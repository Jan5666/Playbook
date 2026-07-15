// pb-modals.js - extracted modal-component bucket (Phase 4). Browser-only classic script.
// Registers window.PBModals.<Modal> and reads shared app.js primitives from window.PBApp
// at render time (bridge). data.js/PBStore globals are read directly, not via the bridge.
(function () {
  const { useState, useRef, useCallback, useEffect, useMemo } = React; // UMD global
  const parseDecimal = PBCore.parseDecimal; // PBCore global (loaded before this script)
  const CURRENCY_SYMBOLS = PBContent.CURRENCY_SYMBOLS; // PBContent global (loaded before this script)
  const priceKey = PBCore.priceKey; // PBCore global
  const marketCurrency = PBCore.marketCurrency; // PBCore global
  const convertCcy = PBCore.convertCcy; // PBCore global
  const valuePositionInCostCcy = PBCore.valuePositionInCostCcy; // PBCore global (money helper - stays in PBCore)
  const INDICATOR_INFO = PBContent.INDICATOR_INFO; // PBContent global
  const fetchQuote = PBData.fetchQuote; // PBData global (browser-only; loaded before this script)
  const isUnitTrustId = PBData.isUnitTrustId; // PBData global
  const MARKET_CURRENCY = PBCore.MARKET_CURRENCY; // PBCore global
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
// Log a single deposit / withdrawal (moved from app.js, Phase 4 inc 13). Display-only:
// deposit/withdraw toggle, currency, amount, optional locked USD-landed rate; delegates
// the money math to the parent via onSave.
function ContributionModal({ onClose, onSave, onOpenImport }) {
  const { Icon, useSwipeDownToClose, useBodyScrollLock, sanitizeDecimalInput } = window.PBApp;
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
  const { Icon, useSwipeDownToClose, useBodyScrollLock, sanitizeDecimalInput, uid, parseCashFlowsFromText, parseCashFlowFile } = window.PBApp;
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
function baseCurrency(code, market) {
  const c = (code || '').toUpperCase();
  if (c.startsWith('ZA')) return 'ZAR';
  if (c.startsWith('GB')) return 'GBP';
  if (c.startsWith('AU')) return 'AUD';
  if (c.startsWith('EU') || c === 'EUR') return 'EUR';
  if (c === 'USD' || c === 'USC') return 'USD';
  if (c.length === 3) return c;
  return (MARKET_CURRENCY[market]?.code) || 'USD';
}
function FundamentalsBlock(_refFB) {
  const { fmt } = window.PBApp;
  let { fundamentals, quote, market, fxRates, onRetry } = _refFB;
  const loading = fundamentals && fundamentals.loading && !fundamentals.data;
  const f = fundamentals?.data || {};
  const cur = quote?.price && quote.price > 0 ? quote.price : null;
  // Currency symbol follows the position's market (same source as fmt() used for
  // the analyst targets below) so every figure on the card reads in one currency.
  const ccySym = (MARKET_CURRENCY[market] || MARKET_CURRENCY.US).sym;
  const nativeCode = baseCurrency(f.currency || quote?.currency, market);
  // Market cap normalised to USD (FX base is USD: rates[code] = units per 1 USD).
  let mcapUsd = null;
  if (f.marketCap != null && isFinite(f.marketCap)) {
    if (nativeCode === 'USD') mcapUsd = f.marketCap;
    else { const rate = fxRates?.rates?.[nativeCode]; if (rate) mcapUsd = f.marketCap / rate; }
  }
  const quarterLabel = (() => {
    const ms = f.mostRecentQuarter || f.lastFiscalYearEnd;
    return ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : null;
  })();
  const signed = (n, d = 1) => (n >= 0 ? '+' : '') + n.toFixed(d) + '%';
  const tone = (n) => n >= 0 ? 'text-up' : 'text-down';
  // \u2500\u2500 Headline analytics (the metrics the user explicitly tracks) \u2500\u2500
  const headline = [];
  const hpush = (label, value, opts) => { if (value != null) headline.push({ label, value, ...(opts || {}) }); };
  if (f.peTrailing != null) hpush('P/E (TTM)', f.peTrailing.toFixed(2), { sub: quarterLabel ? 'Q ended ' + quarterLabel : null });
  if (f.peForward != null) hpush('Forward P/E', f.peForward.toFixed(2));
  if (mcapUsd != null) { const m = fmtLarge(mcapUsd); if (m) hpush('Market cap', '$' + m, { sub: nativeCode !== 'USD' ? 'USD' : null }); }
  if (f.debtToEquity != null) hpush('Debt / equity', (f.debtToEquity / 100).toFixed(2));
  if (f.freeCashflow != null) { const v = fmtLarge(f.freeCashflow); if (v) hpush('Free cash flow', ccySym + v, { cls: f.freeCashflow >= 0 ? 'text-up' : 'text-down' }); }
  if (f.profitMargin != null) hpush('Profit margin', f.profitMargin.toFixed(1) + '%', { cls: tone(f.profitMargin) });
  if (f.earningsGrowth != null) hpush('Profit growth', signed(f.earningsGrowth), { cls: tone(f.earningsGrowth), sub: 'YoY net income' });
  if (f.revenue != null) { const r = fmtLarge(f.revenue); if (r) hpush('Revenue', ccySym + r, { sub: 'TTM' }); }
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
  if (f.eps != null) push('EPS (TTM)', ccySym + f.eps.toFixed(2));
  if (f.dividendYield != null) push('Dividend yield', f.dividendYield.toFixed(2) + '%');
  if (f.bookValue != null) push('NAV / share', ccySym + f.bookValue.toFixed(2));
  if (f.bookValue != null && cur != null && f.bookValue > 0) {
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
  if (f.ebitda != null) { const e = fmtLarge(f.ebitda); if (e) push('EBITDA', ccySym + e); }
  if (quote?.dayHigh != null && quote?.dayLow != null) {
    push("Day range", ccySym + quote.dayLow.toFixed(2) + ' – ' + ccySym + quote.dayHigh.toFixed(2));
  }
  if (yearHigh != null && yearLow != null) {
    push("52W range", ccySym + yearLow.toFixed(2) + ' – ' + ccySym + yearHigh.toFixed(2));
  }
  if (quote?.volume != null) { const v = fmtLarge(quote.volume); if (v) push('Volume', v); }
  if (f.avgVolume != null) { const v = fmtLarge(f.avgVolume); if (v) push('Avg volume', v); }
  const targetSection = f.targetMean ? React.createElement("div", { className: "analyst-card" },
    React.createElement("div", { className: "eyebrow" }, "Analyst targets", f.analystCount ? ' · ' + f.analystCount + ' analysts' : ''),
    React.createElement("div", { className: "analyst-row" },
      React.createElement("div", null,
        React.createElement("div", { className: "analyst-label" }, "Mean target"),
        React.createElement("div", { className: "mono analyst-val" }, fmt(f.targetMean, market))
      ),
      cur && React.createElement("div", null,
        React.createElement("div", { className: "analyst-label" }, "Upside"),
        React.createElement("div", { className: `mono analyst-val ${f.targetMean > cur ? 'text-up' : 'text-down'}` },
          ((f.targetMean - cur) / cur * 100).toFixed(1) + '%'
        )
      ),
      f.recommendation && React.createElement("div", null,
        React.createElement("div", { className: "analyst-label" }, "Consensus"),
        React.createElement("div", { className: `mono analyst-val rec-${f.recommendation}` }, f.recommendation.replace('_', ' '))
      )
    ),
    (f.targetLow != null && f.targetHigh != null) && React.createElement("div", { className: "analyst-range" },
      React.createElement("span", { className: "analyst-range-label" }, "Range"),
      React.createElement("span", { className: "mono" }, fmt(f.targetLow, market), " – ", fmt(f.targetHigh, market))
    ),
    f.targetSource && React.createElement("div", { className: "analyst-attrib" },
      (f.targetUpdated
        ? 'Updated ' + new Date(f.targetUpdated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' via '
        : 'via ') + f.targetSource
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
        React.createElement("div", { className: "fund-val mono" }, s.value)
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
  const { Icon, useSwipeDownToClose, useBodyScrollLock, prettyName, resolveTickerName, fmt, fmtCcy, fmtCcySigned, fmtIndicator, indicatorFor, timeAgo, PriceBlock, sanitizeDecimalInput } = window.PBApp;
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
  window.PBModals = window.PBModals || {};
  window.PBModals.SectorAllocationModal = SectorAllocationModal;
  window.PBModals.SectorDetailModal = SectorDetailModal;
  window.PBModals.ContributionModal = ContributionModal;
  window.PBModals.ContributionImportModal = ContributionImportModal;
  window.PBModals.DetailModal = DetailModal;
})();
