// Per-market logo resolution. The ONE rule this file exists to enforce:
// outside the US market, a bare ticker is never a lookup key. Bare-ticker
// endpoints are US-centric and return the US listing with a 200 — MTN resolves
// to Vail Resorts, SOL to ReneSola. See the spec, §1 Claim A.
//
// The safe key outside the US is the company's own DOMAIN. A domain is
// self-evidently checkable by a human reading this file (a ticker→ISIN row is
// not), and a domain-keyed icon service can only ever answer with art from that
// company's own site. That is why DOMAIN_BY_KEY carries the non-US universe and
// ISIN_BY_TICKER is now only a fallback for the handful it was already pinned on.

export const ISIN_BY_TICKER = {
  'JSE:NPN': 'ZAE000015889', 'JSE:SOL': 'ZAE000006896', 'JSE:MTN': 'ZAE000042164',
  'JSE:SHP': 'ZAE000012084', 'JSE:PRX': 'NL0013654783', 'JSE:FSR': 'ZAE000066304',
  'JSE:CPI': 'ZAE000035861', 'JSE:BVT': 'ZAE000117321', 'JSE:KIO': 'ZAE000085346',
  'JSE:DSY': 'ZAE000022331', 'JSE:AGL': 'GB00B1XZS820', 'JSE:BTI': 'GB0002875804',
  'JSE:CFR': 'CH0210483332', 'JSE:ABG': 'ZAE000255915', 'JSE:SBK': 'ZAE000109815',
};

