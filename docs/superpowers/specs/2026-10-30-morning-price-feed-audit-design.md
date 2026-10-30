# Morning price feed audit (2026-10-30)

## Report

For about a month: SA prices don't load in the morning and seem to arrive only after
midday; the refresh button seems to do nothing; the day move looks like a mix of
yesterday's and today's, possibly an SA/US time-zone confusion. Wanted rule: each
market's day move is the move within that market's own trading day: yesterday's while
it is shut, the live move while it is open.

## What could and could not be measured

This container's egress blocks Yahoo and all six CORS proxies, so the live feed was
**not** observed. Everything below is either reproduced on the real kernels (`pb-core`,
`pb-data`) or simulated with a mocked `fetch`. Each defect's test is verified to FAIL
on pristine `main` (stubs for the functions that did not exist yet). No price-related
code changed between 2026-08-13 and this audit, so the "last month" timing points at
the environment: the free proxies (dying, rate-limiting, caching). The code fixes
below make the app tolerate that far better. They do not remove the dependency (see
"Not done").

## Defects and fixes

| # | Defect (reproduced) | Fix |
|---|---|---|
| A | The merge accepted an **older** quote over a newer one: a proxy's cached pre-open response, Stooq's EOD row, or a superseded sweep's last batch put yesterday back on a row. | `PBCore.quoteOlderThan` (sessionDay, then tick) gates `guardBatch`. |
| E2 | The auto-poll URL carried **no** cache key, so a proxy cache's age was unbounded, and a cached answer is a "success" nothing retries. | Per-minute key `&_b=` on the auto-poll's quote URLs; manual keeps per-call `&_=`. |
| E1 | The refresh button **queued behind** the in-flight sweep. Before the bell nothing counts as "unhealthy", so the recovery side-pass had nothing to do and the press waited out a multi-minute sweep. | Press supersedes: the old sweep stops at its next batch boundary (`shouldStop`), a forced sweep starts at once. Tab switches keep the polite queue. |
| D | Sweep order was storage order, so closed US names went ahead of open JSE holdings and failed symbols waited behind healthy ones. | `PBCore.prioritizeSweep`: broken first, then markets in session, then the rest. |
| E3 | A dead proxy kept its slot; every URL refused by the front-runner walked into it and waited its 8 s timeout. Simulated: **80** requests to dead edges per 20 URLs. | Per-proxy health: 2 consecutive failures send a proxy to the back for 3 min (404s neutral). Same simulation: **8**. |
| B | `quoteSettled` froze a JSE/LSE quote fetched minutes after the close, which is a pre-auction print on Yahoo's ~15-min-delayed feed, as "At close" until the next bell. A quote two sessions old was also skipped all night. | Settled needs a fetch ≥ 40 min after the close and `sessionDay === lastSessionDay`. |
| C | On an SA (or NL) phone every US row hid its move from 00:00 SAST until NY midnight (06:00 SAST now, **07:00 SAST from 1 Nov**). | `quoteSessionState` judges the tick on the market's calendar. "Today" sums keep the viewer's day. |

## Not done (deliberately)

* **The structural fix is SECURITY_ROADMAP Phase 1.1**: a first-party quote proxy on
  the existing Worker. It removes the free-proxy dependency that every item above is
  working around. It needs a Worker deploy (Jan-only), so it is out of scope here.
* Thinly traded JSE names with no trade yet today still read `'stale'` (dash) after
  the bell. That is Jan's 2026-08-06 call, unchanged, but it is a candidate cause of
  "SA prices appear only later in the day" for illiquid holdings.
  **Settings → Diagnostics → Price feed** will show it as `day` = yesterday with no
  `MISSED SWEEP` flag.
