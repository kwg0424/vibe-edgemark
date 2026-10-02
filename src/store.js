// 설정 저장소. 동기화하는 데이터 = { conf: { openIn, sort, accordion, maximizedOnly, peekWindowed, remember, fontSize, rowHeight, width } }
// 저장 방식은 두 가지 (StayTab · DragOn 과 같음):
//   browser (기본): chrome.storage.sync 의 conf 키 하나.
//                   Edge 에 로그인하고 확장 동기화를 켜 두면 같은 계정의 다른 PC로 자동 전파된다.
//   server        : chrome.storage.local 의 data 에 두고, 사용자가 연결한 WebDAV 서버 파일(암호화)과 동기화 (sync.js).
//                   서버 모드에서는 storage.sync 를 건드리지 않는다 (브라우저 저장을 쓰는 다른 PC 설정 보호).
// chrome.storage.local: { mode: "server", webdav: { url, username, password }, data, server: { baseEtag, dirty, lastSync, error, autoPaused } }
// 값을 바꾸는 saveConf 는 백그라운드만 부른다 (서버 동기화와 한 줄로 처리). 설정 페이지와 사이드바는 메시지로 부탁한다.

// openIn: 항목을 클릭(Enter)했을 때 "newTab"(새 탭으로 이동) / "current"(지금 탭)
// sort: "browser"(기본 순서 = 브라우저에 저장된 순서, 기본값) / "title"(이름 순서, 폴더 먼저)
// accordion: 폴더를 열면 같은 단계의 다른 폴더를 닫는다
// maximizedOnly: 창이 최대화일 때만 왼쪽 끝에서 자동으로 연다 (창 모드·팝업에서는 열지 않음)
// peekWindowed: maximizedOnly 일 때 창 모드·팝업에서는 사이드바 대신 작은 '열기 탭'만 살짝 보여 준다 (누르면 열림)
// remember: 다시 열 때 펼친 폴더와 스크롤 위치를 기억한다 (끄면 매번 첫 폴더만 펼친 처음 상태로)
// fontSize: 사이드바 글자 크기(px), rowHeight: 목록 한 줄 높이(px), width: 사이드바 너비(px)
// content.js 의 DEFAULT_CONF 와 같게
export const DEFAULTS = { openIn: "newTab", sort: "browser", accordion: false, maximizedOnly: true, peekWindowed: true, remember: false, fontSize: 15, rowHeight: 40, width: 400 };
export const CHOICES = { openIn: ["newTab", "current"], sort: ["browser", "title"] };
export const RANGES = { fontSize: [10, 20], rowHeight: [20, 48], width: [240, 600] };

export async function getMode() {
  const { mode } = await chrome.storage.local.get("mode");
  return mode === "server" ? "server" : "browser";
}

export async function getData() {
  const { mode, data } = await chrome.storage.local.get(["mode", "data"]);
  return mode === "server" ? normalizeData(data) : getBrowserData();
}

export async function getBrowserData() {
  const { conf } = await chrome.storage.sync.get("conf");
  return normalizeData({ conf });
}

export const getConf = async () => (await getData()).conf;

export function normalizeData(d) {
  const conf = {};
  for (const [k, v] of Object.entries(DEFAULTS)) conf[k] = typeof d?.conf?.[k] === typeof v ? d.conf[k] : v;
  for (const [k, list] of Object.entries(CHOICES)) if (!list.includes(conf[k])) conf[k] = DEFAULTS[k];
  for (const [k, [min, max]] of Object.entries(RANGES)) conf[k] = Number.isFinite(conf[k]) ? Math.min(max, Math.max(min, Math.round(conf[k]))) : DEFAULTS[k];
  return { conf };
}

export function sameData(a, b) {
  return Object.keys(DEFAULTS).every((k) => a.conf[k] === b.conf[k]);
}

export const isDefault = (d) => sameData(d, normalizeData(null));

// 서버 모드면 true 를 돌려준다 → 백그라운드가 서버 동기화를 건다
export async function saveConf(patch) {
  if ((await getMode()) === "server") {
    const { data, server = {} } = await chrome.storage.local.get(["data", "server"]);
    const d = normalizeData(data);
    await chrome.storage.local.set({ data: normalizeData({ conf: { ...d.conf, ...patch } }), server: { ...server, dirty: true } });
    return true;
  }
  const { conf } = await getBrowserData();
  await chrome.storage.sync.set(normalizeData({ conf: { ...conf, ...patch } })); // 사이드바가 그대로 읽으므로 맞춘 값으로 저장
  return false;
}

// 브라우저 저장의 데이터를 통째로 바꾼다 (서버 → 브라우저 저장으로 전환할 때)
export async function replaceBrowserData(data) {
  await chrome.storage.sync.set({ conf: data.conf });
}
