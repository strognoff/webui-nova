# Test report — 2026-02-11 (Remove Trading, reopen follow-up)

## Scope verified
Issue: https://github.com/strognoff/webui-nova/issues/2

Reopened requirements covered:
- Chat box enlarged to 10+ lines
- Thinking status shown while replying
- Reconnect action + connection status shown
- "Next cron" refresh reliability
- Trading widgets removed (Total P/L, Next Exit, Open Trades)

## Verification notes
1. **Trading widgets removed**
   - UI now focuses on cron/token/activity insights; no trading cards present in layout.
2. **Thinking status**
   - `chatStatus` is set to `thinking` during send flow and returns to `idle` on final/error.
3. **Reconnect + connection status**
   - `GET /api/connection-status` returns live connectivity state.
   - `POST /api/reconnect` triggers reconnect check and UI badge update.
4. **Larger textbox**
   - Input textarea updated to `rows="10"`.
5. **Next cron refresh**
   - Insights refresh is `async` and uses no-cache timestamp query (`/api/insights?ts=...`) for fresh next-run values.

## Artifacts
- Screenshot: `demo/2026-02-11/webui-nova-remove-trading-v2.png`

## Runtime sanity checks
- `node --check public/app.js` passes.
- API checks during run:
  - `GET /api/connection-status` => connected true
  - `POST /api/reconnect` => connected true
