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
const restorePageButton = document.querySelector("#restorePageButton");
const ocrButton = document.querySelector("#ocrButton");
const importButton = document.querySelector("#importButton");
const exportButton = document.querySelector("#exportButton");
const deletePageButton = document.querySelector("#deletePageButton");
const saveButton = document.querySelector("#saveButton");
const leaveButton = document.querySelector("#leaveButton");
const importFileInput = document.querySelector("#importFileInput");
const ocrFileInput = document.querySelector("#ocrFileInput");
const memoInput = document.querySelector("#memoInput");
const editorFrame = document.querySelector(".editor-frame");
const cursorLayer = document.querySelector("#cursorLayer");
const ocrDialog = document.querySelector("#ocrDialog");
const ocrStatusText = document.querySelector("#ocrStatusText");
const ocrResultInput = document.querySelector("#ocrResultInput");
const insertOcrButton = document.querySelector("#insertOcrButton");
const cancelOcrButton = document.querySelector("#cancelOcrButton");
const closeOcrButton = document.querySelector("#closeOcrButton");
const sessionKey = "collaborate-memo-session";
const maxOcrImageBytes = 10 * 1024 * 1024;
const maxOcrImageSide = 2200;

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
  editingPageId: "",
  lastEditedPageId: "",
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
  composingPageId: "",
  compositionBaseText: "",
  deferredCompositionOps: [],
  pendingOps: new Map(),
  pendingRecoveries: new Map(),
  ocrWorker: null,
  ocrWorkerPromise: null,
  ocrBusy: false,
  ocrInsertRange: null,
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
  send({ type: "delete-page", pageId: page.id });
});

leaveButton.addEventListener("click", leaveRoom);

