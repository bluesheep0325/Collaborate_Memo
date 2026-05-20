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
