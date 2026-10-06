// EdgeMark 설정 화면. 저장은 백그라운드에 메시지로 부탁한다 (서버 동기화와 한 줄로 처리하도록).
import { getData, DEFAULTS } from "./src/store.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const CONF_KEYS = ["maximizedOnly", "peekWindowed", "accordion", "remember"]; // 체크박스 id = 설정 이름
const SELECT_KEYS = ["openIn", "sort"]; // 선택 칸 id = 설정 이름
const SIZE_KEYS = ["fontSize", "rowHeight", "width"]; // 모양 (미리보기에 바로 보임)
const SPEED_KEYS = ["slideSpeed", "folderSpeed"]; // 애니메이션 시간(ms)
const NUM_KEYS = [...SIZE_KEYS, ...SPEED_KEYS]; // 숫자 입력란 id = 설정 이름, 슬라이더는 id + "Range" (범위는 src/store.js 의 RANGES)
let data = { conf: {} };

function message(id, text, isError) {
  const m = $(id);
  m.textContent = text || "";
  m.classList.toggle("error", !!isError);
  m.hidden = !text;
}

// ---------- 사이드바 설정 ----------

function renderConf() {
  for (const k of CONF_KEYS) $(k).checked = data.conf[k];
  for (const k of SELECT_KEYS) $(k).value = data.conf[k];
  // 열기 탭은 '최대화일 때만 열기'의 하위 설정 → 그게 꺼져 있으면 흐리게
  $("peekWindowed").disabled = !data.conf.maximizedOnly;
  $("row-peekWindowed").classList.toggle("off", !data.conf.maximizedOnly);
  for (const k of NUM_KEYS) {
    // 조절하는 중인 칸은 건드리지 않는다
    if (document.activeElement === $(k) || document.activeElement === $(k + "Range")) continue;
    $(k).value = $(k + "Range").value = data.conf[k];
    previewSize(k, data.conf[k]);
  }
}

for (const k of CONF_KEYS) {
  $(k).onchange = async (e) => {
    data = await send({ type: "setConf", patch: { [k]: e.target.checked } });
    renderConf();
  };
}

for (const k of SELECT_KEYS) {
  $(k).onchange = async (e) => {
    const sort = data.conf.sort;
    data = await send({ type: "setConf", patch: { [k]: e.target.value } });
    renderConf();
    if (data.conf.sort !== sort) fillPreview();
  };
}

// 글자 크기 · 목록 간격: 움직이는 동안 미리보기만 바꾸고, 슬라이더를 놓거나 숫자 칸을 벗어나거나 Enter 할 때 저장.
// 범위를 벗어나면 백그라운드가 맞춰서 돌려준다
async function saveSize(patch) {
  data = await send({ type: "setConf", patch });
  for (const k of NUM_KEYS) {
    $(k).value = $(k + "Range").value = data.conf[k];
    previewSize(k, data.conf[k]);
  }
}

for (const k of NUM_KEYS) {
  const num = $(k), range = $(k + "Range");
  range.oninput = () => {
    num.value = range.value;
    previewSize(k, range.value);
  };
  range.onchange = () => saveSize({ [k]: Number(range.value) });
  num.oninput = () => {
    const n = Number(num.value);
    if (num.value !== "" && n >= Number(num.min) && n <= Number(num.max)) {
      range.value = n;
      previewSize(k, n);
    }
  };
  num.onchange = () => {
    const n = Number(num.value);
    if (num.value === "" || !Number.isFinite(n)) return saveSize({});
    saveSize({ [k]: n });
  };
}

const resetTo = (keys) => () => saveSize(Object.fromEntries(keys.map((k) => [k, DEFAULTS[k]])));
$("btn-size-reset").onclick = resetTo(SIZE_KEYS);
$("btn-speed-reset").onclick = resetTo(SPEED_KEYS);

// ---------- 미리보기 ----------
// 실제 사이드바와 같은 CSS·줄(sidebar-view.js)로 그린다. 즐겨찾기 모음의 앞부분, 첫 폴더는 펼쳐서 들여쓰기도 보이게

