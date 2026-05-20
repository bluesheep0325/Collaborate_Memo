# Collaborate Memo

Browser-based realtime collaborative memo app for small rooms.

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

This repository includes `render.yaml` for Render web services. Create a Render Blueprint from this repository, then set `ROOM_PASSWORD` as a secret environment variable before sharing the public URL.

Recommended environment variables:

```text
ROOM_PASSWORD=<shared room passphrase>
MEMO_DATA_FILE=/var/data/rooms.json
ALLOWED_ORIGINS=https://your-app.example.com
```

`MEMO_DATA_FILE` controls where room data is saved. On platforms with ephemeral filesystems, configure a persistent disk and point this variable to a path on that disk.

If `ROOM_PASSWORD` is empty, anyone who can access the URL can enter a room by guessing or knowing the room ID.

## Options

```powershell
$env:PORT=8080; npm start
```

```powershell
$env:HOST='127.0.0.1'; npm start
```

## Test

```powershell
npm test
```
