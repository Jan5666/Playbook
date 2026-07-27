// pb-views.js - extracted view-component bucket (Phase 4). Browser-only classic script.
// Registers window.PBViews.<View> and reads shared app.js primitives from window.PBApp
// at render time (bridge). data.js/PBStore globals are read directly, not via the bridge.
(function () {
  const { useEffect, useRef, useState, useMemo, useCallback, useLayoutEffect } = React; // UMD global; views use these hooks unqualified
// PBCore/PBData module globals used by the extracted Heatmap view (Phase 4 inc 23).
const convertCcy = PBCore.convertCcy;
const positionCostCcy = PBCore.positionCostCcy;
const marketCurrency = PBCore.marketCurrency;
const priceKey = PBCore.priceKey;
const fetchQuoteBatchLight = PBData.fetchQuoteBatchLight;
// More PBCore/PBContent/PBData module globals for the extracted Dashboard view (Phase 4 inc 24).
const CURRENCY_SYMBOLS = PBContent.CURRENCY_SYMBOLS;
const MARKET_CURRENCY = PBCore.MARKET_CURRENCY;
const contribInDisplay = PBCore.contribInDisplay;
const quoteTradedToday = PBCore.quoteTradedToday;
const fetchHistory = PBData.fetchHistory;
// PBContent/PBCore module globals for the extracted Current (Holdings) view (Phase 4 inc 25).
const MARKETS = PBContent.MARKETS;
const valuePositionInCostCcy = PBCore.valuePositionInCostCcy;
// PBCore module global for the extracted Watchlist view (Phase 4 inc 26).
const parseDecimal = PBCore.parseDecimal;
// PBData module global for the relocated shared holding rows (Phase 4 inc 28).
const isUnitTrustId = PBData.isUnitTrustId;
// PBContent module global for the instrument logo pack.
const logoFor = PBContent.logoFor;
// ─── Hot Topics ──────────────────────────────────────────────────────────────
// Earnings countdown across mega-caps + your names + JSE, a scheduled macro
// calendar (Fed/ECB/BOJ/BoE/SARB + data/energy), and AI-surfaced market-moving
// news. Self-refreshes via the parent's 3h TTL cache; pull-to-refresh on demand.
const HOT_TAG_LABEL = {
  Fed: 'FED', ECB: 'ECB', BOJ: 'BOJ', BOE: 'BoE', SARB: 'SARB',
  Data: 'DATA', Energy: 'ENERGY', Geo: 'GEO', Event: 'EVENT'
};
function hotCountdown(diff) {
  if (isNaN(diff)) return '';
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return `in ${diff}d`;
}
function HotTopicsView(_refHT) {
  const { Icon, timeAgo, hotToDate, hotDayDiff, prettyName } = window.PBApp;
  let { hot, onLoad, onOpenDetail, perplexityKey, onOpenAlerts, toast } = _refHT;
  const prices = PBStore.usePricesMap();
  const onLoadRef = useRef(onLoad);
  useEffect(() => { onLoadRef.current = onLoad; }, [onLoad]);
  useEffect(() => { onLoadRef.current && onLoadRef.current(); }, []);
  const doRefresh = () => {
    if (hot && hot.loading) return;
    if (toast) toast('Refreshing Hot Topics…');
    onLoadRef.current && onLoadRef.current(true);
  };
  const data = hot && hot.data;
  const loading = hot && hot.loading;
  const earnings = (data && data.earnings) || [];
  const macro = (data && data.macro) || [];
  const news = (data && data.news) || [];

  const updated = data && data.generatedAt
    ? `Updated ${timeAgo(new Date(data.generatedAt).toISOString())}` : (loading ? 'Loading…' : '');

  // ── header ──
  const header = React.createElement("div", { className: "hot-header" },
    React.createElement("div", null,
      React.createElement("div", { className: "hot-title" }, "Hot Topics"),
      React.createElement("div", { className: "hot-sub" },
        data && data.aiUsed ? 'Live · AI + scheduled calendar' : 'Scheduled calendar · add a Perplexity key for live coverage'
      )
    ),
    React.createElement("button", {
      className: `icon-btn ${loading ? 'spin' : ''}`,
      "aria-label": "Refresh",
      disabled: loading,
      onClick: doRefresh
    }, React.createElement(Icon, { name: "refresh" }))
  );

  // ── earnings countdown ──
  const earnSection = React.createElement("div", { className: "hot-section" },
    React.createElement("div", { className: "eyebrow", style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      React.createElement("span", null, "Earnings countdown"),
      React.createElement("span", { className: "hot-count" }, earnings.length ? `${earnings.length} in 30d` : '')
    ),
    earnings.length > 0
      ? React.createElement("div", { className: "hot-earn-grid" }, earnings.map((e, i) => {
          const diff = hotDayDiff(hotToDate(e.date));
          const q = prices[e.market + ':' + e.ticker];
          const urgent = diff <= 3;
          return React.createElement("div", {
            key: e.ticker + e.date + i,
            className: `hot-earn-card${urgent ? ' urgent' : ''}`,
            onClick: () => onOpenDetail(e.ticker, e.market)
          },
            React.createElement("div", { className: "hot-earn-top" },
              React.createElement("div", null,
                React.createElement("div", { className: "hot-earn-tkr" },
                  React.createElement("span", { className: "tkr" }, e.ticker),
                  e.market && e.market !== 'US' && React.createElement("span", { className: "market-badge" }, e.market),
                  e.yours && React.createElement("span", { className: "hot-yours" }, "Yours")
                ),
                e.company && React.createElement("div", { className: "hot-earn-name" }, prettyName(e.company))
              ),
              React.createElement("div", { className: `hot-cd${urgent ? ' urgent' : ''}` }, hotCountdown(diff))
            ),
            React.createElement("div", { className: "hot-earn-bottom" },
              React.createElement("span", { className: "hot-earn-date" },
                hotToDate(e.date) ? hotToDate(e.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : ''
              ),
              e.when && e.when !== 'TBD' && React.createElement("span", { className: "hot-when" }, e.when),
              q && typeof q.changePct === 'number' && React.createElement("span", {
                className: `hot-chg ${q.changePct >= 0 ? 'up' : 'down'}`
              }, (q.changePct >= 0 ? '+' : '') + q.changePct.toFixed(2) + '%')
            )
          );
        }))
      : React.createElement("div", { className: "hot-empty" },
          loading ? 'Loading earnings…' : 'No big-name earnings in the next 30 days.')
  );

  // ── macro calendar ──
  const macroSection = React.createElement("div", { className: "hot-section" },
    React.createElement("div", { className: "eyebrow" }, "Macro & events"),
    macro.length > 0
      ? React.createElement("div", { className: "hot-event-list" }, macro.map((m, i) => {
          const d = hotToDate(m.date);
          const diff = hotDayDiff(d);
          const t = (m.type || 'Event');
          const urgent = diff <= 2;
          return React.createElement("div", { key: m.date + m.title + i, className: "hot-event" },
            React.createElement("div", { className: "hot-event-when" },
              React.createElement("div", { className: "hot-event-day" }, d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''),
              React.createElement("div", { className: `hot-event-cd${urgent ? ' urgent' : ''}` }, hotCountdown(diff))
            ),
            React.createElement("div", { className: "hot-event-body" },
              React.createElement("div", { className: "hot-event-title" }, m.title),
              m.detail && React.createElement("div", { className: "hot-event-detail" }, m.detail)
            ),
            React.createElement("span", { className: `hot-tag tag-${String(t).toLowerCase()}` }, HOT_TAG_LABEL[t] || String(t).toUpperCase())
          );
        }))
      : React.createElement("div", { className: "hot-empty" }, loading ? 'Loading calendar…' : 'No scheduled events.')
  );

  // ── what's moving (news) ──
  const newsSection = React.createElement("div", { className: "hot-section" },
    React.createElement("div", { className: "eyebrow" }, "What's moving"),
    news.length > 0
      ? React.createElement("div", null, news.map((n, i) => React.createElement("a", {
          key: i,
          href: n.link && n.link !== '#' ? n.link : undefined,
          target: "_blank", rel: "noopener",
          className: "news-item news-item-ai"
        },
          React.createElement("div", { className: "news-title" }, React.createElement("span", { className: "news-ai-badge" }, "AI"), n.title),
          n.summary && React.createElement("div", { className: "news-summary" }, n.summary),
          React.createElement("div", { className: "news-meta" },
            React.createElement("span", null, n.source),
            n.pubDate && React.createElement(React.Fragment, null, React.createElement("span", null, "·"), React.createElement("span", null, timeAgo(n.pubDate))),
            React.createElement(Icon, { name: "external", size: 11 })
          )
        )))
      : React.createElement("div", { className: "hot-empty" },
          perplexityKey
            ? (loading ? 'Fetching headlines…' : 'No market-moving headlines right now.')
            : React.createElement("span", null,
                "Add a Perplexity key to surface live market-moving & energy news. ",
                React.createElement("button", { className: "linklike", onClick: onOpenAlerts }, "Add key")
              ))
  );

  return React.createElement("div", { className: "hot-view" },
    header,
    earnSection,
    macroSection,
    newsSection,
    updated && React.createElement("div", { className: "hot-updated" }, updated)
  );
}

// --- New picks (moved from app.js, Phase 4 inc 8) ---
function PicksView(_ref9) {
  const { PriceBlock, fmt } = window.PBApp;
  const DATA = window.PB_DATA;
  let {
    onOpenDetail
  } = _ref9;
  const prices = PBStore.usePricesMap();
  return React.createElement("div", null, React.createElement("div", {
    className: "grid grid-2"
  }, DATA.NEW_PICKS.map(p => {
    const q = prices['US:' + p.ticker];
    const upsideNow = q && p.entryPrice ? (p.targetPrice - q.price) / q.price * 100 : null;
    return React.createElement("div", {
      key: p.ticker,
      className: "pos-card",
      onClick: () => onOpenDetail(p.ticker, 'US')
    }, React.createElement("div", {
      className: "pos-head"
    }, React.createElement("div", {
      className: "flex-1"
    }, React.createElement("div", {
      className: "flex items-center gap-2"
    }, React.createElement("span", {
      className: "tkr"
    }, p.ticker), React.createElement("span", {
      className: "market-badge"
    }, p.allocation, "%")), React.createElement("div", {
      className: "tkr-name"
    }, p.name, " \xB7 ", p.sector)), React.createElement("span", {
      className: `pill ${p.conviction === 'HIGH' ? 'pill-buy' : 'pill-hold'}`
    }, p.conviction)), React.createElement("div", {
      className: "current-price-label"
    }, "Current"), React.createElement(PriceBlock, {
      quote: q,
      size: "lg",
      market: 'US'
    }), React.createElement("div", {
      className: "kv-row mt-3"
    }, React.createElement("div", {
      className: "kv"
    }, React.createElement("div", {
      className: "kv-label"
    }, "Entry"), React.createElement("div", {
      className: "kv-val"
    }, fmt(p.entryPrice, 'US'))), React.createElement("div", {
      className: "kv"
    }, React.createElement("div", {
      className: "kv-label"
    }, "Target"), React.createElement("div", {
      className: "kv-val"
    }, fmt(p.targetPrice, 'US'))), React.createElement("div", {
      className: "kv"
    }, React.createElement("div", {
      className: "kv-label"
    }, "Upside"), React.createElement("div", {
      className: "kv-val up"
    }, upsideNow != null ? (upsideNow >= 0 ? '+' : '') + upsideNow.toFixed(0) + '%' : '+' + p.upside + '%'))), React.createElement("div", {
      className: "text-sm text-muted mt-3",
      style: {
        lineHeight: 1.5
      }
    }, p.thesis));
  })));
}

// --- Hedges (moved from app.js, Phase 4 inc 9) ---
function HedgesView(_ref0) {
  const { PriceBlock } = window.PBApp;
  const DATA = window.PB_DATA;
  let {
    onOpenDetail
  } = _ref0;
  const prices = PBStore.usePricesMap();
  return React.createElement("div", null, React.createElement("div", {
    className: "grid grid-2"
  }, DATA.HEDGES.map(h => {
    const q = prices['US:' + h.ticker];
    return React.createElement("div", {
      key: h.ticker,
      className: "pos-card",
      onClick: () => onOpenDetail(h.ticker, 'US')
    }, React.createElement("div", {
      className: "pos-head"
    }, React.createElement("div", {
      className: "flex-1"
    }, React.createElement("div", {
      className: "flex items-center gap-2"
    }, React.createElement("span", {
      className: "tkr"
    }, h.ticker), React.createElement("span", {
      className: "market-badge"
    }, h.allocation, "%")), React.createElement("div", {
      className: "tkr-name"
    }, h.name))), React.createElement(PriceBlock, {
      quote: q,
      size: "lg",
      market: 'US'
    }), React.createElement("div", {
      className: "text-xs text-dim mono mt-2",
      style: {
        letterSpacing: '0.1em',
        textTransform: 'uppercase'
      }
    }, h.role), React.createElement("div", {
      className: "text-sm text-muted mt-2"
    }, h.rationale));
  })), React.createElement("div", {
    className: "mt-6"
  }, React.createElement("div", {
    className: "eyebrow"
  }, "Explicitly skipped"), React.createElement("div", {
    className: "card"
  }, React.createElement("ul", {
    className: "bullet-list"
  }, React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "TLT"), " \u2014 17-yr duration too sensitive to Fed error. IEF covers it with less drawdown risk.")), React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "VIXY / UVXY"), " \u2014 constant contango decay. Structural money-loser for retail holders.")), React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "SH / SPXS"), " \u2014 inverse equity erodes via compounding. Cash beats inverse ETFs over any holding period >1 month.")), React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "GDXJ"), " \u2014 too correlated with tech beta. IAU alone delivers the gold exposure cleanly."))))));
}

// --- Rules (moved from app.js, Phase 4 inc 10) ---
function ruleSection(section, cardClass) {
  return [React.createElement("div", {
    key: section.id + '-eyebrow',
    className: "eyebrow"
  }, section.heading), React.createElement("div", {
    key: section.id + '-card',
    className: cardClass
  }, React.createElement("ul", {
    className: "bullet-list"
  }, section.bullets.map((b, i) => React.createElement("li", {
    key: i
  }, React.createElement("span", null, b.strong ? React.createElement("strong", null, b.strong) : null, b.text)))))];
}
function RulesView() {
  const RULES = PBContent.RULES;
  const DATA = window.PB_DATA;
  const byId = id => RULES.find(s => s.id === id);
  return React.createElement("div", null, ...ruleSection(byId('trim'), "card mb-4"), ...ruleSection(byId('thesisBreak'), "card mb-4"), React.createElement("div", {
    className: "eyebrow"
  }, "Key risks"), React.createElement("div", {
    className: "grid grid-2 mb-4"
  }, DATA.RISKS.map((r, i) => React.createElement("div", {
    key: i,
    className: "card"
  }, React.createElement("div", {
    className: "flex justify-between items-center mb-2",
    style: {
      gap: 8
    }
  }, React.createElement("div", {
    className: "font-semibold",
    style: {
      fontSize: 14,
      lineHeight: 1.3
    }
  }, r.title), React.createElement("span", {
    className: `pill ${r.probability === 'HIGH' ? 'pill-danger' : 'pill-warn'}`
  }, r.probability)), React.createElement("div", {
    className: "text-sm text-muted"
  }, r.impact)))), ...ruleSection(byId('saTax'), "card"));
}