pageSearchInput.addEventListener("input", () => {
  state.searchQuery = pageSearchInput.value.trim().toLowerCase();
  renderPages();
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

ocrButton.addEventListener("click", () => {
  if (!canEdit()) return;
  ocrFileInput.click();
});

ocrFileInput.addEventListener("change", async () => {
  const file = ocrFileInput.files?.[0];
  ocrFileInput.value = "";
  if (!file) return;
  await recognizeImageText(file);
});

insertOcrButton.addEventListener("click", insertOcrResult);
cancelOcrButton.addEventListener("click", closeOcrDialog);
closeOcrButton.addEventListener("click", closeOcrDialog);
ocrDialog.addEventListener("click", (event) => {
  if (event.target === ocrDialog && !state.ocrBusy) closeOcrDialog();
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

memoInput.addEventListener("input", (event) => {
  const page = currentPage();
  if (!page) return;

  const nextValue = memoInput.value;
  if (state.composing || event.isComposing) {
    markPageEdited(page.id);
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
  markPageEdited(page.id);
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

memoInput.addEventListener("paste", (event) => {
  const image = imageFileFromDataTransfer(event.clipboardData);
  if (image) {
    event.preventDefault();
    state.forceNextInputReplace = false;
    recognizeImageText(image);
    return;
  }

  state.forceNextInputReplace = true;
  setTimeout(() => {
    const page = currentPage();
    if (state.forceNextInputReplace && page && memoInput.value !== state.lastValue) {
      state.forceNextInputReplace = false;
      replacePageText(page, memoInput.value);
    }
  }, 0);
});

editorFrame.addEventListener("dragover", (event) => {
  if (imageFileFromDataTransfer(event.dataTransfer)) {
    event.preventDefault();
  }
});

editorFrame.addEventListener("drop", (event) => {
  const image = imageFileFromDataTransfer(event.dataTransfer);
  if (!image) return;
  event.preventDefault();
  recognizeImageText(image);
});

memoInput.addEventListener("compositionstart", beginComposition);

memoInput.addEventListener("compositionend", finishComposition);

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
    const saved = loadSession();
    if (saved?.pageId && state.pages.some((page) => page.id === saved.pageId)) {
      state.activePageId = saved.pageId;
      state.lastEditedPageId = saved.pageId;
    }
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
      const editingThisTitle = page.id === state.editingPageId;
      if (page.id === state.activePageId && !editingThisTitle) {
        pageTitleInput.value = page.title;
      }
      if (!editingThisTitle) renderPages();
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

  if (isComposingPage(page.id)) {
    state.lastValue = page.text;
    state.deferredCompositionOps.push(op);
    renderCursors();
    return;
  }

  if (page.id === state.activePageId) {
    const selectionStart = transformPosition(memoInput.selectionStart, op);
    const selectionEnd = transformPosition(memoInput.selectionEnd, op);
    memoInput.value = page.text;
    state.lastValue = page.text;
    memoInput.setSelectionRange(selectionStart, selectionEnd);
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

  const replaceOp = { start: 0, deleteCount: page.text.length, insert: message.text };
  clearPendingOps(page.id);
  page.text = message.text;
  page.version = Math.max(page.version, message.version);

  const user = state.users.get(message.userId);
  if (user && message.cursor) user.cursor = message.cursor;

  if (isComposingPage(page.id)) {
    state.lastValue = page.text;
    state.deferredCompositionOps.push(replaceOp);
    renderCursors();
    return;
  }

  if (page.id === state.activePageId) {
    const cursorPosition = Math.min(memoInput.selectionStart, page.text.length);
    memoInput.value = page.text;
    state.lastValue = page.text;
    memoInput.setSelectionRange(cursorPosition, cursorPosition);
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
      const isEditing = state.editingPageId === page.id;
      const row = document.createElement("div");
      row.className = `page-row${page.id === state.activePageId ? " active" : ""}`;
      row.dataset.pageId = page.id;

      let titleControl;
      if (isEditing) {
        titleControl = document.createElement("input");
        titleControl.className = "page-title-edit";
        titleControl.maxLength = 40;
        titleControl.value = page.title || "Untitled";
        titleControl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitTitleEdit(page.id, titleControl.value);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancelTitleEdit();
          }
        });
        titleControl.addEventListener("blur", () => {
          if (state.editingPageId === page.id) commitTitleEdit(page.id, titleControl.value);
        });
      } else {
        titleControl = document.createElement("button");
        titleControl.className = `page-item${page.id === state.activePageId ? " active" : ""}`;
        titleControl.type = "button";
        titleControl.dataset.pageId = page.id;
        titleControl.textContent = page.title || "Untitled";
        titleControl.addEventListener("click", () => switchPage(page.id, true));
      }

      const editButton = document.createElement("button");
      editButton.className = "page-edit-button";
      editButton.type = "button";
      editButton.textContent = isEditing ? "保存" : "編集";
      editButton.title = isEditing ? "ページ名を保存" : "ページ名を編集";
      editButton.disabled = !canEdit();
      editButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!canEdit()) return;
        if (isEditing) {
          commitTitleEdit(page.id, titleControl.value);
        } else {
          beginTitleEdit(page.id);
        }
      });
      editButton.addEventListener("mousedown", (event) => event.preventDefault());

      const pageIndex = state.pages.findIndex((item) => item.id === page.id);
      const moveControls = document.createElement("div");
      moveControls.className = "page-move-controls";

      const moveUpButton = document.createElement("button");
      moveUpButton.className = "page-move-button";
      moveUpButton.type = "button";
      moveUpButton.textContent = "↑";
      moveUpButton.title = "ページを上へ移動";
      moveUpButton.setAttribute("aria-label", `${page.title || "Untitled"}を上へ移動`);
      moveUpButton.disabled = !canEdit() || isEditing || pageIndex <= 0;
      moveUpButton.addEventListener("click", (event) => {
        event.stopPropagation();
        movePageBy(page.id, -1);
      });
      moveUpButton.addEventListener("mousedown", (event) => event.preventDefault());

      const moveDownButton = document.createElement("button");
      moveDownButton.className = "page-move-button";
      moveDownButton.type = "button";
      moveDownButton.textContent = "↓";
      moveDownButton.title = "ページを下へ移動";
      moveDownButton.setAttribute("aria-label", `${page.title || "Untitled"}を下へ移動`);
      moveDownButton.disabled = !canEdit() || isEditing || pageIndex === -1 || pageIndex >= state.pages.length - 1;
      moveDownButton.addEventListener("click", (event) => {
        event.stopPropagation();
        movePageBy(page.id, 1);
      });
      moveDownButton.addEventListener("mousedown", (event) => event.preventDefault());

      moveControls.append(moveUpButton, moveDownButton);
      row.append(titleControl, moveControls, editButton);
      return row;
    })
  );
  deletePageButton.disabled = !canEdit() || state.pages.length <= 1;
  deletePageButton.title =
    state.pages.length <= 1
      ? "最後のページは削除できません"
      : "現在のページを削除";
  addPageButton.disabled = !canEdit();
  if (state.editingPageId) {
    const editingInput = pageList.querySelector(".page-title-edit");
    editingInput?.focus();
    editingInput?.select();
  }
  updateActionButtons();
}