// MARKET:TICKER -> the company's primary web domain. Every entry here is the
// operating company's own site, so the art that comes back is its own mark.
// Dual listings (BHP on JSE and ASX, Glencore on JSE and LSE) deliberately
// repeat the same domain — one company, one mark.
export const DOMAIN_BY_KEY = {
  // ─── JSE operating companies ──────────────────────────────────────────────
  'JSE:ABG': 'absa.africa', 'JSE:ADH': 'advtech.co.za', 'JSE:AEL': 'altron.com',
  'JSE:AFE': 'aeciworld.com', 'JSE:AFH': 'alexforbes.com', 'JSE:AGL': 'angloamerican.com',
  'JSE:ANG': 'anglogoldashanti.com', 'JSE:APH': 'alphaminresources.com',
  'JSE:APN': 'aspenpharma.com', 'JSE:ARI': 'arm.co.za', 'JSE:ARL': 'astralfoods.com',
  'JSE:AVI': 'avi.co.za', 'JSE:BAT': 'brait.com', 'JSE:BHG': 'bhp.com',
  'JSE:BID': 'bidcorpgroup.com', 'JSE:BLU': 'bluelabeltelecoms.co.za', 'JSE:BTI': 'bat.com',
  'JSE:BVT': 'bidvest.com', 'JSE:BYI': 'bytesplc.com', 'JSE:CFR': 'richemont.com',
  'JSE:CGR': 'calgrom3.com', 'JSE:CLS': 'clicksgroup.co.za', 'JSE:CMH': 'cmh.co.za',
  'JSE:CML': 'coronation.com', 'JSE:CPI': 'capitecbank.co.za', 'JSE:DCP': 'dischem.co.za',
  'JSE:DRD': 'drdgold.com', 'JSE:DSY': 'discovery.co.za', 'JSE:DTC': 'datatec.com',
  'JSE:EQU': 'equites.co.za', 'JSE:EXX': 'exxaro.com', 'JSE:FBR': 'famousbrands.co.za',
  'JSE:FFB': 'fortressfund.co.za', 'JSE:FSR': 'firstrand.co.za', 'JSE:GFI': 'goldfields.com',
  'JSE:GLN': 'glencore.com', 'JSE:GND': 'grindrod.com', 'JSE:GRT': 'growthpoint.co.za',
  'JSE:HAR': 'harmony.co.za', 'JSE:HCI': 'hci.co.za', 'JSE:HDC': 'hudaco.co.za',
  'JSE:HMN': 'hammerson.com', 'JSE:HYP': 'hyprop.co.za', 'JSE:IMP': 'implats.co.za',
  'JSE:INL': 'investec.com', 'JSE:INP': 'investec.com', 'JSE:ITE': 'italtile.co.za',
  'JSE:JSE': 'jse.co.za', 'JSE:KAP': 'kap.co.za', 'JSE:KIO': 'angloamericankumba.com',
  'JSE:KRO': 'karooooo.com', 'JSE:KST': 'psg.co.za', 'JSE:LBR': 'libstar.co.za',
  'JSE:LHC': 'lifehealthcare.co.za', 'JSE:LTE': 'lighthouse.mu', 'JSE:MNP': 'mondigroup.com',
  'JSE:MRP': 'mrpricegroup.com', 'JSE:MSP': 'masrei.com', 'JSE:MTA': 'metair.co.za',
  'JSE:MTH': 'motus.co.za', 'JSE:MTM': 'momentum.co.za', 'JSE:MTN': 'mtn.com',
  'JSE:NED': 'nedbank.co.za', 'JSE:NPH': 'northam.co.za', 'JSE:NPK': 'nampak.com',
  'JSE:NPN': 'naspers.com', 'JSE:NRP': 'nepirockcastle.com', 'JSE:NTC': 'netcare.co.za',
  'JSE:OCE': 'oceana.co.za', 'JSE:OMN': 'omnia.co.za', 'JSE:OMU': 'oldmutual.com',
  'JSE:OUT': 'outsurance.co.za', 'JSE:PAN': 'panafricanresources.com', 'JSE:PIK': 'pnp.co.za',
  'JSE:PPC': 'ppc.africa', 'JSE:PPH': 'pepkor.co.za', 'JSE:PRX': 'prosus.com',
  'JSE:QLT': 'quilter.com', 'JSE:RBX': 'raubex.com', 'JSE:RCL': 'rclfoods.com',
  'JSE:RDF': 'redefine.co.za', 'JSE:REM': 'remgro.com', 'JSE:RES': 'resilient.co.za',
  'JSE:RLO': 'reunert.com', 'JSE:RNI': 'reinet.com', 'JSE:SAC': 'sacorporatefund.co.za',
  'JSE:SAP': 'sappi.com', 'JSE:SBK': 'standardbank.com', 'JSE:SEA': 'spearprop.co.za',
  'JSE:SHC': 'shaftesburycapital.com', 'JSE:SHG': 'seaharvest.co.za', 'JSE:SHP': 'shoprite.co.za',
  'JSE:SLM': 'sanlam.com', 'JSE:SNT': 'santam.co.za', 'JSE:SOH': 'southoceanholdings.com',
  'JSE:SOL': 'sasol.com', 'JSE:SPP': 'spar.co.za', 'JSE:SSU': 'southernsun.com',
  'JSE:SSW': 'sibanyestillwater.com', 'JSE:SUI': 'suninternational.com',
  'JSE:SUR': 'spurcorporation.com', 'JSE:SYG': 'sygnia.co.za', 'JSE:TBS': 'tigerbrands.com',
  'JSE:TFG': 'tfglimited.co.za', 'JSE:TGA': 'thungela.com', 'JSE:THA': 'tharisa.com',
  'JSE:TKG': 'telkom.co.za', 'JSE:TRU': 'truworths.co.za', 'JSE:VAL': 'valterraplatinum.com',
  'JSE:VKE': 'vukile.co.za', 'JSE:VOD': 'vodacom.co.za', 'JSE:WBO': 'wbho.co.za',
  'JSE:WHL': 'woolworthsholdings.co.za', 'JSE:YRK': 'york.co.za', 'JSE:ZED': 'zeder.co.za',
  // JSE, remainder of the sector map: alternate codes, preference shares and
  // mid caps. A preference share carries its issuer's mark (ABSP is Absa).
  'JSE:ABSP': 'absa.africa', 'JSE:ADV': 'advtech.co.za', 'JSE:AEG': 'aveng.co.za',
  'JSE:AIL': 'arcinvestments.co.za', 'JSE:AIP': 'adcock.com', 'JSE:ALT': 'altron.com',
  'JSE:AMS': 'valterraplatinum.com', 'JSE:APF': 'acceleratepf.co.za', 'JSE:ARM': 'arm.co.za',
  'JSE:ART': 'argent.co.za', 'JSE:ATT': 'attacq.co.za', 'JSE:BAW': 'barloworld.com',
  'JSE:BGA': 'absa.africa', 'JSE:BHP': 'bhp.com', 'JSE:BWN': 'balwin.co.za',
  'JSE:CPIP': 'capitecbank.co.za', 'JSE:CSB': 'cashbuild.co.za', 'JSE:EMI': 'emira.co.za',
  'JSE:ENX': 'enxgroup.co.za', 'JSE:EOH': 'eoh.co.za', 'JSE:FFA': 'fortressfund.co.za',
  'JSE:GML': 'gemfieldsgroup.com', 'JSE:GPI': 'grandparade.co.za', 'JSE:IVT': 'invictaholdings.co.za',
  'JSE:LEW': 'lewisgroup.co.za', 'JSE:MCG': 'multichoice.com', 'JSE:MND': 'mondigroup.com',
  'JSE:MUR': 'murrob.com', 'JSE:N91': 'ninetyone.com', 'JSE:NHM': 'northam.co.za',
  'JSE:NIN': 'ninetyone.com', 'JSE:OCT': 'octodec.co.za', 'JSE:ORN': 'orionminerals.com.au',
  'JSE:PPE': 'purplegroup.co.za', 'JSE:PSG': 'psggroup.co.za', 'JSE:RBP': 'bafokengplatinum.co.za',
  'JSE:RFG': 'rfg.co.za', 'JSE:RMB': 'rmbh.co.za', 'JSE:RMH': 'rmbh.co.za',
  'JSE:RMI': 'outsurance.co.za', 'JSE:S32': 'south32.net', 'JSE:SEP': 'sephakuholdings.com',
  'JSE:SPG': 'supergroup.co.za', 'JSE:SSS': 'storage.co.za', 'JSE:TCP': 'transactioncapital.co.za',
  'JSE:TEX': 'textonproperty.co.za', 'JSE:TSG': 'tsogosun.com',
  // ─── LSE ──────────────────────────────────────────────────────────────────
  'LSE:HSBA': 'hsbc.com', 'LSE:BP': 'bp.com', 'LSE:SHEL': 'shell.com',
  'LSE:AZN': 'astrazeneca.com', 'LSE:GSK': 'gsk.com', 'LSE:ULVR': 'unilever.com',
  'LSE:RIO': 'riotinto.com', 'LSE:AAL': 'angloamerican.com', 'LSE:GLEN': 'glencore.com',
  'LSE:VOD': 'vodafone.com', 'LSE:BT-A': 'bt.com', 'LSE:LLOY': 'lloydsbank.com',
  'LSE:BARC': 'barclays.co.uk', 'LSE:NWG': 'natwestgroup.com', 'LSE:STAN': 'sc.com',
  'LSE:DGE': 'diageo.com', 'LSE:REL': 'relx.com', 'LSE:CPG': 'compass-group.com',
  'LSE:WPP': 'wpp.com', 'LSE:EXPN': 'experianplc.com', 'LSE:LSE': 'lseg.com',
  'LSE:NG': 'nationalgrid.com', 'LSE:SSE': 'sse.com', 'LSE:BKG': 'berkeleygroup.co.uk',
  'LSE:ABDN': 'abrdn.com', 'LSE:ABF': 'abf.co.uk', 'LSE:ADM': 'admiralgroup.co.uk',
  'LSE:AHT': 'ashtead-group.com', 'LSE:AJB': 'ajbell.co.uk', 'LSE:ANTO': 'antofagasta.co.uk',
  'LSE:AV': 'aviva.com', 'LSE:BA': 'baesystems.com', 'LSE:BAB': 'babcockinternational.com',
  'LSE:BATS': 'bat.com', 'LSE:BBOX': 'tritaxbigbox.co.uk', 'LSE:BDEV': 'barrattredrow.co.uk',
  'LSE:BGEO': 'bankofgeorgiagroup.com', 'LSE:BLND': 'britishland.com', 'LSE:BME': 'bmstores.co.uk',
  'LSE:BNZL': 'bunzl.com', 'LSE:CBG': 'closebrothers.com', 'LSE:CCH': 'coca-colahellenic.com',
  'LSE:CNA': 'centrica.com', 'LSE:CRDA': 'croda.com', 'LSE:CRH': 'crh.com',
  'LSE:CTEC': 'convatecgroup.com', 'LSE:DCC': 'dcc.ie', 'LSE:DRX': 'drax.com',
  'LSE:ENQ': 'enquest.com', 'LSE:ENT': 'entaingroup.com', 'LSE:FLTR': 'flutter.com',
  'LSE:FRAS': 'frasers.group', 'LSE:FRES': 'fresnilloplc.com', 'LSE:FXPO': 'ferrexpo.com',
  'LSE:GAW': 'games-workshop.com', 'LSE:GNS': 'genusplc.com', 'LSE:GRI': 'graingerplc.co.uk',
  'LSE:HBR': 'harbourenergy.com', 'LSE:HIK': 'hikma.com', 'LSE:HLMA': 'halma.com',
  'LSE:HLN': 'haleon.com', 'LSE:HOC': 'hochschildmining.com', 'LSE:HSX': 'hiscoxgroup.com',
  'LSE:HWDN': 'howdenjoinerygroupplc.com', 'LSE:IAG': 'iairgroup.com', 'LSE:ICG': 'icgam.com',
  'LSE:IGG': 'iggroup.com', 'LSE:III': '3i.com', 'LSE:IMB': 'imperialbrandsplc.com',
  'LSE:IMI': 'imiplc.com', 'LSE:INVP': 'investec.com', 'LSE:ITV': 'itvplc.com',
  'LSE:JD': 'jdplc.com', 'LSE:KNOS': 'kainos.com', 'LSE:LAND': 'landsec.com',
  'LSE:LGEN': 'legalandgeneralgroup.com', 'LSE:LSEG': 'lseg.com', 'LSE:MNDI': 'mondigroup.com',
  'LSE:MNG': 'mandg.com', 'LSE:MRO': 'melroseplc.net', 'LSE:NXT': 'nextplc.co.uk',
  'LSE:OCDO': 'ocadogroup.com', 'LSE:OSB': 'osb.co.uk', 'LSE:PAGE': 'page.com',
  'LSE:PETS': 'petsathome.com', 'LSE:PHNX': 'thephoenixgroup.com', 'LSE:PHP': 'phpgroup.co.uk',
  'LSE:PNN': 'pennon-group.co.uk', 'LSE:PRU': 'prudentialplc.com', 'LSE:PSN': 'persimmonhomes.com',
  'LSE:PSON': 'pearson.com', 'LSE:QQ': 'qinetiq.com', 'LSE:RKT': 'reckitt.com',
  'LSE:ROR': 'rotork.com', 'LSE:RR': 'rolls-royce.com', 'LSE:RTO': 'rentokil-initial.com',
  'LSE:SBRY': 'sainsburys.co.uk', 'LSE:SDR': 'schroders.com', 'LSE:SDRC': 'schroders.com',
  'LSE:SGE': 'sage.com', 'LSE:SGRO': 'segro.com', 'LSE:SMIN': 'smiths.com',
  'LSE:SN': 'smith-nephew.com', 'LSE:SPX': 'spiraxgroup.com', 'LSE:STJ': 'sjp.co.uk',
  'LSE:SVT': 'severntrent.com', 'LSE:SXS': 'spectris.com', 'LSE:TLW': 'tullowoil.com',
  'LSE:TSCO': 'tescoplc.com', 'LSE:TUI': 'tuigroup.com', 'LSE:TW': 'taylorwimpey.co.uk',
  'LSE:UTG': 'unite-group.co.uk', 'LSE:UU': 'unitedutilities.com', 'LSE:WEIR': 'global.weir',
  'LSE:WIZ': 'wizzair.com', 'LSE:WTB': 'whitbread.co.uk',
  // ─── ASX ──────────────────────────────────────────────────────────────────
  'ASX:CBA': 'commbank.com.au', 'ASX:BHP': 'bhp.com', 'ASX:CSL': 'csl.com',
  'ASX:ANZ': 'anz.com.au', 'ASX:WBC': 'westpac.com.au', 'ASX:NAB': 'nab.com.au',
  'ASX:WES': 'wesfarmers.com.au', 'ASX:WOW': 'woolworthsgroup.com.au',
  'ASX:MQG': 'macquarie.com', 'ASX:RIO': 'riotinto.com', 'ASX:FMG': 'fmgl.com.au',
  'ASX:TCL': 'transurban.com', 'ASX:GMG': 'goodman.com', 'ASX:REA': 'rea-group.com',
  'ASX:ALL': 'aristocrat.com', 'ASX:COL': 'colesgroup.com.au', 'ASX:TLS': 'telstra.com.au',
  'ASX:XRO': 'xero.com', 'ASX:APX': 'appen.com', 'ASX:APT': 'afterpay.com',
  'ASX:ZIP': 'zip.co', 'ASX:A2M': 'thea2milkcompany.com', 'ASX:ALU': 'altium.com',
  'ASX:AMC': 'amcor.com', 'ASX:APA': 'apagroup.com.au', 'ASX:ASX': 'asx.com.au',
  'ASX:AZJ': 'aurizon.com.au', 'ASX:BXB': 'brambles.com', 'ASX:CAR': 'carsales.com.au',
  'ASX:COH': 'cochlear.com', 'ASX:CPU': 'computershare.com', 'ASX:DMP': 'dominos.com.au',
  'ASX:EVN': 'evolutionmining.com.au', 'ASX:GPT': 'gpt.com.au', 'ASX:HVN': 'harveynormanholdings.com.au',
  'ASX:IAG': 'iag.com.au', 'ASX:IGO': 'igo.com.au', 'ASX:JBH': 'jbhifi.com.au',
  'ASX:JHX': 'jameshardie.com.au', 'ASX:LYC': 'lynasrareearths.com', 'ASX:MFG': 'magellangroup.com.au',
  'ASX:MGR': 'mirvac.com', 'ASX:MIN': 'mineralresources.com.au', 'ASX:NEM': 'newmont.com',
  'ASX:NST': 'nsrltd.com', 'ASX:ORG': 'originenergy.com.au', 'ASX:PLS': 'pilbaraminerals.com.au',
  'ASX:PME': 'promedicus.com', 'ASX:QAN': 'qantas.com', 'ASX:QBE': 'qbe.com',
  'ASX:RHC': 'ramsayhealth.com', 'ASX:RMD': 'resmed.com', 'ASX:S32': 'south32.net',
  'ASX:SCG': 'scentregroup.com', 'ASX:SEK': 'seek.com.au', 'ASX:SGP': 'stockland.com.au',
  'ASX:SHL': 'sonichealthcare.com', 'ASX:STO': 'santos.com', 'ASX:SUN': 'suncorpgroup.com.au',
  'ASX:TWE': 'tweglobal.com', 'ASX:WDS': 'woodside.com', 'ASX:WHC': 'whitehavencoal.com.au',
  'ASX:WTC': 'wisetechglobal.com',
  // ─── Frankfurt (XETRA) ────────────────────────────────────────────────────
  'FRA:SAP': 'sap.com', 'FRA:SIE': 'siemens.com', 'FRA:ALV': 'allianz.com',
  'FRA:DTE': 'telekom.com', 'FRA:BMW': 'bmwgroup.com', 'FRA:VOW3': 'volkswagen-group.com',
  'FRA:MBG': 'mercedes-benz.com', 'FRA:DBK': 'db.com', 'FRA:BAS': 'basf.com',
  'FRA:BAYN': 'bayer.com', 'FRA:IFX': 'infineon.com', 'FRA:MUV2': 'munichre.com',
  'FRA:PAH3': 'porsche-se.com', 'FRA:P911': 'porsche.com', 'FRA:PORS': 'porsche.com',
  'FRA:CON': 'continental.com', 'FRA:HEN3': 'henkel.com', 'FRA:BEI': 'beiersdorf.com',
  'FRA:FRE': 'fresenius.com', 'FRA:RWE': 'rwe.com', 'FRA:EOAN': 'eon.com',
  'FRA:MTX': 'mtu.de', 'FRA:HEI': 'heidelbergmaterials.com', 'FRA:HOT': 'hochtief.com',
  'FRA:CBK': 'commerzbank.com', 'FRA:DB1': 'deutsche-boerse.com', 'FRA:HNR1': 'hannover-re.com',
  'FRA:ADS': 'adidas-group.com', 'FRA:PUM': 'puma.com', 'FRA:ZAL': 'zalando.com',
  'FRA:HFG': 'hellofreshgroup.com', 'FRA:LIN': 'linde.com', 'FRA:SY1': 'symrise.com',
  'FRA:COV': 'covestro.com', 'FRA:1COV': 'covestro.com', 'FRA:SHL': 'siemens-healthineers.com',
  'FRA:MRK': 'merckgroup.com', 'FRA:QIA': 'qiagen.com', 'FRA:VNA': 'vonovia.de',
  'FRA:LEG': 'leg-se.com', 'FRA:DPW': 'dhl.com', 'FRA:BNR': 'brenntag.com',
  'FRA:ENR': 'siemens-energy.com',
  // ─── Euronext Paris ───────────────────────────────────────────────────────
  'PAR:AIR': 'airbus.com', 'PAR:SU': 'se.com', 'PAR:SAF': 'safran-group.com',
  'PAR:VIE': 'veolia.com', 'PAR:TTE': 'totalenergies.com', 'PAR:SAN': 'sanofi.com',
  'PAR:BNP': 'bnpparibas.com', 'PAR:GLE': 'societegenerale.com', 'PAR:ACA': 'credit-agricole.com',
  'PAR:CS': 'axa.com', 'PAR:MC': 'lvmh.com', 'PAR:RMS': 'hermes.com',
  'PAR:KER': 'kering.com', 'PAR:EL': 'essilorluxottica.com', 'PAR:OR': 'loreal.com',
  'PAR:BN': 'danone.com', 'PAR:RI': 'pernod-ricard.com', 'PAR:AI': 'airliquide.com',
  'PAR:ORA': 'orange.com', 'PAR:PUB': 'publicisgroupe.com', 'PAR:VIV': 'vivendi.com',
  'PAR:ENGI': 'engie.com', 'PAR:CAP': 'capgemini.com', 'PAR:LR': 'legrand.com',
  'PAR:ALO': 'alstom.com', 'PAR:AMUN': 'amundi.com', 'PAR:HO': 'thalesgroup.com',
  'PAR:STLAP': 'stellantis.com', 'PAR:ERA': 'eramet.com', 'PAR:TFI': 'groupe-tf1.fr',
  'PAR:ATO': 'atos.net', 'PAR:DSY': '3ds.com', 'PAR:STMPA': 'st.com', 'PAR:STM': 'st.com',
  'PAR:URW': 'urw.com', 'PAR:GFC': 'gecina.fr', 'PAR:SGO': 'saint-gobain.com',
  'PAR:ML': 'michelin.com', 'PAR:DG': 'vinci.com', 'PAR:EN': 'bouygues.com',
  'PAR:TEP': 'teleperformance.com', 'PAR:CA': 'carrefour.com', 'PAR:BVI': 'bureauveritas.com',
  'PAR:EDEN': 'edenred.com', 'PAR:ERF': 'eurofins.com',
  // ─── Euronext Amsterdam ───────────────────────────────────────────────────
  'AMS:ASML': 'asml.com', 'AMS:ADYEN': 'adyen.com', 'AMS:PHIA': 'philips.com',
  'AMS:INGA': 'ing.com', 'AMS:ABN': 'abnamro.com', 'AMS:AGN': 'aegon.com',
  'AMS:NN': 'nn-group.com', 'AMS:HEIA': 'theheinekencompany.com', 'AMS:AD': 'aholddelhaize.com',
  'AMS:PRX': 'prosus.com', 'AMS:UMG': 'universalmusic.com', 'AMS:AKZA': 'akzonobel.com',
  'AMS:WKL': 'wolterskluwer.com', 'AMS:RAND': 'randstad.com', 'AMS:BESI': 'besi.com',
  'AMS:ASM': 'asm.com', 'AMS:ASRNL': 'asrnl.com', 'AMS:JDEP': 'jdepeets.com',
  'AMS:OCI': 'oci-global.com', 'AMS:AALB': 'aalberts.com', 'AMS:PNL': 'postnl.nl',
  'AMS:TKWY': 'justeattakeaway.com', 'AMS:UNA': 'unilever.com', 'AMS:MT': 'arcelormittal.com',
  'AMS:GLPG': 'glpg.com', 'AMS:IMCD': 'imcdgroup.com', 'AMS:KPN': 'kpn.com',
  'AMS:EXO': 'exor.com', 'AMS:REN': 'relx.com',
  // EU_SUGGESTIONS rows without an `exchange` fall back to FRA, so the handful
  // that names Amsterdam/Paris companies needs both keys.
  'FRA:ASML': 'asml.com', 'FRA:PHIA': 'philips.com', 'FRA:INGA': 'ing.com',
  'FRA:HEIA': 'theheinekencompany.com', 'FRA:AIR': 'airbus.com', 'FRA:TTE': 'totalenergies.com',
  'FRA:SAN': 'sanofi.com', 'FRA:BNP': 'bnpparibas.com', 'FRA:MC': 'lvmh.com',
  'FRA:OR': 'loreal.com', 'FRA:SU': 'se.com', 'FRA:AI': 'airliquide.com',
};

