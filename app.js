"use strict";

const {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback
} = React;
const DATA = window.PB_DATA;
const LS = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  },
  set(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) {
      console.warn('LS.set failed:', e);
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {}
  }
};
function usePersistedState(key, defaultValue) {
  const [value, setValue] = useState(() => LS.get(key, defaultValue));
  useEffect(() => {
    LS.set(key, value);
  }, [key, value]);
  return [value, setValue];
}
function yahooSymbol(ticker, market) {
  if (market === 'JSE') return ticker + '.JO';
  if (ticker === '^SPX') return '%5EGSPC';
  if (ticker === '^VIX') return '%5EVIX';
  if (ticker === '^GSPC') return '%5EGSPC';
  return ticker;
}
async function fetchQuote(ticker, market) {
  const sym = yahooSymbol(ticker, market);
  const proxies = [url => `https://corsproxy.io/?${encodeURIComponent(url)}`, url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`];
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`;
  for (const buildProxy of proxies) {
    try {
      const res = await fetch(buildProxy(yahooUrl), {
        cache: 'no-store'
      });
      if (!res.ok) continue;
      const data = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const meta = result.meta;
      if (!meta || typeof meta.regularMarketPrice !== 'number') continue;
      let price = meta.regularMarketPrice;
      let prevClose = meta.chartPreviousClose || meta.previousClose || price;
      let currency = meta.currency || (market === 'JSE' ? 'ZAR' : 'USD');
      if (market === 'JSE' && currency === 'ZAc') {
        price = price / 100;
        prevClose = prevClose / 100;
        currency = 'ZAR';
      }
      return {
        price,
        prevClose,
        change: price - prevClose,
        changePct: prevClose > 0 ? (price - prevClose) / prevClose * 100 : 0,
        currency,
        marketState: meta.marketState || 'UNKNOWN',
        fetchedAt: Date.now(),
        source: 'yahoo'
      };
    } catch (e) {
      continue;
    }
  }
  try {
    const stooqSym = market === 'JSE' ? ticker.toLowerCase() + '.jo' : ticker === '^SPX' || ticker === '^GSPC' ? '%5Espx' : ticker === '^VIX' ? '%5Evix' : ticker.toLowerCase().replace('-', '.') + '.us';
    const stooqUrl = `https://stooq.com/q/l/?s=${stooqSym}&f=sd2t2ohlcv&h&e=csv`;
    for (const buildProxy of proxies) {
      try {
        const res = await fetch(buildProxy(stooqUrl), {
          cache: 'no-store'
        });
        const text = await res.text();
        const lines = text.trim().split('\n');
        if (lines.length < 2) continue;
        const parts = lines[1].split(',');
        let close = parseFloat(parts[6]);
        let open = parseFloat(parts[3]);
        if (!isFinite(close) || !isFinite(open) || open === 0) continue;
        if (market === 'JSE') {
          close = close / 100;
          open = open / 100;
        }
        return {
          price: close,
          prevClose: open,
          change: close - open,
          changePct: (close - open) / open * 100,
          currency: market === 'JSE' ? 'ZAR' : 'USD',
          marketState: 'UNKNOWN',
          fetchedAt: Date.now(),
          source: 'stooq'
        };
      } catch (e) {
        continue;
      }
    }
  } catch (e) {}
  console.warn(`Price fetch failed for ${ticker} (${market})`);
  return null;
}
async function fetchQuoteBatch(items) {
  const results = {};
  const batchSize = 4;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(it => fetchQuote(it.ticker, it.market)));
    settled.forEach((r, idx) => {
      const key = batch[idx].market + ':' + batch[idx].ticker;
      if (r.status === 'fulfilled' && r.value) results[key] = r.value;
    });
  }
  return results;
}
async function fetchNewsForTicker(ticker, market) {
  const yahooSym = market === 'JSE' ? ticker + '.JO' : ticker;
  const rssUrl = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${yahooSym}&region=US&lang=en-US`;
  const proxied = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`;
  try {
    const res = await fetch(proxied);
    const data = await res.json();
    if (data.status === 'ok' && Array.isArray(data.items)) {
      return data.items.slice(0, 12).map(it => ({
        title: it.title,
        link: it.link,
        source: it.author || 'Yahoo Finance',
        pubDate: it.pubDate
      }));
    }
  } catch (e) {}
  return [];
}
function fmt(n, market) {
  const sym = market === 'JSE' ? 'R' : '$';
  if (n == null || !isFinite(n)) return sym + '—';
  return sym + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}
