import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const roomPassword = process.env.ROOM_PASSWORD || "";
const dataFile = process.env.MEMO_DATA_FILE || join(root, "data", "rooms.json");
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabaseTable = process.env.SUPABASE_TABLE || "memo_rooms";
const supabaseRetentionDays = Number(process.env.SUPABASE_RETENTION_DAYS || 7);
const useSupabase = Boolean(supabaseUrl && supabaseServiceRoleKey);
const roomTtlMs = Number(process.env.ROOM_TTL_MS || 0);
const maxRooms = Number(process.env.MAX_ROOMS || 100);
const maxUsersPerRoom = Number(process.env.MAX_USERS_PER_ROOM || 10);
const maxPagesPerRoom = Number(process.env.MAX_PAGES_PER_ROOM || 50);
const maxPageChars = Number(process.env.MAX_PAGE_CHARS || 200000);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const maxFrameBytes = 128 * 1024;
let saveTimer = null;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

const securityHeaders = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()"
};

const rooms = new Map();
const sockets = new Set();
const colorPalette = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c"];

function createPage(title = "Page 1") {
  return {
    id: randomUUID(),
    title,
    text: "",
    version: 0,
    history: []
  };
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    if (rooms.size >= maxRooms) return null;
    const firstPage = createPage("Page 1");
    rooms.set(roomId, {
      id: roomId,
      pages: [firstPage],
      activePageId: firstPage.id,
      users: new Map()
    });
    scheduleSave();
  }
  return rooms.get(roomId);
}

function safeRoomId(value) {
  return String(value || "")
    .trim()
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .slice(0, 40);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function applyOp(text, op) {
  const start = clamp(op.start, 0, text.length);
  const deleteCount = clamp(op.deleteCount, 0, text.length - start);
  return text.slice(0, start) + op.insert + text.slice(start + deleteCount);
}

function transformPosition(position, op, preferAfterInsert = true) {
  const start = op.start;
  const end = op.start + op.deleteCount;

  if (position < start) return position;
  if (position > end) return position + op.insert.length - op.deleteCount;
  return start + (preferAfterInsert ? op.insert.length : 0);
}

function transformOp(incoming, applied) {
  const start = transformPosition(incoming.start, applied, incoming.insert.length > 0);
  const end = transformPosition(incoming.start + incoming.deleteCount, applied, false);

  return {
    start: Math.max(0, start),
    deleteCount: Math.max(0, end - start),
    insert: incoming.insert
  };
}

function serializeRoom(room) {
  return {
    id: room.id,
    activePageId: room.activePageId,
    pages: room.pages.map(({ id, title, text, version }) => ({ id, title, text, version })),
    users: [...room.users.values()]
  };
}

function withSecurityHeaders(headers = {}) {
  return { ...securityHeaders, ...headers };
}

function serializeRoomForStorage(room) {
  return {
    id: room.id,
    activePageId: room.activePageId,
    pages: room.pages.map(({ id, title, text, version }) => ({ id, title, text, version }))
  };
}

async function loadRooms() {
  if (useSupabase) {
    await cleanupSupabaseRooms();
    await loadRoomsFromSupabase();
    return;
  }

  try {
    const saved = JSON.parse(await readFile(dataFile, "utf8"));
    for (const roomData of saved.rooms || []) {
      const pages = Array.isArray(roomData.pages) && roomData.pages.length > 0 ? roomData.pages : [createPage("Page 1")];
      for (const page of pages) {
        page.history = [];
        page.version = Number(page.version) || 0;
        page.text = String(page.text || "");
        page.title = String(page.title || "Untitled");
      }
      rooms.set(roomData.id, {
        id: roomData.id,
        pages,
        activePageId: roomData.activePageId || pages[0].id,
        users: new Map()
      });
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`Failed to load memo data: ${error.message}`);
    }
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveRooms().catch((error) => console.error(`Failed to save memo data: ${error.message}`));
  }, 250);
}

