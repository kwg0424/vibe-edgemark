// EdgeMark 콘텐츠 스크립트: 마우스를 화면 왼쪽 끝에 잠깐 대면 사이드바를 띄운다.
// 사이드바는 closed Shadow DOM 안에 그려서 페이지 CSS와 서로 섞이지 않게 한다.
// 북마크 읽기와 탭 열기는 background.js 에 메시지로 맡긴다.
//   chrome.storage.local { openFolders: [id] }  펼쳐 둔 폴더 (이 PC에만, '기억하기' 설정이 켜져 있을 때만 씀)
// 설정 (src/store.js 의 DEFAULTS) 은 src/store.js 와 같은 곳에서 읽는다 (서비스 워커를 깨우지 않도록 메시지 없이):
//   브라우저 동기화면 chrome.storage.sync 의 conf, 서버(WebDAV) 동기화면 chrome.storage.local 의 data.conf
(() => {
  if (window.top !== window || window.__edgeMark) return;
  window.__edgeMark = true;

  const EDGE = 6;          // 왼쪽 끝에서 이 px 안에 들어오면 바로 연다
  const PEEK_EDGE = 24;    // 창 모드·팝업에서 열기 탭을 띄울 때는 더 넓게 (창 테두리 밖으로 금방 나가 버리므로)
  const EXIT_EDGE = 40;    // 이 px 안에서 페이지 왼쪽 밖으로 빠져나가도 연다 (왼쪽에 모니터가 더 있을 때)
  const DEFAULT_CONF = { openIn: "end", sort: "browser", accordion: false, maximizedOnly: true, peekWindowed: true, remember: false, fontSize: 15, rowHeight: 40, width: 400, folderSpeed: 100, slideSpeed: 100 }; // src/store.js 의 DEFAULTS 와 같게

  const { CSS, item, editRow, sortItems, ICON_ADD_FOLDER, ICON_DELETE, ICON_SETTINGS, ICON_PEEK } = EdgeMarkView; // sidebar-view.js

  let peek, peekTimer;
  let host, root, backdrop, panel, search, list, tree, results;
  let isOpen = false;
  let searchTimer, searchJob, shownQuery = ""; // shownQuery: 결과를 그렸거나 그리는 중인 검색어
  let openFolders = new Set();
  let conf = DEFAULT_CONF;
  let prevFocus, scrollTop = 0;
  let active = null; // 방향키·클릭으로 고른 줄 (폴더 추가는 이 줄의 폴더에, 삭제는 이 줄을)
  let editing = null; // 새 폴더 이름을 입력하는 중이면 { input, cancel }
  let toastTimer;
  let deleting = false; // 삭제 모드 (상단 삭제 버튼): 줄마다 − 가 나온다
  let asking = null; // 확인창이 떠 있으면 그 답을 정하는 함수
  let drag = null; // 드래그 중인 줄 { id, row }
  let dropAt = null, expandTimer; // 지금 표시 중인 놓을 자리 { row, pos }, 드래그 중 폴더 위에 머물면 펼치기
  // 페이지 확대 배율. 사이드바(host)를 1/zoom 로 줄여서 확대·축소와 상관없이 같은 크기로 보이게 하고, 가장자리 감지 폭도 화면 px 로 맞춘다.
  // 서비스 워커를 깨우지 않도록 처음 쓸 때(마우스가 왼쪽 가까이 오거나 열 때) 한 번 묻고, 그 뒤로는 바뀔 때 background.js 가 알려 준다
  let zoom = 1, zoomAsked = false;

  const send = (msg) => chrome.runtime.sendMessage(msg);
  const alive = () => !!chrome.runtime?.id; // 확장을 다시 불러오면 기존 탭의 스크립트는 끊긴다
  const isEditable = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  // ---------- 화면 ----------

  function build() {
    host = document.createElement("edgemark-sidebar");
    host.style.cssText = "all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647;";
    applyZoom();
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${CSS}</style>
      <div class="backdrop"></div>
      <button class="peek" title="북마크 사이드바 열기" tabindex="-1">${ICON_PEEK}</button>
      <div class="panel">
        <div class="top">
          <input class="search" type="search" placeholder="북마크 검색" spellcheck="false" autocomplete="off">
          <button class="btn" data-act="folder" title="폴더 추가">${ICON_ADD_FOLDER}</button>
          <button class="btn del" data-act="delete" title="삭제 모드">${ICON_DELETE}</button>
          <button class="btn" data-act="settings" title="설정">${ICON_SETTINGS}</button>
        </div>
        <div class="list" tabindex="-1"><div class="tree"></div><div class="results" hidden></div></div>
        <div class="toast"></div>
        <div class="ask" hidden><div class="box"><p></p><div class="actions"><button class="ok">삭제</button><button class="cancel">취소</button></div></div></div>
      </div>`;
    backdrop = root.querySelector(".backdrop");
    peek = root.querySelector(".peek");
    peek.addEventListener("click", () => {
      hidePeek();
      open();
    });
    peek.addEventListener("mouseenter", () => clearTimeout(peekTimer));
    peek.addEventListener("mouseleave", () => { peekTimer = setTimeout(hidePeek, 150); }); // 탭에서 마우스가 떠나면 숨긴다
    panel = root.querySelector(".panel");
    search = root.querySelector(".search");
    list = root.querySelector(".list");
    tree = root.querySelector(".tree");
    results = root.querySelector(".results");
    applyConf();

    root.querySelector('[data-act="folder"]').addEventListener("click", addFolder);
    root.querySelector('[data-act="delete"]').addEventListener("click", () => setDeleting(!deleting));
    root.querySelector('[data-act="settings"]').addEventListener("click", () => {
      send({ type: "options" }); // 콘텐츠 스크립트는 설정 화면을 직접 못 연다
      close();
    });
    root.querySelector(".ask .ok").addEventListener("click", () => asking?.(true));
    root.querySelector(".ask .cancel").addEventListener("click", () => asking?.(false));
    list.addEventListener("dragstart", onDragStart);
    list.addEventListener("dragover", onDragOver);
    list.addEventListener("drop", onDrop);
    list.addEventListener("dragend", endDrag);
    list.addEventListener("click", onClick);
    list.addEventListener("auxclick", onAuxClick);
    list.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); }); // 가운데 버튼 자동 스크롤 막기
    backdrop.addEventListener("mousedown", (e) => {
      e.preventDefault();
      close();
    });
    backdrop.addEventListener("wheel", (e) => e.preventDefault(), { passive: false }); // 열린 동안 뒤 페이지는 스크롤하지 않음
    panel.addEventListener("keydown", onKey);
    // 사이드바 안에서 누른 키가 페이지 단축키(YouTube 의 k 등)로 넘어가지 않게
    for (const type of ["keydown", "keyup", "keypress"]) host.addEventListener(type, (e) => e.stopPropagation());
    panel.addEventListener("mouseleave", () => {
      // 검색 중, 폴더 이름 입력 중, 드래그 중이면 그대로 둔다
      if ((search.value && root.activeElement) || editing || drag || asking) return;
      close();
    });
    // 목록 끝에서 휠을 더 굴려도 페이지가 스크롤되지 않게
    panel.addEventListener("wheel", (e) => {
      const atTop = list.scrollTop <= 0;
      const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
      if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atEnd)) e.preventDefault();
    }, { passive: false });
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 150);
    });
  }

  function empty(text) {
    const el = document.createElement("div");
    el.className = "empty";
    el.textContent = text;
    return el;
  }

  async function renderChildren(id, box, depth) {
    const kids = await send({ type: "children", id });
    if (Array.isArray(kids)) await renderItems(sortItems(kids, conf.sort), box, depth);
  }

  async function renderItems(kids, box, depth) {
    const items = kids.map((b) => item(b, depth));
    box.append(...items);
    await Promise.all(kids.map((b, i) => (!b.url && openFolders.has(b.id) ? expand(items[i], b.id, depth) : null)));
  }

  // 하위 항목은 다 그린 뒤 한 번에 넣는다 (애니메이션이 빈 칸에서 시작하고, 반쯤 그려진 모습이 보이지 않게)
  async function expand(el, id, depth, animate = false) {
    el.firstChild.classList.add("expanded");
    const box = el.lastChild, frag = document.createDocumentFragment();
    for (const a of box.getAnimations()) a.cancel(); // 접히는 중이었으면 멈춘다 (다 접힌 뒤 비우는 것도 안 함)
    await renderChildren(id, frag, depth + 1);
    if (!el.firstChild.classList.contains("expanded")) return; // 그리는 사이 다시 접힘
    box.replaceChildren(frag);
    if (animate) slide(box, true);
  }

  // 접기: 애니메이션이 끝나면 비운다
  function collapse(el) {
    el.firstChild.classList.remove("expanded");
    const box = el.lastChild;
    slide(box, false).then(() => { if (!el.firstChild.classList.contains("expanded")) box.replaceChildren(); }, () => {});
  }

  // 폴더 펼치기·접기 애니메이션: 하위 항목 칸의 높이를 0 ↔ 실제 높이로. 시간은 설정 folderSpeed(ms), 0 이면 바로.
  // 끝나면 이루어지고, 중간에 멈추면(cancel) 거부되는 Promise
  function slide(box, opening) {
    for (const a of box.getAnimations()) a.cancel();
    const h = box.scrollHeight;
    if (!conf.folderSpeed || !h) return Promise.resolve();
    const frames = [{ height: "0px", opacity: 0, overflow: "hidden" }, { height: `${h}px`, opacity: 1, overflow: "hidden" }];
    if (!opening) frames.reverse();
    return box.animate(frames, { duration: conf.folderSpeed, easing: "ease-out" }).finished;
  }

  // 열 때마다 새로 그린다 (그 사이 북마크가 바뀌었을 수 있으므로)
  // 맨 위에는 '즐겨찾기 모음'(id 1)의 내용을 바로 펼쳐 놓고, '기타 즐겨찾기' 등 나머지 최상위 폴더는 그 아래에 폴더로 둔다
  // reset: '기억하기'가 꺼져 있으면 첫 폴더만 펼친 처음 상태로 (추가한 항목을 보여 줄 때는 지금 상태 유지)
  async function renderTree(reset = true) {
    const frag = document.createDocumentFragment();
    const [bar, roots] = await Promise.all([send({ type: "children", id: "1" }), send({ type: "children", id: "0" })]);
    // 즐겨찾기 모음의 내용은 정렬하고, '기타 즐겨찾기' 같은 나머지 최상위 폴더는 그 아래에 그대로
    const top = [...(Array.isArray(bar) ? sortItems(bar, conf.sort) : []), ...(Array.isArray(roots) ? roots.filter((r) => r.id !== "1") : [])];
    // 기억하지 않으면 매번 처음 상태: 맨 위 첫 폴더만 펼친다
    if (reset && !conf.remember) {
      const first = top.find((b) => !b.url);
      openFolders = new Set(first ? [first.id] : []);
    }
    await renderItems(top, frag, 0);
    tree.replaceChildren(frag.childNodes.length ? frag : empty("북마크가 없습니다"));
    if (!tree.hidden) setActive(null);
  }

  // 같은 검색어면 다시 그리지 않는다 (한글 조합이 끝날 때도 input 이 한 번 더 온다) → 방향키로 고른 줄이 유지된다.
  // 결과가 다 그려지면 끝나는 Promise 를 돌려준다
  function runSearch() {
    clearTimeout(searchTimer);
    searchTimer = null;
    const q = search.value.trim();
    tree.hidden = !!q;
    results.hidden = !q;
    if (!q) {
      shownQuery = "";
      return Promise.resolve();
    }
    if (q === shownQuery) return searchJob;
    shownQuery = q;
    return (searchJob = (async () => {
      const found = await send({ type: "search", query: q });
      if (shownQuery !== q) return; // 그 사이 검색어가 바뀜
      results.replaceChildren(...(Array.isArray(found) && found.length
        ? sortItems(found, conf.sort).map((b) => item(b, 0))
        : [empty("검색 결과가 없습니다")]));
      setActive(null);
      list.scrollTop = 0;
    })());
  }

  // ---------- 동작 ----------

  async function toggleFolder(row) {
    const el = row.parentElement, id = row.dataset.id;
    if (openFolders.has(id)) {
      openFolders.delete(id);
      collapse(el);
    } else {
      if (conf.accordion) collapseSiblings(el);
      openFolders.add(id);
      await expand(el, id, +row.dataset.depth, true);
    }
    if (conf.remember) chrome.storage.local.set({ openFolders: [...openFolders] });
  }

  // 같은 단계의 펼쳐진 폴더를 닫고, 그 안에서 펼쳐 둔 폴더도 기억에서 지운다
  function collapseSiblings(el) {
    for (const sib of el.parentElement.children) {
      if (sib === el) continue;
      const rows = sib.querySelectorAll(".row.expanded");
      if (!rows.length) continue;
      for (const r of rows) openFolders.delete(r.dataset.id);
      collapse(sib);
    }
  }

  // 클릭·Enter: 설정대로 (기본 새 탭으로 이동, 또는 지금 탭) / Ctrl·가운데 클릭: 새 탭(뒤에서) / Shift: 새 탭으로 이동. 폴더는 펼치기/접기
  function activate(row, e) {
    if (row.classList.contains("folder")) return void toggleFolder(row);
    openLink(row.dataset.url, e.ctrlKey || e.metaKey ? "background" : e.shiftKey ? "foreground" : conf.openIn === "current" ? "current" : "foreground");
  }

  function onClick(e) {
    const plus = e.target.closest(".plus");
    if (plus) return void addPage(plus.closest(".row").dataset.id);
    const minus = e.target.closest(".minus");
    if (minus) return void removeRow(minus.closest(".row"));
    const row = e.target.closest(".row");
    if (!row || row.classList.contains("editing")) return;
    setActive(row, false);
    if (deleting && !row.classList.contains("folder")) return; // 삭제 모드에서는 북마크를 열지 않는다 (폴더는 펼치기만)
    activate(row, e);
  }

  // ---------- 추가 (폴더 · 현재 페이지) · 삭제 ----------
  // 폴더 추가: 고른 줄이 폴더면 그 안, 북마크면 그 북마크가 있는 폴더, 고른 줄이 없으면 즐겨찾기 모음(1). 맨 끝에 넣는다
  // 현재 페이지 추가: 폴더 줄 오른쪽 끝 + 를 누른 그 폴더

  const targetFolder = () =>
    !active?.isConnected ? "1" : active.classList.contains("folder") ? active.dataset.id : active.dataset.parent || "1";

  // action: { label, run } 을 주면 버튼(되돌리기 등)을 붙이고 조금 더 오래 보여 준다
  function toast(text, action) {
    const t = root.querySelector(".toast");
    t.replaceChildren(text);
    if (action) {
      const b = document.createElement("button");
      b.className = "undo";
      b.textContent = action.label;
      b.onclick = () => {
        t.classList.remove("show");
        list.focus({ preventScroll: true }); // 버튼이 사라져도 키보드(방향키·Del)를 계속 쓸 수 있게
        action.run();
      };
      t.append(b);
    }
    t.classList.toggle("act", !!action);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), action ? 5000 : 2000);
  }

  // 검색을 끝내고 트리에서 path 의 폴더들을 펼쳐 nodeId 줄을 고른다
  async function reveal(path, nodeId) {
    for (const id of path) if (id !== "1") openFolders.add(id);
    if (conf.remember) chrome.storage.local.set({ openFolders: [...openFolders] });
    search.value = "";
    await runSearch();
    await renderTree(false);
    const row = nodeId && tree.querySelector(`.row[data-id="${nodeId}"]`);
    if (row) setActive(row);
  }

  async function addPage(parentId) {
    const res = await send({ type: "addPage", parentId, url: location.href, title: document.title });
    if (!res?.node) return toast(res?.error || "추가하지 못했습니다");
    await reveal(res.path, res.node.id);
    toast(res.exists ? `이미 북마크에 있습니다 · ${res.folder}` : `추가했습니다 · ${res.folder}`);
  }

  async function addFolder() {
    if (editing) return editing.input.focus();
    const parentId = targetFolder();
    // 넣을 폴더를 트리에서 펼쳐 두고, 그 맨 끝에 이름 입력 줄을 띄운다
    await reveal(parentId === "1" ? [] : await send({ type: "path", id: parentId }), parentId === "1" ? null : parentId);
    let box = tree, before = null, depth = 0;
    const folderRow = parentId !== "1" && tree.querySelector(`.row.folder[data-id="${parentId}"]`);
    if (folderRow) {
      box = folderRow.parentElement.lastChild;
      depth = +folderRow.dataset.depth + 1;
    } else {
      // 즐겨찾기 모음: 맨 위 목록에서 '기타 즐겨찾기' 같은 다른 최상위 폴더 앞
      before = [...tree.children].find((el) => el.firstChild?.dataset?.parent && el.firstChild.dataset.parent !== "1") || null;
    }
    const row = editRow(depth);
    box.insertBefore(row, before);
    const input = row.querySelector(".name");
    input.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });

    const done = async (save) => {
      if (!editing) return;
      editing = null;
      const title = input.value.trim();
      row.remove();
      if (!save || !title) return;
      const res = await send({ type: "createFolder", parentId, title });
      if (!res?.node) return toast(res?.error || "폴더를 만들지 못했습니다");
      await reveal([...res.path, res.node.id], res.node.id);
      toast(`폴더를 만들었습니다 · ${res.folder}`);
    };
    editing = { input, cancel: () => done(false) };
    input.addEventListener("keydown", (e) => {
      if (e.isComposing || e.key !== "Enter") return; // 한글 조합 중 Enter 는 글자 확정용
      e.preventDefault();
      done(true);
    });
    input.addEventListener("blur", () => done(true)); // 다른 곳을 누르면 입력한 이름으로 만든다 (비어 있으면 취소)
  }

  // 삭제 모드 켜고 끄기: 상단 삭제 버튼 (한 번 더 누르거나 Esc, 사이드바를 닫으면 꺼짐)
  function setDeleting(on) {
    deleting = on;
    panel.classList.toggle("deleting", on);
    const btn = root.querySelector('[data-act="delete"]');
    btn.classList.toggle("on", on);
  }

  // 사이드바 안 확인창 → true(삭제) / false(취소). Enter = 삭제, Esc = 취소
  // okLabel 을 주면 빨간 '삭제' 대신 파란 버튼 (예: 열기)
  function ask(text, okLabel) {
    const box = root.querySelector(".ask");
    box.querySelector("p").textContent = text;
    const ok = box.querySelector(".ok");
    ok.textContent = okLabel || "삭제";
    ok.classList.toggle("safe", !!okLabel);
    box.hidden = false;
    box.querySelector(".ok").focus({ preventScroll: true });
    return new Promise((resolve) => {
      asking = (yes) => {
        asking = null;
        box.hidden = true;
        list.focus({ preventScroll: true });
        resolve(yes);
      };
    });
  }

  // 줄 삭제 (− 버튼, Del). 하위 항목이 있는 폴더는 먼저 묻는다.
  // 지운 뒤 같은 자리의 줄을 고르고, 잠깐 '되돌리기'를 보여 준다
  async function removeRow(row) {
    if (!row?.isConnected) return;
    if (row.dataset.parent === "0") return toast("기본 폴더는 삭제할 수 없습니다");
    const name = row.querySelector(".title").textContent;
    if (row.classList.contains("folder")) {
      const n = await send({ type: "count", id: row.dataset.id });
      if (n > 0 && !(await ask(`'${name}' 폴더와 안에 있는 항목 ${n}개를 모두 삭제할까요?`))) return;
    }
    const i = rows().indexOf(row);
    const res = await send({ type: "remove", id: row.dataset.id });
    if (!res?.removed) return toast(res?.error || "삭제하지 못했습니다");
    if (tree.hidden) {
      shownQuery = ""; // 같은 검색어라도 다시 그린다
      await runSearch();
    } else await renderTree(false);
    const after = rows();
    if (after.length) setActive(after[Math.min(i, after.length - 1)]);
    list.focus({ preventScroll: true });
    toast(`삭제했습니다 · ${res.title}`, {
      label: "되돌리기",
      run: async () => {
        const r = await send({ type: "restore", snapshot: res.removed });
        if (!r?.node) return toast(r?.error || "되돌리지 못했습니다");
        await reveal(r.path, r.node.id);
        toast("되돌렸습니다");
      }
    });
  }

  // ---------- 드래그로 옮기기 ----------
  // 폴더 줄: 가운데 → 그 폴더 안(맨 끝), 위·아래 가장자리 → 그 앞·뒤. 북마크 줄: 위 절반 → 앞, 아래 절반 → 뒤.
  // 북마크를 페이지나 다른 앱으로 끌어 놓으면 주소가 들어간다 (text/uri-list)

  function onDragStart(e) {
    const row = e.target.closest?.(".row");
    if (!row || row.classList.contains("editing")) return;
    drag = { id: row.dataset.id, row };
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "copyMove";
    if (row.dataset.url) {
      e.dataTransfer.setData("text/uri-list", row.dataset.url);
      e.dataTransfer.setData("text/plain", row.dataset.url);
    } else e.dataTransfer.setData("text/plain", row.textContent);
  }

  function dropSpot(e) {
    const row = e.target.closest?.(".row");
    if (!drag || !row || row === drag.row || row.classList.contains("editing")) return null;
    if (drag.row.parentElement.contains(row)) return null; // 폴더를 자기 안으로는 못 옮긴다
    const folder = row.classList.contains("folder");
    const base = row.dataset.parent === "0"; // 기본 폴더 앞뒤에는 못 놓고 안으로만
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    const pos = folder && (base || (y > 0.25 && y < 0.75)) ? "into" : y < 0.5 ? "before" : "after";
    if (base && pos !== "into") return null;
    return { row, pos };
  }

  function showDrop(spot) {
    if (dropAt && (!spot || dropAt.row !== spot.row || dropAt.pos !== spot.pos)) {
      dropAt.row.classList.remove("drop-before", "drop-after", "drop-into");
      clearTimeout(expandTimer);
    }
    if (spot && (dropAt?.row !== spot.row || dropAt?.pos !== spot.pos)) {
      spot.row.classList.add(`drop-${spot.pos}`);
      // 접힌 폴더 위에 잠깐 머물면 펼쳐서 그 안으로도 놓을 수 있게
      if (spot.pos === "into" && !spot.row.classList.contains("expanded")) {
        expandTimer = setTimeout(() => toggleFolder(spot.row), 700);
      }
    }
    dropAt = spot;
  }

  function onDragOver(e) {
    const spot = dropSpot(e);
    showDrop(spot);
    if (!spot) return;
    e.preventDefault(); // 여기에 놓을 수 있음
    e.dataTransfer.dropEffect = "move";
  }

  async function onDrop(e) {
    const spot = dropSpot(e);
    const id = drag?.id;
    endDrag();
    if (!spot || !id) return;
    e.preventDefault();
    const { row, pos } = spot;
    const msg = pos === "into"
      ? { type: "move", id, parentId: row.dataset.id }
      : { type: "move", id, parentId: row.dataset.parent, index: +row.dataset.index + (pos === "after" ? 1 : 0) };
    const res = await send(msg);
    if (!res?.node) return toast(res?.error || "옮기지 못했습니다");
    await reveal(res.path, res.node.id);
  }

  function endDrag() {
    showDrop(null);
    drag?.row.classList.remove("dragging");
    drag = null;
  }

  // ---------- 키보드 ----------
  // 검색창: Enter 또는 ↓ → 목록으로 (첫 줄), ↑ → 목록 마지막 줄
  // 목록: ↑↓ 이동 (끝에서 처음으로 돈다), Enter 열기, → 폴더 펼치기, ← 접기 (하위 항목에서는 부모 폴더를 접고 그 줄로), 글자를 치면 다시 검색창으로

  const rows = () => [...(tree.hidden ? results : tree).querySelectorAll(".row:not(.editing)")];

  function setActive(row, scroll = true) {
    active?.classList.remove("active");
    active = row;
    if (!row) return;
    row.classList.add("active");
    if (scroll) row.scrollIntoView({ block: "nearest" });
  }

  function move(step) {
    const all = rows();
    if (!all.length) return;
    const i = all.indexOf(active);
    setActive(all[i < 0 ? (step > 0 ? 0 : all.length - 1) : (i + step + all.length) % all.length]);
  }

  async function onKey(e) {
    if (e.target.classList?.contains("name")) return; // 새 폴더 이름 입력 칸은 따로 처리
    if (asking) return; // 확인창: Enter 는 포커스 된 버튼이, Esc 는 아래 전역 처리가 맡는다
    // 한글 입력기가 켜져 있으면 방향키·Enter 를 누를 때 "Process" 가 먼저 오고 실제 키가 뒤따른다 → Process 는 무시 (두 번 움직이지 않게).
    // 글자 키의 Process 는 아래에서 검색창으로 보낸다. 조합 중 Enter 는 글자 확정용이라 둔다
    if (e.key === "Process" && !/^(Key|Digit)/.test(e.code)) return;
    const key = e.key;
    if (e.isComposing && key === "Enter") return;
    const inSearch = root.activeElement === search;
    if (key === "ArrowDown" || key === "ArrowUp" || (inSearch && key === "Enter")) {
      e.preventDefault();
      if (inSearch) {
        list.focus({ preventScroll: true }); // 조합 중이던 글자는 여기서 확정된다
        await runSearch(); // 아직 안 돈 검색이 있으면 끝까지 기다렸다가 고른다
        if (!rows().includes(active)) active = null;
      }
      move(key === "ArrowUp" ? -1 : inSearch && active ? 0 : 1);
      return;
    }
    if (inSearch) return;
    if (key === "Enter" && active) {
      e.preventDefault();
      if (!deleting || active.classList.contains("folder")) activate(active, e);
    } else if (key === "Delete" && active) {
      e.preventDefault();
      removeRow(active);
    } else if (key === "ArrowLeft" && active && !active.classList.contains("expanded")) {
      // 하위 항목(북마크·접힌 폴더)에서 ← → 부모 폴더를 접고 그 폴더 줄로 올라간다
      e.preventDefault();
      const parentRow = active.parentElement.parentElement.parentElement?.firstElementChild;
      if (parentRow?.classList.contains("folder") && parentRow.classList.contains("expanded")) {
        await toggleFolder(parentRow);
        setActive(parentRow);
      }
    } else if ((key === "ArrowRight" || key === "ArrowLeft") && active?.classList.contains("folder")) {
      e.preventDefault();
      if (active.classList.contains("expanded") === (key === "ArrowLeft")) toggleFolder(active);
    } else if ((key.length === 1 || key === "Backspace" || key === "Process") && !e.ctrlKey && !e.altKey && !e.metaKey) {
      search.focus({ preventScroll: true }); // 이 키는 검색창에 그대로 들어간다
    }
  }

  // 가운데(휠) 클릭: 북마크 → 새 탭(뒤에서), 폴더 → 그 폴더 바로 안의 북마크를 모두 새 탭(뒤에서)으로
  function onAuxClick(e) {
    const row = e.button === 1 && e.target.closest(".row");
    if (!row || row.classList.contains("editing")) return;
    e.preventDefault();
    if (row.classList.contains("folder")) openAll(row);
    else openLink(row.dataset.url, "background");
  }

  const OPEN_ALL_ASK = 10; // 이보다 많으면 먼저 묻는다

  async function openAll(row) {
    const name = row.querySelector(".title").textContent;
    const kids = await send({ type: "children", id: row.dataset.id });
    const urls = (Array.isArray(kids) ? sortItems(kids, conf.sort) : []).filter((b) => b.url).map((b) => b.url);
    if (!urls.length) return toast(`'${name}' 폴더에 북마크가 없습니다`);
    if (urls.length > OPEN_ALL_ASK && !(await ask(`'${name}' 폴더의 북마크 ${urls.length}개를 모두 새 탭으로 열까요?`, "열기"))) return;
    const res = await send({ type: "openAll", urls, pos: tabPos() });
    if (res?.error) return toast(res.error);
    toast(`북마크 ${urls.length}개를 새 탭으로 열었습니다`);
  }

  // 새 탭 자리: 바로 뒤 · 지금 탭이면 지금 탭 바로 뒤, 나머지(맨 뒤, 예전 값 newTab)는 맨 뒤
  const tabPos = () => (conf.openIn === "next" || conf.openIn === "current" ? "next" : "end");

  function openLink(url, where) {
    send({ type: "open", url, where, pos: tabPos() });
    if (where !== "background") close(); // 뒤에서 연 새 탭이면 계속 고를 수 있게 둔다
  }

  async function open() {
    if (isOpen || !alive()) return;
    askZoom();
    if (!host) build();
    hidePeek();
    if (!host.isConnected) document.documentElement.append(host);
    isOpen = true;
    prevFocus = document.activeElement;

    // 먼저 띄우고 (지난번 트리 그대로) 북마크는 뒤에서 새로 그린다
    panel.classList.add("open");
    backdrop.classList.add("open");
    // 페이지에서 입력 중이 아니면 바로 검색할 수 있게 (한글 입력도 되도록 실제 포커스를 준다)
    if (!isEditable(prevFocus)) search.focus({ preventScroll: true });

    if (conf.remember) {
      const { openFolders: saved } = await chrome.storage.local.get("openFolders");
      if (saved) openFolders = new Set(saved);
    }
    await renderTree();
    if (isOpen && !tree.hidden) list.scrollTop = conf.remember ? scrollTop : 0;
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    if (!host) return;
    editing?.cancel(); // 닫으면 새 폴더 입력은 취소
    asking?.(false); // 확인창도 취소
    setDeleting(false);
    if (!tree.hidden) scrollTop = list.scrollTop;
    panel.classList.remove("open");
    backdrop.classList.remove("open");
    search.value = "";
    clearTimeout(searchTimer);
    shownQuery = "";
    tree.hidden = false;
    results.hidden = true;
    setActive(null);
    if (root.activeElement) {
      root.activeElement.blur();
      prevFocus?.focus?.({ preventScroll: true });
    }
    // 기억하지 않으면 닫혀 있는 동안 처음 상태로 다시 그려 둔다 (다음에 열 때 지난 상태가 잠깐 보이지 않게)
    if (!conf.remember) renderTree().then(() => { if (!isOpen) list.scrollTop = 0; }, () => {});
  }

  // 창이 화면(작업 표시줄 제외)을 꽉 채울 때만. 최대화된 창은 테두리만큼 화면 밖으로 조금 나가 있다 (Windows는 8px)
  const isMaximized = () =>
    Math.abs(screenX - screen.availLeft) <= 12 && Math.abs(screenY - screen.availTop) <= 12 &&
    outerWidth >= screen.availWidth && outerHeight >= screen.availHeight;
  const canOpen = (e) => !isOpen && !e.buttons && !document.fullscreenElement;

  // 왼쪽 끝에 닿았을 때: 열 수 있으면 열고, 창 모드·팝업이면 (설정에 따라) 작은 열기 탭만 보여 준다
  function edgeHit(e) {
    if (!canOpen(e)) return;
    if (!conf.maximizedOnly || isMaximized()) return void open();
    if (conf.peekWindowed && alive()) showPeek(e.clientY);
  }

  // 열기 탭은 저절로 사라지지 않는다. 탭에서 마우스가 떠나거나 페이지 안쪽으로 멀어지면 숨긴다
  function showPeek(y) {
    if (!host) build();
    if (!host.isConnected) document.documentElement.append(host);
    clearTimeout(peekTimer);
    if (peek.classList.contains("show")) return; // 이미 떠 있으면 그 자리에 둔다
    // host 가 1/zoom 로 줄어 있으므로 페이지 좌표에 zoom 을 곱해 host 안 좌표로
    peek.style.top = `${Math.max(8, Math.min(innerHeight * zoom - 94, y * zoom - 43))}px`;
    peek.classList.add("show");
  }

  function hidePeek() {
    clearTimeout(peekTimer);
    peek?.classList.remove("show");
  }

  async function loadConf() {
    if (!alive()) return;
    const { mode, data } = await chrome.storage.local.get(["mode", "data"]);
    const c = mode === "server" ? data?.conf : (await chrome.storage.sync.get("conf")).conf;
    conf = { ...DEFAULT_CONF, ...c };
    // 예전에 500ms 까지 저장했던 값은 지금 최대(300)로 (src/store.js 의 RANGES)
    for (const k of ["slideSpeed", "folderSpeed"]) conf[k] = Number.isFinite(conf[k]) ? Math.min(300, Math.max(0, conf[k])) : DEFAULT_CONF[k];
    applyConf();
  }

  // 글자 크기 · 목록 간격 · 너비 · 애니메이션 시간 (범위는 설정 저장할 때 맞춰져 온다)
  // 시간은 host 에 넣는다 (패널 옆의 반투명 덮개도 같이 쓰도록)
  function applyConf() {
    if (!panel) return;
    panel.style.setProperty("--font-size", `${conf.fontSize}px`);
    panel.style.setProperty("--row-height", `${conf.rowHeight}px`);
    panel.style.setProperty("--width", `${conf.width}px`);
    host.style.setProperty("--slide", `${conf.slideSpeed}ms`);
    host.style.setProperty("--fold", `${conf.folderSpeed}ms`);
  }

  function askZoom() {
    if (zoomAsked || !alive()) return;
    zoomAsked = true;
    send({ type: "zoom" }).then(setZoom, () => {});
  }

  function setZoom(z) {
    if (!(z > 0) || z === zoom) return;
    zoom = z;
    applyZoom();
  }

  const applyZoom = () => host?.style.setProperty("zoom", String(1 / zoom));
  loadConf();
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === "sync" && changes.conf) || (area === "local" && (changes.mode || changes.data))) loadConf();
  });

  // ---------- 페이지 이벤트 ----------

  // 열기 탭을 띄우는 경우(최대화일 때만 열기 + 창 모드·팝업)만 감지 폭을 넓힌다
  const edgeWidth = () => (conf.maximizedOnly && conf.peekWindowed && !isMaximized() ? PEEK_EDGE : EDGE);

  // 감지 폭(EDGE 등)은 화면 px 기준 → 페이지 좌표에 zoom 을 곱해서 비교한다
  addEventListener("mousemove", (e) => {
    const x = e.clientX * zoom;
    if (x < 200) askZoom(); // 왼쪽 끝에 닿기 전에 미리 배율을 알아 둔다
    if (x <= EDGE || (x <= PEEK_EDGE && x <= edgeWidth())) edgeHit(e);
    else if (x > 120 && peek?.classList.contains("show")) hidePeek(); // 마우스가 멀어지면 열기 탭은 숨긴다
  }, { capture: true, passive: true });

  // 왼쪽에 모니터가 더 있으면 마우스가 끝에서 멈추지 않고 바로 옆 화면으로 넘어간다
  document.addEventListener("mouseout", (e) => {
    if (!e.relatedTarget && e.clientX * zoom <= EXIT_EDGE && e.clientY >= 0 && e.clientY <= innerHeight) edgeHit(e);
  }, true);

  addEventListener("mousedown", (e) => {
    if (isOpen && !e.composedPath().includes(host)) close();
  }, true);

  addEventListener("keydown", (e) => {
    if (!isOpen || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (asking) {
      asking(false);
    } else if (editing) {
      editing.cancel();
      list.focus({ preventScroll: true });
    } else if (deleting) {
      setDeleting(false);
    } else if (search.value) {
      search.value = "";
      runSearch();
      search.focus({ preventScroll: true });
    } else close();
  }, true);

  document.addEventListener("fullscreenchange", close);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "toggle") isOpen ? close() : open();
    else if (msg.type === "zoom") {
      zoomAsked = true; // 알려 줬으니 따로 묻지 않아도 된다
      setZoom(msg.zoom);
    }
  });
})();
