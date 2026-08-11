// pb-modals.js - extracted modal-component bucket (Phase 4). Browser-only classic script.
// Registers window.PBModals.<Modal> and reads shared app.js primitives from window.PBApp
// at render time (bridge). data.js/PBStore globals are read directly, not via the bridge.
(function () {
  const { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } = React; // UMD global
  const parseDecimal = PBCore.parseDecimal; // PBCore global (loaded before this script)
  const CURRENCY_SYMBOLS = PBContent.CURRENCY_SYMBOLS; // PBContent global (loaded before this script)
  const priceKey = PBCore.priceKey; // PBCore global
  const marketCurrency = PBCore.marketCurrency; // PBCore global
  const convertCcy = PBCore.convertCcy; // PBCore global
  const valuePositionInCostCcy = PBCore.valuePositionInCostCcy; // PBCore global (money helper - stays in PBCore)
  const positionCostCcy = PBCore.positionCostCcy; // PBCore global (money helper)
  const INDICATOR_INFO = PBContent.INDICATOR_INFO; // PBContent global
  const fetchQuote = PBData.fetchQuote; // PBData global (browser-only; loaded before this script)
  const isUnitTrustId = PBData.isUnitTrustId; // PBData global
  const fetchViaProxies = PBData.fetchViaProxies; // PBData global (CORS proxy fetch — used by fetchSectorTrend)
  const MARKET_CURRENCY = PBCore.MARKET_CURRENCY; // PBCore global
  const sameUnderlyingExchange = PBCore.sameUnderlyingExchange; // PBCore global (JSE === TFSA venue)
  const DISPLAY_CURRENCIES = PBContent.DISPLAY_CURRENCIES; // PBContent global
  const MARKETS = PBContent.MARKETS; // PBContent global
  const RIBBON_CATALOG = PBContent.RIBBON_CATALOG; // PBContent global
  const SECTOR_ETF = PBContent.SECTOR_ETF; // PBContent global (sector -> SPDR ETF map)
  const SECTOR_TREND_WINDOWS = PBContent.SECTOR_TREND_WINDOWS; // PBContent global
  const parseHoldingsFromText = PBImport.parseHoldingsFromText; // PBImport global (loaded before this script)
  const rankImportCandidates = PBImport.rankImportCandidates; // PBImport global
  const buildImportAttempts = PBImport.buildImportAttempts; // PBImport global
  const companyNameScore = PBImport.companyNameScore; // PBImport global
  const looksLikeTickerToken = PBImport.looksLikeTickerToken; // PBImport global
  const normaliseCompanyName = PBImport.normaliseCompanyName; // PBImport global
  const parseEasyEquitiesScreenshot = PBImport.parseEasyEquitiesScreenshot; // PBImport global
  const dedupeEeHoldings = PBImport.dedupeEeHoldings; // PBImport global
// fetchSectorTrend + SECTOR_TREND_CACHE - sector-ETF trend reader. Moved verbatim
// from app.js (Phase 4 inc 35); its only consumer is SectorDetailModal (this bucket,
// zero pb-views / zero root-App callers). Impure (Yahoo via fetchViaProxies) but
// app-state-uncoupled — reads PBContent/PBData globals (IIFE-read above) + its own
// module-private cache, so no lead read is needed.
// Each GICS-style sector maps to the SPDR sector ETF that tracks it. We treat
// the ETF's own price history as a proxy for "the size / health of the sector"
// over time — it's a clean, liquid, well-known instrument per sector and lets us
// show multi-horizon trend without needing a sector-market-cap time series.
const SECTOR_TREND_CACHE = {};
async function fetchSectorTrend(sectorName) {
  const map = SECTOR_ETF[sectorName];
  if (!map) return { unsupported: true };
  const cached = SECTOR_TREND_CACHE[map.etf];
  if (cached && Date.now() - cached.fetchedAt < 6 * 3600 * 1000) return cached;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${map.etf}?interval=1d&range=5y`;
  const text = await fetchViaProxies(url, { timeoutMs: 9000 });
  if (!text) return null;
  let result;
  try { result = JSON.parse(text)?.chart?.result?.[0]; } catch (_e) { return null; }
  const ts = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(closes)) return null;
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c === 'number' && isFinite(c) && c > 0) bars.push({ t: ts[i] * 1000, p: c });
  }
  if (bars.length < 2) return null;
  const latest = bars[bars.length - 1].p;
  const now = bars[bars.length - 1].t;
  const closeAtOrBefore = (targetMs) => {
    for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].t <= targetMs) return bars[i].p; }
    return null;
  };
  const trends = SECTOR_TREND_WINDOWS.map(w => {
    const past = closeAtOrBefore(now - w.days * 86400000);
    const pct = past && past > 0 ? (latest - past) / past * 100 : null;
    return { key: w.key, pct };
  });
  const entry = { etf: map.etf, name: map.name, trends, fetchedAt: Date.now() };
  SECTOR_TREND_CACHE[map.etf] = entry;
  return entry;
}
// useSwipeDownToClose - iOS-sheet swipe-to-dismiss hook. Moved verbatim from app.js
// (Phase 4 inc 34); every caller lives in this bucket (modals only, zero pb-views /
// zero root-App callers). Native useRef/useEffect already IIFE-read above; no lead read.
function useSwipeDownToClose(panelRef, onClose, enabled = true) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // When disabled (e.g. the import review stage), attach nothing at all so a
    // normal content scroll can never be mistaken for a swipe-to-dismiss.
    if (enabled === false) return undefined;
    const panel = panelRef.current;
    if (!panel) return;
    const isMobileLayout = () => window.matchMedia('(max-width: 639px)').matches;
    const getBackdrop = () => panel.parentElement && panel.parentElement.querySelector('.modal-backdrop');
    // iOS-sheet easing — quick, decelerating, no overshoot.
    const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
    let startY = 0;       // y where the actual drag began (transform anchor)
    let originY = 0;      // y where the finger first touched
    let prevY = 0;
    let dragging = false;
    let velocity = 0;
    let lastT = 0;
    let panelH = 0;
    // A close-drag may only begin from the fixed top chrome — the grab handle or
    // the header. The scrolling body never dismisses the sheet, so scrolling its
    // content up/down can no longer close the card (the previous guard checked
    // `panel.scrollTop`, but the panel itself is `overflow:hidden` and never
    // scrolls — the `.modal-body` does — so that guard was always 0 and ANY
    // downward finger anywhere started a close: the "scrolling closes it" bug).
    let grabZone = false;
    const DRAG_THRESHOLD = 6;
    const onTouchStart = (e) => {
      if (!isMobileLayout() || e.touches.length !== 1) return;
      const t = e.target;
      grabZone = !!(t && t.closest && t.closest('.modal-handle, .modal-header'));
      originY = prevY = e.touches[0].clientY;
      dragging = false;
      velocity = 0;
      lastT = Date.now();
      panelH = panel.offsetHeight || window.innerHeight;
    };
    const onTouchMove = (e) => {
      if (!isMobileLayout()) return;
      const y = e.touches[0].clientY;
      if (!dragging) {
        // Only the handle/header grab zone can start a close-drag, pulling down.
        if (!grabZone || y - originY <= 0) { originY = y; prevY = y; return; }
        if (y - originY < DRAG_THRESHOLD) return;
        dragging = true;
        // Anchor the drag here so the panel tracks the finger 1:1 with no jump.
        startY = y;
        // Kill the entrance animation permanently. Otherwise, when we later
        // remove `.swiping` (which set `animation:none`), the base panel's
        // `slide-up` keyframes re-run and the sheet jumps back up before
        // closing — the glitch the user reported.
        panel.style.animation = 'none';
        panel.classList.add('swiping');
      }
      const now = Date.now();
      const dt = now - lastT;
      if (dt > 0) velocity = (y - prevY) / dt;
      prevY = y;
      lastT = now;
      const drag = Math.max(0, y - startY);
      panel.style.transform = `translateY(${drag}px)`;
      const bd = getBackdrop();
      if (bd) bd.style.opacity = String(1 - Math.min(1, drag / panelH) * 0.7);
      if (e.cancelable) e.preventDefault();
    };
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      const drag = Math.max(0, prevY - startY);
      panel.classList.remove('swiping');
      const bd = getBackdrop();
      const shouldClose = drag > panelH * 0.28 || (drag > 48 && velocity > 0.45);
      if (shouldClose) {
        panel.style.transition = `transform 0.26s ${EASE}`;
        panel.style.transform = 'translateY(100%)';
        if (bd) { bd.style.transition = 'opacity 0.26s ease'; bd.style.opacity = '0'; }
        let done = false;
        const cb = () => {
          if (done) return;
          done = true;
          // Trigger the close (which unmounts the modal) while the panel is
          // still translated off-screen. We must NOT reset the transform until
          // we KNOW the close failed to unmount the panel. The old code did this
          // on a fixed 80ms timer, which races React's commit: when the stock
          // card is heavy (charts/fundamentals) or the scroll-restore stalls the
          // frame, the unmount lands later than 80ms, so the panel first slides
          // back into view and only then disappears — the "closes, flickers on,
          // closes again" glitch. Instead, watch the DOM: the instant React
          // removes the panel we stand down and leave it off-screen (no flicker).
          // Only a genuinely guarded onClose (e.g. import review ignores swipe)
          // leaves the node attached, and a long fallback glides it home.
          closeRef.current();
          let settled = false;
          let guard = 0;
          const standDown = () => {
            if (settled) return; settled = true;
            try { obs.disconnect(); } catch (_e) {}
            clearTimeout(guard);
          };
          const obs = typeof MutationObserver !== 'undefined'
            ? new MutationObserver(() => { if (!panel.isConnected) standDown(); })
            : null;
          if (obs) { try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch (_e) {} }
          // Fallback: if the panel is still mounted well after the close (guarded
          // onClose, or no MutationObserver support), glide it back into place.
          guard = setTimeout(() => {
            if (settled) return; settled = true;
            try { obs && obs.disconnect(); } catch (_e) {}
            if (!panel.isConnected) return;
            panel.style.transition = `transform 0.3s ${EASE}`;
            panel.style.transform = '';
            if (bd && bd.isConnected) { bd.style.transition = 'opacity 0.3s ease'; bd.style.opacity = ''; }
          }, 600);
        };
        panel.addEventListener('transitionend', cb, { once: true });
        setTimeout(cb, 320);
      } else {
        panel.style.transition = `transform 0.4s ${EASE}`;
        panel.style.transform = '';
        if (bd) { bd.style.transition = 'opacity 0.3s ease'; bd.style.opacity = ''; }
        const clear = () => { panel.style.transition = ''; if (bd) bd.style.transition = ''; };
        panel.addEventListener('transitionend', clear, { once: true });
        setTimeout(clear, 440);
      }
    };
    panel.addEventListener('touchstart', onTouchStart, { passive: true });
    panel.addEventListener('touchmove', onTouchMove, { passive: false });
    panel.addEventListener('touchend', finish);
    panel.addEventListener('touchcancel', finish);
    return () => {
      panel.removeEventListener('touchstart', onTouchStart);
      panel.removeEventListener('touchmove', onTouchMove);
      panel.removeEventListener('touchend', finish);
      panel.removeEventListener('touchcancel', finish);
    };
  }, [panelRef, enabled]);
}
// SectorWeightRows — ETF/fund sector-split editor. Moved verbatim from app.js (Phase 4 inc 31);
// its only callers (SectorAllocationModal + PositionModal) live in this bucket. Icon via the
// PBApp bridge; DATA read at render time.
function SectorWeightRows({ rows, setRows }) {
  const { Icon } = window.PBApp;
  const DATA = window.PB_DATA; // data.js loads after this bucket - read at render time
  const addRow = () => setRows(rs => [...rs, { sector: '', weight: '' }]);
  const updateRow = (i, patch) => setRows(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const removeRow = (i) => setRows(rs => rs.filter((_, idx) => idx !== i));
  const clean = rows.map(r => ({ sector: r.sector, weight: parseFloat(r.weight) })).filter(r => r.sector && isFinite(r.weight) && r.weight > 0);
  const sum = clean.reduce((s, r) => s + r.weight, 0);
  return React.createElement(React.Fragment, null,
    rows.length === 0
      ? React.createElement("div", { className: "form-help", style: { marginTop: 0, marginBottom: 8 } },
          "Optional. Split a fund or ETF across the sectors it actually holds, so your allocation chart looks through to its real sector mix instead of a single bucket.")
      : React.createElement("div", { className: "sector-split-list" },
          rows.map((r, i) => React.createElement("div", { className: "sector-split-row", key: i },
            React.createElement("select", {
              className: "import-field-select sector-split-sector",
              value: r.sector,
              onChange: e => updateRow(i, { sector: e.target.value })
            }, React.createElement("option", { value: "" }, "Select sector…"),
               (DATA.SECTOR_CANON || []).map(s => React.createElement("option", { key: s, value: s }, s))),
            React.createElement("div", { className: "input-suffix-wrap sector-split-weight" },
              React.createElement("input", {
                type: "number", inputMode: "decimal", min: "0", max: "100", step: "1",
                placeholder: "0", value: r.weight,
                onChange: e => updateRow(i, { weight: e.target.value })
              }),
              React.createElement("span", { className: "suffix" }, "%")),
            React.createElement("button", {
              className: "icon-btn sector-split-del", type: "button", "aria-label": "Remove sector",
              onClick: () => removeRow(i)
            }, React.createElement(Icon, { name: "x", size: 14 }))))),
    React.createElement("div", { className: "sector-split-foot" },
      React.createElement("button", { className: "btn btn-secondary btn-sm", type: "button", onClick: addRow },
        React.createElement(Icon, { name: "plus", size: 13 }), " Add sector"),
      clean.length ? React.createElement("span", {
        className: "sector-split-sum" + (Math.abs(sum - 100) < 0.1 ? " ok" : "")
      }, "Total ", sum.toFixed(sum % 1 === 0 ? 0 : 1), "%") : null),
    clean.length && Math.abs(sum - 100) >= 0.1 ? React.createElement("div", { className: "form-help" },
      "Weights are applied relative to one another, so they needn't add up to exactly 100%.") : null
  );
}

// Dedicated "edit just the sector allocation" modal for one instrument, opened
// from the sector-breakdown popup. Edits the shared pb.sectorWeights map (keyed
// by MARKET:TICKER) so the change applies to that fund everywhere it's held.
function SectorAllocationModal({ ticker, market, name, initialWeights, onClose, onSave }) {
  const { Icon, useBodyScrollLock } = window.PBApp;
  const [rows, setRows] = useState(() =>
    Array.isArray(initialWeights) && initialWeights.length
      ? initialWeights.map(w => ({ sector: w.sector || '', weight: w.weight != null ? String(w.weight) : '' }))
      : [{ sector: '', weight: '' }]);
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  const save = () => {
    const clean = rows.map(r => ({ sector: r.sector, weight: parseFloat(r.weight) })).filter(r => r.sector && isFinite(r.weight) && r.weight > 0);
    onSave(clean.length ? clean : null);
    onClose();
  };
  return React.createElement("div", { className: "modal" },
    React.createElement("div", { className: "modal-backdrop", onClick: onClose }),
    React.createElement("div", { className: "modal-panel", ref: panelRef, style: { maxWidth: 480 } },
      React.createElement("div", { className: "modal-handle" }),
      React.createElement("div", { className: "modal-header" },
        React.createElement("div", null,
          React.createElement("div", { className: "modal-title" }, "Sector allocation"),
          React.createElement("div", { className: "modal-subtitle" }, ticker, name && name !== ticker ? " · " + name : "")),
        React.createElement("button", { className: "modal-close", onClick: onClose, "aria-label": "Close" },
          React.createElement(Icon, { name: "x" }))),
      React.createElement("div", { className: "modal-body" },
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Sector breakdown (ETFs & funds)"),
          React.createElement(SectorWeightRows, { rows: rows, setRows: setRows })),
        React.createElement("div", { className: "form-actions" },
          React.createElement("button", { className: "btn btn-secondary", onClick: onClose }, "Cancel"),
          React.createElement("button", { className: "btn btn-primary", onClick: save }, "Save allocation")))));
}
// Sector detail popup (moved from app.js, Phase 4 inc 12) — heatmap sector card:
// stats strip, relative-size bar, multi-window trend, contained zoom heatmap.
function SectorDetailModal({ sectorName, rows, exchangeLabel, onClose, onOpenDetail }) {
  const { Icon, useBodyScrollLock } = window.PBApp;
  const { ZoomPanHeatmap } = window.PBViews;
  const [trend, setTrend] = useState(null);
  const [trendLoading, setTrendLoading] = useState(true);
  const [closing, setClosing] = useState(false);

  const close = useCallback(() => {
    setClosing(true);
    setTimeout(onClose, 240);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    setTrendLoading(true);
    setTrend(null);
    fetchSectorTrend(sectorName).then(t => { if (alive) { setTrend(t); setTrendLoading(false); } });
    return () => { alive = false; };
  }, [sectorName]);

  useBodyScrollLock();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [close]);

  // Relative size: this sector's market-cap weight vs every other sector on the
  // same heatmap, plus its rank, so the user can gauge how big it is.
  const sizeCtx = useMemo(() => {
    const agg = {};
    let total = 0;
    rows.forEach(r => {
      const v = r.value || 0;
      agg[r.sector] = (agg[r.sector] || 0) + v;
      total += v;
    });
    const list = Object.entries(agg).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
    const rank = list.findIndex(s => s.name === sectorName) + 1;
    const me = list.find(s => s.name === sectorName);
    const largest = list.length ? list[0].value : 0;
    return {
      total, count: list.length, rank,
      value: me ? me.value : 0,
      share: total > 0 && me ? me.value / total * 100 : 0,
      relToLargest: largest > 0 && me ? me.value / largest * 100 : 0,
      top: list.slice(0, 6),
    };
  }, [rows, sectorName]);

  const sectorRows = useMemo(() => rows.filter(r => r.sector === sectorName), [rows, sectorName]);
  const dataRows = sectorRows.filter(r => r.changePct != null && isFinite(r.changePct));
  const up = dataRows.filter(r => r.changePct > 0).length;
  const down = dataRows.filter(r => r.changePct < 0).length;
  const totalVal = dataRows.reduce((s, r) => s + r.value, 0);
  const dayAvg = totalVal > 0 ? dataRows.reduce((s, r) => s + r.changePct * r.value, 0) / totalVal : 0;

  const trendRow = trend && trend.trends
    ? React.createElement("div", { className: "sector-trend-grid" },
        trend.trends.map(t => React.createElement("div", { key: t.key, className: "sector-trend-cell" },
          React.createElement("div", { className: "sector-trend-key" }, t.key),
          React.createElement("div", {
            className: "sector-trend-val " + (t.pct == null ? 'flat' : t.pct >= 0 ? 'up' : 'down')
          }, t.pct == null ? '—' : (t.pct >= 0 ? '+' : '') + t.pct.toFixed(1) + '%')
        )))
    : (trendLoading
        ? React.createElement("div", { className: "sector-trend-loading" }, "Loading sector trend…")
        : React.createElement("div", { className: "sector-trend-loading" },
            trend && trend.unsupported ? "No trend proxy for this sector." : "Sector trend unavailable right now."));

  return React.createElement("div", { className: "sector-modal" + (closing ? " closing" : "") },
    React.createElement("div", { className: "sector-modal-backdrop", onClick: close }),
    React.createElement("div", { className: "sector-modal-panel", role: "dialog", "aria-label": sectorName + " sector" },
      React.createElement("div", { className: "sector-modal-header" },
        React.createElement("div", { className: "sector-modal-titles" },
          React.createElement("div", { className: "sector-modal-title" }, sectorName),
          React.createElement("div", { className: "sector-modal-sub" },
            exchangeLabel ? exchangeLabel + " · " : "",
            sectorRows.length, " companies",
            trend && trend.etf ? React.createElement("span", { className: "sector-proxy-tag" }, " proxy ", trend.etf) : null)),
        React.createElement("button", { className: "modal-close", onClick: close, "aria-label": "Close" },
          React.createElement(Icon, { name: "x" }))),

      React.createElement("div", { className: "sector-modal-body" },
        // Snapshot stat strip
        React.createElement("div", { className: "sector-stat-strip" },
          React.createElement("div", { className: "sector-stat" },
            React.createElement("div", { className: "sector-stat-label" }, "Today"),
            React.createElement("div", { className: "sector-stat-val " + (dayAvg >= 0 ? 'up' : 'down') },
              (dayAvg >= 0 ? '+' : '') + dayAvg.toFixed(2) + '%')),
          React.createElement("div", { className: "sector-stat" },
            React.createElement("div", { className: "sector-stat-label" }, "Breadth"),
            React.createElement("div", { className: "sector-stat-val" },
              React.createElement("span", { className: "stat-up" }, "▲", up),
              " ",
              React.createElement("span", { className: "stat-down" }, "▼", down))),
          React.createElement("div", { className: "sector-stat" },
            React.createElement("div", { className: "sector-stat-label" }, "Weight"),
            React.createElement("div", { className: "sector-stat-val" }, sizeCtx.share.toFixed(1) + '%')),
          React.createElement("div", { className: "sector-stat" },
            React.createElement("div", { className: "sector-stat-label" }, "Size rank"),
            React.createElement("div", { className: "sector-stat-val" }, sizeCtx.rank > 0 ? '#' + sizeCtx.rank + ' / ' + sizeCtx.count : '—'))),

        // Relative-size bar vs the biggest sector
        React.createElement("div", { className: "sector-size-block" },
          React.createElement("div", { className: "sector-size-head" },
            React.createElement("span", null, "Size vs largest sector"),
            React.createElement("span", { className: "text-dim" }, sizeCtx.relToLargest.toFixed(0) + '%')),
          React.createElement("div", { className: "sector-size-track" },
            React.createElement("div", { className: "sector-size-fill", style: { width: Math.max(2, Math.min(100, sizeCtx.relToLargest)) + '%' } }))),

        // Multi-horizon trend
        React.createElement("div", { className: "sector-trend-block" },
          React.createElement("div", { className: "sector-section-label" }, "Sector trend",
            trend && trend.name ? React.createElement("span", { className: "text-dim" }, " · ", trend.name) : null),
          trendRow,
          React.createElement("div", { className: "sector-trend-note" }, "Total return of the sector's proxy ETF over each window.")),

        // Focused heatmap of just this sector — pinch / scroll / double-tap to
        // zoom and drag to pan, exactly like the big heatmap, but contained.
        React.createElement("div", { className: "sector-heat-block" },
          React.createElement("div", { className: "sector-section-label" }, "Companies",
            React.createElement("span", { className: "text-dim" }, " · pinch / scroll to zoom, drag to pan")),
          sectorRows.length > 0
            ? React.createElement("div", { className: "sector-zoom-wrap" },
                React.createElement(ZoomPanHeatmap, {
                  rows: sectorRows,
                  loading: false,
                  lockScroll: false,
                  stageClass: "sector-zoom-stage",
                  contentClass: "heatmap-fs-content",
                  // Keep the sector popup mounted underneath so closing the
                  // stock card returns the user to the sector exactly where they
                  // left off. The stock card (z-index 95) layers above it.
                  onOpenDetail: (tk, mk) => { onOpenDetail && onOpenDetail(tk, mk); }
                }))
            : React.createElement("div", { className: "text-dim text-sm" }, "No live data for this sector yet.")))));
}
// Log a single deposit / withdrawal (moved from app.js, Phase 4 inc 13). Display-only:
// deposit/withdraw toggle, currency, amount, optional locked USD-landed rate; delegates
// the money math to the parent via onSave.
function ContributionModal({ onClose, onSave, onOpenImport }) {
  const { Icon, useBodyScrollLock, sanitizeDecimalInput } = window.PBApp;
  const [flow, setFlow] = useState('deposit'); // 'deposit' | 'withdraw'
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [usdLanded, setUsdLanded] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  const isWithdraw = flow === 'withdraw';
  // The "USD landed" field only makes sense for a non-USD deposit funding a USD
  // account (e.g. ZAR → USD). Hidden otherwise.
  const showLanded = !isWithdraw && currency !== 'USD';
  const submit = () => {
    const a = parseDecimal(amount);
    if (!isFinite(a) || a <= 0) return;
    // Withdrawals are stored as negative cash flows so the contribution history
    // and overall-return maths net them out automatically.
    onSave(isWithdraw ? -a : a, currency, date, note, showLanded ? usdLanded : '');
  };
  const ccy = currency === 'ZAR' ? 'R' : '$';
  return React.createElement("div", { className: "modal" },
    React.createElement("div", { className: "modal-backdrop", onClick: onClose }),
    React.createElement("div", { className: "modal-panel", style: { maxWidth: 520 }, ref: panelRef },
      React.createElement("div", { className: "modal-handle" }),
      React.createElement("div", { className: "modal-header" },
        React.createElement("div", null,
          React.createElement("div", { className: "modal-title" }, isWithdraw ? "Log withdrawal" : "Log deposit"),
          React.createElement("div", { className: "modal-subtitle" }, isWithdraw ? "Record cash taken out of your portfolio" : "Record cash deposited from outside your portfolio")
        ),
        React.createElement("button", { className: "modal-close", onClick: onClose, "aria-label": "Close" },
          React.createElement(Icon, { name: "x" })
        )
      ),
      React.createElement("div", { className: "modal-body" },
        React.createElement("div", { className: "flow-toggle" },
          React.createElement("button", {
            type: "button", className: "flow-toggle-btn" + (!isWithdraw ? " active deposit" : ""),
            onClick: () => setFlow('deposit')
          }, React.createElement(Icon, { name: "plus", size: 12 }), "Deposit"),
          React.createElement("button", {
            type: "button", className: "flow-toggle-btn" + (isWithdraw ? " active withdraw" : ""),
            onClick: () => setFlow('withdraw')
          }, React.createElement(Icon, { name: "minus", size: 12 }), "Withdrawal")
        ),
        onOpenImport ? React.createElement("button", {
          className: "contrib-import-link", type: "button",
          onClick: () => { onClose(); onOpenImport(); }
        }, React.createElement(Icon, { name: "download", size: 12 }), "Import deposits & withdrawals from a file or list") : null,
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Currency"),
          React.createElement("select", { value: currency, onChange: e => setCurrency(e.target.value) },
            React.createElement("option", { value: "USD" }, "USD ($)"),
            React.createElement("option", { value: "ZAR" }, "ZAR (R)"),
            React.createElement("option", { value: "GBP" }, "GBP (\u00a3)"),
            React.createElement("option", { value: "AUD" }, "AUD (A$)"),
            React.createElement("option", { value: "EUR" }, "EUR (\u20ac)")
          )
        ),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, isWithdraw ? "Amount" : "Amount transferred"),
          React.createElement("div", { className: "input-prefix-wrap" },
            React.createElement("span", { className: "prefix" }, ccy),
            React.createElement("input", {
              type: "text", inputMode: "decimal",
              autoComplete: "off", autoCorrect: "off", spellCheck: false,
              placeholder: "0.00", value: amount,
              onChange: e => setAmount(sanitizeDecimalInput(e.target.value)),
              autoFocus: true,
              onKeyDown: e => { if (e.key === 'Enter') submit(); }
            })
          )
        ),
        showLanded ? React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "USD landed in account"),
          React.createElement("div", { className: "input-prefix-wrap" },
            React.createElement("span", { className: "prefix" }, "$"),
            React.createElement("input", {
              type: "text", inputMode: "decimal",
              autoComplete: "off", autoCorrect: "off", spellCheck: false,
              placeholder: "0.00", value: usdLanded,
              onChange: e => setUsdLanded(sanitizeDecimalInput(e.target.value)),
              onKeyDown: e => { if (e.key === 'Enter') submit(); }
            })
          ),
          React.createElement("div", { className: "text-dim", style: { fontSize: 12, marginTop: 6, lineHeight: 1.4 } },
            "Optional — the dollars that actually arrived after conversion & fees. Locks in the real rate so overall profit compares what you put in to what you hold now.")
        ) : null,
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Date"),
          React.createElement("input", { type: "date", value: date, onChange: e => setDate(e.target.value) })
        ),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Note (optional)"),
          React.createElement("input", {
            type: "text", placeholder: "e.g. Monthly DCA, bonus deposit",
            value: note, onChange: e => setNote(e.target.value), maxLength: 100
          })
        ),
        React.createElement("div", { className: "form-actions" },
          React.createElement("button", { className: "btn btn-ghost", onClick: onClose }, "Cancel"),
          React.createElement("button", { className: "btn btn-primary", onClick: submit }, isWithdraw ? "Add withdrawal" : "Add deposit")
        )
      )
    )
  );
}
// Import a batch of deposits / withdrawals from pasted text or a CSV/XLSX file.
// Two stages: paste/drop → an editable review table where each dated amount can
// be flipped between deposit and withdrawal and re-currencied before committing.
function ContributionImportModal({ onClose, onImport }) {
  const { Icon, useBodyScrollLock, sanitizeDecimalInput, uid, parseCashFlowsFromText, parseCashFlowFile } = window.PBApp;
  const [stage, setStage] = useState('input'); // 'input' | 'review'
  const [rows, setRows] = useState([]);
  const [pasteText, setPasteText] = useState('');
  const [parseError, setParseError] = useState('');
  const [parsing, setParsing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [defaultCurrency, setDefaultCurrency] = useState('USD');
  const fileRef = useRef(null);
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, () => { if (stage === 'input') onClose(); });
  useBodyScrollLock();

  const toRows = (flows) => flows.map(f => ({
    id: uid(),
    date: f.date || '',
    amount: f.amount != null ? String(Math.abs(f.amount)) : '',
    type: ((f.amount != null && f.amount < 0) || f.type === 'withdrawal') ? 'withdrawal' : 'deposit',
    currency: f.currency || defaultCurrency,
    note: f.note || '',
    include: true
  }));
  const handleParsed = (flows) => {
    if (!flows || flows.length === 0) {
      setParseError("Couldn't find any dated amounts. Paste rows like “2026-01-15, 1000” or “15 Jan 2026, 500, withdrawal”.");
      return;
    }
    setRows(toRows(flows));
    setStage('review');
    setParseError('');
  };
  const handlePaste = () => {
    if (!pasteText.trim()) return;
    setParsing(true); setParseError('');
    try { handleParsed(parseCashFlowsFromText(pasteText)); }
    catch (e) { setParseError('Could not parse that text.'); }
    finally { setParsing(false); }
  };
  const handleFiles = async (files) => {
    const file = files && files[0];
    if (!file) return;
    setParsing(true); setParseError('');
    try { handleParsed(await parseCashFlowFile(file)); }
    catch (e) { setParseError(e?.message || 'Could not read that file. Try CSV, XLSX, or paste the rows instead.'); }
    finally { setParsing(false); }
  };

  const updateRow = (id, patch) => setRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
  const removeRow = (id) => setRows(prev => prev.filter(r => r.id !== id));
  const rowValid = (r) => r.include && r.date && isFinite(parseDecimal(r.amount)) && parseDecimal(r.amount) > 0;
  const validRows = rows.filter(rowValid);
  const sym = (c) => CURRENCY_SYMBOLS[c] || '';
  const deposits = validRows.filter(r => r.type === 'deposit');
  const withdrawals = validRows.filter(r => r.type === 'withdrawal');

  const doImport = () => {
    const entries = validRows.map(r => ({
      amount: (r.type === 'withdrawal' ? -1 : 1) * Math.abs(parseDecimal(r.amount)),
      currency: r.currency, date: r.date, note: r.note
    }));
    if (entries.length === 0) return;
    onImport(entries);
    onClose();
  };

  const CCYS = ['USD', 'ZAR', 'GBP', 'AUD', 'EUR'];
  const inputStage = React.createElement(React.Fragment, null,
    React.createElement("div", { className: "import-market-pick" },
      React.createElement("div", { className: "form-label" }, "Default currency"),
      React.createElement("div", { className: "import-bulk-chips" },
        CCYS.map(c => React.createElement("button", {
          key: c, type: "button",
          className: "import-bulk-chip" + (defaultCurrency === c ? " active" : ""),
          onClick: () => setDefaultCurrency(c)
        }, c, React.createElement("span", { className: "import-chip-sym" }, CURRENCY_SYMBOLS[c] || '')))),
      React.createElement("div", { className: "form-help" }, "Applied to any pasted row that doesn't name its own currency — you can change any row in the next step.")),
    React.createElement("div", {
      className: "import-drop" + (dragOver ? " over" : ""),
      onClick: () => fileRef.current && fileRef.current.click(),
      onDragOver: e => { e.preventDefault(); setDragOver(true); },
      onDragLeave: () => setDragOver(false),
      onDrop: e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }
    },
      React.createElement(Icon, { name: parsing ? "refresh" : "download", size: 24, className: parsing ? "spin" : "" }),
      React.createElement("div", { className: "import-drop-title" }, parsing ? "Reading…" : "Drop a CSV or Excel file, or tap to browse"),
      React.createElement("div", { className: "import-drop-sub" }, "Columns in any order: date · amount · type · currency · note"),
      React.createElement("input", {
        ref: fileRef, type: "file", accept: ".csv,.tsv,.txt,.xlsx,.xls", style: { display: 'none' },
        onChange: e => { handleFiles(e.target.files); e.target.value = ''; }
      })),
    React.createElement("div", { className: "import-or" }, React.createElement("span", null, "or paste rows")),
    React.createElement("textarea", {
      className: "import-paste", value: pasteText, placeholder: "2026-01-15, 1000, deposit, Monthly DCA\n2026-02-20, 500, withdrawal\n15 Mar 2026, R2 500, deposit",
      onChange: e => setPasteText(e.target.value), rows: 5
    }),
    parseError ? React.createElement("div", { className: "verify-error", style: { marginTop: 10 } }, parseError) : null,
    React.createElement("div", { className: "form-actions", style: { marginTop: 4 } },
      React.createElement("button", { className: "btn btn-secondary", onClick: onClose }, "Cancel"),
      React.createElement("button", { className: "btn btn-primary", onClick: handlePaste, disabled: parsing || !pasteText.trim() }, parsing ? "Reading…" : "Review")));

  const reviewStage = React.createElement(React.Fragment, null,
    React.createElement("div", { className: "cfi-summary" },
      React.createElement("span", null, validRows.length, " of ", rows.length, " ready"),
      React.createElement("span", { className: "cfi-summary-sep" }, "·"),
      React.createElement("span", { className: "up" }, deposits.length, " deposit", deposits.length === 1 ? "" : "s"),
      React.createElement("span", { className: "cfi-summary-sep" }, "·"),
      React.createElement("span", { className: "down" }, withdrawals.length, " withdrawal", withdrawals.length === 1 ? "" : "s")),
    React.createElement("div", { className: "cfi-list" },
      rows.map(r => React.createElement("div", { className: "cfi-row" + (r.include ? "" : " excluded") + (r.include && !rowValid(r) ? " invalid" : ""), key: r.id },
        React.createElement("div", { className: "cfi-row-head" },
          React.createElement("button", {
            className: "cfi-type-toggle " + r.type, type: "button",
            onClick: () => updateRow(r.id, { type: r.type === 'withdrawal' ? 'deposit' : 'withdrawal' }),
            title: "Toggle deposit / withdrawal"
          }, React.createElement(Icon, { name: r.type === 'withdrawal' ? 'minus' : 'plus', size: 11 }), r.type === 'withdrawal' ? 'Out' : 'In'),
          React.createElement("input", { className: "cfi-date", type: "date", value: r.date, onChange: e => updateRow(r.id, { date: e.target.value }) }),
          React.createElement("button", { className: "cfi-remove", onClick: () => removeRow(r.id), "aria-label": "Remove" }, React.createElement(Icon, { name: "x", size: 12 }))),
        React.createElement("div", { className: "cfi-row-body" },
          React.createElement("div", { className: "cfi-amount-wrap" },
            React.createElement("span", { className: "cfi-amount-sym" }, sym(r.currency)),
            React.createElement("input", {
              className: "cfi-amount", type: "text", inputMode: "decimal", value: r.amount, placeholder: "0.00",
              onChange: e => updateRow(r.id, { amount: sanitizeDecimalInput(e.target.value) })
            })),
          React.createElement("select", { className: "cfi-ccy", value: r.currency, onChange: e => updateRow(r.id, { currency: e.target.value }) },
            CCYS.map(c => React.createElement("option", { key: c, value: c }, c))),
          React.createElement("input", { className: "cfi-note", type: "text", value: r.note, placeholder: "Note", maxLength: 100, onChange: e => updateRow(r.id, { note: e.target.value }) })))),
    ),
    React.createElement("div", { className: "form-actions" },
      React.createElement("button", { className: "btn btn-secondary", onClick: () => setStage('input') }, "Back"),
      React.createElement("button", { className: "btn btn-primary", onClick: doImport, disabled: validRows.length === 0 },
        "Import ", validRows.length, " ", validRows.length === 1 ? "entry" : "entries")));

  return React.createElement("div", { className: "modal" },
    React.createElement("div", { className: "modal-backdrop", onClick: () => { if (stage === 'input') onClose(); } }),
    React.createElement("div", { className: "modal-panel", style: { maxWidth: 520 }, ref: panelRef },
      React.createElement("div", { className: "modal-handle" }),
      React.createElement("div", { className: "modal-header" },
        React.createElement("div", null,
          React.createElement("div", { className: "modal-title" }, "Import deposits & withdrawals"),
          React.createElement("div", { className: "modal-subtitle" }, stage === 'input' ? "Paste a list or drop a file — amounts and dates" : "Check each row, flip deposits/withdrawals, then import")),
        React.createElement("button", { className: "modal-close", onClick: onClose, "aria-label": "Close" }, React.createElement(Icon, { name: "x" }))),
      React.createElement("div", { className: "modal-body" }, stage === 'input' ? inputStage : reviewStage)));
}
// --- Settings dialog + its tab-reorder sub-component (Phase 4 inc-17, moved from app.js) ---
// SettingsModal + TabReorderList (single-caller). Display + delegate only; mutations are props.
function TabReorderList({ tabOrder, hiddenTabs, onToggleHidden }) {
  const { Icon, TAB_ALWAYS_VISIBLE, TAB_LABELS } = window.PBApp;
  const [order, setOrder] = useState(tabOrder);
  const [dragKey, setDragKey] = useState(null);
  const orderRef = useRef(order);
  orderRef.current = order;
  const draggingRef = useRef(false);
  const dragRef = useRef(null);
  const rowEls = useRef(new Map());
  const prevTops = useRef(new Map());

  // Re-sync when the parent order changes and we're not mid-drag.
  useEffect(() => { if (!draggingRef.current) setOrder(tabOrder); }, [tabOrder]);

  // The lifted row's transform: stay glued to the finger and keep a subtle lift
  // scale (matching the .is-dragging CSS, which the inline transform overrides).
  const liftTransform = (y) => `translateY(${y}px) scale(1.02)`;

  // FLIP after each reorder commit. Non-dragged rows animate from their captured
  // positions to the new layout; the dragged row is silently re-glued to the
  // finger from its NEW slot (pre-paint, so there's no one-frame back-jump).
  useLayoutEffect(() => {
    const prev = prevTops.current;
    if (!prev.size) return;
    const d = dragRef.current;
    rowEls.current.forEach((el, key) => {
      if (!el) return;
      if (key === dragKey) {
        if (!d) return;
        el.style.transition = 'none';
        el.style.transform = '';
        const top = el.getBoundingClientRect().top;
        d.naturalTop = top;
        el.style.transform = liftTransform(d.pointerY - d.grabOffset - top);
        return;
      }
      const before = prev.get(key);
      if (before == null) return;
      const after = el.getBoundingClientRect().top;
      const dy = before - after;
      if (!dy) return;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      void el.offsetHeight; // force reflow so the next change animates
      el.style.transition = 'transform 0.24s cubic-bezier(0.22,1,0.36,1)';
      el.style.transform = '';
    });
    prev.clear();
  }, [order, dragKey]);

  const captureTops = () => {
    const m = prevTops.current; m.clear();
    rowEls.current.forEach((el, key) => { if (el) m.set(key, el.getBoundingClientRect().top); });
  };

  const onHandleDown = (e, key) => {
    if (e.button != null && e.button !== 0) return;
    const el = rowEls.current.get(key);
    if (!el) return;
    e.preventDefault();
    draggingRef.current = true;
    const rect = el.getBoundingClientRect();
    const stride = el.offsetHeight + 8; // row height + list gap
    // Track a synchronous working copy + index so the gesture stays correct even
    // before React commits the reorder (setState is batched/async). grabOffset is
    // where the finger sits within the row; naturalTop is the top of its current
    // slot — together they keep the lifted row pinned to the finger.
    const work = orderRef.current.slice();
    dragRef.current = {
      key, stride, idx: work.indexOf(key), work,
      grabOffset: e.clientY - rect.top, naturalTop: rect.top, pointerY: e.clientY
    };
    el.style.transition = 'none';
    setDragKey(key);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_e) {}
  };
  const onHandleMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    d.pointerY = e.clientY;
    const el = rowEls.current.get(d.key);
    // Glue the lifted row to the finger relative to its current slot.
    if (el) el.style.transform = liftTransform(d.pointerY - d.grabOffset - d.naturalTop);
    // Slots crossed from the current natural slot. The layout effect re-measures
    // naturalTop after the commit, so multi-slot fast drags settle correctly.
    const displacement = (d.pointerY - d.grabOffset) - d.naturalTop;
    const steps = Math.round(displacement / d.stride);
    if (steps !== 0) {
      const target = Math.max(0, Math.min(d.work.length - 1, d.idx + steps));
      if (target !== d.idx) {
        captureTops();
        d.work.splice(target, 0, d.work.splice(d.idx, 1)[0]);
        d.idx = target;
        setOrder(d.work.slice());
      }
    }
  };
  const endDrag = () => {
    const d = dragRef.current;
    if (!d) { draggingRef.current = false; setDragKey(null); return; }
    const el = rowEls.current.get(d.key);
    if (el) {
      el.style.transition = 'transform 0.26s cubic-bezier(0.22,1,0.36,1)';
      el.style.transform = '';
      const clear = () => { el.style.transition = ''; };
      el.addEventListener('transitionend', clear, { once: true });
      setTimeout(clear, 340);
    }
    const finalOrder = d.work;
    dragRef.current = null;
    draggingRef.current = false;
    setDragKey(null);
    PBStore.setSetting('tabOrder', finalOrder);
  };

  return React.createElement("div", { className: "tab-config-list" + (dragKey ? " dragging" : "") },
    order.map((key) => {
      const hidden = (hiddenTabs || []).includes(key) && key !== TAB_ALWAYS_VISIBLE;
      const pinned = key === TAB_ALWAYS_VISIBLE;
      return React.createElement("div", {
        key: key,
        ref: el => { if (el) rowEls.current.set(key, el); else rowEls.current.delete(key); },
        className: "tab-config-row" + (hidden ? " is-hidden" : "") + (dragKey === key ? " is-dragging" : "")
      },
        React.createElement("button", {
          className: "tab-config-grip", type: "button", "aria-label": "Drag to reorder",
          onPointerDown: e => onHandleDown(e, key),
          onPointerMove: onHandleMove,
          onPointerUp: endDrag,
          onPointerCancel: endDrag
        }, React.createElement(Icon, { name: "grip", size: 18 })),
        React.createElement("span", { className: "tab-config-name" }, TAB_LABELS[key] || key),
        pinned
          ? React.createElement("span", { className: "tab-config-pin" }, "Always on")
          : React.createElement("button", {
              className: "tab-config-toggle" + (hidden ? "" : " on"), type: "button",
              "aria-label": hidden ? "Show tab" : "Hide tab", onClick: () => onToggleHidden(key)
            }, React.createElement(Icon, { name: hidden ? "eye-off" : "eye", size: 15 })));
    })
  );
}

// ─── Viewport diagnostics ────────────────────────────────────────────────────
// Reads what the DEVICE actually thinks the viewport is, because Chrome cannot
// tell us. The stock card stops ~0.5cm short of the bottom of the glass on Jan's
// installed iOS PWA; two structurally different CSS approaches to the sheet's
// bottom edge (PR #64: `.modal { inset: 0 }` vs an explicit
// `height: max(100vh, 100dvh, 100lvh)`) both move the box measurably in a real
// browser and produced the SAME result on the phone. Headless Chrome reports
// every env(safe-area-inset-*) as 0, so the gap has never once reproduced here.
// Rather than guess a third time, measure.
//
// Everything below is read-only and stateless: no pb.* key, no LS access, no
// network. Probes are appended, measured in the same frame and removed.
function collectViewportDiagnostics() {
  const out = { at: new Date().toISOString() };
  const round = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
  const probes = [];
  const mk = (css) => {
    const el = document.createElement('div');
    // visibility:hidden, NOT display:none — a display-none box has no geometry
    // at all, so it would measure 0 and tell us nothing.
    el.style.cssText = 'visibility:hidden;pointer-events:none;position:absolute;top:0;left:0;width:1px;' + css;
    document.body.appendChild(el);
    probes.push(el);
    return el;
  };
  try {
    const de = document.documentElement;
    const cs = getComputedStyle(de);
    const scr = window.screen || {};
    out.screen = { w: round(scr.width), h: round(scr.height), avail: round(scr.availHeight), dpr: window.devicePixelRatio };
    out.layout = { innerW: round(window.innerWidth), innerH: round(window.innerHeight), clientH: round(de.clientHeight), clientW: round(de.clientWidth) };
    // Where the web view sits ON the screen. Load-bearing: a view that is 62px
    // short and anchored at the top is broken, while the same 62px-short view
    // offset 62px DOWN reaches the glass and is correct. `screen.height - innerH`
    // cannot tell those apart — it reads 62 for both — so the offset is the only
    // thing that distinguishes a fix from a failure.
    const sy = (typeof window.screenY === 'number') ? window.screenY
             : (typeof window.screenTop === 'number') ? window.screenTop : null;
    out.viewOffset = {
      screenY: sy == null ? null : round(sy),
      outerW: round(window.outerWidth), outerH: round(window.outerHeight)
    };
    const vv = window.visualViewport;
    out.visual = vv
      ? { w: round(vv.width), h: round(vv.height), offsetTop: round(vv.offsetTop), pageTop: round(vv.pageTop), scale: round(vv.scale) }
      : null;
    out.safeArea = {
      top: cs.getPropertyValue('--safe-top').trim() || '(unset)',
      bottom: cs.getPropertyValue('--safe-bottom').trim() || '(unset)',
      left: cs.getPropertyValue('--safe-left').trim() || '(unset)',
      right: cs.getPropertyValue('--safe-right').trim() || '(unset)'
    };
    // What does the device resolve each viewport unit to? This is the reading no
    // amount of reasoning from a desktop browser can substitute for.
    out.units = {};
    ['100vh', '100dvh', '100svh', '100lvh'].forEach(u => {
      const el = mk('height:' + u + ';');
      out.units[u] = round(el.getBoundingClientRect().height);
    });
    // A bare fixed overlay: does `position: fixed; inset: 0` reach the bottom?
    const fx = mk('position:fixed;inset:0;width:auto;height:auto;');
    const fr = fx.getBoundingClientRect();
    out.fixedProbe = { top: round(fr.top), bottom: round(fr.bottom), height: round(fr.height) };
    // The decisive ones: REAL sheets, run through the REAL cascade — the
    // standalone media query, the .pb-standalone class, .modal-panel's height,
    // all of it — measured where they actually land. Animation is disabled or we
    // would catch them mid slide-up transform.
    //
    // TWO probes, because they exercise different declarations. The plain panel
    // takes `height: calc(100% - 48px)`; the stock card takes `height: auto` +
    // `max-height`, and with an EMPTY body it just hugs 33px and would sit at the
    // bottom no matter how badly the height maths were broken. The tall filler is
    // what forces it against its ceiling, which is the state Jan is looking at.
    const mkSheet = (cls, fillerPx) => {
      const shell = document.createElement('div');
      shell.className = 'modal';
      shell.setAttribute('aria-hidden', 'true');
      shell.style.cssText = 'visibility:hidden;pointer-events:none;animation:none;';
      const panel = document.createElement('div');
      panel.className = cls;
      panel.style.animation = 'none';
      const body = document.createElement('div');
      body.className = 'modal-body';
      if (fillerPx) {
        const filler = document.createElement('div');
        filler.style.height = fillerPx + 'px';
        body.appendChild(filler);
      }
      panel.appendChild(body);
      shell.appendChild(panel);
      document.body.appendChild(shell);
      probes.push(shell);
      const mr = shell.getBoundingClientRect(), pr = panel.getBoundingClientRect();
      return {
        modalTop: round(mr.top), modalBottom: round(mr.bottom), modalHeight: round(mr.height),
        panelTop: round(pr.top), panelBottom: round(pr.bottom), panelHeight: round(pr.height),
        bodyPadBottom: getComputedStyle(body).paddingBottom
      };
    };
    out.sheetProbe = mkSheet('modal-panel', 0);
    out.cardProbe = mkSheet('modal-panel stock-detail-panel', 4000);
    out.mode = {
      standaloneQuery: !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches),
      navigatorStandalone: !!window.navigator.standalone,
      rootHasClass: de.classList.contains('pb-standalone'),
      ua: (navigator.userAgent || '').slice(0, 160)
    };
    // BUILD STAMP — what this page is ACTUALLY running, read live from the DOM.
    // Without it, "the meta did not take effect" and "the app is still booting an
    // old index.html" look identical from the outside, and they need completely
    // different fixes. iOS also captures the status-bar style when the icon is
    // added to the home screen and does not re-read it on launch, so the shipped
    // value and the applied value can legitimately disagree.
    const metaOf = (name) => {
      const el = document.querySelector('meta[name="' + name + '"]');
      return el ? (el.getAttribute('content') || '(empty)') : '(absent)';
    };
    out.build = {
      statusBar: metaOf('apple-mobile-web-app-status-bar-style'),
      viewport: metaOf('viewport'),
      swController: (navigator.serviceWorker && navigator.serviceWorker.controller) ? 'active' : 'none'
    };
    // Verdicts. NOT simply "every row should be 0" — read them in this order:
    //   glassBelowView  the one that matters: physical screen left uncovered BELOW
    //                   the web view. Needs screenY, which iOS may report as 0, so
    //                   it is null rather than wrong when unavailable.
    //   viewportVsScreen  view height vs screen. Non-zero is only a BUG when the
    //                   view is also anchored at the top; a view that is short but
    //                   offset down by the same amount reaches the glass and is fine.
    //   sheet/cardVsScreen  same caveat — they inherit the view's offset.
    //   sheetVsFixed    purely internal, and must always be 0: it says the sheet
    //                   agrees with the overlay box, which is the app's own job.
    const screenH = out.screen.h;
    const offY = out.viewOffset.screenY;
    out.verdict = {
      glassBelowView: (screenH != null && offY != null) ? round(screenH - (offY + out.layout.innerH)) : null,
      viewportVsScreen: screenH != null ? round(screenH - out.layout.innerH) : null,
      fixedVsScreen: screenH != null ? round(screenH - out.fixedProbe.bottom) : null,
      sheetVsScreen: screenH != null ? round(screenH - out.sheetProbe.panelBottom) : null,
      cardVsScreen: screenH != null ? round(screenH - out.cardProbe.panelBottom) : null,
      sheetVsFixed: round(out.fixedProbe.bottom - out.sheetProbe.panelBottom)
    };
  } catch (e) {
    out.error = String(e && e.message || e);
  } finally {
    probes.forEach(el => { try { el.remove(); } catch (_e) {} });
  }
  return out;
}
// Flattens the object into the label/value rows the card renders and the text
// the Copy button puts on the clipboard — one shape, so what Jan pastes is
// exactly what he sees.
function diagnosticsRows(d, cacheName) {
  if (!d) return [];
  const rows = [];
  const push = (label, value) => rows.push({ label, value: String(value) });
  const px = (n) => (n == null ? '-' : n + 'px');
  if (d.error) push('ERROR', d.error);
  // Build stamp first: if this does not match what was shipped, every geometry
  // number below describes an old build and should not be reasoned about.
  if (d.build) {
    push('status-bar meta', d.build.statusBar);
    push('viewport meta', d.build.viewport);
    push('sw / cache', d.build.swController + ' / ' + (cacheName || '(reading)'));
  }
  if (d.verdict) {
    push('Glass below view', d.verdict.glassBelowView == null ? '(no screenY)' : px(d.verdict.glassBelowView));
    push('Viewport vs screen', px(d.verdict.viewportVsScreen));
    push('Fixed vs screen', px(d.verdict.fixedVsScreen));
    push('Sheet vs screen', px(d.verdict.sheetVsScreen));
    push('Stock card vs screen', px(d.verdict.cardVsScreen));
    push('Sheet vs fixed', px(d.verdict.sheetVsFixed));
  }
  if (d.screen) push('screen', d.screen.w + ' x ' + d.screen.h + ' @' + d.screen.dpr + 'x (avail ' + d.screen.avail + ')');
  if (d.layout) push('inner / client', d.layout.innerW + ' x ' + d.layout.innerH + ' / ' + d.layout.clientH);
  if (d.viewOffset) push('view offset / outer', (d.viewOffset.screenY == null ? 'screenY n/a' : 'screenY ' + d.viewOffset.screenY)
    + ' / ' + d.viewOffset.outerW + ' x ' + d.viewOffset.outerH);
  push('visualViewport', d.visual ? (d.visual.w + ' x ' + d.visual.h + ' top ' + d.visual.offsetTop + ' scale ' + d.visual.scale) : '(none)');
  if (d.safeArea) push('safe t/b/l/r', [d.safeArea.top, d.safeArea.bottom, d.safeArea.left, d.safeArea.right].join(' / '));
  if (d.units) Object.keys(d.units).forEach(u => push(u, px(d.units[u])));
  if (d.fixedProbe) push('fixed inset:0', 'top ' + d.fixedProbe.top + ' bottom ' + d.fixedProbe.bottom);
  if (d.sheetProbe) {
    push('.modal', 'top ' + d.sheetProbe.modalTop + ' bottom ' + d.sheetProbe.modalBottom + ' h ' + d.sheetProbe.modalHeight);
    push('.modal-panel', 'top ' + d.sheetProbe.panelTop + ' bottom ' + d.sheetProbe.panelBottom + ' h ' + d.sheetProbe.panelHeight);
    push('sheet pad-bottom', d.sheetProbe.bodyPadBottom);
  }
  if (d.cardProbe) {
    push('.stock-detail-panel', 'top ' + d.cardProbe.panelTop + ' bottom ' + d.cardProbe.panelBottom + ' h ' + d.cardProbe.panelHeight);
    push('card pad-bottom', d.cardProbe.bodyPadBottom);
  }
  if (d.mode) {
    push('standalone', 'query ' + d.mode.standaloneQuery + ' / nav ' + d.mode.navigatorStandalone + ' / class ' + d.mode.rootHasClass);
    push('UA', d.mode.ua);
  }
  push('measured at', d.at);
  return rows;
}

function SettingsModal({ fxRates, onRefreshFx,
                        positions, contributions, onExport, onImport, cloudBackup, onDeleteHoldings,
                        tabOrder, hiddenTabs,
                        pushStatus, onConnectPush, onTestPush, onDisconnectPush, onClose }) {
  const { Icon, fmt, useBodyScrollLock, computeFxSnapshot, formatCode, normalizeCode, positionDisplayName, DEFAULT_TAB_ORDER, MARKET_LABELS, TAB_ALWAYS_VISIBLE } = window.PBApp;
  const prices = PBStore.usePricesMap();
  // Settings edited here are read/written directly on the store (no prop-drilling).
  const displayCurrency = PBStore.useSetting('displayCurrency');
  const ribbonItems = PBStore.useSetting('ribbonItems');
  const ribbonMode = PBStore.useSetting('ribbonMode');
  const perplexityKey = PBStore.useSetting('perplexityKey');
  const pushBackend = PBStore.useSetting('pushBackend');
  const iconTheme = PBStore.useSetting('iconTheme');
  const theme = PBStore.useSetting('theme');
  const donutPalette = PBStore.useSetting('donutPalette');
  const donutTopN = PBStore.useSetting('donutTopN');
  const previewMode = PBStore.useSetting('previewMode');
  const [refreshing, setRefreshing] = useState(false);
  const [activeSection, setActiveSection] = useState('display');
  const [selectedDel, setSelectedDel] = useState(() => new Set());
  const [confirmDel, setConfirmDel] = useState(false);
  const [pkDraft, setPkDraft] = useState(perplexityKey || '');
  const [pkReveal, setPkReveal] = useState(false);
  const [pushDraft, setPushDraft] = useState(pushBackend || '');
  const [restoreCode, setRestoreCode] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreErr, setRestoreErr] = useState('');
  const [codeCopied, setCodeCopied] = useState(false);
  const [codeReveal, setCodeReveal] = useState(false);
  const [diag, setDiag] = useState(null);
  const [diagCache, setDiagCache] = useState(null);
  const [diagCopied, setDiagCopied] = useState(false);
  const fileInputRef = useRef(null);
  const panelRef = useRef(null);
  // Settings is a centered dialog (premium app feel), not a swipe-down sheet,
  // so it doesn't use useSwipeDownToClose — close via the X or backdrop.
  useBodyScrollLock();
  useEffect(() => { setPkDraft(perplexityKey || ''); }, [perplexityKey]);
  useEffect(() => { setPushDraft(pushBackend || ''); }, [pushBackend]);
  // Measured on entry to the section, not on mount: the probes touch the DOM, so
  // they should only run when someone is actually looking at the readout.
  useEffect(() => {
    if (activeSection !== 'diagnostics') return;
    setDiagCopied(false);
    setDiag(collectViewportDiagnostics());
    // The cache name is the only async part of the build stamp, so it is read
    // separately rather than making the measurement itself async (the probes must
    // be appended, measured and removed inside one frame). `caches` is absent on
    // insecure origins and in some harness contexts — degrade, never throw.
    let alive = true;
    (async () => {
      let name = '(unavailable)';
      try {
        if (window.caches && caches.keys) {
          const keys = await caches.keys();
          name = keys.filter(k => k.startsWith('playbook-shell-')).join(', ') || '(none)';
        }
      } catch (_e) { name = '(error)'; }
      if (alive) setDiagCache(name);
    })();
    return () => { alive = false; };
  }, [activeSection]);
  const diagRows = useMemo(() => diagnosticsRows(diag, diagCache), [diag, diagCache]);
  const diagText = useMemo(
    () => diagRows.map(r => r.label + ': ' + r.value).join('\n'),
    [diagRows]
  );
  const copyDiag = async () => {
    try {
      await navigator.clipboard.writeText(diagText);
      setDiagCopied(true);
      setTimeout(() => setDiagCopied(false), 2000);
    } catch (_e) { setDiagCopied(false); }
  };
  const snap = useMemo(
    () => computeFxSnapshot({ positions, contributions, prices, fxRates, displayCurrency }),
    [positions, contributions, prices, fxRates, displayCurrency]
  );
  const refresh = async () => {
    setRefreshing(true);
    try { await onRefreshFx(); } finally { setRefreshing(false); }
  };
  const rates = fxRates?.rates || {};
  // Connections (AI news + push) handlers
  const pkConfigured = !!perplexityKey;
  const savePk = () => PBStore.setSetting('perplexityKey', pkDraft.trim());
  const clearPk = () => { setPkDraft(''); PBStore.setSetting('perplexityKey', ''); };
  // Cloud backup handlers
  const cb = cloudBackup || {};
  const cbStatusLabel = {
    syncing: 'Syncing…', synced: 'Backed up', idle: 'Connected', error: 'Backend URL needed', off: 'Off'
  }[cb.status] || 'Off';
  const copyCode = async () => {
    try { await navigator.clipboard.writeText(formatCode(cb.code || '')); setCodeCopied(true); setTimeout(() => setCodeCopied(false), 1500); }
    catch (_e) { setCodeReveal(true); } // clipboard blocked — at least reveal it to copy by hand
  };
  const doRestore = async () => {
    setRestoreErr(''); setRestoreBusy(true);
    try { await cb.restore(restoreCode); /* reloads on success */ }
    catch (e) { setRestoreErr(e.message || 'Restore failed'); setRestoreBusy(false); }
  };
  // iOS-Settings-style sidebar: each section carries a colored icon tile and
  // lives in a labelled cluster. Tints stay inside the app palette so the rail
  // reads branded, not candy.
  const sections = [
    { key: 'display', label: 'Currency', icon: 'globe', tint: 'var(--blue)', group: 'General' },
    { key: 'appearance', label: 'Appearance', icon: 'image', tint: 'var(--purple)', group: 'General' },
    { key: 'tabs', label: 'Tabs', icon: 'list', tint: '#64748b', group: 'General' },
    { key: 'ribbon', label: 'Ribbon', icon: 'activity', tint: 'var(--amber)', group: 'General' },
    { key: 'fx', label: 'FX Rates', icon: 'refresh', tint: 'var(--emerald)', group: 'Portfolio' },
    { key: 'holdings', label: 'Holdings', icon: 'briefcase', tint: 'var(--brand)', group: 'Portfolio' },
    { key: 'preview', label: 'Preview', icon: 'eye', tint: '#0ea5e9', group: 'Portfolio' },
    { key: 'connections', label: 'Connections', icon: 'link', tint: 'var(--rose)', group: 'Data & sync' },
    { key: 'data', label: 'Data', icon: 'download', tint: '#71717a', group: 'Data & sync' },
    { key: 'diagnostics', label: 'Diagnostics', icon: 'gauge', tint: '#94a3b8', group: 'Data & sync' },
  ];
  const navGroups = [];
  sections.forEach(s => {
    const last = navGroups[navGroups.length - 1];
    if (!last || last.title !== s.group) navGroups.push({ title: s.group, items: [s] });
    else last.items.push(s);
  });
  const toggleTabHidden = (key) => {
    if (key === TAB_ALWAYS_VISIBLE) return;
    const hidden = (hiddenTabs || []);
    PBStore.setSetting('hiddenTabs', hidden.includes(key) ? hidden.filter(k => k !== key) : [...hidden, key]);
  };
  // Group positions by market for the delete tool, ordered like the Holdings tabs.
  const marketOrder = MARKETS.map(m => m.value);
  const delGroups = Array.from(new Set(positions.map(p => p.market)))
    .sort((a, b) => marketOrder.indexOf(a) - marketOrder.indexOf(b))
    .map(mkt => ({
      market: mkt,
      label: MARKET_LABELS[mkt] || mkt,
      rows: positions.filter(p => p.market === mkt),
    }));
  const toggleDel = (id) => setSelectedDel(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleDelMarket = (rows) => setSelectedDel(prev => {
    const next = new Set(prev);
    const allSel = rows.every(r => next.has(r.id));
    rows.forEach(r => allSel ? next.delete(r.id) : next.add(r.id));
    return next;
  });
  const selectedRows = positions.filter(p => selectedDel.has(p.id));
  // Delete is a two-step in-dialog confirm (premium feel — no jarring browser
  // confirm()). The trash button arms `confirmDel`, which swaps the list for a
  // confirmation panel; only its red "Delete" commits.
  const doDeleteHoldings = () => {
    const ids = Array.from(selectedDel);
    if (ids.length === 0 || !onDeleteHoldings) { setConfirmDel(false); return; }
    onDeleteHoldings(ids);
    setSelectedDel(new Set());
    setConfirmDel(false);
  };
  const holdingValue = (p) => {
    const q = prices[priceKey(p.market, p.ticker)];
    const px = q && isFinite(q.price) ? q.price : (isFinite(p.costBasis) ? p.costBasis : null);
    return px == null ? null : px * p.shares;
  };
  const activeLabel = (sections.find(s => s.key === activeSection) || {}).label || '';
  return React.createElement("div", { className: "settings-overlay" },
    React.createElement("div", { className: "settings-backdrop", onClick: onClose }),
    React.createElement("div", { className: "settings-dialog", ref: panelRef },
      React.createElement("div", { className: "settings-dialog-header" },
        React.createElement("div", { className: "settings-logo" }, React.createElement(Icon, { name: "settings", size: 18 })),
        React.createElement("div", { className: "settings-dialog-titles" },
          React.createElement("div", { className: "settings-dialog-title" }, "Settings"),
          React.createElement("div", { className: "settings-dialog-sub" }, "Preferences \xB7 portfolio \xB7 data")),
        React.createElement("button", { className: "modal-close", onClick: onClose, 'aria-label': "Close" },
          React.createElement(Icon, { name: "x" })
        )
      ),
      React.createElement("div", { className: "settings-dialog-body" },
        React.createElement("nav", { className: "settings-nav", "aria-label": "Settings sections" },
          navGroups.map(g => React.createElement("div", { className: "settings-nav-group", key: g.title },
            React.createElement("div", { className: "settings-nav-group-title" }, g.title),
            g.items.map(s => React.createElement("button", {
              key: s.key,
              className: `settings-nav-item ${activeSection === s.key ? 'active' : ''}`,
              "aria-current": activeSection === s.key ? 'page' : undefined,
              onClick: () => setActiveSection(s.key)
            },
              React.createElement("span", { className: "settings-nav-ico", style: { background: s.tint } },
                React.createElement(Icon, { name: s.icon, size: 13 })),
              React.createElement("span", { className: "settings-nav-label" }, s.label)))))
        ),
        React.createElement("div", { className: "settings-content" + (activeSection === 'holdings' && positions.length > 0 && !confirmDel ? " has-sticky-bar" : "") },
        React.createElement("div", { className: "settings-content-title" }, activeLabel),
        activeSection === 'display' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "settings-row" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Display currency"),
              React.createElement("div", { className: "settings-row-desc" }, "Portfolio totals and FX shown in this currency")
            ),
            React.createElement("select", {
              value: displayCurrency,
              onChange: e => PBStore.setSetting('displayCurrency', e.target.value),
              style: { width: 'auto', minWidth: 110 }
            }, DISPLAY_CURRENCIES.map(c => React.createElement("option", {
              key: c.code, value: c.code
            }, c.sym + " " + c.code)))
          ),
          React.createElement("div", { className: "settings-info-box" },
            React.createElement("div", { className: "settings-info-title" },
              React.createElement(Icon, { name: "globe", size: 12 }), " How FX gain/loss is calculated"),
            React.createElement("div", { className: "settings-info-body" },
              "When you add a position, the live exchange rate is stored. Price P/L tracks native-currency changes. FX impact shows how much your ", displayCurrency, " value has shifted purely from currency moves.")
          )
        ),
        activeSection === 'preview' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "settings-row mb-3" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Preview mode"),
              React.createElement("div", { className: "settings-row-desc" },
                "Show the app with a realistic demo portfolio — trendy stocks across every market and sector, live prices, invented sizes. Your real holdings stay untouched and hidden while it's on; editing is disabled.")
            ),
            React.createElement("div", { className: "seg-toggle", style: { flex: '0 0 auto', minWidth: 168 } },
              React.createElement("button", {
                type: "button",
                className: "seg-opt" + (!previewMode ? " active" : ""),
                onClick: () => PBStore.setSetting('previewMode', false),
                "aria-pressed": !previewMode
              }, "Off"),
              React.createElement("button", {
                type: "button",
                className: "seg-opt" + (previewMode ? " active" : ""),
                onClick: () => PBStore.setSetting('previewMode', true),
                "aria-pressed": previewMode
              }, "On")
            )
          ),
          previewMode && React.createElement("div", { className: "settings-row-desc" },
            "Preview is on — a \"Preview\" pill shows in the header. Alerts pause while it's on.")
        ),
        activeSection === 'appearance' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "settings-row mb-3" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Theme"),
              React.createElement("div", { className: "settings-row-desc" }, "Light or dark appearance for the app")
            ),
            React.createElement("div", { className: "seg-toggle", style: { flex: '0 0 auto', minWidth: 168 } },
              React.createElement("button", {
                type: "button",
                className: "seg-opt" + (theme === 'light' ? " active" : ""),
                style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 },
                onClick: () => PBStore.setSetting('theme', 'light'),
                "aria-pressed": theme === 'light'
              }, React.createElement(Icon, { name: "sun", size: 14 }), "Light"),
              React.createElement("button", {
                type: "button",
                className: "seg-opt" + (theme !== 'light' ? " active" : ""),
                style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 },
                onClick: () => PBStore.setSetting('theme', 'dark'),
                "aria-pressed": theme !== 'light'
              }, React.createElement(Icon, { name: "moon", size: 14 }), "Dark")
            )
          ),
          React.createElement("div", { className: "settings-section-title mb-1" }, "Home-screen icon"),
          React.createElement("div", { className: "settings-row-desc mb-3" },
            "Pick the app icon for your phone's home screen, the browser tab, and PWA install. On iPhone, remove and re-add Playbook to the Home Screen after switching to refresh the icon."),
          React.createElement("div", { className: "icon-choice-grid" },
            [
              { key: 'dark',  label: 'Dark',  tile: '#0B0B10', muted: '#3A3A52' },
              { key: 'light', label: 'Light', tile: '#FFFFFF', muted: '#C9CBDB' }
            ].map(opt => {
              const active = (iconTheme || 'dark') === opt.key;
              return React.createElement("button", {
                key: opt.key,
                type: "button",
                className: `icon-choice ${active ? 'active' : ''}`,
                onClick: () => PBStore.setSetting('iconTheme', opt.key),
                "aria-pressed": active
              },
                React.createElement("svg", { className: "icon-choice-tile", viewBox: "0 0 512 512", width: 76, height: 76, "aria-hidden": "true" },
                  React.createElement("rect", { width: 512, height: 512, rx: 114, fill: opt.tile }),
                  React.createElement("rect", { x: 142, y: 260, width: 56, height: 120, rx: 18, fill: opt.muted }),
                  React.createElement("rect", { x: 228, y: 180, width: 56, height: 200, rx: 18, fill: "#5A5AD0" }),
                  React.createElement("rect", { x: 314, y: 90, width: 56, height: 290, rx: 18, fill: "#6E6EF0" })
                ),
                React.createElement("span", { className: "icon-choice-label" }, opt.label),
                active && React.createElement("span", { className: "icon-choice-check" },
                  React.createElement(Icon, { name: "check", size: 13 }))
              );
            })
          ),
          React.createElement("div", { className: "settings-section-title mb-1", style: { marginTop: 20 } }, "Allocation chart"),
          React.createElement("div", { className: "settings-row" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Colour scale"),
              React.createElement("div", { className: "settings-row-desc" },
                (donutPalette === 'indigo')
                  ? "Indigo — the brand's periwinkle→blue gradient, a distinct shade per holding."
                  : "Spectrum — a distinct colour per holding across the full palette.")
            ),
            React.createElement("div", { className: "seg-toggle", style: { flex: '0 0 auto', minWidth: 168 } },
              React.createElement("button", {
                type: "button",
                className: "seg-opt" + (donutPalette !== 'indigo' ? " active" : ""),
                onClick: () => PBStore.setSetting('donutPalette', 'spectrum'),
                "aria-pressed": donutPalette !== 'indigo'
              }, "Spectrum"),
              React.createElement("button", {
                type: "button",
                className: "seg-opt" + (donutPalette === 'indigo' ? " active" : ""),
                onClick: () => PBStore.setSetting('donutPalette', 'indigo'),
                "aria-pressed": donutPalette === 'indigo'
              }, "Indigo")
            )
          ),
          React.createElement("div", { className: "settings-row", style: { marginTop: 14 } },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Holdings shown"),
              React.createElement("div", { className: "settings-row-desc" },
                "Show your largest holdings individually; the rest combine into “Other”. Sectors and markets are never grouped.")
            ),
            React.createElement("select", {
              value: String(donutTopN),
              onChange: e => PBStore.setSetting('donutTopN', parseInt(e.target.value, 10)),
              style: { width: 'auto', minWidth: 110 }
            },
              React.createElement("option", { value: "0" }, "All"),
              [5, 8, 10, 12, 15, 20, 30].map(nn => React.createElement("option", { key: nn, value: String(nn) }, "Top " + nn)))
          )
        ),
        activeSection === 'tabs' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "settings-section-title mb-1" }, "Navigation tabs"),
          React.createElement("div", { className: "settings-row-desc mb-3" },
            "Drag the handle to reorder, and tap the eye to hide tabs you don't use. Dashboard is always shown."),
          React.createElement(TabReorderList, {
            tabOrder: (tabOrder || DEFAULT_TAB_ORDER),
            hiddenTabs: hiddenTabs,
            onToggleHidden: toggleTabHidden
          })
        ),
        activeSection === 'ribbon' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "settings-row mb-3" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Display mode"),
              React.createElement("div", { className: "settings-row-desc" },
                ribbonItems.length <= 3
                  ? "With 3 or fewer items, pills display in a row."
                  : "Choose how extra pills are laid out.")
            ),
            ribbonItems.length > 3 && React.createElement("select", {
              value: ribbonMode,
              onChange: e => PBStore.setSetting('ribbonMode', e.target.value),
              style: { width: 'auto', minWidth: 110 }
            },
              React.createElement("option", { value: "rows" }, "Rows of 3"),
              React.createElement("option", { value: "marquee" }, "Scrolling ticker"))
          ),
          React.createElement("div", { className: "settings-section-title mb-2" }, "Select items"),
          React.createElement("div", { className: "settings-row-desc mb-3" }, "Tap to toggle. Open any item from the ribbon for its chart, a plain-English explanation, and price alerts."),
          [
            { id: 'markets', label: 'Indices, commodities & crypto' },
            { id: 'macro',   label: 'Macro & rates' }
          ].map(grp => {
            const items = RIBBON_CATALOG.filter(i => (i.group || 'markets') === grp.id);
            if (!items.length) return null;
            return React.createElement(React.Fragment, { key: grp.id },
              React.createElement("div", { className: "ribbon-catalog-subhead" }, grp.label),
              React.createElement("div", { className: "ribbon-catalog-grid" },
                items.map(item => {
                  const active = ribbonItems.includes(item.key);
                  return React.createElement("button", {
                    key: item.key,
                    className: `ribbon-catalog-item ${active ? 'active' : ''}`,
                    onClick: () => {
                      if (active) PBStore.setSetting('ribbonItems', ribbonItems.filter(k => k !== item.key));
                      else PBStore.setSetting('ribbonItems', [...ribbonItems, item.key]);
                    }
                  },
                    React.createElement("span", { className: "ribbon-catalog-short" }, item.short),
                    React.createElement("span", { className: "ribbon-catalog-name" }, item.label)
                  );
                })
              )
            );
          })
        ),
        activeSection === 'fx' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "flex justify-between items-center mb-3" },
            React.createElement("div", { className: "settings-section-title" }, "Live exchange rates"),
            React.createElement("button", {
              className: `btn btn-secondary btn-sm ${refreshing ? 'spin' : ''}`,
              onClick: refresh, disabled: refreshing
            }, React.createElement(Icon, { name: "refresh", size: 12 }),
               refreshing ? " Refreshing..." : " Refresh now")
          ),
          fxRates ? React.createElement(React.Fragment, null,
            React.createElement("div", { className: "card", style: { padding: 0, overflow: 'hidden' } },
              DISPLAY_CURRENCIES.filter(c => c.code !== displayCurrency).map((c, i, arr) => {
                const one = convertCcy(1, c.code, displayCurrency, rates);
                return React.createElement("div", { key: c.code, className: "fx-rate-row",
                  style: i < arr.length - 1 ? { borderBottom: '1px solid var(--border)' } : {} },
                  React.createElement("span", { className: "from" },
                    React.createElement("span", { className: "mono", style: { fontWeight: 600 } }, c.code),
                    React.createElement("span", { className: "text-dim text-xs" }, " · " + c.label)
                  ),
                  React.createElement("span", { className: "arrow" }, "→"),
                  React.createElement("span", { className: "rate mono" },
                    one != null ? (CURRENCY_SYMBOLS[displayCurrency] + one.toLocaleString('en-US', { maximumFractionDigits: 4 })) : '—'
                  )
                );
              })
            ),
            React.createElement("div", { className: "text-xs text-dim mt-2" },
              "Source: ", fxRates.source, " · fetched ",
              new Date(fxRates.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            )
          ) : React.createElement("div", { className: "settings-empty" },
            React.createElement(Icon, { name: "refresh", size: 24 }),
            React.createElement("p", null, "Rates not loaded — tap Refresh now.")
          )
        ),
        activeSection === 'holdings' && React.createElement("div", { className: "settings-section" },
          positions.length === 0
            ? React.createElement("div", { className: "settings-empty" },
                React.createElement(Icon, { name: "briefcase", size: 24 }),
                React.createElement("p", null, "No holdings to manage yet."))
          : confirmDel
            // ── Step 2: confirmation panel (replaces the list while armed) ──
            ? React.createElement("div", { className: "hm-confirm" },
                React.createElement("div", { className: "hm-confirm-icon" },
                  React.createElement(Icon, { name: "trash", size: 22 })),
                React.createElement("div", { className: "hm-confirm-title" },
                  "Delete ", selectedRows.length, " holding", selectedRows.length === 1 ? "" : "s", "?"),
                React.createElement("div", { className: "hm-confirm-body" },
                  "This permanently removes the position", selectedRows.length === 1 ? "" : "s",
                  " without recording a sale and can't be undone."),
                React.createElement("div", { className: "hm-confirm-list" },
                  selectedRows.map(p => {
                    const nm = positionDisplayName(p, p.market);
                    return React.createElement("div", { key: p.id, className: "hm-confirm-chip" },
                      React.createElement("span", { className: "hm-chip-tkr" }, p.ticker),
                      nm && nm !== p.ticker ? React.createElement("span", { className: "hm-chip-name" }, nm) : null,
                      React.createElement("span", { className: "hm-chip-mkt" }, MARKET_LABELS[p.market] || p.market));
                  })),
                React.createElement("div", { className: "hm-confirm-actions" },
                  React.createElement("button", { className: "btn btn-ghost", onClick: () => setConfirmDel(false) }, "Cancel"),
                  React.createElement("button", { className: "btn btn-danger", onClick: doDeleteHoldings },
                    React.createElement(Icon, { name: "trash", size: 14 }),
                    " Delete ", selectedRows.length, " holding", selectedRows.length === 1 ? "" : "s"))
              )
            // ── Step 1: premium selectable list ──
            : React.createElement(React.Fragment, null,
                React.createElement("div", { className: "settings-row-desc mb-3" },
                  "Select holdings to permanently delete. This removes positions without recording a sale — use ", React.createElement("b", null, "Sell"), " on the Holdings screen if you actually sold one."),
                React.createElement("div", { className: "hm-list" },
                  delGroups.map(g => {
                    const allSel = g.rows.every(r => selectedDel.has(r.id));
                    return React.createElement("div", { key: g.market, className: "hm-group" },
                      React.createElement("div", { className: "hm-group-head" },
                        React.createElement("span", { className: "hm-group-title" }, g.label),
                        React.createElement("span", { className: "hm-group-count" }, g.rows.length),
                        React.createElement("button", {
                          className: "hm-selectall", type: "button",
                          onClick: () => toggleDelMarket(g.rows)
                        }, allSel ? "Deselect all" : "Select all")),
                      React.createElement("div", { className: "hm-rows" },
                        g.rows.map(p => {
                          const nm = positionDisplayName(p, p.market);
                          const sel = selectedDel.has(p.id);
                          const val = holdingValue(p);
                          return React.createElement("button", {
                            key: p.id, type: "button",
                            className: "hm-row" + (sel ? " sel" : ""),
                            "aria-pressed": sel,
                            onClick: () => toggleDel(p.id)
                          },
                            React.createElement("span", { className: "hm-check" + (sel ? " on" : "") },
                              sel ? React.createElement(Icon, { name: "check", size: 13 }) : null),
                            React.createElement("span", { className: "hm-row-main" },
                              React.createElement("span", { className: "hm-row-tkr" }, p.ticker),
                              nm && nm !== p.ticker ? React.createElement("span", { className: "hm-row-name" }, nm) : null),
                            React.createElement("span", { className: "hm-row-meta" },
                              React.createElement("span", { className: "hm-row-val" }, val == null ? "—" : fmt(val, p.market)),
                              React.createElement("span", { className: "hm-row-qty" }, p.shares, " sh")));
                        })));
                  })),
                React.createElement("div", { className: "hm-bar" },
                  React.createElement("span", { className: "hm-bar-count" },
                    selectedDel.size > 0 ? selectedDel.size + " selected" : "None selected"),
                  React.createElement("div", { className: "hm-bar-actions" },
                    React.createElement("button", {
                      className: "btn btn-ghost btn-sm",
                      disabled: selectedDel.size === 0,
                      onClick: () => setSelectedDel(new Set())
                    }, "Clear"),
                    React.createElement("button", {
                      className: "btn btn-danger btn-sm",
                      disabled: selectedDel.size === 0,
                      onClick: () => setConfirmDel(true)
                    }, React.createElement(Icon, { name: "trash", size: 13 }),
                       selectedDel.size > 0 ? " Delete (" + selectedDel.size + ")" : " Delete")))
              )
        ),
        activeSection === 'connections' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "settings-row-desc mb-3" },
            "Optional integrations that power AI news and always-on alerts. Keys and URLs are stored locally in this browser only."),
          // ── AI news (Perplexity) ──
          React.createElement("div", { className: "conn-card" + (pkConfigured ? " ok" : "") },
            React.createElement("div", { className: "conn-card-head" },
              React.createElement("div", { className: "conn-card-icon" }, React.createElement(Icon, { name: "activity", size: 16 })),
              React.createElement("div", { className: "conn-card-titles" },
                React.createElement("div", { className: "conn-card-title" }, "AI news"),
                React.createElement("div", { className: "conn-card-sub" }, "Perplexity")),
              React.createElement("span", { className: "conn-status" + (pkConfigured ? " on" : "") },
                pkConfigured ? "Configured" : "Off")),
            React.createElement("div", { className: "conn-card-body" },
              pkConfigured
                ? "Perplexity is pulling AI-curated headlines alongside Yahoo Finance RSS. Paste a new key to replace it, or remove to disable."
                : "Paste a Perplexity API key to pull AI-curated headlines alongside Yahoo Finance RSS."),
            React.createElement("div", { className: "pk-row" },
              React.createElement("input", {
                type: pkReveal ? "text" : "password",
                autoComplete: "off", spellCheck: false,
                placeholder: "pplx-…", value: pkDraft,
                onChange: e => setPkDraft(e.target.value),
                className: "pk-input"
              }),
              React.createElement("button", {
                className: "btn btn-ghost btn-xs", type: "button",
                onClick: () => setPkReveal(v => !v),
                "aria-label": pkReveal ? "Hide key" : "Reveal key"
              }, pkReveal ? "Hide" : "Show")),
            React.createElement("div", { className: "pk-actions" },
              React.createElement("button", {
                className: "btn btn-primary btn-xs", type: "button",
                disabled: pkDraft.trim() === (perplexityKey || ''),
                onClick: savePk
              }, pkConfigured ? "Update key" : "Save key"),
              pkConfigured && React.createElement("button", {
                className: "btn btn-ghost btn-xs", type: "button", onClick: clearPk
              }, "Remove"))
          ),
          // ── Background push server ──
          (() => {
            const meta = ({
              connected:   { cls: 'ok',   label: 'Connected' },
              connecting:  { cls: '',     label: 'Connecting…' },
              error:       { cls: 'err',  label: 'Not connected' },
              unsupported: { cls: 'warn', label: 'Unavailable' }
            })[pushStatus] || { cls: '', label: 'Off' };
            const body = pushStatus === 'connected'
              ? 'Connected. Your alerts are checked on the server every minute during market hours and pushed instantly — even with Playbook fully closed, on iPhone and Android.'
              : pushStatus === 'connecting'
              ? 'Connecting to your push server…'
              : pushStatus === 'unsupported'
              ? "Push isn't available in this browser. On iPhone, install to the Home Screen and reopen from the icon (iOS 16.4+)."
              : pushStatus === 'error'
              ? "Couldn't reach the server. Check the URL, make sure notifications are enabled, and that the worker is deployed."
              : 'The path to always-on, app-closed alerts. Deploy the free worker in the backend/ folder, then paste its URL here.';
            return React.createElement("div", { className: "conn-card " + meta.cls },
              React.createElement("div", { className: "conn-card-head" },
                React.createElement("div", { className: "conn-card-icon" }, React.createElement(Icon, { name: "bell", size: 16 })),
                React.createElement("div", { className: "conn-card-titles" },
                  React.createElement("div", { className: "conn-card-title" }, "Background push server"),
                  React.createElement("div", { className: "conn-card-sub" }, "Always-on alerts")),
                React.createElement("span", { className: "conn-status" + (pushStatus === 'connected' ? " on" : "") }, meta.label)),
              React.createElement("div", { className: "conn-card-body" }, body),
              React.createElement("div", { className: "pk-row" },
                React.createElement("input", {
                  type: "url", inputMode: "url", autoComplete: "off",
                  autoCapitalize: "none", spellCheck: false,
                  placeholder: "https://playbook-push.<you>.workers.dev",
                  value: pushDraft,
                  onChange: e => setPushDraft(e.target.value),
                  className: "pk-input"
                }),
                pushStatus === 'connected'
                  ? React.createElement("button", { className: "btn btn-ghost btn-xs", type: "button", onClick: onDisconnectPush }, "Disconnect")
                  : React.createElement("button", {
                      className: "btn btn-primary btn-xs", type: "button",
                      disabled: pushStatus === 'connecting',
                      onClick: () => onConnectPush(pushDraft)
                    }, pushStatus === 'connecting' ? "…" : "Connect")),
              pushStatus === 'connected' && React.createElement("div", { className: "pk-actions" },
                React.createElement("button", {
                  className: "btn btn-ghost btn-xs", type: "button", onClick: onTestPush
                }, React.createElement(Icon, { name: "bell", size: 13 }), " Send test push")));
          })()
        ),
        activeSection === 'data' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "settings-data-row" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Save backup file"),
              React.createElement("div", { className: "settings-row-desc" }, "All data + settings as JSON. On iPhone, save it to Files / iCloud.")
            ),
            React.createElement("button", { className: "btn btn-secondary btn-sm", onClick: onExport },
              React.createElement(Icon, { name: "download", size: 13 }), " Export")
          ),
          React.createElement("div", { className: "settings-data-row" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Restore from file"),
              React.createElement("div", { className: "settings-row-desc" }, "Import a previously exported JSON backup (replaces current data)")
            ),
            React.createElement("button", { className: "btn btn-secondary btn-sm", onClick: () => fileInputRef.current?.click() },
              React.createElement(Icon, { name: "share", size: 13 }), " Import")
          ),
          React.createElement("input", {
            ref: fileInputRef, type: "file", accept: "application/json",
            style: { display: 'none' },
            onChange: e => { if (e.target.files[0]) onImport(e.target.files[0]); e.target.value = ''; }
          }),

          // ─── Cloud backup ─────────────────────────────────────────────────
          React.createElement("div", { className: "settings-content-title mt-4" }, "Cloud backup"),
          React.createElement("div", { className: "settings-data-row" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, cb.enabled ? "Auto-backup is on" : "Encrypted auto-backup"),
              React.createElement("div", { className: "settings-row-desc" },
                cb.enabled
                  ? ("Saved to your backend on every change. Status: " + cbStatusLabel + (cb.lastSync ? " \xB7 " + new Date(cb.lastSync).toLocaleString() : ""))
                  : "Keep an encrypted copy on your backend so data survives deleting + re-adding the app icon.")
            ),
            cb.enabled
              ? React.createElement("button", { className: "btn btn-ghost btn-sm", onClick: cb.disable }, "Turn off")
              : React.createElement("button", { className: "btn btn-primary btn-sm", onClick: cb.enable, disabled: !cb.base },
                  React.createElement(Icon, { name: "refresh", size: 13 }), " Turn on")
          ),
          !cb.base && React.createElement("div", { className: "settings-info-box mt-2" },
            React.createElement("div", { className: "settings-info-body" },
              "Set your backend URL under Connections first — cloud backup uses the same server (redeploy the Worker so it has the /backup route).")
          ),
          cb.enabled && cb.code && React.createElement("div", { className: "settings-info-box mt-2" },
            React.createElement("div", { className: "settings-row-title" }, "Recovery code"),
            React.createElement("div", { className: "settings-row-desc" },
              "Write this down. You enter it to restore after re-adding the icon — it's the only key and can't be recovered for you."),
            React.createElement("div", { className: "pk-row mt-2" },
              React.createElement("code", { className: "pk-input", style: { letterSpacing: '0.12em', fontFamily: 'ui-monospace, monospace' } },
                codeReveal ? formatCode(cb.code) : "••••-••••-••••"),
              React.createElement("button", { className: "btn btn-ghost btn-xs", onClick: () => setCodeReveal(v => !v) }, codeReveal ? "Hide" : "Show"),
              React.createElement("button", { className: "btn btn-primary btn-xs", onClick: copyCode }, codeCopied ? "Copied!" : "Copy")
            ),
            React.createElement("div", { className: "pk-actions mt-2" },
              React.createElement("button", { className: "btn btn-ghost btn-xs", onClick: cb.pushNow, disabled: cb.status === 'syncing' },
                React.createElement(Icon, { name: "refresh", size: 13 }), cb.status === 'syncing' ? " Syncing…" : " Sync now"))
          ),

          // Restore-from-cloud — works on a fresh device too (enter the code).
          React.createElement("div", { className: "settings-data-row mt-3" },
            React.createElement("div", { className: "settings-row-label" },
              React.createElement("div", { className: "settings-row-title" }, "Restore from cloud"),
              React.createElement("div", { className: "settings-row-desc" }, "Re-added the icon? Enter your recovery code to pull your data back.")
            )
          ),
          React.createElement("div", { className: "pk-row" },
            React.createElement("input", {
              type: "text", inputMode: "text", autoComplete: "off", autoCapitalize: "characters", spellCheck: false,
              placeholder: "XXXX-XXXX-XXXX", value: restoreCode, className: "pk-input",
              onChange: e => setRestoreCode(e.target.value)
            }),
            React.createElement("button", {
              className: "btn btn-primary btn-xs", disabled: restoreBusy || !cb.base || normalizeCode(restoreCode).length < 8,
              onClick: doRestore
            }, restoreBusy ? "…" : "Restore")
          ),
          restoreErr && React.createElement("div", { className: "settings-row-desc", style: { color: 'var(--negative, #f87171)', marginTop: 6 } }, restoreErr),

          React.createElement("div", { className: "settings-info-box mt-3" },
            React.createElement("div", { className: "settings-info-body" },
              "Backups cover everything: holdings, watchlists & groups, alerts, contributions, transactions, sector weights, TFSA targets and all settings. Cloud copies are end-to-end encrypted — the server only stores unreadable ciphertext."
            )
          )
        ),

        // ─── Diagnostics ───────────────────────────────────────────────────
        // What this device reports for the viewport and the safe-area insets.
        // Exists because the stock card's bottom-edge bug does not reproduce in
        // any browser available here: headless Chrome reports every
        // env(safe-area-inset-*) as 0, and two opposite CSS fixes both changed
        // the layout in Chrome while changing nothing on the phone. Read-only,
        // stateless, no network, no pb.* key.
        activeSection === 'diagnostics' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "settings-info-box" },
            React.createElement("div", { className: "settings-info-body" },
              "Measurements taken on this device. Nothing is stored or sent anywhere. Read 'safe t/b/l/r' first: a non-zero FIRST value means the app is drawing under the status bar. 'Glass below view' is the screen left uncovered under the web view and should be 0px; 'Sheet vs fixed' is the app's own job and must always be 0px. The other rows compare against the physical screen, so they read non-zero whenever the web view is merely offset - that is not automatically a fault. Tap Copy and paste the text back so the numbers can be read exactly rather than off a screenshot."
            )
          ),
          React.createElement("div", { className: "pos-list diag-list mt-3" },
            diagRows.map((r, i) => React.createElement("div", {
              key: r.label + i, className: "pos-line", "data-k": r.label
            },
              React.createElement("span", { className: "pos-line-label" }, r.label),
              React.createElement("span", { className: "pos-line-val mono" }, r.value)))
          ),
          React.createElement("div", { className: "pk-actions mt-3" },
            React.createElement("button", {
              className: "btn btn-secondary btn-sm", type: "button", onClick: copyDiag
            }, React.createElement(Icon, { name: "share", size: 13 }), diagCopied ? " Copied" : " Copy"),
            React.createElement("button", {
              className: "btn btn-ghost btn-sm", type: "button",
              onClick: () => { setDiagCopied(false); setDiag(collectViewportDiagnostics()); }
            }, React.createElement(Icon, { name: "refresh", size: 13 }), " Re-measure")
          )
        )
        )
      )
    )
  );
}
// --- Detail-card sub-component subtree (Phase 4 inc-16, moved from app.js) ---
// PriceChart / EarningsBadge / FundamentalsBlock / WatchlistControl / HoldingNotesControl /
// IndicatorValueBlock / IndicatorAbout + private helpers. Consumed by DetailModal below.
function PriceChart(_refChart) {
  const { fmtIndicator } = window.PBApp;
  let { history, loading, range, onRangeChange, currency, quote, indicator, rangeKeys, onRetry } = _refChart;
  const [hover, setHover] = useState(null);
  const [sel, setSel] = useState(null);
  const svgRef = useRef(null);
  const geomRef = useRef({ len: 0, W: 600, PL: 2, PR: 2, chartW: 596 });
  const sym = ({ ZAR: 'R', GBP: '\u00a3', AUD: 'A$', EUR: '\u20ac' })[currency] || '$';
  // Axis/scrub value formatter: indicators print in their own unit (e.g.
  // "4.45%", "$18.05T", "20"); ordinary prices keep the currency symbol.
  const vfmt = indicator ? (v => fmtIndicator(indicator, v)) : (v => sym + v.toFixed(2));
  const allRanges = [
    { key: '1d', label: '1D' },
    { key: '5d', label: '1W' },
    { key: '1mo', label: '1M' },
    { key: '3mo', label: '3M' },
    { key: '6mo', label: '6M' },
    { key: 'ytd', label: 'YTD' },
    { key: '1y', label: '1Y' },
    { key: '5y', label: '5Y' },
    { key: 'max', label: 'Max' }
  ];
  // Indicators with sparse (monthly/weekly) data restrict the range bar to the
  // windows that actually have enough points to chart.
  const ranges = (rangeKeys && rangeKeys.length)
    ? allRanges.filter(r => rangeKeys.includes(r.key))
    : allRanges;
  const rangeBar = React.createElement("div", { className: "chart-ranges" },
    ranges.map(r => React.createElement("button", {
      key: r.key,
      className: `chart-range-btn ${range === r.key ? 'active' : ''}`,
      onClick: () => onRangeChange(r.key)
    }, r.label))
  );
  const rawPoints = history && history.data && history.data.points ? history.data.points : null;
  const ready = !!(rawPoints && rawPoints.length >= 2);
  // Touch interaction (iOS-Stocks style): one finger scrubs a single point; two
  // fingers select a range and read out the % move + time span between them.
  // Native non-passive listeners let us preventDefault so the gesture stays
  // smooth and never scrolls the sheet; rAF-coalesced so rapid moves don't thrash.
  useEffect(() => {
    if (!ready) return;
    const el = svgRef.current;
    if (!el) return;
    let raf = 0, pendingV = null;
    const flush = () => {
      raf = 0;
      const p = pendingV; pendingV = null;
      if (!p) return;
      if (p.k === 'sel') { setSel({ a: p.a, b: p.b }); setHover(null); }
      else if (p.k === 'hover') { setHover({ idx: p.idx }); setSel(null); }
      else { setHover(null); setSel(null); }
    };
    const schedule = v => { pendingV = v; if (!raf) raf = requestAnimationFrame(flush); };
    const idxFromX = clientX => {
      const g = geomRef.current;
      const rect = el.getBoundingClientRect();
      if (!rect.width || g.len < 2) return 0;
      const x = (clientX - rect.left) / rect.width * g.W;
      const cx = Math.max(g.PL, Math.min(g.W - g.PR, x));
      const idx = Math.round((cx - g.PL) / g.chartW * (g.len - 1));
      return Math.max(0, Math.min(g.len - 1, idx));
    };
    const read = e => {
      const t = e.touches;
      if (!t || t.length === 0) { schedule({ k: 'clear' }); return; }
      if (t.length >= 2) schedule({ k: 'sel', a: idxFromX(t[0].clientX), b: idxFromX(t[1].clientX) });
      else schedule({ k: 'hover', idx: idxFromX(t[0].clientX) });
    };
    const onStart = e => { read(e); e.preventDefault(); };
    const onMoveT = e => { read(e); e.preventDefault(); };
    const onEnd = e => { read(e); };
    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMoveT, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMoveT);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [ready]);
  // Clear any active scrub/selection when the range changes so stale indices
  // never point past the freshly-loaded series.
  useEffect(() => { setHover(null); setSel(null); }, [range]);
  if (!ready) {
    const dataMissing = history && history.data === null && !loading;
    if (dataMissing) {
      // Both fetch sweeps came back empty (a flaky-proxy moment). Offer a one-tap
      // retry so the user isn't stuck toggling ranges to force a refetch.
      return React.createElement("div", { className: "chart-block" }, rangeBar,
        React.createElement("div", { className: "chart-empty chart-empty-fail" },
          React.createElement("span", null, 'Chart data unavailable'),
          onRetry ? React.createElement("button", {
            className: "chart-retry-btn", onClick: onRetry
          }, "Retry") : null));
    }
    // Shimmer skeleton while the series loads \u2014 reads as a premium fintech app
    // instead of a bare "Loading\u2026" string.
    return React.createElement("div", { className: "chart-block" }, rangeBar,
      React.createElement("div", { className: "chart-skeleton" },
        React.createElement("div", { className: "chart-skeleton-line" }),
        React.createElement("div", { className: "chart-skeleton-shimmer" })
      )
    );
  }
  const is1d = range === '1d';
  // For the intraday view, the daily % must agree with the header (which is
  // measured from the previous close, not the first intraday bar). We draw a
  // dashed prev-close baseline and report the live quote's change verbatim, and
  // append the live price so the line ends exactly where the header sits.
  const baseline = is1d && quote && typeof quote.prevClose === 'number' && quote.prevClose > 0 ? quote.prevClose : null;
  let points = rawPoints;
  if (is1d && quote && typeof quote.price === 'number' && quote.price > 0) {
    // During extended hours the live tick is the pre/post price, not the regular
    // close — append THAT (tagged with its session) so the line ends where the
    // after-hours / pre-market readout sits instead of snapping back down to the
    // regular close and drawing a phantom drop at the end.
    const liveP = (quote.extPrice != null && quote.extKind) ? quote.extPrice : quote.price;
    const liveSession = quote.extKind === 'post' ? 'post'
      : quote.extKind === 'pre' ? 'pre'
      : (rawPoints[rawPoints.length - 1].session || 'regular');
    const lastP = rawPoints[rawPoints.length - 1].p;
    if (Math.abs(lastP - liveP) / liveP > 0.0005) {
      points = [...rawPoints, { t: Date.now(), p: liveP, session: liveSession }];
    }
  }
  const W = 600, H = 180;
  const PL = 2, PR = 2, PT = 6, PB = 6;
  const prs = points.map(p => p.p);
  let min = Math.min(...prs);
  let max = Math.max(...prs);
  if (baseline != null) { min = Math.min(min, baseline); max = Math.max(max, baseline); }
  const span = max - min || 1;
  const chartW = W - PL - PR;
  const chartH = H - PT - PB;
  const xFor = i => PL + (i / (points.length - 1)) * chartW;
  const yFor = p => PT + (1 - (p - min) / span) * chartH;
  const d = points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${xFor(i).toFixed(2)},${yFor(pt.p).toFixed(2)}`).join(' ');
  const areaD = d + ` L${xFor(points.length - 1).toFixed(2)},${H - PB} L${PL},${H - PB} Z`;
  // Extended-hours segmentation — 1d only. We split the line so the pre-market
  // and after-hours portions read as dashed/translucent with shaded bands and a
  // labelled market-open divider, while the regular session stays solid.
  const hasExtHours = is1d && points.some(p => p.session && p.session !== 'regular');
  const hasRegular = hasExtHours && points.some(p => p.session === 'regular');
  const openIdx = hasRegular ? points.findIndex(p => p.session === 'regular') : -1;
  const postIdx = hasExtHours ? points.findIndex(p => p.session === 'post') : -1;
  const segPath = (i0, i1) => {
    if (i0 < 0 || i1 < i0) return '';
    let s = '';
    for (let i = i0; i <= i1; i++) s += (i === i0 ? 'M' : 'L') + xFor(i).toFixed(2) + ',' + yFor(points[i].p).toFixed(2) + ' ';
    return s.trim();
  };
  // allExt = the whole intraday line is extended-hours (e.g. viewing during the
  // pre-market session before the open) → draw the entire line dashed.
  const allExt = hasExtHours && !hasRegular;
  const hasPre = hasRegular && openIdx > 0;
  const hasPost = hasRegular && postIdx >= 0;
  const regStart = openIdx >= 0 ? openIdx : 0;
  const regEnd = postIdx >= 0 ? postIdx : points.length - 1;
  const preSegD = hasPre ? segPath(0, openIdx) : '';
  const regSegD = hasRegular ? segPath(regStart, regEnd) : '';
  const postSegD = hasPost ? segPath(postIdx, points.length - 1) : '';
  const openX = hasPre ? xFor(openIdx) : null;
  const postX = hasPost ? xFor(postIdx) : null;
  const hasPreBars = hasExtHours && points.some(p => p.session === 'pre');
  const hasPostBars = hasExtHours && points.some(p => p.session === 'post');
  const extColor = '#94a3b8';
  const first = points[0].p;
  const last = points[points.length - 1].p;
  // Daily move is anchored to prev close / live quote so it matches the header.
  const retPct = (is1d && quote && typeof quote.changePct === 'number') ? quote.changePct
    : (baseline != null ? (last - baseline) / baseline * 100
    : (first > 0 ? (last - first) / first * 100 : 0));
  const up = retPct >= 0;
  const color = up ? '#10b981' : '#f43f5e';
  const gradId = `grad-${up ? 'up' : 'down'}`;
  // Latest geometry for the native touch handlers (they read this ref so the
  // listeners can stay attached across range/data changes).
  geomRef.current = { len: points.length, W, PL, PR, chartW };
  // What a single-point scrub measures its % move "from": the prev-close baseline
  // on the intraday chart (so it matches the header), else the first point shown.
  const refP = (is1d && baseline != null) ? baseline : first;
  const refLabel = (is1d && baseline != null) ? 'from prev close' : 'from start';
  // Desktop: hovering scrubs a single point (no press needed). Touch (1- and
  // 2-finger) is handled by the native listeners set up above.
  const onMouseMove = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * W;
    if (x < PL || x > W - PR) { setHover(null); return; }
    const idx = Math.max(0, Math.min(points.length - 1, Math.round((x - PL) / chartW * (points.length - 1))));
    setSel(null);
    setHover({ idx });
  };
  const label = ranges.find(r => r.key === range)?.label || range;
  // Single-point scrub geometry.
  const hoverIdx = hover ? Math.max(0, Math.min(points.length - 1, hover.idx)) : null;
  const hoverP = hoverIdx != null ? points[hoverIdx].p : 0;
  const hoverX = hoverIdx != null ? xFor(hoverIdx) : 0;
  const hoverY = hoverIdx != null ? yFor(hoverP) : 0;
  const hoverChg = (hoverIdx != null && refP > 0) ? (hoverP - refP) / refP * 100 : 0;
  // Two-finger range selection: % move and elapsed time between the two held
  // points. Only active once they resolve to distinct points.
  let selData = null;
  if (sel) {
    const len = points.length;
    const a = Math.max(0, Math.min(len - 1, sel.a));
    const b = Math.max(0, Math.min(len - 1, sel.b));
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (hi > lo) {
      const pLo = points[lo].p, pHi = points[hi].p;
      const pct = pLo > 0 ? (pHi - pLo) / pLo * 100 : 0;
      selData = {
        pct, up: pct >= 0,
        xLo: xFor(lo), xHi: xFor(hi), yLo: yFor(pLo), yHi: yFor(pHi),
        tLo: points[lo].t, tHi: points[hi].t
      };
    }
  }
  const selColor = selData && selData.up ? '#10b981' : '#f43f5e';
  const fmtSpan = (t0, t1) => {
    const d0 = new Date(t0), d1 = new Date(t1);
    const ms = Math.max(0, t1 - t0);
    let dur;
    if (is1d) {
      const mins = Math.max(1, Math.round(ms / 60000));
      const h = Math.floor(mins / 60);
      dur = h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
      const opt = { hour: 'numeric', minute: '2-digit', hour12: true };
      return d0.toLocaleTimeString(undefined, opt) + ' – ' + d1.toLocaleTimeString(undefined, opt) + ' · ' + dur;
    }
    const days = Math.round(ms / 86400000);
    if (days <= 1) dur = '1 day';
    else if (days < 45) dur = days + ' days';
    else { const months = Math.round(days / 30.44); dur = months < 24 ? months + ' mo' : (days / 365).toFixed(1) + ' yr'; }
    const opt = { month: 'short', day: 'numeric' };
    return d0.toLocaleDateString(undefined, opt) + ' – ' + d1.toLocaleDateString(undefined, opt) + ' · ' + dur;
  };
  return React.createElement("div", { className: "chart-block" },
    rangeBar,
    React.createElement("div", { className: "chart-wrap" },
      React.createElement("svg", {
        ref: svgRef,
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: "none",
        className: "chart-svg",
        onMouseMove: onMouseMove,
        onMouseLeave: () => setHover(null)
      },
        React.createElement("defs", null,
          React.createElement("linearGradient", { id: gradId, x1: "0", y1: "0", x2: "0", y2: "1" },
            React.createElement("stop", { offset: "0%", stopColor: color, stopOpacity: 0.3 }),
            React.createElement("stop", { offset: "100%", stopColor: color, stopOpacity: 0 })
          )
        ),
        React.createElement("path", { d: areaD, fill: `url(#${gradId})` }),
        hasPre && React.createElement("rect", {
          x: PL, y: PT, width: Math.max(0, openX - PL), height: chartH,
          fill: extColor, fillOpacity: 0.09
        }),
        hasPost && React.createElement("rect", {
          x: postX, y: PT, width: Math.max(0, (W - PR) - postX), height: chartH,
          fill: extColor, fillOpacity: 0.07
        }),
        baseline != null && React.createElement("line", {
          x1: PL, y1: yFor(baseline), x2: W - PR, y2: yFor(baseline),
          stroke: "#a1a1aa", strokeWidth: 0.5, strokeDasharray: "3,3", strokeOpacity: 0.6,
          vectorEffect: "non-scaling-stroke"
        }),
        hasPre && React.createElement("line", {
          x1: openX, y1: PT, x2: openX, y2: H - PB,
          stroke: extColor, strokeWidth: 1, strokeDasharray: "2,2", strokeOpacity: 0.9,
          vectorEffect: "non-scaling-stroke"
        }),
        // Extended-hours portions: dashed + translucent. Regular session: solid.
        hasExtHours
          ? React.createElement(React.Fragment, null,
              allExt && React.createElement("path", { d, fill: "none", stroke: extColor, strokeWidth: 1.5, strokeDasharray: "3,2.5", strokeOpacity: 0.9, vectorEffect: "non-scaling-stroke" }),
              preSegD && React.createElement("path", { d: preSegD, fill: "none", stroke: extColor, strokeWidth: 1.4, strokeDasharray: "3,2.5", strokeOpacity: 0.85, vectorEffect: "non-scaling-stroke" }),
              postSegD && React.createElement("path", { d: postSegD, fill: "none", stroke: extColor, strokeWidth: 1.4, strokeDasharray: "3,2.5", strokeOpacity: 0.85, vectorEffect: "non-scaling-stroke" }),
              regSegD && React.createElement("path", { d: regSegD, fill: "none", stroke: color, strokeWidth: 1.6, vectorEffect: "non-scaling-stroke" })
            )
          : React.createElement("path", { d, fill: "none", stroke: color, strokeWidth: 1.5, vectorEffect: "non-scaling-stroke" }),
        selData && React.createElement("g", null,
          React.createElement("rect", { x: selData.xLo, y: PT, width: Math.max(0, selData.xHi - selData.xLo), height: chartH, fill: selColor, fillOpacity: 0.12 }),
          React.createElement("line", { x1: selData.xLo, y1: PT, x2: selData.xLo, y2: H - PB, stroke: "#cbd5e1", strokeWidth: 0.6, strokeDasharray: "2,2", strokeOpacity: 0.9, vectorEffect: "non-scaling-stroke" }),
          React.createElement("line", { x1: selData.xHi, y1: PT, x2: selData.xHi, y2: H - PB, stroke: "#cbd5e1", strokeWidth: 0.6, strokeDasharray: "2,2", strokeOpacity: 0.9, vectorEffect: "non-scaling-stroke" }),
          React.createElement("circle", { cx: selData.xLo, cy: selData.yLo, r: 3.6, fill: selColor, style: { stroke: 'var(--bg)' }, strokeWidth: 1.2 }),
          React.createElement("circle", { cx: selData.xHi, cy: selData.yHi, r: 3.6, fill: selColor, style: { stroke: 'var(--bg)' }, strokeWidth: 1.2 })
        ),
        !selData && hoverIdx != null && React.createElement("g", null,
          React.createElement("line", { x1: hoverX, y1: PT, x2: hoverX, y2: H - PB, stroke: "#a1a1aa", strokeWidth: 1, strokeDasharray: "3,2", strokeOpacity: 0.9, vectorEffect: "non-scaling-stroke" }),
          React.createElement("circle", { cx: hoverX, cy: hoverY, r: 5, fill: color, fillOpacity: 0.18, style: { stroke: 'none' } }),
          React.createElement("circle", { cx: hoverX, cy: hoverY, r: 3.5, fill: color, style: { stroke: 'var(--bg)' }, strokeWidth: 1.2 })
        )
      ),
      !selData && hoverIdx != null && React.createElement("div", {
        className: "chart-tooltip",
        // Anchor the readout at the scrub point, but slide it dynamically so it
        // never spills past the chart edges: translateX goes 0% → -100% as the
        // point moves left → right (−50% / centred in the middle). This keeps the
        // whole price/date box on-screen no matter where you touch. Vertically we
        // flip it to the opposite half from the dot (drop to the bottom when the
        // point sits high, sit at the top when it's low) so it never covers the
        // very point it's describing.
        style: (() => {
          const fx = hoverX / W;
          const dropToBottom = hoverY < H / 2;
          return {
            left: `${fx * 100}%`, transform: `translateX(${-fx * 100}%)`,
            ...(dropToBottom ? { top: 'auto', bottom: 0 } : { top: 0, bottom: 'auto' })
          };
        })()
      },
        React.createElement("div", { className: "mono" }, vfmt(hoverP)),
        React.createElement("div", { className: "chart-tooltip-date" }, (() => {
          const d = new Date(points[hoverIdx].t);
          if (range === '1d') {
            return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
          }
          if (range === '5d') {
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' +
              d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
          }
          return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        })()),
        React.createElement("div", { className: `chart-tooltip-chg mono ${hoverChg >= 0 ? 'text-up' : 'text-down'}` },
          (hoverChg >= 0 ? '+' : '') + hoverChg.toFixed(2) + '% ',
          React.createElement("span", { className: "chart-tooltip-ref" }, refLabel))
      ),
      selData && React.createElement("div", {
        className: "chart-tooltip chart-sel-readout",
        style: (() => {
          const fx = (selData.xLo + selData.xHi) / 2 / W;
          // Flip below the points when either marker sits in the top half.
          const dropToBottom = Math.min(selData.yLo, selData.yHi) < H / 2;
          return {
            left: `${fx * 100}%`, transform: `translateX(${-fx * 100}%)`,
            ...(dropToBottom ? { top: 'auto', bottom: 0 } : { top: 0, bottom: 'auto' })
          };
        })()
      },
        React.createElement("div", { className: `chart-sel-pct mono ${selData.up ? 'text-up' : 'text-down'}` },
          (selData.up ? '+' : '') + selData.pct.toFixed(2) + '%'),
        React.createElement("div", { className: "chart-tooltip-date" }, fmtSpan(selData.tLo, selData.tHi))
      ),
      // The market-open divider tag yields to the scrub/compare readout: while a
      // finger is down (single-point hover or two-finger selection) the price/date
      // popup is what the user is reading, so the "OPEN" label is suppressed rather
      // than left to paint over the top of it.
      hasPre && hoverIdx == null && !selData && React.createElement("div", {
        className: "chart-open-tag",
        style: { left: `${(openX / W) * 100}%` }
      }, "OPEN")
    ),
    hasExtHours && React.createElement("div", { className: "chart-session-legend" },
      hasPreBars && React.createElement("span", { className: "chart-session-item" },
        React.createElement("span", { className: "chart-session-swatch pre" }), "Pre-market"),
      hasPostBars && React.createElement("span", { className: "chart-session-item" },
        React.createElement("span", { className: "chart-session-swatch pre" }), "After-hours"),
      hasRegular && React.createElement("span", { className: "chart-session-item" },
        React.createElement("span", { className: "chart-session-swatch reg", style: { borderTopColor: color } }), "Regular session")
    ),
    React.createElement("div", { className: "chart-hint" },
      "Drag to scrub · hold two fingers to compare two points"),
    React.createElement("div", { className: "chart-summary" },
      React.createElement("div", null,
        React.createElement("span", { className: "chart-sum-label" }, label + ' return'),
        React.createElement("span", { className: `chart-sum-val mono ${up ? 'text-up' : 'text-down'}` },
          (up ? '+' : '') + retPct.toFixed(2) + '%'
        )
      ),
      React.createElement("div", { className: "chart-range-stats" },
        baseline != null ? React.createElement(React.Fragment, null,
          React.createElement("span", { className: "chart-sum-label" }, 'Prev close'),
          React.createElement("span", { className: "mono" }, vfmt(baseline)),
          React.createElement("span", { className: "chart-sum-label", style: { marginLeft: 10 } }, 'High')
        ) : React.createElement("span", { className: "chart-sum-label" }, 'High'),
        React.createElement("span", { className: "mono" }, vfmt(max)),
        React.createElement("span", { className: "chart-sum-label", style: { marginLeft: 10 } }, 'Low'),
        React.createElement("span", { className: "mono" }, vfmt(min))
      )
    )
  );
}
function fmtLarge(n) {
  if (n == null || !isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}
function fmtPct(n, digits = 2) {
  if (n == null || !isFinite(n)) return null;
  return (n >= 0 ? '' : '') + n.toFixed(digits) + '%';
}
function EarningsBadge(_refEB) {
  const { Icon } = window.PBApp;
  let { fundamentals } = _refEB;
  const f = fundamentals?.data;
  if (!f || !f.earningsDate) return null;
  const now = Date.now();
  const d = new Date(f.earningsDate);
  const end = f.earningsDateEnd ? new Date(f.earningsDateEnd) : null;
  const endMs = end ? end.getTime() : f.earningsDate;
  if (endMs < now - 24 * 3600 * 1000) return null;
  const days = Math.round((f.earningsDate - now) / (24 * 3600 * 1000));
  const isPast = f.earningsDate < now && endMs >= now;
  const dateLabel = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const rangeLabel = end && end.toDateString() !== d.toDateString()
    ? dateLabel + ' – ' + end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : dateLabel;
  let when;
  if (isPast) when = 'Reporting window';
  else if (days <= 0) when = 'Today';
  else if (days === 1) when = 'Tomorrow';
  else if (days <= 7) when = 'In ' + days + ' days';
  else when = 'In ' + days + ' days';
  const urgent = days <= 7 && !isPast;
  return React.createElement("div", { className: `earnings-badge${urgent ? ' urgent' : ''}` },
    React.createElement("div", { className: "earnings-icon" },
      React.createElement(Icon, { name: "alert", size: 14 })
    ),
    React.createElement("div", { className: "earnings-body" },
      React.createElement("div", { className: "earnings-title" }, "Upcoming earnings"),
      React.createElement("div", { className: "earnings-date" }, rangeLabel, " · ", when)
    ),
    f.epsEst != null && React.createElement("div", { className: "earnings-est" },
      React.createElement("div", { className: "earnings-est-label" }, "EPS est."),
      React.createElement("div", { className: "mono earnings-est-val" }, f.epsEst.toFixed(2))
    )
  );
}
// Representative sector forward P/E benchmarks (broad-market estimates, early
// 2026). Used as the "Industry fwd P/E" comparator when a live per-industry
// figure isn't available (no free CORS source provides one without a key).
const SECTOR_FWD_PE = PBContent.SECTOR_FWD_PE;
function sectorForwardPE(sector) {
  if (!sector) return null;
  const v = SECTOR_FWD_PE[String(sector).trim().toLowerCase()];
  return (typeof v === 'number') ? v : null;
}
// Convert a Yahoo currency code (e.g. ZAc, GBp, USD) to its 3-letter base.
// Lives in pb-core now (money math has one home); this is the bind.
const baseCurrency = PBCore.baseCurrencyCode;
function FundamentalsBlock(_refFB) {
  const { fmt } = window.PBApp;
  let { fundamentals, quote, market, fxRates, onRetry } = _refFB;
  const loading = fundamentals && fundamentals.loading && !fundamentals.data;
  const f = fundamentals?.data || {};
  const cur = quote?.price && quote.price > 0 ? quote.price : null;
  // A fundamentals object mixes TWO currencies and the card has to keep them
  // apart: anything PRICED (day range, 52-week range, analyst targets, dividends
  // per share) is in the listing currency, anything REPORTED (revenue, EBITDA,
  // cash flow, EPS, NAV) is in the currency the company files its statements in.
  // Naspers and Datatec trade in rand and report in dollars; printing a dollar
  // revenue behind an "R" is how a card lies without a single wrong number.
  const ccySym = (MARKET_CURRENCY[market] || MARKET_CURRENCY.US).sym;
  const listingCode = (MARKET_CURRENCY[market] || MARKET_CURRENCY.US).code;
  const money = PBCore.fundamentalsMoney(f, market, fxRates?.rates);
  const stCode = money.statementCcy;
  // Say the code whenever the statements are filed elsewhere - or whenever there
  // is no symbol to say it with, so a figure is never left currency-less.
  const stSym = CURRENCY_SYMBOLS[stCode] || '';
  const stTag = (stCode !== listingCode || !stSym) ? stCode : null;
  const capMoney = (n) => (CURRENCY_SYMBOLS[money.capCcy] || (money.capCcy + ' ')) + n;
  const periodLabel = (() => {
    const q = f.mostRecentQuarter, y = f.lastFiscalYearEnd;
    const ms = q || y;
    if (!ms) return null;
    const when = new Date(ms).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    // Say which period it actually is. This used to caption every date "Q ended",
    // including fiscal-year ends and (before the parser fix) a valuation date.
    return (q ? 'Q ended ' : 'FY ended ') + when;
  })();
  const signed = (n, d = 1) => (n >= 0 ? '+' : '') + n.toFixed(d) + '%';
  const tone = (n) => n >= 0 ? 'text-up' : 'text-down';
  // \u2500\u2500 Headline analytics (the metrics the user explicitly tracks) \u2500\u2500
  const headline = [];
  const hpush = (label, value, opts) => { if (value != null) headline.push({ label, value, ...(opts || {}) }); };
  if (f.peTrailing != null) hpush('P/E (TTM)', f.peTrailing.toFixed(2), { sub: periodLabel });
  if (f.peForward != null) hpush('Forward P/E', f.peForward.toFixed(2));
  // Market cap in dollars so it reads against every other holding, with the
  // figure as quoted underneath. The old code assumed the object's single
  // currency field belonged to the cap, so a rand cap on a dollar-reporting
  // JSE listing was printed unconverted: Naspers as "$600B" rather than ~$32B.
  // A missing FX rate now shows the native figure instead of hiding the row.
  if (money.capUsd != null) {
    const m = fmtLarge(money.capUsd);
    const native = money.capCcy !== 'USD' ? fmtLarge(money.capNative) : null;
    if (m) hpush('Market cap', '$' + m, { sub: native ? capMoney(native) : null });
  } else if (money.capNative != null) {
    const m = fmtLarge(money.capNative);
    if (m) hpush('Market cap', capMoney(m), { sub: money.capCcy });
  }
  if (f.debtToEquity != null) hpush('Debt / equity', (f.debtToEquity / 100).toFixed(2));
  if (f.freeCashflow != null) { const v = fmtLarge(f.freeCashflow); if (v) hpush('Free cash flow', stSym + v, { cls: f.freeCashflow >= 0 ? 'text-up' : 'text-down', sub: stTag }); }
  if (f.profitMargin != null) hpush('Profit margin', f.profitMargin.toFixed(1) + '%', { cls: tone(f.profitMargin) });
  if (f.earningsGrowth != null) hpush('Profit growth', signed(f.earningsGrowth), { cls: tone(f.earningsGrowth), sub: 'YoY net income' });
  if (f.revenue != null) { const r = fmtLarge(f.revenue); if (r) hpush('Revenue', stSym + r, { sub: stTag ? 'TTM ' + stTag : 'TTM' }); }
  if (f.revenueGrowth != null) hpush('Revenue growth', signed(f.revenueGrowth), { cls: tone(f.revenueGrowth), sub: 'YoY' });
  const headlineKeys = new Set(['P/E (TTM)', 'Forward P/E', 'Market cap', 'Debt / equity', 'Free cash flow', 'Profit margin', 'Profit growth', 'Revenue', 'Revenue growth']);
  const stats = [];
  const push = (label, value, sub) => {
    if (value == null || value === '' || (typeof value === 'number' && !isFinite(value))) return;
    if (headlineKeys.has(label)) return;
    stats.push({ label, value, sub });
  };
  const yearHigh = f.yearHigh || quote?.yearHigh;
  const yearLow = f.yearLow || quote?.yearLow;
  if (f.eps != null) push('EPS (TTM)', stSym + f.eps.toFixed(2), stTag);
  if (f.dividendYield != null) {
    // Dividends are paid per share in the LISTING currency, not the reporting one.
    push('Dividend yield', f.dividendYield.toFixed(2) + '%',
      f.dividendRate != null ? ccySym + f.dividendRate.toFixed(2) + ' / share (TTM)' : null);
  }
  if (f.bookValue != null) push('NAV / share', stSym + f.bookValue.toFixed(2), stTag);
  // Comparing price to book value only means anything when both are in the same
  // currency; when the statements are filed in another one, the unitless P/B
  // below is the honest answer instead of a premium computed across currencies.
  if (f.bookValue != null && cur != null && f.bookValue > 0 && stCode === listingCode) {
    const diff = (cur - f.bookValue) / f.bookValue * 100;
    const prem = diff >= 0;
    push(prem ? 'NAV premium' : 'NAV discount', (prem ? '+' : '') + diff.toFixed(1) + '%');
  } else if (f.priceToBook != null) {
    const diff = (f.priceToBook - 1) * 100;
    const prem = diff >= 0;
    push(prem ? 'NAV premium' : 'NAV discount', (prem ? '+' : '') + diff.toFixed(1) + '%');
  }
  if (f.pegRatio != null) push('PEG', f.pegRatio.toFixed(2));
  if (f.priceToBook != null) push('P/B', f.priceToBook.toFixed(2));
  if (f.priceToSales != null) push('P/S', f.priceToSales.toFixed(2));
  if (f.beta != null) push('Beta', f.beta.toFixed(2));
  if (f.operatingMargin != null) push('Op margin', f.operatingMargin.toFixed(1) + '%');
  if (f.roe != null) push('ROE', f.roe.toFixed(1) + '%');
  if (f.currentRatio != null) push('Current ratio', f.currentRatio.toFixed(2));
  if (f.ebitda != null) { const e = fmtLarge(f.ebitda); if (e) push('EBITDA', stSym + e, stTag); }
  if (quote?.dayHigh != null && quote?.dayLow != null) {
    push("Day range", ccySym + quote.dayLow.toFixed(2) + ' – ' + ccySym + quote.dayHigh.toFixed(2));
  }
  if (yearHigh != null && yearLow != null) {
    push("52W range", ccySym + yearLow.toFixed(2) + ' – ' + ccySym + yearHigh.toFixed(2));
  }
  if (quote?.volume != null) { const v = fmtLarge(quote.volume); if (v) push('Volume', v); }
  if (f.avgVolume != null) { const v = fmtLarge(f.avgVolume); if (v) push('Avg volume', v); }
  // Analyst targets belong to the LISTING currency, but the S&P Global pool
  // behind stockanalysis quotes some non-US listings in dollars - and a dollar
  // target measured against a rand price renders as a ~-95% "upside". Convert
  // when a rate exists; without one, drop the section rather than print a
  // cross-currency comparison that looks like a collapse.
  const tgtCode = baseCurrency(f.targetCurrency || listingCode, market);
  const toListing = (n) => {
    if (n == null || !isFinite(n)) return null;
    if (tgtCode === listingCode) return n;
    return PBCore.convertCcy(n, tgtCode, listingCode, fxRates?.rates || null);
  };
  const targetMean = toListing(f.targetMean);
  const targetHigh = toListing(f.targetHigh);
  const targetLow = toListing(f.targetLow);
  const targetSection = targetMean ? React.createElement("div", { className: "analyst-card" },
    React.createElement("div", { className: "eyebrow" }, "Analyst targets", f.analystCount ? ' · ' + f.analystCount + ' analysts' : ''),
    React.createElement("div", { className: "analyst-row" },
      React.createElement("div", null,
        React.createElement("div", { className: "analyst-label" }, "Mean target"),
        React.createElement("div", { className: "mono analyst-val" }, fmt(targetMean, market))
      ),
      cur && React.createElement("div", null,
        React.createElement("div", { className: "analyst-label" }, "Upside"),
        React.createElement("div", { className: `mono analyst-val ${targetMean > cur ? 'text-up' : 'text-down'}` },
          ((targetMean - cur) / cur * 100).toFixed(1) + '%'
        )
      ),
      f.recommendation && React.createElement("div", null,
        React.createElement("div", { className: "analyst-label" }, "Consensus"),
        React.createElement("div", { className: `mono analyst-val rec-${f.recommendation}` }, f.recommendation.replace('_', ' '))
      )
    ),
    (targetLow != null && targetHigh != null) && React.createElement("div", { className: "analyst-range" },
      React.createElement("span", { className: "analyst-range-label" }, "Range"),
      React.createElement("span", { className: "mono" }, fmt(targetLow, market), " – ", fmt(targetHigh, market))
    ),
    f.targetSource && React.createElement("div", { className: "analyst-attrib" },
      (f.targetUpdated
        ? 'Updated ' + new Date(f.targetUpdated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' via '
        : 'via ') + f.targetSource
        + (tgtCode !== listingCode ? ' (converted from ' + tgtCode + ')' : '')
    )
  ) : null;
  const sectorRow = (f.sector || f.industry) ? React.createElement("div", { className: "sector-row" },
    f.sector && React.createElement("span", { className: "sector-chip" }, f.sector),
    f.industry && React.createElement("span", { className: "sector-chip muted" }, f.industry)
  ) : null;
  const ai = f.source === 'perplexity';
  const empty = !loading && headline.length === 0 && stats.length === 0 && !targetSection && !sectorRow;
  return React.createElement("div", { className: "fundamentals-block" },
    React.createElement("div", { className: "eyebrow", style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      React.createElement("span", null, "Key stats & ratios"),
      ai && React.createElement("span", { className: "news-ai-badge" }, "AI"),
      loading && React.createElement("span", { className: "text-xs" }, "Loading\u2026")
    ),
    sectorRow,
    headline.length > 0 && React.createElement("div", { className: "fundamentals-grid headline" },
      headline.map((s, i) => React.createElement("div", { key: 'h' + i, className: "fund-cell" },
        React.createElement("div", { className: "fund-label" }, s.label),
        React.createElement("div", { className: "fund-val mono" + (s.cls ? ' ' + s.cls : '') }, s.value),
        s.sub ? React.createElement("div", { className: "fund-sub" }, s.sub) : null
      ))
    ),
    stats.length > 0 && React.createElement("div", { className: "fundamentals-grid" },
      stats.map((s, i) => React.createElement("div", { key: i, className: "fund-cell" },
        React.createElement("div", { className: "fund-label" }, s.label),
        React.createElement("div", { className: "fund-val mono" }, s.value),
        // `push()` has always taken a sub-line; only the headline grid rendered
        // one, so every sub passed here was silently dropped. It carries the
        // reporting currency and the dividend rate now, which is exactly the
        // context a bare number is ambiguous without.
        s.sub ? React.createElement("div", { className: "fund-sub" }, s.sub) : null
      ))
    ),
    targetSection,
    empty && React.createElement("div", { className: "fundamentals-empty" },
      React.createElement("div", null,
        "Couldn't load fundamentals right now. The free data sources sometimes rate-limit or block the shared proxies; a Perplexity API key (Alerts panel) adds an AI-sourced fallback."
      ),
      onRetry && React.createElement("button", {
        className: "btn btn-ghost btn-xs",
        style: { marginTop: 8 },
        onClick: onRetry
      }, "Retry")
    )
  );
}
// Inline "add to watchlist(s)" control shown inside the stock card. A stock can
// live in several lists at once, so the panel is multi-select: each list row is a
// toggle (checkbox) the user can tick on/off independently. The common case stays
// one tap — no custom lists and not yet tracked → tapping just adds to the
// built-in list — while power users file a stock into any combination of lists
// from the card they already have open.
function WatchlistControl(_refWL) {
  const { Icon, watchListIds } = window.PBApp;
  let { ticker, market, name, watchlist, watchlistGroups, onAddWatch, onRemoveWatch, onMoveWatch, onToggleWatchList, onAddWatchGroup } = _refWL;
  const item = (watchlist || []).find(w => w.ticker === ticker && w.market === market) || null;
  const watching = !!item;
  const memberIds = item ? watchListIds(item) : [];
  const groups = watchlistGroups || [];
  const lists = [{ id: 'default', name: 'Watchlist' }, ...groups];
  const hasCustom = groups.length > 0;
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  // Custom lists this stock sits in — drives the subtitle on the toggle so the
  // user can see at a glance where it's filed without opening the panel.
  const customMemberNames = memberIds
    .filter(id => id !== 'default')
    .map(id => (lists.find(l => l.id === id) || {}).name)
    .filter(Boolean);
  const closePanel = () => { setOpen(false); setCreating(false); setNewName(''); };
  // Toggle membership in one list. onToggleWatchList handles create-on-first-add
  // and drop-when-last-removed; the panel stays open so several can be ticked.
  const toggle = (listId) => {
    if (onToggleWatchList) onToggleWatchList(ticker, market, name || null, listId);
    else if (!memberIds.includes(listId)) onAddWatch(ticker, market, name || null, listId);
  };
  const handleMainClick = () => {
    // Nothing to choose between (no custom lists, not yet tracked) → one-tap add.
    if (!watching && !hasCustom) { toggle('default'); return; }
    setOpen(o => !o); setCreating(false);
  };
  const submitNew = () => {
    const nm = newName.trim();
    if (!nm) return;
    const _r = onAddWatchGroup(nm);
    const id = _r && _r.id;
    if (id) toggle(id);
    setCreating(false); setNewName('');
  };
  const removeAll = () => { if (item) onRemoveWatch(item.id); closePanel(); };
  return React.createElement("div", { className: "wl-control" },
    React.createElement("button", {
      className: "wl-toggle" + (watching ? " watching" : ""),
      onClick: handleMainClick, "aria-expanded": open
    },
      React.createElement(Icon, { name: watching ? "checkCircle" : "plus", size: 15 }),
      React.createElement("span", { className: "wl-toggle-label" },
        watching ? "On watchlist" : "Add to watchlist",
        watching && customMemberNames.length ? React.createElement("span", { className: "wl-toggle-list" }, " \xB7 " + customMemberNames.join(', ')) : null),
      (hasCustom || watching) ? React.createElement(Icon, { name: "chevron", size: 14, className: "wl-toggle-caret" + (open ? " open" : "") }) : null),
    open ? React.createElement("div", { className: "wl-panel" },
      React.createElement("div", { className: "wl-panel-head" }, "In which lists"),
      lists.map(l => {
        const inList = memberIds.includes(l.id);
        return React.createElement("button", {
          key: l.id, className: "wl-list-row" + (inList ? " current" : ""),
          onClick: () => toggle(l.id)
        },
          React.createElement("span", { className: "wl-check" + (inList ? " on" : "") },
            inList ? React.createElement(Icon, { name: "check", size: 12 }) : null),
          React.createElement("span", { className: "wl-list-name" }, l.name),
          inList ? React.createElement("span", { className: "wl-list-tag" }, "Added") : null);
      }),
      creating
        ? React.createElement("div", { className: "wl-new-row" },
            React.createElement("input", {
              className: "wl-new-input", type: "text", placeholder: "New list name", value: newName, maxLength: 28,
              autoFocus: true, onChange: e => setNewName(e.target.value),
              onKeyDown: e => { if (e.key === 'Enter') submitNew(); }
            }),
            React.createElement("button", { className: "btn btn-primary btn-sm", onClick: submitNew, disabled: !newName.trim(), style: { flex: '0 0 auto' } }, "Create"))
        : React.createElement("button", { className: "wl-list-row wl-new-trigger", onClick: () => setCreating(true) },
            React.createElement(Icon, { name: "plus", size: 14 }),
            React.createElement("span", { className: "wl-list-name" }, "New list…")),
      watching ? React.createElement("button", { className: "wl-list-row wl-remove", onClick: removeAll },
        React.createElement(Icon, { name: "trash", size: 14 }),
        React.createElement("span", { className: "wl-list-name" }, "Remove from all")) : null) : null
  );
}
// The notes you saved on a holding, shown in the stock card as a collapsible
// dropdown directly beneath the watchlist control — so the context you wrote
// when you bought (thesis, account, "held since…") is one tap away on the card,
// not buried in the edit form.
function HoldingNotesControl(_refHN) {
  const { Icon } = window.PBApp;
  let { notes } = _refHN;
  const [open, setOpen] = useState(false);
  const text = (notes || '').trim();
  if (!text) return null;
  return React.createElement("div", { className: "hn-control" },
    React.createElement("button", {
      className: "wl-toggle hn-toggle", onClick: () => setOpen(o => !o), "aria-expanded": open
    },
      React.createElement(Icon, { name: "edit", size: 15 }),
      React.createElement("span", { className: "wl-toggle-label" }, "Your notes"),
      React.createElement(Icon, { name: "chevron", size: 14, className: "wl-toggle-caret" + (open ? " open" : "") })),
    open ? React.createElement("div", { className: "wl-panel hn-panel" },
      React.createElement("div", { className: "hn-note-text" }, text)) : null
  );
}
// Friendly "as of" date for an indicator reading. FRED monthly series anchor to
// the 1st of the month, so those read as "May 2026"; daily/weekly read in full.
function fmtIndicatorAsOf(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return dateStr;
  return d.getUTCDate() === 1
    ? d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
// The big value + change readout for an indicator card (unit-aware; no currency
// symbol). Shows the previous reading and, for released data (FRED/liquidity),
// the "as of" date so it's clear how fresh the number is.
function IndicatorValueBlock(_refIVB) {
  const { fmtIndicator } = window.PBApp;
  let { indicator, quote } = _refIVB;
  if (!quote) return React.createElement("div", { className: "price-block-wrap" },
    React.createElement("span", { className: "price price-xl mono text-dim" }, "—"));
  const up = quote.change >= 0;
  const flat = !quote.change;
  const hasAsOf = !!quote.asOf;
  const hasPrev = typeof quote.prevClose === 'number' && isFinite(quote.prevClose);
  return React.createElement("div", { className: "price-block-wrap" },
    React.createElement("div", { className: "flex items-baseline gap-2" },
      React.createElement("span", { className: "price price-xl" }, fmtIndicator(indicator, quote.price)),
      !flat && React.createElement("span", { className: `chg ${up ? 'up' : 'down'}` },
        up ? "▲" : "▼", " ", fmtIndicator(indicator, quote.change, { signed: true }))
    ),
    (hasPrev || hasAsOf) && React.createElement("div", { className: "daily-block" },
      React.createElement("div", { className: "daily-col" },
        hasPrev && React.createElement("div", { className: "daily-row prevclose-row" },
          React.createElement("span", { className: "daily-label" }, hasAsOf ? "Previous" : "Prev close"),
          React.createElement("span", { className: "daily-val mono prevclose-val" }, fmtIndicator(indicator, quote.prevClose))),
        hasAsOf && React.createElement("div", { className: "daily-row prevclose-row" },
          React.createElement("span", { className: "daily-label" }, "As of"),
          React.createElement("span", { className: "daily-val mono prevclose-val" }, fmtIndicatorAsOf(quote.asOf)))
      ))
  );
}
// The plain-English "deep dive" for an indicator: what it is, how to read it,
// and a small quick-reference of typical levels.
function IndicatorAbout(_refIA) {
  const { Icon } = window.PBApp;
  let { indicator, info } = _refIA;
  if (!info) return null;
  return React.createElement("div", { className: "indicator-about" },
    React.createElement("div", { className: "indicator-about-head" },
      React.createElement(Icon, { name: "gauge", size: 14 }),
      React.createElement("span", null, "What is ", indicator.label, "?")),
    React.createElement("p", { className: "indicator-about-what" }, info.what),
    React.createElement("div", { className: "indicator-about-sub" }, "How to read it"),
    React.createElement("p", { className: "indicator-about-interpret" }, info.interpret),
    info.levels && info.levels.length > 0 && React.createElement("div", { className: "indicator-levels" },
      info.levels.map((lv, i) => React.createElement("div", { key: i, className: "indicator-level" },
        React.createElement("span", { className: "indicator-level-label" }, lv.label),
        React.createElement("span", { className: "indicator-level-range" }, lv.range)))),
    React.createElement("div", { className: "indicator-about-note" },
      "Educational only — not investment advice."));
}
// Stock / indicator detail card - the app's richest read-only surface (quote,
// position P&L, chart, fundamentals, watchlist, notes, news + a price-alert
// popup via ReactDOM.createPortal). Display + delegate only; mutations are props.
function DetailModal(_ref10) {
  const { Icon, useBodyScrollLock, prettyName, resolveTickerName, fmt, fmtCcy, fmtCcySigned, fmtIndicator, indicatorFor, timeAgo, PriceBlock, sanitizeDecimalInput } = window.PBApp;
  let {
    selected,
    positions,
    watchlist,
    watchlistGroups,
    alerts,
    news,
    historyByTicker,
    fundamentals,
    fxRates,
    onClose,
    onAddWatch,
    onRemoveWatch,
    onMoveWatch,
    onToggleWatchList,
    onAddWatchGroup,
    onAddAlert,
    onRemoveAlert,
    onLoadNews,
    onLoadHistory,
    onRetryFundamentals
  } = _ref10;
  const prices = PBStore.usePricesMap();
  const {
    ticker,
    market
  } = selected;
  const liveQuote = prices[priceKey(market, ticker)];
  // Stocks opened from the heatmap / picks aren't in the main price feed, so
  // fetch their quote on demand — this gives the detail its price, change and
  // company name instead of just a bare ticker.
  const [fetchedQuote, setFetchedQuote] = useState(null);
  useEffect(() => {
    setFetchedQuote(null);
    if (!liveQuote) {
      let alive = true;
      fetchQuote(ticker, market).then(q => { if (alive && q) setFetchedQuote(q); });
      return () => { alive = false; };
    }
  }, [ticker, market]);
  const quote = liveQuote || fetchedQuote;
  const pos = positions ? positions.find(p => p.ticker === ticker && p.market === market) : null;
  // Macro/market indicators (10Y yield, DXY, CPI, Fear & Greed, …) reuse this
  // card but in "indicator mode": unit-aware value, a plain-English explanation,
  // and price triggers — no position, watchlist, fundamentals or news.
  const indicator = indicatorFor(market, ticker);
  const isIndicator = !!indicator;
  const info = isIndicator ? INDICATOR_INFO[indicator.key] : null;
  // The number a fresh price-trigger pre-fills to (indicator unit precision for
  // indicators, 2dp for ordinary prices).
  const defaultTarget = (q) => q ? q.price.toFixed(isIndicator ? indicator.decimals : 2) : '';
  // Name resolution prefers the name saved on the holding, then the live quote /
  // curated lists. Null (never the bare ticker) so the subtitle doesn't echo the
  // ticker that's already the card's heading.
  const displayName = isIndicator ? indicator.label
    : ((pos && pos.name) ? prettyName(pos.name) : (resolveTickerName(ticker, market, quote) || null));
  // A unit trust has no ticker symbol — its "ticker" is an opaque Morningstar id,
  // so the fund name (not the id) is the card's heading and the subtitle drops
  // the duplicate name, leaving just the market badge.
  const isUnitTrust = !isIndicator && isUnitTrustId(ticker);
  const headTitle = isIndicator ? indicator.short : (isUnitTrust && displayName ? displayName : ticker);
  const subName = isUnitTrust ? null : displayName;
  const ccy = marketCurrency(market);
  // Price-trigger formatting: indicators show their own unit (e.g. "4.45%",
  // "F&G 20", "$18.05T") instead of a currency symbol.
  const alertPrefix = isIndicator ? (indicator.unit === 'usd_t' ? '$' : '') : (CURRENCY_SYMBOLS[ccy] || '$');
  const fmtAlertTarget = (v) => isIndicator ? fmtIndicator(indicator, v) : ((CURRENCY_SYMBOLS[ccy] || '$') + v.toFixed(2));
  const [dir, setDir] = useState('above');
  const [target, setTarget] = useState(defaultTarget(quote));
  const [note, setNote] = useState('');
  const [range, setRange] = useState(isIndicator ? (indicator.defaultRange || '1y') : '1y');
  const [showAlertForm, setShowAlertForm] = useState(!!selected.openAlerts);
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  const history = historyByTicker ? historyByTicker[priceKey(market, ticker) + ':' + range] : null;
  useEffect(() => {
    if (quote && !target) setTarget(defaultTarget(quote));
  }, [quote]);
  useEffect(() => {
    if (onLoadHistory) onLoadHistory(range);
  }, [range]);
  const submitAlert = () => {
    const t = parseDecimal(target);
    if (!isFinite(t)) return;
    if (!isIndicator && t <= 0) return; // prices are positive; indicator targets can be 0+
    onAddAlert(ticker, market, dir, t, note);
    setNote('');
  };
  return React.createElement("div", {
    className: "modal",
    onClick: e => {
      if (e.target.classList.contains('modal')) onClose();
    }
  }, React.createElement("div", {
    className: "modal-backdrop",
    onClick: onClose
  }), React.createElement("div", {
    className: "modal-panel stock-detail-panel",
    ref: panelRef
  }, React.createElement("div", {
    className: "modal-handle"
  }), React.createElement("div", {
    className: "modal-header"
  }, React.createElement("div", { style: { minWidth: 0 } }, React.createElement("div", {
    className: "modal-title"
  }, headTitle), React.createElement("div", {
    className: "modal-subtitle"
  }, subName ? React.createElement(React.Fragment, null, subName, " \xB7 ") : null, React.createElement("span", {
    className: "market-badge"
  }, isIndicator ? "Indicator" : (isUnitTrust ? "Unit trust" : market)))), React.createElement("button", {
    className: "modal-close",
    onClick: onClose,
    "aria-label": "Close"
  }, React.createElement(Icon, {
    name: "x"
  }))), React.createElement("div", {
    className: "modal-body"
  }, 
    React.createElement("div", { style: { position: 'relative' } },
      isIndicator
        ? React.createElement(IndicatorValueBlock, { indicator: indicator, quote: quote })
        : React.createElement(PriceBlock, { quote: quote, size: "xl", showDailyRow: true, market: market }),
      React.createElement("button", {
        className: "detail-alert-bell",
        onClick: () => {
          // Open the alert popup fresh each time — same behaviour as the
          // watchlist bell (openAlertPopup): default to "above" and pre-fill
          // the current price so it's consistent across the app.
          setDir('above');
          setTarget(defaultTarget(quote));
          setNote('');
          setShowAlertForm(true);
        },
        "aria-label": "Price alerts"
      }, React.createElement(Icon, { name: "bell", size: 16 }),
        alerts.length > 0 && React.createElement("span", { className: "detail-alert-count" }, alerts.length))
    ),

    // Plain-English explanation — the "deep dive" that helps a retail investor
    // understand what this indicator means and how to read it.
    info && React.createElement(IndicatorAbout, { indicator: indicator, info: info }),

    !isIndicator && onAddWatch ? React.createElement(WatchlistControl, {
      ticker: ticker, market: market, name: displayName,
      watchlist: watchlist, watchlistGroups: watchlistGroups,
      onAddWatch: onAddWatch, onRemoveWatch: onRemoveWatch,
      onMoveWatch: onMoveWatch, onToggleWatchList: onToggleWatchList, onAddWatchGroup: onAddWatchGroup
    }) : null,

    // Notes you left on this holding — collapsible, just below the watchlist box.
    !isIndicator && pos && pos.notes ? React.createElement(HoldingNotesControl, { notes: pos.notes }) : null,

    !isIndicator && pos && quote && (() => {
      // A plain top-to-bottom list reads far more clearly than a 3×2 grid:
      // label on the left, value on the right, one fact per line. The two
      // figures users care about most — what they paid vs. what it's worth now —
      // sit together under a divider with the clearer "Purchase value" /
      // "Current value" wording, with Profit / Loss as the bottom line.
      // Value the position in its cost currency (native for normal holdings, the
      // fiat the user paid for crypto bought in ZAR), so every line reads in one
      // coherent currency and the price-vs-cost % is meaningful.
      const rates = fxRates?.rates || null;
      const val = valuePositionInCostCcy(pos, quote, rates);
      const posCcy = val.ccy;
      const curPriceInCcy = posCcy === val.native
        ? quote.price
        : convertCcy(quote.price, val.native, posCcy, rates);
      const purchaseValue = val.cost;
      const currentValue = val.value;
      const pl = val.gain;
      const plPct = val.gainPct != null ? val.gainPct : 0;
      const isCryptoPos = pos.market === 'CRYPTO';
      const posLine = (label, value, opts) => React.createElement("div", {
        className: "pos-line" + ((opts && opts.sep) ? " pos-line-sep" : "") + ((opts && opts.strong) ? " pos-line-strong" : "")
      },
        React.createElement("span", { className: "pos-line-label" }, label),
        React.createElement("span", { className: "pos-line-val mono" + ((opts && opts.cls) ? " " + opts.cls : "") }, value));
      return React.createElement("div", { className: "holding-card" },
        React.createElement("div", { className: "eyebrow" }, "Your position"),
        React.createElement("div", { className: "pos-list" },
          posLine(isCryptoPos ? "Amount" : "Shares", pos.shares),
          posLine(isCryptoPos ? "Avg cost" : "Avg price", fmtCcy(pos.costBasis, posCcy)),
          posLine("Current price", curPriceInCcy != null ? fmtCcy(curPriceInCcy, posCcy) : fmt(quote.price, market)),
          posLine("Purchase value", currentValue != null ? fmtCcy(purchaseValue, posCcy) : "—", { sep: true }),
          posLine("Current value", currentValue != null ? fmtCcy(currentValue, posCcy) : "—"),
          posLine("Profit / Loss",
            React.createElement(React.Fragment, null,
              fmtCcySigned(pl, posCcy), " (", plPct >= 0 ? '+' : '', plPct.toFixed(1), "%)"),
            { strong: true, cls: (pl != null && pl >= 0) ? 'text-up' : 'text-down' })
        )
      );
    })(),

    !isIndicator && quote && quote.yearHigh ? React.createElement("div", {
      className: "ath-strip"
    }, React.createElement("span", { className: "eyebrow" }, "52W High"),
      React.createElement("span", { className: "mono" }, fmt(quote.yearHigh, market)),
      React.createElement("span", {
        className: `mono ${quote.price >= quote.yearHigh * 0.995 ? 'text-up' : 'text-muted'}`
      }, quote.price >= quote.yearHigh * 0.995 ? 'At high' : ((quote.price - quote.yearHigh) / quote.yearHigh * 100).toFixed(2) + '%')) : null,
    !isIndicator && React.createElement(EarningsBadge, { fundamentals: fundamentals }),
    React.createElement(PriceChart, {
      history: history, loading: history?.loading,
      range: range, onRangeChange: setRange,
      currency: quote?.currency || ccy,
      quote: quote,
      indicator: indicator,
      rangeKeys: isIndicator ? indicator.chartRanges : null,
      onRetry: () => { if (onLoadHistory) onLoadHistory(range); }
    }),
    !isIndicator && React.createElement(FundamentalsBlock, { fundamentals: fundamentals, quote: quote, market: market, fxRates: fxRates, onRetry: onRetryFundamentals }),

    // Price alerts open as a centered popup — the same dialog the watchlist
    // bell shows — for a consistent experience across the app. Rendered through
    // a portal to document.body so it isn't trapped inside the detail panel's
    // transformed (will-change) scroll container, and elevated above the modal.
    showAlertForm && ReactDOM.createPortal(
      React.createElement("div", { className: "alert-popup-overlay alert-popup-elevated" },
        React.createElement("div", { className: "alert-popup-backdrop", onClick: () => setShowAlertForm(false) }),
        React.createElement("div", { className: "alert-popup-panel" },
          React.createElement("div", { className: "alert-popup-header" },
            React.createElement("div", null,
              React.createElement("div", { className: "modal-title" }, headTitle),
              React.createElement("div", { className: "modal-subtitle" }, "Price alerts \xB7 ", React.createElement("span", { className: "market-badge" }, isIndicator ? "Indicator" : market))),
            React.createElement("button", { className: "modal-close", onClick: () => setShowAlertForm(false), "aria-label": "Close" },
              React.createElement(Icon, { name: "x" }))),
          alerts.length > 0 && React.createElement("div", {
            style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }
          }, alerts.map(a => React.createElement("div", {
            key: a.id, className: "alert-item"
          }, React.createElement("div", null,
            React.createElement("div", { className: "mono text-sm" },
              a.direction === 'above' ? '↑ above ' : '↓ below ', isIndicator ? fmtAlertTarget(a.targetPrice) : fmt(a.targetPrice, market)),
            a.note && React.createElement("div", { className: "text-xs text-dim mt-1" }, a.note)),
            React.createElement("button", {
              className: "btn btn-ghost btn-xs",
              onClick: () => onRemoveAlert(a.id), "aria-label": "Remove"
            }, React.createElement(Icon, { name: "x", size: 12 }))))),
          React.createElement("div", { className: "alert-form" },
            React.createElement("div", { className: "alert-dir-group", role: "radiogroup", "aria-label": "Trigger direction" },
              React.createElement("button", {
                type: "button", role: "radio", "aria-checked": dir === 'above',
                className: `alert-dir-btn up ${dir === 'above' ? 'active' : ''}`,
                onClick: () => setDir('above')
              }, React.createElement("span", { className: "alert-dir-arrow" }, "↑"),
                React.createElement("span", { className: "alert-dir-label" }, "Above")),
              React.createElement("button", {
                type: "button", role: "radio", "aria-checked": dir === 'below',
                className: `alert-dir-btn down ${dir === 'below' ? 'active' : ''}`,
                onClick: () => setDir('below')
              }, React.createElement("span", { className: "alert-dir-arrow" }, "↓"),
                React.createElement("span", { className: "alert-dir-label" }, "Below"))
            ),
            React.createElement("div", { className: "alert-target-row" },
              React.createElement("div", { className: "input-prefix-wrap alert-target-wrap" },
                React.createElement("span", { className: "prefix" }, alertPrefix),
                React.createElement("input", {
                  type: "text", inputMode: "decimal",
                  autoComplete: "off", autoCorrect: "off", spellCheck: false,
                  placeholder: isIndicator ? "Target value" : "Target price", value: target,
                  onChange: e => setTarget(sanitizeDecimalInput(e.target.value)),
                  className: "alert-target-input"
                }))),
            React.createElement("input", {
              type: "text", placeholder: "Note (optional)",
              value: note, onChange: e => setNote(e.target.value),
              maxLength: "80", className: "alert-note-input"
            }),
            React.createElement("button", {
              className: `btn btn-block mt-3 alert-submit ${dir === 'above' ? 'up' : 'down'}`,
              onClick: submitAlert
            }, React.createElement(Icon, { name: "plus" }),
              " Alert when ", dir === 'above' ? 'above ' : 'below ',
              target && isFinite(parseDecimal(target)) ? fmtAlertTarget(parseDecimal(target)) : 'target')))),
      document.body
    ),

    !isIndicator && React.createElement("div", null, React.createElement("div", {
      className: "eyebrow",
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
    }, React.createElement("span", null, "News"), news?.loading && React.createElement("span", {
      className: "text-xs"
    }, "Loading…")), news && news.data && news.data.length > 0 ? React.createElement("div", null, news.data.map((n, i) => React.createElement("a", {
      key: i,
      href: n.link && n.link !== '#' ? n.link : undefined,
      target: "_blank", rel: "noopener",
      className: `news-item${n.ai ? ' news-item-ai' : ''}`
    }, React.createElement("div", { className: "news-title" },
      n.ai && React.createElement("span", { className: "news-ai-badge" }, "AI"), n.title),
      n.summary && React.createElement("div", { className: "news-summary" }, n.summary),
      React.createElement("div", { className: "news-meta" },
        React.createElement("span", null, n.source),
        n.pubDate && React.createElement(React.Fragment, null,
          React.createElement("span", null, "·"),
          React.createElement("span", null, timeAgo(n.pubDate))),
        React.createElement(Icon, { name: "external", size: 11 }))))) : React.createElement("div", {
      className: "text-sm text-dim"
    }, news?.loading ? 'Fetching headlines…' : 'No recent headlines found. Yahoo Finance RSS may be rate-limited — try again later.')))));
}
// AlertsModal (moved from app.js, Phase 4 inc 18) — price-trigger + triggered-history sheet.
// Pure display/delegate: removes/clears alerts and requests notification permission through
// props; alert evaluation + money math stay in pb-core. Deps reached via the PBApp bridge.
function AlertsModal(_ref11) {
  const { Icon, fmt, timeAgo, useBodyScrollLock } = window.PBApp;
  let {
    alerts,
    triggered,
    notifPerm,
    onClose,
    onRemoveAlert,
    onClearTriggered,
    onRequestPerm,
    onOpenDetail
  } = _ref11;
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  // Tapping a trigger or alert jumps straight to that company's chart. Close the
  // sheet first so the detail card opens cleanly on top of the dashboard.
  const openChart = (ticker, market) => {
    if (!onOpenDetail) return;
    onClose();
    onOpenDetail(ticker, market);
  };
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  const iOSNeedsInstall = isIOS && !standalone;
  const recentTriggered = triggered.slice(0, 30);
  return React.createElement("div", {
    className: "modal"
  }, React.createElement("div", {
    className: "modal-backdrop",
    onClick: onClose
  }), React.createElement("div", {
    className: "modal-panel",
    ref: panelRef
  }, React.createElement("div", {
    className: "modal-handle"
  }), React.createElement("div", {
    className: "modal-header"
  }, React.createElement("div", null, React.createElement("div", {
    className: "modal-title"
  }, "Alerts"), React.createElement("div", {
    className: "modal-subtitle"
  }, "Price triggers \xB7 triggered history")), React.createElement("button", {
    className: "modal-close",
    onClick: onClose,
    "aria-label": "Close"
  }, React.createElement(Icon, {
    name: "x"
  }))), React.createElement("div", {
    className: "modal-body"
  }, iOSNeedsInstall ? React.createElement("div", {
    className: "perm-box warn"
  }, React.createElement("div", {
    className: "perm-title"
  }, React.createElement(Icon, {
    name: "alert",
    size: 14
  }), " iOS: install to Home Screen first"), React.createElement("div", {
    className: "perm-body"
  }, "iPhone notifications only work from a home-screen-installed PWA (iOS 16.4+). Tap the Share button in Safari, then \"Add to Home Screen\", then reopen from the home screen and enable notifications.")) : notifPerm === 'default' ? React.createElement("div", {
    className: "perm-box"
  }, React.createElement("div", {
    className: "perm-title"
  }, React.createElement(Icon, {
    name: "bell",
    size: 14
  }), " Enable notifications"), React.createElement("div", {
    className: "perm-body"
  }, "Get a push when a price crosses your target. In-app alerts also fire as toasts while the app is open."), React.createElement("button", {
    className: "btn btn-primary",
    onClick: onRequestPerm
  }, React.createElement(Icon, {
    name: "bell"
  }), " Enable notifications")) : notifPerm === 'granted' ? React.createElement("div", {
    className: "perm-box ok"
  }, React.createElement("div", {
    className: "perm-title"
  }, React.createElement(Icon, {
    name: "checkCircle",
    size: 14
  }), " Notifications enabled"), React.createElement("div", {
    className: "perm-body"
  }, "Alerts fire while the app is open, and in the background when it's installed to your home screen — Android/Chrome checks your alerts periodically even when the app is closed. On iPhone, background checks aren't supported, so keep the app recently used for lock-screen delivery.")) : notifPerm === 'denied' ? React.createElement("div", {
    className: "perm-box err"
  }, React.createElement("div", {
    className: "perm-title"
  }, React.createElement(Icon, {
    name: "x",
    size: 14
  }), " Notifications blocked"), React.createElement("div", {
    className: "perm-body"
  }, "You previously blocked notifications. Re-enable in Settings \u2192 Notifications \u2192 Playbook (or Safari).")) : React.createElement("div", {
    className: "perm-box warn"
  }, React.createElement("div", {
    className: "perm-title"
  }, "Notifications not supported"), React.createElement("div", {
    className: "perm-body"
  }, "This browser doesn't support web notifications. Alerts will still show as in-app toasts.")),
    React.createElement("div", null, React.createElement("div", {
    className: "eyebrow",
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    }
  }, React.createElement("span", null, "Triggered (", triggered.length, ")"), triggered.length > 0 && React.createElement("button", {
    className: "btn btn-ghost btn-xs",
    onClick: () => {
      if (confirm('Clear all triggered history?')) onClearTriggered();
    }
  }, "Clear all")), triggered.length === 0 ? React.createElement("div", {
    className: "text-sm text-dim"
  }, "No alerts have triggered yet.") : React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, recentTriggered.map(t => React.createElement("div", {
    key: t.id,
    className: "alert-item alert-item-tap",
    role: "button",
    tabIndex: 0,
    "aria-label": `Open ${t.ticker} chart`,
    onClick: () => openChart(t.ticker, t.market),
    onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChart(t.ticker, t.market); } }
  }, React.createElement("div", null, React.createElement("div", null, React.createElement("span", {
    className: "tkr-sm"
  }, t.ticker), " ", React.createElement("span", {
    className: "market-badge"
  }, t.market), " ", React.createElement("span", {
    className: "mono text-sm"
  }, t.direction === 'above' ? '↑ ' : '↓ ', fmt(t.targetPrice, t.market))), React.createElement("div", {
    className: "text-xs text-dim mt-1"
  }, timeAgo(t.triggeredAt), " \xB7 hit at ", fmt(t.triggerPrice, t.market))), React.createElement(Icon, {
    name: "chevron", size: 15, className: "alert-item-go"
  }))))), React.createElement("div", null, React.createElement("div", {
    className: "eyebrow"
  }, "Active (", alerts.length, ")"), alerts.length === 0 ? React.createElement("div", {
    className: "text-sm text-dim"
  }, "No active alerts. Tap any ticker to set one.") : React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, alerts.map(a => React.createElement("div", {
    key: a.id,
    className: "alert-item alert-item-tap",
    role: "button",
    tabIndex: 0,
    "aria-label": `Open ${a.ticker} chart`,
    onClick: () => openChart(a.ticker, a.market),
    onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChart(a.ticker, a.market); } }
  }, React.createElement("div", null, React.createElement("div", null, React.createElement("span", {
    className: "tkr-sm"
  }, a.ticker), " ", React.createElement("span", {
    className: "market-badge"
  }, a.market)), React.createElement("div", {
    className: "mono text-sm"
  }, a.direction === 'above' ? '↑ above ' : '↓ below ', fmt(a.targetPrice, a.market)), a.note && React.createElement("div", {
    className: "text-xs text-dim mt-1"
  }, a.note)), React.createElement("button", {
    className: "btn btn-ghost btn-xs",
    onClick: e => { e.stopPropagation(); onRemoveAlert(a.id); },
    "aria-label": "Remove"
  }, React.createElement(Icon, {
    name: "x",
    size: 12
  })))))))));
}
function ImportModal({ onClose, onImport, defaultMarket }) {
  const { Icon, fmt, uid, sanitizeDecimalInput, resolveTickerName, useBodyScrollLock, TickerSearch, parseImportFile, ocrImageFile, searchListingsMulti } = window.PBApp;
  const DATA = window.PB_DATA; // data.js loads after this bucket - read at render time
  const todayISO = new Date().toISOString().slice(0, 10);
  const [stage, setStage] = useState('input'); // 'input' | 'review'
  const [rows, setRows] = useState([]);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [importing, setImporting] = useState(false);
  // The market the user expects these holdings to live on. It biases every
  // name→listing match (e.g. "Anglo American" → AGL.JO on JSE vs AAL.L on LSE).
  const [chosenMarket, setChosenMarket] = useState(defaultMarket || 'US');
  // Sector the user picks for a row the classifier can't place ("Other"). Saved
  // to the persistent sector cache on import so it's remembered next time.
  const [sectorByRow, setSectorByRow] = useState({});
  // On-device OCR of Easy Equities screenshots: progress + status while reading.
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrStep, setOcrStep] = useState('');
  const [ocrError, setOcrError] = useState('');
  // Confirm before discarding a review in progress (only the X button can close
  // the review stage — swipe and backdrop are disabled there).
  const [confirmClose, setConfirmClose] = useState(false);
  const fileRef = useRef(null);
  const imgRef = useRef(null);
  const panelRef = useRef(null);
  // Swipe-to-dismiss only on the input stage; the review stage is locked so
  // scrolling the matches can never flick the sheet closed.
  useSwipeDownToClose(panelRef, onClose, stage === 'input');
  useBodyScrollLock();
  // The X (and any close intent) prompts when there's a review in flight.
  const requestClose = () => {
    if (stage === 'review' && rows.length > 0 && !importing) setConfirmClose(true);
    else onClose();
  };

  const toRows = (holdings, market) => holdings.map(h => ({
    id: uid(),
    query: h.query || '',
    tickerHint: h.tickerHint || null,
    market: h.marketHint || market,
    // The import row explicitly named its market (a ticker exchange suffix or an
    // exchange/market column) — so the matcher must stay on it and never drift to
    // a foreign cross-listing.
    marketExplicit: !!h.marketHint,
    ticker: '',                 // resolved live symbol
    resolvedName: h.nameHint || h.query || '',
    candidates: [],
    shares: h.shares != null ? String(h.shares) : '',
    costBasis: h.costBasis != null ? String(h.costBasis) : '',
    purchaseDate: h.purchaseDate || '',
    status: null,               // null | 'resolving' | 'ok' | 'notfound'
    currentPrice: null,
    include: true,
    showAlts: false,
  }));

  const handleParsed = (holdings) => {
    if (!holdings || holdings.length === 0) {
      setParseError("Couldn't find anything to import. Paste a list of company names (one per line) — e.g. \"Broadcom\", \"Naspers\" — or broker rows like \"Broadcom, 10, 800\".");
      return;
    }
    const r = toRows(holdings, chosenMarket);
    setRows(r);
    setStage('review');
    setParseError('');
    resolveRows(r);
  };

  const isImageFile = (f) => !!f && (/^image\//.test(f.type) || /\.(png|jpe?g|webp|heic|heif|bmp|gif)$/i.test(f.name || ''));

  const handleFiles = async (files) => {
    const file = files && files[0];
    if (!file) return;
    // Screenshots (Easy Equities holdings) route to the on-device OCR path; every
    // other file type (CSV / XLSX / PDF / text) goes through the native parsers.
    if (isImageFile(file)) return handleScreenshots(files);
    setParsing(true); setParseError('');
    try {
      const holdings = await parseImportFile(file);
      handleParsed(holdings);
    } catch (e) {
      setParseError(e?.message || 'Could not read that file. Try CSV, XLSX, or paste the rows instead.');
    } finally {
      setParsing(false);
    }
  };

  // OCR one or more Easy Equities screenshots in-browser, then hand the extracted
  // holdings to the same review flow as a pasted list. Each detail screenshot
  // yields one holding; a portfolio-list screenshot can yield several.
  const handleScreenshots = async (files) => {
    const imgs = Array.from(files || []).filter(isImageFile);
    if (!imgs.length) return;
    setOcrBusy(true); setOcrError(''); setParseError(''); setOcrProgress(0);
    try {
      const all = [];
      for (let k = 0; k < imgs.length; k++) {
        setOcrStep(imgs.length > 1 ? `Reading screenshot ${k + 1} of ${imgs.length}…` : 'Reading screenshot…');
        setOcrProgress(0);
        const { text, headerText } = await ocrImageFile(imgs[k], p => setOcrProgress(p));
        // Each holding's market comes from the screenshot's own EXCHANGE field,
        // falling back to the market the user started from (defaultMarket). The
        // dedicated title-bar read (headerText) gives the cleanest full name.
        all.push(...parseEasyEquitiesScreenshot(text, defaultMarket, { headerText }));
      }
      if (!all.length) {
        setOcrError("Couldn't read any holdings from those images. Use an Easy Equities holding page (“# Shares” + “Avg. Purchase Price”), a trade confirmation, a transaction-history row, or your portfolio list — and crop out anything else.");
        return;
      }
      // The same trade can arrive twice — its emailed broker note and its
      // transaction-history row — so collapse duplicates before review, otherwise
      // the per-ticker merge on commit would double the position.
      const deduped = dedupeEeHoldings(all);
      // Highlight the market most rows landed on (their detected exchange, else
      // the tab the user started from) so the review chips match.
      const mk = deduped.find(h => h.marketHint)?.marketHint;
      if (mk) setChosenMarket(mk);
      handleParsed(deduped);
    } catch (e) {
      setOcrError(e?.message || 'Could not read those screenshots. Try again, or paste your holdings instead.');
    } finally {
      setOcrBusy(false); setOcrStep(''); setOcrProgress(0);
    }
  };

  const handlePaste = () => {
    if (!pasteText.trim()) return;
    setParsing(true); setParseError('');
    try {
      handleParsed(parseHoldingsFromText(pasteText));
    } catch (e) {
      setParseError('Could not parse that text.');
    } finally {
      setParsing(false);
    }
  };

  // Resolve one row: search live listings by the company name, rank with the
  // chosen market biasing the pick, then confirm with a real quote. Falls back
  // to the bare ticker hint and to other-market candidates so a name still
  // resolves even when its primary listing isn't on the chosen exchange.
  const resolveRow = async (r) => {
    const market = r.market;
    const remote = await searchListingsMulti(r.query, r.tickerHint, market).catch(() => []);
    const ranked = rankImportCandidates(r.query, r.tickerHint, market, remote);
    // A symbol-like query / hint is the user's intended ticker on the chosen
    // market. Try the chosen market first and only drift off-market as a last
    // resort, so a US ticker is never booked as its European cross-listing (EUR).
    const symHint = (r.tickerHint && looksLikeTickerToken(r.tickerHint)) ? String(r.tickerHint).toUpperCase()
                  : (looksLikeTickerToken(r.query) ? String(r.query).toUpperCase() : null);
    // Which listings to try, in order (pure — pb-import.js, unit-tested there).
    // A live JSE result counts as on-market for a TFSA row and is re-tagged to
    // TFSA, so the holding lands in the account the user chose.
    const attempts = buildImportAttempts(ranked, { market, marketExplicit: r.marketExplicit, symHint });
    let pick = null, q = null;
    for (const c of attempts.slice(0, 6)) {
      const cq = await fetchQuote(c.ticker, c.market).catch(() => null);
      if (cq) { pick = c; q = cq; break; }
    }
    // Confidence = how well the matched listing's name fits the query. Low
    // confidence (or a pick that landed off the chosen market) is surfaced so
    // the user can sanity-check or pick an alternative.
    // Name priority: the candidate's own name → the search result for that exact
    // listing (clean "Vanguard S&P 500 ETF"-style names) → the live quote's name →
    // the query. The middle step matters for ticker/symbol imports where `pick` is
    // a bare-symbol attempt with no name, so ETFs don't show a cryptic quote name.
    // Same-venue match (JSE result on a TFSA row), so the ranked entry is found by
    // underlying exchange — `pick.market` may have been re-tagged to the row's own.
    const matchedCand = pick ? ranked.find(c => c.ticker === pick.ticker && sameUnderlyingExchange(c.market, pick.market)) : null;
    const resolvedName = q && pick
      ? (pick.name || (matchedCand && matchedCand.name) || resolveTickerName(pick.ticker, pick.market, q) || r.query)
      : r.resolvedName;
    const conf = q && pick ? (pick.nameScore != null ? pick.nameScore : companyNameScore(r.query, resolvedName)) : 0;
    const offMarket = !!(q && pick && !sameUnderlyingExchange(pick.market, market));
    return {
      ticker: q && pick ? pick.ticker : (r.tickerHint || ''),
      market: q && pick ? pick.market : market,
      resolvedName,
      currentPrice: q ? q.price : null,
      status: q ? 'ok' : 'notfound',
      confidence: conf,
      lowConfidence: !!(q && (conf < 0.5 || offMarket)),
      candidates: ranked.slice(0, 7),
      // A fresh auto-match supersedes any earlier hand-forced listing on this row.
      manual: false,
    };
  };

  const resolveRows = async (list) => {
    setResolving(true);
    setRows(prev => prev.map(x => list.some(l => l.id === x.id) ? { ...x, status: 'resolving' } : x));
    let i = 0;
    const worker = async () => {
      while (i < list.length) {
        const r = list[i++];
        if (!r.query.trim()) { setRows(prev => prev.map(x => x.id === r.id ? { ...x, status: 'notfound' } : x)); continue; }
        const res = await resolveRow(r);
        setRows(prev => prev.map(x => x.id === r.id ? { ...x, ...res } : x));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
    setResolving(false);
  };

  const updateRow = (id, patch) => setRows(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));
  const removeRow = (id) => setRows(prev => prev.filter(r => r.id !== id));

  // Re-resolve a single row (after the user edits its search text or market).
  const reResolveRow = async (id) => {
    let target = null;
    setRows(prev => prev.map(r => { if (r.id === id) { target = r; return { ...r, status: 'resolving' }; } return r; }));
    if (!target) return;
    const res = await resolveRow({ ...target, status: 'resolving' });
    setRows(prev => prev.map(r => r.id === id ? { ...r, ...res } : r));
  };

  // User explicitly picks one of the alternative listings (or forces a symbol via
  // the manual search). This is the user asserting knowledge the matcher lacks, so
  // it is never overruled: the listing they picked stays on the row even when the
  // live feed can't confirm it — that lands as 'unverified' (importable, flagged)
  // rather than 'notfound' (blocked). Picking a same-venue listing (a JSE result on
  // a TFSA row) keeps the account the row is already on.
  const chooseCandidate = async (id, cand) => {
    const row = rows.find(r => r.id === id);
    const market = (row && sameUnderlyingExchange(cand.market, row.market)) ? row.market : cand.market;
    setRows(prev => prev.map(r => r.id === id ? { ...r, ticker: cand.ticker, market, resolvedName: cand.name, status: 'resolving', showAlts: false, lowConfidence: false } : r));
    const q = await fetchQuote(cand.ticker, market).catch(() => null);
    setRows(prev => prev.map(r => r.id === id ? {
      ...r,
      status: q ? 'ok' : 'unverified',
      manual: true,
      currentPrice: q ? q.price : null,
      lowConfidence: false,
      resolvedName: q ? (resolveTickerName(cand.ticker, market, q) || cand.name) : (cand.name || r.resolvedName),
    } : r));
  };

  // "Add anyway" on a row the live search couldn't match: the user knows the
  // listing exists (a brand-new ETF, a feed outage, a symbol Yahoo doesn't carry),
  // so let them commit it. Uses whatever symbol the row already carries — a hand-
  // picked one, the broker's ticker hint, or a symbol-shaped query — and only falls
  // back to opening the manual search when there's genuinely no symbol to force.
  const forceRow = (id) => {
    const r = rows.find(x => x.id === id);
    if (!r) return;
    const sym = (r.ticker || '').trim() || (looksLikeTickerToken(r.query) ? String(r.query).trim().toUpperCase() : '');
    if (!sym) { updateRow(id, { manualSearch: true, showAlts: false }); return; }
    updateRow(id, {
      ticker: sym.toUpperCase(),
      status: 'unverified',
      manual: true,
      lowConfidence: false,
      currentPrice: null,
      resolvedName: r.resolvedName || r.query || sym.toUpperCase(),
    });
  };

  // One-tap "these are all JSE / US / …": set the bias market, apply it to every
  // included row, and re-run name matching so each maps to that exchange.
  const setAllMarket = (market) => {
    setChosenMarket(market);
    const next = rows.map(r => r.include ? { ...r, market, status: null, currentPrice: null, ticker: '' } : r);
    setRows(next);
    resolveRows(next.filter(r => r.include));
  };

  const hasShares = (r) => isFinite(parseDecimal(r.shares)) && parseDecimal(r.shares) > 0;
  const hasCost = (r) => isFinite(parseDecimal(r.costBasis)) && parseDecimal(r.costBasis) > 0;
  // A row is "settled on a listing" when the feed confirmed it ('ok') OR the user
  // forced one the feed couldn't confirm ('unverified'). Both import; only the
  // second is flagged as unconfirmed, because the user vouched for it.
  const isSettled = (r) => r.status === 'ok' || r.status === 'unverified';
  // The sector this row will be allocated to in the dashboard — the same static
  // resolution the allocation chart uses (listing map first, then the name), so
  // what the user sees here is exactly where it'll land.
  const sectorForRow = (r) => {
    if (!(isSettled(r) && r.ticker)) return 'Other';
    const f = DATA.findSector(r.ticker, r.market);
    if (f.sector !== 'Other') return f.sector;
    const byName = r.resolvedName ? DATA.classifySectorByName(r.resolvedName) : 'Other';
    return (byName && byName !== 'Other') ? byName : 'Other';
  };
  // The effective sector to commit: an explicit user pick wins, else the detected
  // one (null only when genuinely unknown, so we never persist "Other").
  const effectiveSector = (r) => {
    if (sectorByRow[r.id]) return sectorByRow[r.id];
    const det = sectorForRow(r);
    return det !== 'Other' ? det : null;
  };
  // Importable once the row sits on a listing (feed-confirmed, or hand-forced by
  // the user) with valid qty/cost.
  const validRows = rows.filter(r => r.include && r.ticker.trim() && isSettled(r) && hasShares(r) && hasCost(r));
  const notFoundCount = rows.filter(r => r.include && r.status === 'notfound').length;
  const unverifiedCount = rows.filter(r => r.include && r.status === 'unverified').length;
  const needQtyCount = rows.filter(r => r.include && isSettled(r) && (!hasShares(r) || !hasCost(r))).length;
  // Guard against silent collapse: when two *differently-named* included rows
  // resolve to the same live listing, importing merges them (sums the shares) —
  // the exact failure where several distinct ETFs land on one ticker and the
  // committed value is the sum of unrelated holdings. Flag those rows so the user
  // re-checks the match before committing. (Same name twice is a real averaged
  // buy and is left alone.)
  const collisionKeys = (() => {
    const byKey = {};
    rows.forEach(r => {
      if (!r.include || !isSettled(r) || !r.ticker.trim()) return;
      const k = priceKey(r.market, r.ticker.trim().toUpperCase());
      (byKey[k] = byKey[k] || []).push(r);
    });
    const out = new Set();
    Object.keys(byKey).forEach(k => {
      const list = byKey[k];
      if (list.length > 1 && new Set(list.map(r => normaliseCompanyName(r.query || ''))).size > 1) out.add(k);
    });
    return out;
  })();
  const isCollisionRow = (r) => r.include && isSettled(r) && !!r.ticker.trim() &&
    collisionKeys.has(priceKey(r.market, r.ticker.trim().toUpperCase()));
  const collisionCount = rows.filter(isCollisionRow).length;

  const doImport = async () => {
    if (validRows.length === 0) return;
    setImporting(true);
    try {
      await onImport(validRows.map(r => ({
        ticker: r.ticker.trim().toUpperCase(),
        market: r.market,
        name: r.resolvedName || null,
        shares: parseDecimal(r.shares),
        costBasis: parseDecimal(r.costBasis),
        purchaseDate: r.purchaseDate || null,
        notes: '',
        sector: effectiveSector(r),
      })));
      onClose();
    } finally {
      setImporting(false);
    }
  };

  const renderInput = () => React.createElement("div", { className: "modal-body" },
    React.createElement("div", { className: "import-market-pick" },
      React.createElement("div", { className: "form-label" }, "Which market are these holdings on?"),
      React.createElement("div", { className: "import-bulk-chips" },
        MARKETS.map(m => React.createElement("button", {
          key: m.value, type: "button",
          className: "import-bulk-chip" + (chosenMarket === m.value ? " active" : ""),
          onClick: () => setChosenMarket(m.value),
          title: m.country + " · " + m.exchange
        }, m.label))),
      React.createElement("div", { className: "form-help" }, "Guides name matching — e.g. “Naspers” → NPN on JSE. You can change any row afterwards.")
    ),
    React.createElement("div", { className: "ee-scan" },
      React.createElement("div", { className: "ee-scan-head" },
        React.createElement("div", { className: "ee-scan-badge" }, React.createElement(Icon, { name: "image", size: 18 })),
        React.createElement("div", null,
          React.createElement("div", { className: "ee-scan-title" }, "Scan Easy Equities screenshots"),
          React.createElement("div", { className: "ee-scan-sub" }, "Add holdings from screenshots — read on your device, nothing uploaded."))),
      React.createElement("div", {
        className: "ee-scan-drop" + (ocrBusy ? " busy" : ""),
        onDragOver: e => { e.preventDefault(); },
        onDrop: e => { e.preventDefault(); if (!ocrBusy) handleScreenshots(e.dataTransfer.files); },
        onClick: () => { if (!ocrBusy) imgRef.current?.click(); }
      },
        ocrBusy
          ? React.createElement(React.Fragment, null,
              React.createElement(Icon, { name: "refresh", size: 22, className: "spin" }),
              React.createElement("div", { className: "ee-scan-status" }, ocrStep || "Reading…"),
              React.createElement("div", { className: "ee-scan-bar" },
                React.createElement("div", { className: "ee-scan-bar-fill", style: { width: Math.round(ocrProgress * 100) + "%" } })),
              React.createElement("div", { className: "ee-scan-hint" }, "First scan downloads the on-device reader — a few seconds."))
          : React.createElement(React.Fragment, null,
              React.createElement(Icon, { name: "image", size: 24 }),
              React.createElement("div", { className: "ee-scan-cta" }, "Tap to choose screenshots"),
              React.createElement("div", { className: "ee-scan-hint" }, "Holding pages, trade confirmations, transaction-history rows, or your portfolio list — add several at once.")),
        React.createElement("input", {
          ref: imgRef, type: "file", accept: "image/*", multiple: true,
          style: { display: 'none' },
          onChange: e => { handleScreenshots(e.target.files); e.target.value = ''; }
        })
      ),
      ocrError ? React.createElement("div", { className: "verify-error", style: { marginTop: 8 } }, ocrError) : null
    ),
    React.createElement("div", { className: "import-or" }, React.createElement("span", null, "or import a file")),
    React.createElement("div", {
      className: "import-drop" + (dragOver ? " over" : ""),
      onDragOver: e => { e.preventDefault(); setDragOver(true); },
      onDragLeave: () => setDragOver(false),
      onDrop: e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); },
      onClick: () => fileRef.current?.click()
    },
      React.createElement(Icon, { name: parsing ? "refresh" : "download", size: 26, className: parsing ? "spin" : "" }),
      React.createElement("div", { className: "import-drop-title" }, parsing ? "Reading your file…" : "Drop a file or tap to browse"),
      React.createElement("div", { className: "import-drop-sub" }, "CSV · Excel (.xlsx) · PDF · Markdown · plain text"),
      React.createElement("input", {
        ref: fileRef, type: "file", accept: ".csv,.tsv,.txt,.md,.xls,.xlsx,.pdf,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/pdf",
        style: { display: 'none' },
        onChange: e => handleFiles(e.target.files)
      })
    ),
    React.createElement("div", { className: "import-or" }, React.createElement("span", null, "or paste your holdings")),
    React.createElement("div", { className: "form-help", style: { marginBottom: 8 } },
      "One holding per line: ", React.createElement("strong", null, "date, company or ticker, shares, cost per share"),
      ". Order is flexible, and a name on its own works too — you can fill in the rest in the next step."),
    React.createElement("textarea", {
      className: "import-paste",
      placeholder: "2024-10-01, Apple, 10, 150.25\n2025-02-14, Naspers, 5, 3200\nAnglo American, 100, 480\nBroadcom",
      value: pasteText,
      onChange: e => setPasteText(e.target.value),
      rows: 6
    }),
    parseError ? React.createElement("div", { className: "verify-error", style: { marginTop: 10 } }, parseError) : null,
    React.createElement("div", { className: "form-actions", style: { marginTop: 14 } },
      React.createElement("button", { className: "btn btn-secondary", onClick: onClose }, "Cancel"),
      React.createElement("button", {
        className: "btn btn-primary",
        onClick: handlePaste,
        disabled: !pasteText.trim() || parsing
      }, "Match holdings")
    )
  );

  const statusDot = (r) => {
    if (r.status === 'resolving') return React.createElement("span", { className: "import-status checking", title: "Matching…" });
    if (r.status === 'ok') return React.createElement("span", { className: "import-status ok", title: r.currentPrice != null ? ("Matched · now " + fmt(r.currentPrice, r.market)) : "Matched" });
    if (r.status === 'unverified') return React.createElement("span", { className: "import-status warn", title: "Your listing — no live price yet" });
    if (r.status === 'notfound') return React.createElement("span", { className: "import-status bad", title: "No live match on this market" });
    return React.createElement("span", { className: "import-status", title: "Not matched" });
  };

  const renderCard = (r) => {
    const sharesBad = !(isFinite(parseDecimal(r.shares)) && parseDecimal(r.shares) > 0);
    const costBad = !(isFinite(parseDecimal(r.costBasis)) && parseDecimal(r.costBasis) > 0);
    // Holding amount = shares × cost/share — shown so the user can confirm the
    // app derived the position size correctly from the four imported fields.
    const amt = (!sharesBad && !costBad) ? parseDecimal(r.shares) * parseDecimal(r.costBasis) : null;
    // The row's own listing never shows up as an "alternative" — matched by
    // underlying exchange so a TFSA row doesn't offer its own JSE twin.
    const alts = (r.candidates || []).filter(c => !(c.ticker === r.ticker && sameUnderlyingExchange(c.market, r.market))).slice(0, 6);
    const lowConf = r.status === 'ok' && r.lowConfidence;
    const unverified = r.status === 'unverified';
    const collide = isCollisionRow(r);
    // The sector this holding will land in (same resolution as the chart). Shown
    // for every matched row; when it can't be classified we flag it and the user's
    // pick is learned (persisted) so the allocation chart stops saying "Other".
    const matched = isSettled(r) && !!r.ticker;
    const detectedSector = matched ? sectorForRow(r) : null;
    const sectorValue = sectorByRow[r.id] || (detectedSector && detectedSector !== 'Other' ? detectedSector : '');
    const sectorUnknown = matched && detectedSector === 'Other' && !sectorByRow[r.id];
    return React.createElement("div", { key: r.id, className: "import-card" + (r.include ? "" : " excluded") + (r.status === 'notfound' ? " is-bad" : "") + (lowConf ? " is-low" : "") + (unverified ? " is-unverified" : "") + (collide ? " is-dup" : "") },
      React.createElement("div", { className: "import-card-top" },
        React.createElement("label", {
          className: "import-include" + (r.include ? " on" : ""),
          title: r.include ? "This holding will be imported — toggle off to skip it" : "Skipped — toggle on to import this holding"
        },
          React.createElement("input", { type: "checkbox", className: "import-include-input", checked: r.include, onChange: e => updateRow(r.id, { include: e.target.checked }) }),
          React.createElement("span", { className: "import-include-track" }, React.createElement("span", { className: "import-include-thumb" })),
          React.createElement("span", { className: "import-include-label" }, r.include ? "Include" : "Skipped")),
        React.createElement("button", { className: "import-del", onClick: () => removeRow(r.id), "aria-label": "Remove row" },
          React.createElement(Icon, { name: "x", size: 13 }))
      ),
      React.createElement("input", {
        className: "import-query-input",
        value: r.query, placeholder: "Company name",
        autoComplete: "off", spellCheck: false,
        onChange: e => updateRow(r.id, { query: e.target.value }),
        onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); reResolveRow(r.id); } },
        // A hand-forced row is never silently re-matched away by a stray tap: only
        // an explicit re-match (Enter, the refresh button, a market change, or
        // "Re-match all") reopens a listing the user chose themselves.
        onBlur: () => { if (r.query.trim() && r.status !== 'resolving' && !r.manual) reResolveRow(r.id); }
      }),
      React.createElement("div", { className: "import-card-match" },
        statusDot(r),
        r.ticker
          ? React.createElement(React.Fragment, null,
              isUnitTrustId(r.ticker)
                ? React.createElement("span", { className: "market-badge" }, "Unit trust")
                : React.createElement("span", { className: "import-match-tkr" }, r.ticker),
              React.createElement("span", { className: "import-match-name" }, r.resolvedName || ''),
              lowConf ? React.createElement("span", { className: "import-conf-low", title: "Loose match — please confirm or pick an alternative" }, "check?") : null,
              unverified ? React.createElement("span", { className: "import-conf-manual", title: "Your listing — no live price yet. It will import and price on the next refresh." }, "unverified") : null)
          : React.createElement("span", { className: "import-match-name text-dim" },
              r.status === 'resolving' ? "Searching live listings…" : (r.status === 'notfound' ? "No match — try the exact name or another market" : "Not matched yet")),
        alts.length > 0 ? React.createElement("button", {
          className: "btn btn-ghost btn-xs import-alts-toggle",
          onClick: () => updateRow(r.id, { showAlts: !r.showAlts, manualSearch: false })
        }, r.showAlts ? "Hide" : "Change") : null,
        React.createElement("button", {
          className: "btn btn-ghost btn-xs import-alts-toggle" + (r.manualSearch ? " active" : ""),
          onClick: () => updateRow(r.id, { manualSearch: !r.manualSearch, showAlts: false }),
          title: "Search live listings and pick the exact one"
        }, r.manualSearch ? "Close" : (r.status === 'notfound' ? "Find" : "Search")),
        // The user's override. The matcher can be wrong — a listing may be too new
        // for Yahoo, or the feed may be down — and the holder often knows better,
        // so nothing here is a dead end: force the symbol in and import it.
        r.status === 'notfound' ? React.createElement("button", {
          className: "btn btn-ghost btn-xs import-alts-toggle import-force",
          onClick: () => forceRow(r.id),
          title: "Import this holding on the symbol as typed, without a live match"
        }, "Add anyway") : null,
        React.createElement("button", {
          className: "btn btn-ghost btn-xs import-alts-toggle",
          onClick: () => reResolveRow(r.id), title: "Re-match"
        }, React.createElement(Icon, { name: "refresh", size: 12 }))
      ),
      unverified ? React.createElement("div", { className: "import-manual-note" },
        React.createElement(Icon, { name: "alert", size: 12 }),
        React.createElement("span", null, "Importing ", React.createElement("b", null, r.ticker), " on ", (MARKETS.find(m => m.value === r.market) || {}).label || r.market,
          " as you set it — we couldn't confirm a live price. It'll price on the next refresh if the symbol is right.")) : null,
      collide ? React.createElement("div", { className: "import-dup-warn" },
        React.createElement(Icon, { name: "alert", size: 12 }),
        React.createElement("span", null, "Same listing as another row — importing will merge them into one position. Use ", React.createElement("b", null, "Search"), " to pick the correct listing for this holding.")) : null,
      r.showAlts && alts.length > 0 ? React.createElement("div", { className: "import-alts" },
        alts.map(c => React.createElement("button", {
          key: priceKey(c.market, c.ticker), className: "import-alt",
          onClick: () => chooseCandidate(r.id, c)
        },
          isUnitTrustId(c.ticker) ? null : React.createElement("span", { className: "import-alt-tkr" }, c.ticker),
          // Badge the account it would actually land in: picking a JSE listing on a
          // TFSA row keeps it in the TFSA, so don't label it "JSE" here.
          React.createElement("span", { className: "market-badge" },
            isUnitTrustId(c.ticker) ? "Unit trust" : (sameUnderlyingExchange(c.market, r.market) ? r.market : c.market)),
          React.createElement("span", { className: "import-alt-name" }, c.name)))
      ) : null,
      // Manual matcher: search every live exchange by name or symbol and pick the
      // exact listing when auto-matching missed or the user wants a different one.
      r.manualSearch ? React.createElement("div", { className: "import-manual-search" },
        React.createElement("div", { className: "import-manual-hint" },
          "Search by company name, or type the exact symbol (e.g. ", React.createElement("code", null, "AAPL"),
          " or ", React.createElement("code", null, "AGL.JO"), ") and pick “Use this exact symbol” to force the match. Set the market with the dropdown above first if needed."),
        React.createElement(TickerSearch, {
          value: r.query,
          market: r.market,
          onChange: () => {},
          onMarketChange: () => {},
          onSelect: (sel) => { updateRow(r.id, { manualSearch: false }); chooseCandidate(r.id, { ticker: sel.ticker, market: sel.market, name: sel.name }); }
        })
      ) : null,
      React.createElement("div", { className: "import-card-meta" },
        React.createElement("div", { className: "import-qty-field import-exch-field" },
          React.createElement("span", { className: "import-qty-label" }, "Exchange"),
          React.createElement("select", {
            className: "import-input import-field-select", value: r.market,
            onChange: e => { updateRow(r.id, { market: e.target.value, status: 'resolving', ticker: '' }); reResolveRow(r.id); }
          }, MARKETS.map(m => React.createElement("option", { key: m.value, value: m.value },
              m.label + " — " + m.country)))),
        React.createElement("div", { className: "import-qty-field import-date-field" },
          React.createElement("span", { className: "import-qty-label" }, "Date"),
          React.createElement("input", {
            className: "import-input", type: "date", max: todayISO,
            value: r.purchaseDate || '',
            onChange: e => updateRow(r.id, { purchaseDate: e.target.value })
          }))),
      React.createElement("div", { className: "import-card-qty" },
        React.createElement("div", { className: "import-qty-field" },
          React.createElement("span", { className: "import-qty-label" }, "Shares"),
          React.createElement("input", {
            className: "import-input" + (sharesBad ? " bad" : ""),
            inputMode: "decimal", value: r.shares, placeholder: "0",
            onChange: e => updateRow(r.id, { shares: sanitizeDecimalInput(e.target.value) })
          })),
        React.createElement("div", { className: "import-qty-field" },
          React.createElement("span", { className: "import-qty-label" }, "Cost/share (", (MARKET_CURRENCY[r.market] || MARKET_CURRENCY.US).code, ")"),
          React.createElement("input", {
            className: "import-input" + (costBad ? " bad" : ""),
            inputMode: "decimal", value: r.costBasis, placeholder: "0.00",
            onChange: e => updateRow(r.id, { costBasis: sanitizeDecimalInput(e.target.value) })
          }))),
      amt != null ? React.createElement("div", { className: "import-amount-line" },
        React.createElement("span", null, "Holding amount"),
        React.createElement("span", { className: "mono" }, fmt(amt, r.market))) : null,
      matched ? React.createElement("div", { className: "import-qty-field import-sector-field" + (sectorUnknown ? " is-unknown" : "") },
        React.createElement("span", { className: "import-qty-label" },
          "Sector",
          React.createElement("span", { className: "import-sector-hint" },
            sectorUnknown
              ? React.createElement(React.Fragment, null, React.createElement(Icon, { name: "alert", size: 11 }), " pick one — we'll remember it")
              : " · where it lands in your allocation")),
        React.createElement("select", {
          className: "import-input import-field-select" + (sectorUnknown ? " bad" : ""),
          value: sectorValue,
          onChange: e => setSectorByRow(prev => ({ ...prev, [r.id]: e.target.value }))
        },
          React.createElement("option", { value: "" }, sectorUnknown ? "Choose sector…" : "Other (uncategorised)"),
          (DATA.SECTOR_CANON || []).map(s => React.createElement("option", { key: s, value: s }, s)))
      ) : null
    );
  };

  const renderReview = () => React.createElement("div", { className: "modal-body" },
    React.createElement("div", { className: "import-review-head" },
      React.createElement("span", null, validRows.length, " of ", rows.length, " ready"),
      notFoundCount > 0 ? React.createElement("span", { className: "text-down text-xs" }, notFoundCount, " unmatched") : null,
      unverifiedCount > 0 ? React.createElement("span", { className: "text-warn text-xs" }, unverifiedCount, " unverified") : null,
      resolving ? React.createElement("span", { className: "text-dim text-xs" }, "Matching…") : React.createElement("button", {
        className: "btn btn-ghost btn-xs", onClick: () => resolveRows(rows.filter(r => r.include))
      }, React.createElement(Icon, { name: "refresh", size: 12 }), " Re-match all")
    ),
    React.createElement("div", { className: "import-bulk-market" },
      React.createElement("span", { className: "import-bulk-label" }, "Match all rows against exchange"),
      React.createElement("div", { className: "import-bulk-chips" },
        MARKETS.map(m => React.createElement("button", {
          key: m.value,
          type: "button",
          className: "import-bulk-chip" + (chosenMarket === m.value ? " active" : ""),
          onClick: () => setAllMarket(m.value),
          title: m.country + " · " + m.exchange + " · " + (MARKET_CURRENCY[m.value] || MARKET_CURRENCY.US).code
        }, m.label)))
    ),
    React.createElement("div", { className: "import-cards" }, rows.map(renderCard)),
    collisionCount > 0 && !resolving ? React.createElement("div", { className: "import-gate-note import-dup-note" },
      React.createElement(Icon, { name: "alert", size: 13 }),
      React.createElement("span", null, `${collisionCount} rows matched a listing that another row also uses — importing as-is will combine them into a single position with summed shares. Re-check the flagged rows so each holding lands on its own listing.`)
    ) : null,
    (notFoundCount > 0 || needQtyCount > 0) && !resolving ? React.createElement("div", { className: "import-gate-note" },
      notFoundCount > 0
        ? `${notFoundCount} row${notFoundCount !== 1 ? 's' : ''} couldn't be matched to a live listing — refine the name, switch the market, or tap Change to pick from alternatives. If you know the listing is right, tap Add anyway and it imports on the symbol you set.`
        : `${needQtyCount} matched row${needQtyCount !== 1 ? 's' : ''} still need shares and cost before importing.`
    ) : null,
    React.createElement("div", { className: "form-actions", style: { marginTop: 14 } },
      React.createElement("button", { className: "btn btn-secondary", onClick: () => { setStage('input'); setRows([]); } }, "Back"),
      React.createElement("button", {
        className: "btn btn-primary", onClick: doImport,
        disabled: validRows.length === 0 || importing || resolving
      }, importing ? "Importing…" : resolving ? "Matching…" : "Import " + validRows.length + " holding" + (validRows.length !== 1 ? "s" : ""))
    )
  );

  return React.createElement("div", { className: "modal" },
    React.createElement("div", { className: "modal-backdrop", onClick: stage === 'input' ? onClose : undefined }),
    React.createElement("div", { className: "modal-panel", ref: panelRef, style: { maxWidth: 520 } },
      stage === 'input' ? React.createElement("div", { className: "modal-handle" }) : null,
      React.createElement("div", { className: "modal-header" },
        React.createElement("div", null,
          React.createElement("div", { className: "modal-title" }, defaultMarket === 'TFSA' ? "Import TFSA holdings" : "Import holdings"),
          React.createElement("div", { className: "modal-subtitle" }, stage === 'input' ? "Match company names to live listings" : "Review matches before importing")
        ),
        React.createElement("button", { className: "modal-close", onClick: requestClose, "aria-label": "Close" }, React.createElement(Icon, { name: "x" }))
      ),
      stage === 'input' ? renderInput() : renderReview()
    ),
    confirmClose ? React.createElement("div", { className: "import-confirm" },
      React.createElement("div", { className: "import-confirm-card" },
        React.createElement("div", { className: "import-confirm-title" }, "Discard this import?"),
        React.createElement("div", { className: "import-confirm-body" },
          "You're reviewing ", React.createElement("strong", null, rows.length, " holding", rows.length !== 1 ? "s" : ""),
          ". Closing now discards these matches — nothing will be added to your portfolio."),
        React.createElement("div", { className: "import-confirm-actions" },
          React.createElement("button", { className: "btn btn-secondary", onClick: () => setConfirmClose(false) }, "Keep editing"),
          React.createElement("button", { className: "btn btn-danger", onClick: () => { setConfirmClose(false); onClose(); } }, "Discard import"))
      )
    ) : null
  );
}
// Buy more of an existing holding. Adds shares at a new cost/share and lets the
// shared addPosition merge + re-average the position. Previews the resulting
// share count and blended average cost before committing.
function BuyModal({ position, fxRates, onClose, onBuy }) {
  const { Icon, useBodyScrollLock, sanitizeDecimalInput } = window.PBApp;
  const prices = PBStore.usePricesMap();
  const [shares, setShares] = useState('');
  const [buyPrice, setBuyPrice] = useState('');
  const todayISO = new Date().toISOString().slice(0, 10);
  const [buyDate, setBuyDate] = useState(todayISO);
  const [notes, setNotes] = useState('');
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  const q = prices[priceKey(position.market, position.ticker)];
  // Top up in the same currency the holding's cost is booked in: native for a
  // normal holding, the chosen fiat for crypto bought in ZAR. The live quote is
  // in the market's native currency, so seed it converted into the cost currency.
  const isCryptoPos = position.market === 'CRYPTO';
  const nativeCode = marketCurrency(position.market);
  const costCcy = positionCostCcy(position);
  const rates = fxRates?.rates || null;
  const seededPrice = q ? (costCcy === nativeCode ? q.price : convertCcy(q.price, nativeCode, costCcy, rates)) : null;
  useEffect(() => {
    if (seededPrice != null && isFinite(seededPrice) && !buyPrice) setBuyPrice(seededPrice.toFixed(2));
  }, [seededPrice]);
  const ccy = isCryptoPos ? (CURRENCY_SYMBOLS[costCcy] || '$') : (MARKET_CURRENCY[position.market] || MARKET_CURRENCY.US).sym;
  const numShares = parseDecimal(shares);
  const numPrice = parseDecimal(buyPrice);
  const dateOk = !buyDate || buyDate <= todayISO;
  const valid = isFinite(numShares) && numShares > 0 && isFinite(numPrice) && numPrice > 0 && dateOk;
  const addAmount = valid ? numShares * numPrice : null;
  const newTotalShares = valid ? position.shares + numShares : position.shares;
  const newAvg = valid ? (position.shares * position.costBasis + numShares * numPrice) / newTotalShares : null;
  const submit = () => {
    if (!valid) return;
    onBuy(position.ticker, position.market, numShares, numPrice, buyDate, notes, costCcy);
    onClose();
  };
  return React.createElement("div", { className: "modal" },
    React.createElement("div", { className: "modal-backdrop", onClick: onClose }),
    React.createElement("div", { className: "modal-panel", ref: panelRef, style: { maxWidth: 520 } },
      React.createElement("div", { className: "modal-handle" }),
      React.createElement("div", { className: "modal-header" },
        React.createElement("div", null,
          React.createElement("div", { className: "modal-title" }, "Buy more ", position.ticker),
          React.createElement("div", { className: "modal-subtitle" },
            position.shares, isCryptoPos ? " held \xB7 avg " : (position.shares === 1 ? " share held \xB7 avg " : " shares held \xB7 avg "), ccy, position.costBasis.toFixed(2))),
        React.createElement("button", { className: "modal-close", onClick: onClose, "aria-label": "Close" },
          React.createElement(Icon, { name: "x" }))),
      React.createElement("div", { className: "modal-body" },
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, isCryptoPos ? "Amount to buy" : "Shares to buy"),
          React.createElement("input", {
            type: "text", inputMode: "decimal",
            autoComplete: "off", autoCorrect: "off", spellCheck: false,
            placeholder: isCryptoPos ? "0.5" : "10",
            value: shares, onChange: e => setShares(sanitizeDecimalInput(e.target.value))
          })),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, isCryptoPos ? ("Cost per coin (" + costCcy + ")") : "Cost per share"),
          React.createElement("div", { className: "input-prefix-wrap" },
            React.createElement("span", { className: "prefix" }, ccy),
            React.createElement("input", {
              type: "text", inputMode: "decimal",
              autoComplete: "off", autoCorrect: "off", spellCheck: false,
              placeholder: seededPrice != null && isFinite(seededPrice) ? seededPrice.toFixed(2) : '0.00',
              value: buyPrice, onChange: e => setBuyPrice(sanitizeDecimalInput(e.target.value))
            }))),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Purchase date"),
          React.createElement("input", {
            type: "date", value: buyDate, max: todayISO,
            onChange: e => setBuyDate(e.target.value)
          })),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Notes (optional)"),
          React.createElement("input", {
            type: "text", maxLength: "200", placeholder: "e.g. Added on the dip",
            value: notes, onChange: e => setNotes(e.target.value)
          })),
        addAmount != null && React.createElement("div", {
          className: "card buy-preview", style: { padding: '10px 14px' }
        },
          React.createElement("div", { className: "buy-preview-row" },
            React.createElement("span", { className: "text-xs text-dim" }, "Amount"),
            React.createElement("span", { className: "mono font-semibold" }, ccy + addAmount.toFixed(2))),
          React.createElement("div", { className: "buy-preview-row" },
            React.createElement("span", { className: "text-xs text-dim" }, "New position"),
            React.createElement("span", { className: "mono font-semibold" },
              newTotalShares, " sh \xB7 avg ", ccy, newAvg.toFixed(2)))),
        React.createElement("div", { className: "form-actions" },
          React.createElement("button", { className: "btn btn-secondary", onClick: onClose }, "Cancel"),
          React.createElement("button", {
            className: "btn btn-primary", onClick: submit, disabled: !valid
          }, "Add shares")))));
}
function SellModal({ position, onClose, onSell }) {
  const { Icon, useBodyScrollLock, sanitizeDecimalInput } = window.PBApp;
  const prices = PBStore.usePricesMap();
  const [shares, setShares] = useState('');
  const [pctStr, setPctStr] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const todayISO = new Date().toISOString().slice(0, 10);
  const [sellDate, setSellDate] = useState(todayISO);
  const [notes, setNotes] = useState('');
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  const q = prices[priceKey(position.market, position.ticker)];
  useEffect(() => {
    if (q && !sellPrice) setSellPrice(q.price.toFixed(2));
  }, [q]);
  const ccy = (MARKET_CURRENCY[position.market] || MARKET_CURRENCY.US).sym;
  const numShares = parseDecimal(shares);
  const numPrice = parseDecimal(sellPrice);
  // Sell by % of holding: typing a % (or clicking a chip) fills the share count,
  // and the app works out the rest. 100% sells the whole position cleanly. The %
  // box and the shares box stay in sync — editing either updates the other.
  const sharesFromPct = (pct) => {
    if (!isFinite(pct)) return;
    const c = Math.max(0, Math.min(100, pct));
    if (c >= 100) { setShares(position.shares.toString()); return; }
    const raw = position.shares * c / 100;
    // Round to 4 dp to avoid float noise, then trim trailing zeros.
    setShares(parseFloat(raw.toFixed(4)).toString());
  };
  // Drive everything from the % box: set the displayed % and the matching shares.
  const applyPctInput = (v) => {
    setPctStr(v);
    sharesFromPct(parseDecimal(v));
  };
  // Quick chip: fill both boxes from a round percentage.
  const applyPctChip = (pct) => {
    setPctStr(String(pct));
    sharesFromPct(pct);
  };
  // Editing the shares box directly keeps the % box in step.
  const applySharesInput = (v) => {
    setShares(v);
    const n = parseDecimal(v);
    setPctStr(isFinite(n) && position.shares > 0
      ? String(parseFloat((n / position.shares * 100).toFixed(2)))
      : '');
  };
  const pctOfHolding = isFinite(numShares) && position.shares > 0 ? numShares / position.shares * 100 : null;
  const valid = isFinite(numShares) && numShares > 0 && numShares <= position.shares && isFinite(numPrice) && numPrice > 0;
  const pnl = valid ? (numPrice - position.costBasis) * numShares : null;
  const submit = () => {
    if (!valid) return;
    onSell(position.ticker, position.market, numShares, numPrice, sellDate, notes);
    onClose();
  };
  return React.createElement("div", { className: "modal" },
    React.createElement("div", { className: "modal-backdrop", onClick: onClose }),
    React.createElement("div", { className: "modal-panel", ref: panelRef, style: { maxWidth: 520 } },
      React.createElement("div", { className: "modal-handle" }),
      React.createElement("div", { className: "modal-header" },
        React.createElement("div", null,
          React.createElement("div", { className: "modal-title" }, "Sell ", position.ticker),
          React.createElement("div", { className: "modal-subtitle" },
            position.shares, " shares held \xB7 avg ", ccy, position.costBasis.toFixed(2))),
        React.createElement("button", { className: "modal-close", onClick: onClose, "aria-label": "Close" },
          React.createElement(Icon, { name: "x" }))),
      React.createElement("div", { className: "modal-body" },
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Portion to sell"),
          React.createElement("div", { className: "sell-pct-row" },
            React.createElement("div", { className: "sell-pct-chips" },
              [25, 50, 75, 100].map(pct => {
                const active = pctOfHolding != null && Math.abs(pctOfHolding - pct) < 0.05;
                return React.createElement("button", {
                  key: pct, type: "button",
                  className: `sell-pct-chip ${active ? 'active' : ''}`,
                  onClick: () => applyPctChip(pct)
                }, pct === 100 ? "All" : pct + "%");
              })),
            React.createElement("div", { className: "input-suffix-wrap sell-pct-input" },
              React.createElement("input", {
                type: "text", inputMode: "decimal",
                autoComplete: "off", autoCorrect: "off", spellCheck: false,
                "aria-label": "Percent to sell",
                placeholder: "0",
                value: pctStr, onChange: e => applyPctInput(sanitizeDecimalInput(e.target.value))
              }),
              React.createElement("span", { className: "suffix" }, "%"))),
          React.createElement("div", { className: "form-help" }, "Type a percentage (or tap a chip) and we'll work out the shares — or enter an exact share count below.")),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Shares to sell"),
          React.createElement("input", {
            type: "text", inputMode: "decimal",
            autoComplete: "off", autoCorrect: "off", spellCheck: false,
            placeholder: position.shares.toString(),
            value: shares, onChange: e => applySharesInput(sanitizeDecimalInput(e.target.value))
          }),
          React.createElement("div", { className: "form-help" },
            "Max: ", position.shares,
            pctOfHolding != null && numShares > 0 && numShares <= position.shares
              ? React.createElement("span", { className: "text-dim" }, " · ", pctOfHolding.toFixed(pctOfHolding % 1 === 0 ? 0 : 1), "% of holding")
              : null,
            numShares > position.shares && React.createElement("span", { className: "text-down" }, " — exceeds your holding"))),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Sell price per share"),
          React.createElement("div", { className: "input-prefix-wrap" },
            React.createElement("span", { className: "prefix" }, ccy),
            React.createElement("input", {
              type: "text", inputMode: "decimal",
              autoComplete: "off", autoCorrect: "off", spellCheck: false,
              placeholder: q ? q.price.toFixed(2) : '0.00',
              value: sellPrice, onChange: e => setSellPrice(sanitizeDecimalInput(e.target.value))
            }))),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Sale date"),
          React.createElement("input", {
            type: "date", value: sellDate, max: todayISO,
            onChange: e => setSellDate(e.target.value)
          })),
        React.createElement("div", { className: "form-group" },
          React.createElement("label", { className: "form-label" }, "Notes (optional)"),
          React.createElement("input", {
            type: "text", maxLength: "200", placeholder: "e.g. Trimmed after earnings",
            value: notes, onChange: e => setNotes(e.target.value)
          })),
        pnl != null && React.createElement("div", {
          className: `card ${pnl >= 0 ? 'sell-pnl-up' : 'sell-pnl-down'}`,
          style: { padding: '10px 14px', textAlign: 'center' }
        },
          React.createElement("div", { className: "text-xs text-dim" }, "Estimated P/L"),
          React.createElement("div", { className: `mono font-semibold ${pnl >= 0 ? 'text-up' : 'text-down'}`, style: { fontSize: 18 } },
            (pnl >= 0 ? '+' : '') + ccy + Math.abs(pnl).toFixed(2))),
        React.createElement("div", { className: "form-actions" },
          React.createElement("button", { className: "btn btn-secondary", onClick: onClose }, "Cancel"),
          React.createElement("button", {
            className: "btn btn-danger", onClick: submit, disabled: !valid
          }, "Record sale")))));
}
function PositionModal(_ref12) {
  const { Icon, useBodyScrollLock, TickerSearch, sanitizeDecimalInput, MarketPicker } = window.PBApp;
  const DATA = window.PB_DATA; // data.js loads after this bucket - read at render time
  let {
    editId,
    existing,
    defaultMarket,
    displayCurrency,
    initialSectorWeights,
    onClose,
    onSave
  } = _ref12;
  const isEdit = !!editId;
  const [ticker, setTicker] = useState(existing?.ticker || '');
  const [market, setMarket] = useState(existing?.market || defaultMarket || 'US');
  const [shares, setShares] = useState(existing?.shares?.toString() || '');
  const [costBasis, setCostBasis] = useState(existing?.costBasis?.toString() || '');
  const isCrypto = market === 'CRYPTO';
  // Crypto trades globally in USD but people buy it in fiat (often ZAR here). Let
  // the holder record what they actually paid: choose the cost currency and enter
  // either a price per coin or the total they spent. costCurrency defaults to the
  // user's display currency so a ZAR user gets ZAR without extra taps; absent /
  // USD it behaves exactly like a normal USD-priced holding.
  const [costCurrency, setCostCurrency] = useState(existing?.costCurrency || displayCurrency || 'USD');
  const [costMode, setCostMode] = useState(isEdit ? 'perUnit' : 'total'); // crypto only
  const [totalSpent, setTotalSpent] = useState(
    existing && existing.costCurrency && existing.shares
      ? String(parseFloat((existing.shares * existing.costBasis).toFixed(2)))
      : '');
  const [notes, setNotes] = useState(existing?.notes || '');
  const todayISO = new Date().toISOString().slice(0, 10);
  const [purchaseDate, setPurchaseDate] = useState(existing?.purchaseDate || todayISO);
  const [verifying, setVerifying] = useState(false);
  const [tickerError, setTickerError] = useState('');
  // Set when the live feed couldn't confirm the symbol. The failed verify used to
  // be a dead end — the holder can know a listing is real and correct (a new ETF,
  // a market the feed lags on, a proxy outage) and had no way past it — so it now
  // offers to save the position exactly as entered instead of refusing it.
  const [canForce, setCanForce] = useState(false);
  // Sector this holding will be allocated to — auto-detected from the ticker,
  // overridable, and learned so the allocation chart reflects it.
  const [sectorOverride, setSectorOverride] = useState(existing?.sector || '');
  // Optional look-through sector breakdown for ETFs / funds: rows of
  // { sector, weight } (weight as a % string). When set, the allocation chart
  // splits this holding across these sectors instead of one bucket.
  const [sectorRows, setSectorRows] = useState(() =>
    Array.isArray(initialSectorWeights)
      ? initialSectorWeights.map(w => ({ sector: w.sector || '', weight: w.weight != null ? String(w.weight) : '' }))
      : []);
  const cleanSectorRows = sectorRows
    .map(r => ({ sector: r.sector, weight: parseFloat(r.weight) }))
    .filter(r => r.sector && isFinite(r.weight) && r.weight > 0);
  // Holds the pending edit while the user confirms it: { changes, payload,
  // verifiedQuote }. null when no confirmation is in flight.
  const [confirmEdit, setConfirmEdit] = useState(null);
  const panelRef = useRef(null);
  useSwipeDownToClose(panelRef, onClose);
  useBodyScrollLock();
  const detectedSector = ticker.trim() ? DATA.findSector(ticker.trim().toUpperCase(), market).sector : 'Other';
  const sectorValue = sectorOverride || (detectedSector !== 'Other' ? detectedSector : '');
  const sectorUnknown = !!ticker.trim() && detectedSector === 'Other' && !sectorOverride;
  // Trim float noise off a share count so "10" doesn't read back as "10.0000".
  const fmtShares = v => String(parseFloat(Number(v || 0).toFixed(6)));
  // For an edit, list exactly which fields changed (old → new) so the user can
  // see and confirm what they're about to save.
  const diffChanges = (payload) => {
    if (!existing) return [];
    const ex = existing;
    const out = [];
    const exTicker = String(ex.ticker || '').toUpperCase();
    if (payload.ticker !== exTicker) out.push({ label: 'Ticker', from: exTicker || '—', to: payload.ticker });
    if (payload.market !== ex.market) out.push({ label: 'Market', from: ex.market || '—', to: payload.market });
    if (Number(payload.shares) !== Number(ex.shares)) out.push({ label: 'Shares', from: fmtShares(ex.shares), to: fmtShares(payload.shares) });
    const exCcySym = CURRENCY_SYMBOLS[positionCostCcy(ex)] || ccy;
    if (Number(payload.costBasis) !== Number(ex.costBasis)) out.push({ label: 'Avg price', from: exCcySym + Number(ex.costBasis || 0).toFixed(2), to: ccy + Number(payload.costBasis).toFixed(2) });
    if ((payload.costCurrency || null) !== (ex.costCurrency || null)) out.push({ label: 'Cost currency', from: positionCostCcy(ex), to: payload.costCurrency || marketCurrency(payload.market) });
    if ((payload.purchaseDate || '') !== (ex.purchaseDate || '')) out.push({ label: 'Purchase date', from: ex.purchaseDate || '—', to: payload.purchaseDate || '—' });
    if ((payload.sector || '') !== (ex.sector || '')) out.push({ label: 'Sector', from: ex.sector || 'Other', to: payload.sector || 'Other' });
    const wStr = (ws) => Array.isArray(ws) && ws.length ? ws.map(w => `${w.sector} ${w.weight}%`).join(', ') : '—';
    const initW = Array.isArray(initialSectorWeights)
      ? initialSectorWeights.map(w => ({ sector: w.sector, weight: parseFloat(w.weight) })).filter(w => w.sector && isFinite(w.weight) && w.weight > 0)
      : [];
    if (wStr(initW) !== wStr(payload.sectorWeights)) out.push({ label: 'Sector split', from: wStr(initW), to: wStr(payload.sectorWeights) });
    if ((payload.notes || '') !== (ex.notes || '')) out.push({ label: 'Notes', from: ex.notes || '—', to: payload.notes || '—' });
    return out;
  };
  // The currency the cost basis is entered/stored in: the chosen fiat for crypto,
  // otherwise the market's native currency. Drives the input prefix and storage.
  const costCcyCode = isCrypto ? costCurrency : marketCurrency(market);
  // Per-unit cost: crypto in "total" mode derives it from total ÷ amount, so the
  // user can just type what they spent. Everything else is a direct per-share price.
  const perUnitCost = (isCrypto && costMode === 'total')
    ? ((parseDecimal(shares) > 0) ? parseDecimal(totalSpent) / parseDecimal(shares) : NaN)
    : parseDecimal(costBasis);
  const submit = async (opts) => {
    const force = !!(opts && opts.force);
    if (!ticker.trim()) return;
    const s = parseDecimal(shares);
    const c = perUnitCost;
    if (!isFinite(s) || s <= 0) return;
    if (!isFinite(c) || c <= 0) return;
    if (purchaseDate && purchaseDate > todayISO) {
      setTickerError('Purchase date cannot be in the future.');
      return;
    }
    // Verify against the live feed for a new position, and for an edit whenever
    // the ticker or market changed — so re-pointing a holding to a corrected
    // listing is validated, while a pure shares/cost/date edit stays offline.
    const listingChanged = isEdit && existing &&
      (ticker.trim().toUpperCase() !== String(existing.ticker || '').toUpperCase() || market !== existing.market);
    let verifiedQuote = null;
    if ((!isEdit || listingChanged) && !force) {
      setVerifying(true);
      setTickerError('');
      verifiedQuote = await fetchQuote(ticker.trim(), market);
      setVerifying(false);
      if (!verifiedQuote) {
        // Not a refusal — a warning with a way through. The user decides.
        setTickerError(`We couldn't find a live price for "${ticker.trim().toUpperCase()}" on ${market}. Check the symbol — or add it anyway if you know it's right.`);
        setCanForce(true);
        return;
      }
    }
    // Pass the quote we just fetched up so the feed can seed it instantly — the
    // dashboard pie/line then update the moment the position is added.
    const payload = {
      ticker: ticker.trim().toUpperCase(),
      market, shares: s, costBasis: c, notes,
      purchaseDate: purchaseDate || null,
      sector: sectorValue || null,
      sectorWeights: cleanSectorRows.length ? cleanSectorRows : null,
      // Only persist a cost currency when it genuinely differs from the market's
      // native one (crypto bought in ZAR) — keeps every normal holding untouched.
      costCurrency: (isCrypto && costCcyCode !== marketCurrency(market)) ? costCcyCode : undefined
    };
    // Editing an existing holding: confirm the change first and show exactly
    // what's changing (field: old → new) so an accidental edit can't slip
    // through. A brand-new position saves straight away.
    if (isEdit) {
      const changes = diffChanges(payload);
      if (changes.length === 0) { onClose(); return; }
      setConfirmEdit({ changes, payload, verifiedQuote });
      return;
    }
    onSave(payload, verifiedQuote);
  };
  const ccy = isCrypto ? (CURRENCY_SYMBOLS[costCurrency] || '$') : (MARKET_CURRENCY[market] || MARKET_CURRENCY.US).sym;
  return React.createElement(React.Fragment, null, React.createElement("div", {
    className: "modal"
  }, React.createElement("div", {
    className: "modal-backdrop",
    onClick: onClose
  }), React.createElement("div", {
    className: "modal-panel",
    ref: panelRef,
    style: {
      maxWidth: 520
    }
  }, React.createElement("div", {
    className: "modal-handle"
  }), React.createElement("div", {
    className: "modal-header"
  }, React.createElement("div", null, React.createElement("div", {
    className: "modal-title"
  }, isEdit ? 'Edit position' : 'Add position'), React.createElement("div", {
    className: "modal-subtitle"
  }, "Stored locally on this device")), React.createElement("button", {
    className: "modal-close",
    onClick: onClose,
    "aria-label": "Close"
  }, React.createElement(Icon, {
    name: "x"
  }))), React.createElement("div", {
    className: "modal-body"
  }, React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Market"), React.createElement(MarketPicker, {
    value: market,
    onChange: v => { setMarket(v); setTickerError(''); setCanForce(false); }
  })), React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Ticker"), React.createElement(TickerSearch, {
    value: ticker,
    onChange: v => { setTicker(v); setTickerError(''); setCanForce(false); },
    market: market,
    onMarketChange: m2 => { setMarket(m2); setTickerError(''); setCanForce(false); }
  }), tickerError ? React.createElement("div", { className: "verify-error" }, tickerError) : null,
    canForce ? React.createElement("div", { className: "verify-force" },
      React.createElement("button", {
        className: "btn btn-ghost btn-xs import-force",
        onClick: () => submit({ force: true }),
        disabled: verifying
      }, "Add anyway"),
      React.createElement("span", { className: "form-help" },
        "Saves ", ticker.trim().toUpperCase() || 'this holding', " on ", market,
        " exactly as entered. It'll price on the next refresh if the symbol is right.")) : null,
    isEdit ? React.createElement("div", { className: "form-help" },
      "Change the ticker or market to re-point this holding to the correct live listing (e.g. if it was imported or added incorrectly). Your shares, cost and date stay as below.") : null), React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Sector"), React.createElement("select", {
    className: "import-field-select" + (sectorUnknown ? " bad" : ""),
    value: sectorValue,
    onChange: e => setSectorOverride(e.target.value)
  }, React.createElement("option", { value: "" }, "Other (uncategorised)"),
     (DATA.SECTOR_CANON || []).map(s => React.createElement("option", { key: s, value: s }, s))),
    React.createElement("div", { className: "form-help" },
      !ticker.trim() ? "Pick a ticker first — we'll auto-detect the sector."
        : sectorUnknown ? "Couldn't auto-detect this one — choose where it lands in your allocation chart."
        : "Where this lands in your allocation chart (auto-detected — change if needed).")
  ), (!isCrypto && React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Sector breakdown (ETFs & funds)"),
    React.createElement(SectorWeightRows, { rows: sectorRows, setRows: setSectorRows })
  )), React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, isCrypto ? "Amount" : "Shares"), React.createElement("input", {
    type: "text",
    inputMode: "decimal",
    autoComplete: "off",
    autoCorrect: "off",
    spellCheck: false,
    placeholder: isCrypto ? "0.5" : "10",
    value: shares,
    onChange: e => setShares(sanitizeDecimalInput(e.target.value))
  }), isCrypto ? React.createElement("div", { className: "form-help" },
      "Number of coins or tokens you hold — fractional amounts are fine.") : null),
  isCrypto ? React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", { className: "form-label" }, "Cost"),
    React.createElement("div", { className: "crypto-cost-controls" },
      React.createElement("select", {
        className: "import-field-select crypto-cost-ccy",
        value: costCurrency,
        onChange: e => setCostCurrency(e.target.value),
        "aria-label": "Cost currency"
      }, DISPLAY_CURRENCIES.map(d => React.createElement("option", { key: d.code, value: d.code }, d.code + " (" + d.sym + ")"))),
      React.createElement("div", { className: "seg-toggle crypto-cost-mode" },
        React.createElement("button", {
          type: "button", className: "seg-opt" + (costMode === 'total' ? " active" : ""),
          onClick: () => setCostMode('total')
        }, "Total spent"),
        React.createElement("button", {
          type: "button", className: "seg-opt" + (costMode === 'perUnit' ? " active" : ""),
          onClick: () => setCostMode('perUnit')
        }, "Price per coin"))),
    React.createElement("div", { className: "input-prefix-wrap" },
      React.createElement("span", { className: "prefix" }, ccy),
      React.createElement("input", {
        type: "text", inputMode: "decimal", autoComplete: "off", autoCorrect: "off", spellCheck: false,
        placeholder: "0.00",
        value: costMode === 'total' ? totalSpent : costBasis,
        onChange: e => (costMode === 'total' ? setTotalSpent : setCostBasis)(sanitizeDecimalInput(e.target.value))
      })),
    React.createElement("div", { className: "form-help" },
      costMode === 'total'
        ? (isFinite(perUnitCost) && perUnitCost > 0
            ? "≈ " + ccy + perUnitCost.toLocaleString('en-US', { maximumFractionDigits: 8 }) + " per coin"
            : "Total you paid in " + costCurrency + " — we'll work out the per-coin cost.")
        : (parseDecimal(shares) > 0 && isFinite(perUnitCost) && perUnitCost > 0
            ? "Total ≈ " + ccy + (perUnitCost * parseDecimal(shares)).toLocaleString('en-US', { maximumFractionDigits: 2 })
            : "Price per coin you paid, in " + costCurrency + ".")),
    costCurrency !== 'USD' ? React.createElement("div", { className: "form-help" },
      "Priced live in USD and converted to " + costCurrency + " — your " + costCurrency + " cost is kept as-is.") : null)
  : React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Purchase price per share"), React.createElement("div", {
    className: "input-prefix-wrap"
  }, React.createElement("span", {
    className: "prefix"
  }, ccy), React.createElement("input", {
    type: "text",
    inputMode: "decimal",
    autoComplete: "off",
    autoCorrect: "off",
    spellCheck: false,
    placeholder: "0.00",
    value: costBasis,
    onChange: e => setCostBasis(sanitizeDecimalInput(e.target.value))
  })), React.createElement("div", {
    className: "form-help"
  }, "What you paid per share (your average if you bought in tranches).")), React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Purchase date"), React.createElement("input", {
    type: "date",
    value: purchaseDate,
    max: todayISO,
    onChange: e => setPurchaseDate(e.target.value)
  }), React.createElement("div", {
    className: "form-help"
  }, "Used to price FX gain/loss against the rate on the day you bought.")), React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Notes (optional)"), React.createElement("textarea", {
    maxLength: "200",
    placeholder: "e.g. TFSA, held since Oct 2024",
    value: notes,
    onChange: e => setNotes(e.target.value)
  })), React.createElement("div", {
    className: "form-actions"
  }, React.createElement("button", {
    className: "btn btn-secondary",
    onClick: onClose
  }, "Cancel"), React.createElement("button", {
    className: "btn btn-primary",
    onClick: () => submit(),
    disabled: verifying
  }, verifying ? 'Verifying…' : isEdit ? 'Save changes' : 'Add position'))))),
    confirmEdit ? ReactDOM.createPortal(
      React.createElement("div", { className: "import-confirm import-confirm-elevated" },
        React.createElement("div", { className: "import-confirm-card", style: { maxWidth: 400 } },
          React.createElement("div", { className: "import-confirm-title" }, "Save these changes?"),
          React.createElement("div", { className: "import-confirm-body" },
            "You're editing ",
            React.createElement("strong", null, existing && existing.ticker ? String(existing.ticker).toUpperCase() : "this holding"),
            ". Confirm what's changing:"),
          React.createElement("div", { className: "edit-confirm-diff" },
            confirmEdit.changes.map((ch, i) => React.createElement("div", { key: i, className: "edit-diff-row" },
              React.createElement("div", { className: "edit-diff-label" }, ch.label),
              React.createElement("div", { className: "edit-diff-vals" },
                React.createElement("span", { className: "edit-diff-from" }, ch.from),
                React.createElement(Icon, { name: "chevron", size: 13, className: "edit-diff-arrow" }),
                React.createElement("span", { className: "edit-diff-to" }, ch.to))))),
          React.createElement("div", { className: "import-confirm-actions" },
            React.createElement("button", { className: "btn btn-secondary", onClick: () => setConfirmEdit(null) }, "Keep editing"),
            React.createElement("button", {
              className: "btn btn-primary",
              onClick: () => { const ce = confirmEdit; setConfirmEdit(null); onSave(ce.payload, ce.verifiedQuote); }
            }, "Save changes")))),
      document.body) : null);
}

  window.PBModals = window.PBModals || {};
  window.PBModals.SectorAllocationModal = SectorAllocationModal;
  window.PBModals.SectorDetailModal = SectorDetailModal;
  window.PBModals.ContributionModal = ContributionModal;
  window.PBModals.ContributionImportModal = ContributionImportModal;
  window.PBModals.DetailModal = DetailModal;
  window.PBModals.SettingsModal = SettingsModal;
  window.PBModals.AlertsModal = AlertsModal;
  window.PBModals.ImportModal = ImportModal;
  window.PBModals.BuyModal = BuyModal;
  window.PBModals.SellModal = SellModal;
  window.PBModals.PositionModal = PositionModal;
})();
