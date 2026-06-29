# Refresh button peek — design

**Date:** 2026-06-29
**Status:** Approved (design), pending implementation
**Area:** Header — price-feed status + refresh control

## Problem

The header carries the price-feed status in a standalone pill (`.status-chip`,
"Updated 5s ago" / "Updating…" / "Couldn't refresh — tap to retry") sitting
beside a separate refresh `.icon-btn`. Two controls do one job, and the pill's
variable width competes with the "Playbook" brand for space (see the prior
header-squeeze fix). The user wants the status folded into the refresh button,
with a press-and-hold gesture that expands to reveal the last-updated time in a
premium, iOS-style animation.

## Goals

- Merge feed status into the refresh button; remove the standalone `.status-chip`.
- At rest, the button shows status at a glance via a small **colored dot**
  (green = live, amber = updating, red = couldn't refresh) and keeps spinning
  while loading.
- **Press-and-hold ("peek")** expands a pill leftward out of the button showing
  the **relative time + state** ("Updated 5s ago" / "Updating…" / "Couldn't
  refresh — tap to retry"). It stays open while held and springs closed on
  release.
- A **quick tap still refreshes** (existing behaviour, `onChipRefresh`).
- Animation reads as premium / iOS (codebase easing, subtle scale + shadow +
  backdrop blur), and respects `prefers-reduced-motion`.

## Non-goals

- No change to feed/polling logic or to `refreshChipState` semantics — only the
  presentation moves.
- Holdings tab sort/refresh untouched.
- No haptics (web has no reliable API here); the spring + visual is the feel.

## Interaction model

State lives in the existing `App` scope where `chipState`, `onChipRefresh`,
`loading`, and `lastUpdate` already exist (around app.js:2962–2985, 3320–3366).

- `onPointerDown` on the control: capture the pointer (`setPointerCapture`),
  record press time, start a **hold timer (~200ms)**.
- **Release < 200ms** (timer still pending) → treat as a **tap → `onChipRefresh()`**.
- **Timer fires while still pressed** → enter **peek**: set `peeking = true`
  (pill expands). The relative time keeps ticking live via the existing
  `useNow` clock, so a held-open pill updates in place.
- **Release while peeking** → `peeking = false` (spring closed); **do not** fire
  a refresh.
- **Pointer move beyond a small slop (~10px)** before the timer fires → cancel
  (it was a scroll/drag, not a tap or hold); mirrors the watchlist long-press
  slop check.
- `onContextMenu` → `preventDefault()` and `touch-action: none` on the control,
  so a touch long-press doesn't trigger the OS context menu / text selection.
- Error state (`chipState.phase === 'error'`): red dot at rest; a tap retries
  (already wired through `onChipRefresh`), a peek reads the retry text.

Tap-vs-hold disambiguation is purely the 200ms timer + slop; no reliance on
`click` (we drive everything from pointer events and suppress the click).

## Visual & animation spec

### Resting state — status dot
- Small dot positioned as a badge on the refresh icon (top-right), reusing the
  existing dot color classes: `.dot.live` / `.dot.loading` / `.dot.stale` /
  `.dot.error` (driven by `chipState.dot`).
- Icon retains its `spin` class while `loading`.
- Dot fades out once the pill is open (the text conveys state then).

### Peek pill — expansion
- The pill is an overlay anchored to the control's **right edge**, growing
  **leftward** into the flexible gap between the brand and the icons →
  **no reflow** of bell/settings.
- Width animates to the **JS-measured content width** (measure the text's
  `scrollWidth` on open and set an explicit px width) so easing is crisp and
  length-independent, rather than a guessed `max-width`.
- Text fades + slides in (`opacity` 0→1, small `translateX`).
- Easing: `cubic-bezier(0.32, 0.72, 0, 1)` (the codebase's iOS curve, app.js:312).
- Durations: **~280ms open / ~220ms close**.
- Premium touches: pill scales from `0.96`→`1`, soft shadow lift, and a
  header-matching `backdrop-filter: blur(20px)` translucent background.
- `transform-origin: right center` so it visually emanates from the button.

### Reduced motion
- Under `@media (prefers-reduced-motion: reduce)`: skip width/scale/transition;
  the pill appears/disappears instantly. All state remains accessible.

## Structure / components

- **Remove** the `.status-chip` element from the header JSX (app.js:3332–3344).
- **New `RefreshControl`** (small component or inline cluster) rendered where the
  refresh `.icon-btn` is today. It owns:
  - the icon button (refresh glyph + status dot badge),
  - the overlay peek pill (text node + measuring ref),
  - the pointer/hold handlers (`longPressTimerRef`-style, mirroring
    app.js:6877–7034 and `setPointerCapture` usage).
  - Props in: `chipState`, `loading`, `lastUpdate`, `onRefresh` (= `onChipRefresh`).
- **CSS** added to the header block of styles.css (near `.icon-btn`, ~line 159):
  `.refresh-ctl` (positioning context), `.refresh-dot` (badge), `.refresh-peek`
  (overlay pill), open/closed states, and the reduced-motion override.

The bell and settings buttons, and the surrounding header flex layout (including
the prior brand `flex: 1 0 auto` squeeze fix), are unchanged.

## Accessibility

- The button's `aria-label` carries the live status text (e.g. "Updated 5s ago,
  tap to refresh") so screen-reader and keyboard users get the status on focus.
- `Enter` / `Space` trigger a refresh (peek is a pointer-only visual
  enhancement; no information is exclusive to it).
- `focus-visible` outline preserved (as the chip had).

## Edge cases

- Held open across a successful refresh: dot/text update live ("Updating…" →
  "Updated just now"); pill width re-measures on text change.
- Pointer leaves the button while held: pointer capture keeps the gesture bound;
  release still collapses.
- Very long error text while peeking on a narrow screen: pill width is capped to
  available space with ellipsis (reuses the chip's prior overflow handling), so
  it never pushes "Playbook".
- Rapid tap during a spin: still issues a refresh (no-op-safe, as today).

## Testing / verification

Real-browser harness (same shape as `verify-refresh-behavior.mjs` /
`verify-extended-hours.mjs`):

1. The standalone `.status-chip` no longer renders; the refresh control does.
2. The status dot's class tracks feed state (seed loading/live/error → assert
   `.refresh-dot` class).
3. A **short tap** issues a fresh sweep (network mock logs a request); a
   **synthetic long-press** (pointerdown, wait > 200ms, pointerup) expands the
   pill (assert it becomes visible with the relative-time text) and issues
   **no** refresh.
4. Holding shows the live text; releasing collapses it.
5. Existing `verify-refresh-behavior.mjs` still passes (tap-refresh, cache-bust,
   chip text/state transitions adapted to the new control).