async function saveRooms() {
  if (useSupabase) {
    await saveRoomsToSupabase();
    return;
  }

  const payload = {
    savedAt: new Date().toISOString(),
    rooms: [...rooms.values()].map(serializeRoomForStorage)
  };
  await mkdir(dirname(dataFile), { recursive: true });
  await writeFile(dataFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function loadRoomsFromSupabase() {
  const cutoff = new Date(Date.now() - supabaseRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const query = new URLSearchParams({
    select: "room_id,active_page_id,pages",
    updated_at: `gte.${cutoff}`,
    order: "updated_at.desc",
    limit: String(maxRooms)
  });
  const rows = await supabaseRequest(`/${supabaseTable}?${query}`);

  for (const row of rows || []) {
    const pages = Array.isArray(row.pages) && row.pages.length > 0 ? row.pages : [createPage("Page 1")];
    for (const page of pages) {
      page.history = [];
      page.version = Number(page.version) || 0;
      page.text = String(page.text || "");
      page.title = String(page.title || "Untitled");
    }
    rooms.set(row.room_id, {
      id: row.room_id,
      pages,
      activePageId: row.active_page_id || pages[0].id,
      users: new Map()
    });
  }
}

async function saveRoomsToSupabase() {
  const now = new Date().toISOString();
  const rows = [...rooms.values()].map((room) => ({
    room_id: room.id,
    active_page_id: room.activePageId,
    pages: serializeRoomForStorage(room).pages,
    updated_at: now
  }));

  if (rows.length === 0) return;

  await supabaseRequest(`/${supabaseTable}?on_conflict=room_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows)
  });
}

async function deleteRoomFromSupabase(roomId) {
  if (!useSupabase) return;
  await supabaseRequest(`/${supabaseTable}?room_id=eq.${encodeURIComponent(roomId)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" }
  });
}

async function cleanupSupabaseRooms() {
  if (!Number.isFinite(supabaseRetentionDays) || supabaseRetentionDays <= 0) return;
  const cutoff = new Date(Date.now() - supabaseRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  await supabaseRequest(`/${supabaseTable}?updated_at=lt.${encodeURIComponent(cutoff)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" }
  });
}

async function supabaseRequest(path, options = {}) {
  const baseUrl = supabaseUrl.replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase request failed: ${response.status} ${text}`);
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function isAllowedOrigin(request) {
  if (allowedOrigins.length === 0) return true;
  const origin = request.headers.origin;
  return Boolean(origin && allowedOrigins.includes(origin));
}

function passwordMatches(input) {
  if (!roomPassword) return true;

  const expected = Buffer.from(roomPassword);
  const actual = Buffer.from(String(input || ""));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function broadcast(room, message, exceptSocket = null) {
  const payload = JSON.stringify(message);
  for (const socket of sockets) {
    if (socket !== exceptSocket && socket.roomId === room.id && socket.wsReadyState === "open") {
      socket.send(payload);
    }
  }
}

function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === "/healthz") {
    response.writeHead(
      200,
      withSecurityHeaders({
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      })
    );
    response.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: sockets.size }));
    return;
  }

  if (url.pathname === "/robots.txt") {
    response.writeHead(
      200,
      withSecurityHeaders({
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      })
    );
    response.end("User-agent: *\nDisallow: /\n");
    return;
  }

  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const resolvedPath = normalize(join(publicDir, requestedPath));

  if (!resolvedPath.startsWith(publicDir) || !existsSync(resolvedPath)) {
    response.writeHead(404, withSecurityHeaders({ "content-type": "text/plain; charset=utf-8" }));
    response.end("Not found");
    return;
  }

  response.writeHead(
    200,
    withSecurityHeaders({
      "content-type": mimeTypes[extname(resolvedPath)] || "application/octet-stream",
      "cache-control": "no-store"
    })
  );
  createReadStream(resolvedPath).pipe(response);
}

const server = createServer(serveStatic);

server.on("upgrade", (request, socket) => {
  if (request.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }
  if (!isAllowedOrigin(request)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  const key = request.headers["sec-websocket-key"];
  const acceptKey = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
  );

  socket.id = randomUUID();
  socket.wsReadyState = "open";
  socket.buffer = Buffer.alloc(0);
  socket.send = (message) => writeFrame(socket, message);
  sockets.add(socket);

  socket.on("data", (chunk) => readFrames(socket, chunk));
  socket.on("close", () => leave(socket));
  socket.on("error", () => leave(socket));
});

function readFrames(socket, chunk) {
  socket.buffer = Buffer.concat([socket.buffer, chunk]);
  if (socket.buffer.length > maxFrameBytes) {
    socket.end();
    leave(socket);
    return;
  }

  while (socket.buffer.length >= 2) {
    const first = socket.buffer[0];
    const second = socket.buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) === 0x80;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (socket.buffer.length < offset + 2) return;
      length = socket.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (socket.buffer.length < offset + 8) return;
      length = Number(socket.buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    const maskOffset = masked ? 4 : 0;
    if (socket.buffer.length < offset + maskOffset + length) return;

    let payload = socket.buffer.subarray(offset + maskOffset, offset + maskOffset + length);
    if (masked) {
      const mask = socket.buffer.subarray(offset, offset + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }

    socket.buffer = socket.buffer.subarray(offset + maskOffset + length);

    if (opcode === 0x8) {
      socket.end();
      leave(socket);
      return;
    }
    if (opcode === 0x9) {
      writeFrame(socket, payload, 0x0a);
      continue;
    }
    if (opcode === 0x1) {
      handleMessage(socket, payload.toString("utf8"));
    }
  }
}

function writeFrame(socket, payload, opcode = 0x1) {
  if (socket.destroyed) return;
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let header;

  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }

  socket.write(Buffer.concat([header, data]));
}

function handleMessage(socket, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    if (process.env.DEBUG_WS) console.error("Invalid websocket payload:", raw);
    return;
  }

  if (process.env.DEBUG_WS) console.error("Websocket message:", message.type);

  if (message.type === "join") {
    joinRoom(socket, message);
    return;
  }

  if (!socket.roomId) return;
  const room = rooms.get(socket.roomId);
  if (!room) return;

  if (message.type === "page-op") handlePageOp(socket, room, message);
  if (message.type === "cursor") handleCursor(socket, room, message);
  if (message.type === "add-page") handleAddPage(socket, room, message);
  if (message.type === "delete-page") handleDeletePage(socket, room, message);
  if (message.type === "rename-page") handleRenamePage(socket, room, message);
  if (message.type === "switch-page") handleSwitchPage(socket, room, message);
  if (message.type === "heartbeat") socket.send(JSON.stringify({ type: "heartbeat" }));
}