function beginComposition() {
  const page = currentPage();
  state.composing = true;
  state.composingPageId = page?.id || "";
  state.compositionBaseText = page ? page.text : state.lastValue;
  state.deferredCompositionOps = [];
}

function finishComposition() {
  const page = currentPage();
  const pageId = state.composingPageId;
  const baseText = state.compositionBaseText;
  const finalText = memoInput.value;
  let selectionStart = memoInput.selectionStart;
  let selectionEnd = memoInput.selectionEnd;
  const deferredOps = state.deferredCompositionOps;

  state.composing = false;
  state.composingPageId = "";
  state.compositionBaseText = "";
  state.deferredCompositionOps = [];

  if (!page || page.id !== pageId) return;

  let localOp = diffText(baseText, finalText);
  for (const op of deferredOps) {
    if (localOp) localOp = transformOp(localOp, op, true);
    selectionStart = transformPosition(selectionStart, op);
    selectionEnd = transformPosition(selectionEnd, op);
  }

  if (localOp) {
    page.text = applyOp(page.text, localOp);
    page.version += 1;
    state.localSequence += 1;
    rememberPendingOp(page.id, state.localSequence, localOp);
  }

  state.lastValue = page.text;
  memoInput.value = page.text;
  selectionStart = Math.min(selectionStart, memoInput.value.length);
  selectionEnd = Math.min(selectionEnd, memoInput.value.length);
  memoInput.setSelectionRange(selectionStart, selectionEnd);
  markPageEdited(page.id);

  if (localOp) {
    send({
      type: "page-op",
      pageId: page.id,
      op: localOp,
      baseVersion: page.version - 1,
      sequence: state.localSequence,
      cursor: localCursorPayload()
    });
  }
  sendCursor();
  renderCursors();
}

function isComposingPage(pageId) {
  return state.composing && state.composingPageId === pageId;
}

function imageFileFromDataTransfer(dataTransfer) {
  if (!dataTransfer) return null;

  for (const item of dataTransfer.items || []) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      return item.getAsFile();
    }
  }

  for (const file of dataTransfer.files || []) {
    if (file.type.startsWith("image/")) return file;
  }

  return null;
}