const { CSS, item, sortItems, ICON_ADD_FOLDER, ICON_DELETE, ICON_SETTINGS } = EdgeMarkView;
const preview = $("preview").attachShadow({ mode: "open" });
preview.innerHTML = `<style>${CSS}
  .panel.preview { position: static; width: 100%; height: 100%; transform: none; visibility: visible; transition: none; border: 0; box-shadow: none; }
  .row { cursor: default; }
</style>
<div class="panel preview">
  <div class="top">
    <input class="search" type="search" placeholder="북마크 검색" tabindex="-1" readonly>
    <span class="btn">${ICON_ADD_FOLDER}</span>
    <span class="btn">${ICON_DELETE}</span>
    <span class="btn">${ICON_SETTINGS}</span>
  </div>
  <div class="list"></div>
</div>`;
const previewPanel = preview.querySelector(".panel");

function previewSize(k, v) {
  if (!SIZE_KEYS.includes(k)) return; // 애니메이션 시간은 미리보기와 상관없음
  if (k === "width") $("preview").style.width = `${v}px`; // 미리보기 칸 자체를 사이드바 너비로
  else previewPanel.style.setProperty(k === "fontSize" ? "--font-size" : "--row-height", `${v}px`);
}

const SAMPLE = [
  { id: "s1", title: "업무" },
  { id: "s2", title: "네이버", url: "https://www.naver.com/" },
  { id: "s3", title: "GitHub", url: "https://github.com/" },
  { id: "s4", title: "YouTube", url: "https://www.youtube.com/" }
];

async function fillPreview() {
  const list = preview.querySelector(".list");
  let items = await chrome.bookmarks.getChildren("1").catch(() => []);
  if (!items.length) items = SAMPLE;
  items = sortItems(items, data.conf.sort).slice(0, 14);
  const els = items.map((b) => item(b, 0));
  list.replaceChildren(...els);
  const i = items.findIndex((b) => !b.url && !b.id.startsWith("s"));
  if (i < 0) return;
  const kids = sortItems(await chrome.bookmarks.getChildren(items[i].id).catch(() => []), data.conf.sort).slice(0, 4);
  if (!kids.length) return;
  els[i].firstChild.classList.add("expanded");
  els[i].lastChild.append(...kids.map((b) => item(b, 1)));
}

async function load() {
  const sort = data.conf.sort;
  data = await getData();
  renderConf();
  if (data.conf.sort !== sort) fillPreview(); // 정렬이 바뀌면 미리보기도 다시
}

// ---------- 동기화 (브라우저 / 서버 WebDAV) — StayTab · DragOn 과 같음 ----------

let status = { mode: "browser" };
let connectOpen = false;
let busy = false;
let lastRunEnd = 0; // 방금 끝난 작업의 결과 문구를 뒤따라 오는 저장소 변경 알림이 지우지 않도록

const timeText = (t) => new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function renderStorage() {
  const server = status.mode === "server";
  $("sub").textContent = server
    ? "서버(WebDAV) 동기화로 다른 PC와 공유됩니다."
    : "브라우저 계정 동기화로 다른 PC와 공유됩니다.";
  $("storage-browser").hidden = server || connectOpen;
  $("storage-server").hidden = !server || connectOpen;
  $("form-connect").hidden = !connectOpen;
  if (server) {
    $("server-url").textContent = status.username ? `${status.url} · ${status.username}` : status.url;
    const state = $("server-state");
    state.textContent = status.error
      ? status.autoPaused
        ? `자동 동기화 실패: ${status.error} — "동기화"가 성공할 때까지 자동 동기화를 멈춥니다.`
        : status.error
      : status.dirty
        ? "서버에 아직 올리지 않은 변경이 있습니다."
        : status.lastSync ? `마지막 동기화 ${timeText(status.lastSync)}` : "";
    state.classList.toggle("error", !!status.error);
    $("dirty-dot").hidden = !status.dirty && !status.error;
  }
  for (const b of document.querySelectorAll("#storage button")) b.disabled = busy;
}