// SA ETFs carry the managing house's mark: an investor recognises "Satrix", not
// a per-fund logo that does not exist. Prefix order matters — the first match
// wins, so the longer, more specific prefixes come first.
export const ISSUER_BY_PREFIX = [
  { test: /^STX/, issuer: 'satrix' },
  { test: /^SY[GF]/, issuer: 'sygnia' },          // SYG*, and SYFANG (Itrix FANG.AI)
  { test: /^ETF/, issuer: '1nvest' },
  { test: /^NF|^NEWUSD$|^NGPL|^GLD$/, issuer: 'newfunds' },
  { test: /^COG|^COOPTI/, issuer: 'coronation' },
  { test: /^ASH/, issuer: 'ashburton' },
  { test: /^FNB/, issuer: 'fnb' },
  // CoreShares was absorbed by 10X, so its CS*/CTOP/DIVTRX range and 10X's own
  // funds are one house today and must not render as two different marks.
  { test: /^CS[PENT]|^CTOP|^DIVTRX|^GLODIV|^GLPROP|^GLOBAL$|^INCOME$|^APACXJ|^WNXT40|^WTOP20/, issuer: 'tenx' },
  { test: /^AAG|^AAS|^EASY|^CARTBL/, issuer: 'easyetfs' },
  { test: /^RW(DVF|GPR|INC)/, issuer: 'reitway' },
  { test: /^PCWGE/, issuer: 'portfoliometrix' },
  { test: /^VUNGLE/, issuer: 'vunani' },
];

