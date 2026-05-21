const entryView = document.querySelector("#entryView");
const memoView = document.querySelector("#memoView");
const joinForm = document.querySelector("#joinForm");
const roomInput = document.querySelector("#roomInput");
const nameInput = document.querySelector("#nameInput");
const passwordInput = document.querySelector("#passwordInput");
const entryError = document.querySelector("#entryError");
const roomLabel = document.querySelector("#roomLabel");
const pageList = document.querySelector("#pageList");
const addPageButton = document.querySelector("#addPageButton");
const pageTitleInput = document.querySelector("#pageTitleInput");
const editTitleButton = document.querySelector("#editTitleButton");
const statusText = document.querySelector("#statusText");
const userList = document.querySelector("#userList");
const deletePageButton = document.querySelector("#deletePageButton");
const saveButton = document.querySelector("#saveButton");
const leaveButton = document.querySelector("#leaveButton");
const memoInput = document.querySelector("#memoInput");
const cursorLayer = document.querySelector("#cursorLayer");
const sessionKey = "collaborate-memo-session";

const state = {
  socket: null,
  selfId: "",
  roomId: "",
  userName: "",
  password: "",
  activePageId: "",
  pages: [],
  users: new Map(),
  lastValue: "",
  titleTimer: null,
  titleBeforeEdit: "",
  localSequence: 0,
  reconnectTimer: null,
  heartbeatTimer: null,
  reconnectAttempts: 0,
  joined: false,
  leaving: false
};

const params = new URLSearchParams(location.search);
roomInput.value = params.get("room") || localStorage.getItem("memo-room") || "";
nameInput.value = localStorage.getItem("memo-name") || "";

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const roomId = roomInput.value.trim() || "default";
  const userName = nameInput.value.trim() || "Guest";
  const password = passwordInput.value;

  entryError.textContent = "";
  localStorage.setItem("memo-room", roomId);
  localStorage.setItem("memo-name", userName);
  connect(roomId, userName, password);
});

addPageButton.addEventListener("click", () => {
  send({ type: "add-page", title: `Page ${state.pages.length + 1}` });
});

deletePageButton.addEventListener("click", () => {
  const page = currentPage();
  if (!page || state.pages.length <= 1) return;
  send({ type: "delete-page", pageId: page.id });
});

leaveButton.addEventListener("click", leaveRoom);

editTitleButton.addEventListener("click", () => {
  if (pageTitleInput.readOnly) {
    beginTitleEdit();
  } else {
    commitTitleEdit();
  }
});

editTitleButton.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

pageTitleInput.addEventListener("input", () => {
  const page = currentPage();
  if (!page) return;
  page.title = normalizeTitle(pageTitleInput.value, page.title);
  renderPages();

  clearTimeout(state.titleTimer);
  state.titleTimer = setTimeout(() => {
    send({ type: "rename-page", pageId: page.id, title: page.title });
  }, 300);
});

pageTitleInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    commitTitleEdit();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    cancelTitleEdit();
  }
});

pageTitleInput.addEventListener("blur", () => {
  if (!pageTitleInput.readOnly) commitTitleEdit();
});

memoInput.addEventListener("input", () => {
  const page = currentPage();
  if (!page) return;

  const nextValue = memoInput.value;
  const op = diffText(state.lastValue, nextValue);
  if (!op) return;

  page.text = nextValue;
  state.lastValue = nextValue;
  page.version += 1;
  state.localSequence += 1;

  send({
    type: "page-op",
    pageId: page.id,
    op,
    baseVersion: page.version - 1,
    sequence: state.localSequence,
    cursor: localCursorPayload()
  });
  sendCursor();
});

memoInput.addEventListener("keyup", sendCursor);
memoInput.addEventListener("click", sendCursor);
memoInput.addEventListener("select", sendCursor);
memoInput.addEventListener("mouseup", sendCursor);
memoInput.addEventListener("scroll", renderCursors);
window.addEventListener("resize", renderCursors);
document.addEventListener("selectionchange", () => {
  if (document.activeElement === memoInput) sendCursor();
});

