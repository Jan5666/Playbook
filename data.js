// Playbook reference data — used by the app for thesis lookups, suggestions, etc.
window.PB_DATA = {
  HOLDINGS: [
    { ticker:'GOOGL', name:'Alphabet', sector:'AI / Cloud', action:'HOLD FULL', actionType:'hold', conviction:'HIGH',
      thesis:'PEG below 1, Cloud growing over 50%, antitrust overhang removed April 8 with behavioral-only remedies. TPU silicon is a structural moat. Best long-term compounder in the book.',
      catalysts:['Cloud growth sustainability above 50%','Gemini monetization ramp','TPU silicon adoption','YouTube Shorts monetization'],
      risks:['AI capex digestion concerns','Regulatory pressure in EU','Search cannibalization from AI'],
      trimLevels:['$385 — Trim 20%','$430 — Trim another 20%','$265 — Reassess (close below)'] },
    { ticker:'AMZN', name:'Amazon', sector:'AI / Cloud', action:'HOLD, ADD ON DIPS', actionType:'hold', conviction:'HIGH',
      thesis:'AWS re-accelerating +24%. Capex peak 2027 with FCF inflection to follow. Retail margin expansion underappreciated.',
      catalysts:['AWS growth re-acceleration','Advertising ramp','Capex peak and FCF inflection 2027'],
      risks:['$200B capex vs negative FCF','Retail margin pressure','Anthropic investment dilution'] },
    { ticker:'ASML', name:'ASML Holding', sector:'Semi Equipment', action:'TRIM 25%', actionType:'trim', conviction:'MEDIUM',
      thesis:'Q1 beat but 2027 EUV volumes disappointed. MATCH Act overhang. Monopoly intact but growth deceleration priced in.',
      catalysts:['High-NA EUV adoption','China export controls clarity','TSMC capex flow-through'],
      risks:['2027 EUV order visibility','MATCH Act US restrictions','Cyclical semi slowdown'],
      trimLevels:['$1500 — Trim 25% (now)','$1700 — Trim another 15%','$1260 — Reassess','$1100 — Hard exit'] },
    { ticker:'ASPI', name:'ASP Isotopes', sector:'Speculative', action:'SELL ALL', actionType:'sell', conviction:'HIGH',
      thesis:'Pre-revenue, -$175M net loss, guaranteed dilution. Harvest the loss for SA CGT offset against Citigroup trims this tax year.',
      catalysts:['None material near-term'], risks:['Dilution certainty','Pre-revenue execution'] },
    { ticker:'BRK-B', name:'Berkshire Hathaway', sector:'Diversified', action:'HOLD', actionType:'hold', conviction:'MEDIUM',
      thesis:'Abel buybacks resumed at P/B 1.42. Cash pile $373-381B provides optionality. Defensive ballast.',
      catalysts:['Capital deployment from $373B cash','Abel M&A activity','Buyback resumption'],
      risks:['Succession execution','Insurance cycle turn'] },
    { ticker:'C', name:'Citigroup', sector:'Financials', action:'TRIM 20%', actionType:'trim', conviction:'HIGH',
      thesis:'At 52-week high post Q1 blowout. P/TBV still 0.95x so ride remainder through Investor Day 7 May and Banamex monetization.',
      catalysts:['Investor Day 7 May','Banamex IPO monetization','ROTCE target progress'],
      risks:['Credit cycle turn','Consensus PT $132-135 barely above spot'],
      trimLevels:['$130 — Trim 20% (now)','$150 — Trim another 15%','$108 — Reassess'] },
    { ticker:'CEG', name:'Constellation Energy', sector:'Nuclear Power', action:'ADD / BUILD', actionType:'buy', conviction:'HIGH',
      thesis:'Core nuclear-AI holding. Largest US carbon-free generator with PPAs to Microsoft, Meta, Google. Target $385 (+32%).',
      catalysts:['Q2-Q3 hyperscaler PPA announcements','PJM capacity auction reset','Crane restart progress'],
      risks:['FERC rulings on behind-the-meter','AI-utility multiple compression'] },
    { ticker:'ETN', name:'Eaton', sector:'Industrials', action:'HOLD, NO ADDS', actionType:'hold', conviction:'MEDIUM',
      thesis:'Data center electrification beneficiary but 2026 margins face 130 bps headwind. Valuation demanding.',
      catalysts:['Data center orders backlog','Aerospace segment margins'],
      risks:['Margin compression 2026','Demanding valuation'] },
    { ticker:'NBIS', name:'Nebius Group', sector:'AI Infrastructure', action:'TRIM 33%', actionType:'trim', conviction:'HIGH',
      thesis:'Parabolic move. $16-20B capex vs only $3B revenue. Meta deal revenue starts 2027+. Dilution guaranteed.',
      catalysts:['Meta contract revenue 2027+','GPU capacity expansion'],
      risks:['$16-20B capex vs $3B revenue','Guaranteed equity dilution'],
      trimLevels:['$168 — Trim 33% (now)','$220 — Trim another 1/3','$120 — Reassess','$95 — Hard exit'] },
    { ticker:'NVDA', name:'NVIDIA', sector:'AI Semi', action:'TRIM 15%', actionType:'trim', conviction:'HIGH',
      thesis:'Still cheapest mega-cap AI on PEG 0.63, but $4.9T cap and 138% gain demand position-size discipline. Trim is about risk not thesis.',
      catalysts:['Blackwell Ultra ramp','Rubin architecture 2026','Sovereign AI deals'],
      risks:['AI capex digestion','China export restrictions','Position concentration'],
      trimLevels:['$215 — Trim 15% (now)','$265 — Trim another 15%','$170 — Reassess'] },
    { ticker:'OXY', name:'Occidental Petroleum', sector:'Energy', action:'TRIM 25-30%', actionType:'trim', conviction:'MEDIUM',
      thesis:'+60% YTD after OxyChem sale. Most catalyst priced in. Keep smaller position for oil hedge and Stratos DAC optionality.',
      catalysts:['Stratos DAC commissioning','Buffett continued accumulation'],
      risks:['Oil price reversal','DAC execution risk'] },
    { ticker:'MSTR', name:'Strategy', sector:'Bitcoin Proxy', action:'SELL 50-100%', actionType:'sell', conviction:'HIGH',
      thesis:'Single weakest holding. mNAV premium vanished. Dilution compounding. IBIT is cleaner BTC proxy.',
      catalysts:['None improving the thesis'],
      risks:['mNAV below 1 diluted','Dilution spiral','CEO broke never-sell pledge'],
      trimLevels:['$156 — Sell 50% now','$180 — Exit remaining','$120 — Full exit'] }
  ],
  NEW_PICKS: [
    { ticker:'CEG', name:'Constellation Energy', sector:'Nuclear Power', conviction:'HIGH', allocation:10, entryPrice:292, targetPrice:385, upside:32,
      thesis:'Largest US carbon-free generator with long-term PPAs to Microsoft, Meta, and Google.',
      catalysts:['Q2-Q3 PPA announcements','PJM capacity auction reset'], risks:['FERC rulings','Multiple compression'] },
    { ticker:'TSM', name:'Taiwan Semi', sector:'Foundry', conviction:'HIGH', allocation:10, entryPrice:378, targetPrice:475, upside:26,
      thesis:'Sole 3nm/2nm producer. Apple, Nvidia, AMD dependent. Arizona fabs de-risk geography.',
      catalysts:['3nm volume ramp','Arizona Fab 21 ramp','Pricing power'], risks:['Taiwan geopolitical risk','Cyclical semi'] },
    { ticker:'UNH', name:'UnitedHealth', sector:'Healthcare', conviction:'HIGH', allocation:9, entryPrice:314, targetPrice:460, upside:46,
      thesis:'Deeply oversold on MLR concerns. Integrated model still structural winner. Bradshaw cleanup underway.',
      catalysts:['MLR normalization 2026','Optum margin expansion','Regulatory clarity'],
      risks:['Medicare Advantage rate cuts','DOJ investigations'] },
    { ticker:'VRTX', name:'Vertex Pharma', sector:'Biotech', conviction:'HIGH', allocation:8, entryPrice:439, targetPrice:560, upside:28,
      thesis:'CF monopoly. Casgevy launch. Non-opioid pain pill Journavx US launch 2025. Pipeline diversification real.',
      catalysts:['Journavx uptake','Casgevy scaling','Pipeline readouts'],
      risks:['Pricing pressure','Pipeline setbacks'] },
    { ticker:'GEV', name:'GE Vernova', sector:'Power Infra', conviction:'MEDIUM-HIGH', allocation:6, entryPrice:965, targetPrice:1250, upside:30,
      thesis:'Electrification pure-play. Gas turbine orders booked to 2028. Grid solutions backlog record.',
      catalysts:['Grid spend acceleration','Gas turbine backlog','SMR optionality'],
      risks:['Wind segment drag','Valuation expanded'] },
    { ticker:'CRWD', name:'CrowdStrike', sector:'Cybersecurity', conviction:'MEDIUM-HIGH', allocation:6, entryPrice:405, targetPrice:510, upside:26,
      thesis:'Post-incident rebuild complete. Falcon Flex adoption. AI-SOC leader. Margins re-expanding.',
      catalysts:['Net new ARR re-acceleration','Cloud security share gains','Flex adoption'],
      risks:['Competition from SentinelOne','Macro IT spend'] },
    { ticker:'LLY', name:'Eli Lilly', sector:'Pharma', conviction:'MEDIUM-HIGH', allocation:6, entryPrice:935, targetPrice:1180, upside:26,
      thesis:'GLP-1 supply catch-up. Oral orforglipron in pivotal trials. Pipeline depth beyond obesity.',
      catalysts:['Orforglipron Ph3 readouts','Manufacturing capacity online','Alzheimer drug kisunla'],
      risks:['Competition from Novo','Compounding knockoffs'] },
    { ticker:'GD', name:'General Dynamics', sector:'Defense', conviction:'MEDIUM-HIGH', allocation:5, entryPrice:340, targetPrice:410, upside:21,
      thesis:'Submarine and Gulfstream franchises. NATO spending commitments firm. Valuation reasonable.',
      catalysts:['Columbia-class submarine ramp','G700/G800 deliveries','NATO 3%+ GDP'],
      risks:['Program execution','Budget continuing resolution'] },
    { ticker:'ITA', name:'iShares US Aerospace & Defense', sector:'Defense ETF', conviction:'MEDIUM', allocation:3, entryPrice:234, targetPrice:290, upside:24,
      thesis:'Diversified defense exposure without single-name risk. Structural tailwind from global rearmament.',
      catalysts:['NATO spending','Global defense budget growth'], risks:['Policy reversals','Consolidation premium fade'] }
  ],
  HEDGES: [
    { ticker:'IAU', name:'iShares Gold Trust', allocation:6, role:'Physical gold', rationale:'0.25% fee vs GLD 0.40%. Gold +49% 1-yr. True non-correlated hedge.' },
    { ticker:'IEF', name:'iShares 7-10yr Treasury', allocation:5, role:'Intermediate duration', rationale:'Avoids TLT 17-yr duration risk. ~4% yield.' },
    { ticker:'XLV', name:'Health Care Select Sector', allocation:4, role:'Defensive equity', rationale:'Underowned, undervalued. Aging demographic plus GLP-1 tailwind.' },
    { ticker:'USMV', name:'iShares MSCI USA Min Vol', allocation:3, role:'Low-vol equity', rationale:'0.15% fee beats SPLV. Stays invested with lower drawdown.' }
  ],
  JSE_SUGGESTIONS: [
    {ticker:'NPN',name:'Naspers'},{ticker:'PRX',name:'Prosus'},{ticker:'BHG',name:'BHP Group'},
    {ticker:'AGL',name:'Anglo American'},{ticker:'GLN',name:'Glencore'},{ticker:'CPI',name:'Capitec'},
    {ticker:'FSR',name:'FirstRand'},{ticker:'SBK',name:'Standard Bank'},{ticker:'SHP',name:'Shoprite'},
    {ticker:'CFR',name:'Richemont'},{ticker:'MTN',name:'MTN Group'},{ticker:'VOD',name:'Vodacom'},
    {ticker:'SOL',name:'Sasol'},{ticker:'GFI',name:'Gold Fields'},{ticker:'ANG',name:'AngloGold Ashanti'},
    {ticker:'IMP',name:'Impala Platinum'},{ticker:'AMS',name:'Anglo Plat'},{ticker:'SSW',name:'Sibanye-Stillwater'},
    {ticker:'NED',name:'Nedbank'},{ticker:'ABG',name:'Absa Group'},{ticker:'INP',name:'Investec plc'},
    {ticker:'DSY',name:'Discovery'},{ticker:'SLM',name:'Sanlam'},{ticker:'OMU',name:'Old Mutual'}
  ],
  LSE_SUGGESTIONS: [
    {ticker:'HSBA',name:'HSBC Holdings'},{ticker:'BP',name:'BP plc'},{ticker:'SHEL',name:'Shell'},
    {ticker:'AZN',name:'AstraZeneca'},{ticker:'GSK',name:'GSK'},{ticker:'ULVR',name:'Unilever'},
    {ticker:'RIO',name:'Rio Tinto'},{ticker:'AAL',name:'Anglo American'},{ticker:'GLEN',name:'Glencore'},
    {ticker:'VOD',name:'Vodafone Group'},{ticker:'BT-A',name:'BT Group'},{ticker:'LLOY',name:'Lloyds Banking'},
    {ticker:'BARC',name:'Barclays'},{ticker:'NWG',name:'NatWest Group'},{ticker:'STAN',name:'Standard Chartered'},
    {ticker:'DGE',name:'Diageo'},{ticker:'REL',name:'RELX'},{ticker:'CPG',name:'Compass Group'},
    {ticker:'WPP',name:'WPP'},{ticker:'EXPN',name:'Experian'},{ticker:'LSE',name:'London Stock Exchange Group'},
    {ticker:'NG',name:'National Grid'},{ticker:'SSE',name:'SSE plc'},{ticker:'BKG',name:'Berkeley Group'}
  ],
  ASX_SUGGESTIONS: [
    {ticker:'CBA',name:'Commonwealth Bank'},{ticker:'BHP',name:'BHP Group'},{ticker:'CSL',name:'CSL Limited'},
    {ticker:'ANZ',name:'ANZ Banking Group'},{ticker:'WBC',name:'Westpac Banking'},{ticker:'NAB',name:'National Australia Bank'},
    {ticker:'WES',name:'Wesfarmers'},{ticker:'WOW',name:'Woolworths Group'},{ticker:'MQG',name:'Macquarie Group'},
    {ticker:'RIO',name:'Rio Tinto'},{ticker:'FMG',name:'Fortescue'},{ticker:'TCL',name:'Transurban'},
    {ticker:'GMG',name:'Goodman Group'},{ticker:'REA',name:'REA Group'},{ticker:'ALL',name:'Aristocrat Leisure'},
    {ticker:'COL',name:'Coles Group'},{ticker:'TLS',name:'Telstra'},{ticker:'XRO',name:'Xero Limited'},
    {ticker:'APX',name:'Appen'},{ticker:'APT',name:'Afterpay'},{ticker:'ZIP',name:'Zip Co'}
  ],
  EU_SUGGESTIONS: [
    {ticker:'ASML',name:'ASML Holding',exchange:'AMS'},{ticker:'PHIA',name:'Philips',exchange:'AMS'},
    {ticker:'INGA',name:'ING Group',exchange:'AMS'},{ticker:'HEIA',name:'Heineken',exchange:'AMS'},
    {ticker:'AIR',name:'Airbus',exchange:'PAR'},{ticker:'TTE',name:'TotalEnergies',exchange:'PAR'},
    {ticker:'SAN',name:'Sanofi',exchange:'PAR'},{ticker:'BNP',name:'BNP Paribas',exchange:'PAR'},
    {ticker:'MC',name:'LVMH',exchange:'PAR'},{ticker:'OR',name:"L'Oréal",exchange:'PAR'},
    {ticker:'SU',name:'Schneider Electric',exchange:'PAR'},{ticker:'AI',name:'Air Liquide',exchange:'PAR'},
    {ticker:'SAP',name:'SAP SE',exchange:'FRA'},{ticker:'SIE',name:'Siemens',exchange:'FRA'},
    {ticker:'ALV',name:'Allianz',exchange:'FRA'},{ticker:'DTE',name:'Deutsche Telekom',exchange:'FRA'},
    {ticker:'BMW',name:'BMW Group',exchange:'FRA'},{ticker:'VOW3',name:'Volkswagen',exchange:'FRA'},
    {ticker:'MBG',name:'Mercedes-Benz',exchange:'FRA'},{ticker:'DBK',name:'Deutsche Bank',exchange:'FRA'},
    {ticker:'BAS',name:'BASF',exchange:'FRA'},{ticker:'BAYN',name:'Bayer',exchange:'FRA'}
  ],
  DEPLOYMENT_PHASES: [
    { order:1, phase:'Phase 1', title:'Immediate (within 10 days)',
      actions:['Sell ASPI full','Sell MSTR 50%','Trim NBIS 33%','Trim Citi 20%','Trim NVDA 15%','Trim ASML 25%','Trim OXY 25-30%','Deploy ~$150 CEG, ~$150 TSM, ~$130 UNH, ~$120 VRTX','Add $100 to hedges','Hold ~$150 as opportunity cash'] },
    { order:2, phase:'Phase 2', title:'Monthly DCA (May 2026 — Jan 2027)',
      actions:['Monthly $150-200: 70% new basket, 20% hedges, 10% cash','VOO >$660: pause','VOO $580-615: deploy extra $150','VOO $550-580: deploy 50% reserve','VOO <$550: deploy all reserves'] },
    { order:3, phase:'Phase 3', title:'Tax-Year Rebalance (Feb 2027)',
      actions:['Split disposals 28 Feb + 1 Mar for two R40k CGT exclusions','Late Feb: trim on valuation','Early Mar: redeploy into underweights','Trim any winner past +100%'] },
    { order:4, phase:'Phase 4', title:'Final Push (Mar — Jul 2027)',
      actions:['Continue monthly DCA','If ahead of 30% by end-2026: shift hedges to 22-25%','Lock in gains through target window'] }
  ],
  RISKS: [
    { title:'Hyperscaler capex cut by top-3 player', probability:'HIGH', impact:'Cut NVDA, AMZN, ETN, CEG, GEV weights 25-50%.' },
    { title:'Iran/oil re-escalation + Hormuz closure', probability:'MEDIUM', impact:'Brent >$120 is threshold. Add to OXY and hedges.' },
    { title:'Fed cannot cut / must hike', probability:'MEDIUM', impact:'Core CPI >3.2% for two prints. Reduce small-cap, prefer IEF.' },
    { title:'AI capex digestion narrative', probability:'MEDIUM-HIGH', impact:'Accelerate NVDA trim to -30%.' }
  ],
  PILLARS: [
    { num:'01', title:'Exit MSTR', body:'Thesis no longer holds. Dilution compounding, mNAV vanished, CEO broke never-sell pledge.', action:'Sell 50-100%' },
    { num:'02', title:'Harvest Winners', body:'Citi +141%, NVDA +138%, Alphabet +110%, ASML +106%. Trim against pre-written rules.', action:'Lock ~$400' },
    { num:'03', title:'Diversify', body:'Into healthcare (UNH, VRTX, LLY), nuclear (CEG), defense (GD, ITA), semi-ADRs (TSM).', action:'8 new picks' }
  ]
};

// Known tickers for sector/name lookups (all exchanges)
window.PB_DATA.findInfo = function(ticker, market) {
  if (market === 'JSE') return window.PB_DATA.JSE_SUGGESTIONS.find(s => s.ticker === ticker) || { ticker, name: ticker };
  if (market === 'LSE') return window.PB_DATA.LSE_SUGGESTIONS.find(s => s.ticker === ticker) || { ticker, name: ticker };
  if (market === 'ASX') return window.PB_DATA.ASX_SUGGESTIONS.find(s => s.ticker === ticker) || { ticker, name: ticker };
  if (market === 'FRA' || market === 'PAR' || market === 'AMS') {
    return window.PB_DATA.EU_SUGGESTIONS.find(s => s.ticker === ticker && s.exchange === market)
      || window.PB_DATA.EU_SUGGESTIONS.find(s => s.ticker === ticker)
      || { ticker, name: ticker };
  }
  return window.PB_DATA.HOLDINGS.find(h => h.ticker === ticker)
    || window.PB_DATA.NEW_PICKS.find(p => p.ticker === ticker)
    || window.PB_DATA.HEDGES.find(h => h.ticker === ticker)
    || { ticker, name: ticker };
};