async function recognizeImageText(file) {
  if (!canEdit()) return;
  if (state.composing) {
    showNotice("変換中はOCR結果を挿入できません。変換を確定してから実行してください。", "error");
    return;
  }
  if (!file.type.startsWith("image/")) {
    showNotice("画像ファイルを選択してください。", "error");
    return;
  }
  if (file.size > maxOcrImageBytes) {
    showNotice("OCRできる画像は10MBまでです。", "error");
    return;
  }
  if (state.ocrBusy) return;

  state.ocrBusy = true;
  state.ocrInsertRange = {
    pageId: state.activePageId,
    start: memoInput.selectionStart,
    end: memoInput.selectionEnd
  };
  openOcrDialog("画像からテキストを読み取っています", "");

  try {
    const image = await imageForOcr(file);
    const worker = await ocrWorker();
    setOcrStatus("OCRを実行しています");
    const result = await worker.recognize(image);
    const text = normalizeOcrText(result.data?.text || "");
    ocrResultInput.value = text;
    ocrResultInput.disabled = false;
    insertOcrButton.disabled = text.length === 0;
    setOcrStatus(text ? "認識結果を確認して挿入できます" : "テキストを検出できませんでした");
    showNotice(text ? "OCRが完了しました。" : "OCRでテキストを検出できませんでした。", text ? "online" : "error");
  } catch (error) {
    ocrResultInput.value = "";
    ocrResultInput.disabled = true;
    insertOcrButton.disabled = true;
    setOcrStatus("OCRに失敗しました。画像を変えて試してください。");
    showNotice(`OCRに失敗しました: ${error.message}`, "error");
  } finally {
    state.ocrBusy = false;
    updateActionButtons();
  }
}

function openOcrDialog(status, text) {
  ocrDialog.classList.remove("hidden");
  ocrResultInput.value = text;
  ocrResultInput.disabled = true;
  insertOcrButton.disabled = true;
  cancelOcrButton.disabled = false;
  closeOcrButton.disabled = false;
  setOcrStatus(status);
}

function closeOcrDialog() {
  if (state.ocrBusy) return;
  ocrDialog.classList.add("hidden");
  state.ocrInsertRange = null;
  ocrResultInput.value = "";
}

function setOcrStatus(text) {
  ocrStatusText.textContent = text;
}

async function ocrWorker() {
  if (state.ocrWorker) return state.ocrWorker;
  if (!state.ocrWorkerPromise) {
    state.ocrWorkerPromise = import("/vendor/tesseract/tesseract.esm.min.js").then(async ({ createWorker }) => {
      const worker = await createWorker(["jpn", "eng"], 1, {
        workerPath: "/vendor/tesseract/worker.min.js",
        corePath: "/vendor/tesseract-core",
        langPath: "/vendor/tessdata",
        logger: (message) => {
          if (!state.ocrBusy || !message.status) return;
          const progress = Number.isFinite(message.progress) ? ` ${Math.round(message.progress * 100)}%` : "";
          setOcrStatus(`${ocrStatusLabel(message.status)}${progress}`);
        }
      });
      await worker.setParameters({ preserve_interword_spaces: "1" });
      state.ocrWorker = worker;
      return worker;
    });
  }
  return state.ocrWorkerPromise;
}

function ocrStatusLabel(status) {
  const labels = {
    loading: "OCRエンジンを読み込んでいます",
    "loading tesseract core": "OCRエンジンを読み込んでいます",
    "initializing tesseract": "OCRエンジンを初期化しています",
    "loading language traineddata": "日本語/英語データを読み込んでいます",
    "initializing api": "OCRを準備しています",
    recognizing: "画像から文字を読み取っています"
  };
  return labels[status] || status;
}

async function imageForOcr(file) {
  if (!("createImageBitmap" in window)) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxOcrImageSide / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 2 * 1024 * 1024) {
      bitmap.close?.();
      return file;
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();

    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("画像の前処理に失敗しました。"))), "image/png");
    });
  } catch {
    return file;
  }
}

