# WebUI-Nova Test Report — 2026-02-09

Scope: Remove Trading UI + chat status updates + reconnect indicator + Next cron refresh.

## Manual checks
- Chat loads, session list populates, connection status updates.
- Chat status shows **thinking** while awaiting reply and returns to **idle** after final.
- Textarea fits ~10 lines (taller input).
- Insights refresh updates cron list (no-cache fetch with timestamp).
- Trading widgets removed (profit/loss, last trade, open trades, next exit).

## Screenshot
- demo/2026-02-09/webui-nova-remove-trading.png
