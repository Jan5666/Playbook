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
// Stock / indicator detail card - the app's richest read-only surface (quote,
// position P&L, chart, fundamentals, watchlist, notes, news + a price-alert
// popup via ReactDOM.createPortal). Display + delegate only; mutations are props.
function DetailModal(_ref10) {
  const { Icon, useSwipeDownToClose, useBodyScrollLock, prettyName, resolveTickerName, fmt, fmtCcy, fmtCcySigned, fmtIndicator, indicatorFor, timeAgo, PriceBlock, PriceChart, FundamentalsBlock, EarningsBadge, WatchlistControl, HoldingNotesControl, IndicatorValueBlock, IndicatorAbout, sanitizeDecimalInput } = window.PBApp;
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
