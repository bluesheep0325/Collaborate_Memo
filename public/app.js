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
const pageSearchInput = document.querySelector("#pageSearchInput");
const pageTitleInput = document.querySelector("#pageTitleInput");
const statusText = document.querySelector("#statusText");
const userList = document.querySelector("#userList");
const shareButton = document.querySelector("#shareButton");
const duplicatePageButton = document.querySelector("#duplicatePageButton");
const previewButton = document.querySelector("#previewButton");
const restorePageButton = document.querySelector("#restorePageButton");
const importButton = document.querySelector("#importButton");
const exportButton = document.querySelector("#exportButton");
const deletePageButton = document.querySelector("#deletePageButton");
const saveButton = document.querySelector("#saveButton");
const leaveButton = document.querySelector("#leaveButton");
const importFileInput = document.querySelector("#importFileInput");
const memoInput = document.querySelector("#memoInput");
const editorFrame = document.querySelector(".editor-frame");
const previewPane = document.querySelector("#previewPane");
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
  deletedPageCount: 0,
  searchQuery: "",
  previewMode: false,
  draggingPageId: "",
  lastValue: "",
  titleTimer: null,
  titleBeforeEdit: "",
  localSequence: 0,
  reconnectTimer: null,
  heartbeatTimer: null,
  noticeTimer: null,
  reconnectAttempts: 0,
  joined: false,
  leaving: false,
  forceNextInputReplace: false,
  composing: false,
  pendingOps: new Map(),
  pendingRecoveries: new Map(),
  recoveryCounter: 0,
  maxPageChars: 0
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
  if (!canEdit()) return;
  send({ type: "add-page", title: `Page ${state.pages.length + 1}` });
});

deletePageButton.addEventListener("click", () => {
  if (!canEdit()) return;
  const page = currentPage();
  if (!page || state.pages.length <= 1) return;
  if (!confirm(`「${page.title}」を削除しますか？この操作は元に戻せません。`)) return;
  send({ type: "delete-page", pageId: page.id });
});

leaveButton.addEventListener("click", leaveRoom);

pageSearchInput.addEventListener("input", () => {
  state.searchQuery = pageSearchInput.value.trim().toLowerCase();
  renderPages();
});