export const ISSUERS = {
  satrix: { name: 'Satrix', domain: 'satrix.co.za' },
  sygnia: { name: 'Sygnia', domain: 'sygnia.co.za' },
  '1nvest': { name: '1nvest', domain: '1nvest.co.za' },
  newfunds: { name: 'NewFunds', domain: 'newfunds.co.za' },
  coronation: { name: 'Coronation', domain: 'coronation.com' },
  ashburton: { name: 'Ashburton', domain: 'ashburtoninvestments.com' },
  fnb: { name: 'FNB', domain: 'fnb.co.za' },
  tenx: { name: '10X', domain: '10x.co.za' },
  easyetfs: { name: 'EasyETFs', domain: 'easyequities.co.za' },
  reitway: { name: 'Reitway Global', domain: 'reitwayglobal.com' },
  portfoliometrix: { name: 'PortfolioMetrix', domain: 'portfoliometrix.com' },
  vunani: { name: 'Vunani', domain: 'vunanifm.co.za' },
};

export const CRYPTO_ID = {
  BTC: 'btc', ETH: 'eth', XRP: 'xrp', SOL: 'sol', ADA: 'ada', DOGE: 'doge',
  DOT: 'dot', LINK: 'link', LTC: 'ltc', AVAX: 'avax', MATIC: 'matic', UNI: 'uni',
  BCH: 'bch', XLM: 'xlm', ATOM: 'atom', XMR: 'xmr', ETC: 'etc', FIL: 'fil',
  NEAR: 'near', ALGO: 'algo', HBAR: 'hbar', AAVE: 'aave', MKR: 'mkr', TRX: 'trx',
  USDT: 'usdt', USDC: 'usdc', BNB: 'bnb', SHIB: 'shib', TON: 'ton', XTZ: 'xtz',
};

