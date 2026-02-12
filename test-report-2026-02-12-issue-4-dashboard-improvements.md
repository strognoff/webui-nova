# Test Report — webui-nova issue #4 (dashboard improvements)

Date (UTC): 2026-02-12
Branch: `feat/issue-4-dashboard-improvements`

## Scope verified

1. Session list is AGENT-only
- Code path: `public/app.js` (`refreshSessions` filters `key.startsWith('agent:')`).
- Result: PASS

2. SEND flow reliability
- Non-empty validation added.
- Guard states for disconnected/no-session.
- Send button disabled while sending; re-enabled on final/error/disconnect.
- Result: PASS

3. Reconnect behavior
- Reconnect button guarded against double-click races.
- Reconnecting UI state shown while reconnect is in progress.
- Result: PASS

4. Token usage chart day boundary
- Day bucket uses local timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) instead of hardcoded London.
- UI label updated to local-date wording.
- Result: PASS

5. Obsolete trading panels copy
- Strings `TOTAL P/L`, `NEXT EXIT`, and `OPEN TRADES` not present in current served UI/server files.
- Result: PASS

## Notes
- `node --check server.mjs` passes.
- No automated UI suite in repo for these flows; verification is code-path + runtime sanity checks.
