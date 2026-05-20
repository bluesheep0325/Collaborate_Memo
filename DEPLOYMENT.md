# Free Render Deployment

This setup is intended for occasional meetings, such as a weekly 3-hour session.

## What to Expect

- First access after the app sleeps can take about a minute.
- Connected browsers send a heartbeat every 30 seconds to help keep the free service awake during the meeting.
- Data is held in memory during the session. Render free local files are not durable across restarts, redeploys, or spin-downs.
- Save important pages with `TXT保存` before ending a meeting.

## Deploy

1. Open Render and create a new Blueprint from this GitHub repository.
2. Confirm it detects `render.yaml`.
3. Set `ROOM_PASSWORD` to a shared passphrase.
4. Deploy.
5. Open the generated `https://...onrender.com` URL.
6. Share the URL, room ID, user name convention, and passphrase with meeting participants.

## Optional

Set `ALLOWED_ORIGINS` after the first deploy if you want WebSocket connections to be accepted only from the Render URL.

Example:

```text
ALLOWED_ORIGINS=https://your-service-name.onrender.com
```

Do this after you know the final URL. If it is set incorrectly, clients can load the page but fail to connect in realtime.
