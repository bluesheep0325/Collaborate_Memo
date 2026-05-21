# Free Render Deployment

This setup is intended for occasional meetings, such as a weekly 3-hour session.

## What to Expect

- First access after the app sleeps can take about a minute.
- Connected browsers send a heartbeat every 30 seconds to help keep the free service awake during the meeting.
- Data is held in memory during the session. Render free local files are not durable across restarts, redeploys, or spin-downs.
- If Supabase is configured, room data is restored after restarts for the configured retention period.
- Save important pages with `TXT保存` before ending a meeting when the content matters.

## Deploy

1. Create a Supabase project.
2. Open the Supabase SQL Editor and run `supabase/schema.sql` from this repository.
3. Open Render and create a new Blueprint from this GitHub repository.
4. Confirm it detects `render.yaml`.
5. Set `ROOM_PASSWORD` to a shared passphrase.
6. Set `SUPABASE_URL` to your Supabase project URL.
7. Set `SUPABASE_SERVICE_ROLE_KEY` to the server-side service role key.
8. Deploy.
9. Open the generated `https://...onrender.com` URL.
10. Share the URL, room ID, user name convention, and passphrase with meeting participants.

## Supabase Retention

The default retention is 7 days:

```text
SUPABASE_RETENTION_DAYS=7
```

Old rooms are removed when the app starts. Set this to a larger number if you want longer recovery, or leave Supabase variables empty to use memory-only session storage.

Keep `SUPABASE_SERVICE_ROLE_KEY` only in Render environment variables. Do not place it in frontend code, README examples, screenshots, or GitHub issues.

## Text Size Limits

The default page limit is:

```text
MAX_PAGE_CHARS=200000
MAX_FRAME_BYTES=1048576
```

Raise both values if you need to paste longer transcripts. `MAX_FRAME_BYTES` is a byte limit for one WebSocket message, so set it to at least `MAX_PAGE_CHARS * 4 + 16384` when `MAX_PAGE_CHARS` is increased.

## Verify

After deploy:

```powershell
$env:DEPLOY_URL='https://your-app.onrender.com'
$env:ROOM_PASSWORD='<shared room passphrase>'
npm run verify:deploy
```

This checks the health endpoint, page load, WebSocket join, and heartbeat.

## Optional

Set `ALLOWED_ORIGINS` after the first deploy if you want WebSocket connections to be accepted only from the Render URL.

Example:

```text
ALLOWED_ORIGINS=https://your-service-name.onrender.com
```

Do this after you know the final URL. If it is set incorrectly, clients can load the page but fail to connect in realtime.
