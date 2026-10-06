// EdgeMark 백그라운드: 콘텐츠 스크립트는 bookmarks·tabs API를 쓸 수 없으므로 여기서 대신 처리하고,
// 설정 저장과 서버(WebDAV) 동기화를 맡는다.
// 외부 통신은 사용자가 서버(WebDAV) 동기화를 연결했을 때 그 서버로만 한다.
import { getData, getBrowserData, saveConf, replaceBrowserData, normalizeData, sameData, isDefault } from "./src/store.js";
import { sync, peekRemote } from "./src/sync.js";
import { folderUrl, assertSecureUrl } from "./src/webdav.js";

// ---------- 북마크 · 탭 (사이드바) ----------

async function children(id) {
  const kids = await chrome.bookmarks.getChildren(id);
  if (id !== "0") return kids;
  // 맨 위 폴더 중 빈 폴더(보통 '모바일 즐겨찾기')는 숨긴다
  const counts = await Promise.all(kids.map((k) => chrome.bookmarks.getChildren(k.id).then((c) => c.length)));
  return kids.filter((_, i) => counts[i]);
}

// 맨 위(0) 바로 아래부터 id 까지의 폴더 id 목록 (사이드바가 그 경로를 펼치도록)
async function ancestors(id) {
  const ids = [];
  while (id && id !== "0") {
    ids.unshift(id);
    id = (await chrome.bookmarks.get(id))[0].parentId;
  }
  return ids;
}

const folderTitle = async (id) => (await chrome.bookmarks.get(id))[0].title;

// 현재 페이지 추가. 이미 북마크에 있으면 새로 만들지 않고 그 북마크를 알려 준다
async function addPage({ parentId, url, title }) {
  const [found] = await chrome.bookmarks.search({ url }).catch(() => []);
  const node = found || (await chrome.bookmarks.create({ parentId, title: title || url, url }));
  return { node, exists: !!found, path: await ancestors(node.parentId), folder: await folderTitle(node.parentId) };
}

// 옮기기. index 를 안 주면 그 폴더 맨 끝
async function moveNode({ id, parentId, index }) {
  const node = await chrome.bookmarks.move(id, index === undefined ? { parentId } : { parentId, index });
  return { node, path: await ancestors(node.parentId) };
}

// 삭제. 되돌리기용으로 지우기 전 모습(하위 포함)을 돌려준다
async function removeNode(id) {
  const [snap] = await chrome.bookmarks.getSubTree(id);
  if (snap.url) await chrome.bookmarks.remove(id);
  else await chrome.bookmarks.removeTree(id);
  return { removed: snap, title: snap.title || snap.url };
}

// 폴더 안의 항목 수 (하위 폴더 안까지)
async function countInside(id) {
  const count = (n) => (n.children || []).reduce((s, c) => s + 1 + count(c), 0);
  return count((await chrome.bookmarks.getSubTree(id))[0]);
}

// 되돌리기: 지운 자리에 다시 만든다 (id 는 새로 생긴다)
async function restoreNode(snap) {
  const make = async (n, parentId, index) => {
    const node = await chrome.bookmarks.create({ parentId, index, title: n.title, ...(n.url && { url: n.url }) });
    for (const c of n.children || []) await make(c, node.id);
    return node;
  };
  const node = await make(snap, snap.parentId, snap.index);
  return { node, path: await ancestors(node.parentId) };
}

async function createFolder({ parentId, title }) {
  const node = await chrome.bookmarks.create({ parentId, title });
  return { node, path: await ancestors(node.parentId), folder: await folderTitle(node.parentId) };
}

// 새 탭 자리. pos: next(지금 탭 바로 뒤) / end(창의 맨 뒤)
const newTabIndex = async (tab, pos) =>
  pos === "end" ? (await chrome.tabs.query({ windowId: tab.windowId })).length : tab.index + 1;

// where: current(지금 탭) / foreground(새 탭으로 이동) / background(새 탭, 지금 탭 유지)
async function openUrl(url, where, pos, tab) {
  if (where === "current") await chrome.tabs.update(tab.id, { url });
  else await chrome.tabs.create({ url, active: where === "foreground", index: await newTabIndex(tab, pos), openerTabId: tab.id });
}

// 폴더 안 북마크 모두 열기: 새 탭 자리(바로 뒤 / 맨 뒤)부터 순서대로, 뒤에서
async function openAll(urls, pos, tab) {
  const start = await newTabIndex(tab, pos);
  for (const [i, url] of urls.entries()) {
    await chrome.tabs.create({ url, active: false, index: start + i, openerTabId: tab.id });
  }
  return { opened: urls.length };
}

