// pb-modals.js - extracted modal-component bucket (Phase 4). Browser-only classic script.
// Registers window.PBModals.<Modal> and reads shared app.js primitives from window.PBApp
// at render time (bridge). data.js/PBStore globals are read directly, not via the bridge.
(function () {
  const { useState, useRef, useCallback, useEffect, useMemo } = React; // UMD global
// Dedicated "edit just the sector allocation" modal for one instrument, opened
// from the sector-breakdown popup. Edits the shared pb.sectorWeights map (keyed
// by MARKET:TICKER) so the change applies to that fund everywhere it's held.
function SectorAllocationModal({ ticker, market, name, initialWeights, onClose, onSave }) {
  const { Icon, useSwipeDownToClose, useBodyScrollLock, SectorWeightRows } = window.PBApp;
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
  const { Icon, useBodyScrollLock, fetchSectorTrend, ZoomPanHeatmap } = window.PBApp;
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
  window.PBModals = window.PBModals || {};
  window.PBModals.SectorAllocationModal = SectorAllocationModal;
  window.PBModals.SectorDetailModal = SectorDetailModal;
})();