async function loadStatus() {
  status = await send({ type: "status" });
  renderStorage();
}

const DONE = {
  created: "서버에 새 설정 파일을 만들었습니다",
  pushed: "서버에 저장했습니다",
  merged: "양쪽 변경을 합쳐 서버에 저장했습니다",
  pulled: "서버에서 설정을 가져왔습니다",
  unchanged: "이미 최신 상태입니다"
};

async function run(msg) {
  busy = true;
  renderStorage();
  message("storage-message", "");
  try {
    const res = await send(msg);
    if (res.error) message("storage-message", res.error, true);
    else if (DONE[res.action]) message("storage-message", DONE[res.action]);
    return res;
  } finally {
    busy = false;
    lastRunEnd = Date.now();
    await loadStatus();
    await load();
  }
}

function openConnect() {
  const f = $("form-connect").elements;
  const server = status.mode === "server";
  f.url.value = server ? status.url : "";
  f.username.value = server ? status.username : "";
  // 저장된 비밀번호는 받지도 표시하지도 않는다. 비워 두면 그대로 쓴다
  f.password.value = "";
  f.password.required = !(server && status.hasPassword);
  f.password.placeholder = server && status.hasPassword ? "변경하지 않으려면 비워 두세요" : "";
  connectOpen = true;
  message("storage-message", "");
  renderStorage();
  f.url.focus();
}

$("btn-open-connect").onclick = openConnect;
$("btn-edit-connect").onclick = openConnect;
$("connect-cancel").onclick = () => {
  connectOpen = false;
  message("storage-message", "");
  renderStorage();
};

// 서버와 이 기기 설정이 다를 때 어느 쪽을 쓸지 → "remote" | "local" | null(취소)
function askConflict() {
  const dlg = $("conflict");
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue || null), { once: true });
    dlg.returnValue = "";
    dlg.showModal();
  });
}
for (const btn of document.querySelectorAll("#conflict button")) btn.onclick = () => $("conflict").close(btn.value);

// 서버 주소에 접속할 권한 (선택 권한 — 연결하는 서버 하나만). 제출(사용자 동작) 안에서 바로 요청해야 한다
function requestServerAccess(url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return Promise.resolve(true); // 주소 오류는 백그라운드가 알려 준다
  }
  return chrome.permissions.request({ origins: [`${origin}/*`] });
}

$("form-connect").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  if (!(await requestServerAccess(f.url.value.trim()))) return message("storage-message", "서버 접속 권한을 허용해야 연결할 수 있습니다", true);
  const msg = { type: "connect", url: f.url.value, username: f.username.value, password: f.password.value };
  let res = await run(msg);
  if (res.ask) {
    const choice = await askConflict();
    if (!choice) return message("storage-message", "연결을 취소했습니다");
    res = await run({ ...msg, choice });
  }
  if (!res.error && !res.ask) {
    f.password.value = "";
    connectOpen = false;
    renderStorage();
  }
};

$("btn-sync").onclick = () => run({ type: "sync" });

$("btn-disconnect").onclick = async () => {
  if (!confirm("브라우저 동기화로 전환할까요?\n지금 설정을 이 브라우저에 저장하고 서버 연결을 끊습니다. 서버의 파일은 그대로 남습니다.")) return;
  await run({ type: "disconnect" });
  message("storage-message", "브라우저 동기화로 전환했습니다");
};

// 다른 PC나 다른 설정 탭에서 바뀌면 화면 갱신 (openFolders = 사이드바 펼친 폴더는 무시)
const SETTING_KEYS = ["mode", "webdav", "data", "server"];
chrome.storage.onChanged.addListener((changes, area) => {
  if (busy) return;
  if (area === "sync" && status.mode === "browser") load();
  if (area === "local" && SETTING_KEYS.some((k) => k in changes)) {
    // 백그라운드 자동 동기화로 상태가 바뀌면 지난 결과 문구는 지운다
    if (Date.now() - lastRunEnd > 1500) message("storage-message", "");
    load();
    loadStatus();
  }
});

load();
loadStatus();
