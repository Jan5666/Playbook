// scratchpad/inc8-extract-picks.mjs - run once from repo root; NOT committed.
// Moves PicksView verbatim app.js -> pb-views.js (injecting the bridge + PB_DATA reads),
// replaces the app.js definition with a bind, grows the PBApp bridge to 7 members, and
// fixes the inc-7 bind comment's stale filename. BOM + CRLF + \uXXXX escapes preserved.
import { readFileSync, writeFileSync } from 'node:fs';

// ---- app.js: slice PicksView out (ASCII markers) ----
const appLines = readFileSync('app.js', 'utf8').split('\r\n');
const pStart = appLines.findIndex(l => l.startsWith('function PicksView('));
if (pStart < 0) throw new Error('PicksView start marker not found');
const pEnd = appLines.findIndex((l, i) => i > pStart && l.startsWith('function HedgesView('));
if (pEnd < 0) throw new Error('HedgesView end marker not found');
const moved = appLines.slice(pStart, pEnd); // PicksView fn, verbatim

// inject the two lead reads immediately after the signature line
moved.splice(1, 0,
  '  const { PriceBlock, fmt } = window.PBApp;',
  '  const DATA = window.PB_DATA;');

// replace the app.js definition with a one-line bind (+ note)
appLines.splice(pStart, pEnd - pStart,
  '// PicksView is defined in pb-views.js (Phase 4 inc 8); bind it here.',
  'const PicksView = PBViews.PicksView;');

// grow the PBApp bridge (fresh index - the line moved up after the splice above)
const bridgeIdx = appLines.findIndex(l => l.startsWith('window.PBApp = {'));
if (bridgeIdx < 0) throw new Error('PBApp publish marker not found');
appLines[bridgeIdx] = 'window.PBApp = { Icon, timeAgo, hotToDate, hotDayDiff, prettyName, PriceBlock, fmt };';

// fix the inc-7 bind comment's stale filename (HotTopicsView note still says pb-view-hot.js)
const cmtIdx = appLines.findIndex(l => l.includes('HotTopicsView is defined in pb-view-hot.js'));
if (cmtIdx >= 0) appLines[cmtIdx] = appLines[cmtIdx].split('pb-view-hot.js').join('pb-views.js');

writeFileSync('app.js', appLines.join('\r\n'), 'utf8');

// ---- pb-views.js: insert PicksView before the registration block, then register it ----
const vLines = readFileSync('pb-views.js', 'utf8').split('\r\n');
const regIdx = vLines.findIndex(l => l.includes('window.PBViews = window.PBViews'));
if (regIdx < 0) throw new Error('PBViews registration marker not found');
vLines.splice(regIdx, 0, '', '// --- New picks (moved from app.js, Phase 4 inc 8) ---', ...moved);
const hotRegIdx = vLines.findIndex(l => l.includes('window.PBViews.HotTopicsView = HotTopicsView'));
if (hotRegIdx < 0) throw new Error('HotTopicsView registration marker not found');
vLines.splice(hotRegIdx + 1, 0, '  window.PBViews.PicksView = PicksView;');
writeFileSync('pb-views.js', vLines.join('\r\n'), 'utf8');

console.log('inc8: moved', moved.length, 'lines (incl. 2 injected); pb-views.js now', vLines.length, 'lines');