pageList.addEventListener("dragover", (event) => {
  if (!state.draggingPageId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
});

pageList.addEventListener("drop", (event) => {
  const dropItem = event.target instanceof Element ? event.target.closest(".page-row") : null;
  if (!state.draggingPageId || dropItem) return;
  event.preventDefault();
  send({ type: "move-page", pageId: state.draggingPageId, beforePageId: "" });
});

shareButton.addEventListener("click", async () => {
  if (!state.roomId) return;
  const url = new URL(location.href);
  url.searchParams.set("room", state.roomId);
  try {
    await navigator.clipboard.writeText(url.href);
    showNotice("共有リンクをコピーしました。", "online");
  } catch {
    prompt("共有リンク", url.href);
  }
});

restorePageButton.addEventListener("click", () => {
  if (!canEdit()) return;
  send({ type: "restore-page" });
});

duplicatePageButton.addEventListener("click", () => {
  const page = currentPage();
  if (!page || !canEdit()) return;
  send({ type: "duplicate-page", pageId: page.id });
});

previewButton.addEventListener("click", () => {
  state.previewMode = !state.previewMode;
  renderPreview();
});

exportButton.addEventListener("click", exportAllPages);

importButton.addEventListener("click", () => {
  if (!canEdit()) return;
  importFileInput.click();
});

importFileInput.addEventListener("change", async () => {
  const file = importFileInput.files?.[0];
  importFileInput.value = "";
  if (!file) return;
  await importPagesFromFile(file);
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

memoInput.addEventListener("input", (event) => {
  const page = currentPage();
  if (!page) return;

  const nextValue = memoInput.value;
  if (state.composing || event.isComposing) {
    page.text = nextValue;
    renderPreview();
    return;
  }

  const shouldReplaceText =
    state.forceNextInputReplace ||
    event.inputType === "insertFromPaste" ||
    event.inputType === "insertFromDrop" ||
    event.inputType === "deleteByCut";
  if (shouldReplaceText) {
    state.forceNextInputReplace = false;
    replacePageText(page, nextValue);
    return;
  }

  const op = diffText(state.lastValue, nextValue);
  if (!op) return;

  page.text = nextValue;
  state.lastValue = nextValue;
  renderPreview();
  page.version += 1;
  state.localSequence += 1;
  rememberPendingOp(page.id, state.localSequence, op);

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

memoInput.addEventListener("paste", () => {
  state.forceNextInputReplace = true;
  setTimeout(() => {
    const page = currentPage();
    if (state.forceNextInputReplace && page && memoInput.value !== state.lastValue) {
      state.forceNextInputReplace = false;
      replacePageText(page, memoInput.value);
    }
  }, 0);
});

memoInput.addEventListener("compositionstart", () => {
  state.composing = true;
});

memoInput.addEventListener("compositionend", () => {
  const page = currentPage();
  state.composing = false;
  if (!page || memoInput.value === state.lastValue) return;

  const nextValue = memoInput.value;
  const op = diffText(state.lastValue, nextValue);
  if (!op) return;

  page.text = nextValue;
  state.lastValue = nextValue;
  renderPreview();
  page.version += 1;
  state.localSequence += 1;
  rememberPendingOp(page.id, state.localSequence, op);

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
    const drafts = collectUnsyncedDrafts();
    state.selfId = message.selfId;
    state.activePageId = message.room.activePageId;
    state.pages = message.room.pages;
    state.users = new Map(message.room.users.map((user) => [user.id, user]));
    state.deletedPageCount = Number(message.room.deletedPageCount) || 0;
    state.pendingOps = new Map();
    state.maxPageChars = Number(message.limits?.maxPageChars) || 0;
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
    recoverUnsyncedDrafts(drafts);
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
      "invalid-room-id": "ルームIDに使える文字は、文字・数字・_・- のみです。",
      "room-full": "このルームは満員です。",
      "server-full": "作成できるルーム数の上限に達しています。",
      "rate-limited": "入室試行が多すぎます。少し待ってください。"
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

  if (message.type === "user-updated") {
    state.users.set(message.user.id, message.user);
    renderUsers();
    renderPages();
  }

  if (message.type === "page-op") {
    receivePageOp(message);
  }

  if (message.type === "page-replace") {
    receivePageReplace(message);
  }

  if (message.type === "page-rejected") {
    receivePageRejected(message);
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
    finishPendingRecovery(message);
    renderAll();
  }

  if (message.type === "page-deleted") {
    state.pages = state.pages.filter((page) => page.id !== message.pageId);
    state.deletedPageCount = Number(message.deletedPageCount) || state.deletedPageCount;
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

  if (message.type === "pages-reordered") {
    const pagesById = new Map(state.pages.map((page) => [page.id, page]));
    state.pages = message.pageIds.map((pageId) => pagesById.get(pageId)).filter(Boolean);
    state.activePageId = state.pages.some((page) => page.id === state.activePageId)
      ? state.activePageId
      : message.activePageId || state.pages[0]?.id || "";
    renderPages();
  }

  if (message.type === "page-restored") {
    state.pages.push(message.page);
    state.deletedPageCount = Number(message.deletedPageCount) || 0;
    switchPage(message.page.id, false);
    renderAll();
  }

  if (message.type === "action-error") {
    const labels = {
      "page-limit": "ページ数の上限に達しています。",
      "last-page": "最後のページは削除できません。",
      "nothing-to-restore": "復元できるページがありません。"
    };
    showNotice(labels[message.reason] || "操作を完了できませんでした。", "error");
  }
}

function receivePageOp(message) {
  const page = state.pages.find((item) => item.id === message.pageId);
  if (!page) return;

  if (message.userId === state.selfId) {
    forgetPendingOp(page.id, message.sequence);
    page.version = Math.max(page.version, message.version);
    return;
  }

  const op = transformRemoteOpForLocalPage(page.id, message.op);
  page.text = applyOp(page.text, op);
  page.version = Math.max(page.version, message.version);

  const user = state.users.get(message.userId);
  if (user && message.cursor) user.cursor = message.cursor;

  if (page.id === state.activePageId) {
    const selectionStart = transformPosition(memoInput.selectionStart, op);
    const selectionEnd = transformPosition(memoInput.selectionEnd, op);
    memoInput.value = page.text;
    state.lastValue = page.text;
    memoInput.setSelectionRange(selectionStart, selectionEnd);
    renderPreview();
    renderCursors();
  }
}

function receivePageReplace(message) {
  const page = state.pages.find((item) => item.id === message.pageId);
  if (!page) return;

  if (message.userId === state.selfId) {
    forgetPendingOp(page.id, message.sequence);
    page.version = Math.max(page.version, message.version);
    return;
  }

  clearPendingOps(page.id);
  page.text = message.text;
  page.version = Math.max(page.version, message.version);

  const user = state.users.get(message.userId);
  if (user && message.cursor) user.cursor = message.cursor;

  if (page.id === state.activePageId) {
    const cursorPosition = Math.min(memoInput.selectionStart, page.text.length);
    memoInput.value = page.text;
    state.lastValue = page.text;
    memoInput.setSelectionRange(cursorPosition, cursorPosition);
    renderPreview();
    renderCursors();
  }
}

function receivePageRejected(message) {
  const page = state.pages.find((item) => item.id === message.pageId);
  if (!page) return;

  const draft = {
    sourcePageId: page.id,
    title: recoveryTitle(page.title),
    text: page.text
  };

  forgetPendingOp(page.id, message.sequence);
  page.text = message.text;
  page.version = Number(message.version) || 0;
  state.lastValue = page.id === state.activePageId ? message.text : state.lastValue;

  if (page.id === state.activePageId) {
    const cursorPosition = Math.min(memoInput.selectionStart, page.text.length);
    memoInput.value = page.text;
    memoInput.setSelectionRange(cursorPosition, cursorPosition);
    renderPreview();
    renderCursors();
  }

  if (draft.text !== page.text) {
    queueRecoveryDraft(draft);
  }
}

function renderAll() {
  renderPages();
  renderUsers();
  renderCursors();
}

function renderPages() {
  const visiblePages = state.searchQuery
    ? state.pages.filter((page) => `${page.title}\n${page.text}`.toLowerCase().includes(state.searchQuery))
    : state.pages;
  pageList.replaceChildren(
    ...visiblePages.map((page) => {
      const row = document.createElement("div");
      row.className = `page-row${page.id === state.activePageId ? " active" : ""}`;
      row.draggable = canEdit();
      row.dataset.pageId = page.id;

      const button = document.createElement("button");
      button.className = `page-item${page.id === state.activePageId ? " active" : ""}`;
      button.type = "button";
      button.dataset.pageId = page.id;
      button.textContent = page.title || "Untitled";
      button.addEventListener("click", () => switchPage(page.id, true));

      const editButton = document.createElement("button");
      editButton.className = "page-edit-button";
      editButton.type = "button";
      editButton.textContent = "編集";
      editButton.title = "ページ名を編集";
      editButton.disabled = !canEdit();
      editButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!canEdit()) return;
        switchPage(page.id, true);
        beginTitleEdit();
      });

      row.addEventListener("dragstart", (event) => {
        if (!canEdit()) return;
        state.draggingPageId = page.id;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", page.id);
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => {
        state.draggingPageId = "";
        pageList.querySelectorAll(".page-row").forEach((item) => item.classList.remove("dragging", "drop-target"));
      });
      row.addEventListener("dragover", (event) => {
        if (!state.draggingPageId || state.draggingPageId === page.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        row.classList.add("drop-target");
      });
      row.addEventListener("dragleave", () => {
        row.classList.remove("drop-target");
      });
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        const pageId = event.dataTransfer.getData("text/plain") || state.draggingPageId;
        row.classList.remove("drop-target");
        if (!pageId || pageId === page.id) return;
        send({ type: "move-page", pageId, beforePageId: page.id });
      });
      row.append(button, editButton);
      return row;
    })
  );
  deletePageButton.disabled = !canEdit() || state.pages.length <= 1;
  deletePageButton.title =
    state.pages.length <= 1
      ? "最後のページは削除できません"
      : "現在のページを削除";
  addPageButton.disabled = !canEdit();
  updateActionButtons();
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
      const suffixes = [];
      if (user.id === state.selfId) suffixes.push("自分");
      if (user.role === "owner") suffixes.push("所有者");
      name.textContent = suffixes.length ? `${user.name} (${suffixes.join(", ")})` : user.name;

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
  renderPreview();
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
  if (!page || !canEdit()) return;

  state.titleBeforeEdit = page.title;
  pageTitleInput.readOnly = false;
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
  setEditingEnabled(status === "online");
}

function canEdit() {
  return state.joined && state.socket?.readyState === WebSocket.OPEN;
}

function setEditingEnabled(enabled) {
  memoInput.readOnly = !enabled;
  addPageButton.disabled = !enabled;
  importButton.disabled = !enabled;
  duplicatePageButton.disabled = !enabled;
  if (!enabled) {
    endTitleEditMode();
  }
  deletePageButton.disabled = !enabled || state.pages.length <= 1;
  updateActionButtons();
}

function showNotice(text, status = "error") {
  clearTimeout(state.noticeTimer);
  statusText.textContent = text;
  statusText.className = `status is-${status}`;
  state.noticeTimer = setTimeout(() => {
    setStatus(canEdit() ? "online" : "offline");
  }, 3500);
}

function updateActionButtons() {
  const joined = state.joined && state.pages.length > 0;
  shareButton.disabled = !state.roomId;
  exportButton.disabled = !joined;
  saveButton.disabled = !joined;
  importButton.disabled = !canEdit();
  restorePageButton.disabled = !canEdit() || state.deletedPageCount <= 0;
  restorePageButton.title =
    state.deletedPageCount > 0 ? `${state.deletedPageCount}件の削除済みページを復元できます` : "復元できるページはありません";
  duplicatePageButton.disabled = !canEdit() || !currentPage();
  previewButton.disabled = !state.joined;
  previewButton.textContent = state.previewMode ? "編集" : "表示";
  previewButton.title = state.previewMode ? "編集に戻る" : "プレビュー";
  previewButton.setAttribute("aria-label", previewButton.title);
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

function replacePageText(page, text) {
  const nextText = state.maxPageChars > 0 ? text.slice(0, state.maxPageChars) : text;
  if (nextText !== text) {
    memoInput.value = nextText;
  }

  page.text = nextText;
  state.lastValue = nextText;
  renderPreview();
  page.version += 1;
  state.localSequence += 1;
  clearPendingOps(page.id);
  rememberPendingOp(page.id, state.localSequence, { replace: true });

  send({
    type: "page-replace",
    pageId: page.id,
    text: nextText,
    baseVersion: page.version - 1,
    sequence: state.localSequence,
    cursor: localCursorPayload()
  });
  sendCursor();
}

function collectUnsyncedDrafts() {
  const drafts = [];
  for (const [pageId, pending] of state.pendingOps) {
    if (!pending.length) continue;
    const page = state.pages.find((item) => item.id === pageId);
    if (!page) continue;
    drafts.push({
      sourcePageId: page.id,
      title: recoveryTitle(page.title),
      text: page.text
    });
  }
  return drafts;
}

function recoverUnsyncedDrafts(drafts) {
  for (const draft of drafts) {
    const serverPage = state.pages.find((page) => page.id === draft.sourcePageId);
    if (!serverPage || serverPage.text !== draft.text) {
      queueRecoveryDraft(draft);
    }
  }
}

function queueRecoveryDraft(draft) {
  if (draft.text == null) return;
  const requestId = `recovery-${Date.now()}-${state.recoveryCounter}`;
  state.recoveryCounter += 1;
  state.pendingRecoveries.set(requestId, draft);
  send({ type: "add-page", title: draft.title, requestId });
}

function finishPendingRecovery(message) {
  if (!message.requestId || message.userId !== state.selfId) return;
  const draft = state.pendingRecoveries.get(message.requestId);
  if (!draft) return;
  state.pendingRecoveries.delete(message.requestId);
  const page = state.pages.find((item) => item.id === message.page.id);
  if (!page) return;
  switchPage(page.id, false);
  replacePageText(page, draft.text);
}

function recoveryTitle(title) {
  return normalizeTitle(`${title || "Untitled"} recovery`, "Recovered memo");
}

function renderPreview() {
  editorFrame.classList.toggle("is-preview", state.previewMode);
  previewPane.classList.toggle("hidden", !state.previewMode);
  previewButton.textContent = state.previewMode ? "編集" : "表示";
  previewButton.title = state.previewMode ? "編集に戻る" : "プレビュー";
  previewButton.setAttribute("aria-label", previewButton.title);
  if (!state.previewMode) return;

  const page = currentPage();
  previewPane.replaceChildren(...markdownNodes(page?.text || ""));
}

function markdownNodes(text) {
  const nodes = [];
  let list = null;
  let codeBlock = null;

  function finishList() {
    if (list) {
      nodes.push(list);
      list = null;
    }
  }

  function finishCode() {
    if (codeBlock) {
      nodes.push(codeBlock);
      codeBlock = null;
    }
  }

  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      if (codeBlock) {
        finishCode();
      } else {
        finishList();
        codeBlock = document.createElement("pre");
      }
      continue;
    }

    if (codeBlock) {
      codeBlock.textContent += `${line}\n`;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      finishList();
      const element = document.createElement(`h${heading[1].length}`);
      element.textContent = heading[2];
      nodes.push(element);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!list) list = document.createElement("ul");
      const item = document.createElement("li");
      item.textContent = bullet[1];
      list.append(item);
      continue;
    }

    if (!line.trim()) {
      finishList();
      continue;
    }

    finishList();
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    nodes.push(paragraph);
  }

  finishList();
  finishCode();
  return nodes.length ? nodes : [document.createElement("p")];
}

function exportAllPages() {
  if (!state.pages.length) return;
  const payload = {
    app: "Collaborate Memo",
    exportedAt: new Date().toISOString(),
    roomId: state.roomId,
    activePageId: state.activePageId,
    pages: state.pages.map(({ title, text }) => ({ title, text }))
  };
  downloadText(`${safeFileName(state.roomId || "memo")}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
}

async function importPagesFromFile(file) {
  if (!canEdit()) return;
  const text = await file.text();
  let importedPages = null;

  try {
    const data = JSON.parse(text);
    if (Array.isArray(data.pages)) {
      importedPages = data.pages.map((page, index) => ({
        title: normalizeTitle(page.title, `Imported ${index + 1}`),
        text: String(page.text || "")
      }));
    }
  } catch {
    importedPages = null;
  }

  if (!importedPages) {
    importedPages = [{ title: normalizeTitle(file.name.replace(/\.[^.]+$/, ""), "Imported memo"), text }];
  }

  for (const page of importedPages.slice(0, 20)) {
    queueRecoveryDraft(page);
  }
  showNotice(`${Math.min(importedPages.length, 20)}ページを読み込みました。`, "online");
}

function downloadText(fileName, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function safeFileName(name) {
  return String(name || "memo").replace(/[\\/:*?"<>|]/g, "_") || "memo";
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
  state.deletedPageCount = 0;
  state.searchQuery = "";
  state.previewMode = false;
  pageSearchInput.value = "";
  state.lastValue = "";
  state.composing = false;
  state.pendingOps = new Map();
  entryError.textContent = "";
  memoView.classList.add("hidden");
  entryView.classList.remove("hidden");
  renderPreview();
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

function transformPosition(position, op, preferAfterInsert = true) {
  const start = op.start;
  const end = op.start + op.deleteCount;

  if (position < start) return position;
  if (position > end) return position + op.insert.length - op.deleteCount;
  return start + (preferAfterInsert ? op.insert.length : 0);
}

function transformOp(incoming, applied, preferAfterInsert = true) {
  if (incoming.replace || applied.replace) return incoming;

  const start = transformPosition(incoming.start, applied, preferAfterInsert && incoming.insert.length > 0);
  const end = transformPosition(incoming.start + incoming.deleteCount, applied, false);

  return {
    start: Math.max(0, start),
    deleteCount: Math.max(0, end - start),
    insert: incoming.insert
  };
}

function pendingOpsFor(pageId) {
  if (!state.pendingOps.has(pageId)) state.pendingOps.set(pageId, []);
  return state.pendingOps.get(pageId);
}

function rememberPendingOp(pageId, sequence, op) {
  pendingOpsFor(pageId).push({ sequence, op });
}

function forgetPendingOp(pageId, sequence) {
  if (!sequence) return;

  const pending = pendingOpsFor(pageId);
  const index = pending.findIndex((item) => item.sequence === sequence);
  if (index !== -1) pending.splice(index, 1);
}

function clearPendingOps(pageId) {
  pendingOpsFor(pageId).length = 0;
}

function transformRemoteOpForLocalPage(pageId, remoteOp) {
  const pending = pendingOpsFor(pageId);
  if (pending.some((item) => item.op.replace)) return remoteOp;

  let transformedRemote = remoteOp;
  for (const item of pending) {
    transformedRemote = transformOp(transformedRemote, item.op, false);
  }
  for (const item of pending) {
    item.op = transformOp(item.op, transformedRemote, true);
  }
  return transformedRemote;
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
