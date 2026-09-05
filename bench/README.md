# Benchmark

Reproducible performance numbers for the app, independent of your network.

```bash
cd bench
npm install && npx playwright install chromium   # once
npm run record                                    # once: capture real API/CDN responses into fixtures/
node run.mjs --label baseline                     # replay with synthetic network + 4x CPU throttle
# ...make changes...
node run.mjs --label after
node compare.mjs baseline after
```

## What is measured

**Startup** (median of 5 fresh browser contexts):

| metric | meaning |
|---|---|
| `first_card_ms` | navigation start until the first `.job-card` exists in the DOM. The user-facing "I can see jobs" moment. |
| `fcp_ms` | First Contentful Paint. |
| `dcl_ms` | DOMContentLoaded. |
| `requests_before_first_card` | how many requests were on the path to the first card. |
| `kb_before_first_card` | bytes fetched before the first card. |

Measured twice per run: **cold** (empty localStorage, first visit) and **warm** (returning user, the app's own cache populated).

**Render** (413-post thread, median of 7): time for `renderJobs(allComments)` to return (`js_ms`) and until the next painted frame (`frame_ms`) for a set of representative search queries. `renderJobs` is the stable seam: whatever the internals become, it must re-render the list for the current search and filter state.

## Network model

Every request, local files included, is fulfilled after `RTT + bytes / bandwidth`. Default `--rtt 100 --mbps 5 --cpu 4` approximates a mid-range phone on an average connection. Third-party URLs are served from `fixtures/` (gzipped, recorded once); a request with no fixture is aborted and reported. Analytics is always blocked.

Re-record only deliberately: it changes the data the baseline was measured against.
