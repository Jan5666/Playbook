# Playbook PWA

Single-page React PWA for tracking your investment playbook with live prices, P/L, price alerts, phone notifications, and a Hot Topics earnings/macro radar.

## Highlights

- **Live prices & P/L** across US, JSE, TFSA and more, with market-hours-aware polling (slows to 5-min cadence when every tracked market is closed to save battery).
- **Price alerts** that fire in-app, in the background on Android (Periodic Background Sync), and — with the optional backend below — as true server push on **both iPhone and Android even when the app is fully closed**.
- **Hot Topics** tab: a 30-day earnings countdown across global mega-caps, your own holdings/watchlist and JSE names; a scheduled central-bank calendar (Fed/ECB/BoJ/BoE/SARB) plus data/energy events; and AI-surfaced market-moving headlines.

## Optional push backend (always-on alerts)

A static site can't wake itself to check prices when closed — so for premium, app-closed delivery (the only way on iPhone), deploy the tiny free Cloudflare Worker in [`backend/`](backend/README.md). It checks your alerts every minute during market hours and pushes instantly, at near-zero phone battery. Then paste its URL into **Alerts → Background push server**. Takes ~5 minutes; runs entirely on Cloudflare's free tier.

## Deploy

This is a static site — all the static assets below must be served from the **same HTTPS origin** with the service worker (`sw.js`) at the site root.

### Easiest: Netlify Drop
1. Go to https://app.netlify.com/drop
2. Drag the entire unzipped folder onto the page
3. Wait ~20 seconds for deployment
4. You'll get a URL like `https://random-name-123.netlify.app`
5. Open that URL on your iPhone in Safari

### Alternative: GitHub Pages
1. Create a new repo (public or private with Pages enabled)
2. Upload all 9 files to the repo root (not a subfolder)
3. Settings → Pages → Deploy from branch → `main` / `(root)`
4. Wait ~2 minutes for deployment
5. Open `https://<username>.github.io/<repo>/` on iPhone

### Alternative: Cloudflare Pages
1. https://dash.cloudflare.com → Pages → Create a project → Direct upload
2. Drag the folder
3. Deploy

## Install on iPhone

**Critical: notifications only work after install to Home Screen.**

1. Open the hosted URL in **Safari** (NOT Chrome — iOS Chrome can't install PWAs)
2. Tap the **Share** button (the square with an up-arrow, usually at the bottom)
3. Scroll down and tap **Add to Home Screen**
4. Tap **Add** in the top-right
5. Close Safari and open Playbook from your home screen icon
6. Go to the Alerts tab → tap "Enable notifications"
7. Allow when iOS asks

You must reopen from the home-screen icon, not Safari. iOS 16.4 or newer required.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Shell with PWA meta tags; loads React 18 from a CDN, then `data.js` + `app.js` |
| `app.js` | The whole React app — hand-written `React.createElement` (no build step / no JSX), ~755 KB |
| `data.js` | Playbook reference data (holdings, picks, hedges) + sector classifiers |
| `styles.css` | iPhone-optimized styles with safe-area handling |
| `sw.js` | **Same-origin service worker** — required for iOS push |
| `manifest.json` / `manifest-light.json` | PWA manifests (dark / light home-screen tile) |
| `icon-180/192/512.png` | App icons (Apple touch + PWA + splash) |
| `brand/` | Favicon + light/dark home-screen icon variants |
| `backend/` | Optional Cloudflare Worker for always-on server push **and** zero-knowledge cloud backup (see its own README) — not part of the static deploy |

## Data sources

- **Prices**: Yahoo Finance chart API via multiple CORS proxies (corsproxy.io, allorigins, codetabs). JSE tickers use `.JO` suffix with automatic cents→rand conversion.
- **News**: Yahoo Finance RSS via api.rss2json.com (free tier, subject to rate limits).
- **Hot Topics**: Perplexity (`sonar`) for the live earnings calendar, macro events and market-moving news when an API key is set (Alerts → AI news); always falls back to a built-in 2026 central-bank calendar and any earnings dates already cached for your holdings. The central-bank dates are scheduled a year ahead — refresh `BUILTIN_MACRO_2026` in `app.js` annually.

## Your data

Everything you enter — positions, cost basis, watchlist, alerts — lives in `localStorage` on your phone. Never sent to any server.

Use **Backup data** on the Dashboard to download a JSON file. **Restore backup** to re-import it.

Clearing Safari data or uninstalling the PWA wipes your inputs.

## Known limits

- Prices have ~15 min delay (free data sources are delayed).
- News RSS can return empty if rate-limited.
- **Without the backend**, iOS notifications only fire while the app is open or recently backgrounded (Android also gets throttled Periodic Background Sync). **With the [optional backend](backend/README.md)**, alerts arrive as real push on both platforms even when the app is fully closed.
- Hot Topics' built-in macro calendar is a hardcoded 2026 schedule; set a Perplexity key for live, self-updating coverage that supersedes it.

## Not investment advice.
