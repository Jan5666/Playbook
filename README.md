# Playbook PWA

Single-page React PWA for tracking your investment playbook with live prices, P&L, price alerts, and iPhone notifications.

## Deploy

This is a static site — all 9 files must be served from the **same HTTPS origin** with the service worker (`sw.js`) at the site root.

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
| `index.html` | Shell with PWA meta tags |
| `app.js` | Compiled React app (~80 KB) |
| `data.js` | Playbook reference data (holdings, picks, hedges) |
| `styles.css` | iPhone-optimized styles with safe-area handling |
| `sw.js` | **Same-origin service worker** — required for iOS push |
| `manifest.json` | PWA manifest |
| `icon-180.png` | Apple touch icon |
| `icon-192.png` | Standard PWA icon |
| `icon-512.png` | Large icon for splash |

## Data sources

- **Prices**: Yahoo Finance chart API via multiple CORS proxies (corsproxy.io, allorigins, codetabs). JSE tickers use `.JO` suffix with automatic cents→rand conversion.
- **News**: Yahoo Finance RSS via api.rss2json.com (free tier, subject to rate limits).

## Your data

Everything you enter — positions, cost basis, watchlist, alerts — lives in `localStorage` on your phone. Never sent to any server.

Use **Backup data** on the Dashboard to download a JSON file. **Restore backup** to re-import it.

Clearing Safari data or uninstalling the PWA wipes your inputs.

## Known limits

- Prices have ~15 min delay (free data sources are delayed).
- News RSS can return empty if rate-limited.
- iOS notifications only fire reliably while the app is open or recently backgrounded. True always-on push requires a backend server — out of scope for a static site.
- No automatic market-hours detection; the refresh loop runs 24/7 at 90-second intervals while open.

## Not investment advice.