const CRYPTO_CDN = 'https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color';

export function issuerFor(ticker) {
  const hit = ISSUER_BY_PREFIX.find(p => p.test.test(ticker));
  return hit ? hit.issuer : null;
}

// The issuer prefixes describe SA-listed funds only. Applying them anywhere else
// would misread US tickers that happen to collide — GLD is NewGold on the JSE and
// SPDR Gold Shares in New York.
const FUND_MARKETS = new Set(['JSE', 'TFSA']);
export function domainFor(market, ticker) {
  const direct = DOMAIN_BY_KEY[`${market}:${ticker}`];
  if (direct) return direct;
  if (!FUND_MARKETS.has(market)) return null;
  const issuer = issuerFor(ticker);
  return issuer && ISSUERS[issuer] ? ISSUERS[issuer].domain : null;
}

// Keys whose available art is KNOWN WRONG. A denied key resolves to nothing, so
// the UI falls back to its monogram rather than showing another company's mark.
// Do not remove an entry here without new art verified by eye.
//
// JSE:KIO — Kumba Iron Ore is an Anglo American subsidiary and every source,
// including angloamericankumba.com's own icon, returns the parent Anglo American
// blue/red triangle. Verified again by eye on 2026-07-27. The owner ruled it
// must be Kumba's own mark or nothing.
export const DENY = new Set([
  'JSE:KIO',
]);