saveButton.addEventListener("click", () => {
  const page = currentPage();
  if (!page) return;

  const safeTitle = page.title.replace(/[\\/:*?"<>|]/g, "_") || "memo";
  const blob = new Blob([page.text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeTitle}.txt`;
  anchor.click();
  URL.revokeObjectURL(url);
});

function connect(roomId = state.roomId, userName = state.userName, password = state.password) {
  clearTimeout(state.reconnectTimer);
  state.leaving = false;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}`);

  state.socket = socket;
  state.roomId = roomId;
  state.userName = userName;
  state.password = password;
  setStatus("connecting");

  socket.addEventListener("open", () => {
    send({ type: "join", roomId, userName, password });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    handleMessage(message);
  });

  socket.addEventListener("close", () => {
    setStatus("offline");
    stopHeartbeat();
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    setStatus("error");
  });
}

function send(message) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(message));
  }
}

function handleMessage(message) {
  if (message.type === "joined") {
    state.selfId = message.selfId;
    state.activePageId = message.room.activePageId;
    state.pages = message.room.pages;
    state.users = new Map(message.room.users.map((user) => [user.id, user]));
    state.joined = true;
    state.reconnectAttempts = 0;
    startHeartbeat();
    saveSession();
    entryView.classList.add("hidden");
    memoView.classList.remove("hidden");
    roomLabel.textContent = state.roomId;
    setStatus("online");
    switchPage(state.activePageId, false);
    renderAll();
  }

  if (message.type === "join-error") {
    state.joined = false;
    stopHeartbeat();
    clearSession();
    state.socket?.close();
    entryView.classList.remove("hidden");
    memoView.classList.add("hidden");
    const errorLabels = {
      "invalid-password": "合言葉が違います。",
      "room-full": "このルームは満員です。",
      "server-full": "作成できるルーム数の上限に達しています。"
    };
    entryError.textContent = errorLabels[message.reason] || "入室できませんでした。";
    setStatus("offline");
  }

  if (message.type === "user-joined") {
    state.users.set(message.user.id, message.user);
    renderUsers();
  }

  if (message.type === "user-left") {
    state.users.delete(message.userId);
    renderUsers();
    renderCursors();
  }

  if (message.type === "page-op") {
    receivePageOp(message);
  }

  if (message.type === "cursor") {
    const user = state.users.get(message.userId);
    if (user) {
      user.cursor = message.cursor;
      user.activePageId = message.cursor.pageId;
      renderCursors();
    }
  }

  if (message.type === "page-added") {
    state.pages.push(message.page);
    state.activePageId = message.page.id;
    switchPage(message.page.id, false);
    renderAll();
  }

  if (message.type === "page-deleted") {
    state.pages = state.pages.filter((page) => page.id !== message.pageId);
    if (state.pages.length === 0) return;
    const nextPageId = state.pages.some((page) => page.id === state.activePageId)
      ? state.activePageId
      : message.activePageId || state.pages[0].id;
    switchPage(nextPageId, false);
    renderAll();
  }

  if (message.type === "page-renamed") {
    const page = state.pages.find((item) => item.id === message.pageId);
    if (page) {
      page.title = message.title;
      const editingThisTitle = page.id === state.activePageId && !pageTitleInput.readOnly;
      if (page.id === state.activePageId && !editingThisTitle) {
        pageTitleInput.value = page.title;
      }
      renderPages();
    }
  }
}

function receivePageOp(message) {
  const page = state.pages.find((item) => item.id === message.pageId);
  if (!page || message.userId === state.selfId) {
    if (page) page.version = Math.max(page.version, message.version);
    return;
  }

  page.text = applyOp(page.text, message.op);
  page.version = Math.max(page.version, message.version);

  const user = state.users.get(message.userId);
  if (user && message.cursor) user.cursor = message.cursor;

  if (page.id === state.activePageId) {
    const selectionStart = transformPosition(memoInput.selectionStart, message.op);
    const selectionEnd = transformPosition(memoInput.selectionEnd, message.op);
    memoInput.value = page.text;
    state.lastValue = page.text;
    memoInput.setSelectionRange(selectionStart, selectionEnd);
    renderCursors();
  }
}

