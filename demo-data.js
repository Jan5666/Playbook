// Demo portfolio for Preview mode (Settings → Preview). Static, deterministic,
// never written to localStorage — usePortfolio swaps these in read-only while
// pb.previewMode.v1 is on, so the app can be shown without revealing real data.
// Live prices drive all figures; only shares/cost bases/deposits are invented.
// Record shapes mirror what the real mutators write (addPosition/addContribution/
// addTfsaDeposit/addWatch in app.js) so every view reads them unchanged.
(function () {
  const positions = [
    // US — mega-cap tech + a spread of sectors (USD)
    { id: 'demo-nvda', ticker: 'NVDA', market: 'US', shares: 6,  costBasis: 128, name: 'NVIDIA Corporation',    notes: '', purchaseDate: '2024-09-12', addedAt: '2024-09-12T09:00:00.000Z', fxRateAtCost: 1, fxBase: 'USD' },
    { id: 'demo-msft', ticker: 'MSFT', market: 'US', shares: 5,  costBasis: 390, name: 'Microsoft Corporation', notes: '', purchaseDate: '2024-10-03', addedAt: '2024-10-03T09:00:00.000Z', fxRateAtCost: 1, fxBase: 'USD' },
    { id: 'demo-aapl', ticker: 'AAPL', market: 'US', shares: 10, costBasis: 195, name: 'Apple Inc.',            notes: '', purchaseDate: '2024-11-20', addedAt: '2024-11-20T09:00:00.000Z', fxRateAtCost: 1, fxBase: 'USD' },
    { id: 'demo-tsla', ticker: 'TSLA', market: 'US', shares: 8,  costBasis: 290, name: 'Tesla, Inc.',           notes: '', purchaseDate: '2025-01-15', addedAt: '2025-01-15T09:00:00.000Z', fxRateAtCost: 1, fxBase: 'USD' },
    { id: 'demo-amzn', ticker: 'AMZN', market: 'US', shares: 6,  costBasis: 185, name: 'Amazon.com, Inc.',      notes: '', purchaseDate: '2025-02-27', addedAt: '2025-02-27T09:00:00.000Z', fxRateAtCost: 1, fxBase: 'USD' },
    { id: 'demo-jpm',  ticker: 'JPM',  market: 'US', shares: 4,  costBasis: 230, name: 'JPMorgan Chase & Co.',  notes: '', purchaseDate: '2025-04-08', addedAt: '2025-04-08T09:00:00.000Z', fxRateAtCost: 1, fxBase: 'USD' },
    { id: 'demo-lly',  ticker: 'LLY',  market: 'US', shares: 2,  costBasis: 750, name: 'Eli Lilly and Company', notes: '', purchaseDate: '2025-06-19', addedAt: '2025-06-19T09:00:00.000Z', fxRateAtCost: 1, fxBase: 'USD' },
    { id: 'demo-xom',  ticker: 'XOM',  market: 'US', shares: 10, costBasis: 112, name: 'Exxon Mobil Corporation', notes: '', purchaseDate: '2025-08-11', addedAt: '2025-08-11T09:00:00.000Z', fxRateAtCost: 1, fxBase: 'USD' },
    // LSE (GBP)
    { id: 'demo-azn',  ticker: 'AZN',  market: 'LSE', shares: 20, costBasis: 110, name: 'AstraZeneca PLC', notes: '', purchaseDate: '2025-03-14', addedAt: '2025-03-14T09:00:00.000Z', fxRateAtCost: 0.79, fxBase: 'USD' },
    { id: 'demo-shel', ticker: 'SHEL', market: 'LSE', shares: 40, costBasis: 26,  name: 'Shell plc',       notes: '', purchaseDate: '2025-05-22', addedAt: '2025-05-22T09:00:00.000Z', fxRateAtCost: 0.78, fxBase: 'USD' },
    // JSE (ZAR)
    { id: 'demo-npn',  ticker: 'NPN',  market: 'JSE', shares: 4,  costBasis: 3800, name: 'Naspers Limited', notes: '', purchaseDate: '2025-01-30', addedAt: '2025-01-30T09:00:00.000Z', fxRateAtCost: 18.6, fxBase: 'USD' },
    { id: 'demo-sol',  ticker: 'SOL',  market: 'JSE', shares: 60, costBasis: 140,  name: 'Sasol Limited',   notes: '', purchaseDate: '2025-07-02', addedAt: '2025-07-02T09:00:00.000Z', fxRateAtCost: 17.9, fxBase: 'USD' },
    // TFSA (JSE ETFs, ZAR)
    { id: 'demo-stx40',  ticker: 'STX40',  market: 'TFSA', shares: 120, costBasis: 85, name: 'Satrix Top 40 ETF',     notes: '', purchaseDate: '2025-04-01', addedAt: '2025-04-01T09:00:00.000Z', fxRateAtCost: 18.2, fxBase: 'USD' },
    { id: 'demo-stxwdm', ticker: 'STXWDM', market: 'TFSA', shares: 150, costBasis: 92, name: 'Satrix MSCI World ETF', notes: '', purchaseDate: '2026-03-03', addedAt: '2026-03-03T09:00:00.000Z', fxRateAtCost: 18.0, fxBase: 'USD' },
    // Crypto (USD)
    { id: 'demo-btc', ticker: 'BTC', market: 'CRYPTO', shares: 0.05, costBasis: 65000, name: 'Bitcoin',  notes: '', purchaseDate: '2024-12-10', addedAt: '2024-12-10T09:00:00.000Z', fxRateAtCost: 1, fxBase: 'USD' },
    { id: 'demo-eth', ticker: 'ETH', market: 'CRYPTO', shares: 0.8,  costBasis: 2800,  name: 'Ethereum', notes: '', purchaseDate: '2025-02-05', addedAt: '2025-02-05T09:00:00.000Z', fxRateAtCost: 1, fxBase: 'USD' }
  ];
  const watchlist = [
    { id: 'demo-w1', ticker: 'AMD',  market: 'US',  name: 'Advanced Micro Devices', listIds: ['default'], addedAt: '2025-06-01T09:00:00.000Z' },
    { id: 'demo-w2', ticker: 'PLTR', market: 'US',  name: 'Palantir Technologies',  listIds: ['default'], addedAt: '2025-06-01T09:00:00.000Z' },
    { id: 'demo-w3', ticker: 'COIN', market: 'US',  name: 'Coinbase Global',        listIds: ['default'], addedAt: '2025-06-01T09:00:00.000Z' },
    { id: 'demo-w4', ticker: 'GOOG', market: 'US',  name: 'Alphabet Inc.',          listIds: ['default'], addedAt: '2025-06-01T09:00:00.000Z' },
    { id: 'demo-w5', ticker: 'DSY',  market: 'JSE', name: 'Discovery Limited',      listIds: ['default'], addedAt: '2025-06-01T09:00:00.000Z' }
  ];
  // ~2 years of deposits ≈ $21k committed, so overall return reads sensibly.
  // ZAR entries carry the locked landed-USD rate the growth tracker expects.
  const contributions = [
    { id: 'demo-c1', amount: 5000,  currency: 'USD', date: '2024-08-15', note: '', fxRateAtContrib: 1,    fxBase: 'USD' },
    { id: 'demo-c2', amount: 3000,  currency: 'USD', date: '2024-12-02', note: '', fxRateAtContrib: 1,    fxBase: 'USD' },
    { id: 'demo-c3', amount: 45000, currency: 'ZAR', date: '2025-03-10', note: '', fxRateAtContrib: 18.4, fxBase: 'USD', usdLanded: 2445.65 },
    { id: 'demo-c4', amount: 4000,  currency: 'USD', date: '2025-07-21', note: '', fxRateAtContrib: 1,    fxBase: 'USD' },
    { id: 'demo-c5', amount: 30000, currency: 'ZAR', date: '2025-11-05', note: '', fxRateAtContrib: 17.9, fxBase: 'USD', usdLanded: 1675.98 },
    { id: 'demo-c6', amount: 2500,  currency: 'USD', date: '2026-02-16', note: '', fxRateAtContrib: 1,    fxBase: 'USD' },
    { id: 'demo-c7', amount: 2000,  currency: 'USD', date: '2026-05-04', note: '', fxRateAtContrib: 1,    fxBase: 'USD' }
  ];
  const tfsaDeposits = [
    { id: 'demo-t1', amount: 24000, date: '2025-04-01', note: 'Annual lump sum', source: 'manual' },
    { id: 'demo-t2', amount: 12000, date: '2026-03-03', note: 'New tax year',    source: 'manual' }
  ];
  window.PB_DEMO = { positions, watchlist, contributions, transactions: [], tfsaDeposits };
})();
