// pb-views.js - extracted view-component bucket (Phase 4). Browser-only classic script.
// Registers window.PBViews.<View> and reads shared app.js primitives from window.PBApp
// at render time (bridge). data.js/PBStore globals are read directly, not via the bridge.
(function () {
  const { useEffect, useRef } = React; // UMD global; view uses these hooks unqualified
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
  window.PBViews = window.PBViews || {};
  window.PBViews.HotTopicsView = HotTopicsView;
  window.PBViews.PicksView = PicksView;
})();