// 페이지 확대/축소가 바뀌면 그 탭의 사이드바에 알려 준다 (사이드바는 확대와 상관없이 같은 크기로 보이게)
chrome.tabs.onZoomChange.addListener(({ tabId, newZoomFactor }) => {
  chrome.tabs.sendMessage(tabId, { type: "zoom", zoom: newZoomFactor }).catch(() => {});
});

// 아이콘 클릭: 사이드바 열기/닫기 (콘텐츠 스크립트가 없는 edge:// 등에서는 아무 일 없음). 설정은 아이콘 우클릭 → 확장 옵션
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => {});
});

// ---------- 서버(WebDAV) 동기화 (StayTab · DragOn 과 같음) ----------

// 설정 변경과 서버 동기화는 한 줄로 세워 처리한다 (동기화 도중 바뀐 내용을 덮어쓰지 않도록)
let queue = Promise.resolve();
const serial = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

// 설정을 바꾸면 바로 서버에 저장한다 (queueSync). 실패하면 "동기화 필요"(빨간 점)로 남고
// 옵션의 "동기화" 버튼이나 다음 변경 때 다시 올린다. 다른 PC 변경은 동기화 버튼, 다음 저장,
// 또는 마지막 동기화가 하루를 넘었을 때의 자동 동기화(autoSync)로 받는다.
// auto: 자동 동기화가 실패하면 autoPaused 로 표시 → 수동 동기화가 성공할 때까지 자동으로 다시 시도하지 않는다
async function runSync(auto = false) {
  const { mode, webdav, data, server = {} } = await chrome.storage.local.get(["mode", "webdav", "data", "server"]);
  if (mode !== "server" || !webdav) return { action: "none" };
  try {
    const r = await sync(webdav, { data: normalizeData(data), baseEtag: server.baseEtag ?? null, dirty: !!server.dirty });
    await chrome.storage.local.set({ data: r.data, server: { baseEtag: r.baseEtag, dirty: false, lastSync: Date.now() } });
    return { action: r.action };
  } catch (e) {
    await chrome.storage.local.set({ server: { ...server, error: e.message, ...(auto && { autoPaused: true }) } });
    return { error: e.message };
  }
}

// 연달아 바꾸면 아직 시작 안 한 동기화 하나로 묶는다
let syncQueued = false;
function queueSync() {
  if (syncQueued) return;
  syncQueued = true;
  serial(() => {
    syncQueued = false;
    return runSync();
  });
}

const AUTO_SYNC_AFTER = 24 * 60 * 60 * 1000; // 마지막 동기화 후 하루
const AUTO_CHECK_EVERY = 10 * 60 * 1000; // 사이드바를 열 때마다 저장소를 읽지 않도록 (서비스 워커가 떠 있는 동안)
let lastAutoCheck = 0;

// 브라우저 시작·사이드바 열 때 확인. alarms 권한 없이 사용자가 브라우저를 쓰는 동안에만 돈다
function autoSync() {
  if (Date.now() - lastAutoCheck < AUTO_CHECK_EVERY) return;
  lastAutoCheck = Date.now();
  serial(async () => {
    const { mode, webdav, server = {} } = await chrome.storage.local.get(["mode", "webdav", "server"]);
    if (mode !== "server" || !webdav || server.autoPaused) return;
    if (server.lastSync && Date.now() - server.lastSync < AUTO_SYNC_AFTER) return;
    await runSync(true);
  });
}

chrome.runtime.onStartup.addListener(autoSync);