function normalizeOcrText(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function insertOcrResult() {
  if (state.ocrBusy || state.composing) return;
  const text = ocrResultInput.value.trim();
  const range = state.ocrInsertRange;
  const page = currentPage();
  if (!text || !range || !page || page.id !== range.pageId || !canEdit()) return;

  const start = Math.min(range.start, range.end, memoInput.value.length);
  const end = Math.min(Math.max(range.start, range.end), memoInput.value.length);
  const prefix = start > 0 && !memoInput.value[start - 1].match(/\s/) ? "\n" : "";
  const suffix = end < memoInput.value.length && !memoInput.value[end]?.match(/\s/) ? "\n" : "";
  const insert = `${prefix}${text}${suffix}`;
  const nextText = `${memoInput.value.slice(0, start)}${insert}${memoInput.value.slice(end)}`;
  const caret = start + insert.length;

  memoInput.value = nextText;
  memoInput.setSelectionRange(caret, caret);
  replacePageText(page, nextText);
  memoInput.focus();
  closeOcrDialog();
}

function movePageBy(pageId, direction) {
  if (!canEdit()) return;

  const pageIndex = state.pages.findIndex((page) => page.id === pageId);
  const targetIndex = pageIndex + direction;
  if (pageIndex === -1 || targetIndex < 0 || targetIndex >= state.pages.length) return;

  const beforePageId = direction < 0 ? state.pages[targetIndex].id : state.pages[pageIndex + 2]?.id || "";
  send({ type: "move-page", pageId, beforePageId });
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

function beginTitleEdit(pageId = state.activePageId) {
  const page = state.pages.find((item) => item.id === pageId);
  if (!page || !canEdit()) return;

  clearTimeout(state.titleTimer);
  state.editingPageId = page.id;
  state.titleBeforeEdit = page.title;
  renderPages();
}

function commitTitleEdit(pageId = state.editingPageId, title = "") {
  const page = state.pages.find((item) => item.id === pageId);
  if (!page) return;

  clearTimeout(state.titleTimer);
  page.title = normalizeTitle(title, state.titleBeforeEdit || page.title);
  pageTitleInput.value = page.title;
  markPageEdited(page.id);
  send({ type: "rename-page", pageId: page.id, title: page.title });
  endTitleEditMode();
  renderPages();
}

function cancelTitleEdit() {
  const page = state.pages.find((item) => item.id === state.editingPageId);
  if (!page) return;

  clearTimeout(state.titleTimer);
  page.title = state.titleBeforeEdit || page.title;
  pageTitleInput.value = page.title;
  endTitleEditMode();
  renderPages();
}

function endTitleEditMode() {
  pageTitleInput.readOnly = true;
  state.editingPageId = "";
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
  ocrButton.disabled = !enabled || state.ocrBusy;
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
  ocrButton.disabled = !canEdit() || state.ocrBusy;
  restorePageButton.disabled = !canEdit() || state.deletedPageCount <= 0;
  restorePageButton.title =
    state.deletedPageCount > 0 ? `${state.deletedPageCount}件の削除済みページを復元できます` : "復元できるページはありません";
  duplicatePageButton.disabled = !canEdit() || !currentPage();
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
  if (state.composing && page.id === state.composingPageId) return;
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
  markPageEdited(page.id);
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
  showNotice(`${Math.min(importedPages.length, 20)}ページをインポートしました。`, "online");
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
      password: state.password,
      pageId: state.lastEditedPageId || state.activePageId
    })
  );
}

function markPageEdited(pageId) {
  if (!pageId) return;
  state.lastEditedPageId = pageId;
  saveSession();
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
  state.editingPageId = "";
  pageSearchInput.value = "";
  state.lastEditedPageId = "";
  state.lastValue = "";
  state.composing = false;
  state.composingPageId = "";
  state.compositionBaseText = "";
  state.deferredCompositionOps = [];
  state.ocrBusy = false;
  state.ocrInsertRange = null;
  state.pendingOps = new Map();
  entryError.textContent = "";
  memoView.classList.add("hidden");
  entryView.classList.remove("hidden");
  closeOcrDialog();
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
  state.lastEditedPageId = savedSession.pageId || "";
  connect(savedSession.roomId, savedSession.userName, savedSession.password || "");
}