function joinRoom(socket, message) {
  if (!passwordMatches(message.password)) {
    socket.send(JSON.stringify({ type: "join-error", reason: "invalid-password" }));
    setTimeout(() => socket.end(), 50);
    return;
  }

  const roomId = safeRoomId(message.roomId) || "default";
  const room = getRoom(roomId);
  if (!room) {
    socket.send(JSON.stringify({ type: "join-error", reason: "server-full" }));
    setTimeout(() => socket.end(), 50);
    return;
  }
  if (room.users.size >= maxUsersPerRoom) {
    socket.send(JSON.stringify({ type: "join-error", reason: "room-full" }));
    setTimeout(() => socket.end(), 50);
    return;
  }

  const colorIndex = room.users.size % colorPalette.length;
  const user = {
    id: socket.id,
    name: String(message.userName || "Guest").trim().slice(0, 24) || "Guest",
    color: colorPalette[colorIndex],
    cursor: { pageId: room.activePageId, index: 0, start: 0, end: 0 },
    activePageId: room.activePageId
  };

  socket.roomId = roomId;
  room.users.set(socket.id, user);
  socket.send(JSON.stringify({ type: "joined", selfId: socket.id, room: serializeRoom(room) }));
  broadcast(room, { type: "user-joined", user }, socket);
}

function handlePageOp(socket, room, message) {
  const page = room.pages.find((item) => item.id === message.pageId);
  if (!page || typeof message.op?.insert !== "string") return;

  let op = {
    start: Number(message.op.start) || 0,
    deleteCount: Number(message.op.deleteCount) || 0,
    insert: message.op.insert.slice(0, 50000)
  };

  const baseVersion = Number(message.baseVersion) || 0;
  const missedOps = page.history.filter((item) => item.version > baseVersion);
  for (const historyItem of missedOps) {
    op = transformOp(op, historyItem.op);
  }

  op.start = clamp(op.start, 0, page.text.length);
  op.deleteCount = clamp(op.deleteCount, 0, page.text.length - op.start);
  op.insert = op.insert.slice(0, Math.max(0, maxPageChars - (page.text.length - op.deleteCount)));
  if (op.deleteCount === 0 && op.insert.length === 0) return;

  page.text = applyOp(page.text, op);
  page.version += 1;
  page.history.push({ version: page.version, op, userId: socket.id });
  page.history = page.history.slice(-200);
  scheduleSave();

  const user = room.users.get(socket.id);
  if (user && message.cursor) {
    user.cursor = normalizeCursor(page, message.cursor);
    user.activePageId = page.id;
  }

  broadcast(room, {
    type: "page-op",
    pageId: page.id,
    op,
    version: page.version,
    userId: socket.id,
    cursor: user?.cursor
  });
}

