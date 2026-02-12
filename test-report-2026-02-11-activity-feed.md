# Test report — 2026-02-11 Activity feed

## Scope
Issue: https://github.com/strognoff/webui-nova/issues/3

## Automated tests
Command:
```bash
npm run test:activity
```
Result:
- pass 2 / fail 0
- verifies endpoint caps at 5 items and sorts newest-first
- verifies empty-state contract `{ items: [] }`

## API contract check
Command:
```bash
curl -sS 'http://127.0.0.1:18881/api/activity-feed?limit=99' | jq '.items | length'
```
Result:
- returns max 5 when data exists
- returns 0 when no updates exist

## UI evidence
- Success state screenshot: `demo/activity-feed-success.png`
- Empty state screenshot: `demo/activity-feed-empty.png`
- Error state screenshot: `demo/activity-feed-error.png`

## Notes
- Canonical event contract:
  - `id` string
  - `timestamp` ISO-8601 UTC
  - `type` string
  - `summary` string
- Ordering: newest first by timestamp