// Tickers that must reuse another key's art, so one issuer is never rendered as
// several different marks. Providers return five different State Street variants
// across its nine funds — including two pieces of generic clipart (an orange brick
// square for XLB, a newspaper for XLC) that are not brand marks at all.
export const CANONICAL_ART = {
  'US:DIA': 'US:SPY', 'US:GLD': 'US:SPY', 'US:XLB': 'US:SPY', 'US:XLC': 'US:SPY',
  'US:XLI': 'US:SPY', 'US:XLK': 'US:SPY', 'US:XLP': 'US:SPY', 'US:XLRE': 'US:SPY',
  'US:XLU': 'US:SPY', 'US:XLV': 'US:SPY', 'US:XLY': 'US:SPY',
};

// Google's favicon service, keyed by domain. It 404s on an unknown host rather
// than inventing a placeholder, which is the property that matters: several
// competing services (icon.horse in particular) answer with a generated letter
// tile at HTTP 200, and three different JSE companies came back byte-identical.
export const faviconUrl = (domain, size = 256) =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;

// Icon paths a great many sites serve without declaring them in <head>. These
// live here rather than in the orchestrator so that ALL logo URL construction
// stays in the one file that knows the market rule — the orchestrator must never
// be able to invent a lookup key of its own.
export const WELL_KNOWN_ICON_PATHS = [
  '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png',
  '/favicon.svg', '/favicon.png',
];
export const siteUrl = (domain, path = '/') => `https://www.${domain}${path}`;