function renderAll() {
  renderPages();
  renderUsers();
  renderCursors();
}

function renderPages() {
  pageList.replaceChildren(
    ...state.pages.map((page) => {
      const button = document.createElement("button");
      button.className = `page-item${page.id === state.activePageId ? " active" : ""}`;
      button.type = "button";
      button.textContent = page.title || "Untitled";
      button.addEventListener("click", () => switchPage(page.id, true));
      return button;
    })
  );
  deletePageButton.disabled = state.pages.length <= 1;
  deletePageButton.title = state.pages.length <= 1 ? "最後のページは削除できません" : "現在のページを削除";
}

function renderUsers() {
  const users = [...state.users.values()];
  userList.replaceChildren(
    ...users.map((user) => {
      const pill = document.createElement("span");
      pill.className = "user-pill";
      pill.style.setProperty("--user-color", user.color);
      pill.title = user.name;

      const dot = document.createElement("span");
      dot.className = "user-dot";
      const name = document.createElement("span");
      name.className = "user-name";
      name.textContent = user.id === state.selfId ? `${user.name} (自分)` : user.name;

      pill.append(dot, name);
      return pill;
    })
  );
}

function renderCursors() {
  const page = currentPage();
  if (!page) return;

  const cursors = [...state.users.values()].filter(
    (user) => user.id !== state.selfId && user.cursor?.pageId === state.activePageId
  );
  const cursorGroups = groupCursorsByPosition(cursors);
  const selections = cursors.flatMap((user) => renderSelectionForUser(user));

  cursorLayer.replaceChildren(
    ...selections,
    ...cursorGroups.map((group) => {
      const point = caretPoint(memoInput, group.index);
      const cursor = document.createElement("div");
      cursor.className = "remote-cursor";
      cursor.style.left = `${point.left}px`;
      cursor.style.top = `${point.top}px`;
      cursor.style.setProperty("--cursor-color", group.users[0].color);

      const label = document.createElement("span");
      label.className = "remote-cursor-label";
      label.textContent = group.users.map((user) => user.name).join(", ");

      const colorStack = document.createElement("strong");
      colorStack.className = "remote-cursor-colors";
      for (const user of group.users) {
        const dot = document.createElement("i");
        dot.style.setProperty("--cursor-color", user.color);
        colorStack.append(dot);
      }

      label.prepend(colorStack);
      cursor.append(label);
      return cursor;
    })
  );
}

function renderSelectionForUser(user) {
  const start = Number(user.cursor.start ?? user.cursor.index) || 0;
  const end = Number(user.cursor.end ?? user.cursor.index) || 0;
  if (start === end) return [];

  const rects = selectionRects(memoInput, Math.min(start, end), Math.max(start, end));
  return rects.map((rect, index) => {
    const selection = document.createElement("div");
    selection.className = "remote-selection";
    selection.style.left = `${rect.left}px`;
    selection.style.top = `${rect.top}px`;
    selection.style.width = `${rect.width}px`;
    selection.style.height = `${rect.height}px`;
    selection.style.background = hexToRgba(user.color, 0.18);
    selection.style.borderColor = hexToRgba(user.color, 0.34);

    if (index === 0) {
      const label = document.createElement("span");
      label.className = "remote-selection-label";
      label.textContent = user.name;
      label.style.background = user.color;
      selection.append(label);
    }

    return selection;
  });
}

function groupCursorsByPosition(users) {
  const groups = new Map();

  for (const user of users) {
    const index = Number(user.cursor.index) || 0;
    const key = `${user.cursor.pageId}:${index}`;
    const group = groups.get(key) || { index, users: [] };
    group.users.push(user);
    groups.set(key, group);
  }

  return [...groups.values()];
}

