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
  TFSA_SUGGESTIONS: [
    {ticker:'STX40',name:'Satrix 40 ETF'},{ticker:'STX500',name:'Satrix 500 ETF'},
    {ticker:'STXNDQ',name:'Satrix Nasdaq 100 ETF'},{ticker:'STXWDM',name:'Satrix World ETF'},
    {ticker:'STXEMG',name:'Satrix Emerging Markets ETF'},{ticker:'STXSWX',name:'Satrix SWIX 40 ETF'},
    {ticker:'STXDIV',name:'Satrix Divi Plus ETF'},{ticker:'STXPRO',name:'Satrix Property ETF'},
    {ticker:'STXIND',name:'Satrix Industrial 25 ETF'},{ticker:'STXFIN',name:'Satrix Financial 15 ETF'},
    {ticker:'STXRES',name:'Satrix Resource 10 ETF'},{ticker:'STXRAF',name:'Satrix RAFI 40 ETF'},
    {ticker:'CSEW40',name:'CoreShares Equal Weight 40 ETF'},{ticker:'CSTOP50',name:'CoreShares Top 50 ETF'},
    {ticker:'CSNDQ',name:'CoreShares Nasdaq 100 ETF'},{ticker:'CSPROP',name:'CoreShares SA Property ETF'},
    {ticker:'CSP500',name:'CoreShares S&P 500 ETF'},{ticker:'GLODIV',name:'CoreShares Global Dividend ETF'},
    {ticker:'NFEMOM',name:'Newfunds Equity Momentum ETF'},{ticker:'NFSWIX',name:'Newfunds SWIX 40 ETF'},
    {ticker:'NFEDEF',name:'Newfunds Equity Defence ETF'},{ticker:'SYG500',name:'Sygnia S&P 500 ETF'},
    {ticker:'SYGSW4',name:'Sygnia SWIX 40 ETF'},{ticker:'SYG4IR',name:'Sygnia 4th Industrial Rev ETF'},
    {ticker:'SYGP',name:'Sygnia Property ETF'},{ticker:'ETFWLD',name:'1nvest World ETF'},
    {ticker:'ETFGRE',name:'1nvest Gold ETF'},{ticker:'ASHT40',name:'Ashburton 1200 ETF'},
    {ticker:'NPN',name:'Naspers'},{ticker:'PRX',name:'Prosus'},{ticker:'CPI',name:'Capitec'},
    {ticker:'FSR',name:'FirstRand'},{ticker:'SBK',name:'Standard Bank'},{ticker:'SHP',name:'Shoprite'},
    {ticker:'CFR',name:'Richemont'},{ticker:'DSY',name:'Discovery'},{ticker:'SLM',name:'Sanlam'},
    {ticker:'GFI',name:'Gold Fields'},{ticker:'ANG',name:'AngloGold Ashanti'},
    {ticker:'NED',name:'Nedbank'},{ticker:'ABG',name:'Absa Group'},{ticker:'MTN',name:'MTN Group'},
    {ticker:'VOD',name:'Vodacom'},{ticker:'SOL',name:'Sasol'},{ticker:'BID',name:'Bid Corp'},
    {ticker:'APN',name:'Aspen Pharmacare'},{ticker:'WHL',name:'Woolworths Holdings'}
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
  ],
  HEATMAPS: [
    { id:'sp500', label:'S&P 500', market:'US', constituents: [
      // Technology
      {t:'AAPL',s:'Technology',i:'Consumer Electronics',m:3600},
      {t:'MSFT',s:'Technology',i:'Software - Infrastructure',m:3400},
      {t:'NVDA',s:'Technology',i:'Semiconductors',m:3300},
      {t:'AVGO',s:'Technology',i:'Semiconductors',m:1100},
      {t:'ORCL',s:'Technology',i:'Software - Infrastructure',m:700},
      {t:'AMD',s:'Technology',i:'Semiconductors',m:360},
      {t:'CRM',s:'Technology',i:'Software - Application',m:250},
      {t:'ADBE',s:'Technology',i:'Software - Infrastructure',m:240},
      {t:'CSCO',s:'Technology',i:'Communication Equipment',m:235},
      {t:'ACN',s:'Technology',i:'Information Technology Services',m:220},
      {t:'NOW',s:'Technology',i:'Software - Application',m:200},
      {t:'IBM',s:'Technology',i:'Information Technology Services',m:210},
      {t:'INTU',s:'Technology',i:'Software - Application',m:185},
      {t:'QCOM',s:'Technology',i:'Semiconductors',m:180},
      {t:'TXN',s:'Technology',i:'Semiconductors',m:165},
      {t:'AMAT',s:'Technology',i:'Semiconductors',m:145},
      {t:'ANET',s:'Technology',i:'Computer Hardware',m:140},
      {t:'PLTR',s:'Technology',i:'Software - Infrastructure',m:240},
      {t:'ADI',s:'Technology',i:'Semiconductors',m:115},
      {t:'MU',s:'Technology',i:'Semiconductors',m:110},
      {t:'APH',s:'Technology',i:'Electronic Components',m:100},
      {t:'LRCX',s:'Technology',i:'Semiconductors',m:100},
      {t:'INTC',s:'Technology',i:'Semiconductors',m:100},
      {t:'CRWD',s:'Technology',i:'Software - Infrastructure',m:100},
      {t:'KLAC',s:'Technology',i:'Semiconductors',m:90},
      {t:'SNPS',s:'Technology',i:'Software - Infrastructure',m:85},
      {t:'CDNS',s:'Technology',i:'Software - Infrastructure',m:80},
      {t:'DELL',s:'Technology',i:'Computer Hardware',m:85},
      {t:'APP',s:'Technology',i:'Software - Application',m:80},
      {t:'GLW',s:'Technology',i:'Electronic Components',m:50},
      {t:'MPWR',s:'Technology',i:'Semiconductors',m:30},
      // Communication Services
      {t:'GOOGL',s:'Communication Services',i:'Internet Content & Information',m:2200},
      {t:'META',s:'Communication Services',i:'Internet Content & Information',m:1500},
      {t:'NFLX',s:'Communication Services',i:'Entertainment',m:350},
      {t:'TMUS',s:'Communication Services',i:'Telecom Services',m:280},
      {t:'DIS',s:'Communication Services',i:'Entertainment',m:200},
      {t:'VZ',s:'Communication Services',i:'Telecom Services',m:180},
      {t:'T',s:'Communication Services',i:'Telecom Services',m:145},
      // Consumer Cyclical
      {t:'AMZN',s:'Consumer Cyclical',i:'Internet Retail',m:2300},
      {t:'TSLA',s:'Consumer Cyclical',i:'Auto Manufacturers',m:1200},
      {t:'HD',s:'Consumer Cyclical',i:'Home Improvement Retail',m:380},
      {t:'MCD',s:'Consumer Cyclical',i:'Restaurants',m:220},
      {t:'BKNG',s:'Consumer Cyclical',i:'Travel Services',m:165},
      {t:'LOW',s:'Consumer Cyclical',i:'Home Improvement Retail',m:145},
      {t:'TJX',s:'Consumer Cyclical',i:'Apparel Retail',m:145},
      {t:'SBUX',s:'Consumer Cyclical',i:'Restaurants',m:120},
      {t:'NKE',s:'Consumer Cyclical',i:'Footwear & Accessories',m:110},
      {t:'ORLY',s:'Consumer Cyclical',i:'Specialty Retail',m:75},
      {t:'AZO',s:'Consumer Cyclical',i:'Specialty Retail',m:60},
      {t:'ROST',s:'Consumer Cyclical',i:'Apparel Retail',m:50},
      // Consumer Defensive
      {t:'WMT',s:'Consumer Defensive',i:'Discount Stores',m:800},
      {t:'COST',s:'Consumer Defensive',i:'Discount Stores',m:440},
      {t:'PG',s:'Consumer Defensive',i:'Household & Personal Products',m:380},
      {t:'KO',s:'Consumer Defensive',i:'Beverages - Non-Alcoholic',m:290},
      {t:'PM',s:'Consumer Defensive',i:'Tobacco',m:220},
      {t:'PEP',s:'Consumer Defensive',i:'Beverages - Non-Alcoholic',m:220},
      {t:'CL',s:'Consumer Defensive',i:'Household & Personal Products',m:75},
      {t:'TGT',s:'Consumer Defensive',i:'Discount Stores',m:70},
      {t:'MO',s:'Consumer Defensive',i:'Tobacco',m:90},
      // Financial Services
      {t:'BRK-B',s:'Financial Services',i:'Insurance - Diversified',m:1100},
      {t:'JPM',s:'Financial Services',i:'Banks - Diversified',m:700},
      {t:'V',s:'Financial Services',i:'Credit Services',m:580},
      {t:'MA',s:'Financial Services',i:'Credit Services',m:450},
      {t:'BAC',s:'Financial Services',i:'Banks - Diversified',m:350},
      {t:'WFC',s:'Financial Services',i:'Banks - Diversified',m:250},
      {t:'AXP',s:'Financial Services',i:'Credit Services',m:220},
      {t:'BX',s:'Financial Services',i:'Asset Management',m:220},
      {t:'MS',s:'Financial Services',i:'Capital Markets',m:220},
      {t:'GS',s:'Financial Services',i:'Capital Markets',m:200},
      {t:'BLK',s:'Financial Services',i:'Asset Management',m:165},
      {t:'PGR',s:'Financial Services',i:'Insurance - Property & Casualty',m:165},
      {t:'SPGI',s:'Financial Services',i:'Financial Data & Stock Exchanges',m:160},
      {t:'KKR',s:'Financial Services',i:'Asset Management',m:140},
      {t:'C',s:'Financial Services',i:'Banks - Diversified',m:130},
      {t:'CB',s:'Financial Services',i:'Insurance - Property & Casualty',m:130},
      {t:'MMC',s:'Financial Services',i:'Insurance Brokers',m:110},
      {t:'ICE',s:'Financial Services',i:'Financial Data & Stock Exchanges',m:95},
      {t:'COF',s:'Financial Services',i:'Credit Services',m:90},
      {t:'MCO',s:'Financial Services',i:'Financial Data & Stock Exchanges',m:90},
      {t:'PNC',s:'Financial Services',i:'Banks - Regional',m:80},
      {t:'AON',s:'Financial Services',i:'Insurance Brokers',m:80},
      // Healthcare
      {t:'LLY',s:'Healthcare',i:'Drug Manufacturers - General',m:720},
      {t:'UNH',s:'Healthcare',i:'Healthcare Plans',m:580},
      {t:'JNJ',s:'Healthcare',i:'Drug Manufacturers - General',m:400},
      {t:'ABBV',s:'Healthcare',i:'Drug Manufacturers - General',m:380},
      {t:'MRK',s:'Healthcare',i:'Drug Manufacturers - General',m:240},
      {t:'ABT',s:'Healthcare',i:'Medical Devices',m:215},
      {t:'TMO',s:'Healthcare',i:'Diagnostics & Research',m:200},
      {t:'DHR',s:'Healthcare',i:'Diagnostics & Research',m:175},
      {t:'AMGN',s:'Healthcare',i:'Drug Manufacturers - General',m:165},
      {t:'PFE',s:'Healthcare',i:'Drug Manufacturers - General',m:145},
      {t:'SYK',s:'Healthcare',i:'Medical Devices',m:145},
      {t:'BSX',s:'Healthcare',i:'Medical Devices',m:130},
      {t:'MDT',s:'Healthcare',i:'Medical Devices',m:130},
      {t:'VRTX',s:'Healthcare',i:'Drug Manufacturers - Specialty',m:120},
      {t:'ELV',s:'Healthcare',i:'Healthcare Plans',m:120},
      {t:'GILD',s:'Healthcare',i:'Drug Manufacturers - General',m:110},
      {t:'BMY',s:'Healthcare',i:'Drug Manufacturers - General',m:110},
      {t:'CI',s:'Healthcare',i:'Healthcare Plans',m:95},
      {t:'REGN',s:'Healthcare',i:'Biotechnology',m:90},
      {t:'HCA',s:'Healthcare',i:'Medical Care Facilities',m:90},
      // Industrials
      {t:'GE',s:'Industrials',i:'Aerospace & Defense',m:240},
      {t:'CAT',s:'Industrials',i:'Farm & Heavy Construction Machinery',m:200},
      {t:'RTX',s:'Industrials',i:'Aerospace & Defense',m:165},
      {t:'HON',s:'Industrials',i:'Conglomerates',m:145},
      {t:'UNP',s:'Industrials',i:'Railroads',m:145},
      {t:'ETN',s:'Industrials',i:'Specialty Industrial Machinery',m:130},
      {t:'BA',s:'Industrials',i:'Aerospace & Defense',m:110},
      {t:'LMT',s:'Industrials',i:'Aerospace & Defense',m:110},
      {t:'DE',s:'Industrials',i:'Farm & Heavy Construction Machinery',m:110},
      {t:'UPS',s:'Industrials',i:'Integrated Freight & Logistics',m:110},
      {t:'WM',s:'Industrials',i:'Waste Management',m:90},
      {t:'ITW',s:'Industrials',i:'Specialty Industrial Machinery',m:80},
      {t:'GD',s:'Industrials',i:'Aerospace & Defense',m:80},
      {t:'MMM',s:'Industrials',i:'Conglomerates',m:80},
      {t:'CSX',s:'Industrials',i:'Railroads',m:70},
      {t:'NOC',s:'Industrials',i:'Aerospace & Defense',m:70},
      {t:'FDX',s:'Industrials',i:'Integrated Freight & Logistics',m:70},
      // Basic Materials
      {t:'LIN',s:'Basic Materials',i:'Specialty Chemicals',m:220},
      {t:'SHW',s:'Basic Materials',i:'Specialty Chemicals',m:90},
      {t:'FCX',s:'Basic Materials',i:'Copper',m:70},
      {t:'ECL',s:'Basic Materials',i:'Specialty Chemicals',m:70},
      {t:'NEM',s:'Basic Materials',i:'Gold',m:60},
      {t:'APD',s:'Basic Materials',i:'Specialty Chemicals',m:65},
      // Real Estate
      {t:'PLD',s:'Real Estate',i:'REIT - Industrial',m:100},
      {t:'AMT',s:'Real Estate',i:'REIT - Specialty',m:100},
      {t:'EQIX',s:'Real Estate',i:'REIT - Specialty',m:80},
      {t:'WELL',s:'Real Estate',i:'REIT - Healthcare',m:75},
      {t:'CCI',s:'Real Estate',i:'REIT - Specialty',m:50},
      {t:'DLR',s:'Real Estate',i:'REIT - Specialty',m:50},
      {t:'O',s:'Real Estate',i:'REIT - Retail',m:50},
      // Energy
      {t:'XOM',s:'Energy',i:'Oil & Gas Integrated',m:480},
      {t:'CVX',s:'Energy',i:'Oil & Gas Integrated',m:290},
      {t:'COP',s:'Energy',i:'Oil & Gas E&P',m:130},
      {t:'EOG',s:'Energy',i:'Oil & Gas E&P',m:75},
      {t:'WMB',s:'Energy',i:'Oil & Gas Midstream',m:65},
      {t:'KMI',s:'Energy',i:'Oil & Gas Midstream',m:60},
      {t:'SLB',s:'Energy',i:'Oil & Gas Equipment',m:60},
      {t:'OXY',s:'Energy',i:'Oil & Gas E&P',m:50},
      // Utilities
      {t:'NEE',s:'Utilities',i:'Utilities - Regulated Electric',m:165},
      {t:'GEV',s:'Utilities',i:'Utilities - Renewable',m:100},
      {t:'SO',s:'Utilities',i:'Utilities - Regulated Electric',m:95},
      {t:'DUK',s:'Utilities',i:'Utilities - Regulated Electric',m:90},
      {t:'AEP',s:'Utilities',i:'Utilities - Regulated Electric',m:50},
      {t:'D',s:'Utilities',i:'Utilities - Regulated Electric',m:50}
    ]},
    { id:'nasdaq100', label:'NASDAQ 100', market:'US', constituents: [
      {t:'AAPL',s:'Technology',i:'Consumer Electronics',m:3600},
      {t:'MSFT',s:'Technology',i:'Software - Infrastructure',m:3400},
      {t:'NVDA',s:'Technology',i:'Semiconductors',m:3300},
      {t:'AMZN',s:'Consumer Cyclical',i:'Internet Retail',m:2300},
      {t:'GOOGL',s:'Communication Services',i:'Internet Content & Information',m:2200},
      {t:'META',s:'Communication Services',i:'Internet Content & Information',m:1500},
      {t:'TSLA',s:'Consumer Cyclical',i:'Auto Manufacturers',m:1200},
      {t:'AVGO',s:'Technology',i:'Semiconductors',m:1100},
      {t:'COST',s:'Consumer Defensive',i:'Discount Stores',m:440},
      {t:'NFLX',s:'Communication Services',i:'Entertainment',m:350},
      {t:'AMD',s:'Technology',i:'Semiconductors',m:360},
      {t:'TMUS',s:'Communication Services',i:'Telecom Services',m:280},
      {t:'ADBE',s:'Technology',i:'Software - Infrastructure',m:240},
      {t:'CSCO',s:'Technology',i:'Communication Equipment',m:235},
      {t:'PEP',s:'Consumer Defensive',i:'Beverages - Non-Alcoholic',m:220},
      {t:'INTU',s:'Technology',i:'Software - Application',m:185},
      {t:'QCOM',s:'Technology',i:'Semiconductors',m:180},
      {t:'BKNG',s:'Consumer Cyclical',i:'Travel Services',m:165},
      {t:'TXN',s:'Technology',i:'Semiconductors',m:165},
      {t:'AMGN',s:'Healthcare',i:'Drug Manufacturers - General',m:165},
      {t:'AMAT',s:'Technology',i:'Semiconductors',m:145},
      {t:'HON',s:'Industrials',i:'Conglomerates',m:145},
      {t:'ISRG',s:'Healthcare',i:'Medical Devices',m:160},
      {t:'SBUX',s:'Consumer Cyclical',i:'Restaurants',m:120},
      {t:'VRTX',s:'Healthcare',i:'Drug Manufacturers - Specialty',m:120},
      {t:'ADI',s:'Technology',i:'Semiconductors',m:115},
      {t:'GILD',s:'Healthcare',i:'Drug Manufacturers - General',m:110},
      {t:'MU',s:'Technology',i:'Semiconductors',m:110},
      {t:'INTC',s:'Technology',i:'Semiconductors',m:100},
      {t:'PANW',s:'Technology',i:'Software - Infrastructure',m:115},
      {t:'CRWD',s:'Technology',i:'Software - Infrastructure',m:100},
      {t:'CMCSA',s:'Communication Services',i:'Telecom Services',m:175},
      {t:'LRCX',s:'Technology',i:'Semiconductors',m:100},
      {t:'KLAC',s:'Technology',i:'Semiconductors',m:90},
      {t:'REGN',s:'Healthcare',i:'Biotechnology',m:90},
      {t:'SNPS',s:'Technology',i:'Software - Infrastructure',m:85},
      {t:'CDNS',s:'Technology',i:'Software - Infrastructure',m:80},
      {t:'ADP',s:'Technology',i:'Information Technology Services',m:115},
      {t:'MELI',s:'Consumer Cyclical',i:'Internet Retail',m:100},
      {t:'MAR',s:'Consumer Cyclical',i:'Lodging',m:75},
      {t:'CTAS',s:'Industrials',i:'Specialty Business Services',m:80},
      {t:'ASML',s:'Technology',i:'Semiconductors',m:280},
      {t:'NXPI',s:'Technology',i:'Semiconductors',m:55},
      {t:'MRVL',s:'Technology',i:'Semiconductors',m:75},
      {t:'PYPL',s:'Financial Services',i:'Credit Services',m:70},
      {t:'ABNB',s:'Consumer Cyclical',i:'Travel Services',m:80},
      {t:'CSX',s:'Industrials',i:'Railroads',m:70},
      {t:'ORLY',s:'Consumer Cyclical',i:'Specialty Retail',m:75},
      {t:'MDLZ',s:'Consumer Defensive',i:'Confectioners',m:90},
      {t:'MNST',s:'Consumer Defensive',i:'Beverages - Non-Alcoholic',m:55}
    ]},
    { id:'dow', label:'Dow Jones 30', market:'US', constituents: [
      {t:'AAPL',s:'Technology',i:'Consumer Electronics',m:3600},
      {t:'MSFT',s:'Technology',i:'Software - Infrastructure',m:3400},
      {t:'NVDA',s:'Technology',i:'Semiconductors',m:3300},
      {t:'AMZN',s:'Consumer Cyclical',i:'Internet Retail',m:2300},
      {t:'JPM',s:'Financial Services',i:'Banks - Diversified',m:700},
      {t:'V',s:'Financial Services',i:'Credit Services',m:580},
      {t:'UNH',s:'Healthcare',i:'Healthcare Plans',m:580},
      {t:'JNJ',s:'Healthcare',i:'Drug Manufacturers - General',m:400},
      {t:'WMT',s:'Consumer Defensive',i:'Discount Stores',m:800},
      {t:'HD',s:'Consumer Cyclical',i:'Home Improvement Retail',m:380},
      {t:'PG',s:'Consumer Defensive',i:'Household & Personal Products',m:380},
      {t:'CVX',s:'Energy',i:'Oil & Gas Integrated',m:290},
      {t:'KO',s:'Consumer Defensive',i:'Beverages - Non-Alcoholic',m:290},
      {t:'MRK',s:'Healthcare',i:'Drug Manufacturers - General',m:240},
      {t:'MCD',s:'Consumer Cyclical',i:'Restaurants',m:220},
      {t:'CSCO',s:'Technology',i:'Communication Equipment',m:235},
      {t:'CAT',s:'Industrials',i:'Farm & Heavy Construction Machinery',m:200},
      {t:'AXP',s:'Financial Services',i:'Credit Services',m:220},
      {t:'IBM',s:'Technology',i:'Information Technology Services',m:210},
      {t:'GS',s:'Financial Services',i:'Capital Markets',m:200},
      {t:'DIS',s:'Communication Services',i:'Entertainment',m:200},
      {t:'AMGN',s:'Healthcare',i:'Drug Manufacturers - General',m:165},
      {t:'HON',s:'Industrials',i:'Conglomerates',m:145},
      {t:'BA',s:'Industrials',i:'Aerospace & Defense',m:110},
      {t:'NKE',s:'Consumer Cyclical',i:'Footwear & Accessories',m:110},
      {t:'VZ',s:'Communication Services',i:'Telecom Services',m:180},
      {t:'TRV',s:'Financial Services',i:'Insurance - Property & Casualty',m:55},
      {t:'MMM',s:'Industrials',i:'Conglomerates',m:80},
      {t:'DOW',s:'Basic Materials',i:'Specialty Chemicals',m:35},
      {t:'WBA',s:'Healthcare',i:'Pharmaceutical Retailers',m:10}
    ]},
    { id:'ftse100', label:'FTSE 100 (UK)', market:'LSE', constituents: [
      {t:'AZN',s:'Healthcare',i:'Drug Manufacturers - General',m:200},
      {t:'SHEL',s:'Energy',i:'Oil & Gas Integrated',m:230},
      {t:'HSBA',s:'Financial Services',i:'Banks - Diversified',m:170},
      {t:'ULVR',s:'Consumer Defensive',i:'Household & Personal Products',m:130},
      {t:'BP',s:'Energy',i:'Oil & Gas Integrated',m:90},
      {t:'GSK',s:'Healthcare',i:'Drug Manufacturers - General',m:75},
      {t:'RIO',s:'Basic Materials',i:'Industrial Metals & Mining',m:115},
      {t:'GLEN',s:'Basic Materials',i:'Industrial Metals & Mining',m:65},
      {t:'REL',s:'Communication Services',i:'Publishing',m:90},
      {t:'BATS',s:'Consumer Defensive',i:'Tobacco',m:80},
      {t:'DGE',s:'Consumer Defensive',i:'Beverages - Wineries & Distilleries',m:65},
      {t:'BARC',s:'Financial Services',i:'Banks - Diversified',m:55},
      {t:'LLOY',s:'Financial Services',i:'Banks - Diversified',m:50},
      {t:'NWG',s:'Financial Services',i:'Banks - Diversified',m:45},
      {t:'NG',s:'Utilities',i:'Utilities - Regulated Electric',m:60},
      {t:'VOD',s:'Communication Services',i:'Telecom Services',m:30},
      {t:'CPG',s:'Consumer Cyclical',i:'Restaurants',m:60},
      {t:'EXPN',s:'Industrials',i:'Specialty Business Services',m:45},
      {t:'PRU',s:'Financial Services',i:'Insurance - Diversified',m:30},
      {t:'TSCO',s:'Consumer Defensive',i:'Grocery Stores',m:35},
      {t:'AAL',s:'Basic Materials',i:'Industrial Metals & Mining',m:35},
      {t:'IMB',s:'Consumer Defensive',i:'Tobacco',m:30},
      {t:'STAN',s:'Financial Services',i:'Banks - Diversified',m:30},
      {t:'BT-A',s:'Communication Services',i:'Telecom Services',m:18},
      {t:'WPP',s:'Communication Services',i:'Advertising Agencies',m:10},
      {t:'HLN',s:'Healthcare',i:'Drug Manufacturers - Specialty',m:18},
      {t:'BKG',s:'Real Estate',i:'Real Estate Services',m:10},
      {t:'NXT',s:'Consumer Cyclical',i:'Apparel Retail',m:14},
      {t:'SVT',s:'Utilities',i:'Utilities - Regulated Water',m:8},
      {t:'UU',s:'Utilities',i:'Utilities - Regulated Water',m:9},
      {t:'LGEN',s:'Financial Services',i:'Insurance - Life',m:18},
      {t:'RKT',s:'Consumer Defensive',i:'Household & Personal Products',m:40},
      {t:'SMIN',s:'Industrials',i:'Specialty Industrial Machinery',m:8},
      {t:'MNG',s:'Financial Services',i:'Asset Management',m:6},
      {t:'SBRY',s:'Consumer Defensive',i:'Grocery Stores',m:10},
      {t:'RR',s:'Industrials',i:'Aerospace & Defense',m:50},
      {t:'AHT',s:'Industrials',i:'Rental & Leasing Services',m:25},
      {t:'CRH',s:'Basic Materials',i:'Building Materials',m:60},
      {t:'PHNX',s:'Financial Services',i:'Insurance - Life',m:6},
      {t:'III',s:'Financial Services',i:'Asset Management',m:5},
      {t:'LSE',s:'Financial Services',i:'Financial Data & Stock Exchanges',m:65}
    ]},
    { id:'jse40', label:'JSE Top 40 (SA)', market:'JSE', constituents: [
      {t:'NPN',s:'Communication Services',i:'Internet Content & Information',m:600},
      {t:'PRX',s:'Communication Services',i:'Internet Content & Information',m:500},
      {t:'BHG',s:'Basic Materials',i:'Industrial Metals & Mining',m:380},
      {t:'AGL',s:'Basic Materials',i:'Industrial Metals & Mining',m:280},
      {t:'GLN',s:'Basic Materials',i:'Industrial Metals & Mining',m:240},
      {t:'CPI',s:'Financial Services',i:'Banks - Regional',m:330},
      {t:'FSR',s:'Financial Services',i:'Banks - Diversified',m:380},
      {t:'SBK',s:'Financial Services',i:'Banks - Diversified',m:330},
      {t:'SHP',s:'Consumer Defensive',i:'Grocery Stores',m:200},
      {t:'CFR',s:'Consumer Cyclical',i:'Luxury Goods',m:1100},
      {t:'MTN',s:'Communication Services',i:'Telecom Services',m:160},
      {t:'VOD',s:'Communication Services',i:'Telecom Services',m:90},
      {t:'SOL',s:'Energy',i:'Oil & Gas Integrated',m:60},
      {t:'GFI',s:'Basic Materials',i:'Gold',m:330},
      {t:'ANG',s:'Basic Materials',i:'Gold',m:260},
      {t:'IMP',s:'Basic Materials',i:'Other Precious Metals',m:90},
      {t:'AMS',s:'Basic Materials',i:'Other Precious Metals',m:120},
      {t:'SSW',s:'Basic Materials',i:'Other Precious Metals',m:60},
      {t:'NED',s:'Financial Services',i:'Banks - Diversified',m:140},
      {t:'ABG',s:'Financial Services',i:'Banks - Diversified',m:160},
      {t:'INP',s:'Financial Services',i:'Capital Markets',m:50},
      {t:'DSY',s:'Financial Services',i:'Insurance - Diversified',m:100},
      {t:'SLM',s:'Financial Services',i:'Insurance - Life',m:170},
      {t:'OMU',s:'Financial Services',i:'Insurance - Life',m:60},
      {t:'CLS',s:'Consumer Defensive',i:'Grocery Stores',m:35},
      {t:'BID',s:'Industrials',i:'Specialty Business Services',m:135},
      {t:'APN',s:'Healthcare',i:'Drug Manufacturers - Specialty',m:110},
      {t:'WHL',s:'Consumer Cyclical',i:'Apparel Retail',m:65},
      {t:'MRP',s:'Consumer Cyclical',i:'Apparel Retail',m:50},
      {t:'TBS',s:'Consumer Defensive',i:'Packaged Foods',m:80},
      {t:'PIK',s:'Consumer Defensive',i:'Grocery Stores',m:25},
      {t:'TRU',s:'Industrials',i:'Specialty Industrial Machinery',m:50},
      {t:'RMI',s:'Financial Services',i:'Insurance - Diversified',m:40},
      {t:'REM',s:'Financial Services',i:'Asset Management',m:90},
      {t:'NRP',s:'Real Estate',i:'REIT - Diversified',m:65},
      {t:'EXX',s:'Basic Materials',i:'Industrial Metals & Mining',m:55},
      {t:'HMN',s:'Basic Materials',i:'Other Precious Metals',m:50}
    ]},
    { id:'asx50', label:'ASX 50 (Australia)', market:'ASX', constituents: [
      {t:'CBA',s:'Financial Services',i:'Banks - Diversified',m:240},
      {t:'BHP',s:'Basic Materials',i:'Industrial Metals & Mining',m:200},
      {t:'CSL',s:'Healthcare',i:'Biotechnology',m:130},
      {t:'NAB',s:'Financial Services',i:'Banks - Diversified',m:120},
      {t:'WBC',s:'Financial Services',i:'Banks - Diversified',m:115},
      {t:'ANZ',s:'Financial Services',i:'Banks - Diversified',m:100},
      {t:'WES',s:'Consumer Defensive',i:'Discount Stores',m:90},
      {t:'MQG',s:'Financial Services',i:'Capital Markets',m:80},
      {t:'WOW',s:'Consumer Defensive',i:'Grocery Stores',m:40},
      {t:'GMG',s:'Real Estate',i:'REIT - Industrial',m:65},
      {t:'TCL',s:'Industrials',i:'Infrastructure Operations',m:45},
      {t:'RIO',s:'Basic Materials',i:'Industrial Metals & Mining',m:35},
      {t:'FMG',s:'Basic Materials',i:'Industrial Metals & Mining',m:55},
      {t:'TLS',s:'Communication Services',i:'Telecom Services',m:50},
      {t:'COL',s:'Consumer Defensive',i:'Grocery Stores',m:25},
      {t:'XRO',s:'Technology',i:'Software - Application',m:25},
      {t:'REA',s:'Communication Services',i:'Internet Content & Information',m:30},
      {t:'ALL',s:'Consumer Cyclical',i:'Gambling',m:35},
      {t:'SHL',s:'Healthcare',i:'Diagnostics & Research',m:14},
      {t:'QBE',s:'Financial Services',i:'Insurance - Property & Casualty',m:30},
      {t:'ORG',s:'Utilities',i:'Utilities - Diversified',m:20},
      {t:'STO',s:'Energy',i:'Oil & Gas E&P',m:25},
      {t:'WDS',s:'Energy',i:'Oil & Gas Integrated',m:50},
      {t:'NEM',s:'Basic Materials',i:'Gold',m:30},
      {t:'EVN',s:'Basic Materials',i:'Gold',m:14},
      {t:'S32',s:'Basic Materials',i:'Industrial Metals & Mining',m:18},
      {t:'PME',s:'Healthcare',i:'Health Information Services',m:30},
      {t:'JHX',s:'Industrials',i:'Building Products & Equipment',m:25},
      {t:'AMC',s:'Consumer Cyclical',i:'Packaging & Containers',m:25},
      {t:'BXB',s:'Industrials',i:'Rental & Leasing Services',m:30},
      {t:'CPU',s:'Technology',i:'Information Technology Services',m:20},
      {t:'SUN',s:'Financial Services',i:'Insurance - Property & Casualty',m:25},
      {t:'IAG',s:'Financial Services',i:'Insurance - Property & Casualty',m:20},
      {t:'ASX',s:'Financial Services',i:'Financial Data & Stock Exchanges',m:14},
      {t:'MIN',s:'Basic Materials',i:'Industrial Metals & Mining',m:10},
      {t:'MFG',s:'Financial Services',i:'Asset Management',m:5},
      {t:'TWE',s:'Consumer Defensive',i:'Beverages - Wineries & Distilleries',m:9},
      {t:'AZJ',s:'Industrials',i:'Railroads',m:8},
      {t:'APA',s:'Energy',i:'Oil & Gas Midstream',m:13},
      {t:'NST',s:'Basic Materials',i:'Gold',m:20},
      {t:'RMD',s:'Healthcare',i:'Medical Devices',m:50},
      {t:'SEK',s:'Communication Services',i:'Internet Content & Information',m:9}
    ]},
    { id:'dax', label:'DAX 40 (Germany)', market:'FRA', constituents: [
      {t:'SAP',s:'Technology',i:'Software - Application',m:280},
      {t:'SIE',s:'Industrials',i:'Specialty Industrial Machinery',m:170},
      {t:'ALV',s:'Financial Services',i:'Insurance - Diversified',m:120},
      {t:'DTE',s:'Communication Services',i:'Telecom Services',m:140},
      {t:'BMW',s:'Consumer Cyclical',i:'Auto Manufacturers',m:55},
      {t:'VOW3',s:'Consumer Cyclical',i:'Auto Manufacturers',m:45},
      {t:'MBG',s:'Consumer Cyclical',i:'Auto Manufacturers',m:60},
      {t:'DBK',s:'Financial Services',i:'Banks - Diversified',m:30},
      {t:'BAS',s:'Basic Materials',i:'Specialty Chemicals',m:40},
      {t:'BAYN',s:'Healthcare',i:'Drug Manufacturers - General',m:25},
      {t:'MUV2',s:'Financial Services',i:'Insurance - Reinsurance',m:55},
      {t:'RWE',s:'Utilities',i:'Utilities - Renewable',m:25},
      {t:'IFX',s:'Technology',i:'Semiconductors',m:50},
      {t:'ADS',s:'Consumer Cyclical',i:'Footwear & Accessories',m:35},
      {t:'BEI',s:'Consumer Defensive',i:'Household & Personal Products',m:30},
      {t:'CON',s:'Consumer Cyclical',i:'Auto Parts',m:14},
      {t:'DB1',s:'Financial Services',i:'Financial Data & Stock Exchanges',m:50},
      {t:'DPW',s:'Industrials',i:'Integrated Freight & Logistics',m:50},
      {t:'EOAN',s:'Utilities',i:'Utilities - Diversified',m:35},
      {t:'FRE',s:'Healthcare',i:'Medical Care Facilities',m:24},
      {t:'HEN3',s:'Consumer Defensive',i:'Household & Personal Products',m:28},
      {t:'HEI',s:'Basic Materials',i:'Building Materials',m:25},
      {t:'MRK',s:'Healthcare',i:'Drug Manufacturers - General',m:90},
      {t:'MTX',s:'Industrials',i:'Aerospace & Defense',m:30},
      {t:'PAH3',s:'Consumer Cyclical',i:'Auto Manufacturers',m:14},
      {t:'PUM',s:'Consumer Cyclical',i:'Footwear & Accessories',m:5},
      {t:'QIA',s:'Healthcare',i:'Diagnostics & Research',m:11},
      {t:'SHL',s:'Healthcare',i:'Diagnostics & Research',m:60},
      {t:'SY1',s:'Basic Materials',i:'Specialty Chemicals',m:8},
      {t:'VNA',s:'Real Estate',i:'Real Estate Services',m:30},
      {t:'ZAL',s:'Consumer Cyclical',i:'Internet Retail',m:8},
      {t:'1COV',s:'Basic Materials',i:'Specialty Chemicals',m:15},
      {t:'AIR',s:'Industrials',i:'Aerospace & Defense',m:140},
      {t:'BNR',s:'Industrials',i:'Specialty Industrial Machinery',m:8},
      {t:'CBK',s:'Financial Services',i:'Banks - Diversified',m:25},
      {t:'ENR',s:'Industrials',i:'Specialty Industrial Machinery',m:65},
      {t:'PORS',s:'Consumer Cyclical',i:'Auto Manufacturers',m:60}
    ]},
    { id:'cac', label:'CAC 40 (France)', market:'PAR', constituents: [
      {t:'MC',s:'Consumer Cyclical',i:'Luxury Goods',m:330},
      {t:'TTE',s:'Energy',i:'Oil & Gas Integrated',m:140},
      {t:'SAN',s:'Healthcare',i:'Drug Manufacturers - General',m:120},
      {t:'BNP',s:'Financial Services',i:'Banks - Diversified',m:80},
      {t:'OR',s:'Consumer Defensive',i:'Household & Personal Products',m:200},
      {t:'SU',s:'Industrials',i:'Specialty Industrial Machinery',m:140},
      {t:'AI',s:'Basic Materials',i:'Specialty Chemicals',m:90},
      {t:'AIR',s:'Industrials',i:'Aerospace & Defense',m:140},
      {t:'RMS',s:'Consumer Cyclical',i:'Luxury Goods',m:240},
      {t:'EL',s:'Consumer Cyclical',i:'Luxury Goods',m:55},
      {t:'SAF',s:'Industrials',i:'Aerospace & Defense',m:100},
      {t:'BN',s:'Consumer Defensive',i:'Packaged Foods',m:45},
      {t:'CS',s:'Financial Services',i:'Insurance - Diversified',m:80},
      {t:'CAP',s:'Technology',i:'Information Technology Services',m:30},
      {t:'SGO',s:'Industrials',i:'Building Products & Equipment',m:50},
      {t:'LR',s:'Industrials',i:'Specialty Industrial Machinery',m:35},
      {t:'VIV',s:'Communication Services',i:'Entertainment',m:12},
      {t:'VIE',s:'Utilities',i:'Utilities - Diversified',m:23},
      {t:'GLE',s:'Financial Services',i:'Banks - Diversified',m:30},
      {t:'ML',s:'Consumer Cyclical',i:'Auto Parts',m:18},
      {t:'HO',s:'Industrials',i:'Aerospace & Defense',m:50},
      {t:'ENGI',s:'Utilities',i:'Utilities - Diversified',m:35},
      {t:'STM',s:'Technology',i:'Semiconductors',m:25},
      {t:'ACA',s:'Financial Services',i:'Banks - Diversified',m:35},
      {t:'KER',s:'Consumer Cyclical',i:'Luxury Goods',m:25},
      {t:'PUB',s:'Communication Services',i:'Advertising Agencies',m:25},
      {t:'DG',s:'Industrials',i:'Engineering & Construction',m:25},
      {t:'EN',s:'Industrials',i:'Engineering & Construction',m:18},
      {t:'ALO',s:'Industrials',i:'Specialty Industrial Machinery',m:8},
      {t:'TEP',s:'Energy',i:'Oil & Gas Equipment',m:5},
      {t:'ORA',s:'Communication Services',i:'Telecom Services',m:25},
      {t:'CA',s:'Consumer Cyclical',i:'Specialty Retail',m:8},
      {t:'ATO',s:'Technology',i:'Information Technology Services',m:6},
      {t:'BVI',s:'Healthcare',i:'Medical Devices',m:5},
      {t:'EDEN',s:'Consumer Cyclical',i:'Travel Services',m:10},
      {t:'ERF',s:'Healthcare',i:'Medical Devices',m:25}
    ]},
    { id:'aex', label:'AEX (Netherlands)', market:'AMS', constituents: [
      {t:'ASML',s:'Technology',i:'Semiconductors',m:280},
      {t:'PRX',s:'Communication Services',i:'Internet Content & Information',m:90},
      {t:'UNA',s:'Consumer Defensive',i:'Household & Personal Products',m:130},
      {t:'INGA',s:'Financial Services',i:'Banks - Diversified',m:60},
      {t:'HEIA',s:'Consumer Defensive',i:'Beverages - Brewers',m:55},
      {t:'ADYEN',s:'Technology',i:'Software - Infrastructure',m:50},
      {t:'PHIA',s:'Healthcare',i:'Medical Devices',m:25},
      {t:'AD',s:'Consumer Defensive',i:'Grocery Stores',m:35},
      {t:'WKL',s:'Industrials',i:'Specialty Business Services',m:40},
      {t:'AKZA',s:'Basic Materials',i:'Specialty Chemicals',m:13},
      {t:'AGN',s:'Financial Services',i:'Insurance - Life',m:12},
      {t:'MT',s:'Basic Materials',i:'Steel',m:25},
      {t:'GLPG',s:'Healthcare',i:'Biotechnology',m:2},
      {t:'IMCD',s:'Basic Materials',i:'Specialty Chemicals',m:8},
      {t:'KPN',s:'Communication Services',i:'Telecom Services',m:15},
      {t:'BESI',s:'Technology',i:'Semiconductors',m:9},
      {t:'ASRNL',s:'Financial Services',i:'Insurance - Diversified',m:11},
      {t:'NN',s:'Financial Services',i:'Insurance - Life',m:13},
      {t:'ABN',s:'Financial Services',i:'Banks - Diversified',m:14},
      {t:'EXO',s:'Financial Services',i:'Asset Management',m:25},
      {t:'RAND',s:'Industrials',i:'Staffing & Employment Services',m:8},
      {t:'REN',s:'Real Estate',i:'REIT - Diversified',m:5}
    ]}
  ]
};