// --- Overview / Thesis (moved from app.js, Phase 4 inc 10) ---
function OverviewView(_ref1) {
  const { PriceBlock, THESIS_SNAPSHOT } = window.PBApp;
  const DATA = window.PB_DATA;
  const prices = PBStore.usePricesMap();
  return React.createElement("div", null, React.createElement("div", {
    className: "grid grid-3"
  }, DATA.PILLARS.map(p => React.createElement("div", {
    key: p.num,
    className: "card"
  }, React.createElement("div", {
    className: "mono text-xs text-dim mb-3",
    style: {
      letterSpacing: '0.2em'
    }
  }, p.num), React.createElement("h3", {
    className: "serif font-bold mb-2",
    style: {
      fontSize: 20,
      lineHeight: 1.2
    }
  }, p.title), React.createElement("p", {
    className: "text-sm text-muted",
    style: {
      lineHeight: 1.6
    }
  }, p.body), React.createElement("div", {
    className: "mono text-xs text-dim mt-3",
    style: {
      paddingTop: 12,
      borderTop: '1px solid var(--border)',
      letterSpacing: '0.15em',
      textTransform: 'uppercase'
    }
  }, "\u2192 ", p.action)))), React.createElement("div", {
    className: "mt-6"
  }, React.createElement("div", {
    className: "eyebrow"
  }, "Live snapshot \u2014 key names"), React.createElement("div", {
    className: "grid grid-4"
  }, THESIS_SNAPSHOT.map(t => {
    const q = prices['US:' + t];
    const h = DATA.HOLDINGS.find(x => x.ticker === t);
    return React.createElement("div", {
      key: t,
      className: "pos-card"
    }, React.createElement("div", {
      className: "flex justify-between items-center mb-2"
    }, React.createElement("span", {
      className: "tkr-sm"
    }, t), React.createElement("span", {
      className: `pill pill-${h?.actionType || 'hold'}`
    }, h?.action.split(' ')[0] || 'HOLD')), React.createElement(PriceBlock, {
      quote: q,
      market: 'US'
    }));
  }))));
}
// ─── Market rotation ─────────────────────────────────────────────────────────
// "Where did money move today?" One tab that answers three questions the heatmap
// can't: is money flowing INTO the market, OUT of it, or just ROTATING between
// sectors — and if it's rotating, from which sectors into which. It reuses the
// heatmap's constituent universe (PB_DATA.HEATMAPS) and its light batch fetcher
// for the snapshot, plus 5-minute intraday bars for the "how it moved through the
// day" chart. All the number-crunching lives in PBCore (node-tested); this file
// is fetch orchestration + SVG. Flow is a price-based proxy (index weight x day
// move), NOT observed volume — labelled as an estimate throughout.
const RE = React.createElement;
const ROT_PALETTE = ['var(--blue)', 'var(--amber)', 'var(--purple)', 'var(--brand)'];
const ROT_DIM = 'var(--text-dim)';
function rotShort(sector) { return (PBContent.ROTATION_SECTOR_SHORT && PBContent.ROTATION_SECTOR_SHORT[sector]) || sector; }
function rotBn(sym, v, signed) {
  const a = Math.abs(v);
  const d = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  const sign = v < 0 ? '−' : (signed ? '+' : '');
  return sign + sym + a.toFixed(d) + 'bn';
}
function rotPct(v, signed) { return (signed && v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
function rotTime(ms, tz) {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(ms)); }
  catch (_e) { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
}
// #1 inflow -> emerald, #1 outflow -> rose, next four movers -> a fixed palette,
// everything else dimmed. Returns sector -> css color; sectors absent from the
// map render in the dim default so the eye lands on the movers that matter.
function rotColors(classified) {
  const map = {};
  if (!classified) return map;
  if (classified.inflows[0]) map[classified.inflows[0].sector] = 'var(--emerald)';
  if (classified.outflows[0]) map[classified.outflows[0].sector] = 'var(--rose)';
  const rest = classified.inflows.slice(1).concat(classified.outflows.slice(1))
    .sort((a, b) => Math.abs(b.deltaCap) - Math.abs(a.deltaCap));
  let pi = 0;
  for (const s of rest) { if (map[s.sector]) continue; if (pi < ROT_PALETTE.length) map[s.sector] = ROT_PALETTE[pi++]; }
  return map;
}
// Fold each side to <=6 blocks (+ an "Others" bucket) and re-key the exact
// pairFlows ribbons onto the folded blocks. Sentinels for the two "Others"
// buckets can't collide with real GICS sector names.
const ROT_OUT_OTHER = 'out-others', ROT_IN_OTHER = 'in-others';
function rotFlowDisplay(classified, flows) {
  const MAXSIDE = 6;
  function fold(arr, sentinel) {
    const mk = s => ({ sector: s.sector, label: rotShort(s.sector), amt: Math.abs(s.deltaCap), wPct: s.wPct });
    if (arr.length <= MAXSIDE) return { blocks: arr.map(mk), folded: new Set() };
    const head = arr.slice(0, MAXSIDE).map(mk);
    const tail = arr.slice(MAXSIDE);
    head.push({ sector: sentinel, label: 'Others (' + tail.length + ')', amt: tail.reduce((t, s) => t + Math.abs(s.deltaCap), 0), wPct: null });
    return { blocks: head, folded: new Set(tail.map(s => s.sector)) };
  }
  const outF = fold(classified.outflows, ROT_OUT_OTHER);
  const inF = fold(classified.inflows, ROT_IN_OTHER);
  const rem = (name, folded, sentinel) => folded.has(name) ? sentinel : name;
  const agg = new Map();
  for (const f of (flows.flows || [])) {
    const from = rem(f.from, outF.folded, ROT_OUT_OTHER), to = rem(f.to, inF.folded, ROT_IN_OTHER);
    const key = from + ' ' + to;
    agg.set(key, (agg.get(key) || 0) + f.amount);
  }
  const ribbons = [...agg.entries()].map(([k, amount]) => { const parts = k.split(' '); return { from: parts[0], to: parts[1], amount }; });
  return { outBlocks: outF.blocks, inBlocks: inF.blocks, ribbons };
}

// Measures a container element via ResizeObserver, returning [ref, width].
// Bucket-private (Phase 4 inc 33): consumed only by pb-views.js components
// (RotationFlowDiagram, RotationIntradayChart, HeatmapTreemap) — moved off the
// window.PBApp bridge since it has no root-App and no pb-modals caller.
function useContainerWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return;
    const el = ref.current;
    // clientWidth and contentRect.width are both the inner content box (exclude
    // the border), so the treemap layout matches where absolutely-positioned
    // cells actually live — no off-by-border clipping at the right edge.
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// The rotation ribbons: outflow sectors stacked left (losing cap), inflow right
// (gaining), curved bands between them sized by estimated matched flow.
function RotationFlowDiagram(_p) {
  const { classified, flows, sym, highlight, onHighlight } = _p;
  const [wrapRef, width] = useContainerWidth();
  const disp = useMemo(() => rotFlowDisplay(classified, flows), [classified, flows]);
  const W = Math.max(280, width || 0);
  const colW = Math.max(88, Math.min(150, W * 0.28));
  const maxRows = Math.max(disp.outBlocks.length, disp.inBlocks.length, 1);
  const H = Math.max(220, Math.min(340, 44 * maxRows));
  const GAP = 6, MINH = 24;
  function layoutSide(blocks) {
    const n = blocks.length;
    if (n === 0) return [];
    const avail = H - (n - 1) * GAP;
    const total = blocks.reduce((t, b) => t + b.amt, 0) || 1;
    let hs = blocks.map(b => Math.max(MINH, b.amt / total * avail));
    const sumH = hs.reduce((a, b) => a + b, 0) || 1;
    hs = hs.map(h => h * (avail / sumH));
    let y = 0; const out = [];
    for (let i = 0; i < n; i++) { out.push(Object.assign({}, blocks[i], { y, h: hs[i] })); y += hs[i] + GAP; }
    return out;
  }
  const els = [];
  if (width > 20) {
    const outL = layoutSide(disp.outBlocks), inL = layoutSide(disp.inBlocks);
    const outA = {}, inA = {};
    outL.forEach(b => { outA[b.sector] = { yTop: b.y, h: b.h, used: 0, sum: 0 }; });
    inL.forEach(b => { inA[b.sector] = { yTop: b.y, h: b.h, used: 0, sum: 0 }; });
    disp.ribbons.forEach(r => { if (outA[r.from]) outA[r.from].sum += r.amount; if (inA[r.to]) inA[r.to].sum += r.amount; });
    const x1 = colW, x2 = W - colW, dx = x2 - x1;
    const ribbons = disp.ribbons.slice().sort((a, b) => (outA[a.from] ? outA[a.from].yTop : 0) - (outA[b.from] ? outA[b.from].yTop : 0));
    ribbons.forEach((r, idx) => {
      const o = outA[r.from], iA = inA[r.to];
      if (!o || !iA || o.sum <= 0 || iA.sum <= 0) return;
      const sh = o.h * r.amount / o.sum, dh = iA.h * r.amount / iA.sum;
      const ys0 = o.yTop + o.used, ys1 = ys0 + sh; o.used += sh;
      const yd0 = iA.yTop + iA.used, yd1 = yd0 + dh; iA.used += dh;
      const d = 'M ' + x1 + ',' + ys0.toFixed(1) + ' C ' + (x1 + dx * 0.45) + ',' + ys0.toFixed(1) + ' ' + (x2 - dx * 0.45) + ',' + yd0.toFixed(1) + ' ' + x2 + ',' + yd0.toFixed(1) +
        ' L ' + x2 + ',' + yd1.toFixed(1) + ' C ' + (x2 - dx * 0.45) + ',' + yd1.toFixed(1) + ' ' + (x1 + dx * 0.45) + ',' + ys1.toFixed(1) + ' ' + x1 + ',' + ys1.toFixed(1) + ' Z';
      const dim = highlight && highlight !== r.from && highlight !== r.to;
      els.push(RE('path', { key: 'r' + idx, d, className: 'rot-flow-ribbon' + (dim ? ' dim' : ''), fill: 'url(#rotFlowGrad)' }));
    });
    function drawBlocks(list, side) {
      list.forEach(b => {
        const x = side === 'out' ? 0 : W - colW;
        const isOther = b.sector === ROT_OUT_OTHER || b.sector === ROT_IN_OTHER;
        const dim = highlight && highlight !== b.sector;
        els.push(RE('rect', {
          key: side + b.sector, x, y: b.y, width: colW, height: b.h, rx: 8,
          className: 'rot-flow-block ' + side + (dim ? ' dim' : ''),
          onClick: isOther ? undefined : (() => onHighlight(highlight === b.sector ? null : b.sector)),
          style: isOther ? undefined : { cursor: 'pointer' }
        }));
        const cx = x + colW / 2;
        els.push(RE('text', { key: side + b.sector + 'n', x: cx, y: b.y + (b.h >= 34 ? b.h / 2 - 4 : b.h / 2 + 3), className: 'rot-flow-name', textAnchor: 'middle' }, b.label));
        if (b.h >= 34) els.push(RE('text', { key: side + b.sector + 'a', x: cx, y: b.y + b.h / 2 + 11, className: 'rot-flow-amt', textAnchor: 'middle' },
          (b.wPct != null ? rotPct(b.wPct, true) + '  ' : '') + rotBn(sym, side === 'out' ? -b.amt : b.amt, side !== 'out')));
      });
    }
    drawBlocks(outL, 'out'); drawBlocks(inL, 'in');
    // One-sided session: no ribbons exist, so the empty side gets the whole free
    // region as a contained placeholder instead of a bare label on the narrow
    // column (which used to spill past the panel edge).
    if (outL.length === 0 || inL.length === 0) {
      const emptyIn = inL.length === 0;
      const ex0 = emptyIn ? colW + 16 : 0;
      const ex1 = emptyIn ? W : W - colW - 16;
      els.push(RE('rect', { key: 'empty-box', x: ex0, y: 0, width: ex1 - ex0, height: H, rx: 8, className: 'rot-flow-empty' }));
      els.push(RE('text', { key: 'empty-note', x: (ex0 + ex1) / 2, y: H / 2 + 4, className: 'rot-flow-note', textAnchor: 'middle' },
        emptyIn ? 'No measurable inflows' : 'No measurable outflows'));
    }
  }
  return RE('div', { ref: wrapRef, className: 'rot-flow-wrap' },
    width > 20 ? RE('svg', { className: 'rot-flow-svg', viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H, role: 'img', 'aria-label': 'Sector money-flow diagram' },
      RE('defs', null, RE('linearGradient', { id: 'rotFlowGrad', x1: '0', y1: '0', x2: '1', y2: '0' },
        RE('stop', { offset: '0%', className: 'rot-grad-from' }), RE('stop', { offset: '100%', className: 'rot-grad-to' }))),
      els) : null);
}

// Cumulative sector performance through the trading day, benchmark emphasised,
// top movers coloured, the rest dimmed. Tap a line's legend chip (or a list row)
// to isolate it.
function RotationIntradayChart(_p) {
  const { built, colorMap, market, highlight, onHighlight } = _p;
  const [wrapRef, width] = useContainerWidth();
  const W = Math.max(280, width || 0), H = 240;
  const padL = 8, padR = 48, padT = 10, padB = 22;
  const ts = built && built.ts ? built.ts : [];
  const ready = width > 20 && ts.length >= 2;
  const tz = PBCore.SESSIONS[market] ? PBCore.SESSIONS[market].tz : undefined;
  const svgKids = [];
  if (ready) {
    const rs = built.regularStart, re = built.regularEnd, lastTs = ts[ts.length - 1];
    const hasPost = built.sessionAt && built.sessionAt.some(s => s === 'post');
    const xmin = rs != null ? Math.max(ts[0], rs - 3600000) : ts[0];
    const xmax = re != null ? Math.max(lastTs, re + (hasPost ? 3600000 : 0)) : lastTs;
    let ymin = 0, ymax = 0;
    const consider = v => { if (v == null || !isFinite(v)) return; if (v < ymin) ymin = v; if (v > ymax) ymax = v; };
    for (let g = 0; g < ts.length; g++) { if (ts[g] < xmin || ts[g] > xmax) continue; consider(built.benchmark[g]); built.series.forEach(s => consider(s.cum[g])); }
    if (ymax - ymin < 0.2) { ymax += 0.5; ymin -= 0.5; }
    const py = (ymax - ymin) * 0.08; ymax += py; ymin -= py;
    const xS = t => padL + (t - xmin) / (xmax - xmin || 1) * (W - padL - padR);
    const yS = v => padT + (ymax - v) / (ymax - ymin || 1) * (H - padT - padB);
    // pre/post shading
    if (rs != null && rs > xmin) svgKids.push(RE('rect', { key: 'pre', className: 'rot-band', x: xS(xmin), y: padT, width: Math.max(0, xS(rs) - xS(xmin)), height: H - padT - padB }));
    if (re != null && re < xmax) svgKids.push(RE('rect', { key: 'post', className: 'rot-band', x: xS(re), y: padT, width: Math.max(0, xS(xmax) - xS(re)), height: H - padT - padB }));
    // zero line
    const yz = yS(0);
    svgKids.push(RE('line', { key: 'zero', className: 'rot-zero', x1: padL, y1: yz, x2: W - padR, y2: yz }));
    svgKids.push(RE('text', { key: 'zlbl', className: 'rot-axis-lbl', x: W - padR + 3, y: yz + 3 }, '0%'));
    // time ticks
    const ticks = (rs != null && re != null) ? [rs, (rs + re) / 2, re] : [xmin, (xmin + xmax) / 2, xmax];
    ticks.forEach((t, i) => {
      if (t < xmin || t > xmax) return;
      svgKids.push(RE('text', { key: 'tick' + i, className: 'rot-axis-lbl', x: xS(t), y: H - 6, textAnchor: i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle' }, rotTime(t, tz)));
    });
    const linePath = cum => {
      let d = '', pen = false;
      for (let g = 0; g < ts.length; g++) {
        if (ts[g] < xmin || ts[g] > xmax) { continue; }
        const v = cum[g];
        if (v == null || !isFinite(v)) { pen = false; continue; }
        d += (pen ? ' L ' : ' M ') + xS(ts[g]).toFixed(1) + ',' + yS(v).toFixed(1);
        pen = true;
      }
      return d.trim();
    };
    // dim non-highlighted; draw dim sectors first, then coloured, then benchmark on top
    const ordered = built.series.slice().sort((a, b) => (colorMap[a.key] ? 1 : 0) - (colorMap[b.key] ? 1 : 0));
    ordered.forEach(s => {
      const col = colorMap[s.key] || ROT_DIM;
      const isMover = !!colorMap[s.key];
      const faded = highlight && highlight !== s.key;
      const op = faded ? 0.12 : (isMover ? 0.95 : 0.35);
      const d = linePath(s.cum);
      if (d) svgKids.push(RE('path', { key: 'ln' + s.key, className: 'rot-line', d, stroke: col, strokeWidth: highlight === s.key ? 2.6 : (isMover ? 1.7 : 1.2), opacity: op, fill: 'none' }));
    });
    const bd = linePath(built.benchmark);
    if (bd) svgKids.push(RE('path', { key: 'bench', className: 'rot-line-bench', d: bd, opacity: highlight ? 0.5 : 0.95, fill: 'none' }));
    // right-edge value labels (benchmark + movers), collision-pushed
    const labels = [];
    const finalOf = cum => { for (let g = ts.length - 1; g >= 0; g--) { if (ts[g] > xmax) continue; if (cum[g] != null && isFinite(cum[g])) return { v: cum[g], g }; } return null; };
    const bf = finalOf(built.benchmark);
    if (bf) labels.push({ y: yS(bf.v), text: rotPct(bf.v, true), col: 'var(--text)', w: 700 });
    built.series.forEach(s => { if (!colorMap[s.key]) return; const f = finalOf(s.cum); if (f) labels.push({ y: yS(f.v), text: rotPct(f.v, true), col: colorMap[s.key], w: 600 }); });
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 11) labels[i].y = labels[i - 1].y + 11;
    labels.forEach((l, i) => svgKids.push(RE('text', { key: 'vl' + i, className: 'rot-val-lbl', x: W - padR + 3, y: l.y + 3, fill: l.col, style: { fontWeight: l.w } }, l.text)));
  }
  // legend chips (HTML), tap to isolate
  const legendItems = built && built.series ? built.series.filter(s => colorMap[s.key]).sort((a, b) => {
    const fa = a.cum[a.cum.length - 1], fb = b.cum[b.cum.length - 1];
    return Math.abs(fb || 0) - Math.abs(fa || 0);
  }) : [];
  const legend = RE('div', { className: 'rot-legend' },
    RE('button', { className: 'rot-legend-chip' + (highlight === '__bench' ? ' active' : ''), onClick: () => onHighlight(highlight === '__bench' ? null : '__bench') },
      RE('span', { className: 'rot-legend-dot', style: { background: 'var(--text)' } }), 'Market'),
    legendItems.map(s => RE('button', {
      key: s.key, className: 'rot-legend-chip' + (highlight === s.key ? ' active' : ''),
      onClick: () => onHighlight(highlight === s.key ? null : s.key)
    }, RE('span', { className: 'rot-legend-dot', style: { background: colorMap[s.key] } }), rotShort(s.key))));
  return RE('div', { className: 'rot-chart-outer' },
    RE('div', { ref: wrapRef, className: 'rot-chart-wrap' },
      ready ? RE('svg', { className: 'rot-chart-svg', viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H, role: 'img', 'aria-label': 'Intraday sector performance' }, svgKids) : null),
    legend);
}

// Per-sector detail: the numbers behind the picture. Sorted by estimated flow.
function RotationSectorList(_p) {
  const { sectors, marketPct, sym, market, colorMap, highlight, onHighlight, onOpenDetail } = _p;
  return RE('div', { className: 'rot-list' },
    sectors.map(s => {
      if (s.wPct == null) return null;
      const col = colorMap[s.sector] || ROT_DIM;
      const bps = Math.round((s.wPct - marketPct) * 100);
      const faded = highlight && highlight !== s.sector;
      return RE('div', {
        key: s.sector, className: 'rot-row' + (highlight === s.sector ? ' hl' : '') + (faded ? ' faded' : ''),
        onClick: () => onHighlight(highlight === s.sector ? null : s.sector)
      },
        RE('div', { className: 'rot-row-main' },
          RE('span', { className: 'rot-row-dot', style: { background: col } }),
          RE('div', { className: 'rot-row-name' }, rotShort(s.sector),
            RE('span', { className: 'rot-row-sub' }, '▲ ' + s.adv + ' / ▼ ' + s.dec)),
          RE('span', { className: 'rot-row-num ' + (s.wPct >= 0 ? 'up' : 'down') }, rotPct(s.wPct, true)),
          RE('span', { className: 'rot-row-num rot-row-bps' }, (bps >= 0 ? '+' : '') + bps + ' bp'),
          RE('span', { className: 'rot-row-num rot-row-flow ' + (s.deltaCap >= 0 ? 'up' : 'down') }, rotBn(sym, s.deltaCap, true))
        ),
        RE('div', { className: 'rot-row-chips' },
          s.top ? RE('button', { className: 'rot-tkr-chip up', onClick: e => { e.stopPropagation(); onOpenDetail(s.top.ticker, market); } }, s.top.ticker + ' ' + rotPct(s.top.changePct, true)) : null,
          s.bottom && s.bottom.ticker !== (s.top && s.top.ticker) ? RE('button', { className: 'rot-tkr-chip down', onClick: e => { e.stopPropagation(); onOpenDetail(s.bottom.ticker, market); } }, s.bottom.ticker + ' ' + rotPct(s.bottom.changePct, true)) : null
        )
      );
    }));
}

function MarketRotationView(_refMR) {
  const { Icon, usePersistedState } = window.PBApp;
  let { onOpenDetail, toast } = _refMR;
  const exchanges = window.PB_DATA.HEATMAPS;
  const [selectedId, setSelectedId] = usePersistedState('pb.rotation.exchange.v1', 'sp500');
  const exchange = exchanges.find(e => e.id === selectedId) || exchanges[0];
  const [persisted, setPersisted] = usePersistedState('pb.rotation.lastgood.v1', {});
  const [cache, setCache] = useState(() => Object.assign({}, persisted));
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(() => persisted[exchange.id] && persisted[exchange.id].fetchedAt ? new Date(persisted[exchange.id].fetchedAt) : null);
  const [highlight, setHighlight] = useState(null);
  const loadRef = useRef(false);
  const cacheKey = exchange.id;
  const cached = cache[cacheKey];
  const sym = (PBCore.MARKET_CURRENCY[exchange.market] && PBCore.MARKET_CURRENCY[exchange.market].sym) || '$';

  const load = useCallback(async (force) => {
    if (loadRef.current) return;
    const existing = cache[cacheKey];
    if (!force && existing && existing.fetchedAt && Date.now() - existing.fetchedAt < 300000) return;
    loadRef.current = true;
    setLoading(true); setError(null);
    const constituents = exchange.constituents;
    setProgress({ phase: 'quotes', done: 0, total: constituents.length });
    const buildRows = quotes => constituents.map(c => {
      const q = quotes[PBCore.priceKey(exchange.market, c.t)];
      return { ticker: c.t, sector: c.s, m: c.m, changePct: q ? q.changePct : null };
    });
    const aggregate = (quotes, series, activity, fetchedAt) => {
      const snapshot = PBCore.aggregateSectorSnapshot(buildRows(quotes));
      const classified = PBCore.classifyRotation(snapshot);
      const flows = PBCore.pairFlows(snapshot.sectors);
      return { snapshot, classified, flows, series: series || null, activity: activity || null, fetchedAt };
    };
    try {
      const items = constituents.map(c => ({ ticker: c.t, market: exchange.market }));
      const quotes = await PBData.fetchQuoteBatchLight(items, (done, total, partial) => {
        setProgress({ phase: 'quotes', done, total });
        if (partial) setCache(prev => Object.assign({}, prev, { [cacheKey]: aggregate(partial, prev[cacheKey] && prev[cacheKey].series, prev[cacheKey] && prev[cacheKey].activity, 0) }));
      });
      if (buildRows(quotes).filter(r => r.changePct != null).length === 0) {
        setError('No live data returned. Try again shortly.');
        return;
      }
      const snapEntry = aggregate(quotes, cached && cached.series, cached && cached.activity, 0);
      setCache(prev => Object.assign({}, prev, { [cacheKey]: snapEntry }));
      // Phase B: intraday sector lines.
      let built = null;
      try {
        const plan = PBCore.buildRotationFetchPlan(exchange, { sectorEtf: PBContent.SECTOR_ETF, topN: 3 });
        const syms = []; const seen = new Set();
        plan.legs.forEach(leg => leg.symbols.forEach(s => { const k = PBCore.priceKey(s.market, s.ticker); if (!seen.has(k)) { seen.add(k); syms.push(s); } }));
        const bars = {}; let done = 0;
        setProgress({ phase: 'intraday', done: 0, total: syms.length });
        for (let i = 0; i < syms.length; i += 6) {
          const chunk = syms.slice(i, i + 6);
          const res = await Promise.allSettled(chunk.map(s => PBData.fetchIntradayBars(s.ticker, s.market)));
          res.forEach((r, j) => { if (r.status === 'fulfilled' && r.value) bars[PBCore.priceKey(chunk[j].market, chunk[j].ticker)] = r.value; });
          done = Math.min(done + chunk.length, syms.length);
          setProgress({ phase: 'intraday', done, total: syms.length });
        }
        built = PBCore.combineSectorSeries(plan, bars);
        if (!built.series || built.series.length === 0) built = null;
      } catch (_e) { built = null; }
      const finalEntry = { snapshot: snapEntry.snapshot, classified: snapEntry.classified, flows: snapEntry.flows, series: built, activity: built ? built.activity : null, fetchedAt: Date.now() };
      setCache(prev => Object.assign({}, prev, { [cacheKey]: finalEntry }));
      const persistFlows = Object.assign({}, snapEntry.flows, { flows: (snapEntry.flows.flows || []).filter(f => f.amount >= 0.01 * (snapEntry.flows.matched || 1)) });
      setPersisted(prev => Object.assign({}, prev, { [cacheKey]: {
        snapshot: snapEntry.snapshot, classified: snapEntry.classified, flows: persistFlows,
        series: built ? PBCore.downsampleRotationSeries(built, 48) : null,
        activity: built ? built.activity : null, fetchedAt: finalEntry.fetchedAt
      } }));
      setLastUpdate(new Date());
    } catch (_e) {
      setError('Failed to load rotation data. Check your connection.');
    } finally {
      loadRef.current = false; setLoading(false); setProgress(null);
    }
  }, [cacheKey, exchange, cache, cached, setPersisted]);

  useEffect(() => {
    const e = cache[cacheKey];
    if (e && e.fetchedAt) setLastUpdate(new Date(e.fetchedAt));
    setHighlight(null);
    load(false);
  }, [cacheKey]);

  const colorMap = useMemo(() => rotColors(cached && cached.classified), [cached && cached.classified]);
  const onHi = useCallback(name => setHighlight(name), []);
  const session = PBCore.marketSession(exchange.market);
  const classified = cached && cached.classified;
  const snapshot = cached && cached.snapshot;
  const flows = cached && cached.flows;
  const series = cached && cached.series;
  const copy = PBContent.ROTATION_COPY;
  const marketPct = classified ? classified.marketPct : 0;
  const flowShown = classified && flows && (flows.totalIn > 0.05 || flows.totalOut > 0.05);
  const progText = progress ? (progress.phase === 'intraday' ? 'Intraday ' + progress.done + ' / ' + progress.total : progress.done + ' / ' + progress.total + ' quotes') : '';

  return RE('div', { className: 'rot-view' },
    // Exchange chips
    RE('div', { className: 'heatmap-toggle' },
      exchanges.map(ex => RE('button', {
        key: ex.id, className: 'heatmap-toggle-btn ' + (ex.id === selectedId ? 'active' : ''),
        onClick: () => setSelectedId(ex.id)
      }, ex.label))),
    error ? RE('div', { className: 'verify-error' }, error) : null,
    loading ? RE('div', { className: 'heatmap-progress' },
      RE('div', { className: 'heatmap-progress-bar' },
        RE('div', { className: 'heatmap-progress-fill', style: { width: (progress && progress.total ? Math.round(progress.done / progress.total * 100) : 5) + '%' } })),
      RE('span', { className: 'heatmap-progress-text' }, progText || ('Loading ' + exchange.label + '…'))) : null,
    // Verdict card
    classified ? RE('div', { className: 'rot-verdict-card' },
      RE('div', { className: 'rot-verdict-top' },
        RE('span', { className: 'rot-verdict-pill v-' + classified.verdict }, copy.verdicts[classified.verdict] || 'Market'),
        RE('span', { className: 'rot-phase-chip' + (session.phase !== 'closed' ? ' live' : '') },
          session.phase !== 'closed' ? RE('span', { className: 'rot-phase-dot' }) : null,
          copy.phase[session.phase] || 'Market')),
      RE('div', { className: 'rot-detail' }, PBCore.rotationSummary(classified)),
      RE('div', { className: 'rot-stats-row' },
        RE('div', { className: 'rot-stat' }, RE('span', { className: 'rot-stat-label' }, 'Market'), RE('span', { className: 'rot-stat-val ' + (marketPct >= 0 ? 'up' : 'down') }, rotPct(marketPct, true))),
        RE('div', { className: 'rot-stat' }, RE('span', { className: 'rot-stat-label' }, 'Breadth'), RE('span', { className: 'rot-stat-val' }, Math.round(classified.breadthPct * 100) + '% adv')),
        RE('div', { className: 'rot-stat' }, RE('span', { className: 'rot-stat-label' }, 'Dispersion'), RE('span', { className: 'rot-stat-val' }, classified.dispersion.toFixed(2) + 'pp')),
        RE('div', { className: 'rot-stat' }, RE('span', { className: 'rot-stat-label' }, 'Net flow'), RE('span', { className: 'rot-stat-val ' + (flows.net >= 0 ? 'up' : 'down') }, rotBn(sym, flows.net, true)))),
      classified.confidence === 'low' && snapshot ? RE('div', { className: 'rot-conf-low' }, 'Partial data — ' + snapshot.market.quoted + ' of ' + snapshot.market.count + ' names quoted') : null
    ) : (!loading && !error ? RE('div', { className: 'rot-empty' }, 'Loading rotation…') : null),
    // Flow diagram panel
    flowShown ? RE('div', { className: 'rot-panel' },
      RE('div', { className: 'rot-panel-head' },
        RE('span', { className: 'rot-panel-title' }, 'Money flow'),
        RE('span', { className: 'rot-panel-sub' }, flows.matched > 0.05 ? '~' + rotBn(sym, flows.matched) + ' rotating · net ' + rotBn(sym, flows.net, true) : 'One-sided · net ' + rotBn(sym, flows.net, true))),
      RE(RotationFlowDiagram, { classified, flows, sym, highlight, onHighlight: onHi })
    ) : (classified && !flowShown ? RE('div', { className: 'rot-panel rot-panel-flat' }, RE('span', { className: 'rot-flow-note' }, 'No meaningful sector flows this session.')) : null),
    // Intraday chart panel
    classified ? RE('div', { className: 'rot-panel' },
      RE('div', { className: 'rot-panel-head' },
        RE('span', { className: 'rot-panel-title' }, 'Through the day'),
        RE('span', { className: 'rot-panel-sub' }, 'Cumulative % vs prior close')),
      series ? RE(RotationIntradayChart, { built: series, colorMap, market: exchange.market, highlight, onHighlight: onHi })
        : RE('div', { className: 'rot-chart-missing' },
          RE('span', null, loading ? 'Loading intraday lines…' : 'Intraday lines unavailable.'),
          !loading ? RE('button', { className: 'btn btn-ghost btn-xs', onClick: () => load(true) }, 'Retry') : null)
    ) : null,
    // Sector list
    classified && snapshot ? RE('div', { className: 'rot-panel' },
      RE('div', { className: 'rot-panel-head' },
        RE('span', { className: 'rot-panel-title' }, 'By sector'),
        series && series.activity ? null : null),
      RE(RotationSectorList, { sectors: snapshot.sectors, marketPct, sym, market: exchange.market, colorMap, highlight, onHighlight: onHi, onOpenDetail })
    ) : null,
    // Footer: method note + updated + refresh
    classified ? RE('div', { className: 'rot-foot' },
      RE('span', { className: 'rot-foot-method' }, copy.method),
      RE('div', { className: 'rot-foot-right' },
        lastUpdate ? RE('span', { className: 'rot-updated' }, 'Updated ' + lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null,
        RE('button', { className: 'btn btn-ghost btn-xs ' + (loading ? 'spin' : ''), onClick: () => load(true), disabled: loading, 'aria-label': 'Refresh rotation' },
          RE(Icon, { name: 'refresh', size: 13 }), ' ', loading ? 'Loading' : 'Refresh'))) : null
  );
}

// ─── Heatmap (sector treemap) view + fullscreen chrome ──────
// Treemap layout math + HeatmapTreemap + ZoomPanHeatmap relocated here from app.js
// (Phase 4 inc 32). No root-App caller — consumed only by HeatmapView / HeatmapFullscreen
// below and by pb-modals SectorDetailModal (which reads ZoomPanHeatmap from
// window.PBViews at render time). Registered on window.PBViews.
function heatColor(pct, isLight) {
  if (pct == null || !isFinite(pct)) {
    return isLight ? { bg: 'rgb(228, 228, 231)', fg: '#52525b' } : { bg: 'rgb(60, 60, 66)', fg: '#a1a1aa' };
  }
  const clamped = Math.max(-3, Math.min(3, pct));
  const t = Math.abs(clamped) / 3;
  let lo, hi, fg;
  if (isLight) {
    // Light mode: pale tint near 0% → deep, saturated colour at the extremes.
    // Dark text on the pale tiles, white once the fill is strong enough.
    lo = clamped >= 0 ? [220, 252, 231] : [254, 226, 226];
    hi = clamped >= 0 ? [21, 128, 61] : [185, 28, 28];
    fg = t > 0.5 ? '#ffffff' : (clamped >= 0 ? '#14532d' : '#7f1d1d');
  } else {
    lo = clamped >= 0 ? [38, 73, 56] : [73, 38, 45];
    hi = clamped >= 0 ? [22, 163, 74] : [220, 38, 38];
    fg = '#ffffff';
  }
  const r = Math.round(lo[0] + (hi[0] - lo[0]) * t);
  const g = Math.round(lo[1] + (hi[1] - lo[1]) * t);
  const b = Math.round(lo[2] + (hi[2] - lo[2]) * t);
  return { bg: `rgb(${r}, ${g}, ${b})`, fg };
}
function squarify(items, rect) {
  if (!items || items.length === 0 || rect.w <= 0 || rect.h <= 0) return [];
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const result = [];
  layoutSquarify(sorted, { ...rect }, result);
  return result;
}
function layoutSquarify(items, rect, result) {
  if (items.length === 0 || rect.w <= 0 || rect.h <= 0) return;
  if (items.length === 1) {
    result.push({ ...items[0], x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    return;
  }
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total <= 0) return;
  const shortSide = Math.min(rect.w, rect.h);
  const area = rect.w * rect.h;
  let row = [items[0]];
  let i = 1;
  let bestWorst = computeWorst(row, shortSide, total, area);
  while (i < items.length) {
    const candidate = [...row, items[i]];
    const cw = computeWorst(candidate, shortSide, total, area);
    if (cw > bestWorst && row.length > 0) break;
    row = candidate;
    bestWorst = cw;
    i++;
  }
  const rowSum = row.reduce((s, it) => s + it.value, 0);
  const rowArea = (rowSum / total) * area;
  if (rect.w >= rect.h) {
    const colW = rowArea / rect.h;
    let yOff = 0;
    for (let k = 0; k < row.length; k++) {
      const item = row[k];
      const itemH = k === row.length - 1 ? (rect.h - yOff) : (item.value / rowSum) * rect.h;
      result.push({ ...item, x: rect.x, y: rect.y + yOff, w: colW, h: itemH });
      yOff += itemH;
    }
    layoutSquarify(items.slice(i), { x: rect.x + colW, y: rect.y, w: rect.w - colW, h: rect.h }, result);
  } else {
    const rowH = rowArea / rect.w;
    let xOff = 0;
    for (let k = 0; k < row.length; k++) {
      const item = row[k];
      const itemW = k === row.length - 1 ? (rect.w - xOff) : (item.value / rowSum) * rect.w;
      result.push({ ...item, x: rect.x + xOff, y: rect.y, w: itemW, h: rowH });
      xOff += itemW;
    }
    layoutSquarify(items.slice(i), { x: rect.x, y: rect.y + rowH, w: rect.w, h: rect.h - rowH }, result);
  }
}
function computeWorst(row, shortSide, totalValue, totalArea) {
  if (row.length === 0) return Infinity;
  const sum = row.reduce((s, i) => s + i.value, 0);
  if (sum <= 0) return Infinity;
  const rowArea = (sum / totalValue) * totalArea;
  const rowLength = rowArea / shortSide;
  if (rowLength <= 0) return Infinity;
  let maxRatio = 0;
  for (const item of row) {
    const itemArea = (item.value / totalValue) * totalArea;
    const itemBreadth = itemArea / rowLength;
    if (itemBreadth <= 0) return Infinity;
    const ratio = Math.max(rowLength / itemBreadth, itemBreadth / rowLength);
    if (ratio > maxRatio) maxRatio = ratio;
  }
  return maxRatio;
}
function buildSectorHierarchy(rows) {
  // rows: [{ticker, sector, industry, value, changePct, market}]
  const sectors = {};
  for (const r of rows) {
    const chg = (typeof r.changePct === 'number' && isFinite(r.changePct)) ? r.changePct : null;
    if (!sectors[r.sector]) sectors[r.sector] = { name: r.sector, value: 0, weightedChg: 0, chgValue: 0, industries: {} };
    if (!sectors[r.sector].industries[r.industry]) sectors[r.sector].industries[r.industry] = { name: r.industry, value: 0, weightedChg: 0, chgValue: 0, tickers: [] };
    sectors[r.sector].value += r.value;
    sectors[r.sector].industries[r.industry].value += r.value;
    if (chg != null) {
      // Only rows with a live quote contribute to the weighted average, so the
      // header figure stays accurate while a heatmap is still streaming in.
      sectors[r.sector].weightedChg += chg * r.value;
      sectors[r.sector].chgValue += r.value;
      sectors[r.sector].industries[r.industry].weightedChg += chg * r.value;
      sectors[r.sector].industries[r.industry].chgValue += r.value;
    }
    sectors[r.sector].industries[r.industry].tickers.push(r);
  }
  const sectorList = Object.values(sectors).map(s => {
    const industries = Object.values(s.industries).map(ind => ({
      name: ind.name, value: ind.value, tickers: ind.tickers,
      avgChange: ind.chgValue > 0 ? ind.weightedChg / ind.chgValue : 0
    }));
    return { name: s.name, value: s.value, industries, avgChange: s.chgValue > 0 ? s.weightedChg / s.chgValue : 0 };
  });
  return sectorList;
}
function layoutTreemap(sectors, w, h) {
  const SECTOR_HEADER = 22;
  const INDUSTRY_HEADER = 14;
  const cells = [];
  const sectorRects = squarify(sectors.map(s => ({ ref: s, value: s.value })), { x: 0, y: 0, w, h });
  for (const sr of sectorRects) {
    const sec = sr.ref;
    cells.push({ kind: 'sector', name: sec.name, avgChange: sec.avgChange, x: sr.x, y: sr.y, w: sr.w, h: sr.h });
    const innerY = sr.y + SECTOR_HEADER;
    const innerH = Math.max(0, sr.h - SECTOR_HEADER);
    if (innerH < 20 || sr.w < 26) continue;
    const industries = sec.industries;
    const useIndustries = industries.length > 1 && innerH >= 40;
    if (!useIndustries) {
      const allTickers = industries.flatMap(ind => ind.tickers);
      const trects = squarify(allTickers.map(t => ({ ref: t, value: t.value })), { x: sr.x, y: innerY, w: sr.w, h: innerH });
      for (const tr of trects) cells.push({ kind: 'ticker', ref: tr.ref, x: tr.x, y: tr.y, w: tr.w, h: tr.h });
      continue;
    }
    const indRects = squarify(industries.map(ind => ({ ref: ind, value: ind.value })), { x: sr.x, y: innerY, w: sr.w, h: innerH });
    for (const ir of indRects) {
      const ind = ir.ref;
      cells.push({ kind: 'industry', name: ind.name, avgChange: ind.avgChange, x: ir.x, y: ir.y, w: ir.w, h: ir.h });
      const tInnerY = ir.y + (ir.h >= 40 ? INDUSTRY_HEADER : 0);
      const tInnerH = Math.max(0, ir.h - (ir.h >= 40 ? INDUSTRY_HEADER : 0));
      if (tInnerH < 16 || ir.w < 22) continue;
      const trects = squarify(ind.tickers.map(t => ({ ref: t, value: t.value })), { x: ir.x, y: tInnerY, w: ir.w, h: tInnerH });
      for (const tr of trects) cells.push({ kind: 'ticker', ref: tr.ref, x: tr.x, y: tr.y, w: tr.w, h: tr.h });
    }
  }
  return cells;
}
function HeatmapTreemap(_ref8c) {
  let { rows, aspectRatio, minHeight, onOpenDetail, onOpenSector, loading, height: fixedHeight, width: fixedWidth } = _ref8c;
  const { Icon } = window.PBApp;
  const [containerRef, measuredWidth] = useContainerWidth();
  const width = fixedWidth || measuredWidth;
  const sectors = useMemo(() => buildSectorHierarchy(rows), [rows]);
  const height = fixedHeight || (width > 0 ? Math.max(minHeight || 360, width * (aspectRatio || 0.7)) : (minHeight || 360));
  // The in-page treemap has a 1px border (fullscreen/zoom set border:none), so its
  // content box is 2px shorter than the styled box-sizing:border-box height. Lay
  // out cells to the content box so the bottom row isn't clipped by the border.
  const BORDER = fixedWidth ? 0 : 2;
  const layoutH = Math.max(0, height - BORDER);
  const cells = useMemo(() => width > 0 ? layoutTreemap(sectors, width, layoutH) : [], [sectors, width, layoutH]);
  const isLight = typeof document !== 'undefined' && document.documentElement && document.documentElement.dataset.theme === 'light';
  return React.createElement("div", { ref: containerRef, className: "treemap", style: { height: height + 'px', width: fixedWidth ? fixedWidth + 'px' : undefined } },
    cells.map((cell, idx) => {
      if (cell.kind === 'sector' || cell.kind === 'industry') {
        const isSec = cell.kind === 'sector';
        // A framing box around the whole group makes it obvious which tiles
        // belong to which sector / industry, plus the label strip on top.
        return [
          React.createElement("div", {
            key: (isSec ? 'sbox:' : 'ibox:') + cell.name + ':' + idx,
            className: isSec ? 'tm-sector-box' : 'tm-industry-box',
            style: { left: cell.x + 'px', top: cell.y + 'px', width: cell.w + 'px', height: cell.h + 'px' }
          }),
          React.createElement("div", {
            key: cell.kind + ':' + cell.name + ':' + idx,
            className: (isSec ? 'tm-sector-label' : 'tm-industry-label') + (isSec && onOpenSector ? ' tm-sector-label-tap' : ''),
            style: { left: cell.x + 'px', top: cell.y + 'px', width: cell.w + 'px' },
            onClick: isSec && onOpenSector ? (e) => { e.stopPropagation(); onOpenSector(cell.name); } : undefined,
            role: isSec && onOpenSector ? 'button' : undefined,
            title: isSec && onOpenSector ? 'Open ' + cell.name + ' sector' : undefined
          },
            React.createElement("span", { className: "tm-label-name" }, cell.name),
            React.createElement("span", { className: `tm-label-chg ${cell.avgChange >= 0 ? 'up' : 'down'}` },
              ' ', (cell.avgChange >= 0 ? '+' : '') + cell.avgChange.toFixed(2) + '%'
            ),
            isSec && onOpenSector ? React.createElement("span", { className: "tm-sector-expand" },
              React.createElement(Icon, { name: "maximize", size: 10 })) : null
          )
        ];
      }
      const t = cell.ref;
      const hasData = t.changePct != null && isFinite(t.changePct);
      const c = heatColor(hasData ? t.changePct : null, isLight);
      // Inset each tile so neighbours are separated by a clean gutter (the dark
      // container shows through), giving the grid breathing room instead of the
      // cramped hairline-border look. Smaller gap on very small cells.
      const GAP = cell.w < 26 || cell.h < 20 ? 1.5 : 2.5;
      const iw = Math.max(0, cell.w - GAP * 2);
      const ih = Math.max(0, cell.h - GAP * 2);
      const showPct = hasData && iw >= 38 && ih >= 30;
      const showTkr = iw >= 20 && ih >= 15;
      const tkrSize = Math.max(9, Math.min(20, Math.sqrt(iw * ih) / 6));
      const pctSize = Math.max(8, tkrSize - 4);
      const radius = Math.min(6, iw / 4, ih / 4);
      return React.createElement("button", {
        key: 't:' + priceKey(t.market, t.ticker),
        className: 'tm-cell' + (hasData ? '' : (loading ? ' loading' : ' nodata')),
        style: {
          left: (cell.x + GAP) + 'px', top: (cell.y + GAP) + 'px',
          width: iw + 'px', height: ih + 'px',
          borderRadius: radius + 'px',
          background: c.bg, color: c.fg
        },
        onClick: () => onOpenDetail && onOpenDetail(t.ticker, t.market),
        title: hasData ? `${t.ticker} ${t.changePct >= 0 ? '+' : ''}${t.changePct.toFixed(2)}%` : t.ticker
      },
        showTkr ? React.createElement("span", { className: 'tm-cell-tkr', style: { fontSize: tkrSize + 'px' } }, t.ticker) : null,
        showPct ? React.createElement("span", { className: 'tm-cell-pct', style: { fontSize: pctSize + 'px' } },
          (t.changePct >= 0 ? '+' : '') + t.changePct.toFixed(2) + '%'
        ) : null
      );
    })
  );
}
// Reusable pinch / scroll / double-tap zoom + drag-pan treemap. Zoom is realised
// by RE-LAYING-OUT the treemap at a larger pixel size (not a CSS scale) so cells
// physically grow and their labels stay sharp. Used both by the fullscreen
// heatmap and the in-place sector popup, so the popup behaves exactly like the
// big heatmap without ever going fullscreen.
function ZoomPanHeatmap(_refZP) {
  let { rows, loading, onOpenDetail, onOpenSector, lockScroll, stageClass, contentClass, portraitStretch } = _refZP;
  const { useBodyScrollLock } = window.PBApp;
  useBodyScrollLock(!!lockScroll);
  const wrapRef = useRef(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  // Latest content geometry, mirrored into a ref so commit()'s pan clamp works
  // against the ACTUAL laid-out size (which can be taller than the stage when
  // portraitStretch is on) instead of assuming content = stage x zoom.
  const geomRef = useRef({ w: 0, h: 0, baseH: 0 });
  const [z, setZ] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const zRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const ptrs = useRef(new Map());
  const pinch = useRef(null);
  const drag = useRef(null);
  const movedRef = useRef(false);
  const rafRef = useRef(0);
  const nextRef = useRef({ z: 1, x: 0, y: 0 });
  const MIN = 1, MAX = 5;
  const commit = (nz, x, y) => {
    nz = Math.max(MIN, Math.min(MAX, nz));
    // Clamp the pan to the real content box. Content height is baseH*nz (baseH
    // may exceed the stage height under portraitStretch), so at zoom 1 there is
    // still vertical room to pan into — that's what lets you reach the bottom
    // sectors the fixed-height fullscreen used to clip.
    const g = geomRef.current;
    const w = g.w || (wrapRef.current ? wrapRef.current.clientWidth : 0);
    const h = g.h || (wrapRef.current ? wrapRef.current.clientHeight : 0);
    const cw = w * nz, ch = (g.baseH || h) * nz;
    x = Math.min(0, Math.max(w - cw, x));
    y = Math.min(0, Math.max(h - ch, y));
    nextRef.current = { z: nz, x, y };
    zRef.current = nz; panRef.current = { x, y };
    if (!rafRef.current) rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      setZ(nextRef.current.z); setPan({ x: nextRef.current.x, y: nextRef.current.y });
    });
  };
  const reset = () => { movedRef.current = false; commit(1, 0, 0); };
  useEffect(() => {
    const measure = () => { const el = wrapRef.current; if (el) setStage({ w: el.clientWidth, h: el.clientHeight }); };
    measure();
    // Re-measure on the next frame too — inside an animating popup the first
    // measurement can land mid-transition.
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    // visualViewport fires when the mobile browser's retractable toolbar shows/
    // hides — the fixed overlay's usable height changes then, so re-measure to
    // keep the treemap sized to what's actually on screen.
    const vv = window.visualViewport;
    if (vv) vv.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      if (vv) vv.removeEventListener('resize', measure);
    };
  }, []);
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const onDown = e => {
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
      ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.current.size === 2) {
        const [a, b] = [...ptrs.current.values()];
        pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), z: zRef.current, px: panRef.current.x, py: panRef.current.y, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, rect: el.getBoundingClientRect() };
        drag.current = null; movedRef.current = true;
      } else if (ptrs.current.size === 1) {
        drag.current = { x: e.clientX, y: e.clientY, px: panRef.current.x, py: panRef.current.y };
        movedRef.current = false;
      }
    };
    const onMove = e => {
      if (!ptrs.current.has(e.pointerId)) return;
      ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.current.size === 2 && pinch.current) {
        const [a, b] = [...ptrs.current.values()];
        const nd = Math.hypot(a.x - b.x, a.y - b.y);
        const g = pinch.current;
        const nz = Math.max(MIN, Math.min(MAX, g.z * (nd / g.d)));
        const k = nz / g.z;
        const fx = g.mx - g.rect.left, fy = g.my - g.rect.top;
        commit(nz, fx - (fx - g.px) * k, fy - (fy - g.py) * k);
        e.preventDefault();
      } else if (ptrs.current.size === 1 && drag.current && (zRef.current > 1.01 || geomRef.current.baseH * zRef.current > geomRef.current.h + 1)) {
        const g = drag.current;
        const dx = e.clientX - g.x, dy = e.clientY - g.y;
        // Until the finger clears the threshold, treat it as a tap, not a pan:
        // panning here calls preventDefault + re-pans mid-gesture, which swallows
        // the cell button's click when zoomed in. Only commit once it's a drag.
        if (!movedRef.current && Math.abs(dx) + Math.abs(dy) <= 5) return;
        movedRef.current = true;
        commit(zRef.current, g.px + dx, g.py + dy);
        e.preventDefault();
      }
    };
    const onUp = e => {
      ptrs.current.delete(e.pointerId);
      if (ptrs.current.size < 2) pinch.current = null;
      if (ptrs.current.size === 0) drag.current = null;
    };
    const onWheel = e => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const fx = e.clientX - rect.left, fy = e.clientY - rect.top;
      const cz = zRef.current;
      const nz = Math.max(MIN, Math.min(MAX, cz * (e.deltaY < 0 ? 1.18 : 0.85)));
      const k = nz / cz;
      commit(nz, fx - (fx - panRef.current.x) * k, fy - (fy - panRef.current.y) * k);
    };
    const onDbl = e => { e.preventDefault(); if (zRef.current > 1.01) commit(1, 0, 0); else { const rect = el.getBoundingClientRect(); const fx = e.clientX - rect.left, fy = e.clientY - rect.top; const nz = 2.5; commit(nz, fx - fx * nz, fy - fy * nz); } };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove, { passive: false });
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('dblclick', onDbl);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('dblclick', onDbl);
    };
  }, []);
  // Suppress tap-throughs that happened during a pan/pinch gesture.
  const handleOpen = (tk, mk) => { if (movedRef.current) return; onOpenDetail && onOpenDetail(tk, mk); };
  const handleSector = onOpenSector ? (name) => { if (movedRef.current) return; onOpenSector(name); } : undefined;
  // In portrait fullscreen, lay the map out TALLER than the stage so all the
  // sectors get legible tiles and the bottom rows stop being clipped to slivers;
  // the user pans/pinches to explore. Landscape/desktop (and the sector popup,
  // which passes no stretch) keep the fit-to-stage behaviour.
  const portrait = stage.w > 0 && stage.h > stage.w;
  const baseH = (portraitStretch && portraitStretch > 1 && portrait) ? Math.round(stage.h * portraitStretch) : stage.h;
  geomRef.current = { w: stage.w, h: stage.h, baseH };
  const cw = Math.round(stage.w * z), ch = Math.round(baseH * z);
  return React.createElement("div", { className: stageClass || "zoompan-stage", ref: wrapRef },
    React.createElement("div", {
      className: contentClass || "zoompan-content",
      style: { transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`, width: cw + 'px', height: ch + 'px' }
    },
      stage.w > 0 ? React.createElement(HeatmapTreemap, { rows: rows, width: cw, height: ch, onOpenDetail: handleOpen, onOpenSector: handleSector, loading: loading }) : null
    ),
    (z > 1.01 || pan.y < -1) ? React.createElement("div", { className: "zoompan-badge" },
      React.createElement("span", null, z > 1.01 ? z.toFixed(1) + '×' : 'Top'),
      React.createElement("button", { className: "zoompan-reset", onClick: reset }, "Reset")
    ) : null
  );
}
// Full-screen pinch-to-zoom & pan heatmap — thin chrome around ZoomPanHeatmap.
function HeatmapFullscreen(_refFS) {
  const { Icon } = window.PBApp;
  let { rows, title, loading, onOpenDetail, onOpenSector, onClose } = _refFS;
  return React.createElement("div", { className: "heatmap-fs" },
    React.createElement("div", { className: "heatmap-fs-bar" },
      React.createElement("div", { className: "heatmap-fs-title" }, title || 'Heatmap',
        React.createElement("span", { className: "heatmap-fs-hint" }, "Pinch, scroll or double-tap to zoom · drag to pan · tap a sector name to dive in")),
      React.createElement("div", { className: "heatmap-fs-actions" },
        React.createElement("button", { className: "btn btn-ghost btn-xs", onClick: onClose, "aria-label": "Close fullscreen" },
          React.createElement(Icon, { name: "x", size: 16 }))
      )
    ),
    React.createElement(ZoomPanHeatmap, {
      rows: rows, loading: loading, onOpenDetail: onOpenDetail, onOpenSector: onOpenSector,
      lockScroll: true, stageClass: "heatmap-fs-stage", contentClass: "heatmap-fs-content",
      portraitStretch: 1.5
    })
  );
}

function HeatmapView(_ref8b) {
  const { Icon, resolveTickerName, usePersistedState } = window.PBApp;
  const SectorDetailModal = PBModals.SectorDetailModal;
  const DATA = window.PB_DATA;
  let { positions, onOpenDetail, displayCurrency, fxRates } = _ref8b;
  const prices = PBStore.usePricesMap();
  const exchanges = DATA.HEATMAPS;
  const [mode, setMode] = usePersistedState('pb.heatmap.mode.v1', 'market');
  const [selectedId, setSelectedId] = usePersistedState('pb.heatmap.exchange.v1', exchanges[0].id);
  const [portfolioFilter, setPortfolioFilter] = usePersistedState('pb.heatmap.pf.v1', 'all');
  const exchange = exchanges.find(e => e.id === selectedId) || exchanges[0];
  // Last-good rows are persisted per exchange so reopening the tab paints the
  // previous heatmap instantly while a fresh fetch runs in the background.
  const [persisted, setPersisted] = usePersistedState('pb.heatmap.lastgood.v1', {});
  const [cache, setCache] = useState(() => ({ ...persisted }));
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [sectorDetail, setSectorDetail] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(() => persisted[exchanges[0].id]?.fetchedAt ? new Date(persisted[exchanges[0].id].fetchedAt) : null);
  const cacheKey = exchange.id;
  const cached = cache[cacheKey];
  const loadRef = useRef(false);
  const mkSkeleton = (c) => ({ ticker: c.t, market: exchange.market, sector: c.s, industry: c.i, value: c.m, price: null, changePct: null });
  const load = useCallback(async (force) => {
    if (loadRef.current) return;
    const existing = cache[cacheKey];
    if (!force && existing && existing.fetchedAt && Date.now() - existing.fetchedAt < 300_000) return;
    loadRef.current = true;
    setLoading(true);
    setError(null);
    const constituents = exchange.constituents;
    setProgress({ done: 0, total: constituents.length });
    // Paint the full grid immediately — its layout is driven by market cap
    // (known up-front), so structure is stable and only colour fills in as
    // quotes arrive. On a refresh we keep the previous (stale) colours visible
    // and overwrite them per batch, so cells never flash back to grey.
    const prevMap = {};
    if (existing && existing.rows) existing.rows.forEach(r => { if (r.changePct != null) prevMap[priceKey(r.market, r.ticker)] = r; });
    const buildRows = (quotes) => constituents.map(c => {
      const key = priceKey(exchange.market, c.t);
      const q = quotes[key];
      if (q) return { ticker: c.t, market: exchange.market, sector: c.s, industry: c.i, value: c.m, price: q.price, changePct: q.changePct };
      const prev = prevMap[key];
      return prev || mkSkeleton(c);
    });
    setCache(prev => ({ ...prev, [cacheKey]: { rows: buildRows({}), fetchedAt: 0 } }));
    try {
      const items = constituents.map(c => ({ ticker: c.t, market: exchange.market }));
      const quotes = await fetchQuoteBatchLight(items, (done, total, partial) => {
        setProgress({ done, total });
        if (partial) setCache(prev => ({ ...prev, [cacheKey]: { rows: buildRows(partial), fetchedAt: 0 } }));
      });
      const rows = buildRows(quotes);
      if (rows.filter(r => r.changePct != null).length === 0) {
        setError('No live data returned. Try again shortly.');
        setCache(prev => { const n = { ...prev }; delete n[cacheKey]; return n; });
      } else {
        const entry = { rows, fetchedAt: Date.now() };
        setCache(prev => ({ ...prev, [cacheKey]: entry }));
        setPersisted(prev => ({ ...prev, [cacheKey]: entry }));
        setLastUpdate(new Date());
      }
    } catch (e) {
      setError('Failed to load heatmap. Check your connection.');
    } finally {
      loadRef.current = false;
      setLoading(false);
      setProgress(null);
    }
  }, [cacheKey, exchange, cache, setPersisted]);
  useEffect(() => {
    if (mode === 'market') {
      const e = cache[cacheKey];
      if (e && e.fetchedAt) setLastUpdate(new Date(e.fetchedAt));
      load(false);
    }
  }, [cacheKey, mode]);
  const portfolioMarkets = useMemo(() => {
    const mkts = new Set();
    positions.forEach(p => mkts.add(p.market));
    return Array.from(mkts).sort();
  }, [positions]);
  const portfolioRows = useMemo(() => {
    if (mode !== 'portfolio') return [];
    const rates = fxRates?.rates || null;
    return positions.filter(p => portfolioFilter === 'all' || p.market === portfolioFilter).map(p => {
      const q = prices[priceKey(p.market, p.ticker)];
      // Size every holding by its market value in the display currency, so US,
      // JSE and TFSA positions are comparable in one treemap (the raw native
      // price would let a rand-quoted position dwarf a dollar one). Falls back
      // to cost basis when no live quote has arrived yet, so the holding still
      // appears — coloured grey, exactly like a market-heatmap constituent whose
      // quote is still streaming in — instead of vanishing from the grid.
      const native = marketCurrency(p.market);
      // Live value is in the market's native currency; the cost-basis fallback is
      // in the currency the holding was booked in (crypto-in-ZAR keeps its rand).
      const value = (q && q.price > 0)
        ? convertCcy(p.shares * q.price, native, displayCurrency, rates)
        : convertCcy(p.shares * p.costBasis, positionCostCcy(p), displayCurrency, rates);
      if (value == null || value <= 0) return null;
      const changePct = q && typeof q.changePct === 'number' && isFinite(q.changePct) ? q.changePct : null;
      let sec = DATA.findSector(p.ticker, p.market);
      if (sec.sector === 'Other') {
        const nm = p.name || resolveTickerName(p.ticker, p.market, q) || '';
        const byName = DATA.classifySectorByName(nm);
        if (byName !== 'Other') sec = { sector: byName, industry: byName };
      }
      return { ticker: p.ticker, market: p.market, sector: sec.sector, industry: sec.industry, value, price: q ? q.price : null, changePct };
    }).filter(Boolean);
  }, [mode, positions, prices, portfolioFilter, displayCurrency, fxRates]);
  const activeRows = mode === 'market' ? (cached ? cached.rows : []) : portfolioRows;
  const stats = useMemo(() => {
    if (!activeRows || activeRows.length === 0) return null;
    const dataRows = activeRows.filter(r => r.changePct != null && isFinite(r.changePct));
    if (dataRows.length === 0) return null;
    const up = dataRows.filter(r => r.changePct > 0).length;
    const down = dataRows.filter(r => r.changePct < 0).length;
    const flat = dataRows.length - up - down;
    const totalVal = dataRows.reduce((s, r) => s + r.value, 0);
    const wAvg = totalVal > 0 ? dataRows.reduce((s, r) => s + r.changePct * r.value, 0) / totalVal : 0;
    return { up, down, flat, avg: wAvg, total: dataRows.length };
  }, [activeRows]);
  const aspectRatio = mode === 'market' ? 0.62 : 0.82;
  // Market mode is an at-a-glance overview, so the grid is sized to the space
  // left in the viewport (under the toggles/stats, above the bottom safe-area)
  // rather than a fixed canvas that ran off the bottom of the screen. We measure
  // the grid's own top offset so it adapts to whatever chrome sits above it, then
  // reserve room below for the "tap a sector" hint, page padding and safe-area.
  const treemapWrapRef = useRef(null);
  const [marketFitH, setMarketFitH] = useState(500);
  useLayoutEffect(() => {
    if (mode !== 'market') return;
    const measure = () => {
      const el = treemapWrapRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      // On phones the chrome above (mode + exchange toggles + meta) is taller and
      // the viewport shorter, so the old fixed 400px floor pushed the grid's bottom
      // rows (and the "tap a sector" hint) below the fold. Size the grid to the
      // space actually left under the toggles and above the bottom hint / safe-area,
      // with a much lower floor on narrow screens so the whole map fits the screen
      // instead of overflowing — the desktop look, scaled down for mobile.
      const isNarrow = window.innerWidth <= 680;
      const BOTTOM_RESERVE = isNarrow ? 100 : 110; // sector hint + page padding + safe-area
      const avail = Math.round(window.innerHeight - top - BOTTOM_RESERVE);
      // Clamp keeps tiles a sensible size on very short / very tall screens; the
      // upper bound stops the grid getting "too long" on big displays.
      const floor = isNarrow ? 240 : 400;
      const ceil = isNarrow ? 600 : 580;
      const clamped = Math.max(floor, Math.min(ceil, avail));
      setMarketFitH(prev => Math.abs(prev - clamped) > 2 ? clamped : prev);
    };
    measure();
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, [mode, selectedId, portfolioFilter, loading, !!error, !!progress, activeRows.length, portfolioMarkets.length]);
  // Portfolio: scale the canvas with holding count so sectors (and the bottom
  // rows) always have room to render their tiles instead of being clipped to a
  // header strip.
  const minHeight = mode === 'market'
    ? marketFitH
    : Math.max(480, Math.min(1200, (activeRows.length || 0) * 40 + 140));
  const progressPct = progress ? Math.round(progress.done / progress.total * 100) : 0;
  return React.createElement("div", null,
    React.createElement("div", { className: "heatmap-mode-toggle" },
      React.createElement("button", {
        className: `heatmap-mode-btn ${mode === 'portfolio' ? 'active' : ''}`,
        onClick: () => setMode('portfolio')
      }, "Portfolio"),
      React.createElement("button", {
        className: `heatmap-mode-btn ${mode === 'market' ? 'active' : ''}`,
        onClick: () => setMode('market')
      }, "Market")
    ),
    mode === 'market' ? React.createElement("div", { className: "heatmap-toggle" },
      exchanges.map(ex => React.createElement("button", {
        key: ex.id,
        className: `heatmap-toggle-btn ${ex.id === selectedId ? 'active' : ''}`,
        onClick: () => setSelectedId(ex.id)
      }, ex.label))
    ) : null,
    mode === 'portfolio' && portfolioMarkets.length > 1 ? React.createElement("div", { className: "heatmap-toggle" },
      React.createElement("button", {
        className: `heatmap-toggle-btn ${portfolioFilter === 'all' ? 'active' : ''}`,
        onClick: () => setPortfolioFilter('all')
      }, "All"),
      portfolioMarkets.map(m => React.createElement("button", {
        key: m,
        className: `heatmap-toggle-btn ${portfolioFilter === m ? 'active' : ''}`,
        onClick: () => setPortfolioFilter(m)
      }, m))
    ) : null,
    React.createElement("div", { className: "heatmap-meta" },
      React.createElement("div", { className: "heatmap-meta-left" },
        stats ? React.createElement(React.Fragment, null,
          React.createElement("span", { className: "stat-up" }, "▲ ", stats.up),
          React.createElement("span", { className: "stat-down" }, "▼ ", stats.down),
          stats.flat > 0 ? React.createElement("span", { className: "stat-flat" }, "● ", stats.flat) : null,
          React.createElement("span", { className: `stat-avg ${stats.avg >= 0 ? 'up' : 'down'}` },
            "weighted ", stats.avg >= 0 ? '+' : '', stats.avg.toFixed(2), '%'
          )
        ) : React.createElement("span", { className: "text-dim text-sm" }, loading ? "Fetching live quotes…" : (mode === 'portfolio' && positions.length === 0 ? "Add positions to see your portfolio heatmap." : ""))
      ),
      React.createElement("div", { className: "heatmap-meta-right" },
        mode === 'market' && lastUpdate ? React.createElement("span", { className: "text-dim text-sm" },
          "Updated ", lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        ) : null,
        activeRows.length > 0 ? React.createElement("button", {
          className: "btn btn-ghost btn-xs",
          onClick: () => setFullscreen(true),
          "aria-label": "Open heatmap fullscreen"
        }, React.createElement(Icon, { name: "maximize", size: 13 }), " Expand") : null,
        mode === 'market' ? React.createElement("button", {
          className: `btn btn-ghost btn-xs ${loading ? 'spin' : ''}`,
          onClick: () => load(true),
          disabled: loading,
          "aria-label": "Refresh heatmap"
        }, React.createElement(Icon, { name: "refresh", size: 13 }), " ", loading ? "Loading" : "Refresh") : null
      )
    ),
    error && mode === 'market' ? React.createElement("div", { className: "verify-error" }, error) : null,
    mode === 'market' && loading ? React.createElement("div", { className: "heatmap-progress" },
      React.createElement("div", { className: "heatmap-progress-bar" },
        React.createElement("div", { className: "heatmap-progress-fill", style: { width: progressPct + '%' } })),
      React.createElement("span", { className: "heatmap-progress-text" },
        progress ? progress.done + " / " + progress.total + " quotes" : "Loading " + exchange.label + "…")
    ) : null,
    activeRows.length > 0 ? React.createElement("div", { ref: treemapWrapRef }, React.createElement(HeatmapTreemap, {
      rows: activeRows,
      height: mode === 'market' ? marketFitH : undefined,
      aspectRatio: aspectRatio,
      minHeight: minHeight,
      onOpenDetail: onOpenDetail,
      onOpenSector: (name) => setSectorDetail(name),
      loading: loading
    })) : (mode === 'portfolio' && !loading ? React.createElement("div", { className: "heatmap-loading" }, positions.length === 0 ? "You don't have any positions yet." : (portfolioRows.length === 0 && portfolioFilter !== 'all' ? "No " + portfolioFilter + " positions with live data." : "Waiting for live quotes…")) : null),
    activeRows.length > 0 ? React.createElement("div", { className: "heatmap-sector-hint" },
      React.createElement(Icon, { name: "maximize", size: 11 }), " Tap a sector name to zoom in") : null,
    fullscreen ? React.createElement(HeatmapFullscreen, {
      rows: activeRows,
      loading: loading,
      title: mode === 'market' ? exchange.label : 'Your portfolio',
      onOpenDetail: (tk, mk) => { setFullscreen(false); onOpenDetail && onOpenDetail(tk, mk); },
      onOpenSector: (name) => setSectorDetail(name),
      onClose: () => setFullscreen(false)
    }) : null,
    sectorDetail ? React.createElement(SectorDetailModal, {
      sectorName: sectorDetail,
      rows: activeRows,
      exchangeLabel: mode === 'market' ? exchange.label : 'Your portfolio',
      onOpenDetail: onOpenDetail,
      onClose: () => setSectorDetail(null)
    }) : null
  );
}

// ─── Dashboard: portfolio growth chart + overview view ──────
// Moved verbatim from app.js (Phase 4 inc 24). The chart cluster (CHART_MONTHS/chartDayLabel/
// buildTimeAxisTicks/PortfolioLineChart) is bucket-private; fmtNum stays in app.js; PortfolioPieChart now lives in this bucket (inc 30)
// (bridged); the two contribution modals are read from PBModals at render time.
// SVG-based line chart for portfolio growth over time
const CHART_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2 Apr" (optionally "2 Apr ’25") — how a person reads a date, vs raw MM-DD.
function chartDayLabel(dateStr, withYear) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.getDate() + ' ' + CHART_MONTHS[d.getMonth()] + (withYear ? ' ’' + String(d.getFullYear()).slice(2) : '');
}
// Time ticks for the growth chart's x axis: calendar-aligned boundaries (weeks →
// month starts → year starts, scaled to the visible span) labelled "7 Apr",
// "1 May", "Jun", "2026". Returns point indices because the x scale is
// index-based (one slot per sampled day), not time-based; a tick is dropped when
// the nearest point drifts too far from the boundary (sparse fallback data), and
// if none survive the endpoints are labelled instead so the axis never goes mute.
function buildTimeAxisTicks(points) {
  if (points.length < 2) return [];
  const parse = s => new Date(s + 'T00:00:00');
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const first = parse(points[0].date), last = parse(points[points.length - 1].date);
  const spanDays = Math.max(1, (last - first) / 864e5);
  const maxDrift = Math.max(3, spanDays / 8);
  const ticks = [];
  const push = (dateStr, label) => {
    const i = points.findIndex(p => p.date >= dateStr);
    if (i < 0) return;
    if ((parse(points[i].date) - parse(dateStr)) / 864e5 > maxDrift) return;
    if (ticks.length && ticks[ticks.length - 1].idx === i) return;
    ticks.push({ idx: i, label });
  };
  if (spanDays <= 70) {
    // Weekly, anchored to Mondays: "7 Apr"
    const d = new Date(first);
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7));
    const stepDays = spanDays <= 35 ? 7 : 14;
    while (d <= last) {
      push(iso(d), d.getDate() + ' ' + CHART_MONTHS[d.getMonth()]);
      d.setDate(d.getDate() + stepDays);
    }
  } else if (spanDays <= 140) {
    // Semi-monthly: "1 May" / "15 May" — walk to the first 1st-or-15th after
    // the window opens, then alternate boundaries.
    const d = new Date(first);
    do { d.setDate(d.getDate() + 1); } while (d.getDate() !== 1 && d.getDate() !== 15);
    while (d <= last) {
      push(iso(d), d.getDate() + ' ' + CHART_MONTHS[d.getMonth()]);
      if (d.getDate() === 1) d.setDate(15); else { d.setDate(1); d.setMonth(d.getMonth() + 1); }
    }
  } else if (spanDays <= 430) {
    // Month starts, stepped to ≤6 labels: "1 Apr" when every month shows,
    // otherwise "Apr" with January carrying the year ("Jan ’26").
    const monthStarts = [];
    const d = new Date(first.getFullYear(), first.getMonth() + 1, 1);
    while (d <= last) { monthStarts.push(new Date(d)); d.setMonth(d.getMonth() + 1); }
    const stepM = Math.max(1, Math.ceil(monthStarts.length / 6));
    monthStarts.forEach((m, i) => {
      if (i % stepM !== 0) return;
      const label = stepM === 1 ? '1 ' + CHART_MONTHS[m.getMonth()]
        : m.getMonth() === 0 ? 'Jan ’' + String(m.getFullYear()).slice(2)
        : CHART_MONTHS[m.getMonth()];
      push(iso(m), label);
    });
  } else {
    // Year starts: "2025"
    const years = [];
    for (let yy = first.getFullYear() + 1; yy <= last.getFullYear(); yy++) years.push(yy);
    const stepY = Math.max(1, Math.ceil(years.length / 6));
    years.forEach((yy, i) => { if (i % stepY === 0) push(yy + '-01-01', String(yy)); });
  }
  if (ticks.length === 0) {
    const withYear = points[0].date.slice(0, 4) !== points[points.length - 1].date.slice(0, 4);
    ticks.push({ idx: 0, label: chartDayLabel(points[0].date, withYear) });
    ticks.push({ idx: points.length - 1, label: chartDayLabel(points[points.length - 1].date, withYear) });
  }
  return ticks;
}
function PortfolioLineChart({ positions, contributions, displayCurrency, fxRates }) {
  const prices = PBStore.usePricesMap();
  const valueHidden = PBStore.useSetting('valueHidden');
  const [range, setRange] = useState('1y');
  const [historyCache, setHistoryCache] = useState({});
  const [loading, setLoading] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(null);
  const svgRef = useRef(null);
  const ranges = [
    { key: '1mo', label: '1M' }, { key: '3mo', label: '3M' }, { key: '6mo', label: '6M' },
    { key: '1y', label: '1Y' }, { key: '2y', label: '2Y' }, { key: '5y', label: '5Y' }, { key: 'all', label: 'All' }
  ];
  const rates = fxRates?.rates || null;
  const today = new Date().toISOString().slice(0, 10);

  const positionKeys = positions.map(p => priceKey(p.market, p.ticker)).sort().join(',');
  useEffect(() => {
    if (positions.length === 0) return;
    let cancelled = false;
    setLoading(true);
    const fetchAll = async () => {
      const needed = positions.filter(p => !historyCache[priceKey(p.market, p.ticker)]);
      if (needed.length === 0) { setLoading(false); return; }
      // Fetch in small batches instead of one big Promise.all: firing 20+ history
      // requests at once swamps the shared CORS proxies and most come back empty,
      // which left the chart blank for larger portfolios. Batching + a retry pass
      // mirrors the quote fetcher and lets the line paint in as data lands.
      const BATCH = 5;
      const fetchInto = async (list, store) => {
        for (let i = 0; i < list.length; i += BATCH) {
          if (cancelled) return;
          const slice = list.slice(i, i + BATCH);
          await Promise.all(slice.map(async p => {
            const key = priceKey(p.market, p.ticker);
            const data = await fetchHistory(p.ticker, p.market, 'max').catch(() => null);
            if (data && data.points.length > 0) store[key] = data.points;
          }));
          if (!cancelled && Object.keys(store).length) setHistoryCache(prev => ({ ...prev, ...store }));
        }
      };
      const results = {};
      await fetchInto(needed, results);
      const missing = needed.filter(p => !results[priceKey(p.market, p.ticker)]);
      if (missing.length) await fetchInto(missing, results);
      if (cancelled) return;
      setLoading(false);
    };
    fetchAll();
    return () => { cancelled = true; };
  }, [positionKeys]);

  const cutoff = useMemo(() => {
    const d = new Date();
    if (range === '1mo') d.setMonth(d.getMonth() - 1);
    else if (range === '3mo') d.setMonth(d.getMonth() - 3);
    else if (range === '6mo') d.setMonth(d.getMonth() - 6);
    else if (range === '1y') d.setFullYear(d.getFullYear() - 1);
    else if (range === '2y') d.setFullYear(d.getFullYear() - 2);
    else if (range === '5y') d.setFullYear(d.getFullYear() - 5);
    else return null;
    return d.toISOString().slice(0, 10);
  }, [range]);

  const points = useMemo(() => {
    if (positions.length === 0) return [];
    const dateMap = {};
    const contribSorted = contributions.slice().sort((a, b) => a.date.localeCompare(b.date));

    // Per-position value series → one forward-filled portfolio series
    // (PBCore.forwardFillPortfolio): on dates where an exchange was shut, the
    // position's last known value carries instead of dropping out of the sum —
    // mixed-calendar portfolios used to spike down on every foreign holiday.
    const positionSeries = [];
    positions.forEach(p => {
      const key = priceKey(p.market, p.ticker);
      const hist = historyCache[key];
      if (!hist || hist.length === 0) return;
      const native = marketCurrency(p.market);
      const entryDate = p.purchaseDate || p.addedAt?.slice(0, 10) || today;
      const points = [];
      hist.forEach(pt => {
        const d = new Date(pt.t).toISOString().slice(0, 10);
        const val = convertCcy(p.shares * pt.p, native, displayCurrency, rates);
        if (val != null) points.push({ d, v: val });
      });
      positionSeries.push({ entryDate, points });
    });
    PBCore.forwardFillPortfolio(positionSeries).forEach(r => {
      dateMap[r.date] = { date: r.date, value: r.value, contributed: 0 };
    });

    positions.forEach(p => {
      const key = priceKey(p.market, p.ticker);
      const hist = historyCache[key];
      if (hist && hist.length > 0) return;
      const q = prices[key];
      if (!q) return;
      const native = marketCurrency(p.market);
      const entryDate = p.purchaseDate || p.addedAt?.slice(0, 10) || today;
      const costVal = convertCcy(p.shares * p.costBasis, positionCostCcy(p), displayCurrency, rates) || 0;
      const curVal = convertCcy(p.shares * q.price, native, displayCurrency, rates) || 0;
      if (!dateMap[entryDate]) dateMap[entryDate] = { date: entryDate, value: 0, contributed: 0 };
      if (!dateMap[today]) dateMap[today] = { date: today, value: 0, contributed: 0 };
      Object.keys(dateMap).forEach(d => {
        if (d < entryDate) return;
        dateMap[d].value += d >= today ? curVal : costVal;
      });
    });

    let cumContrib = 0;
    contribSorted.forEach(c => {
      cumContrib += contribInDisplay(c, displayCurrency, rates);
    });
    const totalContrib = cumContrib;

    let runningContrib = 0;
    let contribIdx = 0;
    const sortedDates = Object.keys(dateMap).sort();
    sortedDates.forEach(d => {
      while (contribIdx < contribSorted.length && contribSorted[contribIdx].date <= d) {
        const conv = convertCcy(contribSorted[contribIdx].amount, contribSorted[contribIdx].currency, displayCurrency, rates);
        if (conv != null) runningContrib += conv;
        contribIdx++;
      }
      dateMap[d].contributed = runningContrib;
    });
    while (contribIdx < contribSorted.length) {
      const conv = convertCcy(contribSorted[contribIdx].amount, contribSorted[contribIdx].currency, displayCurrency, rates);
      if (conv != null) runningContrib += conv;
      contribIdx++;
    }
    if (sortedDates.length > 0) {
      const lastDate = sortedDates[sortedDates.length - 1];
      dateMap[lastDate].contributed = runningContrib;
    }

    if (dateMap[today]) {
      let liveValue = 0;
      positions.forEach(p => {
        const q = prices[priceKey(p.market, p.ticker)];
        if (!q) return;
        const native = marketCurrency(p.market);
        const val = convertCcy(p.shares * q.price, native, displayCurrency, rates);
        if (val != null) liveValue += val;
      });
      dateMap[today].value = liveValue;
      dateMap[today].contributed = totalContrib;
    }

    let all = Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
    if (cutoff) {
      const before = all.filter(p => p.date < cutoff);
      let within = all.filter(p => p.date >= cutoff);
      // Don't let the range filter strip the series down to a single point (which
      // renders as an empty chart): if there was data before the cutoff, anchor
      // the window at the cutoff by carrying the last-known value forward. This is
      // what makes short ranges — and the cost-basis fallback before history loads
      // — still draw a line instead of collapsing.
      if (before.length && (within.length === 0 || within[0].date > cutoff)) {
        const carry = before[before.length - 1];
        within = [{ date: cutoff, value: carry.value, contributed: carry.contributed }, ...within];
      }
      all = within;
    }
    if (all.length > 300) {
      const step = Math.ceil(all.length / 300);
      const sampled = [all[0]];
      for (let i = step; i < all.length - 1; i += step) sampled.push(all[i]);
      sampled.push(all[all.length - 1]);
      return sampled;
    }
    return all;
  }, [positions, historyCache, contributions, displayCurrency, rates, cutoff, prices, today]);

  const W = 560, H = 220, PAD_L = 54, PAD_R = 16, PAD_T = 28, PAD_B = 32;
  const chartW = W - PAD_L - PAD_R, chartH = H - PAD_T - PAD_B;

  const getIdxFromEvent = useCallback((e) => {
    const svg = svgRef.current;
    if (!svg || points.length < 2) return null;
    const rect = svg.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const pxRatio = rect.width / W;
    const svgX = (clientX - rect.left) / pxRatio;
    const idx = Math.round(((svgX - PAD_L) / chartW) * (points.length - 1));
    return Math.max(0, Math.min(points.length - 1, idx));
  }, [points.length]);

  const emptyMsg = loading ? 'Loading historical prices…' : 'Add positions and log deposits to see portfolio growth.';
  if (points.length < 2) {
    return React.createElement("div", { className: "chart-line-wrap" },
      React.createElement("div", { className: "chart-ranges" },
        ranges.map(r => React.createElement("button", {
          key: r.key, className: `chart-range-btn ${range === r.key ? 'active' : ''}`,
          onClick: () => setRange(r.key) }, r.label))),
      React.createElement("div", { className: "chart-empty" },
        React.createElement("div", { className: "text-dim text-sm" }, emptyMsg)));
  }
  const allVals = points.flatMap(p => [p.value, p.contributed].filter(v => v != null && isFinite(v)));
  // Nice-number Y axis: snap the scale to a round step (1 / 2 / 2.5 / 5 × 10ⁿ)
  // so gridlines land on amounts like R250k · R300k, not raw data-min/max splits.
  const rawMinV = Math.min(...allVals), rawMaxV = Math.max(...allVals);
  const roughStep = ((rawMaxV - rawMinV) || Math.max(Math.abs(rawMaxV), 1)) / 4;
  const stepMag = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const stepNorm = roughStep / stepMag;
  const yStep = (stepNorm <= 1 ? 1 : stepNorm <= 2 ? 2 : stepNorm <= 2.5 ? 2.5 : stepNorm <= 5 ? 5 : 10) * stepMag;
  let minV = Math.floor(rawMinV / yStep) * yStep;
  if (minV < 0 && rawMinV >= 0) minV = 0;
  let maxV = Math.ceil(rawMaxV / yStep) * yStep;
  if (maxV === minV) maxV += yStep;
  const rangeV = maxV - minV;
  const x = i => PAD_L + (i / (points.length - 1)) * chartW;
  const y = v => PAD_T + chartH - ((v - minV) / rangeV) * chartH;
  const valuePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const contribPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.contributed).toFixed(1)}`).join('');
  const areaPath = valuePath + `L${x(points.length - 1).toFixed(1)},${(PAD_T + chartH).toFixed(1)}L${PAD_L},${(PAD_T + chartH).toFixed(1)}Z`;
  const yLabels = [];
  for (let i = 0, n = Math.round(rangeV / yStep); i <= n; i++) {
    const val = minV + yStep * i;
    yLabels.push({ val, y: y(val) });
  }
  const xTicks = buildTimeAxisTicks(points);
  const crossesYears = points[0].date.slice(0, 4) !== points[points.length - 1].date.slice(0, 4);
  const sym = CURRENCY_SYMBOLS[displayCurrency] || '$';
  // Ticks land on round steps; the unary + trims trailing zeros so labels stay
  // compact (R250k, R2.5M, R487.5k).
  const fmtShortRaw = v => {
    if (Math.abs(v) >= 1e6) return sym + (+(v / 1e6).toFixed(2)) + 'M';
    if (Math.abs(v) >= 1e3) return sym + (+(v / 1e3).toFixed(2)) + 'k';
    return sym + Math.round(v).toLocaleString('en-US');
  };
  const fmtFullRaw = v => sym + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Hide-value: the growth chart plots the portfolio total, so its money labels
  // mask to dots while hidden (the line's shape stays visible).
  const fmtShort = valueHidden ? (() => '••••') : fmtShortRaw;
  const fmtFull = valueHidden ? (() => '••••••') : fmtFullRaw;

  const hoverPoint = hoverIdx != null ? points[hoverIdx] : null;
  const hoverElements = [];
  if (hoverPoint != null && hoverIdx != null) {
    const hx = x(hoverIdx), hy = y(hoverPoint.value);
    hoverElements.push(
      React.createElement("line", { key: "hl", x1: hx, x2: hx, y1: PAD_T, y2: PAD_T + chartH,
        stroke: "var(--text-dim)", strokeWidth: "0.8", strokeDasharray: "3,2", opacity: "0.5" }),
      React.createElement("circle", { key: "hc", cx: hx, cy: hy, r: "5",
        fill: "var(--brand)", stroke: "var(--bg)", strokeWidth: "2.5" })
    );
    const label = fmtFull(hoverPoint.value);
    const estW = label.length * 7.5 + 16;
    const estH = 22;
    let lx = hx - estW / 2;
    if (lx < PAD_L) lx = PAD_L;
    if (lx + estW > W - PAD_R) lx = W - PAD_R - estW;
    let ly = hy - estH - 10;
    if (ly < 2) ly = hy + 12;
    hoverElements.push(
      React.createElement("rect", { key: "hr", x: lx, y: ly, width: estW, height: estH,
        rx: "6", fill: "var(--bg-raised)", stroke: "var(--border)", strokeWidth: "1" }),
      React.createElement("text", { key: "ht", x: lx + estW / 2, y: ly + estH / 2 + 4,
        textAnchor: "middle", fill: "var(--text)", fontSize: "11", fontFamily: "var(--mono)", fontWeight: "600" },
        label)
    );
    const dateLabel = chartDayLabel(hoverPoint.date, crossesYears);
    hoverElements.push(
      React.createElement("text", { key: "hd", x: hx, y: H - 7,
        textAnchor: "middle", fill: "var(--text)", fontSize: "10", fontFamily: "var(--mono)", fontWeight: "600" },
        dateLabel)
    );
  }

  const onInteract = (e) => {
    const idx = getIdxFromEvent(e);
    if (idx != null) setHoverIdx(idx);
  };

  return React.createElement("div", { className: "chart-line-wrap" },
    React.createElement("div", { className: "chart-line-header" },
      React.createElement("div", { className: "chart-ranges" },
        ranges.map(r => React.createElement("button", {
          key: r.key, className: `chart-range-btn ${range === r.key ? 'active' : ''}`,
          onClick: () => setRange(r.key) }, r.label))),
      React.createElement("div", { className: "chart-line-meta" },
        React.createElement("span", { className: "chart-legend-item" },
          React.createElement("span", { className: "chart-legend-dot", style: { background: 'var(--brand)' } }), "Value"),
        React.createElement("span", { className: "chart-legend-item" },
          React.createElement("span", { className: "chart-legend-dot chart-legend-dot--dashed" }), "Cost"),
        loading ? React.createElement("span", { className: "text-dim text-xs" }, "Loading…") : null)
    ),
    React.createElement("svg", {
      ref: svgRef,
      viewBox: `0 0 ${W} ${H}`, className: "chart-line-svg", preserveAspectRatio: "xMidYMid meet",
      style: { touchAction: 'none' },
      onMouseMove: onInteract,
      onMouseLeave: () => setHoverIdx(null),
      onTouchStart: onInteract,
      onTouchMove: onInteract,
      onTouchEnd: () => setHoverIdx(null)
    },
      React.createElement("defs", null,
        React.createElement("linearGradient", { id: "areaGrad", x1: "0", y1: "0", x2: "0", y2: "1" },
          React.createElement("stop", { offset: "0%", stopColor: "var(--brand)", stopOpacity: "0.25" }),
          React.createElement("stop", { offset: "100%", stopColor: "var(--brand)", stopOpacity: "0.02" })),
        // Left-to-right indigo → periwinkle, echoing the logo's ascending bars.
        React.createElement("linearGradient", { id: "lineGrad", x1: "0", y1: "0", x2: "1", y2: "0" },
          React.createElement("stop", { offset: "0%", stopColor: "var(--brand-dim)" }),
          React.createElement("stop", { offset: "100%", stopColor: "var(--brand)" }))),
      yLabels.map((l, i) => React.createElement("line", {
        key: i, x1: PAD_L, x2: W - PAD_R, y1: l.y, y2: l.y,
        stroke: "var(--border)", strokeWidth: "0.5", strokeDasharray: "3,3" })),
      yLabels.map((l, i) => React.createElement("text", {
        key: 'yl' + i, x: PAD_L - 6, y: l.y + 3.5,
        textAnchor: "end", fill: "var(--text-dim)", fontSize: "10", fontFamily: "var(--mono)" },
        fmtShort(l.val))),
      // Time axis: calendar-aligned tick marks stay put; their labels step aside
      // while scrubbing so the hover date reads cleanly.
      ...xTicks.filter(t => { const tx = x(t.idx); return tx >= PAD_L + 6 && tx <= W - PAD_R - 6; }).map((t, i) =>
        React.createElement("g", { key: 'xt' + i },
          React.createElement("line", { x1: x(t.idx), x2: x(t.idx), y1: PAD_T + chartH, y2: PAD_T + chartH + 4,
            stroke: "var(--border)", strokeWidth: "1" }),
          hoverIdx == null && React.createElement("text", { x: x(t.idx), y: H - 7, textAnchor: "middle",
            fill: "var(--text-dim)", fontSize: "9.5", fontFamily: "var(--mono)", letterSpacing: "0.03em" },
            t.label))),
      React.createElement("path", { d: areaPath, fill: "url(#areaGrad)" }),
      React.createElement("path", { d: contribPath, fill: "none", stroke: "var(--text-dim)", strokeWidth: "1.5", strokeDasharray: "4,3", opacity: "0.4" }),
      React.createElement("path", { d: valuePath, fill: "none", stroke: "url(#lineGrad)", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round" }),
      hoverIdx == null && React.createElement("circle", { cx: x(points.length - 1), cy: y(points[points.length - 1].value), r: "4", fill: "var(--brand)", stroke: "var(--bg-raised)", strokeWidth: "2" }),
      ...hoverElements,
      React.createElement("rect", { x: PAD_L, y: PAD_T, width: chartW, height: chartH,
        fill: "transparent", style: { cursor: 'crosshair' } })
    )
  );
}

function DashboardView(_ref6) {
  const { Icon, fmt, fmtCcy, fmtCcySigned, computeFxSnapshot, fmtNum } = window.PBApp;
  const ContributionModal = PBModals.ContributionModal;
  const ContributionImportModal = PBModals.ContributionImportModal;
  let {
    positions,
    onOpenDetail,
    contributions,
    onAddContribution,
    onRemoveContribution,
    onImportContributions,
    transactions,
    displayCurrency,
    onSetDisplayCurrency,
    fxRates,
    sectorCache,
    fundamentals,
    sectorWeights,
    onSetSectorWeights
  } = _ref6;
  const prices = PBStore.usePricesMap();
  const computeStats = list => {
    let cost = 0, value = 0, hasAllPrices = true;
    list.forEach(p => {
      const q = prices[priceKey(p.market, p.ticker)];
      const native = marketCurrency(p.market);
      const qCcy = q?.currency?.toUpperCase();
      const nativeUpper = native.toUpperCase();
      const sameCcy = !qCcy || qCcy === nativeUpper || qCcy === 'ZAC' && nativeUpper === 'ZAR' || qCcy === 'GBX' && nativeUpper === 'GBP';
      // This view groups by trading currency and sums in that currency. When a
      // holding's cost is booked in a different currency (crypto bought in ZAR),
      // convert it into the group's currency so cost and value stay comparable.
      const costCcy = positionCostCcy(p);
      const rawCost = p.shares * p.costBasis;
      cost += costCcy === native ? rawCost : (convertCcy(rawCost, costCcy, native, fxRates?.rates || null) ?? rawCost);
      if (q && sameCcy) value += p.shares * q.price; else hasAllPrices = false;
    });
    return { cost, value, pnl: value - cost, pnlPct: cost > 0 ? (value - cost) / cost * 100 : 0, hasAllPrices };
  };
  const currencyGroups = Object.values(
    positions.reduce((map, p) => {
      const mc = MARKET_CURRENCY[p.market];
      if (!mc) return map;
      if (!map[mc.code]) map[mc.code] = { ...mc, posns: [], fmtMarket: p.market };
      map[mc.code].posns.push(p);
      return map;
    }, {})
  ).map(g => ({ ...g, ...computeStats(g.posns) }));
  const rates = fxRates?.rates || null;
  const marketGroups = Object.values(
    positions.reduce((map, p) => {
      if (!map[p.market]) map[p.market] = { market: p.market, posns: [] };
      map[p.market].posns.push(p);
      return map;
    }, {})
  ).map(g => {
    let cost = 0, value = 0;
    const native = marketCurrency(g.market);
    g.posns.forEach(p => {
      const q = prices[priceKey(p.market, p.ticker)];
      // Value is in the market's native currency; cost may be booked in another
      // (crypto bought in ZAR), so convert each from its own currency to display.
      const c = convertCcy(p.shares * p.costBasis, positionCostCcy(p), displayCurrency, rates);
      const v = q ? convertCcy(p.shares * q.price, native, displayCurrency, rates) : null;
      if (c != null) cost += c;
      if (v != null) value += v;
    });
    return { ...g, cost, value, pnl: value - cost, pnlPct: cost > 0 ? (value - cost) / cost * 100 : 0 };
  });
  const totalValue = marketGroups.reduce((s, g) => s + g.value, 0);
  const totalCost = marketGroups.reduce((s, g) => s + g.cost, 0);
  const totalPnl = totalValue - totalCost;
  const totalPnlPct = totalCost > 0 ? totalPnl / totalCost * 100 : 0;
  // Today's movement across the whole book, in the display currency. Each
  // holding's day change (price − previous close) is valued in its market's
  // native currency then converted; yesterday's value anchors the percentage.
  // Only markets that have actually TRADED during the user's current local
  // calendar day count — a pre-open US book otherwise reports yesterday's US
  // session as part of today's move.
  let todayChange = 0, todayPrevValue = 0, todayHasData = false;
  positions.forEach(p => {
    const q = prices[priceKey(p.market, p.ticker)];
    if (!q || !isFinite(q.price) || typeof q.prevClose !== 'number' || !(q.prevClose > 0)) return;
    if (!quoteTradedToday(q, p.market)) return;
    const native = marketCurrency(p.market);
    const valNow = convertCcy(p.shares * q.price, native, displayCurrency, rates);
    const valPrev = convertCcy(p.shares * q.prevClose, native, displayCurrency, rates);
    if (valNow != null && valPrev != null) {
      todayChange += valNow - valPrev; todayPrevValue += valPrev; todayHasData = true;
    }
  });
  const todayPct = (todayHasData && todayPrevValue > 0) ? todayChange / todayPrevValue * 100 : null;
  const todayUp = todayChange >= 0;
  const [contribModalOpen, setContribModalOpen] = useState(false);
  const [contribImportOpen, setContribImportOpen] = useState(false);
  const [showContribHistory, setShowContribHistory] = useState(false);
  const [showTxHistory, setShowTxHistory] = useState(false);
  const [txFilter, setTxFilter] = useState('all');
  // App-wide hide-value flag (also read by the donut, Holdings summaries, TFSA
  // totals and the growth chart) — the eye button here is the single toggle.
  const valueHidden = PBStore.useSetting('valueHidden');
  // "Money put in" = each deposit valued at the rate locked when it was made
  // (the real rate when USD-landed was recorded), not today's market rate — so
  // overall return compares what you contributed to what you now hold.
  const totalContribDisplay = contributions.reduce((sum, c) => {
    return sum + contribInDisplay(c, displayCurrency, rates);
  }, 0);
  const overallReturn = totalValue - totalContribDisplay;
  const overallReturnPct = totalContribDisplay > 0 ? (overallReturn / totalContribDisplay * 100) : 0;
  return React.createElement("div", { className: "dashboard-page" },
    // Empty state
    positions.length === 0 ? React.createElement("div", { className: "empty" },
      React.createElement(Icon, { name: "briefcase", size: 40 }),
      React.createElement("h3", null, "No positions yet"),
      React.createElement("p", null, "Add your holdings in the Holdings tab to see portfolio analytics."))
    : React.createElement(React.Fragment, null,
      // Stat cards row
      React.createElement("div", { className: "stat-card total-portfolio-card mb-4" },
        React.createElement("div", { className: "flex justify-between items-center" },
          React.createElement("div", { className: "stat-label" }, "Total Portfolio Value \xB7 " + displayCurrency),
          React.createElement("button", {
            className: "icon-btn",
            onClick: () => PBStore.setSetting('valueHidden', !valueHidden),
            'aria-label': valueHidden ? "Show value" : "Hide value",
            style: { marginTop: -4, marginBottom: -4 }
          }, React.createElement(Icon, { name: valueHidden ? 'eye-off' : 'eye', size: 14 }))),
        React.createElement("div", { className: "stat-value" + (valueHidden ? " val-blur" : "") },
          fmtCcy(totalValue, displayCurrency)),
        // Today's move — a clearly-labelled pill so it reads as the day's change
        // and isn't mistaken for the all-time P/L line beneath it.
        todayPct != null ? React.createElement("div", { className: "dash-today" + (valueHidden ? " val-blur" : "") },
          React.createElement("span", { className: "dash-today-label" }, "Today"),
          React.createElement("span", { className: `dash-today-val ${todayUp ? 'up' : 'down'}` },
            React.createElement("span", { className: "dash-today-arrow" }, todayUp ? '▲' : '▼'),
            fmtCcySigned(todayChange, displayCurrency), " \xB7 ", (todayUp ? '+' : '') + todayPct.toFixed(2) + '%')) : null,
        React.createElement("div", { className: `stat-sub ${totalPnlPct >= 0 ? 'up' : 'down'}` + (valueHidden ? " val-blur" : "") },
          "Unrealised ", totalPnlPct >= 0 ? '+' : '', totalPnlPct.toFixed(2), "% \xB7 ",
          fmtCcySigned(totalPnl, displayCurrency)),
        (() => {
          const snap = computeFxSnapshot({ positions, contributions, prices, fxRates, displayCurrency });
          const hasRates = !!fxRates?.rates;
          const totalContrib = contributions.reduce((s, c) => {
            return s + contribInDisplay(c, displayCurrency, fxRates?.rates || null);
          }, 0);
          const overallProfit = totalValue - totalContrib;
          const fxGain = snap.fxGainOnCost;
          const hasFx = hasRates && Math.abs(fxGain) > 0.01;
          const hasContrib = totalContrib > 0;
          return (hasFx || hasContrib) ? React.createElement("div", {
            className: "portfolio-summary-row" + (valueHidden ? " val-blur" : "")
          },
            hasFx && React.createElement("div", { className: "portfolio-summary-item" },
              React.createElement("span", { className: "portfolio-summary-label" },
                "Forex " + (fxGain >= 0 ? "gain" : "loss")),
              React.createElement("span", { className: `portfolio-summary-val ${fxGain >= 0 ? 'up' : 'down'}` },
                fmtCcySigned(fxGain, displayCurrency))),
            hasContrib && React.createElement("div", { className: "portfolio-summary-item" },
              React.createElement("span", { className: "portfolio-summary-label" }, "Overall profit"),
              React.createElement("span", { className: `portfolio-summary-val ${overallProfit >= 0 ? 'up' : 'down'}` },
                fmtCcySigned(overallProfit, displayCurrency)))
          ) : null;
        })()),
      // Portfolio growth chart
      React.createElement("div", { className: "card mb-4" },
        React.createElement("div", { className: "eyebrow", style: { marginBottom: 12 } }, "Portfolio Growth"),
        React.createElement(PortfolioLineChart, { positions, contributions, displayCurrency, fxRates })),
      // Allocation pie chart
      React.createElement("div", { className: "card mb-4" },
        React.createElement("div", { className: "eyebrow", style: { marginBottom: 12 } }, "Allocation"),
        React.createElement(PortfolioPieChart, { positions, displayCurrency, fxRates, onOpenDetail, sectorCache, fundamentals, sectorWeights, onSetSectorWeights })),
      // Growth tracker
      React.createElement("div", { className: "card mb-4 growth-tracker-card" },
        React.createElement("div", { className: "growth-tracker-header" },
          React.createElement("div", null,
            React.createElement("div", { className: "growth-tracker-title" }, "Growth Tracker"),
            React.createElement("div", { className: "growth-tracker-subtitle" }, "Performance & returns")),
          React.createElement("div", { className: "growth-tracker-actions" },
            onImportContributions ? React.createElement("button", { className: "growth-deposit-btn ghost", onClick: () => setContribImportOpen(true), title: "Import deposits & withdrawals" },
              React.createElement(Icon, { name: "download", size: 11 }), "Import") : null,
            React.createElement("button", { className: "growth-deposit-btn", onClick: () => setContribModalOpen(true) },
              React.createElement(Icon, { name: "plus", size: 11 }), "Log deposit"))),
        React.createElement("div", { className: "growth-stats-grid" },
          React.createElement("div", { className: "growth-stat" },
            React.createElement("div", { className: "growth-stat-header" },
              React.createElement("div", { className: "growth-stat-label" }, "Overall Return"),
              React.createElement("div", { className: "growth-stat-sub" }, "vs. contributions")),
            totalContribDisplay > 0
              ? React.createElement("div", { className: "growth-currency-row" },
                  React.createElement("span", { className: "market-badge" }, displayCurrency),
                  React.createElement("span", { className: `growth-val ${overallReturn >= 0 ? 'up' : 'down'}` + (valueHidden ? " val-blur" : "") },
                    overallReturn >= 0 ? '+' : '\u2212',
                    fmtCcy(Math.abs(overallReturn), displayCurrency)),
                  React.createElement("span", { className: `growth-pct ${overallReturnPct >= 0 ? 'up' : 'down'}` },
                    overallReturnPct >= 0 ? '+' : '', overallReturnPct.toFixed(1), "%"))
              : React.createElement("div", { className: "text-dim text-sm", style: { padding: '10px 14px', background: 'var(--bg-elev)', borderRadius: 10 } }, "Log a deposit to track overall return."),
            totalContribDisplay > 0 && React.createElement("button", {
              className: "growth-contrib-total",
              onClick: () => setShowContribHistory(true)
            }, React.createElement("span", { className: "text-dim" }, "Total contributions"),
              React.createElement("span", { className: "mono" + (valueHidden ? " hsum-blur-inline" : "") }, fmtCcy(totalContribDisplay, displayCurrency)),
              React.createElement(Icon, { name: "chevron", size: 12 }))),
          React.createElement("div", { className: "growth-stat" },
            React.createElement("div", { className: "growth-stat-header" },
              React.createElement("div", { className: "growth-stat-label" }, "Position P/L"),
              React.createElement("div", { className: "growth-stat-sub" }, "vs. cost basis")),
            currencyGroups.length > 0
              ? currencyGroups.map(g => React.createElement("div", { key: g.code, className: "growth-currency-row" },
                  React.createElement("span", { className: "market-badge" }, g.label),
                  React.createElement("span", { className: `growth-val ${g.pnl >= 0 ? 'up' : 'down'}` + (valueHidden ? " val-blur" : "") }, g.pnl >= 0 ? '+' : '\u2212', fmt(Math.abs(g.pnl), g.fmtMarket)),
                  React.createElement("span", { className: `growth-pct ${g.pnlPct >= 0 ? 'up' : 'down'}` }, g.pnlPct >= 0 ? '+' : '', g.pnlPct.toFixed(1), "%")))
              : React.createElement("div", { className: "text-dim text-sm", style: { padding: '10px 14px', background: 'var(--bg-elev)', borderRadius: 10 } }, "Add positions to see P/L."),
            (positions.length > 0 || transactions.length > 0) && React.createElement("button", {
              className: "growth-contrib-total",
              onClick: () => setShowTxHistory(true)
            }, React.createElement("span", { className: "text-dim" }, "Transaction history"),
              React.createElement(Icon, { name: "chevron", size: 12 }))))),
      // Contribution history modal
      showContribHistory && React.createElement("div", { className: "modal", onClick: e => { if (e.target.classList.contains('modal-backdrop')) setShowContribHistory(false); } },
        React.createElement("div", { className: "modal-backdrop", onClick: () => setShowContribHistory(false) }),
        React.createElement("div", { className: "modal-panel", style: { maxWidth: 520 } },
          React.createElement("div", { className: "modal-handle" }),
          React.createElement("div", { className: "modal-header" },
            React.createElement("div", null,
              React.createElement("div", { className: "modal-title" }, "Transaction History"),
              React.createElement("div", { className: "modal-subtitle" }, "All deposits and withdrawals")),
            React.createElement("button", { className: "modal-close", onClick: () => setShowContribHistory(false) },
              React.createElement(Icon, { name: "x" }))),
          React.createElement("div", { className: "modal-body" },
            contributions.length === 0
              ? React.createElement("div", { className: "text-dim text-sm", style: { textAlign: 'center', padding: 20 } }, "No transactions logged yet.")
              : contributions.slice().sort((a, b) => b.date.localeCompare(a.date)).map((c, i) =>
                React.createElement("div", { key: c.id || i, className: "transaction-row" },
                  React.createElement("div", { className: "transaction-info" },
                    React.createElement("div", { className: "transaction-date" }, new Date(c.date + 'T00:00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })),
                    c.usdLanded ? React.createElement("div", { className: "transaction-note" },
                      "→ $" + c.usdLanded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " landed"
                      + (c.fxRateAtContrib ? " · " + (CURRENCY_SYMBOLS[c.currency] || '') + c.fxRateAtContrib.toFixed(2) + "/$" : "")) : null,
                    c.note && React.createElement("div", { className: "transaction-note" }, c.note)),
                  React.createElement("div", { className: `transaction-amount ${c.amount >= 0 ? 'up' : 'down'}` },
                    (c.amount >= 0 ? '+' : '\u2212') + (CURRENCY_SYMBOLS[c.currency] || '') + Math.abs(c.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })),
                  React.createElement("button", { className: "btn btn-ghost btn-xs", onClick: () => { onRemoveContribution(c.id); } },
                    React.createElement(Icon, { name: "x", size: 10 })))),
            React.createElement("div", { className: "transaction-summary" },
              React.createElement("span", null, "Total: "),
              React.createElement("span", { className: "mono" }, fmtCcy(totalContribDisplay, displayCurrency)))))),
      // Transaction history modal
      showTxHistory && (() => {
        const txMarkets = ['all', ...Array.from(new Set(transactions.map(t => t.market)))];
        const filtered = txFilter === 'all' ? transactions : transactions.filter(t => t.market === txFilter);
        const sorted = filtered.slice().sort((a, b) => (b.date || b.createdAt).localeCompare(a.date || a.createdAt));
        return React.createElement("div", { className: "modal", onClick: e => { if (e.target.classList.contains('modal-backdrop')) setShowTxHistory(false); } },
          React.createElement("div", { className: "modal-backdrop", onClick: () => setShowTxHistory(false) }),
          React.createElement("div", { className: "modal-panel", style: { maxWidth: 520 } },
            React.createElement("div", { className: "modal-handle" }),
            React.createElement("div", { className: "modal-header" },
              React.createElement("div", null,
                React.createElement("div", { className: "modal-title" }, "Transaction History"),
                React.createElement("div", { className: "modal-subtitle" }, sorted.length, " transactions")),
              React.createElement("button", { className: "modal-close", onClick: () => setShowTxHistory(false) },
                React.createElement(Icon, { name: "x" }))),
            React.createElement("div", { className: "modal-body" },
              React.createElement("div", { className: "tx-filter-row" },
                txMarkets.map(m => React.createElement("button", {
                  key: m,
                  className: `tx-filter-btn ${txFilter === m ? 'active' : ''}`,
                  onClick: () => setTxFilter(m)
                }, m === 'all' ? 'All' : m))),
              sorted.length === 0
                ? React.createElement("div", { className: "text-dim text-sm", style: { textAlign: 'center', padding: 20 } }, "No transactions recorded yet.")
                : sorted.map(tx => {
                  const isBuy = tx.type === 'buy';
                  const total = tx.shares * tx.price;
                  const ccy = (MARKET_CURRENCY[tx.market] || MARKET_CURRENCY.US).sym;
                  return React.createElement("div", { key: tx.id, className: "transaction-row" },
                    React.createElement("div", { className: "transaction-info" },
                      React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                        React.createElement("span", { className: `tx-type-badge ${isBuy ? 'buy' : 'sell'}` }, isBuy ? 'BUY' : 'SELL'),
                        React.createElement("span", { style: { fontWeight: 600, fontSize: 13 } }, tx.ticker),
                        React.createElement("span", { className: "market-badge" }, tx.market)),
                      React.createElement("div", { className: "text-xs text-dim" },
                        tx.shares, " shares @ ", ccy, fmtNum(tx.price),
                        tx.notes ? ' \xB7 ' + tx.notes : '')),
                    React.createElement("div", { style: { textAlign: 'right' } },
                      React.createElement("div", { className: `transaction-amount ${isBuy ? '' : 'up'}` },
                        (isBuy ? '-' : '+') + ccy + fmtNum(total)),
                      React.createElement("div", { className: "text-xs text-dim" },
                        new Date(tx.date + 'T00:00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }))));
                }))));
      })(),
      // Contribution modal
      contribModalOpen ? React.createElement(ContributionModal, {
        onClose: () => setContribModalOpen(false),
        onOpenImport: onImportContributions ? () => setContribImportOpen(true) : null,
        onSave: (amount, currency, date, note, usdLanded) => { onAddContribution(amount, currency, date, note, usdLanded); setContribModalOpen(false); }
      }) : null,
      // Deposit / withdrawal bulk import
      contribImportOpen ? React.createElement(ContributionImportModal, {
        onClose: () => setContribImportOpen(false),
        onImport: (entries) => { if (onImportContributions) onImportContributions(entries); setContribImportOpen(false); }
      }) : null,
      ));
}

// --- Shared holding rows (relocated from app.js, Phase 4 inc 28) ---
// row zones: Holding (stock name) · P/L · Current value. Shared by the
// Holdings (per-market) and TFSA lists so both read identically.
function HoldingsListHead() {
  return React.createElement("div", { className: "holding-list-head" },
    React.createElement("span", { className: "hlh-name" }, "Holding"),
    React.createElement("span", { className: "hlh-gl" }, "P/L"),
    React.createElement("span", { className: "hlh-val" }, "Current value"));
}
// ─── Instrument logo ─────────────────────────────────────────────────────────
// The mark shown beside a holding/watchlist name. Pure in (ticker, market) —
// no state, no effects — so HoldingRow's React.memo still skips unchanged rows.
//
// Four states, decided at build time by tools/build-logos.mjs and baked into
// PBContent.LOGO_MANIFEST:
//   b (bleed)       — opaque, bright art that IS the tile; fills it edge to edge
//   k (needsBacking)— dark or sparse art; gets the white tile behind it
//   neither         — bright transparent art; floats on the surface, no tile
//   no entry        — monogram, deterministic hue per ticker
// The white tile is what makes the set coherent: the sources return three
// incompatible kinds of art (see the logo spec, §1 Claim C).
function logoHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
function LogoMark(_refLM) {
  const { ticker, market } = _refLM;
  const hit = logoFor(ticker, market);
  if (!hit) {
    // Fund codes (STX40, SYGWD) read better on three characters than two.
    const label = /^[A-Z]{3,}\d/.test(ticker) ? ticker.slice(0, 3) : String(ticker).slice(0, 2);
    return React.createElement("span", {
      className: "pb-logo pb-logo-mono", style: { '--logo-h': logoHue(String(ticker)) },
      "aria-hidden": "true"
    }, React.createElement("span", null, label));
  }
  const cls = "pb-logo" + (hit.b ? " pb-logo-bleed" : hit.k ? " pb-logo-backed" : " pb-logo-plain");
  return React.createElement("span", { className: cls, "aria-hidden": "true" },
    React.createElement("img", {
      src: "./logos/" + hit.f, alt: "", width: 34, height: 34,
      loading: "lazy", decoding: "async",
      // A file that 404s must not leave a broken-image glyph in the row.
      onError: e => { e.target.style.display = 'none'; }
    }));
}
const HoldingRow = React.memo(function HoldingRow(_refHR) {
  const { positionDisplayName, fmtCcy } = window.PBApp;
  let { position: p, market, quote: q, rates, onOpenDetail, onBuyPosition, onSellPosition, onEditPosition } = _refHR;
  // Heading is the company/instrument name. Resolve it from every source — the
  // name saved on the holding, the live quote's company name, the curated lists,
  // then the learned name cache — and only fall back to the bare ticker when
  // nothing else knows it.
  const name = positionDisplayName(p, market, q);
  const hasName = name !== p.ticker;
  // A unit trust has no ticker symbol, so its name takes the primary slot (where
  // a ticker normally sits) and the sub-line is dropped — the opaque Morningstar
  // id is never shown.
  const isUT = isUnitTrustId(p.ticker);
  const mainLabel = isUT && hasName ? name : p.ticker;
  // Value the position in the currency the cost basis is in. For ordinary
  // holdings that's the market's native currency (a no-op); for crypto bought in
  // ZAR it converts the live USD price into ZAR so cost and value line up and the
  // rand they paid is preserved instead of being silently re-based to dollars.
  const val = valuePositionInCostCcy(p, q, rates);
  const rowCcy = val.ccy;
  const marketValue = val.value;
  const cost = val.cost;
  const gain = val.gain;
  const gainUp = gain != null && gain >= 0;
  const growthPct = val.gainPct;
  const dayPct = q && typeof q.changePct === 'number' && isFinite(q.changePct) ? q.changePct : null;
  const dayUp = dayPct != null && dayPct >= 0;
  return React.createElement("button", {
    key: p.id, className: "row holding-row", onClick: () => onOpenDetail(p.ticker, market)
  },
    // LEFT — ticker + market badge (main), company name (sub). Avg cost lives on
    // the bottom action strip beside Edit (see ACTIONS below).
    React.createElement("div", { className: "row-main" },
      React.createElement(LogoMark, { ticker: p.ticker, market: market }),
      React.createElement("div", { className: "hold-txt" },
        React.createElement("div", { className: "hold-id" },
          React.createElement("span", { className: "hold-tkr-main" }, mainLabel),
          React.createElement("span", { className: "mkt-badge" }, isUT ? "fund" : market)),
        React.createElement("div", { className: "row-meta" },
          (hasName && !isUT) ? React.createElement("span", { className: "hold-co-name" }, name) : null))),
    // MIDDLE — total gain/loss: amount on top, % below
    React.createElement("div", { className: "holding-gl" },
      gain != null
        ? React.createElement(React.Fragment, null,
            React.createElement("div", { className: `holding-gl-amt mono ${gainUp ? 'text-up' : 'text-down'}` },
              (gainUp ? '+' : '−') + fmtCcy(gain, rowCcy)),
            growthPct != null ? React.createElement("div", { className: `holding-gl-pct mono ${gainUp ? 'text-up' : 'text-down'}` },
              (gainUp ? '+' : '') + growthPct.toFixed(2) + '%') : null)
        : React.createElement("div", { className: "holding-gl-amt mono text-dim" }, "—")),
    // RIGHT — current value, with the day's movement underneath
    React.createElement("div", { className: "row-right" },
      React.createElement("div", { className: "holding-value mono" }, marketValue != null ? fmtCcy(marketValue, rowCcy) : "—"),
      dayPct != null ? React.createElement("div", {
        className: `holding-day mono ${dayUp ? 'text-up' : 'text-down'}`
      }, (dayUp ? '+' : '') + dayPct.toFixed(2) + '%') : null),
    // ACTIONS — full-width strip beneath the three zones: the Buy/Sell/Edit cluster
    // on the left (identically sized on every card), with Avg cost on the right.
    React.createElement("div", { className: "row-actions" },
      React.createElement("div", { className: "row-actions-btns" },
        onBuyPosition ? React.createElement("button", {
          className: "btn-buy-inline",
          onClick: e => { e.stopPropagation(); onBuyPosition(p); }
        }, "Buy") : null,
        onSellPosition ? React.createElement("button", {
          className: "btn-sell-inline",
          onClick: e => { e.stopPropagation(); onSellPosition(p); }
        }, "Sell") : null,
        onEditPosition ? React.createElement("button", {
          className: "btn-edit-inline",
          onClick: e => { e.stopPropagation(); onEditPosition(p); }
        }, "Edit") : null),
      React.createElement("span", { className: "hold-avg" }, "Avg cost ", fmtCcy(p.costBasis, rowCcy))));
});

function CurrentView(_ref7) {
  let {
    positions,
    marketFilter,
    setMarketFilter,
    fxRates,
    onOpenDetail,
    onAddPosition,
    onEditPosition,
    onImportPositions,
    onBuyPosition,
    onSellPosition
  } = _ref7;
  const { Icon, fmtCcy, fmtCcySigned, MARKET_LABELS, positionDisplayName } = window.PBApp;
  const prices = PBStore.usePricesMap();
  const valueHidden = PBStore.useSetting('valueHidden');
  // Always offer the three primary US/SA tabs, then surface any other market
  // the user actually holds (LSE, ASX, FRA, PAR, AMS…) so imported non-US
  // holdings don't silently disappear from the Holdings view.
  const BASE_TABS = ['US', 'JSE', 'TFSA'];
  const marketOrder = MARKETS.map(m => m.value);
  const extraMarkets = Array.from(new Set(positions.map(p => p.market)))
    .filter(m => !BASE_TABS.includes(m))
    .sort((a, b) => marketOrder.indexOf(a) - marketOrder.indexOf(b));
  const tabs = [...BASE_TABS, ...extraMarkets];
  const tabLabel = (m) => MARKET_LABELS[m] || m;
  const activeMarket = tabs.includes(marketFilter) ? marketFilter : 'US';
  const countFor = (m) => positions.filter(p => p.market === m).length;
  const rates = fxRates?.rates || null;

  // Holdings sort — collapsed icon button + popover, sharing the watchlist's
  // wl-iconbtn / wl-sortmenu styling so the two tabs read identically. Defaults to
  // value (largest holding first) so each market tab opens biggest → smallest;
  // "Default order" (manual/insertion) is still available from the menu.
  const [sortMode, setSortMode] = useState('value');
  const [sortOpen, setSortOpen] = useState(false);
  const sortOptions = [
    { id: 'manual', label: 'Default order' },
    { id: 'value', label: 'Value: high → low' },
    { id: 'plPct', label: 'Gain %: high → low' },
    { id: 'plAmt', label: 'Gain amount' },
    { id: 'today', label: "Today's move" },
    { id: 'name', label: 'Name A–Z' }
  ];
  const sortRows = (rows, market) => {
    if (sortMode === 'manual') return rows;
    const arr = rows.slice();
    arr.sort((a, b) => {
      const qa = prices[priceKey(market, a.ticker)], qb = prices[priceKey(market, b.ticker)];
      if (sortMode === 'today') {
        const ca = qa && isFinite(qa.changePct) ? qa.changePct : -Infinity;
        const cb = qb && isFinite(qb.changePct) ? qb.changePct : -Infinity;
        return cb - ca;
      }
      if (sortMode === 'name') {
        const na = positionDisplayName(a, market, qa) || a.ticker;
        const nb = positionDisplayName(b, market, qb) || b.ticker;
        return na.localeCompare(nb);
      }
      const va = valuePositionInCostCcy(a, qa, rates), vb = valuePositionInCostCcy(b, qb, rates);
      if (sortMode === 'value') return (vb.value ?? -Infinity) - (va.value ?? -Infinity);
      if (sortMode === 'plPct') return (vb.gainPct ?? -Infinity) - (va.gainPct ?? -Infinity);
      if (sortMode === 'plAmt') return (vb.gain ?? -Infinity) - (va.gain ?? -Infinity);
      return 0;
    });
    return arr;
  };

  // Aggregate the active market's holdings into one summary (in the market's
  // native currency): total value, profit, and today's move. Cost booked in a
  // different currency (crypto in ZAR) is converted into native first.
  const computeMarketSummary = (rows, market) => {
    const native = marketCurrency(market);
    let value = 0, cost = 0, prevValue = 0, dayChange = 0, anyPrice = false, anyDay = false;
    rows.forEach(p => {
      const q = prices[priceKey(market, p.ticker)];
      const c = convertCcy(p.shares * p.costBasis, positionCostCcy(p), native, rates);
      cost += (c != null ? c : p.shares * p.costBasis);
      if (q && isFinite(q.price)) {
        value += p.shares * q.price; anyPrice = true;
        // Day line only counts once this market has traded today.
        if (typeof q.prevClose === 'number' && q.prevClose > 0 && quoteTradedToday(q, market)) {
          prevValue += p.shares * q.prevClose;
          dayChange += p.shares * (q.price - q.prevClose);
          anyDay = true;
        } else { prevValue += p.shares * q.price; }
      }
    });
    return {
      native, value, cost, anyPrice,
      gain: anyPrice ? value - cost : null,
      gainPct: (anyPrice && cost > 0) ? (value - cost) / cost * 100 : null,
      dayChange: anyDay ? dayChange : null,
      dayPct: (anyDay && prevValue > 0) ? dayChange / prevValue * 100 : null
    };
  };

  const renderSummary = (rows, market) => {
    const s = computeMarketSummary(rows, market);
    if (!s.anyPrice) return null;
    const up = (s.gain ?? 0) >= 0;
    const ccy = s.native;
    // Stacked progress bar. Profit: [invested | profit] spans the current value.
    // Loss: [value | shortfall] spans the original cost, so the red tail is the
    // slice of cost that's been given back.
    const total = up ? (s.value || 1) : (s.cost || 1);
    const investedPct = Math.max(0, Math.min(100, (up ? s.cost : s.value) / total * 100));
    const deltaPct = Math.max(0, 100 - investedPct);
    const dayUp = (s.dayChange ?? 0) >= 0;
    return React.createElement("div", { className: "holdings-summary" },
      React.createElement("div", { className: "hsum-top" },
        React.createElement("div", { className: "hsum-main" },
          React.createElement("div", { className: "hsum-label" }, "Market value · " + ccy),
          React.createElement("div", { className: "hsum-value mono" + (valueHidden ? " val-blur" : "") }, fmtCcy(s.value, ccy))),
        React.createElement("div", { className: `hsum-pl ${up ? 'up' : 'down'}` },
          React.createElement("div", { className: "hsum-pl-amt mono" + (valueHidden ? " val-blur" : "") }, fmtCcySigned(s.gain, ccy)),
          s.gainPct != null ? React.createElement("div", { className: "hsum-pl-pct mono" },
            (up ? '+' : '') + s.gainPct.toFixed(2) + '%') : null)),
      React.createElement("div", { className: "hsum-bar" },
        React.createElement("div", { className: "hsum-bar-invested", style: { width: investedPct + '%' } }),
        React.createElement("div", { className: `hsum-bar-delta ${up ? 'up' : 'down'}`, style: { width: deltaPct + '%' } })),
      React.createElement("div", { className: "hsum-foot" },
        React.createElement("div", { className: "hsum-foot-legend" },
          React.createElement("span", { className: "hsum-dot invested" }),
          React.createElement("span", null, "Invested ",
            React.createElement("span", { className: valueHidden ? "hsum-blur-inline" : "" }, fmtCcy(s.cost, ccy)))),
        s.dayPct != null ? React.createElement("div", { className: `hsum-today ${dayUp ? 'up' : 'down'}` },
          React.createElement("span", { className: "hsum-today-arrow" }, dayUp ? '▲' : '▼'),
          React.createElement("span", { className: "mono" }, "Today ",
            React.createElement("span", { className: valueHidden ? "hsum-blur-inline" : "" }, fmtCcySigned(s.dayChange, ccy)),
            " · ", (dayUp ? '+' : '') + s.dayPct.toFixed(2) + '%')) : null));
  };

  // Sort + Import + Add cluster. Lives directly beneath the market summary (or
  // above the empty state) rather than up in the tab row, and uses the compact
  // button sizing shared with the watchlist toolbar.
  const renderActions = (market, count) => React.createElement("div", {
    className: "holdings-actions holdings-actions-bar", style: { position: 'relative' }
  },
    count > 1 ? React.createElement("button", {
      className: "wl-iconbtn" + (sortOpen ? " active" : "") + (sortMode !== 'manual' ? " on" : ""),
      "aria-label": "Sort holdings", "aria-expanded": sortOpen,
      onClick: () => setSortOpen(o => !o)
    }, React.createElement(Icon, { name: "sort", size: 13 }),
       sortMode !== 'manual' ? React.createElement("span", { className: "wl-iconbtn-dot" }) : null) : null,
    onImportPositions ? React.createElement("button", { className: "btn btn-secondary btn-xs", onClick: onImportPositions },
      React.createElement(Icon, { name: "download", size: 11 }), " Import") : null,
    React.createElement("button", { className: "btn btn-primary btn-xs", onClick: onAddPosition },
      React.createElement(Icon, { name: "plus", size: 11 }), " Add"),
    // Sort popover anchored to the cluster's right edge so it stays on-screen.
    sortOpen ? React.createElement(React.Fragment, null,
      React.createElement("button", { className: "wl-pop-backdrop", "aria-label": "Close", onClick: () => setSortOpen(false) }),
      React.createElement("div", { className: "wl-sortmenu", style: { left: 'auto', right: 0, transformOrigin: 'top right' } },
        React.createElement("div", { className: "wl-sortmenu-head" }, "Sort by"),
        sortOptions.map(o => React.createElement("button", {
          key: o.id, className: "wl-sortmenu-row" + (sortMode === o.id ? " active" : ""),
          onClick: () => { setSortMode(o.id); setSortOpen(false); }
        }, React.createElement("span", { className: "wl-sortmenu-label" }, o.label),
           sortMode === o.id ? React.createElement(Icon, { name: "check", size: 14 }) : null)))
    ) : null);

  const renderMarket = (market) => {
    const rows = positions.filter(p => p.market === market);
    if (rows.length === 0) {
      return React.createElement("div", null,
        renderActions(market, 0),
        React.createElement("div", { className: "empty" },
          React.createElement(Icon, { name: "briefcase", size: 40 }),
          React.createElement("h3", null, "No ", tabLabel(market), " positions yet"),
          React.createElement("p", null, "Add your ", tabLabel(market), " holdings using the Add button above.")));
    }
    const sorted = sortRows(rows, market);
    return React.createElement("div", null,
      renderSummary(rows, market),
      renderActions(market, rows.length),
      React.createElement("div", {
      className: "eyebrow"
    }, "Your ", tabLabel(market), " positions"), React.createElement(HoldingsListHead, null), React.createElement("div", {
      className: "row-list"
    }, sorted.map(p => React.createElement(HoldingRow, {
      key: p.id,
      position: p,
      market: market,
      quote: prices[priceKey(market, p.ticker)],
      rates: fxRates?.rates || null,
      onOpenDetail: onOpenDetail,
      onBuyPosition: onBuyPosition,
      onSellPosition: onSellPosition,
      onEditPosition: onEditPosition
    }))));
  };
  return React.createElement("div", null, React.createElement("div", {
    className: "flex justify-between items-center mb-3 flex-wrap",
    style: {
      gap: 10
    }
  }, React.createElement("div", {
    className: "toggle-group toggle-group-scroll"
  }, tabs.map(m => React.createElement("button", {
    key: m,
    className: `toggle-opt toggle-opt-market ${activeMarket === m ? 'active' : ''}`,
    onClick: () => setMarketFilter(m)
  },
    React.createElement("span", { className: "toggle-opt-label" }, tabLabel(m)),
    React.createElement("span", { className: "toggle-opt-count" }, countFor(m))
  )))),
    renderMarket(activeMarket));
}

function WatchlistView(_ref8) {
  let {
    watchlist,
    positions,
    watchlistGroups,
    alerts,
    onAdd,
    onRemove,
    onReorder,
    onMoveWatch,
    onAddWatchGroup,
    onRenameWatchGroup,
    onRemoveWatchGroup,
    onOpenDetail,
    onAddAlert,
    onRemoveAlert,
    childSwipeLockRef
  } = _ref8;
  const { SessionBadge, MarketPicker, TickerSearch, PriceBlock, Icon, fmt, fmtNum, sanitizeDecimalInput, usePersistedState, watchListIds, prettyName, resolveTickerName, useHotStocks, buildSuggestions } = window.PBApp;
  const prices = PBStore.usePricesMap();
  const [newTicker, setNewTicker] = useState('');
  const [newMarket, setNewMarket] = useState('US');
  const [showAddForm, setShowAddForm] = useState(false);
  const [showSuggestions, setShowSuggestions] = usePersistedState('pb.watchlist.showSuggestions.v1', true);
  // Multiple named watchlists + per-list filtering. activeList 'all' shows every
  // tracked stock; 'default' is the built-in list; anything else is a custom list
  // id. The full-list, unsorted, unfiltered "All" view is the only one where the
  // long-press drag-reorder runs (it reorders the whole array by index, so it
  // can't operate on a filtered subset).
  const groups = watchlistGroups || [];
  const [activeList, setActiveList] = usePersistedState('pb.watchlist.activeList.v1', 'all');
  const [search, setSearch] = useState('');
  const [filterMarket, setFilterMarket] = useState('all');
  // Smart filter tag — an extra axis beyond market: movers, near-high, alerts.
  // Combines with the market filter (AND) so you can narrow on both at once.
  const [filterTag, setFilterTag] = useState('all');
  const [sortMode, setSortMode] = useState('manual');
  // Search/sort live as collapsed icon buttons in the action row; these drive
  // the iOS-style expand of the search field and the sort popover respectively.
  const [searchOpen, setSearchOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const searchInputRef = useRef(null);
  const [creatingList, setCreatingList] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [managingList, setManagingList] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  // If a stored active list was deleted elsewhere, fall back to All.
  useEffect(() => {
    if (activeList !== 'all' && activeList !== 'default' && !groups.some(g => g.id === activeList)) setActiveList('all');
  }, [activeList, groups]);
  // A stock can sit in several lists at once, so membership is a set test rather
  // than a single id compare. customListsOf drives the per-card list badges.
  const inList = (w, id) => watchListIds(w).includes(id);
  const customListsOf = (w) => watchListIds(w).filter(id => id !== 'default');
  const reorderEnabled = activeList === 'all' && !search.trim() && filterMarket === 'all' && filterTag === 'all' && sortMode === 'manual';
  const targetListId = activeList === 'all' ? 'default' : activeList;
  // Suggestion chips leave the list the instant they're added (the list is
  // derived from the watchlist), which left users unsure their tap registered.
  // We keep a short-lived "added" snapshot so the tapped chip morphs into a
  // green ✓ confirmation before fading, instead of silently vanishing.
  const [justAdded, setJustAdded] = useState([]);

  // Alert popup state
  const [alertPopup, setAlertPopup] = useState(null);
  const [alertDir, setAlertDir] = useState('above');
  const [alertTarget, setAlertTarget] = useState('');
  const [alertNote, setAlertNote] = useState('');
  const openAlertPopup = (ticker, market) => {
    const q = prices[priceKey(market, ticker)];
    setAlertPopup({ ticker, market });
    setAlertDir('above');
    setAlertTarget(q ? q.price.toFixed(2) : '');
    setAlertNote('');
  };
  const submitAlertPopup = () => {
    if (!alertPopup) return;
    const t = parseDecimal(alertTarget);
    if (!isFinite(t) || t <= 0) return;
    onAddAlert(alertPopup.ticker, alertPopup.market, alertDir, t, alertNote);
    setAlertNote('');
  };
  const popupAlerts = alertPopup ? alerts.filter(a => a.ticker === alertPopup.ticker && a.market === alertPopup.market) : [];
  const popupCcy = alertPopup ? (alertPopup.market === 'JSE' ? 'ZAR' : 'USD') : 'USD';

  // Swipe-to-delete state
  const [swipedId, setSwipedId] = useState(null);
  const swipeRefs = useRef(new Map());

  // Freeform long-press drag-to-reorder. Document-level pointer tracking keeps
  // vertical scroll native while horizontal swipe / drag stay responsive.
  const [draggingId, setDraggingId] = useState(null);
  const cardRefsRef = useRef(new Map());
  const setCardRef = useCallback((id) => (el) => {
    if (el) cardRefsRef.current.set(id, el);
    else cardRefsRef.current.delete(id);
  }, []);
  const longPressTimerRef = useRef(null);
  const pressOriginRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);
  const hapticCtxRef = useRef(null);
  const activeGestureRef = useRef(null);
  const pointerTrackRef = useRef(null);
  const dragTouchBlockRef = useRef(null);

  const triggerHaptic = () => {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try { navigator.vibrate(20); } catch (_) {}
    }
    // Audio tick for iOS (vibrate API unsupported). Barely-audible 12ms pop
    // produced through the speaker — gives tactile-ish feedback on-device.
    const ctx = hapticCtxRef.current;
    if (ctx && ctx.state === 'running') {
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.value = 0.08;
        osc.frequency.value = 180;
        osc.start();
        osc.stop(ctx.currentTime + 0.012);
      } catch (_) {}
    }
  };

  const blockPageScroll = () => {
    if (dragTouchBlockRef.current) return;
    const prevent = (e) => { if (e.cancelable) e.preventDefault(); };
    document.addEventListener('touchmove', prevent, { passive: false });
    dragTouchBlockRef.current = prevent;
  };

  const unblockPageScroll = () => {
    if (!dragTouchBlockRef.current) return;
    document.removeEventListener('touchmove', dragTouchBlockRef.current, { passive: false });
    dragTouchBlockRef.current = null;
  };

  const detachPointerTracking = () => {
    const track = pointerTrackRef.current;
    if (!track) return;
    document.removeEventListener('pointermove', track.onMove);
    document.removeEventListener('pointerup', track.onUp);
    document.removeEventListener('pointercancel', track.onUp);
    pointerTrackRef.current = null;
    activeGestureRef.current = null;
    if (childSwipeLockRef) childSwipeLockRef.current = false;
  };

  // Clean up haptic AudioContext on unmount
  useEffect(() => {
    return () => {
      detachPointerTracking();
      unblockPageScroll();
      if (hapticCtxRef.current) try { hapticCtxRef.current.close(); } catch (_) {}
    };
  }, []);

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const naturalRectsRef = useRef(new Map());

  const displaceNeighbours = (originIdx, targetIdx) => {
    const rects = naturalRectsRef.current;
    const originRect = rects.get(watchlist[originIdx].id);
    if (!originRect) return;
    watchlist.forEach((w, i) => {
      if (i === originIdx) return;
      const el = cardRefsRef.current.get(w.id);
      if (!el) return;
      const naturalPos = rects.get(w.id);
      if (!naturalPos) { el.style.transform = ''; return; }
      const reordered = [...watchlist];
      const [moved] = reordered.splice(originIdx, 1);
      reordered.splice(targetIdx, 0, moved);
      const newLogicalIdx = reordered.findIndex(x => x.id === w.id);
      const origLogicalIdx = watchlist.findIndex(x => x.id === w.id);
      if (newLogicalIdx === origLogicalIdx) {
        el.style.transform = '';
      } else {
        const targetRect = rects.get(reordered[origLogicalIdx]?.id);
        if (targetRect) {
          const dy = targetRect.top - naturalPos.top;
          el.style.transform = dy ? `translateY(${dy}px)` : '';
        } else {
          el.style.transform = '';
        }
      }
    });
  };

  const startDrag = (id, pointerId, startY) => {
    const card = cardRefsRef.current.get(id);
    if (!card) return;
    triggerHaptic();
    const originIdx = watchlist.findIndex(w => w.id === id);
    if (originIdx < 0) return;
    naturalRectsRef.current.clear();
    watchlist.forEach(w => {
      const el = cardRefsRef.current.get(w.id);
      if (el) {
        el.style.transition = 'none';
        el.style.transform = '';
      }
    });
    watchlist.forEach(w => {
      const el = cardRefsRef.current.get(w.id);
      if (el) naturalRectsRef.current.set(w.id, el.getBoundingClientRect());
    });
    watchlist.forEach((w, i) => {
      const el = cardRefsRef.current.get(w.id);
      if (el && i !== originIdx) {
        el.style.transition = 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)';
      }
    });
    dragRef.current = {
      id, pointerId,
      pointerStartY: startY,
      originIdx, targetIdx: originIdx,
      moved: false,
    };
    blockPageScroll();
    card.style.transition = 'none';
    card.style.transform = 'scale(1.04)';
    card.style.zIndex = '50';
    try { card.setPointerCapture(pointerId); } catch (_) {}
    setDraggingId(id);
  };

  const onCardPointerDown = (e, id) => {
    if (e.target.closest('button,a,input,[data-no-drag]')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (dragRef.current) return;
    clearLongPress();
    if (!hapticCtxRef.current) {
      try { hapticCtxRef.current = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
    }
    if (hapticCtxRef.current && hapticCtxRef.current.state === 'suspended') {
      try { hapticCtxRef.current.resume(); } catch (_) {}
    }
    if (swipedId && swipedId !== id) closeSwipe(swipedId);
    pressOriginRef.current = { id, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    // Drag-reorder only in the plain "All" view — a filtered/sorted/specific-list
    // view renders a subset, which the index-based reorder can't handle. Swipe and
    // tap stay active regardless.
    if (reorderEnabled) {
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        const po = pressOriginRef.current;
        if (!po || po.id !== id) return;
        startDrag(id, po.pointerId, po.y);
      }, 450);
    }
    attachPointerTracking(id, e.pointerId, e.clientX, e.clientY);
  };

  const handleDocumentPointerMove = (e) => {
    const drag = dragRef.current;
    if (drag) {
      if (e.pointerId !== drag.pointerId) return;
      if (e.cancelable) e.preventDefault();
      const dy = e.clientY - drag.pointerStartY;
      const card = cardRefsRef.current.get(drag.id);
      if (card) card.style.transform = `translateY(${dy}px) scale(1.04)`;
      drag.moved = true;
      const pointerY = e.clientY;
      let targetIdx = drag.originIdx;
      const rects = naturalRectsRef.current;
      for (let i = 0; i < watchlist.length; i++) {
        if (i === drag.originIdx) continue;
        const r = rects.get(watchlist[i].id);
        if (!r) continue;
        const center = r.top + r.height / 2;
        if (i < drag.originIdx && pointerY < center) { targetIdx = i; break; }
        if (i > drag.originIdx && pointerY > center) { targetIdx = i; }
      }
      if (targetIdx !== drag.targetIdx) {
        drag.targetIdx = targetIdx;
        displaceNeighbours(drag.originIdx, targetIdx);
      }
      return;
    }

    const g = activeGestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;

    if (longPressTimerRef.current) {
      if (dx * dx + dy * dy > 100) clearLongPress();
    }

    if (!g.mode) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      g.mode = Math.abs(dx) > Math.abs(dy) ? 'swipe-h' : 'scroll-v';
    }

    if (g.mode === 'scroll-v') {
      // Stop tracking so native scroll stays on the compositor thread.
      const track = pointerTrackRef.current;
      if (track) document.removeEventListener('pointermove', track.onMove);
      return;
    }

    if (e.cancelable) e.preventDefault();
    if (childSwipeLockRef) childSwipeLockRef.current = true;
    clearLongPress();
    g.swipeLocked = true;
    g.dx = dx;
    const inner = swipeRefs.current.get(g.id);
    if (inner) {
      inner.classList.add('is-swiping');
      const clamped = Math.max(-80, Math.min(dx > 0 ? 0 : dx, 0));
      inner.style.transition = 'none';
      inner.style.transform = `translateX(${clamped}px)`;
    }
  };

  const handleDocumentPointerUp = (e) => {
    const drag = dragRef.current;
    if (drag && e.pointerId === drag.pointerId) {
      clearLongPress();
      pressOriginRef.current = null;
      finishDrag(e.type !== 'pointercancel');
      detachPointerTracking();
      return;
    }

    const g = activeGestureRef.current;
    if (g && e.pointerId === g.pointerId && g.swipeLocked) {
      const inner = swipeRefs.current.get(g.id);
      if (inner) {
        inner.classList.remove('is-swiping');
        if (g.dx < -50) {
          inner.style.transition = 'transform 250ms cubic-bezier(0.22, 1, 0.36, 1)';
          inner.style.transform = 'translateX(-80px)';
          setSwipedId(g.id);
        } else {
          inner.style.transition = 'transform 250ms cubic-bezier(0.22, 1, 0.36, 1)';
          inner.style.transform = '';
          setSwipedId(prev => prev === g.id ? null : prev);
        }
      }
    }
    clearLongPress();
    pressOriginRef.current = null;
    detachPointerTracking();
  };

  const attachPointerTracking = (id, pointerId, startX, startY) => {
    detachPointerTracking();
    activeGestureRef.current = { id, pointerId, startX, startY, mode: null, dx: 0, swipeLocked: false };
    const onMove = (ev) => handleDocumentPointerMove(ev);
    const onUp = (ev) => handleDocumentPointerUp(ev);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    pointerTrackRef.current = { onMove, onUp };
  };

  const finishDrag = (commit) => {
    const drag = dragRef.current;
    if (!drag) return;
    watchlist.forEach(w => {
      const el = cardRefsRef.current.get(w.id);
      if (el) {
        el.style.transition = '';
        el.style.transform = '';
        el.style.zIndex = '';
      }
    });
    try {
      const card = cardRefsRef.current.get(drag.id);
      if (card) card.releasePointerCapture(drag.pointerId);
    } catch (_) {}
    if (commit && drag.moved && drag.targetIdx !== drag.originIdx) {
      const arr = [...watchlist];
      const [m] = arr.splice(drag.originIdx, 1);
      arr.splice(drag.targetIdx, 0, m);
      onReorder(arr);
    }
    if (drag.moved) suppressClickRef.current = true;
    dragRef.current = null;
    unblockPageScroll();
    setDraggingId(null);
  };

  const closeSwipe = useCallback((id) => {
    const inner = swipeRefs.current.get(id);
    if (inner) {
      inner.classList.remove('is-swiping');
      inner.style.transition = 'transform 250ms cubic-bezier(0.22, 1, 0.36, 1)';
      inner.style.transform = '';
    }
    setSwipedId(prev => prev === id ? null : prev);
  }, []);

  const confirmDelete = (id) => {
    const inner = swipeRefs.current.get(id);
    if (inner) {
      inner.style.transition = 'transform 200ms ease-out';
      inner.style.transform = 'translateX(-100vw)';
    }
    setTimeout(() => onRemove(id), 220);
  };

  const hotStocks = useHotStocks();
  const suggestions = useMemo(() => buildSuggestions(watchlist, positions, hotStocks), [watchlist, positions, hotStocks]);
  const addSuggestion = (s) => {
    const key = priceKey(s.market, s.ticker);
    if (watchlist.some(w => priceKey(w.market, w.ticker) === key)) return;
    onAdd(s.ticker, s.market, s.name, targetListId);
    triggerHaptic();
    setJustAdded(prev => prev.some(x => priceKey(x.market, x.ticker) === key) ? prev : [...prev, s]);
    setTimeout(() => setJustAdded(prev => prev.filter(x => priceKey(x.market, x.ticker) !== key)), 1700);
  };
  const tabLists = [{ id: 'all', name: 'All' }, { id: 'default', name: 'Watchlist' }, ...groups];
  const isCustomActive = activeList !== 'all' && activeList !== 'default';
  const listNameById = (id) => (id === 'default' ? 'Watchlist' : ((groups.find(g => g.id === id) || {}).name || 'Watchlist'));
  const countFor = (id) => id === 'all' ? watchlist.length : watchlist.filter(w => inList(w, id)).length;
  const activeCount = activeList === 'all' ? watchlist.length : countFor(activeList);
  const marketsPresent = useMemo(() => {
    const set = new Set();
    watchlist.forEach(w => { if (activeList === 'all' || inList(w, activeList)) set.add(w.market); });
    return Array.from(set).sort();
  }, [watchlist, activeList]);
  const visible = useMemo(() => {
    let arr = watchlist.filter(w => activeList === 'all' ? true : inList(w, activeList));
    const s = search.trim().toLowerCase();
    if (s) {
      // Smarter search: every space-separated term must hit somewhere in the
      // ticker or name, so "app tech" narrows instead of needing one substring.
      const terms = s.split(/\s+/).filter(Boolean);
      arr = arr.filter(w => {
        const hay = (w.ticker + ' ' + (w.name || '')).toLowerCase();
        return terms.every(t => hay.includes(t));
      });
    }
    if (filterMarket !== 'all') arr = arr.filter(w => w.market === filterMarket);
    if (filterTag !== 'all') arr = arr.filter(w => {
      const q = prices[priceKey(w.market, w.ticker)];
      const ch = q && typeof q.changePct === 'number' && isFinite(q.changePct) ? q.changePct : null;
      if (filterTag === 'up') return ch != null && ch > 0;
      if (filterTag === 'down') return ch != null && ch < 0;
      if (filterTag === 'nearhigh') return !!q && q.yearHigh > 0 && q.price >= q.yearHigh * 0.95;
      if (filterTag === 'alerts') return alerts.some(a => a.ticker === w.ticker && a.market === w.market);
      return true;
    });
    if (sortMode === 'name') arr = [...arr].sort((a, b) => (prettyName(a.name) || a.ticker).localeCompare(prettyName(b.name) || b.ticker));
    else if (sortMode === 'recent') arr = [...arr].sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
    else if (sortMode === 'today') arr = [...arr].sort((a, b) => {
      const qa = prices[priceKey(a.market, a.ticker)], qb = prices[priceKey(b.market, b.ticker)];
      const ca = qa && typeof qa.changePct === 'number' && isFinite(qa.changePct) ? qa.changePct : -Infinity;
      const cb = qb && typeof qb.changePct === 'number' && isFinite(qb.changePct) ? qb.changePct : -Infinity;
      return cb - ca;
    });
    // Pre/post move: rank by whatever extended-hours reading a symbol carries —
    // the live pre-market % before the open, the live after-hours % in the
    // evening, or the FINAL overnight "after close" move once the session ends.
    // Symbols with no ext reading (regular hours / no data / no ext trading)
    // sink to the bottom, so the option degrades gracefully around the clock.
    else if (sortMode === 'premarket') arr = [...arr].sort((a, b) => {
      const qa = prices[priceKey(a.market, a.ticker)], qb = prices[priceKey(b.market, b.ticker)];
      const pa = qa && qa.extKind && typeof qa.extChangePct === 'number' && isFinite(qa.extChangePct) ? qa.extChangePct : -Infinity;
      const pb = qb && qb.extKind && typeof qb.extChangePct === 'number' && isFinite(qb.extChangePct) ? qb.extChangePct : -Infinity;
      return pb - pa;
    });
    return arr;
  }, [watchlist, activeList, search, filterMarket, filterTag, sortMode, prices, alerts]);
  // Switching lists clears the in-list filters so you never land on a list that
  // looks empty because of a stale search / market filter.
  useEffect(() => { setSearch(''); setFilterMarket('all'); setFilterTag('all'); setManagingList(false); setSearchOpen(false); setSortOpen(false); setManageOpen(false); setFilterOpen(false); }, [activeList]);
  const sortOptions = [
    { id: 'manual', label: reorderEnabled ? 'Manual order' : 'Default order' },
    { id: 'today', label: "Today's move" },
    { id: 'premarket', label: 'Pre/post move' },
    { id: 'name', label: 'Name A–Z' },
    { id: 'recent', label: 'Recently added' }
  ];
  const filterTagOptions = [
    { id: 'all', label: 'All stocks' },
    { id: 'up', label: 'Gainers today' },
    { id: 'down', label: 'Losers today' },
    { id: 'nearhigh', label: 'Near 52W high' },
    { id: 'alerts', label: 'Has alerts' }
  ];
  const createList = () => {
    const _r = onAddWatchGroup && onAddWatchGroup(newListName);
    const id = _r && _r.id;
    if (id) setActiveList(id);
    setNewListName(''); setCreatingList(false);
  };
  const saveRename = () => {
    if (onRenameWatchGroup && renameValue.trim()) onRenameWatchGroup(activeList, renameValue);
    setManagingList(false); setManageOpen(false);
  };
  const deleteList = () => {
    if (onRemoveWatchGroup) onRemoveWatchGroup(activeList);
    setManagingList(false); setManageOpen(false); setActiveList('all');
  };
  return React.createElement("div", null,
    // Topline — the watchlists only. Search, sort and Add live on the row below.
    React.createElement("div", { className: "wl-tabbar" },
      React.createElement("div", { className: "wl-tabs" },
        tabLists.map(l => React.createElement("button", {
          key: l.id,
          className: "wl-tab" + (activeList === l.id ? " active" : ""),
          onClick: () => setActiveList(l.id)
        }, l.name, React.createElement("span", { className: "wl-tab-count" }, countFor(l.id)))),
        onAddWatchGroup ? React.createElement("button", {
          key: '__new', className: "wl-tab wl-tab-new",
          onClick: () => { setCreatingList(true); setManagingList(false); }, "aria-label": "New list", title: "New list"
        }, React.createElement(Icon, { name: "plus", size: 13 })) : null
      )
    ),
    // Action row — interactive search/sort icons (iOS-style expand) + Add. Search
    // and sort only appear when there's something to act on; Add is always here.
    React.createElement("div", { className: "wl-toolbar" + (searchOpen ? " searching" : "") },
      activeCount > 0 ? React.createElement("div", { className: "wl-search2" + (searchOpen ? " open" : "") },
        React.createElement("button", {
          className: "wl-iconbtn wl-search2-btn" + (searchOpen ? " active" : ""),
          "aria-label": searchOpen ? "Close search" : "Search",
          onClick: () => {
            if (searchOpen) { setSearch(''); setSearchOpen(false); }
            else { setSortOpen(false); setManageOpen(false); setFilterOpen(false); setSearchOpen(true); requestAnimationFrame(() => { try { searchInputRef.current && searchInputRef.current.focus(); } catch (_) {} }); }
          }
        }, React.createElement(Icon, { name: searchOpen ? "x" : "search", size: 14 })),
        React.createElement("input", {
          ref: searchInputRef,
          className: "wl-search2-input", type: "text", placeholder: "Filter by ticker or name",
          value: search, onChange: e => setSearch(e.target.value), tabIndex: searchOpen ? 0 : -1,
          autoComplete: "off", autoCorrect: "off", spellCheck: false,
          onKeyDown: e => { if (e.key === 'Escape') { setSearch(''); setSearchOpen(false); } }
        })
      ) : null,
      activeCount > 0 ? React.createElement("div", { className: "wl-sortwrap" },
        React.createElement("button", {
          className: "wl-iconbtn" + (sortOpen ? " active" : "") + (sortMode !== 'manual' ? " on" : ""),
          "aria-label": "Sort", "aria-expanded": sortOpen,
          onClick: () => { setSearchOpen(false); setManageOpen(false); setFilterOpen(false); setSortOpen(o => !o); }
        }, React.createElement(Icon, { name: "sort", size: 14 }),
           sortMode !== 'manual' ? React.createElement("span", { className: "wl-iconbtn-dot" }) : null),
        sortOpen ? React.createElement(React.Fragment, null,
          React.createElement("button", { className: "wl-pop-backdrop", "aria-label": "Close", onClick: () => setSortOpen(false) }),
          React.createElement("div", { className: "wl-sortmenu" },
            React.createElement("div", { className: "wl-sortmenu-head" }, "Sort by"),
            sortOptions.map(o => React.createElement("button", {
              key: o.id, className: "wl-sortmenu-row" + (sortMode === o.id ? " active" : ""),
              onClick: () => { setSortMode(o.id); setSortOpen(false); }
            }, React.createElement("span", { className: "wl-sortmenu-label" }, o.label),
               sortMode === o.id ? React.createElement(Icon, { name: "check", size: 14 }) : null)))
        ) : null
      ) : null,
      // Filter popover — a smart filter holding the market picker plus quick
      // tags (movers, near-high, alerts). Replaces the always-on market chip row.
      activeCount > 0 ? React.createElement("div", { className: "wl-sortwrap" },
        React.createElement("button", {
          className: "wl-iconbtn" + (filterOpen ? " active" : "") + ((filterMarket !== 'all' || filterTag !== 'all') ? " on" : ""),
          "aria-label": "Filter", "aria-expanded": filterOpen,
          onClick: () => { setSearchOpen(false); setSortOpen(false); setManageOpen(false); setFilterOpen(o => !o); }
        }, React.createElement(Icon, { name: "filter", size: 14 }),
           (filterMarket !== 'all' || filterTag !== 'all') ? React.createElement("span", { className: "wl-iconbtn-dot" }) : null),
        filterOpen ? React.createElement(React.Fragment, null,
          React.createElement("button", { className: "wl-pop-backdrop", "aria-label": "Close", onClick: () => setFilterOpen(false) }),
          React.createElement("div", { className: "wl-sortmenu wl-filtermenu" },
            marketsPresent.length > 1 ? React.createElement(React.Fragment, null,
              React.createElement("div", { className: "wl-sortmenu-head" }, "Market"),
              React.createElement("div", { className: "wl-fchips" },
                ['all', ...marketsPresent].map(m => React.createElement("button", {
                  key: m, className: "wl-fchip" + (filterMarket === m ? " active" : ""),
                  onClick: () => setFilterMarket(m)
                }, m === 'all' ? 'All' : m)))
            ) : null,
            React.createElement("div", { className: "wl-sortmenu-head" }, "Show"),
            filterTagOptions.map(o => React.createElement("button", {
              key: o.id, className: "wl-sortmenu-row" + (filterTag === o.id ? " active" : ""),
              onClick: () => setFilterTag(o.id)
            }, React.createElement("span", { className: "wl-sortmenu-label" }, o.label),
               filterTag === o.id ? React.createElement(Icon, { name: "check", size: 14 }) : null)),
            (filterMarket !== 'all' || filterTag !== 'all') ? React.createElement("button", {
              className: "wl-sortmenu-row wl-filter-clear",
              onClick: () => { setFilterMarket('all'); setFilterTag('all'); }
            }, React.createElement(Icon, { name: "x", size: 14 }), React.createElement("span", { className: "wl-sortmenu-label" }, "Clear filters")) : null)
        ) : null
      ) : null,
      // Manage the active custom list — an edit icon that opens the same animated
      // popover as sort, holding the rename/delete actions for this list.
      isCustomActive ? React.createElement("div", { className: "wl-sortwrap" },
        React.createElement("button", {
          className: "wl-iconbtn" + (manageOpen ? " active" : ""),
          "aria-label": "Edit list", "aria-expanded": manageOpen,
          onClick: () => { setSearchOpen(false); setSortOpen(false); setFilterOpen(false); setManagingList(false); setManageOpen(o => !o); }
        }, React.createElement(Icon, { name: "edit", size: 13 })),
        manageOpen ? React.createElement(React.Fragment, null,
          React.createElement("button", { className: "wl-pop-backdrop", "aria-label": "Close", onClick: () => { setManageOpen(false); setManagingList(false); } }),
          React.createElement("div", { className: "wl-sortmenu" },
            React.createElement("div", { className: "wl-sortmenu-head" }, listNameById(activeList), " \xB7 ", activeCount, activeCount === 1 ? " stock" : " stocks"),
            managingList
              ? React.createElement("div", { className: "wl-rename-row" },
                  React.createElement("input", {
                    className: "wl-inline-input", type: "text", value: renameValue, maxLength: 28, autoFocus: true, placeholder: "List name",
                    onChange: e => setRenameValue(e.target.value),
                    onKeyDown: e => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') setManagingList(false); }
                  }),
                  React.createElement("div", { className: "wl-rename-actions" },
                    React.createElement("button", { className: "btn btn-ghost btn-sm", onClick: () => setManagingList(false), style: { flex: '1 1 auto' } }, "Cancel"),
                    React.createElement("button", { className: "btn btn-primary btn-sm", onClick: saveRename, disabled: !renameValue.trim(), style: { flex: '1 1 auto' } }, "Save")))
              : React.createElement(React.Fragment, null,
                  React.createElement("button", {
                    className: "wl-sortmenu-row",
                    onClick: () => { setRenameValue(listNameById(activeList)); setManagingList(true); }
                  }, React.createElement(Icon, { name: "edit", size: 14 }), React.createElement("span", { className: "wl-sortmenu-label" }, "Rename list")),
                  React.createElement("button", {
                    className: "wl-sortmenu-row wl-danger", onClick: deleteList
                  }, React.createElement(Icon, { name: "trash", size: 14 }), React.createElement("span", { className: "wl-sortmenu-label" }, "Delete list"))))
        ) : null
      ) : null,
      React.createElement("button", { className: "btn btn-primary btn-sm wl-add-btn", onClick: () => setShowAddForm(true) },
        React.createElement(Icon, { name: "plus", size: 12 }), " Add")
    ),
    creatingList ? React.createElement("div", { className: "wl-inline-form mb-4" },
      React.createElement("input", {
        className: "wl-inline-input", type: "text", placeholder: "New list name (e.g. Tech, To buy)",
        value: newListName, maxLength: 28, autoFocus: true,
        onChange: e => setNewListName(e.target.value),
        onKeyDown: e => { if (e.key === 'Enter') createList(); if (e.key === 'Escape') { setCreatingList(false); setNewListName(''); } }
      }),
      React.createElement("button", { className: "btn btn-primary btn-sm", onClick: createList, disabled: !newListName.trim(), style: { flex: '0 0 auto' } }, "Create"),
      React.createElement("button", { className: "btn btn-ghost btn-sm", onClick: () => { setCreatingList(false); setNewListName(''); }, style: { flex: '0 0 auto' } }, "Cancel")
    ) : null,
    showAddForm && React.createElement("div", { className: "card mb-4 watchlist-add" },
      React.createElement("div", { className: "wl-add-hint" },
        React.createElement(Icon, { name: "search", size: 13 }),
        React.createElement("span", null, " Search a stock and tap a result to open its card — add it to a watchlist from there.")),
      React.createElement("div", { className: "form-label" }, "Market"),
      React.createElement(MarketPicker, {
        value: newMarket,
        onChange: v => setNewMarket(v),
        style: { width: '100%', marginBottom: 10 }
      }),
      React.createElement("div", { className: "form-label" }, "Search"),
      React.createElement(TickerSearch, {
        value: newTicker,
        onChange: v => setNewTicker(v),
        market: newMarket,
        onMarketChange: v => setNewMarket(v),
        onSelect: (s) => { setShowAddForm(false); setNewTicker(''); onOpenDetail(s.ticker, s.market); },
        onEnter: () => { const t = newTicker.trim(); if (!t) return; setShowAddForm(false); setNewTicker(''); onOpenDetail(t.toUpperCase(), newMarket); }
      }),
      React.createElement("button", {
        className: "btn btn-ghost btn-sm",
        style: { marginTop: 12, width: '100%' },
        onClick: () => { setShowAddForm(false); setNewTicker(''); }
      }, "Close")
    ),
    watchlist.length === 0 ? React.createElement("div", { className: "empty" },
      React.createElement(Icon, { name: "eye", size: 40 }),
      React.createElement("h3", null, "Empty watchlist"),
      React.createElement("p", null, "Tap Add to track your first ticker, or open any stock and tap “Add to watchlist”."))
    : visible.length === 0 ? React.createElement("div", { className: "empty wl-empty-sm" },
      React.createElement(Icon, { name: "eye", size: 32 }),
      React.createElement("p", null,
        (search.trim() || filterMarket !== 'all' || filterTag !== 'all')
          ? "No stocks match this filter."
          : (activeList === 'all' ? "Your watchlist is empty." : "This list is empty. Add a stock here, or open a stock and move it into this list.")))
    : React.createElement("div", { className: "watchlist-list mb-6" },
      visible.map((w) => {
        const q = prices[priceKey(w.market, w.ticker)];
        // No bare-ticker fallback: the ticker is already the card heading, so a
        // missing name should leave the subheading empty rather than repeat it.
        const displayName = w.name ? prettyName(w.name) : resolveTickerName(w.ticker, w.market, q);
        const isDragging = draggingId === w.id;
        let athBadge = null;
        if (q && q.yearHigh && q.yearHigh > 0) {
          const pct = (q.price - q.yearHigh) / q.yearHigh * 100;
          const atAth = q.price >= q.yearHigh * 0.995;
          athBadge = React.createElement("div", {
            className: `ath-badge ${atAth ? 'at-high' : 'below-high'}`
          }, React.createElement("span", { className: "ath-badge-label" }, "52W Hi"),
             React.createElement("span", { className: "ath-badge-val" }, atAth ? 'ATH' : pct.toFixed(1) + '%'));
        }
        const ac = alerts.filter(a => a.ticker === w.ticker && a.market === w.market).length;
        const hasDay = q && typeof q.changePct === 'number' && isFinite(q.changePct);
        const dayUp = hasDay && q.changePct >= 0;
        // Extended-hours chip lives in the card body (bottom-middle), lifted out
        // of the header price block so the price stays pinned to the right edge.
        const hasExt = q && q.extPrice != null && q.extChangePct != null;
        const extUp = hasExt && q.extChangePct >= 0;
        // Final (session-over) readings label as "After close" — the overnight
        // move stays on the card, but never masquerades as a live tape.
        const extFinal = hasExt && q.extLive === false;
        const extLabel = q && q.extKind === 'pre' ? 'Pre-market' : q && q.extKind === 'post' ? (extFinal ? 'After close' : 'After-hours') : '';
        const extSym = (MARKET_CURRENCY[w.market] || MARKET_CURRENCY.US).sym;
        const extChgAbs = hasExt && typeof q.extChange === 'number' && isFinite(q.extChange) ? q.extChange : null;
        return React.createElement("div", {
          key: w.id,
          ref: setCardRef(w.id),
          className: "swipe-card-outer" + (isDragging ? " dragging" : ""),
          onPointerDown: (e) => onCardPointerDown(e, w.id),
          onContextMenu: e => e.preventDefault()
        },
          React.createElement("div", { className: "swipe-delete-bg", onClick: () => confirmDelete(w.id) }, "Delete"),
          React.createElement("div", {
            className: "swipe-card-inner pos-card",
            ref: el => { if (el) swipeRefs.current.set(w.id, el); else swipeRefs.current.delete(w.id); },
            onClick: () => {
              if (suppressClickRef.current) { suppressClickRef.current = false; return; }
              if (dragRef.current) return;
              if (swipedId === w.id) { closeSwipe(w.id); return; }
              onOpenDetail(w.ticker, w.market);
            }
          },
            React.createElement("div", { className: "pos-head" },
              React.createElement("div", { className: "flex-1 wl-id" },
                React.createElement(LogoMark, { ticker: w.ticker, market: w.market }),
                React.createElement("div", { className: "wl-idtxt" },
                React.createElement("div", { className: "flex items-center gap-2" },
                  React.createElement("span", { className: "tkr" }, w.ticker),
                  React.createElement("span", { className: "market-badge" }, w.market),
                  activeList === 'all'
                    ? customListsOf(w).map(id => React.createElement("span", { key: id, className: "wl-card-list" }, listNameById(id))) : null),
                displayName ? React.createElement("div", { className: "tkr-name" }, displayName) : null)),
              // Stock price now sits top-right (swapped with the 52W high below).
              // The ext-hours chip is lifted out (hideExt) and shown in the body.
              React.createElement(PriceBlock, { quote: q, size: "lg", hideChange: true, hideExt: true, market: w.market })),
            React.createElement("div", { className: "watch-body" },
              // 52W high now sits bottom-left (swapped with the price), with the
              // alert bell directly beside it.
              athBadge,
              React.createElement("button", {
                className: "card-alert-bell",
                "data-no-drag": true,
                onClick: e => { e.stopPropagation(); openAlertPopup(w.ticker, w.market); },
                "aria-label": "Alerts"
              }, React.createElement(Icon, { name: "bell", size: 13 }),
                ac > 0 && React.createElement("span", { className: "card-alert-count" }, ac)),
              // Day's move (% only) anchored to the right of the card.
              hasDay
                ? React.createElement("div", { className: `watch-today ${dayUp ? 'up' : 'down'}` },
                    React.createElement("div", { className: "watch-today-pct mono" },
                      (dayUp ? '+' : '') + q.changePct.toFixed(2) + '%'))
                : React.createElement("div", { className: "watch-today" })),
            // Session badge (Open/Closed/Pre/After) so a quiet card reads as
            // market state, not blank. Shown only when the ext-price chip isn't.
            !hasExt && React.createElement("div", { className: "watch-ext" },
              React.createElement(SessionBadge, { market: w.market, quote: q })),
            // Pre/after-hours readout on its own centered line at the foot of the
            // card so it reads as a secondary detail without crowding the name.
            hasExt && React.createElement("div", { className: "watch-ext ext-hours" + (extFinal ? " ext-closed" : "") },
              React.createElement("span", { className: "ext-label" }, extLabel),
              React.createElement("span", { className: "ext-price mono" }, extSym, fmtNum(q.extPrice)),
              React.createElement("span", { className: `ext-chg mono ${extUp ? 'up' : 'down'}` },
                (extUp ? '+' : '') + q.extChangePct.toFixed(2) + '%' +
                (extChgAbs != null ? ' · ' + (extUp ? '+' : '-') + extSym + fmtNum(Math.abs(extChgAbs)) : '')))));
      })),

    alertPopup && React.createElement("div", { className: "alert-popup-overlay" },
      React.createElement("div", { className: "alert-popup-backdrop", onClick: () => setAlertPopup(null) }),
      React.createElement("div", { className: "alert-popup-panel" },
        React.createElement("div", { className: "alert-popup-header" },
          React.createElement("div", null,
            React.createElement("div", { className: "modal-title" }, alertPopup.ticker),
            React.createElement("div", { className: "modal-subtitle" }, "Price alerts \xB7 ", React.createElement("span", { className: "market-badge" }, alertPopup.market))),
          React.createElement("button", { className: "modal-close", onClick: () => setAlertPopup(null), "aria-label": "Close" },
            React.createElement(Icon, { name: "x" }))),
        popupAlerts.length > 0 && React.createElement("div", {
          style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }
        }, popupAlerts.map(a => React.createElement("div", {
          key: a.id, className: "alert-item"
        }, React.createElement("div", null,
          React.createElement("div", { className: "mono text-sm" },
            a.direction === 'above' ? '↑ above ' : '↓ below ', fmt(a.targetPrice, alertPopup.market)),
          a.note && React.createElement("div", { className: "text-xs text-dim mt-1" }, a.note)),
          React.createElement("button", {
            className: "btn btn-ghost btn-xs",
            onClick: () => onRemoveAlert(a.id), "aria-label": "Remove"
          }, React.createElement(Icon, { name: "x", size: 12 }))))),
        React.createElement("div", { className: "alert-form" },
          React.createElement("div", { className: "alert-dir-group", role: "radiogroup", "aria-label": "Trigger direction" },
            React.createElement("button", {
              type: "button", role: "radio", "aria-checked": alertDir === 'above',
              className: `alert-dir-btn up ${alertDir === 'above' ? 'active' : ''}`,
              onClick: () => setAlertDir('above')
            }, React.createElement("span", { className: "alert-dir-arrow" }, "↑"),
              React.createElement("span", { className: "alert-dir-label" }, "Above")),
            React.createElement("button", {
              type: "button", role: "radio", "aria-checked": alertDir === 'below',
              className: `alert-dir-btn down ${alertDir === 'below' ? 'active' : ''}`,
              onClick: () => setAlertDir('below')
            }, React.createElement("span", { className: "alert-dir-arrow" }, "↓"),
              React.createElement("span", { className: "alert-dir-label" }, "Below"))
          ),
          React.createElement("div", { className: "alert-target-row" },
            React.createElement("div", { className: "input-prefix-wrap alert-target-wrap" },
              React.createElement("span", { className: "prefix" }, popupCcy === 'ZAR' ? 'R' : '$'),
              React.createElement("input", {
                type: "text", inputMode: "decimal",
                autoComplete: "off", autoCorrect: "off", spellCheck: false,
                placeholder: "Target price", value: alertTarget,
                onChange: e => setAlertTarget(sanitizeDecimalInput(e.target.value)),
                className: "alert-target-input"
              }))),
          React.createElement("input", {
            type: "text", placeholder: "Note (optional)",
            value: alertNote, onChange: e => setAlertNote(e.target.value),
            maxLength: "80", className: "alert-note-input"
          }),
          React.createElement("button", {
            className: `btn btn-block mt-3 alert-submit ${alertDir === 'above' ? 'up' : 'down'}`,
            onClick: submitAlertPopup
          }, React.createElement(Icon, { name: "plus" }),
            " Alert when ", alertDir === 'above' ? 'above ' : 'below ',
            alertTarget && isFinite(parseDecimal(alertTarget)) ? (popupCcy === 'ZAR' ? 'R' : '$') + fmtNum(parseDecimal(alertTarget)) : 'target')))),

    React.createElement("div", { className: "eyebrow suggestions-head" },
      React.createElement("span", null, "Suggested for you"),
      React.createElement("button", {
        className: "btn btn-ghost btn-xs",
        onClick: () => setShowSuggestions(v => !v),
        'aria-label': showSuggestions ? "Hide suggestions" : "Show suggestions"
      }, showSuggestions ? "Hide" : "Show")),
    showSuggestions && (suggestions.hot.length === 0 && suggestions.more.length === 0 && justAdded.length === 0
      ? React.createElement("div", { className: "text-sm text-dim" }, "No more suggestions — you're tracking the popular names already.")
      : React.createElement(React.Fragment, null,
          justAdded.length > 0 && React.createElement("div", { className: "chip-row" },
            justAdded.map(s => React.createElement("div", {
              key: 'added:' + priceKey(s.market, s.ticker),
              className: "chip added"
            }, React.createElement(Icon, { name: "checkCircle", size: 13 }),
               " ", s.ticker, React.createElement("span", { className: "chip-sub" }, "Added to watchlist")))),
          // Live movers the user doesn't hold/track yet — flame header, and each
          // chip carries the day's % so "hot" is visible at a glance.
          suggestions.hot.length > 0 && React.createElement("div", { className: "sug-sub" },
            React.createElement(Icon, { name: "flame", size: 12, className: "sug-sub-flame" }), "Hot right now"),
          suggestions.hot.length > 0 && React.createElement("div", { className: "chip-row" },
            suggestions.hot.map(s => React.createElement("button", {
              key: priceKey(s.market, s.ticker),
              className: "chip chip-hot",
              onClick: () => addSuggestion(s)
            }, React.createElement(Icon, { name: "plus", size: 12, className: "chip-plus" }),
               " ", s.ticker,
               s.changePct != null && React.createElement("span", { className: "chip-pct " + (s.changePct >= 0 ? "up" : "down") },
                 (s.changePct >= 0 ? "+" : "") + s.changePct.toFixed(1) + "%"),
               React.createElement("span", { className: "chip-sub" }, s.name, " \xB7 ", s.market)))),
          suggestions.more.length > 0 && suggestions.hot.length > 0 && React.createElement("div", { className: "sug-sub" }, "For you"),
          suggestions.more.length > 0 && React.createElement("div", { className: "chip-row" },
            suggestions.more.map(s => React.createElement("button", {
              key: priceKey(s.market, s.ticker),
              className: "chip",
              onClick: () => addSuggestion(s)
            }, React.createElement(Icon, { name: "plus", size: 12, className: "chip-plus" }),
               " ", s.ticker, React.createElement("span", { className: "chip-sub" }, s.name, " \xB7 ", s.market))))))
  );
}

function fmtShares(n) {
  if (n == null || !isFinite(n)) return '';
  if (n >= 100) return n.toFixed(0);
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}
// ─── TFSA limits + South-African tax-year helpers ───────────────────────────
// A TFSA's contribution room is governed by the SA tax year (1 March – end Feb),
// not the calendar year, so "this year's" R46k bar must bucket deposits by tax
// year. Dates are stored as local YYYY-MM-DD strings and parsed by splitting the
// string (never Date→toISOString, which would shift a day for SAST users).
const TFSA_ANNUAL_LIMIT = 46000;
const TFSA_LIFETIME_LIMIT = 500000;
function tfsaTaxYearStart(dateStr) {
  if (!dateStr) return null;
  const parts = String(dateStr).split('-');
  const y = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
  if (!isFinite(y) || !isFinite(m)) return null;
  return m < 3 ? y - 1 : y; // Jan/Feb fall in the tax year that began the prior March
}
function currentTfsaTaxYearStart() {
  const d = new Date();
  return (d.getMonth() + 1) < 3 ? d.getFullYear() - 1 : d.getFullYear();
}
function tfsaTaxYearLabel(startYear) {
  return startYear + '/' + String(startYear + 1).slice(2); // e.g. 2026/27
}
function tfsaTodayStr() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function fmtRand(n, dec) {
  const d = dec == null ? 0 : dec;
  return 'R' + Math.abs(n).toLocaleString('en-ZA', { minimumFractionDigits: d, maximumFractionDigits: d });
}
// Generic collapsible "dropdown" card — a tap-to-expand header over hidden body.
// Used for the contribution planner and the TFSA-information panel.
function Collapsible({ title, subtitle, icon, defaultOpen, badge, children, className }) {
  const { Icon } = window.PBApp;
  const [open, setOpen] = useState(!!defaultOpen);
  return React.createElement("div", { className: "card collapse-card mb-4" + (className ? " " + className : "") },
    React.createElement("button", {
      className: "collapse-head", onClick: () => setOpen(o => !o), "aria-expanded": open, type: "button"
    },
      React.createElement("div", { className: "collapse-head-main" },
        icon ? React.createElement(Icon, { name: icon, size: 15 }) : null,
        React.createElement("div", { className: "collapse-head-text" },
          React.createElement("div", { className: "collapse-title" }, title),
          subtitle ? React.createElement("div", { className: "collapse-sub" }, subtitle) : null
        )
      ),
      React.createElement("div", { className: "collapse-head-right" },
        badge != null ? React.createElement("span", { className: "collapse-badge" }, badge) : null,
        React.createElement(Icon, { name: "chevron", size: 16, className: "collapse-chevron" + (open ? " open" : "") })
      )
    ),
    open ? React.createElement("div", { className: "collapse-body" }, children) : null
  );
}
// Annual (R46k) + lifetime (R500k) contribution bars over an editable deposit log.
// The log mixes manual deposits (cash the user reports putting in) with purchase
// entries auto-appended on every in-app TFSA buy; both count toward the limits and
// both can be edited or removed to fix mistakes/double-counts.
function TFSAContributions({ deposits, onAdd, onUpdate, onRemove, onRemoveMany }) {
  const { Icon } = window.PBApp;
  const [adding, setAdding] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(() => ({ amount: '', date: tfsaTodayStr(), note: '' }));
  const [editForm, setEditForm] = useState({ amount: '', date: '', note: '' });
  // Multi-select mode for the deposit log: lets the user tick several entries
  // (e.g. "everything from this tax year") and delete them in one go, which
  // recomputes both the annual and lifetime counters.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);

  const list = deposits || [];
  const curStart = currentTfsaTaxYearStart();
  const annualUsed = list.reduce((s, d) => s + (tfsaTaxYearStart(d.date) === curStart ? (d.amount || 0) : 0), 0);
  const lifetimeUsed = list.reduce((s, d) => s + (d.amount || 0), 0);
  const annualPct = annualUsed / TFSA_ANNUAL_LIMIT * 100;
  const lifePct = lifetimeUsed / TFSA_LIFETIME_LIMIT * 100;
  const annualLeft = TFSA_ANNUAL_LIMIT - annualUsed;
  const lifeLeft = TFSA_LIFETIME_LIMIT - lifetimeUsed;
  const yearsLeft = lifeLeft > 0 ? Math.ceil(lifeLeft / TFSA_ANNUAL_LIMIT) : 0;

  const submitAdd = () => {
    const amt = parseFloat(form.amount);
    if (!isFinite(amt) || amt === 0 || !form.date) return;
    onAdd(amt, form.date, form.note);
    setForm({ amount: '', date: tfsaTodayStr(), note: '' });
    setAdding(false);
    setLogOpen(true);
  };
  const startEdit = (d) => {
    setEditId(d.id);
    setEditForm({ amount: String(d.amount), date: d.date, note: d.note || '' });
  };
  const submitEdit = () => {
    const amt = parseFloat(editForm.amount);
    if (!isFinite(amt) || amt === 0 || !editForm.date) return;
    onUpdate(editId, { amount: amt, date: editForm.date, note: editForm.note });
    setEditId(null);
  };

  // ── Multi-select helpers ──
  const sorted = list.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const selectedSet = new Set(selectedIds);
  const selectedTotal = list.reduce((s, d) => s + (selectedSet.has(d.id) ? (d.amount || 0) : 0), 0);
  const toggleSel = (id) => setSelectedIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  const selectThisYear = () => setSelectedIds(list.filter(d => tfsaTaxYearStart(d.date) === curStart).map(d => d.id));
  const selectAll = () => setSelectedIds(list.map(d => d.id));
  const clearSel = () => setSelectedIds([]);
  const enterSelect = () => { setSelectMode(true); setLogOpen(true); setAdding(false); setEditId(null); setSelectedIds([]); };
  const exitSelect = () => { setSelectMode(false); setSelectedIds([]); };
  const deleteSelected = () => {
    if (selectedIds.length === 0) return;
    const n = selectedIds.length;
    if (window.confirm(`Remove ${n} deposit${n === 1 ? '' : 's'} (${fmtRand(selectedTotal, 2)}) from your tax-year and lifetime totals?`)) {
      if (onRemoveMany) onRemoveMany(selectedIds);
      else selectedIds.forEach(id => onRemove(id));
      exitSelect();
    }
  };

  const bar = (label, yr, used, limit, pct, leftEl) => React.createElement("div", { className: "tfsa-limit" },
    React.createElement("div", { className: "tfsa-limit-top" },
      React.createElement("div", { className: "tfsa-limit-label" },
        React.createElement("span", null, label),
        yr ? React.createElement("span", { className: "tfsa-limit-yr" }, yr) : null),
      React.createElement("div", { className: "tfsa-limit-fig" },
        React.createElement("span", { className: "tfsa-limit-used" }, fmtRand(used)),
        React.createElement("span", { className: "tfsa-limit-of" }, " / ", fmtRand(limit)))),
    React.createElement("div", { className: "tfsa-limit-bar" },
      React.createElement("div", {
        className: "tfsa-limit-fill" + (used > limit ? " over" : (pct >= 90 ? " near" : "")),
        style: { width: Math.min(100, Math.max(used > 0 ? 1.5 : 0, pct)) + "%" }
      })),
    leftEl);

  const addForm = adding ? React.createElement("div", { className: "tfsa-dep-form" },
    React.createElement("div", { className: "tfsa-dep-fields" },
      React.createElement("div", { className: "tfsa-dep-field" },
        React.createElement("label", null, "Amount"),
        React.createElement("div", { className: "tfsa-dep-amt" },
          React.createElement("span", null, "R"),
          React.createElement("input", {
            type: "number", inputMode: "decimal", min: "0", step: "100", autoFocus: true,
            value: form.amount, placeholder: "0",
            onChange: e => setForm(f => ({ ...f, amount: e.target.value })),
            onKeyDown: e => { if (e.key === 'Enter') submitAdd(); }
          }))),
      React.createElement("div", { className: "tfsa-dep-field" },
        React.createElement("label", null, "Date"),
        React.createElement("input", { type: "date", value: form.date, onChange: e => setForm(f => ({ ...f, date: e.target.value })) }))),
    React.createElement("div", { className: "tfsa-dep-field" },
      React.createElement("label", null, "Note (optional)"),
      React.createElement("input", { type: "text", value: form.note, placeholder: "e.g. EFT from Capitec", onChange: e => setForm(f => ({ ...f, note: e.target.value })) })),
    React.createElement("div", { className: "tfsa-dep-form-actions" },
      React.createElement("button", { className: "btn btn-ghost btn-sm", type: "button", onClick: () => { setAdding(false); setForm({ amount: '', date: tfsaTodayStr(), note: '' }); } }, "Cancel"),
      React.createElement("button", { className: "btn btn-primary btn-sm", type: "button", onClick: submitAdd }, "Save deposit"))
  ) : null;

  // Toolbar atop the open log: in normal mode a "Select" entry point; in select
  // mode the running count/total plus quick selectors for this tax year / all.
  const logToolbar = list.length === 0 ? null : React.createElement("div", { className: "tfsa-dep-log-bar" },
    selectMode
      ? React.createElement(React.Fragment, null,
          React.createElement("div", { className: "tfsa-dep-sel-info" },
            React.createElement("span", { className: "tfsa-dep-sel-count" }, selectedIds.length, " selected"),
            selectedIds.length > 0 ? React.createElement("span", { className: "tfsa-dep-sel-sum" }, fmtRand(selectedTotal, 2)) : null),
          React.createElement("div", { className: "tfsa-dep-sel-quick" },
            React.createElement("button", { className: "tfsa-dep-sel-link", type: "button", onClick: selectThisYear }, "This tax year"),
            React.createElement("button", { className: "tfsa-dep-sel-link", type: "button", onClick: selectAll }, "All"),
            selectedIds.length > 0 ? React.createElement("button", { className: "tfsa-dep-sel-link", type: "button", onClick: clearSel }, "Clear") : null))
      : React.createElement(React.Fragment, null,
          React.createElement("span", { className: "tfsa-dep-log-title" }, "Logged deposits"),
          React.createElement("button", { className: "tfsa-dep-sel-link", type: "button", onClick: enterSelect },
            React.createElement(Icon, { name: "check", size: 12 }), " Select")));

  const logBody = logOpen ? React.createElement("div", { className: "tfsa-dep-log" },
    list.length === 0
      ? React.createElement("div", { className: "tfsa-dep-empty" }, "No deposits logged yet.")
      : React.createElement(React.Fragment, null,
        logToolbar,
        sorted.map(d => {
          if (!selectMode && editId === d.id) {
            return React.createElement("div", { className: "tfsa-dep-row editing", key: d.id },
              React.createElement("div", { className: "tfsa-dep-edit-fields" },
                React.createElement("div", { className: "tfsa-dep-amt" },
                  React.createElement("span", null, "R"),
                  React.createElement("input", { type: "number", inputMode: "decimal", step: "100", value: editForm.amount, onChange: e => setEditForm(f => ({ ...f, amount: e.target.value })) })),
                React.createElement("input", { type: "date", value: editForm.date, onChange: e => setEditForm(f => ({ ...f, date: e.target.value })) })),
              React.createElement("input", { className: "tfsa-dep-edit-note", type: "text", value: editForm.note, placeholder: "Note", onChange: e => setEditForm(f => ({ ...f, note: e.target.value })) }),
              React.createElement("div", { className: "tfsa-dep-form-actions" },
                React.createElement("button", { className: "btn btn-ghost btn-sm", type: "button", onClick: () => setEditId(null) }, "Cancel"),
                React.createElement("button", { className: "btn btn-primary btn-sm", type: "button", onClick: submitEdit }, "Save")));
          }
          const inYear = tfsaTaxYearStart(d.date) === curStart;
          const checked = selectedSet.has(d.id);
          const main = React.createElement("div", { className: "tfsa-dep-main" },
            React.createElement("div", { className: "tfsa-dep-line1" },
              React.createElement("span", { className: "tfsa-dep-amount" }, "+", fmtRand(d.amount, 2)),
              React.createElement("span", { className: "tfsa-dep-tag " + (d.source === 'purchase' ? "buy" : "manual") }, d.source === 'purchase' ? "Buy" : "Deposit"),
              inYear ? null : React.createElement("span", { className: "tfsa-dep-tag past" }, tfsaTaxYearLabel(tfsaTaxYearStart(d.date)))),
            React.createElement("div", { className: "tfsa-dep-line2" },
              React.createElement("span", null, d.date ? new Date(d.date + 'T00:00:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : ''),
              d.note ? React.createElement("span", { className: "tfsa-dep-note" }, " · ", d.note) : null));
          if (selectMode) {
            return React.createElement("div", {
              className: "tfsa-dep-row selectable" + (checked ? " selected" : ""), key: d.id,
              role: "button", "aria-pressed": checked, onClick: () => toggleSel(d.id)
            },
              React.createElement("span", { className: "tfsa-dep-check" + (checked ? " on" : "") },
                checked ? React.createElement(Icon, { name: "check", size: 13 }) : null),
              main);
          }
          return React.createElement("div", { className: "tfsa-dep-row", key: d.id },
            main,
            React.createElement("div", { className: "tfsa-dep-row-actions" },
              React.createElement("button", { className: "icon-btn", type: "button", "aria-label": "Edit", onClick: () => startEdit(d) }, React.createElement(Icon, { name: "edit", size: 13 })),
              React.createElement("button", { className: "icon-btn", type: "button", "aria-label": "Remove", onClick: () => { if (window.confirm('Remove this deposit from your contribution total?')) onRemove(d.id); } }, React.createElement(Icon, { name: "trash", size: 13 }))));
        }),
        selectMode ? React.createElement("div", { className: "tfsa-dep-sel-actions" },
          React.createElement("button", { className: "btn btn-ghost btn-sm", type: "button", onClick: exitSelect }, "Cancel"),
          React.createElement("button", { className: "btn btn-danger btn-sm", type: "button", disabled: selectedIds.length === 0, onClick: deleteSelected },
            React.createElement(Icon, { name: "trash", size: 13 }), " Delete", selectedIds.length ? " (" + selectedIds.length + ")" : "")) : null)
  ) : null;

  return React.createElement("div", { className: "tfsa-room-inner" },
    bar("This tax year", tfsaTaxYearLabel(curStart), annualUsed, TFSA_ANNUAL_LIMIT, annualPct,
      React.createElement("div", { className: "tfsa-limit-sub" + (annualLeft < 0 ? " warn" : "") },
        annualLeft >= 0 ? fmtRand(annualLeft) + " left this tax year" : fmtRand(-annualLeft) + " over the annual limit (40% penalty applies)")),
    bar("Lifetime", null, lifetimeUsed, TFSA_LIFETIME_LIMIT, lifePct,
      React.createElement("div", { className: "tfsa-limit-sub" + (lifeLeft <= 0 ? " ok" : "") },
        lifeLeft > 0
          ? fmtRand(lifeLeft) + " left · ≈ " + yearsLeft + (yearsLeft === 1 ? " year" : " years") + " at the max to fill it"
          : "Lifetime limit reached")),
    React.createElement("div", { className: "tfsa-room-actions" },
      React.createElement("button", { className: "btn btn-primary btn-sm", type: "button", onClick: () => { setAdding(a => !a); setEditId(null); } },
        React.createElement(Icon, { name: "plus", size: 13 }), " Log deposit"),
      React.createElement("button", { className: "btn btn-secondary btn-sm", type: "button", onClick: () => setLogOpen(o => !o) },
        React.createElement(Icon, { name: "list", size: 13 }), " Deposit log (", list.length, ")")),
    addForm,
    logBody,
    React.createElement("div", { className: "tfsa-room-hint" },
      "Buys you make in the app are added here automatically. Log a deposit only for cash added before or outside the app.")
  );
}
// TFSA contribution planner / portfolio balancer.
// The user defines a target structure (a % per holding); each month they enter
// how much they'll contribute and the planner says exactly how many rand (and
// ≈shares) to put into each holding to steer the portfolio toward that structure
// — using only the new contribution, never selling. The split fills the most
// underweight holdings first; any surplus beyond what's needed to reach target
// is spread across holdings by target weight so the structure keeps holding.
function TFSABalancer({ positions, onBuyPosition }) {
  const { Icon, fmt, prettyName } = window.PBApp;
  const prices = PBStore.usePricesMap();
  // Durable user-entered planning data, so these live in PORTFOLIO_SCHEMA rather than
  // raw usePersistedState (which is for view-local UI state only). PORTFOLIO_SCHEMA and
  // not SETTINGS_SCHEMA because setTarget below passes an UPDATER FN, which
  // setCollection accepts and setSetting does not. Same keys + same stored shapes as
  // before, so cloud backup is unchanged.
  const targets = PBStore.useCollection('tfsaTargets');
  const setTargets = v => PBStore.setCollection('tfsaTargets', v);
  const contribution = PBStore.useCollection('tfsaContribution');
  const setContribution = v => PBStore.setCollection('tfsaContribution', v);
  const [editing, setEditing] = useState(false);

  const rows = positions.map(p => {
    const q = prices['TFSA:' + p.ticker];
    const price = q && q.price > 0 ? q.price : p.costBasis;
    return { id: p.id, ticker: p.ticker, name: p.name, shares: p.shares, price, value: p.shares * price, pos: p };
  });
  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  const targetSum = rows.reduce((s, r) => s + (parseFloat(targets[r.ticker]) || 0), 0);
  const hasTargets = targetSum > 0;
  const showEditor = editing || !hasTargets;

  // Keep the editor open through edits — once targets exist it would otherwise
  // collapse mid-typing (showEditor depends on hasTargets). It only closes on Done.
  const setTarget = (tk, v) => { setEditing(true); setTargets(prev => ({ ...prev, [tk]: v })); };
  const useCurrentWeights = () => {
    if (totalValue <= 0) return;
    const next = {}; rows.forEach(r => { next[r.ticker] = (r.value / totalValue * 100).toFixed(1); });
    setEditing(true); setTargets(next);
  };
  const useEqualWeight = () => {
    const each = (100 / (rows.length || 1)).toFixed(1);
    const next = {}; rows.forEach(r => { next[r.ticker] = each; });
    setEditing(true); setTargets(next);
  };

  // ── Allocate the contribution: fill underweight holdings first, spread any
  //    surplus by target weight. Pure new-cash rebalancing (no sells). ──
  const C = Math.max(0, parseFloat(contribution) || 0);
  const newTotal = totalValue + C;
  const plan = rows.map(r => {
    const w = hasTargets ? (parseFloat(targets[r.ticker]) || 0) / targetSum : 0;
    const desired = w * newTotal;
    return { ...r, w, targetPct: w * 100, curPct: totalValue > 0 ? r.value / totalValue * 100 : 0, desired, gap: Math.max(0, desired - r.value) };
  });
  const totalGap = plan.reduce((s, r) => s + r.gap, 0);
  const allocMap = {};
  if (C > 0 && hasTargets) {
    if (totalGap >= C && totalGap > 0) plan.forEach(r => { allocMap[r.ticker] = C * (r.gap / totalGap); });
    else { const leftover = C - totalGap; plan.forEach(r => { allocMap[r.ticker] = r.gap + r.w * leftover; }); }
  }
  plan.forEach(r => {
    r.alloc = allocMap[r.ticker] || 0;
    r.afterValue = r.value + r.alloc;
    r.afterPct = newTotal > 0 ? r.afterValue / newTotal * 100 : 0;
    r.sharesBuy = r.price > 0 ? r.alloc / r.price : null;
  });
  const scaleMax = Math.max(1, ...plan.map(r => Math.max(r.targetPct, r.afterPct, r.curPct)));
  const planSorted = plan.slice().sort((a, b) => b.alloc - a.alloc || b.targetPct - a.targetPct);
  const totalAlloc = plan.reduce((s, r) => s + r.alloc, 0);

  // The Collapsible wrapper supplies the "Contribution planner" title, so the
  // balancer only needs an inline Edit/Done toggle for the target weights.
  const header = hasTargets ? React.createElement("div", { className: "tfsa-bal-toolbar" },
    React.createElement("div", { className: "tfsa-bal-toolbar-label" }, "Target weights"),
    React.createElement("button", { className: "btn btn-secondary btn-sm", type: "button", onClick: () => setEditing(e => !e) },
      React.createElement(Icon, { name: editing ? "check" : "edit", size: 13 }), " ", editing ? "Done" : "Edit")
  ) : null;

  const sumClass = Math.abs(targetSum - 100) < 0.1 ? 'ok' : 'warn';
  const editor = showEditor ? React.createElement("div", { className: "tfsa-target-editor" },
    React.createElement("div", { className: "tfsa-target-list" },
      rows.map(r => React.createElement("div", { className: "tfsa-target-row", key: r.id },
        React.createElement("div", { className: "tfsa-target-id" },
          React.createElement("span", { className: "tkr" }, r.ticker),
          r.name ? React.createElement("span", { className: "tfsa-target-name text-dim" }, prettyName(r.name)) : null
        ),
        React.createElement("div", { className: "tfsa-target-input" },
          React.createElement("input", {
            type: "number", inputMode: "decimal", min: "0", max: "100", step: "0.5",
            value: targets[r.ticker] != null ? targets[r.ticker] : '',
            placeholder: "0",
            onChange: e => setTarget(r.ticker, e.target.value)
          }),
          React.createElement("span", { className: "tfsa-target-pct" }, "%")
        )
      ))
    ),
    React.createElement("div", { className: "tfsa-bal-quick" },
      React.createElement("button", { className: "tfsa-preset-btn", type: "button", onClick: useCurrentWeights },
        React.createElement(Icon, { name: "activity", size: 13 }), " Use current %"),
      React.createElement("button", { className: "tfsa-preset-btn", type: "button", onClick: useEqualWeight },
        React.createElement(Icon, { name: "gauge", size: 13 }), " Equal weight"),
      React.createElement("span", { className: `tfsa-sum ${sumClass}` }, "Total ", targetSum.toFixed(1), "%")
    ),
    targetSum > 0 && Math.abs(targetSum - 100) >= 0.1 ? React.createElement("div", { className: "tfsa-bal-note" },
      "Targets total ", targetSum.toFixed(1), "% — used as relative weights. Set them to 100% for clarity.") : null
  ) : null;

  const contribInput = React.createElement("div", { className: "tfsa-contrib" },
    React.createElement("label", { className: "tfsa-contrib-label" }, "This month's contribution"),
    React.createElement("div", { className: "tfsa-contrib-field" },
      React.createElement("span", { className: "tfsa-contrib-sym" }, "R"),
      React.createElement("input", {
        type: "number", inputMode: "decimal", min: "0", step: "100",
        value: contribution, placeholder: "0",
        onChange: e => setContribution(e.target.value)
      })
    )
  );

  let planBody;
  if (!hasTargets) {
    planBody = React.createElement("div", { className: "tfsa-bal-empty" }, "Set a target % for your holdings above to get a monthly plan.");
  } else {
    planBody = React.createElement(React.Fragment, null,
      C > 0 ? React.createElement("div", { className: "tfsa-plan-head" },
        React.createElement("span", null, "Buy this month"),
        React.createElement("span", { className: "mono" }, fmt(totalAlloc, 'TFSA'))
      ) : React.createElement("div", { className: "tfsa-bal-empty" }, "Enter a contribution to see exactly what to buy — current vs target is shown below."),
      React.createElement("div", { className: "tfsa-plan-list" },
        planSorted.map(r => {
          const buying = r.alloc > 0.005;
          const over = !buying && r.curPct > r.targetPct + 0.1;
          const curW = Math.max(0, Math.min(100, r.curPct / scaleMax * 100));
          const addW = Math.max(0, Math.min(100 - curW, (r.afterPct - r.curPct) / scaleMax * 100));
          const tgtW = Math.max(0, Math.min(100, r.targetPct / scaleMax * 100));
          return React.createElement("div", { className: "tfsa-plan-row", key: r.id },
            React.createElement("div", { className: "tfsa-plan-top" },
              React.createElement("div", { className: "tfsa-plan-id" },
                React.createElement("span", { className: "tkr" }, r.ticker),
                r.name ? React.createElement("span", { className: "tfsa-plan-name text-dim" }, prettyName(r.name)) : null
              ),
              buying
                ? React.createElement("div", { className: "tfsa-plan-action" },
                    React.createElement("span", { className: "tfsa-buy-amt" }, fmt(r.alloc, 'TFSA')),
                    r.sharesBuy != null ? React.createElement("span", { className: "tfsa-buy-sh" }, "≈ ", fmtShares(r.sharesBuy), " sh") : null
                  )
                : React.createElement("span", { className: `tfsa-plan-tag ${over ? 'over' : 'ok'}` }, over ? "Overweight" : "On target")
            ),
            React.createElement("div", { className: "tfsa-plan-bar" },
              React.createElement("div", { className: "tfsa-plan-fill", style: { width: curW + '%' } }),
              addW > 0 ? React.createElement("div", { className: "tfsa-plan-add", style: { left: curW + '%', width: addW + '%' } }) : null,
              React.createElement("div", { className: "tfsa-plan-target", style: { left: tgtW + '%' } })
            ),
            React.createElement("div", { className: "tfsa-plan-meta" },
              React.createElement("span", null, "Target ", r.targetPct.toFixed(1), "% · now ", r.curPct.toFixed(1), "%",
                C > 0 ? React.createElement(React.Fragment, null, " → ",
                  React.createElement("span", { className: buying ? "text-up" : "" }, r.afterPct.toFixed(1), "%")) : null),
              onBuyPosition && buying ? React.createElement("button", { className: "tfsa-plan-buy", onClick: () => onBuyPosition(r.pos) }, "Buy") : null
            )
          );
        })
      )
    );
  }

  return React.createElement("div", { className: "tfsa-bal-inner" }, header, editor, contribInput, planBody);
}
function TFSAView({ positions, onOpenDetail, onAddPosition, onEditPosition, onBuyPosition, onSellPosition,
                   tfsaDeposits, onAddTfsaDeposit, onUpdateTfsaDeposit, onRemoveTfsaDeposit, onRemoveTfsaDeposits,
                   fxRates, sectorCache, fundamentals, sectorWeights, onSetSectorWeights }) {
  const { Icon } = window.PBApp;
  const prices = PBStore.usePricesMap();
  const valueHidden = PBStore.useSetting('valueHidden');
  const totalValue = positions.reduce((s, p) => {
    const q = prices['TFSA:' + p.ticker];
    return s + (q ? p.shares * q.price : p.shares * p.costBasis);
  }, 0);
  const totalCost = positions.reduce((s, p) => s + p.shares * p.costBasis, 0);
  const pnl = totalValue - totalCost;
  const pnlPct = totalCost > 0 ? pnl / totalCost * 100 : 0;
  const hasPositions = positions.length > 0;
  const deposits = tfsaDeposits || [];
  const curStart = currentTfsaTaxYearStart();
  const annualUsed = deposits.reduce((s, d) => s + (tfsaTaxYearStart(d.date) === curStart ? (d.amount || 0) : 0), 0);
  // Holdings listed largest position first (mirrors the Holdings tab's default
  // value sort), falling back to cost when there's no live quote yet.
  const tfsaHoldingValue = (p) => {
    const q = prices['TFSA:' + p.ticker];
    return q ? p.shares * q.price : p.shares * p.costBasis;
  };
  const sortedPositions = [...positions].sort((a, b) => tfsaHoldingValue(b) - tfsaHoldingValue(a));

  // ── 1. TFSA holdings — graph + account value/cost/P/L, first in the tab ──
  const holdingsCard = hasPositions ? React.createElement("div", { className: "card mb-4" },
    React.createElement("div", { className: "eyebrow", style: { marginBottom: 12 } }, "TFSA holdings"),
    React.createElement(PortfolioPieChart, {
      positions, displayCurrency: 'ZAR', fxRates,
      onOpenDetail, sectorCache, fundamentals, sectorWeights, onSetSectorWeights, availableModes: ['ticker', 'sector']
    }),
    React.createElement("div", { className: "kv-row tfsa-holdings-stats" },
      React.createElement("div", { className: "kv" },
        React.createElement("div", { className: "kv-label" }, "Value"),
        React.createElement("div", { className: "kv-val mono" + (valueHidden ? " val-blur" : "") }, fmtRand(totalValue, 2))),
      React.createElement("div", { className: "kv" },
        React.createElement("div", { className: "kv-label" }, "Cost"),
        React.createElement("div", { className: "kv-val mono" + (valueHidden ? " val-blur" : "") }, fmtRand(totalCost, 2))),
      React.createElement("div", { className: "kv" },
        React.createElement("div", { className: "kv-label" }, "P/L"),
        // Currency amount stays the prominent figure; the % rides below it as a
        // smaller tinted pill, mirroring the dashboard's green return boxes.
        React.createElement("div", { className: "tfsa-pnl-val" },
          React.createElement("span", { className: `kv-val mono ${pnl >= 0 ? 'text-up' : 'text-down'}` + (valueHidden ? " val-blur" : "") },
            (pnl >= 0 ? '+' : '−') + fmtRand(pnl, 2)),
          React.createElement("span", { className: `tfsa-pnl-pct ${pnlPct >= 0 ? 'up' : 'down'}` },
            (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(1) + "%"))))
  ) : null;

  // ── TFSA information — collapsible, the rules only (value/cost/P/L now live in
  //    the holdings card) ──
  const infoPanel = React.createElement(Collapsible, {
    title: "TFSA information", subtitle: "How the tax-free account works", icon: "list"
  },
    React.createElement("ul", { className: "bullet-list" },
      React.createElement("li", null, React.createElement("span", null, fmtRand(TFSA_ANNUAL_LIMIT), " annual contribution limit (per tax year, 1 Mar – end Feb)")),
      React.createElement("li", null, React.createElement("span", null, fmtRand(TFSA_LIFETIME_LIMIT), " lifetime contribution limit")),
      React.createElement("li", null, React.createElement("span", null, "All gains, dividends, and interest are ", React.createElement("strong", null, "tax-free"))),
      React.createElement("li", null, React.createElement("span", null, "Only JSE-listed equities, ETFs, and unit trusts are eligible")),
      React.createElement("li", null, React.createElement("span", null, "Withdrawals reduce available contribution room permanently")),
      React.createElement("li", null, React.createElement("span", null, "40% penalty on contributions exceeding the annual limit")))
  );

  return React.createElement("div", null,
    holdingsCard,
    // ── 2. Holdings list — collapsed into a dropdown so the tab stays compact ──
    !hasPositions
      ? React.createElement(React.Fragment, null,
          React.createElement("div", { className: "flex justify-between items-center mb-3" },
            React.createElement("div", { className: "eyebrow", style: { marginBottom: 0 } }, "Your holdings"),
            React.createElement("button", { className: "btn btn-primary btn-xs", onClick: onAddPosition },
              React.createElement(Icon, { name: "plus", size: 12 }), " Add")),
          React.createElement("div", { className: "empty empty-tfsa mb-4" },
            React.createElement(Icon, { name: "briefcase", size: 40 }),
            React.createElement("h3", null, "No TFSA holdings"),
            React.createElement("p", null, "Add JSE-listed ETFs and equities for your Tax-Free Savings Account (or use Import on the Holdings tab).")))
      : React.createElement(Collapsible, {
          title: "Your holdings", icon: "briefcase", defaultOpen: true, badge: positions.length
        },
          React.createElement("div", { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 10 } },
            React.createElement("button", { className: "btn btn-primary btn-xs", onClick: onAddPosition },
              React.createElement(Icon, { name: "plus", size: 12 }), " Add holding")),
          React.createElement(HoldingsListHead, null),
          React.createElement("div", { className: "row-list" },
          sortedPositions.map(p => React.createElement(HoldingRow, {
            key: p.id,
            position: p,
            market: 'TFSA',
            quote: prices['TFSA:' + p.ticker],
            onOpenDetail: onOpenDetail,
            onBuyPosition: onBuyPosition,
            onSellPosition: onSellPosition,
            onEditPosition: onEditPosition
          })))),
    // ── 3. Contribution planner — collapsible dropdown ──
    hasPositions ? React.createElement("div", { style: { marginTop: 16 } },
      React.createElement(Collapsible, {
        title: "Contribution planner", subtitle: "What to buy each month to hold your structure", icon: "gauge"
      }, React.createElement(TFSABalancer, { positions: positions, onBuyPosition: onBuyPosition }))
    ) : null,
    // ── 4. Contribution room — annual + lifetime bars + deposit log, now a
    //    collapsible dropdown sitting under the planner ──
    React.createElement(Collapsible, {
      title: "Contribution room", icon: "activity",
      subtitle: fmtRand(annualUsed) + " of " + fmtRand(TFSA_ANNUAL_LIMIT) + " used this tax year"
    }, React.createElement(TFSAContributions, {
      deposits: deposits,
      onAdd: onAddTfsaDeposit, onUpdate: onUpdateTfsaDeposit, onRemove: onRemoveTfsaDeposit,
      onRemoveMany: onRemoveTfsaDeposits
    })),
    // ── 5. TFSA information — collapsible at the bottom ──
    infoPanel
  );
}

// ─── Allocation donut (PortfolioPieChart) + its SectorHoldingsPopup — moved from app.js
//     (Phase 4 inc 30). The donut colour scales below are private to the chart. PPC reads
//     resolvePositionSector/positionDisplayName/MARKET_LABELS/Icon from the PBApp bridge and
//     SectorAllocationModal from PBModals at render time (pb-modals.js loads after us).
// ── Donut palettes ──────────────────────────────────────────────────────────
// The allocation donut offers two colour scales (Settings → Appearance), each
// generated to exactly N distinct stops so every holding gets its own colour at
// any portfolio size — no recycling once a list outgrows a fixed array.
function _donutHexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function _donutRgbToHex(r, g, b) {
  const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
function _donutHslToHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h / 30) % 12;
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return _donutRgbToHex(f(0), f(8), f(4));
}
// "Indigo" — the logo's periwinkle → indigo → blue → cyan family, sampled
// smoothly across however many holdings are shown. Stays on-brand at any size.
const DONUT_INDIGO_ANCHORS = ['#8A7BF2', '#6E6EF0', '#5A6FE6', '#4F86DC', '#4F9BCF', '#5AAFC2'];
function donutIndigoPalette(n) {
  if (n <= 0) return [];
  if (n === 1) return [DONUT_INDIGO_ANCHORS[1]];
  const A = DONUT_INDIGO_ANCHORS, segs = A.length - 1, out = [];
  // With only a few wedges a smooth indigo ramp reads as nearly one colour, so
  // stretch its tonal range when the list is short: darken the low end and
  // brighten the high end (a lift that runs −1→+1 across the list), with an
  // amount that fades out by ~12 wedges. Each step then becomes a clearly bigger
  // jump while staying in the same family. Indigo scale only.
  const stretch = Math.max(0, (12 - n) / 10); // ~1 at n=2 → 0 at n>=12
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1) * segs;
    const k = Math.min(segs - 1, Math.floor(t));
    const f = t - k;
    const a = _donutHexToRgb(A[k]), b = _donutHexToRgb(A[k + 1]);
    const lift = ((i / (n - 1)) * 2 - 1) * stretch * 34;
    out.push(_donutRgbToHex(
      a.r + (b.r - a.r) * f + lift,
      a.g + (b.g - a.g) * f + lift,
      a.b + (b.b - a.b) * f + lift
    ));
  }
  return out;
}
// "Spectrum" — a curated multi-hue set, extended with golden-angle hues (so
// neighbouring wedges never look alike) once a portfolio outgrows the base set.
const DONUT_SPECTRUM_BASE = ['#3b82f6', '#10b981', '#f43f5e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1', '#14b8a6', '#e879f9'];
function donutSpectrumPalette(n) {
  if (n <= DONUT_SPECTRUM_BASE.length) return DONUT_SPECTRUM_BASE.slice(0, n);
  const out = DONUT_SPECTRUM_BASE.slice();
  for (let i = DONUT_SPECTRUM_BASE.length; i < n; i++) {
    out.push(_donutHslToHex((210 + i * 137.508) % 360, 0.62, 0.58));
  }
  return out;
}
function donutPaletteColors(palette, n) {
  return palette === 'indigo' ? donutIndigoPalette(n) : donutSpectrumPalette(n);
}
const DONUT_OTHER_COLOR = '#2E2E3C';
function PortfolioPieChart({ positions, displayCurrency, fxRates, onOpenDetail, sectorCache, fundamentals, sectorWeights, onSetSectorWeights, availableModes }) {
  const { Icon, positionDisplayName, MARKET_LABELS, resolvePositionSector } = window.PBApp;
  const SectorAllocationModal = PBModals.SectorAllocationModal;
  const donutPalette = PBStore.useSetting('donutPalette');
  const donutTopN = PBStore.useSetting('donutTopN');
  const prices = PBStore.usePricesMap();
  const valueHidden = PBStore.useSetting('valueHidden');
  const [mode, setMode] = useState('ticker');
  const [hovered, setHovered] = useState(null);
  const [openSector, setOpenSector] = useState(null);
  // When set ({ ticker, market, name }), the dedicated sector-allocation editor
  // is open for that instrument — launched from the sector-breakdown popup.
  const [editWeightsFor, setEditWeightsFor] = useState(null);
  // Optional market filter (top-right of the card): narrows the donut to one
  // market's holdings. Only offered when the book spans more than one market.
  const [marketFilter, setMarketFilter] = useState('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef(null);
  const availMarkets = useMemo(() => Array.from(new Set(positions.map(p => p.market))), [positions]);
  useEffect(() => {
    if (marketFilter !== 'all' && !availMarkets.includes(marketFilter)) setMarketFilter('all');
  }, [availMarkets, marketFilter]);
  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e) => { if (filterRef.current && !filterRef.current.contains(e.target)) setFilterOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); };
  }, [filterOpen]);
  const allModes = [
    { key: 'ticker', label: 'Holdings' },
    { key: 'sector', label: 'Sector' },
    { key: 'market', label: 'Market' }
  ];
  // Callers can restrict the toggle set (e.g. TFSA hides "Market" — every holding
  // is the same single market, so the breakdown would be a meaningless 100%).
  const modes = availableModes ? allModes.filter(m => availableModes.includes(m.key)) : allModes;
  const rates = fxRates?.rates || null;
  // Build per-position values, honouring the market filter.
  const visiblePositions = marketFilter === 'all' ? positions : positions.filter(p => p.market === marketFilter);
  const posVals = [];
  visiblePositions.forEach(p => {
    const q = prices[priceKey(p.market, p.ticker)];
    if (!q) return;
    const native = marketCurrency(p.market);
    const val = convertCcy(p.shares * q.price, native, displayCurrency, rates);
    if (val != null && val > 0) {
      // Best available display name for ANY instrument (stock, ETF, trust): the
      // name saved at import, then the live quote's company name, then the
      // curated lists — never the bare ticker unless nothing else is known.
      const nm = positionDisplayName(p, p.market, q);
      // Pass the name so the resolver's last-resort classifier can place funds /
      // bonds / gold / foreign equities that the ticker maps don't cover.
      const sectorInfo = resolvePositionSector(p.ticker, p.market, sectorCache, fundamentals, nm) || {};
      // A look-through sector mix for this instrument (ETF/fund), if the user has
      // set one — used to split the holding across sectors below.
      const rawW = sectorWeights && sectorWeights[priceKey(p.market, p.ticker)];
      const splits = Array.isArray(rawW)
        ? rawW.map(w => ({ sector: w.sector, weight: parseFloat(w.weight) }))
              .filter(w => w.sector && isFinite(w.weight) && w.weight > 0)
        : [];
      posVals.push({ ticker: p.ticker, market: p.market, value: val, name: nm, sector: sectorInfo.sector || 'Other', sectorWeights: splits });
    }
  });
  // Group by mode, and (for the sector view) keep the member holdings per sector
  // so a tap can open a breakdown of exactly which stocks make up each wedge.
  const grouped = {};
  // Members per group key, so a tap on a sector OR a market wedge can open a
  // breakdown of exactly which holdings (and their values) make up that slice.
  const groupMembers = {};
  const addToGroup = (key, value, member) => {
    if (!grouped[key]) grouped[key] = { label: key, value: 0, market: member.market, ticker: member.ticker, name: member.name };
    grouped[key].value += value;
    (groupMembers[key] = groupMembers[key] || []).push(member);
  };
  posVals.forEach(pv => {
    if (mode === 'sector') {
      // ETF/fund with a defined sector mix: split its value across those sectors
      // (weights normalised) so it shows up proportionally in every wedge it spans.
      if (pv.sectorWeights && pv.sectorWeights.length) {
        const totalW = pv.sectorWeights.reduce((s, x) => s + x.weight, 0) || 1;
        pv.sectorWeights.forEach(sp => {
          const portion = pv.value * (sp.weight / totalW);
          if (portion > 0) addToGroup(sp.sector, portion, { ...pv, value: portion, sector: sp.sector });
        });
      } else {
        addToGroup(pv.sector, pv.value, pv);
      }
    } else if (mode === 'market') {
      addToGroup(MARKET_LABELS[pv.market] || pv.market, pv.value, pv);
    } else {
      addToGroup(pv.ticker, pv.value, pv);
    }
  });
  Object.values(groupMembers).forEach(list => list.sort((a, b) => b.value - a.value));
  // Sort by weight, but always sink "Other" to the bottom so it reads as the
  // residual it is rather than competing with real sectors near the top.
  const slices = Object.values(grouped).sort((a, b) => {
    const ao = a.label === 'Other', bo = b.label === 'Other';
    if (ao !== bo) return ao ? 1 : -1;
    return b.value - a.value;
  });
  let total = slices.reduce((s, sl) => s + sl.value, 0);
  // Header: mode toggle (left) + optional market filter (right). Built once and
  // reused in the empty state so a filter that narrows to nothing can still be
  // cleared (otherwise the control would vanish and trap the user).
  const toolbar = React.createElement("div", { className: "pie-toolbar" },
    React.createElement("div", { className: "chart-ranges" },
      modes.map(m => React.createElement("button", {
        key: m.key, className: `chart-range-btn ${mode === m.key ? 'active' : ''}`,
        onClick: () => { setMode(m.key); setHovered(null); setOpenSector(null); }
      }, m.label))),
    availMarkets.length > 1 ? React.createElement("div", { className: "pie-filter", ref: filterRef },
      React.createElement("button", {
        type: "button",
        className: "pie-filter-btn" + (marketFilter !== 'all' ? " active" : ""),
        onClick: () => setFilterOpen(o => !o),
        "aria-haspopup": "true", "aria-expanded": filterOpen,
        title: "Filter by market"
      },
        React.createElement(Icon, { name: "filter", size: 12 }),
        React.createElement("span", { className: "pie-filter-label" },
          marketFilter === 'all' ? 'All' : (MARKET_LABELS[marketFilter] || marketFilter))),
      filterOpen ? React.createElement("div", { className: "pie-filter-menu" },
        ['all', ...availMarkets].map(mk => React.createElement("button", {
          key: mk,
          type: "button",
          className: "pie-filter-opt" + (marketFilter === mk ? " active" : ""),
          onClick: () => { setMarketFilter(mk); setFilterOpen(false); }
        },
          React.createElement("span", null, mk === 'all' ? 'All markets' : (MARKET_LABELS[mk] || mk)),
          marketFilter === mk ? React.createElement(Icon, { name: "check", size: 12 }) : null))
      ) : null
    ) : null);
  if (slices.length === 0) {
    return React.createElement("div", null,
      toolbar,
      React.createElement("div", { className: "chart-empty" },
        React.createElement("div", { className: "text-dim text-sm" },
          marketFilter !== 'all' ? "No holdings in this market yet." : "Add positions to see allocation breakdown.")));
  }
  // Grouping into "Other" applies to the holdings view only — sectors and
  // markets always show in full (never absorbed). `donutTopN` (0 = show all) is
  // the user's chosen cap from Settings → Appearance.
  const groupN = (mode === 'ticker' && typeof donutTopN === 'number' && donutTopN > 0) ? donutTopN : 0;
  let displaySlices = slices;
  if (groupN > 0 && slices.length > groupN) {
    const keep = [];
    let otherVal = 0;
    // slices is already sorted desc with any pre-existing "Other" sunk last, so
    // indexing front-to-back keeps the genuine top holdings and folds the tail
    // (plus any residual "Other") into one wedge.
    slices.forEach((sl, i) => {
      if (i < groupN && sl.label !== 'Other') keep.push(sl);
      else otherVal += sl.value;
    });
    if (otherVal > 0) keep.push({ label: 'Other', value: otherVal, __other: true });
    displaySlices = keep;
  }
  // Clicking a wedge/legend row: holdings → open the stock; sector or market →
  // open a breakdown of the holdings that make up that slice. The grouped
  // "Other" wedge isn't a real instrument or group, so it's inert.
  const clickable = mode === 'ticker' || mode === 'sector' || mode === 'market';
  const handleSlice = (a) => {
    if (a.__other) return;
    if (mode === 'ticker') onOpenDetail(a.ticker, a.market);
    else setOpenSector(a.label);
  };
  // Colour each non-"Other" wedge from the chosen scale, generated to the exact
  // number shown so every holding gets a distinct colour; the grouped residual
  // is always the neutral slate.
  const paletteName = donutPalette === 'indigo' ? 'indigo' : 'spectrum';
  const nColored = displaySlices.reduce((c, s) => c + (s.__other ? 0 : 1), 0);
  const colorList = donutPaletteColors(paletteName, nColored);
  const SIZE = 154, CX = SIZE / 2, CY = SIZE / 2, R = 61, INNER_R = 39;
  const RING_R = (R + INNER_R) / 2, RING_W = R - INNER_R;
  const single = displaySlices.length === 1;
  let cumAngle = -Math.PI / 2;
  let colorIdx = 0;
  const arcs = displaySlices.map((s, i) => {
    const angle = (s.value / total) * Math.PI * 2;
    const startAngle = cumAngle;
    cumAngle += angle;
    const endAngle = cumAngle;
    const largeArc = angle > Math.PI ? 1 : 0;
    const x1 = CX + R * Math.cos(startAngle), y1 = CY + R * Math.sin(startAngle);
    const x2 = CX + R * Math.cos(endAngle), y2 = CY + R * Math.sin(endAngle);
    const ix1 = CX + INNER_R * Math.cos(endAngle), iy1 = CY + INNER_R * Math.sin(endAngle);
    const ix2 = CX + INNER_R * Math.cos(startAngle), iy2 = CY + INNER_R * Math.sin(startAngle);
    // A single 100% holding can't be drawn as an arc path (start == end point
    // is degenerate and renders as a thin seam / nothing). Draw it as a stroked
    // ring circle instead so it shows a clean full donut.
    const d = single ? null
      : `M${x1},${y1}A${R},${R} 0 ${largeArc},1 ${x2},${y2}L${ix1},${iy1}A${INNER_R},${INNER_R} 0 ${largeArc},0 ${ix2},${iy2}Z`;
    const color = s.__other
      ? DONUT_OTHER_COLOR
      : (colorList[colorIdx++] || DONUT_INDIGO_ANCHORS[1]);
    return { ...s, d, color, pct: (s.value / total * 100) };
  });
  const sym = CURRENCY_SYMBOLS[displayCurrency] || '$';
  const fmtTotal = v => sym + Math.round(v).toLocaleString('en-US');
  // Touch parity for hover: dragging a finger across the legend highlights the
  // matching wedge (and updates the centre label) just like a desktop mouseover.
  // Touch events stay captured by the first-touched node, so we hit-test the
  // point under the finger to find which legend row it's currently over.
  const legendTouch = (e) => {
    const t = e.touches && e.touches[0];
    if (!t) return;
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const item = el && el.closest ? el.closest('[data-legend-idx]') : null;
    if (item) {
      const idx = parseInt(item.getAttribute('data-legend-idx'), 10);
      if (!isNaN(idx)) setHovered(idx);
    }
  };
  return React.createElement("div", null,
    toolbar,
    React.createElement("div", { className: "chart-pie-wrap" },
      React.createElement("div", { className: "chart-pie-ring" },
        React.createElement("svg", { viewBox: `0 0 ${SIZE} ${SIZE}`, className: "chart-pie-svg" },
          single
            ? React.createElement("circle", {
                cx: CX, cy: CY, r: RING_R, fill: "none",
                stroke: arcs[0].color, strokeWidth: RING_W,
                style: { cursor: clickable ? 'pointer' : 'default' },
                onClick: () => clickable ? handleSlice(arcs[0]) : null
              })
            : arcs.map((a, i) => React.createElement("path", {
                key: i, d: a.d, fill: a.color,
                stroke: "var(--bg-raised)", strokeWidth: "1.5",
                style: { cursor: clickable ? 'pointer' : 'default', opacity: hovered != null && hovered !== i ? 0.4 : 1, transition: 'opacity 0.2s' },
                onMouseEnter: () => setHovered(i),
                onMouseLeave: () => setHovered(null),
                onClick: () => clickable ? handleSlice(a) : null
              }))),
        React.createElement("div", { className: "chart-pie-center" },
          hovered != null
            ? (() => {
                // Scale the font to the label so a long name wraps to ≤3 lines
                // and stays inside the donut hole; short labels stay big. Holdings
                // mode shows the company name (the ticker is dropped per design).
                const lbl = String((mode === 'ticker' ? (arcs[hovered].name || arcs[hovered].label) : arcs[hovered].label) || '');
                const n = lbl.length;
                const fs = n <= 4 ? 15 : n <= 7 ? 13 : n <= 11 ? 11.5 : n <= 16 ? 10 : n <= 21 ? 9 : 8;
                return React.createElement(React.Fragment, null,
                  React.createElement("div", { className: "chart-pie-center-tkr", style: { fontSize: fs } }, lbl),
                  React.createElement("div", { className: "chart-pie-center-pct" }, arcs[hovered].pct.toFixed(1) + '%'));
              })()
            : React.createElement(React.Fragment, null,
                React.createElement("div", { className: "chart-pie-center-label" }, "Total"),
                React.createElement("div", { className: "chart-pie-center-val" + (valueHidden ? " val-blur" : "") }, fmtTotal(total)))
        )
      ),
      React.createElement("div", {
        className: "chart-pie-legend",
        onTouchStart: legendTouch, onTouchMove: legendTouch, onTouchEnd: () => setHovered(null), onTouchCancel: () => setHovered(null)
      },
        arcs.map((a, i) => React.createElement("button", {
          key: i, className: "chart-pie-legend-item" + (clickable ? " is-clickable" : ""),
          "data-legend-idx": i,
          onMouseEnter: () => setHovered(i),
          onMouseLeave: () => setHovered(null),
          onClick: () => clickable ? handleSlice(a) : null,
          // Holdings mode lists company names only; keep the ticker reachable via
          // the row's tooltip so it stays available as secondary information.
          title: (mode === 'sector' || mode === 'market') ? 'See holdings in ' + a.label : (mode === 'ticker' ? a.ticker : undefined)
        },
          React.createElement("span", { className: "chart-pie-legend-dot", style: { background: a.color } }),
          // Holdings view shows the company / instrument name; sector & market
          // views show their group label.
          React.createElement("span", { className: "chart-pie-legend-tkr" + (mode === 'ticker' ? " is-name" : "") },
            mode === 'ticker' ? (a.name || a.label) : a.label),
          React.createElement("span", { className: "chart-pie-legend-pct" }, a.pct.toFixed(1) + '%'),
          (mode === 'sector' || mode === 'market') ? React.createElement(Icon, { name: "chevron", size: 11, className: "chart-pie-legend-go" }) : null
        ))
      )
    ),
    // Sector / market → "which of my holdings make up this" floating breakdown.
    openSector && (mode === 'sector' || mode === 'market') ? React.createElement(SectorHoldingsPopup, {
      sectorName: openSector,
      kind: mode,
      members: groupMembers[openSector] || [],
      sectorValue: (grouped[openSector] && grouped[openSector].value) || 0,
      portfolioTotal: total,
      displayCurrency: displayCurrency,
      onOpenDetail: onOpenDetail,
      // Only the sector view offers per-holding allocation editing (a market
      // wedge isn't an instrument). Needs a setter from the parent to persist.
      onEditWeights: (onSetSectorWeights && mode === 'sector')
        ? (m => setEditWeightsFor({ ticker: m.ticker, market: m.market, name: m.name }))
        : null,
      onClose: () => setOpenSector(null)
    }) : null,
    // Dedicated allocation editor for the holding tapped in the popup. Stacks
    // above it (.modal z-index 95 > .sector-modal 90).
    editWeightsFor ? React.createElement(SectorAllocationModal, {
      ticker: editWeightsFor.ticker,
      market: editWeightsFor.market,
      name: editWeightsFor.name,
      initialWeights: (sectorWeights && sectorWeights[priceKey(editWeightsFor.market, editWeightsFor.ticker)]) || null,
      onClose: () => setEditWeightsFor(null),
      onSave: (weights) => onSetSectorWeights(priceKey(editWeightsFor.market, editWeightsFor.ticker), weights)
    }) : null
  );
}
// Floating breakdown of exactly which holdings make up a sector wedge — opened
// by tapping a sector in the allocation chart. Lists each position with its
// value, share of the sector, and a proportional bar; tapping a row dives into
// that stock. Mirrors the heatmap's SectorDetailModal pop-in animation.
function SectorHoldingsPopup({ sectorName, members, sectorValue, portfolioTotal, displayCurrency, onOpenDetail, onEditWeights, onClose, kind }) {
  const { Icon, useBodyScrollLock } = window.PBApp;
  const isMarket = kind === 'market';
  const [closing, setClosing] = useState(false);
  const close = useCallback(() => { setClosing(true); setTimeout(onClose, 200); }, [onClose]);
  useBodyScrollLock();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);
  const sym = CURRENCY_SYMBOLS[displayCurrency] || '$';
  const fmtMoney = v => sym + Math.round(v).toLocaleString('en-US');
  const pctPort = portfolioTotal > 0 ? (sectorValue / portfolioTotal * 100) : 0;
  const top = members[0];
  return React.createElement("div", { className: "sector-modal" + (closing ? " closing" : "") },
    React.createElement("div", { className: "sector-modal-backdrop", onClick: close }),
    React.createElement("div", { className: "sector-modal-panel sh-panel", role: "dialog", "aria-label": sectorName + " holdings" },
      React.createElement("div", { className: "sector-modal-header" },
        React.createElement("div", { className: "sector-modal-titles" },
          React.createElement("div", { className: "sector-modal-title" }, sectorName),
          React.createElement("div", { className: "sector-modal-sub" },
            members.length, members.length === 1 ? " holding" : " holdings",
            " · ", pctPort.toFixed(1), "% of portfolio")),
        React.createElement("button", { className: "modal-close", onClick: close, "aria-label": "Close" },
          React.createElement(Icon, { name: "x" }))),
      React.createElement("div", { className: "sector-modal-body" },
        React.createElement("div", { className: "sh-summary" },
          React.createElement("div", { className: "sh-summary-cell" },
            React.createElement("div", { className: "sh-summary-label" }, isMarket ? "Market value" : "Sector value"),
            React.createElement("div", { className: "sh-summary-val" }, fmtMoney(sectorValue))),
          React.createElement("div", { className: "sh-summary-cell" },
            React.createElement("div", { className: "sh-summary-label" }, "Holdings"),
            React.createElement("div", { className: "sh-summary-val" }, members.length)),
          React.createElement("div", { className: "sh-summary-cell" },
            React.createElement("div", { className: "sh-summary-label" }, "Largest"),
            React.createElement("div", { className: "sh-summary-val" }, top ? top.ticker : "—"))),
        React.createElement("div", { className: "sh-list" },
          members.length === 0
            ? React.createElement("div", { className: "text-dim text-sm", style: { padding: 16, textAlign: 'center' } }, isMarket ? "No holdings in this market." : "No holdings in this sector.")
            : members.map((m, i) => {
                const wSector = sectorValue > 0 ? (m.value / sectorValue * 100) : 0;
                const hasName = m.name && m.name !== m.ticker;
                const main = React.createElement("button", {
                  className: "sh-row-main",
                  onClick: () => { if (onOpenDetail) onOpenDetail(m.ticker, m.market); close(); }
                },
                  React.createElement("div", { className: "sh-row-top" },
                    // Ticker — Company / instrument name. Ticker sits in a fixed
                    // column so every name lines up at the same x down the list.
                    React.createElement("div", { className: "sh-row-id" },
                      React.createElement("span", { className: "sh-row-tkr" }, m.ticker),
                      hasName ? React.createElement("span", { className: "sh-row-name" }, m.name) : null),
                    React.createElement("div", { className: "sh-row-figs" },
                      React.createElement("span", { className: "sh-row-val" }, fmtMoney(m.value)),
                      React.createElement("span", { className: "sh-row-wt" }, wSector.toFixed(1), "%"))),
                  React.createElement("div", { className: "sh-bar" },
                    React.createElement("div", { className: "sh-bar-fill", style: { width: Math.max(2, Math.min(100, wSector)) + '%' } })));
                return React.createElement("div", {
                  key: m.market + ':' + m.ticker + ':' + i,
                  className: "sh-row" + (onEditWeights ? " has-edit" : "")
                },
                  main,
                  // Dedicated "edit this fund's sector allocation" entry point —
                  // opens the allocation editor for the instrument. Funds are the
                  // intended use, but it's offered on every holding in the sector.
                  onEditWeights ? React.createElement("button", {
                    className: "sh-row-edit", type: "button",
                    title: "Edit sector allocation", "aria-label": "Edit sector allocation",
                    onClick: (e) => { e.stopPropagation(); onEditWeights(m); close(); }
                  }, React.createElement(Icon, { name: "edit", size: 15 })) : null);
              }))
      )
    )
  );
}

  window.PBViews = window.PBViews || {};
  window.PBViews.HotTopicsView = HotTopicsView;
  window.PBViews.PicksView = PicksView;
  window.PBViews.HedgesView = HedgesView;
  window.PBViews.RulesView = RulesView;
  window.PBViews.OverviewView = OverviewView;
  window.PBViews.MarketRotationView = MarketRotationView;
  window.PBViews.HeatmapView = HeatmapView;
  window.PBViews.HeatmapTreemap = HeatmapTreemap;
  window.PBViews.ZoomPanHeatmap = ZoomPanHeatmap;
  window.PBViews.DashboardView = DashboardView;
  window.PBViews.CurrentView = CurrentView;
  window.PBViews.HoldingRow = HoldingRow;
  window.PBViews.HoldingsListHead = HoldingsListHead;
  window.PBViews.WatchlistView = WatchlistView;
  window.PBViews.TFSAView = TFSAView;
  window.PBViews.PortfolioPieChart = PortfolioPieChart;
  window.PBViews.SectorHoldingsPopup = SectorHoldingsPopup;
})();