function switchPage(pageId, notify) {
  const page = state.pages.find((item) => item.id === pageId);
  if (!page) return;

  clearTimeout(state.titleTimer);
  state.activePageId = page.id;
  pageTitleInput.value = page.title;
  endTitleEditMode();
  memoInput.value = page.text;
  state.lastValue = page.text;
  renderAll();
  memoInput.focus();

  if (notify) {
    send({ type: "switch-page", pageId });
    sendCursor();
  }
}

function currentPage() {
  return state.pages.find((page) => page.id === state.activePageId);
}

function beginTitleEdit() {
  const page = currentPage();
  if (!page) return;

  state.titleBeforeEdit = page.title;
  pageTitleInput.readOnly = false;
  editTitleButton.textContent = "完了";
  pageTitleInput.focus();
  pageTitleInput.select();
}

function commitTitleEdit() {
  const page = currentPage();
  if (!page) return;

  clearTimeout(state.titleTimer);
  page.title = normalizeTitle(pageTitleInput.value, state.titleBeforeEdit || page.title);
  pageTitleInput.value = page.title;
  send({ type: "rename-page", pageId: page.id, title: page.title });
  renderPages();
  endTitleEditMode();
}

function cancelTitleEdit() {
  const page = currentPage();
  if (!page) return;

  clearTimeout(state.titleTimer);
  page.title = state.titleBeforeEdit || page.title;
  pageTitleInput.value = page.title;
  renderPages();
  endTitleEditMode();
}

function endTitleEditMode() {
  pageTitleInput.readOnly = true;
  editTitleButton.textContent = "編集";
  state.titleBeforeEdit = "";
}

function normalizeTitle(title, fallback) {
  const normalized = title.trim().slice(0, 40);
  return normalized || fallback || "Untitled";
}

function setStatus(status) {
  const labels = {
    connecting: "接続状態: 接続中",
    online: "接続状態: 同期中",
    offline: "接続状態: オフライン",
    error: "接続状態: 接続エラー"
  };

  statusText.textContent = labels[status] || labels.offline;
  statusText.className = `status is-${status}`;
}

function scheduleReconnect() {
  if (state.leaving || !state.joined || !state.roomId) return;

  const delay = Math.min(12000, 1000 * 2 ** state.reconnectAttempts);
  state.reconnectAttempts += 1;
  state.reconnectTimer = setTimeout(() => {
    connect();
  }, delay);
}

function startHeartbeat() {
  stopHeartbeat();
  state.heartbeatTimer = setInterval(() => {
    send({ type: "heartbeat" });
  }, 30000);
}

function stopHeartbeat() {
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

function sendCursor() {
  const page = currentPage();
  if (!page) return;
  const payload = localCursorPayload();
  send({ type: "cursor", ...payload });
  const user = state.users.get(state.selfId);
  if (user) {
    user.cursor = payload;
    user.activePageId = page.id;
  }
}

function localCursorPayload() {
  const page = currentPage();
  const start = memoInput.selectionStart;
  const end = memoInput.selectionEnd;
  const index = memoInput.selectionDirection === "backward" ? start : end;

  return {
    pageId: page.id,
    index,
    start: Math.min(start, end),
    end: Math.max(start, end)
  };
}

function saveSession() {
  sessionStorage.setItem(
    sessionKey,
    JSON.stringify({
      roomId: state.roomId,
      userName: state.userName,
      password: state.password
    })
  );
}

function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(sessionKey) || "null");
  } catch {
    return null;
  }
}

function clearSession() {
  sessionStorage.removeItem(sessionKey);
}

