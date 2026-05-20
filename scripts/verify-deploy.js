const deployUrl = process.env.DEPLOY_URL;
const password = process.env.ROOM_PASSWORD || "";

if (!deployUrl) {
  console.error("Set DEPLOY_URL before running this script.");
  console.error("Example: $env:DEPLOY_URL='https://your-app.onrender.com'; npm run verify:deploy");
  process.exit(1);
}

const baseUrl = new URL(deployUrl);
baseUrl.pathname = "/";
baseUrl.search = "";
baseUrl.hash = "";

const wsUrl = new URL(baseUrl);
wsUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";

const healthResponse = await fetch(new URL("/healthz", baseUrl));
assert(healthResponse.ok, "health endpoint should return 2xx");
const health = await healthResponse.json();
assert(health.ok === true, "health endpoint should report ok");

const html = await fetch(baseUrl).then((response) => response.text());
assert(html.includes("Collaborate Memo"), "index page should load");

const socket = new WebSocket(wsUrl);
await waitForOpen(socket);

const joined = waitForMessage(socket, (message) => message.type === "joined" || message.type === "join-error");
socket.send(
  JSON.stringify({
    type: "join",
    roomId: `deploy-check-${Date.now()}`,
    userName: "Deploy Check",
    password
  })
);

const message = await joined;
if (message.type === "join-error") {
  throw new Error(`join failed: ${message.reason}`);
}

socket.send(JSON.stringify({ type: "heartbeat" }));
await waitForMessage(socket, (item) => item.type === "heartbeat");
socket.close();

console.log(`Deploy verification passed: ${baseUrl.href}`);

function waitForOpen(socket, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for websocket open")), timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket failed to open"));
    });
  });
}

function waitForMessage(socket, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("timed out waiting for websocket message"));
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
