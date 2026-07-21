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
// Moved verbatim from app.js (Phase 4 inc 23). HeatmapTreemap + ZoomPanHeatmap stay in app.js
// (ZoomPanHeatmap is also used by pb-modals SectorDetailModal) and are reached via the PBApp
// bridge; SectorDetailModal is read from PBModals at render time (pb-modals.js loads after us).
// Full-screen pinch-to-zoom & pan heatmap — thin chrome around ZoomPanHeatmap.
function HeatmapFullscreen(_refFS) {
  const { Icon, ZoomPanHeatmap } = window.PBApp;
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
  const { Icon, resolveTickerName, usePersistedState, HeatmapTreemap } = window.PBApp;
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
// buildTimeAxisTicks/PortfolioLineChart) is bucket-private; PortfolioPieChart + fmtNum stay in app.js
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
  const { Icon, fmt, fmtCcy, fmtCcySigned, computeFxSnapshot, PortfolioPieChart, fmtNum } = window.PBApp;
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
  const { HoldingRow, HoldingsListHead, Icon, fmtCcy, fmtCcySigned, MARKET_LABELS, positionDisplayName } = window.PBApp;
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

  window.PBViews = window.PBViews || {};
  window.PBViews.HotTopicsView = HotTopicsView;
  window.PBViews.PicksView = PicksView;
  window.PBViews.HedgesView = HedgesView;
  window.PBViews.RulesView = RulesView;
  window.PBViews.OverviewView = OverviewView;
  window.PBViews.MarketRotationView = MarketRotationView;
  window.PBViews.HeatmapView = HeatmapView;
  window.PBViews.DashboardView = DashboardView;
  window.PBViews.CurrentView = CurrentView;
})();