function fmtSigned(n, market) {
  if (n == null || !isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '−';
  return sign + fmt(n, market);
}
function timeAgo(dateStr) {
  try {
    const d = new Date(dateStr);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  } catch (e) {
    return '';
  }
}
function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}
const Icon = _ref => {
  let {
    name,
    size = 15
  } = _ref;
  const paths = {
    refresh: React.createElement("g", null, React.createElement("path", {
      d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"
    }), React.createElement("path", {
      d: "M21 3v5h-5"
    }), React.createElement("path", {
      d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"
    }), React.createElement("path", {
      d: "M8 16H3v5"
    })),
    bell: React.createElement("g", null, React.createElement("path", {
      d: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"
    }), React.createElement("path", {
      d: "M10.3 21a1.94 1.94 0 0 0 3.4 0"
    })),
    moon: React.createElement("path", {
      d: "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
    }),
    sun: React.createElement("g", null, React.createElement("circle", {
      cx: "12",
      cy: "12",
      r: "4"
    }), React.createElement("path", {
      d: "M12 2v2"
    }), React.createElement("path", {
      d: "M12 20v2"
    }), React.createElement("path", {
      d: "m4.93 4.93 1.41 1.41"
    }), React.createElement("path", {
      d: "m17.66 17.66 1.41 1.41"
    }), React.createElement("path", {
      d: "M2 12h2"
    }), React.createElement("path", {
      d: "M20 12h2"
    }), React.createElement("path", {
      d: "m6.34 17.66-1.41 1.41"
    }), React.createElement("path", {
      d: "m19.07 4.93-1.41 1.41"
    })),
    x: React.createElement("g", null, React.createElement("path", {
      d: "M18 6 6 18"
    }), React.createElement("path", {
      d: "m6 6 12 12"
    })),
    plus: React.createElement("g", null, React.createElement("path", {
      d: "M5 12h14"
    }), React.createElement("path", {
      d: "M12 5v14"
    })),
    minus: React.createElement("path", {
      d: "M5 12h14"
    }),
    check: React.createElement("g", null, React.createElement("path", {
      d: "M20 6 9 17l-5-5"
    })),
    checkCircle: React.createElement("g", null, React.createElement("circle", {
      cx: "12",
      cy: "12",
      r: "10"
    }), React.createElement("path", {
      d: "m9 12 2 2 4-4"
    })),
    alert: React.createElement("g", null, React.createElement("circle", {
      cx: "12",
      cy: "12",
      r: "10"
    }), React.createElement("path", {
      d: "M12 8v4"
    }), React.createElement("path", {
      d: "M12 16h.01"
    })),
    external: React.createElement("g", null, React.createElement("path", {
      d: "M15 3h6v6"
    }), React.createElement("path", {
      d: "M10 14 21 3"
    }), React.createElement("path", {
      d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"
    })),
    briefcase: React.createElement("g", null, React.createElement("path", {
      d: "M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"
    }), React.createElement("rect", {
      width: "20",
      height: "14",
      x: "2",
      y: "6",
      rx: "2"
    })),
    eye: React.createElement("g", null, React.createElement("path", {
      d: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"
    }), React.createElement("circle", {
      cx: "12",
      cy: "12",
      r: "3"
    })),
    star: React.createElement("path", {
      d: "M12 2 15.09 8.26 22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
    }),
    trash: React.createElement("g", null, React.createElement("path", {
      d: "M3 6h18"
    }), React.createElement("path", {
      d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"
    }), React.createElement("path", {
      d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
    })),
    edit: React.createElement("g", null, React.createElement("path", {
      d: "M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"
    })),
    chevron: React.createElement("path", {
      d: "m9 18 6-6-6-6"
    }),
    download: React.createElement("g", null, React.createElement("path", {
      d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"
    }), React.createElement("polyline", {
      points: "7 10 12 15 17 10"
    }), React.createElement("line", {
      x1: "12",
      y1: "15",
      x2: "12",
      y2: "3"
    })),
    share: React.createElement("g", null, React.createElement("circle", {
      cx: "18",
      cy: "5",
      r: "3"
    }), React.createElement("circle", {
      cx: "6",
      cy: "12",
      r: "3"
    }), React.createElement("circle", {
      cx: "18",
      cy: "19",
      r: "3"
    }), React.createElement("line", {
      x1: "8.59",
      y1: "13.51",
      x2: "15.42",
      y2: "17.49"
    }), React.createElement("line", {
      x1: "15.41",
      y1: "6.51",
      x2: "8.59",
      y2: "10.49"
    })),
    gauge: React.createElement("g", null, React.createElement("path", {
      d: "m12 14 4-4"
    }), React.createElement("path", {
      d: "M3.34 19a10 10 0 1 1 17.32 0"
    })),
    list: React.createElement("g", null, React.createElement("line", {
      x1: "8",
      y1: "6",
      x2: "21",
      y2: "6"
    }), React.createElement("line", {
      x1: "8",
      y1: "12",
      x2: "21",
      y2: "12"
    }), React.createElement("line", {
      x1: "8",
      y1: "18",
      x2: "21",
      y2: "18"
    }), React.createElement("line", {
      x1: "3",
      y1: "6",
      x2: "3.01",
      y2: "6"
    }), React.createElement("line", {
      x1: "3",
      y1: "12",
      x2: "3.01",
      y2: "12"
    }), React.createElement("line", {
      x1: "3",
      y1: "18",
      x2: "3.01",
      y2: "18"
    }))
  };
  return React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, paths[name] || null);
};
const ToastContext = React.createContext(() => {});
function ToastProvider(_ref2) {
  let {
    children
  } = _ref2;
  const [toast, setToast] = useState(null);
  const show = useCallback(msg => {
    setToast(msg);
    setTimeout(() => setToast(null), 3600);
  }, []);
  return React.createElement(ToastContext.Provider, {
    value: show
  }, children, toast && React.createElement("div", {
    className: "toast"
  }, toast));
}
const useToast = () => React.useContext(ToastContext);
function App() {
  const [positions, setPositions] = usePersistedState('pb.positions.v2', []);
  const [watchlist, setWatchlist] = usePersistedState('pb.watchlist.v2', []);
  const [alerts, setAlerts] = usePersistedState('pb.alerts.v2', []);
  const [triggered, setTriggered] = usePersistedState('pb.triggered.v2', []);
  const [theme, setTheme] = usePersistedState('pb.theme.v2', 'dark');
  const [view, setView] = useState('dashboard');
  const [prices, setPrices] = useState({});
  const [newsByTicker, setNewsByTicker] = useState({});
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [selected, setSelected] = useState(null);
  const [showAlerts, setShowAlerts] = useState(false);
  const [posModalEditId, setPosModalEditId] = useState(null);
  const [posModalOpen, setPosModalOpen] = useState(false);
  const [notifPerm, setNotifPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const [installEvent, setInstallEvent] = useState(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [marketFilter, setMarketFilter] = useState('US');
  const toast = useToast();
  const alertSeen = useRef({});
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const handler = e => {
      e.preventDefault();
      setInstallEvent(e);
      if (!LS.get('pb.installDismissed.v2', false)) setShowInstallBanner(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (isIOS && !standalone && !LS.get('pb.installDismissed.v2', false)) {
      setTimeout(() => setShowInstallBanner(true), 2500);
    }
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);
  const tickersToFetch = useMemo(() => {
    const set = new Set();
    DATA.HOLDINGS.forEach(h => set.add('US:' + h.ticker));
    DATA.NEW_PICKS.forEach(p => set.add('US:' + p.ticker));
    DATA.HEDGES.forEach(h => set.add('US:' + h.ticker));
    set.add('US:VOO');
    set.add('US:^SPX');
    set.add('US:^VIX');
    positions.forEach(p => set.add(p.market + ':' + p.ticker));
    watchlist.forEach(w => set.add(w.market + ':' + w.ticker));
    alerts.forEach(a => set.add(a.market + ':' + a.ticker));
    return Array.from(set).map(k => {
      const [m, t] = k.split(':');
      return {
        market: m,
        ticker: t
      };
    });
  }, [positions, watchlist, alerts]);
  const refreshPrices = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    try {
      const newPrices = await fetchQuoteBatch(tickersToFetch);
      setPrices(prev => ({
        ...prev,
        ...newPrices
      }));
      setLastUpdate(new Date());
    } catch (e) {
      console.error('Refresh failed:', e);
      toast('Price refresh failed');
    }
    setLoading(false);
  }, [tickersToFetch, loading, toast]);
  useEffect(() => {
    refreshPrices();
    const interval = setInterval(() => {
      if (!document.hidden) refreshPrices();
    }, 90000);
    const onVisible = () => {
      if (!document.hidden) {
        const age = lastUpdate ? Date.now() - lastUpdate.getTime() : Infinity;
        if (age > 60000) refreshPrices();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [tickersToFetch]);
  useEffect(() => {
    const newTriggers = [];
    alerts.forEach(a => {
      if (!a.active) return;
      const key = a.market + ':' + a.ticker;
      const p = prices[key];
      if (!p) return;
      const hit = a.direction === 'above' ? p.price >= a.targetPrice : p.price <= a.targetPrice;
      if (hit && alertSeen.current[a.id] !== 'hit') {
        alertSeen.current[a.id] = 'hit';
        newTriggers.push({
          ...a,
          triggeredAt: new Date().toISOString(),
          triggerPrice: p.price
        });
      } else if (!hit) {
        alertSeen.current[a.id] = 'waiting';
      }
    });
    if (newTriggers.length) {
      setTriggered(prev => [...newTriggers, ...prev].slice(0, 100));
      newTriggers.forEach(t => fireNotification(t));
    }
  }, [prices, alerts]);
  const fireNotification = useCallback(async trig => {
    const sym = trig.market === 'JSE' ? 'R' : '$';
    const title = `${trig.ticker} ${trig.direction} ${sym}${trig.targetPrice.toFixed(2)}`;
    const body = `Now at ${sym}${trig.triggerPrice.toFixed(2)}${trig.note ? ` — ${trig.note}` : ''}`;
    try {
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'notify',
          title,
          body,
          tag: 'alert-' + trig.id,
          icon: './icon-192.png',
          badge: './icon-192.png'
        });
        return;
      }
    } catch (e) {}
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.showNotification(title, {
          body,
          tag: 'alert-' + trig.id,
          icon: './icon-192.png'
        });
        return;
      }
    } catch (e) {}
    try {
      if (Notification.permission === 'granted') {
        new Notification(title, {
          body,
          tag: 'alert-' + trig.id,
          icon: './icon-192.png'
        });
        return;
      }
    } catch (e) {}
    toast(`${title}: ${body}`);
  }, [toast]);
  const requestNotifPerm = useCallback(async () => {
    if (typeof Notification === 'undefined') {
      toast('Notifications not supported in this browser');
      return;
    }
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (isIOS && !standalone) {
      toast('On iPhone, install to Home Screen first, then enable notifications');
      return;
    }
    try {
      const r = await Notification.requestPermission();
      setNotifPerm(r);
      if (r === 'granted') {
        toast('Notifications enabled');
        try {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) {
            await reg.showNotification('Playbook', {
              body: 'Alerts are active',
              tag: 'welcome',
              icon: './icon-192.png'
            });
          } else {
            new Notification('Playbook', {
              body: 'Alerts are active',
              icon: './icon-192.png'
            });
          }
        } catch (e) {}
      } else {
        toast('Notifications: ' + r);
      }
    } catch (e) {
      toast('Could not request permission: ' + e.message);
    }
  }, [toast]);
  const addPosition = (ticker, market, shares, costBasis, notes) => {
    const p = {
      id: uid(),
      ticker: ticker.toUpperCase(),
      market,
      shares: parseFloat(shares),
      costBasis: parseFloat(costBasis),
      notes: notes || '',
      addedAt: new Date().toISOString()
    };
    setPositions(prev => [...prev, p]);
    toast('Position added');
  };
  const updatePosition = (id, updates) => {
    setPositions(prev => prev.map(p => p.id === id ? {
      ...p,
      ...updates
    } : p));
    toast('Position updated');
  };
  const removePosition = id => {
    setPositions(prev => prev.filter(p => p.id !== id));
    toast('Position removed');
  };
  const addWatch = (ticker, market) => {
    ticker = ticker.toUpperCase();
    if (watchlist.some(w => w.ticker === ticker && w.market === market)) {
      toast('Already on watchlist');
      return;
    }
    setWatchlist(prev => [...prev, {
      id: uid(),
      ticker,
      market,
      addedAt: new Date().toISOString()
    }]);
    toast('Added ' + ticker);
  };
  const removeWatch = id => setWatchlist(prev => prev.filter(w => w.id !== id));
  const addAlert = (ticker, market, direction, targetPrice, note) => {
    const a = {
      id: uid(),
      ticker,
      market,
      direction,
      targetPrice: parseFloat(targetPrice),
      note: note || '',
      active: true,
      createdAt: new Date().toISOString()
    };
    setAlerts(prev => [...prev, a]);
    toast('Alert set');
  };
  const removeAlert = id => {
    setAlerts(prev => prev.filter(a => a.id !== id));
    delete alertSeen.current[id];
  };
  const clearTriggered = () => {
    setTriggered([]);
    toast('Cleared');
  };
  const loadNews = useCallback(async (ticker, market) => {
    const key = market + ':' + ticker;
    const existing = newsByTicker[key];
    if (existing && existing.items && Date.now() - existing.fetchedAt < 15 * 60 * 1000) return;
    setNewsByTicker(prev => ({
      ...prev,
      [key]: {
        items: existing?.items || [],
        loading: true,
        fetchedAt: existing?.fetchedAt || 0
      }
    }));
    const items = await fetchNewsForTicker(ticker, market);
    setNewsByTicker(prev => ({
      ...prev,
      [key]: {
        items,
        loading: false,
        fetchedAt: Date.now()
      }
    }));
  }, [newsByTicker]);
  const handleInstall = async () => {
    if (installEvent) {
      installEvent.prompt();
      await installEvent.userChoice;
      setInstallEvent(null);
    }
    setShowInstallBanner(false);
    LS.set('pb.installDismissed.v2', true);
  };
  const dismissInstall = () => {
    setShowInstallBanner(false);
    LS.set('pb.installDismissed.v2', true);
  };
  const exportData = () => {
    const data = {
      positions,
      watchlist,
      alerts,
      triggered,
      exportedAt: new Date().toISOString(),
      version: 2
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `playbook-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Backup downloaded');
  };
  const importData = file => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = JSON.parse(e.target.result);
        if (data.positions) setPositions(data.positions);
        if (data.watchlist) setWatchlist(data.watchlist);
        if (data.alerts) setAlerts(data.alerts);
        if (data.triggered) setTriggered(data.triggered);
        toast('Backup restored');
      } catch (err) {
        toast('Invalid backup file');
      }
    };
    reader.readAsText(file);
  };
  const getPrice = (ticker, market) => prices[(market || 'US') + ':' + ticker];
  const openDetail = (ticker, market) => {
    setSelected({
      ticker,
      market: market || 'US'
    });
    loadNews(ticker, market || 'US');
  };
  const views = {
    dashboard: React.createElement(DashboardView, {
      positions: positions,
      prices: prices,
      onAddPosition: () => {
        setPosModalEditId(null);
        setPosModalOpen(true);
      },
      onEditPosition: id => {
        setPosModalEditId(id);
        setPosModalOpen(true);
      },
      onRemovePosition: removePosition,
      onOpenDetail: openDetail,
      onExport: exportData,
      onImport: importData
    }),
    current: React.createElement(CurrentView, {
      prices: prices,
      positions: positions,
      marketFilter: marketFilter,
      setMarketFilter: setMarketFilter,
      onOpenDetail: openDetail
    }),
    watchlist: React.createElement(WatchlistView, {
      watchlist: watchlist,
      prices: prices,
      onAdd: addWatch,
      onRemove: removeWatch,
      onOpenDetail: openDetail
    }),
    picks: React.createElement(PicksView, {
      prices: prices,
      onOpenDetail: openDetail
    }),
    hedges: React.createElement(HedgesView, {
      prices: prices,
      onOpenDetail: openDetail
    }),
    deployment: React.createElement(DeploymentView, null),
    rules: React.createElement(RulesView, null),
    overview: React.createElement(OverviewView, {
      prices: prices
    })
  };
  const recentTriggered24h = triggered.filter(t => Date.now() - new Date(t.triggeredAt).getTime() < 24 * 3600 * 1000).length;
  return React.createElement("div", {
    className: "app"
  }, React.createElement("header", {
    className: "header"
  }, React.createElement("div", {
    className: "header-inner"
  }, React.createElement("div", {
    className: "brand"
  }, React.createElement("div", {
    className: "brand-title"
  }, "Playbook"), React.createElement("div", {
    className: "brand-sub"
  }, "Jan \xB7 30% Target")), React.createElement("div", {
    className: "status-chip"
  }, React.createElement("span", {
    className: `dot ${loading ? 'loading' : lastUpdate ? 'live' : 'loading'}`
  }), React.createElement("span", null, lastUpdate ? lastUpdate.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  }) : '…')), React.createElement("button", {
    className: `icon-btn ${loading ? 'spin' : ''}`,
    onClick: refreshPrices,
    "aria-label": "Refresh"
  }, React.createElement(Icon, {
    name: "refresh"
  })), React.createElement("button", {
    className: "icon-btn",
    onClick: () => setShowAlerts(true),
    "aria-label": "Alerts"
  }, React.createElement(Icon, {
    name: "bell"
  }), recentTriggered24h > 0 && React.createElement("span", {
    className: "badge"
  }, recentTriggered24h > 9 ? '9+' : recentTriggered24h), recentTriggered24h === 0 && alerts.length > 0 && React.createElement("span", {
    className: "badge blue"
  }, alerts.length > 9 ? '9+' : alerts.length)), React.createElement("button", {
    className: "icon-btn",
    onClick: () => setTheme(t => t === 'dark' ? 'light' : 'dark'),
    "aria-label": "Theme"
  }, React.createElement(Icon, {
    name: theme === 'dark' ? 'sun' : 'moon'
  })))), React.createElement(Hero, {
    positions: positions,
    prices: prices
  }), React.createElement("nav", {
    className: "nav"
  }, React.createElement("div", {
    className: "nav-inner"
  }, [['dashboard', 'Dashboard'], ['current', 'Current'], ['watchlist', 'Watchlist'], ['picks', 'New picks'], ['hedges', 'Hedges'], ['deployment', 'Deployment'], ['rules', 'Rules'], ['overview', 'Thesis']].map(_ref3 => {
    let [k, label] = _ref3;
    return React.createElement("button", {
      key: k,
      className: `nav-btn ${view === k ? 'active' : ''}`,
      onClick: () => {
        setView(k);
        window.scrollTo({
          top: 0,
          behavior: 'smooth'
        });
      }
    }, label);
  }))), React.createElement("main", null, views[view]), selected && React.createElement(DetailModal, {
    selected: selected,
    prices: prices,
    alerts: alerts.filter(a => a.ticker === selected.ticker && a.market === selected.market),
    news: newsByTicker[selected.market + ':' + selected.ticker],
    onClose: () => setSelected(null),
    onAddAlert: addAlert,
    onRemoveAlert: removeAlert,
    onLoadNews: () => loadNews(selected.ticker, selected.market)
  }), showAlerts && React.createElement(AlertsModal, {
    alerts: alerts,
    triggered: triggered,
    notifPerm: notifPerm,
    onClose: () => setShowAlerts(false),
    onRemoveAlert: removeAlert,
    onClearTriggered: clearTriggered,
    onRequestPerm: requestNotifPerm
  }), posModalOpen && React.createElement(PositionModal, {
    editId: posModalEditId,
    existing: posModalEditId ? positions.find(p => p.id === posModalEditId) : null,
    onClose: () => setPosModalOpen(false),
    onSave: data => {
      if (posModalEditId) updatePosition(posModalEditId, data);else addPosition(data.ticker, data.market, data.shares, data.costBasis, data.notes);
      setPosModalOpen(false);
    }
  }), showInstallBanner && React.createElement(InstallBanner, {
    isIOS: /iphone|ipad|ipod/i.test(navigator.userAgent),
    onInstall: handleInstall,
    onDismiss: dismissInstall,
    canPrompt: !!installEvent
  }));
}
function Hero(_ref4) {
  let {
    positions,
    prices
  } = _ref4;
  let usdValue = 0,
    zarValue = 0,
    usdCost = 0,
    zarCost = 0;
  positions.forEach(p => {
    const q = prices[p.market + ':' + p.ticker];
    if (p.market === 'JSE') {
      zarCost += p.shares * p.costBasis;
      if (q) zarValue += p.shares * q.price;
    } else {
      usdCost += p.shares * p.costBasis;
      if (q) usdValue += p.shares * q.price;
    }
  });
  const usdGain = usdCost > 0 ? (usdValue - usdCost) / usdCost * 100 : 0;
  const zarGain = zarCost > 0 ? (zarValue - zarCost) / zarCost * 100 : 0;
  const spx = prices['US:^SPX'];
  const vix = prices['US:^VIX'];
  return React.createElement("section", {
    className: "hero"
  }, React.createElement("div", {
    className: "hero-grid"
  }, React.createElement("div", {
    className: "hero-stat"
  }, React.createElement("div", {
    className: "label"
  }, "Your USD"), React.createElement("div", {
    className: "value"
  }, fmt(usdValue, 'US')), React.createElement("div", {
    className: `sub ${usdGain >= 0 ? 'up' : 'down'}`
  }, usdGain >= 0 ? '+' : '', usdGain.toFixed(2), "% \xB7 ", positions.filter(p => p.market === 'US').length, " pos")), React.createElement("div", {
    className: "hero-stat"
  }, React.createElement("div", {
    className: "label"
  }, "Your ZAR"), React.createElement("div", {
    className: "value"
  }, fmt(zarValue, 'JSE')), React.createElement("div", {
    className: `sub ${zarGain >= 0 ? 'up' : 'down'}`
  }, zarGain >= 0 ? '+' : '', zarGain.toFixed(2), "% \xB7 ", positions.filter(p => p.market === 'JSE').length, " pos")), React.createElement("div", {
    className: "hero-stat"
  }, React.createElement("div", {
    className: "label"
  }, "S&P 500"), React.createElement("div", {
    className: "value"
  }, spx ? spx.price.toFixed(0) : '—'), React.createElement("div", {
    className: `sub ${spx && spx.changePct >= 0 ? 'up' : 'down'}`
  }, spx ? (spx.changePct >= 0 ? '+' : '') + spx.changePct.toFixed(2) + '%' : '—')), React.createElement("div", {
    className: "hero-stat"
  }, React.createElement("div", {
    className: "label"
  }, "VIX"), React.createElement("div", {
    className: "value"
  }, vix ? vix.price.toFixed(2) : '—'), React.createElement("div", {
    className: `sub ${vix && vix.changePct >= 0 ? 'down' : 'up'}`
  }, vix ? (vix.changePct >= 0 ? '+' : '') + vix.changePct.toFixed(2) + '%' : '—'))));
}
function PriceBlock(_ref5) {
  let {
    quote,
    size = 'md'
  } = _ref5;
  if (!quote) return React.createElement("span", {
    className: "mono text-dim"
  }, "\u2014");
  const up = quote.changePct >= 0;
  const sym = quote.currency === 'ZAR' ? 'R' : '$';
  const klass = size === 'xl' ? 'price price-xl' : size === 'lg' ? 'price price-lg' : 'price';
  return React.createElement("div", {
    className: "flex items-baseline gap-2"
  }, React.createElement("span", {
    className: klass
  }, sym, quote.price.toFixed(2)), React.createElement("span", {
    className: `chg ${up ? 'up' : 'down'}`
  }, up ? '▲' : '▼', " ", up ? '+' : '', quote.changePct.toFixed(2), "%"));
}
function DashboardView(_ref6) {
  let {
    positions,
    prices,
    onAddPosition,
    onEditPosition,
    onRemovePosition,
    onOpenDetail,
    onExport,
    onImport
  } = _ref6;
  const usdPositions = positions.filter(p => p.market === 'US');
  const zarPositions = positions.filter(p => p.market === 'JSE');
  const computeStats = list => {
    let cost = 0,
      value = 0,
      hasAllPrices = true;
    list.forEach(p => {
      cost += p.shares * p.costBasis;
      const q = prices[p.market + ':' + p.ticker];
      if (q) value += p.shares * q.price;else hasAllPrices = false;
    });
    return {
      cost,
      value,
      pnl: value - cost,
      pnlPct: cost > 0 ? (value - cost) / cost * 100 : 0,
      hasAllPrices
    };
  };
  const usd = computeStats(usdPositions);
  const zar = computeStats(zarPositions);
  const fileInputRef = useRef();
  return React.createElement("div", null, React.createElement("div", {
    className: "flex justify-between items-center mb-3",
    style: {
      gap: 10
    }
  }, React.createElement("div", null, React.createElement("h1", {
    className: "section-title"
  }, "Dashboard"), React.createElement("div", {
    className: "section-desc",
    style: {
      marginBottom: 0
    }
  }, "Your live positions and P&L.")), React.createElement("button", {
    className: "btn btn-primary btn-sm",
    onClick: onAddPosition
  }, React.createElement(Icon, {
    name: "plus",
    size: 13
  }), " Add")), positions.length === 0 ? React.createElement("div", {
    className: "empty"
  }, React.createElement(Icon, {
    name: "briefcase",
    size: 40
  }), React.createElement("h3", null, "No positions yet"), React.createElement("p", null, "Add your holdings to see live prices and P&L. Data stays on this device."), React.createElement("button", {
    className: "btn btn-primary",
    onClick: onAddPosition
  }, React.createElement(Icon, {
    name: "plus"
  }), " Add your first position")) : React.createElement(React.Fragment, null, React.createElement("div", {
    className: "grid grid-4 mb-4"
  }, usdPositions.length > 0 && React.createElement(React.Fragment, null, React.createElement("div", {
    className: "stat-card"
  }, React.createElement("div", {
    className: "stat-label"
  }, "USD value"), React.createElement("div", {
    className: "stat-value"
  }, fmt(usd.value, 'US')), React.createElement("div", {
    className: `stat-sub ${usd.pnlPct >= 0 ? 'up' : 'down'}`
  }, usd.pnlPct >= 0 ? '+' : '', usd.pnlPct.toFixed(2), "%")), React.createElement("div", {
    className: "stat-card"
  }, React.createElement("div", {
    className: "stat-label"
  }, "USD P&L"), React.createElement("div", {
    className: `stat-value ${usd.pnl >= 0 ? 'text-up' : 'text-down'}`
  }, fmtSigned(usd.pnl, 'US')), React.createElement("div", {
    className: "stat-sub"
  }, "on ", fmt(usd.cost, 'US')))), zarPositions.length > 0 && React.createElement(React.Fragment, null, React.createElement("div", {
    className: "stat-card"
  }, React.createElement("div", {
    className: "stat-label"
  }, "ZAR value"), React.createElement("div", {
    className: "stat-value"
  }, fmt(zar.value, 'JSE')), React.createElement("div", {
    className: `stat-sub ${zar.pnlPct >= 0 ? 'up' : 'down'}`
  }, zar.pnlPct >= 0 ? '+' : '', zar.pnlPct.toFixed(2), "%")), React.createElement("div", {
    className: "stat-card"
  }, React.createElement("div", {
    className: "stat-label"
  }, "ZAR P&L"), React.createElement("div", {
    className: `stat-value ${zar.pnl >= 0 ? 'text-up' : 'text-down'}`
  }, fmtSigned(zar.pnl, 'JSE')), React.createElement("div", {
    className: "stat-sub"
  }, "on ", fmt(zar.cost, 'JSE'))))), React.createElement("div", {
    className: "grid grid-2"
  }, positions.map(p => {
    const q = prices[p.market + ':' + p.ticker];
    const marketValue = q ? p.shares * q.price : null;
    const cost = p.shares * p.costBasis;
    const pnl = marketValue != null ? marketValue - cost : null;
    const pnlPct = marketValue != null && cost > 0 ? (marketValue - cost) / cost * 100 : null;
    return React.createElement("div", {
      key: p.id,
      className: "pos-card",
      onClick: () => onOpenDetail(p.ticker, p.market)
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
    }, p.market)), React.createElement("div", {
      className: "tkr-name"
    }, p.shares, " shares @ ", fmt(p.costBasis, p.market))), React.createElement("div", {
      className: "pos-actions",
      onClick: e => e.stopPropagation()
    }, React.createElement("button", {
      className: "btn btn-ghost btn-xs",
      onClick: () => onEditPosition(p.id),
      "aria-label": "Edit"
    }, React.createElement(Icon, {
      name: "edit",
      size: 13
    })), React.createElement("button", {
      className: "btn btn-ghost btn-xs",
      onClick: () => {
        if (confirm('Remove ' + p.ticker + '?')) onRemovePosition(p.id);
      },
      "aria-label": "Remove"
    }, React.createElement(Icon, {
      name: "x",
      size: 13
    })))), React.createElement(PriceBlock, {
      quote: q,
      size: "lg"
    }), React.createElement("div", {
      className: "pnl-row"
    }, React.createElement("span", {
      className: "pnl-label"
    }, "Unrealised"), React.createElement("span", {
      className: `pnl-val ${pnl != null && pnl >= 0 ? 'up' : 'down'}`
    }, pnl != null ? fmtSigned(pnl, p.market) : '—'), React.createElement("span", {
      className: `pnl-pct ${pnlPct != null && pnlPct >= 0 ? 'up' : 'down'}`
    }, pnlPct != null ? (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%' : '')), p.notes && React.createElement("div", {
      className: "text-xs text-dim mt-2"
    }, p.notes));
  }))), React.createElement("div", {
    className: "flex gap-2 mt-6 flex-wrap"
  }, React.createElement("button", {
    className: "btn btn-secondary btn-sm",
    onClick: onExport
  }, React.createElement(Icon, {
    name: "download",
    size: 13
  }), " Backup data"), React.createElement("button", {
    className: "btn btn-secondary btn-sm",
    onClick: () => fileInputRef.current?.click()
  }, React.createElement(Icon, {
    name: "share",
    size: 13
  }), " Restore backup"), React.createElement("input", {
    ref: fileInputRef,
    type: "file",
    accept: "application/json",
    style: {
      display: 'none'
    },
    onChange: e => {
      if (e.target.files[0]) onImport(e.target.files[0]);
      e.target.value = '';
    }
  })));
}
function CurrentView(_ref7) {
  let {
    prices,
    positions,
    marketFilter,
    setMarketFilter,
    onOpenDetail
  } = _ref7;
  const usdPositions = positions.filter(p => p.market === 'US');
  const zarPositions = positions.filter(p => p.market === 'JSE');
  const renderUS = () => {
    if (usdPositions.length === 0) {
      return React.createElement("div", null, React.createElement("div", {
        className: "eyebrow"
      }, "Playbook reference (US)"), React.createElement("div", {
        className: "row-list"
      }, DATA.HOLDINGS.map(h => {
        const q = prices['US:' + h.ticker];
        return React.createElement("button", {
          key: h.ticker,
          className: "row",
          onClick: () => onOpenDetail(h.ticker, 'US')
        }, React.createElement("div", {
          className: "row-main"
        }, React.createElement("div", {
          className: "row-head"
        }, React.createElement("span", {
          className: "tkr"
        }, h.ticker), React.createElement("span", {
          className: "text-sm text-dim"
        }, h.name)), React.createElement("div", {
          className: "row-meta"
        }, h.sector)), React.createElement("div", {
          className: "row-right"
        }, React.createElement(PriceBlock, {
          quote: q
        }), React.createElement("div", {
          className: "mt-1"
        }, React.createElement("span", {
          className: `pill pill-${h.actionType}`
        }, h.action))));
      })), React.createElement("div", {
        className: "empty mt-4"
      }, React.createElement("h3", null, "No US positions yet"), React.createElement("p", null, "Add your US holdings in the Dashboard tab to see live P&L here.")));
    }
    return React.createElement("div", null, React.createElement("div", {
      className: "eyebrow"
    }, "Your US positions"), React.createElement("div", {
      className: "row-list mb-4"
    }, usdPositions.map(p => {
      const q = prices['US:' + p.ticker];
      const info = DATA.findInfo(p.ticker, 'US');
      const marketValue = q ? p.shares * q.price : null;
      const cost = p.shares * p.costBasis;
      const pnlPct = marketValue != null && cost > 0 ? (marketValue - cost) / cost * 100 : null;
      return React.createElement("button", {
        key: p.id,
        className: "row",
        onClick: () => onOpenDetail(p.ticker, 'US')
      }, React.createElement("div", {
        className: "row-main"
      }, React.createElement("div", {
        className: "row-head"
      }, React.createElement("span", {
        className: "tkr"
      }, p.ticker), React.createElement("span", {
        className: "text-sm text-dim"
      }, info.name || p.ticker)), React.createElement("div", {
        className: "row-meta"
      }, p.shares, " \xD7 ", fmt(p.costBasis, 'US'), pnlPct != null && React.createElement("span", {
        className: `mono ${pnlPct >= 0 ? 'text-up' : 'text-down'}`
      }, " \xB7 ", pnlPct >= 0 ? '+' : '', pnlPct.toFixed(2), "%"))), React.createElement("div", {
        className: "row-right"
      }, React.createElement(PriceBlock, {
        quote: q
      }), marketValue != null && React.createElement("div", {
        className: "text-xs text-dim mt-1 mono"
      }, fmt(marketValue, 'US'))));
    })), React.createElement("div", {
      className: "eyebrow"
    }, "Playbook reference"), React.createElement("div", {
      className: "row-list"
    }, DATA.HOLDINGS.filter(h => !usdPositions.some(p => p.ticker === h.ticker)).map(h => {
      const q = prices['US:' + h.ticker];
      return React.createElement("button", {
        key: h.ticker,
        className: "row",
        onClick: () => onOpenDetail(h.ticker, 'US')
      }, React.createElement("div", {
        className: "row-main"
      }, React.createElement("div", {
        className: "row-head"
      }, React.createElement("span", {
        className: "tkr"
      }, h.ticker), React.createElement("span", {
        className: "text-sm text-dim"
      }, h.name)), React.createElement("div", {
        className: "row-meta"
      }, h.sector)), React.createElement("div", {
        className: "row-right"
      }, React.createElement(PriceBlock, {
        quote: q
      }), React.createElement("div", {
        className: "mt-1"
      }, React.createElement("span", {
        className: `pill pill-${h.actionType}`
      }, h.action))));
    })));
  };
  const renderJSE = () => {
    if (zarPositions.length === 0) {
      return React.createElement("div", null, React.createElement("div", {
        className: "empty"
      }, React.createElement(Icon, {
        name: "briefcase",
        size: 40
      }), React.createElement("h3", null, "No JSE positions yet"), React.createElement("p", null, "Add your JSE (ZAR) holdings in the Dashboard tab to see live P&L here.")), React.createElement("div", {
        className: "mt-6"
      }, React.createElement("div", {
        className: "eyebrow"
      }, "Top 40 suggestions"), React.createElement("div", {
        className: "chip-row"
      }, DATA.JSE_SUGGESTIONS.map(s => React.createElement("button", {
        key: s.ticker,
        className: "chip",
        onClick: () => onOpenDetail(s.ticker, 'JSE')
      }, s.ticker, " ", React.createElement("span", {
        className: "chip-sub"
      }, s.name))))));
    }
    return React.createElement("div", null, React.createElement("div", {
      className: "eyebrow"
    }, "Your JSE positions"), React.createElement("div", {
      className: "row-list"
    }, zarPositions.map(p => {
      const q = prices['JSE:' + p.ticker];
      const info = DATA.findInfo(p.ticker, 'JSE');
      const marketValue = q ? p.shares * q.price : null;
      const cost = p.shares * p.costBasis;
      const pnlPct = marketValue != null && cost > 0 ? (marketValue - cost) / cost * 100 : null;
      return React.createElement("button", {
        key: p.id,
        className: "row",
        onClick: () => onOpenDetail(p.ticker, 'JSE')
      }, React.createElement("div", {
        className: "row-main"
      }, React.createElement("div", {
        className: "row-head"
      }, React.createElement("span", {
        className: "tkr"
      }, p.ticker), React.createElement("span", {
        className: "text-sm text-dim"
      }, info.name || p.ticker)), React.createElement("div", {
        className: "row-meta"
      }, p.shares, " \xD7 ", fmt(p.costBasis, 'JSE'), pnlPct != null && React.createElement("span", {
        className: `mono ${pnlPct >= 0 ? 'text-up' : 'text-down'}`
      }, " \xB7 ", pnlPct >= 0 ? '+' : '', pnlPct.toFixed(2), "%"))), React.createElement("div", {
        className: "row-right"
      }, React.createElement(PriceBlock, {
        quote: q
      }), marketValue != null && React.createElement("div", {
        className: "text-xs text-dim mt-1 mono"
      }, fmt(marketValue, 'JSE'))));
    })));
  };
  return React.createElement("div", null, React.createElement("div", {
    className: "flex justify-between items-center mb-3",
    style: {
      gap: 10
    }
  }, React.createElement("div", null, React.createElement("h1", {
    className: "section-title"
  }, "Current"), React.createElement("div", {
    className: "section-desc",
    style: {
      marginBottom: 0
    }
  }, "Live prices for your holdings.")), React.createElement("div", {
    className: "toggle-group"
  }, React.createElement("button", {
    className: `toggle-opt ${marketFilter === 'US' ? 'active' : ''}`,
    onClick: () => setMarketFilter('US')
  }, "US (", usdPositions.length, ")"), React.createElement("button", {
    className: `toggle-opt ${marketFilter === 'JSE' ? 'active' : ''}`,
    onClick: () => setMarketFilter('JSE')
  }, "JSE (", zarPositions.length, ")"))), marketFilter === 'US' ? renderUS() : renderJSE());
}
function WatchlistView(_ref8) {
  let {
    watchlist,
    prices,
    onAdd,
    onRemove,
    onOpenDetail
  } = _ref8;
  const [newTicker, setNewTicker] = useState('');
  const [newMarket, setNewMarket] = useState('US');
  const submit = () => {
    if (!newTicker.trim()) return;
    onAdd(newTicker.trim(), newMarket);
    setNewTicker('');
  };
  return React.createElement("div", null, React.createElement("h1", {
    className: "section-title"
  }, "Watchlist"), React.createElement("div", {
    className: "section-desc"
  }, "Track tickers without a position. US via Yahoo, JSE as ", React.createElement("span", {
    className: "mono text-xs"
  }, ".JO"), " suffix."), React.createElement("div", {
    className: "card mb-4"
  }, React.createElement("div", {
    className: "form-row"
  }, React.createElement("select", {
    value: newMarket,
    onChange: e => setNewMarket(e.target.value),
    style: {
      flex: '0 0 90px'
    }
  }, React.createElement("option", {
    value: "US"
  }, "US"), React.createElement("option", {
    value: "JSE"
  }, "JSE")), React.createElement("input", {
    type: "text",
    placeholder: "Ticker",
    value: newTicker,
    onChange: e => setNewTicker(e.target.value.toUpperCase()),
    onKeyDown: e => {
      if (e.key === 'Enter') submit();
    },
    maxLength: "10",
    autoCapitalize: "characters",
    style: {
      flex: 1
    }
  }), React.createElement("button", {
    className: "btn btn-primary",
    onClick: submit,
    style: {
      flex: '0 0 auto'
    }
  }, React.createElement(Icon, {
    name: "plus"
  }), " Add"))), watchlist.length === 0 ? React.createElement("div", {
    className: "empty"
  }, React.createElement(Icon, {
    name: "eye",
    size: 40
  }), React.createElement("h3", null, "Empty watchlist"), React.createElement("p", null, "Add tickers above to track them live.")) : React.createElement("div", {
    className: "grid grid-2 mb-6"
  }, watchlist.map(w => {
    const q = prices[w.market + ':' + w.ticker];
    return React.createElement("div", {
      key: w.id,
      className: "pos-card",
      onClick: () => onOpenDetail(w.ticker, w.market)
    }, React.createElement("div", {
      className: "pos-head"
    }, React.createElement("div", {
      className: "flex-1"
    }, React.createElement("div", {
      className: "flex items-center gap-2"
    }, React.createElement("span", {
      className: "tkr"
    }, w.ticker), React.createElement("span", {
      className: "market-badge"
    }, w.market))), React.createElement("button", {
      className: "btn btn-ghost btn-xs",
      onClick: e => {
        e.stopPropagation();
        onRemove(w.id);
      },
      "aria-label": "Remove"
    }, React.createElement(Icon, {
      name: "x",
      size: 13
    }))), React.createElement(PriceBlock, {
      quote: q,
      size: "lg"
    }));
  })), React.createElement("div", {
    className: "eyebrow"
  }, "Suggested JSE tickers (tap to view)"), React.createElement("div", {
    className: "chip-row"
  }, DATA.JSE_SUGGESTIONS.map(s => {
    const already = watchlist.some(w => w.ticker === s.ticker && w.market === 'JSE');
    return React.createElement("button", {
      key: s.ticker,
      className: `chip ${already ? 'active' : ''}`,
      onClick: () => {
        if (already) {
          const match = watchlist.find(w => w.ticker === s.ticker && w.market === 'JSE');
          if (match) onRemove(match.id);
        } else {
          onAdd(s.ticker, 'JSE');
        }
      }
    }, s.ticker, React.createElement("span", {
      className: "chip-sub"
    }, s.name));
  })));
}
function PicksView(_ref9) {
  let {
    prices,
    onOpenDetail
  } = _ref9;
  return React.createElement("div", null, React.createElement("h1", {
    className: "section-title"
  }, "New Picks"), React.createElement("div", {
    className: "section-desc"
  }, "Nine positions targeting weighted 27-31% return. Diversified across healthcare, nuclear, defense, cyber, and semi-ADRs."), React.createElement("div", {
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
    }, p.conviction)), React.createElement(PriceBlock, {
      quote: q,
      size: "lg"
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
function HedgesView(_ref0) {
  let {
    prices,
    onOpenDetail
  } = _ref0;
  return React.createElement("div", null, React.createElement("h1", {
    className: "section-title"
  }, "Hedges"), React.createElement("div", {
    className: "section-desc"
  }, "18% allocation to gold, duration, defensive equity, and low-vol. True diversification beats false signal."), React.createElement("div", {
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
      size: "lg"
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
function DeploymentView() {
  return React.createElement("div", null, React.createElement("h1", {
    className: "section-title"
  }, "Deployment"), React.createElement("div", {
    className: "section-desc"
  }, "Four-phase plan through July 2027. Monthly DCA anchored on VOO buy-zone signals."), React.createElement("div", {
    className: "timeline"
  }, DATA.DEPLOYMENT_PHASES.map(p => React.createElement("div", {
    key: p.order,
    className: "timeline-item"
  }, React.createElement("div", {
    className: "timeline-dot"
  }, p.order), React.createElement("div", {
    className: "timeline-content"
  }, React.createElement("div", {
    className: "phase-label"
  }, p.phase), React.createElement("div", {
    className: "phase-title"
  }, p.title), React.createElement("div", {
    className: "card"
  }, React.createElement("ul", {
    className: "bullet-list"
  }, p.actions.map((a, i) => React.createElement("li", {
    key: i
  }, React.createElement("span", null, a))))))))));
}
function RulesView() {
  return React.createElement("div", null, React.createElement("h1", {
    className: "section-title"
  }, "Rules & Risks"), React.createElement("div", {
    className: "section-desc"
  }, "Pre-written discipline beats in-the-moment emotion."), React.createElement("div", {
    className: "eyebrow"
  }, "Trim rules"), React.createElement("div", {
    className: "card mb-4"
  }, React.createElement("ul", {
    className: "bullet-list"
  }, React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "+100% gain"), " \u2014 trim 25% of position, bank profits")), React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "+150% gain"), " \u2014 trim another 20% of remainder")), React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "+200% gain"), " \u2014 trim another 20%, let the rest ride")), React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "-20% from cost"), " \u2014 re-examine thesis, never average down without fresh conviction")), React.createElement("li", null, React.createElement("span", null, React.createElement("strong", null, "Position >12% of book"), " \u2014 trim to 10% regardless of gain")))), React.createElement("div", {
    className: "eyebrow"
  }, "Thesis-break triggers"), React.createElement("div", {
    className: "card mb-4"
  }, React.createElement("ul", {
    className: "bullet-list"
  }, React.createElement("li", null, React.createElement("span", null, "Hyperscaler capex cut by top-3 player (MSFT, GOOGL, META, AMZN, ORCL)")), React.createElement("li", null, React.createElement("span", null, "Core CPI above 3.2% for two consecutive prints")), React.createElement("li", null, React.createElement("span", null, "Brent above $120 \u2014 consumer weakness trigger")), React.createElement("li", null, React.createElement("span", null, "VOO drawdown >15% from buy-zone \u2014 deploy all cash")), React.createElement("li", null, React.createElement("span", null, "Any position where CEO reneges on publicly-stated commitment (the MSTR lesson)")))), React.createElement("div", {
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
  }, r.impact)))), React.createElement("div", {
    className: "eyebrow"
  }, "SA tax-year discipline"), React.createElement("div", {
    className: "card"
  }, React.createElement("ul", {
    className: "bullet-list"
  }, React.createElement("li", null, React.createElement("span", null, "Tax year ends 28 February. Split disposals across 28 Feb + 1 March for two annual R40k CGT exclusions.")), React.createElement("li", null, React.createElement("span", null, "Combined shelter: up to R80k of gains untaxed per year.")), React.createElement("li", null, React.createElement("span", null, "At 40% marginal rate with 40% inclusion, each exclusion = ~R12,800 saved.")), React.createElement("li", null, React.createElement("span", null, "Keep broker IT3(c) certificates for each tax year.")))));
}
function OverviewView(_ref1) {
  let {
    prices
  } = _ref1;
  return React.createElement("div", null, React.createElement("h1", {
    className: "section-title"
  }, "Thesis"), React.createElement("p", {
    className: "section-desc",
    style: {
      fontSize: 16,
      lineHeight: 1.5
    }
  }, "The next 12-16 months are not about finding the next NVDA. They are about ", React.createElement("strong", null, "defending existing gains"), " while redeploying into under-owned, fundamentally-strong sectors."), React.createElement("div", {
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
  }, ['NVDA', 'GOOGL', 'C', 'ASML'].map(t => {
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
      quote: q
    }));
  }))));
}
function DetailModal(_ref10) {
  let {
    selected,
    prices,
    alerts,
    news,
    onClose,
    onAddAlert,
    onRemoveAlert,
    onLoadNews
  } = _ref10;
  const {
    ticker,
    market
  } = selected;
  const info = DATA.findInfo(ticker, market);
  const quote = prices[market + ':' + ticker];
  const ccy = market === 'JSE' ? 'ZAR' : 'USD';
  const [dir, setDir] = useState('above');
  const [target, setTarget] = useState(quote ? quote.price.toFixed(2) : '');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (quote && !target) setTarget(quote.price.toFixed(2));
  }, [quote]);
  const submitAlert = () => {
    const t = parseFloat(target);
    if (!isFinite(t) || t <= 0) return;
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
    className: "modal-panel"
  }, React.createElement("div", {
    className: "modal-handle"
  }), React.createElement("div", {
    className: "modal-header"
  }, React.createElement("div", null, React.createElement("div", {
    className: "modal-title"
  }, ticker), React.createElement("div", {
    className: "modal-subtitle"
  }, info.name || ticker, " \xB7 ", React.createElement("span", {
    className: "market-badge"
  }, market))), React.createElement("button", {
    className: "modal-close",
    onClick: onClose,
    "aria-label": "Close"
  }, React.createElement(Icon, {
    name: "x"
  }))), React.createElement("div", {
    className: "modal-body"
  }, React.createElement(PriceBlock, {
    quote: quote,
    size: "xl"
  }), info.entryPrice && React.createElement("div", {
    className: "kv-row"
  }, React.createElement("div", {
    className: "kv"
  }, React.createElement("div", {
    className: "kv-label"
  }, "Entry"), React.createElement("div", {
    className: "kv-val"
  }, fmt(info.entryPrice, market))), info.targetPrice && React.createElement("div", {
    className: "kv"
  }, React.createElement("div", {
    className: "kv-label"
  }, "Target"), React.createElement("div", {
    className: "kv-val"
  }, fmt(info.targetPrice, market))), info.upside != null && React.createElement("div", {
    className: "kv"
  }, React.createElement("div", {
    className: "kv-label"
  }, "Upside"), React.createElement("div", {
    className: "kv-val up"
  }, "+", info.upside, "%"))), info.action && React.createElement("div", null, React.createElement("span", {
    className: `pill pill-lg pill-${info.actionType || 'hold'}`
  }, info.action)), info.thesis && React.createElement("div", null, React.createElement("div", {
    className: "eyebrow"
  }, "Thesis"), React.createElement("div", {
    className: "thesis-text text-sm text-muted",
    style: {
      lineHeight: 1.6
    }
  }, info.thesis)), info.catalysts && info.catalysts.length > 0 && React.createElement("div", null, React.createElement("div", {
    className: "eyebrow"
  }, "Catalysts"), React.createElement("ul", {
    className: "bullet-list"
  }, info.catalysts.map((c, i) => React.createElement("li", {
    key: i
  }, React.createElement("span", null, c))))), info.risks && info.risks.length > 0 && React.createElement("div", null, React.createElement("div", {
    className: "eyebrow"
  }, "Risks"), React.createElement("ul", {
    className: "bullet-list"
  }, info.risks.map((r, i) => React.createElement("li", {
    key: i
  }, React.createElement("span", null, r))))), info.trimLevels && info.trimLevels.length > 0 && React.createElement("div", null, React.createElement("div", {
    className: "eyebrow"
  }, "Trim ladder"), React.createElement("ul", {
    className: "bullet-list"
  }, info.trimLevels.map((t, i) => React.createElement("li", {
    key: i
  }, React.createElement("span", null, t))))), React.createElement("div", null, React.createElement("div", {
    className: "eyebrow",
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    }
  }, React.createElement("span", null, "Price alerts"), React.createElement("span", {
    className: "text-xs"
  }, alerts.length, " active")), alerts.length > 0 && React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      marginBottom: 12
    }
  }, alerts.map(a => React.createElement("div", {
    key: a.id,
    className: "alert-item"
  }, React.createElement("div", null, React.createElement("div", {
    className: "mono text-sm"
  }, a.direction === 'above' ? '↑ above ' : '↓ below ', fmt(a.targetPrice, market)), a.note && React.createElement("div", {
    className: "text-xs text-dim mt-1"
  }, a.note)), React.createElement("button", {
    className: "btn btn-ghost btn-xs",
    onClick: () => onRemoveAlert(a.id),
    "aria-label": "Remove"
  }, React.createElement(Icon, {
    name: "x",
    size: 12
  }))))), React.createElement("div", {
    className: "card"
  }, React.createElement("div", {
    className: "form-row mb-2"
  }, React.createElement("select", {
    value: dir,
    onChange: e => setDir(e.target.value),
    style: {
      flex: '0 0 110px'
    }
  }, React.createElement("option", {
    value: "above"
  }, "\u2191 above"), React.createElement("option", {
    value: "below"
  }, "\u2193 below")), React.createElement("div", {
    className: "input-prefix-wrap",
    style: {
      flex: 1
    }
  }, React.createElement("span", {
    className: "prefix"
  }, ccy === 'ZAR' ? 'R' : '$'), React.createElement("input", {
    type: "number",
    inputMode: "decimal",
    step: "0.01",
    placeholder: "Target",
    value: target,
    onChange: e => setTarget(e.target.value)
  }))), React.createElement("input", {
    type: "text",
    placeholder: "Note (optional)",
    value: note,
    onChange: e => setNote(e.target.value),
    maxLength: "80",
    style: {
      fontFamily: 'var(--sans)',
      fontSize: 14
    }
  }), React.createElement("button", {
    className: "btn btn-primary btn-block mt-3",
    onClick: submitAlert
  }, React.createElement(Icon, {
    name: "plus"
  }), " Set alert"))), React.createElement("div", null, React.createElement("div", {
    className: "eyebrow",
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    }
  }, React.createElement("span", null, "News"), news?.loading && React.createElement("span", {
    className: "text-xs"
  }, "Loading\u2026")), news && news.items && news.items.length > 0 ? React.createElement("div", null, news.items.map((n, i) => React.createElement("a", {
    key: i,
    href: n.link,
    target: "_blank",
    rel: "noopener",
    className: "news-item"
  }, React.createElement("div", {
    className: "news-title"
  }, n.title), React.createElement("div", {
    className: "news-meta"
  }, React.createElement("span", null, n.source), n.pubDate && React.createElement(React.Fragment, null, React.createElement("span", null, "\xB7"), React.createElement("span", null, timeAgo(n.pubDate))), React.createElement(Icon, {
    name: "external",
    size: 11
  }))))) : React.createElement("div", {
    className: "text-sm text-dim"
  }, news?.loading ? 'Fetching headlines…' : 'No recent headlines found. Yahoo Finance RSS may be rate-limited — try again later.')))));
}
function AlertsModal(_ref11) {
  let {
    alerts,
    triggered,
    notifPerm,
    onClose,
    onRemoveAlert,
    onClearTriggered,
    onRequestPerm
  } = _ref11;
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
    className: "modal-panel"
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
  }, "Alerts fire when the app is open or recently backgrounded. For reliable lock-screen delivery, keep the app open or recently used.")) : notifPerm === 'denied' ? React.createElement("div", {
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
  }, "This browser doesn't support web notifications. Alerts will still show as in-app toasts.")), React.createElement("div", null, React.createElement("div", {
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
    className: "alert-item"
  }, React.createElement("div", null, React.createElement("div", null, React.createElement("span", {
    className: "tkr-sm"
  }, t.ticker), " ", React.createElement("span", {
    className: "market-badge"
  }, t.market), " ", React.createElement("span", {
    className: "mono text-sm"
  }, t.direction === 'above' ? '↑ ' : '↓ ', fmt(t.targetPrice, t.market))), React.createElement("div", {
    className: "text-xs text-dim mt-1"
  }, timeAgo(t.triggeredAt), " \xB7 hit at ", fmt(t.triggerPrice, t.market))))))), React.createElement("div", null, React.createElement("div", {
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
    className: "alert-item"
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
    onClick: () => onRemoveAlert(a.id),
    "aria-label": "Remove"
  }, React.createElement(Icon, {
    name: "x",
    size: 12
  })))))))));
}
function PositionModal(_ref12) {
  let {
    editId,
    existing,
    onClose,
    onSave
  } = _ref12;
  const isEdit = !!editId;
  const [ticker, setTicker] = useState(existing?.ticker || '');
  const [market, setMarket] = useState(existing?.market || 'US');
  const [shares, setShares] = useState(existing?.shares?.toString() || '');
  const [costBasis, setCostBasis] = useState(existing?.costBasis?.toString() || '');
  const [notes, setNotes] = useState(existing?.notes || '');
  const submit = () => {
    if (!ticker.trim()) return;
    const s = parseFloat(shares);
    const c = parseFloat(costBasis);
    if (!isFinite(s) || s <= 0) return;
    if (!isFinite(c) || c <= 0) return;
    onSave({
      ticker: ticker.trim().toUpperCase(),
      market,
      shares: s,
      costBasis: c,
      notes
    });
  };
  const ccy = market === 'JSE' ? 'R' : '$';
  return React.createElement("div", {
    className: "modal"
  }, React.createElement("div", {
    className: "modal-backdrop",
    onClick: onClose
  }), React.createElement("div", {
    className: "modal-panel",
    style: {
      maxWidth: 480
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
  }, "Market"), React.createElement("select", {
    value: market,
    onChange: e => setMarket(e.target.value),
    disabled: isEdit
  }, React.createElement("option", {
    value: "US"
  }, "US (USD)"), React.createElement("option", {
    value: "JSE"
  }, "JSE (ZAR)"))), React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Ticker"), React.createElement("input", {
    type: "text",
    placeholder: market === 'JSE' ? 'e.g. NPN' : 'e.g. NVDA',
    value: ticker,
    onChange: e => setTicker(e.target.value.toUpperCase()),
    maxLength: "10",
    autoCapitalize: "characters",
    disabled: isEdit
  })), React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Shares"), React.createElement("input", {
    type: "number",
    inputMode: "decimal",
    step: "0.0001",
    min: "0",
    placeholder: "10",
    value: shares,
    onChange: e => setShares(e.target.value)
  })), React.createElement("div", {
    className: "form-group"
  }, React.createElement("label", {
    className: "form-label"
  }, "Cost basis per share"), React.createElement("div", {
    className: "input-prefix-wrap"
  }, React.createElement("span", {
    className: "prefix"
  }, ccy), React.createElement("input", {
    type: "number",
    inputMode: "decimal",
    step: "0.01",
    min: "0",
    placeholder: "0.00",
    value: costBasis,
    onChange: e => setCostBasis(e.target.value)
  })), React.createElement("div", {
    className: "form-help"
  }, "What you paid per share (your average if you bought in tranches).")), React.createElement("div", {
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
    onClick: submit
  }, isEdit ? 'Save changes' : 'Add position')))));
}
function InstallBanner(_ref13) {
  let {
    isIOS,
    onInstall,
    onDismiss,
    canPrompt
  } = _ref13;
  return React.createElement("div", {
    className: "install-banner"
  }, React.createElement("div", {
    className: "ib-icon"
  }, React.createElement(Icon, {
    name: "download",
    size: 18
  })), React.createElement("div", {
    className: "ib-text"
  }, React.createElement("b", null, "Install Playbook"), React.createElement("small", null, isIOS ? 'Tap Share → Add to Home Screen for full-screen & notifications' : 'Install for price alerts & notifications')), !isIOS && canPrompt && React.createElement("button", {
    className: "btn btn-primary btn-sm",
    onClick: onInstall
  }, "Install"), React.createElement("button", {
    className: "icon-btn",
    onClick: onDismiss,
    style: {
      width: 30,
      height: 30
    },
    "aria-label": "Close"
  }, React.createElement(Icon, {
    name: "x",
    size: 12
  })));
}
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(ToastProvider, null, React.createElement(App, null)));
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      console.log('SW registered:', reg.scope);
    }).catch(err => {
      console.warn('SW registration failed:', err);
    });
  });
}