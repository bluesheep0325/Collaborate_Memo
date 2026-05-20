# Collaborate Memo

Browser-based realtime collaborative memo app for small rooms.

Reloading the page rejoins the current room in the same browser tab. Use `退出` to leave the room and clear that tab session.

## Start

```powershell
npm start
```

The server listens on `0.0.0.0:3000`, so other devices on the same LAN can open:

```text
http://<server-ip-address>:3000
```

For access from a different network, run this app behind a VPN, tunnel, reverse proxy, or cloud host and expose port `3000` or your configured `PORT`.

## Public Deploy

This repository includes `render.yaml` for Render free web services. Create a Render Blueprint from this repository, then set `ROOM_PASSWORD` as a secret environment variable before sharing the public URL.

Recommended environment variables:

```text
ROOM_PASSWORD=<shared room passphrase>
ALLOWED_ORIGINS=https://your-app.example.com
```

If `ROOM_PASSWORD` is empty, anyone who can access the URL can enter a room by guessing or knowing the room ID.

Render free web services can spin down when idle and their filesystem is ephemeral. This app sends a heartbeat while users are connected, which helps keep the service awake during a meeting. Treat the server state as session data and export important pages with `TXT保存`.

## Options

```powershell
$env:PORT=8080; npm start
```

```powershell
$env:HOST='127.0.0.1'; npm start
```

```powershell
$env:MEMO_DATA_FILE='C:\memo-data\rooms.json'; npm start
```

`MEMO_DATA_FILE` is useful for local use or platforms with persistent storage. Render free instances do not provide persistent local storage.

## Test

```powershell
npm test
```

## Verify a Deployed App

```powershell
$env:DEPLOY_URL='https://your-app.onrender.com'
$env:ROOM_PASSWORD='<shared room passphrase>'
npm run verify:deploy
```
