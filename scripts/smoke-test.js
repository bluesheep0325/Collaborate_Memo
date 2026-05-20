import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const port = 3100;
const baseUrl = `http://localhost:${port}`;
const wsUrl = `ws://localhost:${port}`;
const password = "smoke-secret";
const dataFile = join(tmpdir(), `collaborate-memo-smoke-${Date.now()}.json`);
const server = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    ROOM_PASSWORD: password,
    MEMO_DATA_FILE: dataFile
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
server.stdout.on("data", (chunk) => {
  stdout += chunk;
});
server.stderr.on("data", (chunk) => {
  stderr += chunk;
});

try {
  await waitForHttp();
  const health = await fetch(`${baseUrl}/healthz`).then((response) => response.json());
  assert(health.ok === true, "health endpoint should report ok");

  const html = await fetch(baseUrl).then((response) => response.text());
  assert(html.includes("Collaborate Memo"), "index page should load");

  const rejected = await connectClient("smoke-room", "Mallory", "wrong");
  assert(rejected.error.reason === "invalid-password", "wrong password should be rejected");
  rejected.socket.close();

  const alice = await connectClient("smoke-room", "Alice", password);
  const bob = await connectClient("smoke-room", "Bob", password);
  const pageId = alice.joined.room.pages[0].id;

  const bobEdit = waitForMessage(bob.socket, (message) => message.type === "page-op", "bob page-op");
  alice.socket.send(
    JSON.stringify({
      type: "page-op",
      pageId,
      baseVersion: 0,
      op: { start: 0, deleteCount: 0, insert: "hello" },
      cursor: { index: 5 }
    })
  );
  const editMessage = await bobEdit;
  assert(editMessage.op.insert === "hello", "text operation should reach the other user");

  const aliceCursor = waitForMessage(alice.socket, (message) => message.type === "cursor", "alice cursor");
  bob.socket.send(JSON.stringify({ type: "cursor", pageId, index: 3 }));
  const cursorMessage = await aliceCursor;
  assert(cursorMessage.cursor.index === 3, "cursor position should reach the other user");

  const bobPage = waitForMessage(bob.socket, (message) => message.type === "page-added", "bob page-added");
  alice.socket.send(JSON.stringify({ type: "add-page", title: "Second page" }));
  const pageMessage = await bobPage;
  assert(pageMessage.page.title === "Second page", "new page should reach the other user");

  const aliceRename = waitForMessage(alice.socket, (message) => message.type === "page-renamed", "alice page-renamed");
  bob.socket.send(JSON.stringify({ type: "rename-page", pageId, title: "Renamed page" }));
  const renameMessage = await aliceRename;
  assert(renameMessage.title === "Renamed page", "renamed page title should reach the other user");

  const aliceDelete = waitForMessage(alice.socket, (message) => message.type === "page-deleted", "alice page-deleted");
  bob.socket.send(JSON.stringify({ type: "delete-page", pageId: pageMessage.page.id }));
  const deleteMessage = await aliceDelete;
  assert(deleteMessage.pageId === pageMessage.page.id, "deleted page should reach the other user");

  alice.socket.close();
  bob.socket.close();
  console.log("Smoke test passed");
} finally {
  if (stderr.trim()) console.error(stderr.trim());
  server.kill();
  await Promise.race([once(server, "exit"), delay(1000)]);
}

async function waitForHttp() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`server exited early\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      await delay(100);
    }
  }
  throw new Error("server did not become ready");
}

async function connectClient(roomId, userName, roomPassword) {
  const socket = new WebSocket(wsUrl);
  await once(socket, "open");
  const result = waitForMessage(
    socket,
    (message) => message.type === "joined" || message.type === "join-error",
    `${userName} joined`
  );
  socket.send(JSON.stringify({ type: "join", roomId, userName, password: roomPassword }));
  const message = await result;
  return message.type === "joined" ? { socket, joined: message } : { socket, error: message };
}

function waitForMessage(socket, predicate, label, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`timed out waiting for websocket message: ${label}`));
    }, timeoutMs);

    function onMessage(event) {
      const message = JSON.parse(event.data);
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    }

    socket.addEventListener("message", onMessage);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
