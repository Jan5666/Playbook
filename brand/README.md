# Playbook brand assets

Indigo rising-bars mark ("Ascent"), tuned to your app's existing colors.

## Colors
- Indigo (primary / brightest bar): `#6E6EF0`
- Indigo deep (mid bar): `#5A5AD0`
- Muted bar (dark mode): `#3A3A52`  ·  (light mode): `#C9CBDB`
- Dark tile background: `#0B0B10`

## Files
| File | Use |
|------|-----|
| `mark.svg` | The bars only, transparent — put next to the wordmark in the header |
| `favicon.svg` | Browser tab favicon (dark tile, scalable) |
| `favicon-32.png` | PNG fallback favicon |
| `icon-dark.svg` / `icon-light.svg` | Full app-icon tile, dark / light |
| `icon-512.png` / `icon-192.png` | PWA / Android icons |
| `apple-touch-icon.png` (180px) | iOS home-screen icon |

## How to wire it up (Claude Code in Cursor)
Drop the `brand/` folder into your app's `public/` (or `static/`) directory, then paste this prompt to Claude Code:

> Add our new brand icons from `public/brand/`.
> 1. In `index.html` `<head>`, replace any existing favicon links with:
>    ```html
>    <link rel="icon" type="image/svg+xml" href="/brand/favicon.svg">
>    <link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png">
>    <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
>    ```
> 2. If there is a `manifest.webmanifest` / `manifest.json`, set its `icons` to `/brand/icon-192.png` (192x192) and `/brand/icon-512.png` (512x512).
> 3. In the header/navbar component, render `mark.svg` immediately to the LEFT of the "Playbook" wordmark — about 28–30px tall, with ~12px gap. Use `icon-light.svg`'s muted-bar color logic if the header is ever shown on a light background (swap `#3A3A52` → `#C9CBDB`); otherwise the SVG already works on dark.
> Do not change the wordmark font or any other layout.

### Optional follow-up (allocation donut cleanup)
> In the Allocation card, group all holdings below the top 6 into a single "Other" slice, and recolor the remaining slices using an indigo→blue ramp: `#6E6EF0, #5A6FE6, #4F86DC, #4F9BCF, #5AAFC2, #7E7AD6`, with "Other" as `#2E2E3C`. Keep the donut's center total label.