function handleCursor(socket, room, message) {
  const user = room.users.get(socket.id);
  const page = room.pages.find((item) => item.id === message.pageId);
  if (!user || !page) return;

  user.cursor = normalizeCursor(page, message);
  user.activePageId = page.id;
  broadcast(room, { type: "cursor", userId: socket.id, cursor: user.cursor }, socket);
}

function handleAddPage(socket, room, message) {
  if (room.pages.length >= maxPagesPerRoom) return;

  const page = createPage(String(message.title || `Page ${room.pages.length + 1}`).slice(0, 40));
  room.pages.push(page);
  room.activePageId = page.id;
  scheduleSave();
  broadcast(room, { type: "page-added", page: { id: page.id, title: page.title, text: "", version: 0 } });
}

function handleDeletePage(socket, room, message) {
  if (room.pages.length <= 1) return;

  const pageIndex = room.pages.findIndex((item) => item.id === message.pageId);
  if (pageIndex === -1) return;

  const [deletedPage] = room.pages.splice(pageIndex, 1);
  const fallbackPage = room.pages[Math.min(pageIndex, room.pages.length - 1)];
  if (room.activePageId === deletedPage.id) {
    room.activePageId = fallbackPage.id;
  }

  for (const user of room.users.values()) {
    if (user.activePageId === deletedPage.id || user.cursor?.pageId === deletedPage.id) {
      user.activePageId = fallbackPage.id;
      user.cursor = { pageId: fallbackPage.id, index: 0, start: 0, end: 0 };
    }
  }

  scheduleSave();
  broadcast(room, { type: "page-deleted", pageId: deletedPage.id, activePageId: fallbackPage.id });
}

function handleRenamePage(socket, room, message) {
  const page = room.pages.find((item) => item.id === message.pageId);
  if (!page) return;
  page.title = String(message.title || page.title).trim().slice(0, 40) || page.title;
  scheduleSave();
  broadcast(room, { type: "page-renamed", pageId: page.id, title: page.title });
}

function handleSwitchPage(socket, room, message) {
  const user = room.users.get(socket.id);
  const page = room.pages.find((item) => item.id === message.pageId);
  if (!user || !page) return;
  user.activePageId = page.id;
  user.cursor = { pageId: page.id, index: 0, start: 0, end: 0 };
  broadcast(room, { type: "cursor", userId: socket.id, cursor: user.cursor }, socket);
}

function normalizeCursor(page, cursor) {
  const start = clamp(Number(cursor.start ?? cursor.index) || 0, 0, page.text.length);
  const end = clamp(Number(cursor.end ?? cursor.index) || 0, 0, page.text.length);
  const index = clamp(Number(cursor.index ?? end) || 0, 0, page.text.length);

  return {
    pageId: page.id,
    index,
    start: Math.min(start, end),
    end: Math.max(start, end)
  };
}

function leave(socket) {
  if (socket.wsReadyState === "closed") return;
  socket.wsReadyState = "closed";
  sockets.delete(socket);

  if (!socket.roomId) return;
  const room = rooms.get(socket.roomId);
  if (!room) return;
  room.users.delete(socket.id);
  broadcast(room, { type: "user-left", userId: socket.id });

  if (roomTtlMs > 0 && room.users.size === 0) {
    setTimeout(() => {
      const latest = rooms.get(room.id);
      if (latest && latest.users.size === 0) {
        rooms.delete(room.id);
        deleteRoomFromSupabase(room.id).catch((error) => console.error(`Failed to delete room data: ${error.message}`));
        scheduleSave();
      }
    }, roomTtlMs);
  }
}

await loadRooms();

server.listen(port, host, () => {
  console.log(`Collaborate Memo is running at http://localhost:${port}`);
  for (const address of getLanAddresses()) {
    console.log(`LAN access: http://${address}:${port}`);
  }
});

async function shutdown() {
  clearTimeout(saveTimer);
  await saveRooms();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function getLanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
}
