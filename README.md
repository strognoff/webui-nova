# webui-nova

<img width="1052" height="695" alt="image" src="https://github.com/user-attachments/assets/7380ac69-2559-4ab3-8d52-aad0d3c649f7" />


A tiny, localhost-only web UI for chatting with **OpenClaw** ("Nova") from your browser.

It’s meant to be:

- **Fast**: one Node server, static HTML/CSS/JS.
- **Local**: binds to `127.0.0.1` only.
- **Session-aware**: can attach to the **same OpenClaw sessionKey** used by the OpenClaw Dashboard/Telegram, so you keep the same context + state.

## What it does

- Shows a minimal chat UI + a lightweight animated SVG face (now more animated).
- Displays chat status (idle / thinking / error) and connection status.
- Chat input supports multi‑line (10+ lines). Shift+Enter for newline.
- Insights focus on cron health + token usage (trading widgets removed).
- Insights refresh uses no‑cache timestamp to keep "next cron" accurate.
- Connects to the **OpenClaw Gateway WebSocket** and uses:
  - `sessions.list` to populate the session dropdown
  - `chat.history` to load conversation history
  - `chat.send` to send messages to the selected session
- Sends chat messages with `deliver: false` so **web chat stays web-only** (does not forward to Telegram).

## Requirements

- Node.js 18+ (works on newer Node versions too)
- An OpenClaw Gateway running locally (loopback), typically at:
  - `http://127.0.0.1:18789/`

## Install

```bash
cd webui-nova
npm install
```

## Run

```bash
npm start
```

By default it listens on:

- http://127.0.0.1:18881

### Environment variables

- `NOVA_WEBUI_PORT` (default: `18881`)
- `OPENCLAW_CONFIG_PATH` (default: `~/.openclaw/openclaw.json`)

Example:

```bash
NOVA_WEBUI_PORT=18881 npm start
```

## Configure OpenClaw (important)

Because this UI is served over plain HTTP on `127.0.0.1:18881` (a different origin than the official dashboard), the Gateway may reject WebSocket connections unless you allow token auth over HTTP.

Set this in your OpenClaw config:

```json5
{
  "gateway": {
    "controlUi": {
      "allowInsecureAuth": true
    }
  }
}
```

This is safe **as long as your gateway remains loopback-only** (`gateway.bind: "loopback"`).

## How to use

1. Start the OpenClaw Gateway.
2. Start this web UI (`npm start`).
3. Open http://127.0.0.1:18881
4. Click **Reconnect**.
5. Pick a session from the **Session** dropdown (usually `agent:main:main`).
6. Chat.

## Files

- `server.mjs`: tiny Node HTTP server
  - serves `/` + static assets
  - exposes `/api/gateway` so the browser can discover the gateway WS URL + token
- `public/index.html`: UI layout
- `public/app.js`: UI logic + gateway WS RPC client
- `public/styles.css`: UI styling

## Security notes

- This server binds to **127.0.0.1 only**. Don’t expose it on LAN/Internet.
- `/api/gateway` returns the gateway token so the browser can connect. This is OK for localhost usage, but you should treat it as sensitive.

## License

Unlicensed for now (internal tooling). Add a license if you plan to share widely.