// Known tickers for sector/name lookups (all exchanges)
window.PB_DATA.findInfo = function(ticker, market) {
  if (market === 'TFSA') return window.PB_DATA.TFSA_SUGGESTIONS.find(s => s.ticker === ticker) || window.PB_DATA.JSE_SUGGESTIONS.find(s => s.ticker === ticker) || { ticker, name: ticker };
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

// Build a lookup of ticker -> {sector, industry} from heatmap constituents
window.PB_DATA._sectorLookup = (function() {
  const map = {};
  window.PB_DATA.HEATMAPS.forEach(h => {
    h.constituents.forEach(c => {
      const key = h.market + ':' + c.t;
      if (!map[key]) map[key] = { sector: c.s, industry: c.i };
    });
  });
  return map;
})();

// ── Expert sector classification ───────────────────────────────────────────
// Canonical taxonomy: the 11 GICS-style equity sectors used across the heatmaps,
// plus four non-equity buckets (funds / bonds / commodities / crypto) so ETFs
// and hedges land somewhere meaningful instead of being dumped into "Other".
window.PB_DATA.SECTOR_CANON = ['Technology', 'Communication Services', 'Consumer Cyclical', 'Consumer Defensive', 'Healthcare', 'Financial Services', 'Industrials', 'Energy', 'Basic Materials', 'Real Estate', 'Utilities', 'ETFs & Funds', 'Bonds & Income', 'Gold & Commodities', 'Crypto'];

// Map any incoming sector label — heatmap, curated map, playbook thesis
// shorthand, or a live fundamentals feed (Yahoo / stockanalysis use slightly
// different spellings) — onto one canonical bucket. Freeform text → "Other".
window.PB_DATA._SECTOR_ALIASES = (function () {
  const m = {};
  const add = (canon, aliases) => { m[canon.toLowerCase()] = canon; aliases.forEach(a => { m[a.toLowerCase()] = canon; }); };
  add('Technology', ['tech', 'information technology', 'infotech', 'it', 'semiconductors', 'software', 'hardware', 'electronic technology', 'technology services']);
  add('Communication Services', ['communication', 'communications', 'communication service', 'telecom', 'telecommunication', 'telecommunications', 'telecommunication services', 'media', 'media & entertainment', 'interactive media']);
  add('Consumer Cyclical', ['consumer discretionary', 'consumer cyclicals', 'discretionary', 'retail trade', 'consumer durables', 'autos', 'auto']);
  add('Consumer Defensive', ['consumer staples', 'consumer defensives', 'staples', 'consumer non-cyclical', 'consumer non cyclical', 'consumer non-durables']);
  add('Healthcare', ['health care', 'health', 'medical', 'pharmaceuticals', 'pharma', 'biotech', 'biotechnology', 'life sciences', 'health technology']);
  add('Financial Services', ['financial', 'financials', 'finance', 'financial service', 'banks', 'banking', 'insurance', 'capital markets', 'diversified financials']);
  add('Industrials', ['industrial', 'industrial goods', 'capital goods', 'aerospace & defense', 'aerospace and defense', 'transportation', 'machinery', 'producer manufacturing', 'commercial services']);
  add('Energy', ['oil & gas', 'oil and gas', 'oil', 'gas', 'oil, gas & consumable fuels', 'energy minerals']);
  add('Basic Materials', ['materials', 'material', 'basic material', 'chemicals', 'metals & mining', 'metals and mining', 'mining', 'precious metals', 'non-energy minerals']);
  add('Real Estate', ['reit', 'reits', 'real-estate', 'property', 'real estate investment trusts']);
  add('Utilities', ['utility', 'electric utilities', 'power', 'renewable utilities']);
  add('ETFs & Funds', ['etf', 'etfs', 'fund', 'funds', 'index fund', 'mutual fund', 'diversified', 'exchange traded fund', 'exchange-traded fund', 'miscellaneous']);
  add('Bonds & Income', ['bond', 'bonds', 'fixed income', 'treasury', 'treasuries', 'fixed-income', 'income']);
  add('Gold & Commodities', ['commodity', 'commodities', 'gold', 'gold & precious metals', 'bullion']);
  add('Crypto', ['cryptocurrency', 'crypto assets', 'bitcoin', 'digital assets', 'blockchain']);
  // Playbook thesis shorthand used inside HOLDINGS / NEW_PICKS / HEDGES.
  add('Technology', ['ai / cloud', 'ai semi', 'ai infrastructure', 'semi equipment', 'foundry', 'cybersecurity', 'bitcoin proxy']);
  add('Healthcare', ['defensive equity']);
  add('Industrials', ['power infra', 'defense', 'defense etf']);
  add('Utilities', ['nuclear power', 'nuclear-ai']);
  add('Gold & Commodities', ['physical gold']);
  add('Bonds & Income', ['intermediate duration']);
  add('ETFs & Funds', ['low-vol equity', 'low vol equity']);
  return m;
})();

window.PB_DATA.normalizeSector = function (raw) {
  if (raw == null) return 'Other';
  const s = String(raw).trim();
  if (!s) return 'Other';
  const hit = window.PB_DATA._SECTOR_ALIASES[s.toLowerCase()];
  if (hit) return hit;
  // Tolerate qualifiers like "Financials (sector)" or "Technology Sector".
  const cleaned = s.toLowerCase().replace(/\s*\(.*?\)\s*$/, '').replace(/\s+sector$/, '').trim();
  return window.PB_DATA._SECTOR_ALIASES[cleaned] || 'Other';
};

// Curated US ticker → canonical sector map. Covers the user's playbook universe
// plus several hundred of the most commonly-held US equities and ETFs, so the
// allocator resolves a real sector offline without waiting on a fundamentals
// fetch. Single-sector ETFs map to the sector they track; broad/multi-sector
// funds, bonds, commodities and crypto vehicles get their own buckets.
window.PB_DATA._US_SECTORS = (function () {
  const groups = {
    'Technology': 'AAPL MSFT NVDA AVGO ORCL ADBE CRM ACN AMD CSCO IBM INTU QCOM TXN NOW AMAT ADI MU LRCX KLAC SNPS CDNS INTC PANW ANET PLTR APP DELL SMCI ARM MRVL NXPI MCHP ON STM SWKS QRVO TER ENTG MPWR WOLF CRWD ZS S NET DDOG MDB SNOW DOCN ESTC GTLB FROG PATH AI BBAI SOUN TSM ASML UMC GFS NBIS WDC STX HPQ HPE JNPR FFIV AKAM CIEN COHR LITE NTAP PSTG VRT WIT INFY SHOP TOST ADSK WDAY ZM DOCU OKTA TWLO HUBS BILL APPN ASAN MNDY CFLT U TTD UBER FSLR ENPH SEDG GLW KEYS TYL ZBRA PTC ANSS FICO IT VRSN GEN AKAM',
    'Communication Services': 'GOOGL GOOG META NFLX DIS CMCSA TMUS VZ T CHTR WBD PARA FOXA FOX NWSA NWS OMC IPG TTWO EA RBLX SPOT PINS SNAP MTCH BIDU NTES TCEHY SE ROKU LYV Z ZG NYT WMG DASH',
    'Consumer Cyclical': 'AMZN TSLA HD MCD NKE LOW SBUX BKNG TJX ABNB CMG MAR ORLY AZO ROST YUM HLT RCL CCL NCLH LVS WYNN MGM DKNG F GM RIVN LCID NIO LI XPEV STLA TM RACE LULU DECK ULTA EBAY ETSY W CHWY CPRT DHI LEN PHM NVR TOL GRMN APTV LKQ BBY EXPE POOL TSCO DPZ DRI GPC BABA JD PDD MELI',
    'Consumer Defensive': 'WMT COST PG KO PEP PM MO MDLZ CL KMB GIS KHC HSY STZ KDP MNST SYY ADM KR DG DLTR TGT EL CLX CHD MKC HRL TSN K CAG CPB SJM TAP BF-B KVUE BUD DEO WBA',
    'Healthcare': 'LLY UNH JNJ MRK ABBV TMO ABT DHR PFE AMGN ISRG BSX SYK MDT GILD VRTX REGN CI CVS HCA ELV ZTS BDX HUM CNC MCK COR BMY BIIB MRNA IDXX IQV DXCM EW WST RMD GEHC ALGN MTD WAT PODD HOLX BAX CAH ZBH STE VTRS LH DGX RVTY CRL TECH MOH BNTX CRSP NTLA BEAM VKTX HIMS NBIX EXAS SRPT RARE',
    'Financial Services': 'BRK-B BRK-A JPM V MA BAC WFC GS MS AXP SPGI BLK C SCHW CB MMC PGR CME ICE AON PNC USB TFC COF BK AIG MET PRU TRV ALL AFL MSCI MCO AJG FIS FI GPN COIN HOOD SOFI PYPL AFRM UPST XYZ KKR BX APO ARES OWL CG NDAQ CBOE MKTX FCNCA RJF SYF DFS ALLY NU MARA RIOT CLSK HUT BITF WBS FITB HBAN RF CFG KEY MTB',
    'Industrials': 'GE CAT BA HON UNP RTX LMT UPS DE ETN ADP NOC GD EMR ITW CSX FDX NSC WM PH GEV MMM TDG TT CMI CTAS PCAR ROP CARR OTIS PWR URI GWW FAST AME ODFL VRSK EFX IR DOV XYL HWM AXON LHX HII TXT LDOS BAH CACI PNR ROK FTV AOS NDSN SWK PAYX RSG WCN JCI MAS ALLE DAL UAL AAL LUV PLUG BE SMR OKLO',
    'Energy': 'XOM CVX COP SLB EOG MPC PSX VLO OXY WMB OKE KMI HES DVN FANG HAL BKR TRGP CTRA MRO APA EQT AR CHK RRC OVV MUR SM CIVI PR DINO CCJ UEC DNN NXE UUUU LEU',
    'Basic Materials': 'LIN APD SHW ECL FCX NEM NUE DOW DD PPG CTVA VMC MLM ALB CF MOS FMC IFF EMN CE CMC RPM AVTR SQM GOLD AEM KGC AU HMY WPM FNV RGLD PAAS AG HL CDE MP ASPI',
    'Real Estate': 'PLD AMT EQIX CCI PSA O SPG DLR WELL VICI SBAC EXR AVB EQR ARE INVH MAA UDR ESS KIM REG FRT BXP HST VTR IRM CPT WY DOC CUBE NLY AGNC STWD',
    'Utilities': 'NEE DUK SO D AEP SRE EXC XEL ED PEG WEC ES AEE CEG ETR FE PPL CMS DTE AES LNT NI EVRG CNP ATO PNW NRG VST PCG EIX AWK',
    'ETFs & Funds': 'SPY VOO IVV VTI QQQ QQQM DIA IWM VT VXUS VEU VEA VWO EFA EEM ACWI SCHB SCHX SPLG RSP SCHD VIG VYM DGRO NOBL USMV SPLV QUAL MTUM VUG VTV IWF IWD MGK MGV SCHG SPYG SPYV ITOT IJH IJR IWB IWV VO VB VTWO SCHA SCHM ARKK ARKW ARKF ARKG ARKQ MAGS XLG OEF VONE SPMO COWZ JEPI JEPQ DVY SDY IEFA IEMG ACWX FNDX',
    'Bonds & Income': 'IEF TLT SHY AGG BND BNDX LQD HYG JNK TIP MUB VCIT VCSH SHV BIL SGOV GOVT TLH IEI VGIT VGLT VGSH MBB VTEB PFF SCHP FLOT USHY EMB',
    'Gold & Commodities': 'GLD IAU GLDM SGOL IAUM SLV SIVR PPLT PALL PDBC DBC USO UNG BNO UGA GLTR CPER DBA DBB GSG',
    'Crypto': 'IBIT FBTC GBTC BITO BITB ARKB BTCO HODL BRRR EZBC ETHA ETHE FETH ETHW BITX',
    // Single-sector ETFs — counted as exposure to the sector they track.
  };
  // Sector-tracking ETFs folded into their underlying sector.
  groups['Technology'] += ' XLK VGT SMH SOXX IGV SKYY HACK CIBR BUG WCLD FDN';
  groups['Communication Services'] += ' XLC VOX';
  groups['Consumer Cyclical'] += ' XLY VCR XRT';
  groups['Consumer Defensive'] += ' XLP VDC';
  groups['Healthcare'] += ' XLV VHT IBB XBI IHI';
  groups['Financial Services'] += ' XLF VFH KRE KBE IAI KIE FINX IPAY';
  groups['Industrials'] += ' XLI VIS ITA PPA XAR JETS';
  groups['Energy'] += ' XLE VDE OIH XOP AMLP URA URNM';
  groups['Basic Materials'] += ' XLB VAW GDX GDXJ SIL SILJ LIT COPX REMX SLX';
  groups['Real Estate'] += ' XLRE VNQ SCHH IYR';
  groups['Utilities'] += ' XLU VPU NLR';
  const out = {};
  for (const sec of Object.keys(groups)) groups[sec].split(/\s+/).forEach(t => { if (t) out[t] = sec; });
  return out;
})();

// Curated international ticker → sector map, keyed "MARKET:TICKER" because the
// same symbol means different companies across exchanges (e.g. VOD = Vodacom on
// the JSE, Vodafone on the LSE). Index constituents already resolve via the
// heatmaps; this fills the rest of the suggestion-list universe.
window.PB_DATA._INTL_SECTORS = (function () {
  const groups = {
    'JSE': {
      'Financial Services': 'CPI FSR SBK NED ABG INP DSY SLM OMU', 'Basic Materials': 'BHG BHP AGL GLN GFI ANG IMP AMS SSW',
      'Communication Services': 'NPN PRX MTN VOD', 'Consumer Defensive': 'SHP BID WHL', 'Consumer Cyclical': 'CFR', 'Energy': 'SOL', 'Healthcare': 'APN'
    },
    'LSE': {
      'Financial Services': 'HSBA LLOY BARC NWG STAN INVP LSEG LSE', 'Energy': 'BP SHEL', 'Healthcare': 'AZN GSK',
      'Consumer Defensive': 'ULVR DGE', 'Basic Materials': 'RIO AAL GLEN', 'Communication Services': 'VOD BT-A WPP',
      'Industrials': 'REL EXPN', 'Utilities': 'NG SSE', 'Consumer Cyclical': 'CPG BKG'
    },
    'ASX': {
      'Financial Services': 'CBA ANZ WBC NAB MQG APT ZIP', 'Basic Materials': 'BHP RIO FMG', 'Healthcare': 'CSL',
      'Consumer Defensive': 'WES WOW COL', 'Industrials': 'TCL', 'Real Estate': 'GMG', 'Communication Services': 'REA TLS',
      'Consumer Cyclical': 'ALL', 'Technology': 'XRO APX'
    },
    'FRA': {
      'Technology': 'SAP', 'Industrials': 'SIE', 'Financial Services': 'ALV DBK', 'Communication Services': 'DTE',
      'Consumer Cyclical': 'BMW VOW3 MBG', 'Basic Materials': 'BAS', 'Healthcare': 'BAYN'
    },
    'PAR': {
      'Industrials': 'AIR SU', 'Energy': 'TTE', 'Healthcare': 'SAN', 'Financial Services': 'BNP',
      'Consumer Cyclical': 'MC', 'Consumer Defensive': 'OR', 'Basic Materials': 'AI'
    },
    'AMS': { 'Technology': 'ASML', 'Healthcare': 'PHIA', 'Financial Services': 'INGA', 'Consumer Defensive': 'HEIA' },
    'TFSA': {
      'ETFs & Funds': 'STX40 STX500 STXNDQ STXWDM STXEMG STXSWX STXDIV STXRAF CSEW40 CSTOP50 CSNDQ CSP500 GLODIV NFEMOM NFSWIX NFEDEF SYG500 SYGSW4 SYG4IR ETFWLD ASHT40',
      'Real Estate': 'STXPRO CSPROP SYGP', 'Industrials': 'STXIND', 'Financial Services': 'STXFIN', 'Basic Materials': 'STXRES', 'Gold & Commodities': 'ETFGRE'
    }
  };
  const out = {};
  for (const mkt of Object.keys(groups)) {
    const byTicker = groups[mkt];
    for (const sec of Object.keys(byTicker)) byTicker[sec].split(/\s+/).forEach(t => { if (t) out[mkt + ':' + t] = sec; });
  }
  return out;
})();

// Resolve a position to a canonical sector. Layered, most-authoritative-first:
//   1. curated master map (offline, GICS-correct, broad)
//   2. heatmap index constituents (real industry granularity)
//   3. live fundamentals hint, when the caller has one cached
//   4. playbook thesis shorthand on the user's own holdings / picks / hedges
// Only genuinely unknown symbols fall through to "Other".
window.PB_DATA.findSector = function (ticker, market, hint) {
  const N = window.PB_DATA.normalizeSector;
  if (!ticker) return { sector: 'Other', industry: 'Other' };
  const t = String(ticker).toUpperCase().trim();
  const mkt = market || 'US';
  // 1. Curated master map.
  if (mkt === 'US') {
    const s = window.PB_DATA._US_SECTORS[t];
    if (s) return { sector: s, industry: s };
  } else {
    let s = window.PB_DATA._INTL_SECTORS[mkt + ':' + t];
    // A tax-free account holds JSE-listed shares, so reuse the JSE map for them.
    if (!s && mkt === 'TFSA') s = window.PB_DATA._INTL_SECTORS['JSE:' + t];
    if (s) return { sector: s, industry: s };
  }
  // 2. Heatmap constituents (already GICS, with a real industry label).
  const direct = window.PB_DATA._sectorLookup[mkt + ':' + t]
    || (mkt === 'TFSA' ? window.PB_DATA._sectorLookup['JSE:' + t] : null);
  if (direct) return { sector: N(direct.sector), industry: direct.industry || direct.sector };
  // 3. Live fundamentals hint (authoritative for odd names the caller has opened).
  if (hint) { const h = N(hint); if (h !== 'Other') return { sector: h, industry: typeof hint === 'string' ? hint : h }; }
  // 4. Playbook thesis shorthand.
  const holding = window.PB_DATA.HOLDINGS.find(h => h.ticker === t) || window.PB_DATA.NEW_PICKS.find(p => p.ticker === t);
  if (holding && holding.sector) { const s = N(holding.sector); if (s !== 'Other') return { sector: s, industry: holding.sector }; }
  const hedge = window.PB_DATA.HEDGES.find(h => h.ticker === t);
  if (hedge) { const s = N(hedge.role); return { sector: s !== 'Other' ? s : 'ETFs & Funds', industry: hedge.role || 'Fund' }; }
  return { sector: 'Other', industry: 'Other' };
};
