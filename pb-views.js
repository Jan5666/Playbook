// pb-views.js - extracted view-component bucket (Phase 4). Browser-only classic script.
// Registers window.PBViews.<View> and reads shared app.js primitives from window.PBApp
// at render time (bridge). data.js/PBStore globals are read directly, not via the bridge.
(function () {
  const { useEffect, useRef, useState, useMemo, useCallback } = React; // UMD global; views use these hooks unqualified
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
    if (outL.length === 0) els.push(RE('text', { key: 'no-out', x: colW / 2, y: H / 2, className: 'rot-flow-note', textAnchor: 'middle' }, 'No measurable outflows'));
    if (inL.length === 0) els.push(RE('text', { key: 'no-in', x: W - colW / 2, y: H / 2, className: 'rot-flow-note', textAnchor: 'middle' }, 'No measurable inflows'));
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

  window.PBViews = window.PBViews || {};
  window.PBViews.HotTopicsView = HotTopicsView;
  window.PBViews.PicksView = PicksView;
  window.PBViews.HedgesView = HedgesView;
  window.PBViews.RulesView = RulesView;
  window.PBViews.OverviewView = OverviewView;
  window.PBViews.MarketRotationView = MarketRotationView;
})();
