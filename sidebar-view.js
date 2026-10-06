// EdgeMark 사이드바 모양과 한 줄(북마크·폴더) 만들기.
// 콘텐츠 스크립트(content.js, 페이지 위 사이드바)와 설정 화면(options.js, 미리보기)이 같이 쓴다.
// 콘텐츠 스크립트에서는 확장 전용 공간(isolated world)의 전역이라 페이지에는 보이지 않는다.
globalThis.EdgeMarkView = (() => {
  const FAVICON = chrome.runtime.getURL("/_favicon/");
  const FOLDER_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2l1.6 1.6H13A1.5 1.5 0 0 1 14.5 5v7.5A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5z"/></svg>';

  const ICON_ADD_FOLDER = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.75 4A1.25 1.25 0 0 1 3 2.75h3l1.5 1.5H13a1.25 1.25 0 0 1 1.25 1.25v6.5A1.25 1.25 0 0 1 13 13.25H3A1.25 1.25 0 0 1 1.75 12z"/><path d="M8 6.5v4M6 8.5h4"/></svg>';
  const ICON_DELETE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M6.5 4V2.75h3V4M4 4l.7 9.25h6.6L12 4M6.75 6.5v4.5M9.25 6.5v4.5"/></svg>';
  // 톱니바퀴: TapCode 팝업의 설정 아이콘과 같은 모양 (Lucide, 24×24)
  const ICON_SETTINGS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const ICON_MINUS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8h8"/></svg>';
  const ICON_PLUS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>';

  // 아이콘·화살표·들여쓰기는 글자 크기(--font-size)에 비례한다 (15px 일 때 아이콘 약 19px, 들여쓰기 약 17px)
  // --slide: 사이드바 열고 닫는 시간, --fold: 폴더 화살표 도는 시간 (content.js 가 설정대로 넣는다)
  const CSS = `
    :host {
      --bg: #ffffff; --fg: #1f2328; --muted: #6b7280; --line: #e5e7eb; --hover: #f1f3f5; --accent: #2563eb; --danger: #dc2626; --green: #16a34a;
    }
    @media (prefers-color-scheme: dark) {
      :host { --bg: #1f2023; --fg: #e6e6e6; --muted: #9ca3af; --line: #34363b; --hover: #2a2c30; --accent: #60a5fa; --danger: #f87171; --green: #4ade80; }
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .panel {
      position: fixed; top: 0; left: 0; bottom: 0; width: var(--width, 400px); max-width: 100%; /* vw 는 확대 보정(zoom)과 어긋난다 */
      display: flex; flex-direction: column;
      background: var(--bg); color: var(--fg);
      border-right: 1px solid var(--line); box-shadow: 2px 0 16px rgba(0, 0, 0, .18);
      font: var(--font-size, 15px)/1.4 "Segoe UI", "Malgun Gothic", sans-serif;
      transform: translateX(-100%); visibility: hidden;
      transition: transform var(--slide, 100ms) ease-out, visibility 0s linear var(--slide, 100ms);
    }
    .panel.open { transform: none; visibility: visible; transition: transform var(--slide, 100ms) ease-out; }
    /* 사이드바가 열리면 나머지 화면을 반투명하게 덮는다 (누르면 닫힘) */
    .backdrop {
      position: fixed; inset: 0; background: rgba(0, 0, 0, .55);
      opacity: 0; visibility: hidden;
      transition: opacity var(--slide, 100ms) ease-out, visibility 0s linear var(--slide, 100ms);
    }
    .backdrop.open { opacity: 1; visibility: visible; transition: opacity var(--slide, 100ms) ease-out; }
    .top { display: flex; gap: 6px; margin: 10px; }
    .search {
      flex: 1; min-width: 0; padding: 7px 10px; font: inherit; color: var(--fg);
      background: var(--hover); border: 1px solid var(--line); border-radius: 8px; outline: none;
    }
    .search:focus { border-color: var(--accent); }
    .btn {
      flex: none; width: calc(var(--font-size, 15px) * 2.4); padding: 0; display: grid; place-items: center;
      color: var(--muted); background: var(--hover); border: 1px solid var(--line); border-radius: 8px; cursor: pointer;
    }
    .btn:hover { color: var(--accent); border-color: var(--accent); }
    .btn svg { width: calc(var(--font-size, 15px) * 1.3); height: calc(var(--font-size, 15px) * 1.3); }
    .row.editing { cursor: default; }
    .row.editing .name {
      flex: 1; min-width: 0; margin-right: 2px; padding: 2px 6px; font: inherit; color: var(--fg);
      background: var(--bg); border: 1px solid var(--accent); border-radius: 6px; outline: none;
    }
    .toast {
      position: absolute; left: 10px; right: 10px; bottom: 10px; padding: 8px 12px; border-radius: 8px;
      background: var(--fg); color: var(--bg); opacity: 0; transition: opacity .15s; pointer-events: none;
    }
    .toast.show { opacity: 1; }
    .toast.show.act { pointer-events: auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .toast .undo {
      flex: none; padding: 2px 8px; font: inherit; color: var(--bg); background: transparent;
      border: 1px solid currentColor; border-radius: 6px; cursor: pointer;
    }
    /* 폴더 줄 오른쪽 끝 +: 현재 페이지를 이 폴더에 추가 (마우스를 올리거나 고른 줄에서만 보임) */
    .plus {
      flex: none; margin-left: auto; padding: 0; display: grid; place-items: center; visibility: hidden;
      width: calc(var(--font-size, 15px) * 1.7); height: calc(var(--font-size, 15px) * 1.7);
      color: var(--muted); background: transparent; border: 0; border-radius: 6px; cursor: pointer;
    }
    .plus svg { width: 70%; height: 70%; }
    .row:hover .plus, .row.active .plus { visibility: visible; }
    .plus:hover { color: var(--accent); background: color-mix(in srgb, var(--accent) 15%, transparent); }
    /* 삭제 모드: 상단 삭제 버튼을 누르면 + 대신 줄마다 − 가 나온다 (누르면 삭제).
       빨간 표시는 모두 '빨간 글자 + 옅은 빨간 바탕' 으로 맞춘다 (+ 의 파란 hover, 설정 화면 버튼과 같은 방식) */
    .minus {
      flex: none; margin-left: auto; padding: 0; display: none; place-items: center;
      width: calc(var(--font-size, 15px) * 1.7); height: calc(var(--font-size, 15px) * 1.7);
      color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent);
      border: 0; border-radius: 6px; cursor: pointer;
    }
    .minus svg { width: 70%; height: 70%; }
    .minus:hover { background: color-mix(in srgb, var(--danger) 26%, transparent); }
    .deleting .minus { display: grid; }
    .deleting .plus { display: none; }
    .deleting .link { cursor: default; }
    /* 삭제 버튼: 마우스를 올리면 빨간 휴지통, 삭제 모드 중에는 파란색(켜져 있음) */
    .btn.del:hover {
      color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent);
      border-color: color-mix(in srgb, var(--danger) 45%, transparent);
    }
    .btn.on, .btn.on:hover {
      color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent);
      border-color: color-mix(in srgb, var(--accent) 45%, transparent);
    }
    /* 확인창 (사이드바 안) */
    .ask {
      position: absolute; inset: 0; display: grid; place-items: center; padding: 16px;
      background: rgba(0, 0, 0, .35);
    }
    .ask .box {
      width: 100%; padding: 16px; border-radius: 10px; background: var(--bg); color: var(--fg);
      border: 1px solid var(--line); box-shadow: 0 8px 24px rgba(0, 0, 0, .25);
    }
    .ask p { margin: 0 0 14px; line-height: 1.5; word-break: break-all; }
    .ask .actions { display: flex; justify-content: flex-end; gap: 8px; }
    .ask button {
      padding: 6px 14px; font: inherit; color: var(--fg); background: transparent;
      border: 1px solid var(--line); border-radius: 8px; cursor: pointer;
    }
    .ask button.ok {
      color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent);
      border-color: color-mix(in srgb, var(--danger) 45%, transparent);
    }
    .ask button.ok:hover, .ask button.ok:focus-visible { background: color-mix(in srgb, var(--danger) 26%, transparent); outline: none; }
    .ask button.ok.safe {
      color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent);
      border-color: color-mix(in srgb, var(--accent) 45%, transparent);
    }
    .ask button.ok.safe:hover, .ask button.ok.safe:focus-visible { background: color-mix(in srgb, var(--accent) 26%, transparent); }
    .ask button.cancel:hover { border-color: var(--muted); }
    /* 드래그로 옮기기: 앞/뒤 선, 폴더 안으로 넣을 때는 줄 전체 */
    .row.dragging { opacity: .45; }
    .row.drop-before { box-shadow: inset 0 2px 0 var(--accent); }
    .row.drop-after { box-shadow: inset 0 -2px 0 var(--accent); }
    .row.drop-into { background: color-mix(in srgb, var(--accent) 22%, transparent); }
    /* 창 모드·팝업: 사이드바 대신 왼쪽 끝에 살짝 나오는 열기 탭 (누르면 열림) */
    .peek {
      position: fixed; left: 0; width: 38px; height: 86px; padding: 0; display: grid; place-items: center;
      /* 테마 바탕에 초록빛: 초록 화살표 + 옅은 초록 바탕 + 초록 테두리 (어두운 페이지에서도 보이게) */
      color: var(--green); background: color-mix(in srgb, var(--green) 18%, var(--bg));
      border: 1px solid color-mix(in srgb, var(--green) 55%, transparent); border-left: 0; border-radius: 0 11px 11px 0;
      box-shadow: 2px 0 10px rgba(0, 0, 0, .18); cursor: pointer;
      transform: translateX(-100%); visibility: hidden;
      transition: transform .1s ease-out, visibility 0s linear .1s;
    }
    .peek.show { transform: none; visibility: visible; transition: transform .1s ease-out; }
    .peek:hover { width: 46px; background: color-mix(in srgb, var(--green) 30%, var(--bg)); }
    .peek svg { width: 20px; height: 20px; }
    .list { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding-bottom: 10px; }
    .row {
      display: flex; align-items: center; gap: calc(var(--font-size, 15px) * .45); height: var(--row-height, 40px); padding-right: 10px;
      cursor: pointer; user-select: none; white-space: nowrap;
    }
    /* 마우스가 올라간 줄: 초록 테두리 + 옅은 초록 바탕 (열기 탭의 18% 보다 옅게, 고른 줄의 파란 표시와 겹쳐도 구별되게) */
    .row:hover {
      background: color-mix(in srgb, var(--green) 10%, var(--bg)); border-radius: 6px;
      outline: 2px solid var(--green); outline-offset: -2px;
    }
    /* 고른 줄: 진한 파란 바탕 + 왼쪽 파란 막대 (눈에 띄게) */
    .row.active {
      background: color-mix(in srgb, var(--accent) 30%, transparent);
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .list:focus { outline: none; }
    .arrow { flex: none; width: calc(var(--font-size, 15px) * .77); }
    .folder .arrow::before {
      content: ""; display: block; margin-left: 1px;
      width: calc(var(--font-size, 15px) * .38); height: calc(var(--font-size, 15px) * .38);
      border-right: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted);
      transform: rotate(-45deg); transition: transform var(--fold, 100ms);
    }
    .folder.expanded .arrow::before { transform: rotate(45deg); }
    .icon { flex: none; width: calc(var(--font-size, 15px) * 1.25); height: calc(var(--font-size, 15px) * 1.25); display: block; }
    .icon svg { display: block; width: 100%; height: 100%; }
    .folder .icon { color: var(--muted); }
    .title { overflow: hidden; text-overflow: ellipsis; }
    .empty { padding: 12px 16px; color: var(--muted); }
  `;

  function item(b, depth) {
    const el = document.createElement("div");
    const row = document.createElement("div");
    row.className = b.url ? "row link" : "row folder";
    row.style.paddingLeft = `calc(8px + ${depth} * 1.1 * var(--font-size, 15px))`;
    row.dataset.id = b.id;
    row.dataset.parent = b.parentId || "";
    row.dataset.index = b.index ?? "";
    row.draggable = b.parentId !== "0"; // '기타 즐겨찾기' 같은 기본 폴더는 옮길 수 없다
    row.dataset.depth = depth;

    const arrow = document.createElement("span");
    arrow.className = "arrow";
    let icon;
    if (b.url) {
      row.dataset.url = b.url;
      row.title = b.title ? `${b.title}\n${b.url}` : b.url;
      icon = document.createElement("img");
      icon.src = `${FAVICON}?pageUrl=${encodeURIComponent(b.url)}&size=32`;
      icon.loading = "lazy";
      icon.alt = "";
    } else {
      icon = document.createElement("span");
      icon.innerHTML = FOLDER_SVG;
    }
    icon.className = "icon";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = b.title || b.url || "(제목 없음)";

    row.append(arrow, icon, title);
    if (!b.url) {
      const plus = document.createElement("button");
      plus.className = "plus";
      plus.tabIndex = -1;
      plus.title = "현재 페이지를 이 폴더에 추가";
      plus.innerHTML = ICON_PLUS;
      row.append(plus);
    }
    if (b.parentId !== "0") { // 기본 폴더는 지울 수 없다
      const minus = document.createElement("button");
      minus.className = "minus";
      minus.tabIndex = -1;
      minus.title = "삭제";
      minus.innerHTML = ICON_MINUS;
      row.append(minus);
    }
    el.append(row);
    if (!b.url) el.append(document.createElement("div")); // 하위 항목 자리
    return el;
  }

  // 정렬. title: 폴더 먼저(글자순) 그다음 북마크(글자순) / browser: 브라우저에 저장된 순서 그대로
  const collator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });
  const name = (b) => b.title || b.url || "";
  function sortItems(list, sort) {
    if (sort !== "title") return list;
    return [...list].sort((a, b) => (!a.url === !b.url ? collator.compare(name(a), name(b)) : a.url ? 1 : -1));
  }

  // 폴더 이름 입력 줄 (폴더 추가)
  function editRow(depth) {
    const row = document.createElement("div");
    row.className = "row editing";
    row.style.paddingLeft = `calc(8px + ${depth} * 1.1 * var(--font-size, 15px))`;
    row.innerHTML = `<span class="arrow"></span><span class="icon">${FOLDER_SVG}</span><input class="name" placeholder="새 폴더 이름" spellcheck="false" autocomplete="off">`;
    return row;
  }

  const ICON_PEEK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>';

  return { CSS, item, editRow, sortItems, ICON_ADD_FOLDER, ICON_DELETE, ICON_SETTINGS, ICON_PEEK };
})();