export function chainFor(market, ticker) {
  const out = [];
  if (DENY.has(`${market}:${ticker}`)) return out;
  if (market === 'CRYPTO') {
    const id = CRYPTO_ID[String(ticker).replace(/-USD$/i, '').toUpperCase()];
    // Stock APIs are deliberately absent here: FMP's SOL.png is ReneSola.
    if (id) out.push({ source: 'cryptocurrency-icons', key: 'coin', url: `${CRYPTO_CDN}/${id}.png` });
    return out;
  }
  if (market === 'US') {
    // FMP removed: it is the source of the rejected art (three iShares variants,
    // a bare cropped "i", blank-white QQQ/ARKK). Parqet at size=256 returns
    // high-quality pre-composed brand tiles.
    out.push({ source: 'parqet', key: 'ticker', url: `https://assets.parqet.com/logos/symbol/${encodeURIComponent(ticker)}?format=png&size=256` });
    return out;
  }
  // Every other market: the company's own domain first, then ISIN, then the
  // managing house. Never a bare ticker.
  const domain = domainFor(market, ticker);
  if (domain) {
    out.push({ source: 'favicon', key: 'domain', url: faviconUrl(domain), domain });
    out.push({ source: 'site', key: 'domain', domain });
  }
  const isin = ISIN_BY_TICKER[`${market}:${ticker}`];
  if (isin) out.push({ source: 'parqet-isin', key: 'isin', url: `https://assets.parqet.com/logos/isin/${isin}?format=png&size=256` });
  return out;
}