function leaveRoom() {
  state.leaving = true;
  state.joined = false;
  clearTimeout(state.reconnectTimer);
  stopHeartbeat();
  clearSession();
  state.socket?.close();
  state.socket = null;
  state.selfId = "";
  state.activePageId = "";
  state.pages = [];
  state.users = new Map();
  state.lastValue = "";
  entryError.textContent = "";
  memoView.classList.add("hidden");
  entryView.classList.remove("hidden");
  setStatus("offline");
}

function diffText(before, after) {
  if (before === after) return null;

  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }

  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  return {
    start,
    deleteCount: beforeEnd - start,
    insert: after.slice(start, afterEnd)
  };
}

function applyOp(text, op) {
  return text.slice(0, op.start) + op.insert + text.slice(op.start + op.deleteCount);
}

function transformPosition(position, op) {
  const start = op.start;
  const end = op.start + op.deleteCount;

  if (position < start) return position;
  if (position > end) return position + op.insert.length - op.deleteCount;
  return start + op.insert.length;
}

function caretPoint(textarea, position) {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const span = document.createElement("span");
  const properties = [
    "boxSizing",
    "width",
    "height",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "letterSpacing",
    "lineHeight",
    "tabSize",
    "textTransform",
    "textAlign",
    "whiteSpace",
    "wordBreak",
    "overflowWrap"
  ];

  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.overflow = "hidden";

  for (const property of properties) {
    mirror.style[property] = style[property];
  }

  mirror.textContent = textarea.value.slice(0, position);
  span.textContent = "\u200b";
  mirror.append(span);
  document.body.append(mirror);

  const textareaRect = textarea.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();
  const spanRect = span.getBoundingClientRect();
  const left = spanRect.left - mirrorRect.left + textarea.offsetLeft - textarea.scrollLeft;
  const top = spanRect.top - mirrorRect.top + textarea.offsetTop - textarea.scrollTop;
  mirror.remove();

  return {
    left: Math.min(Math.max(left, 0), textareaRect.width - 20),
    top: Math.min(Math.max(top, 0), textareaRect.height - parseFloat(style.lineHeight))
  };
}

function selectionRects(textarea, start, end) {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const selection = document.createElement("span");
  const properties = [
    "boxSizing",
    "width",
    "height",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "letterSpacing",
    "lineHeight",
    "tabSize",
    "textTransform",
    "textAlign",
    "whiteSpace",
    "wordBreak",
    "overflowWrap"
  ];

  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.overflow = "hidden";

  for (const property of properties) {
    mirror.style[property] = style[property];
  }

  mirror.append(document.createTextNode(textarea.value.slice(0, start)));
  selection.textContent = textarea.value.slice(start, end);
  mirror.append(selection);
  mirror.append(document.createTextNode(textarea.value.slice(end) || "\u200b"));
  document.body.append(mirror);

  const textareaRect = textarea.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();
  const lineHeight = parseFloat(style.lineHeight);
  const rects = [...selection.getClientRects()]
    .map((rect) => ({
      left: rect.left - mirrorRect.left + textarea.offsetLeft - textarea.scrollLeft,
      top: rect.top - mirrorRect.top + textarea.offsetTop - textarea.scrollTop,
      width: rect.width,
      height: Math.max(rect.height, lineHeight)
    }))
    .filter((rect) => rect.width > 0 && rect.top + rect.height > 0 && rect.top < textareaRect.height);

  mirror.remove();

  return rects.map((rect) => {
    const top = Math.max(0, rect.top);
    const left = Math.max(0, rect.left);
    const right = Math.min(textareaRect.width, rect.left + rect.width);
    return {
      left,
      top,
      width: Math.max(0, right - left),
      height: Math.min(rect.height, textareaRect.height - top)
    };
  });
}

function hexToRgba(hex, alpha) {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized,
    16
  );
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

const savedSession = loadSession();
if (savedSession?.roomId && savedSession?.userName) {
  roomInput.value = savedSession.roomId;
  nameInput.value = savedSession.userName;
  passwordInput.value = savedSession.password || "";
  connect(savedSession.roomId, savedSession.userName, savedSession.password || "");
}