// password 를 비워 보내면 저장된 비밀번호를 그대로 쓴다 (옵션 페이지에 비밀번호를 다시 보내지 않으므로)
// 새로 연결할 때 서버에 이 기기와 다른 설정이 있으면 어느 쪽을 쓸지 묻는다:
// choice 없이 오면 { ask: true } 를 돌려주고, 옵션 페이지가 choice("remote" | "local")를 붙여 다시 보낸다
async function connect({ url, username, password, choice }) {
  url = folderUrl(String(url || ""));
  username = String(username || "").trim();
  password = String(password || "");
  try {
    assertSecureUrl(`${url}/`);
  } catch (e) {
    return { error: e.message };
  }
  if (!username) return { error: "아이디를 입력하세요" };
  if (username.includes(":")) return { error: "아이디에는 : 를 쓸 수 없습니다" };

  const state = await chrome.storage.local.get(["mode", "webdav", "data", "server"]);
  password ||= (state.mode === "server" && state.webdav?.password) || "";
  if (!password) return { error: "비밀번호를 입력하세요" };
  const cfg = { url, username, password };
  // 같은 서버 파일에 다시 연결(접속 정보 변경 화면에서 그대로 저장)이면 지금 상태 그대로 동기화
  const same =
    state.mode === "server" && state.webdav?.url === url && state.webdav?.username === username && state.webdav?.password === password;
  const data = state.mode === "server" ? normalizeData(state.data) : await getBrowserData();
  let local = same ? { data, baseEtag: state.server?.baseEtag ?? null, dirty: !!state.server?.dirty } : { data, baseEtag: null, dirty: true };
  let action = null;
  try {
    if (!same) {
      const remote = await peekRemote(cfg);
      if (remote.data && !sameData(remote.data, data)) {
        // 이 기기 설정이 기본값 그대로면 묻지 않고 서버 설정을 쓴다
        if (isDefault(data)) choice = "remote";
        if (!choice) return { ask: true };
        // 서버 설정 사용: 서버 파일을 기준으로 가져온다 / 이 기기 설정 올리기: 서버 파일을 덮어쓴다
        if (choice === "remote") [local, action] = [{ data: remote.data, baseEtag: remote.etag, dirty: false }, "pulled"];
        else local = { data, baseEtag: remote.etag, dirty: true };
      }
    }
    const r = await sync(cfg, local);
    await chrome.storage.local.set({
      mode: "server",
      webdav: cfg,
      data: r.data,
      server: { baseEtag: r.baseEtag, dirty: false, lastSync: Date.now() }
    });
    return { action: action || r.action };
  } catch (e) {
    return { error: e.message };
  }
}

// 브라우저 저장으로 전환: 지금 설정을 브라우저 저장(storage.sync)으로 옮긴다. 서버 파일은 그대로 둔다.
async function disconnect() {
  const { mode, data } = await chrome.storage.local.get(["mode", "data"]);
  if (mode !== "server") return {};
  await replaceBrowserData(normalizeData(data));
  await chrome.storage.local.remove(["mode", "webdav", "data", "server"]);
  return {};
}

async function status() {
  const { mode, webdav, server = {} } = await chrome.storage.local.get(["mode", "webdav", "server"]);
  if (mode !== "server") return { mode: "browser" };
  // 비밀번호는 옵션 페이지로 보내지 않는다 (저장돼 있는지만)
  return {
    mode,
    url: webdav?.url,
    username: webdav?.username || "",
    hasPassword: !!webdav?.password,
    dirty: !!server.dirty,
    lastSync: server.lastSync || null,
    error: server.error || null,
    autoPaused: !!server.autoPaused
  };
}

// ---------- 메시지 (사이드바 · 설정 페이지) ----------

async function handle(msg, sender) {
  switch (msg.type) {
    // 사이드바
    case "children":
      if (msg.id === "0") autoSync(); // 사이드바를 열 때
      return children(msg.id);
    case "search":
      return (await chrome.bookmarks.search(msg.query)).filter((b) => b.url).slice(0, 200);
    case "open":
      return openUrl(msg.url, msg.where, msg.pos, sender.tab);
    case "openAll":
      return openAll(msg.urls, msg.pos, sender.tab);
    case "zoom":
      return chrome.tabs.getZoom(sender.tab.id);
    case "options": // 사이드바의 톱니바퀴
      return chrome.runtime.openOptionsPage();
    case "addPage":
      return addPage(msg);
    case "createFolder":
      return createFolder(msg);
    case "path":
      return ancestors(msg.id);
    case "move":
      return moveNode(msg);
    case "count":
      return countInside(msg.id);
    case "remove":
      return removeNode(msg.id);
    case "restore":
      return restoreNode(msg.snapshot);

    // 설정 페이지
    case "get":
      return getData();
    case "setConf":
      return serial(async () => {
        if (await saveConf(msg.patch)) queueSync(); // 서버 모드면 true
        return getData();
      });
    case "status":
      return status();
    case "sync":
      return serial(runSync);
    case "connect":
      return serial(() => connect(msg));
    case "disconnect":
      return serial(disconnect);
  }
  return {};
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, (e) => reply({ error: String(e?.message || e) }));
  return true; // 비동기 응답
});
