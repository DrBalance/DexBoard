// ============================================
// admin.js — 관리자 API 핸들러 (v2)
// 새 스키마: groups, symbol_groups, bb_map_symbols
// worker.js에서 import해서 사용
// ============================================

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

// ── ETF 구성종목 정적 데이터 (2026-04-30 기준)
const ETF_HOLDINGS_DB = {
  "ARKK": [
    {
      "symbol": "TSLA",
      "name": "Tesla Inc",
      "pct": 9.73
    },
    {
      "symbol": "TEM",
      "name": "Tempus AI Inc",
      "pct": 5.35
    },
    {
      "symbol": "AMD",
      "name": "Advanced Micro Devices",
      "pct": 5.18
    },
    {
      "symbol": "CRSP",
      "name": "CRISPR Therapeutics AG",
      "pct": 4.98
    },
    {
      "symbol": "SHOP",
      "name": "Shopify Inc",
      "pct": 4.37
    },
    {
      "symbol": "ROKU",
      "name": "Roku Inc",
      "pct": 4.33
    },
    {
      "symbol": "HOOD",
      "name": "Robinhood Markets Inc",
      "pct": 4.3
    },
    {
      "symbol": "COIN",
      "name": "Coinbase Global Inc",
      "pct": 4.23
    },
    {
      "symbol": "CRCL",
      "name": "Circle Internet Group Inc",
      "pct": 3.84
    },
    {
      "symbol": "PLTR",
      "name": "Palantir Technologies Inc",
      "pct": 3.13
    }
  ],
  "IGV": [
    {
      "symbol": "MSFT",
      "name": "Microsoft Corp",
      "pct": 8.79
    },
    {
      "symbol": "ORCL",
      "name": "Oracle Corp",
      "pct": 8.64
    },
    {
      "symbol": "PLTR",
      "name": "Palantir Technologies Inc",
      "pct": 8.01
    },
    {
      "symbol": "CRM",
      "name": "Salesforce Inc",
      "pct": 6.68
    },
    {
      "symbol": "PANW",
      "name": "Palo Alto Networks Inc",
      "pct": 5.86
    },
    {
      "symbol": "APP",
      "name": "AppLovin Corp",
      "pct": 4.88
    },
    {
      "symbol": "CRWD",
      "name": "CrowdStrike Holdings Inc",
      "pct": 4.59
    },
    {
      "symbol": "ADBE",
      "name": "Adobe Inc",
      "pct": 4.13
    },
    {
      "symbol": "INTU",
      "name": "Intuit Inc",
      "pct": 4.08
    }
  ],
  "IYR": [
    {
      "symbol": "WELL",
      "name": "Welltower Inc",
      "pct": 10.14
    },
    {
      "symbol": "PLD",
      "name": "Prologis REIT Inc",
      "pct": 9.14
    },
    {
      "symbol": "EQIX",
      "name": "Equinix REIT Inc",
      "pct": 4.8
    },
    {
      "symbol": "DLR",
      "name": "Digital Realty Trust REIT Inc",
      "pct": 4.78
    },
    {
      "symbol": "SPG",
      "name": "Simon Property Group REIT Inc",
      "pct": 4.63
    },
    {
      "symbol": "AMT",
      "name": "American Tower REIT Corp",
      "pct": 4.31
    },
    {
      "symbol": "O",
      "name": "Realty Income REIT Corp",
      "pct": 4.28
    },
    {
      "symbol": "PSA",
      "name": "Public Storage REIT",
      "pct": 3.52
    },
    {
      "symbol": "VTR",
      "name": "Ventas REIT Inc",
      "pct": 3.08
    }
  ],
  "KRE": [
    {
      "symbol": "EWBC",
      "name": "East West Bancorp Inc",
      "pct": 1.63
    },
    {
      "symbol": "WAL",
      "name": "Western Alliance Bancorp",
      "pct": 1.6
    },
    {
      "symbol": "BPOP",
      "name": "Popular Inc",
      "pct": 1.59
    },
    {
      "symbol": "PNFP",
      "name": "Pinnacle Financial Partners Inc",
      "pct": 1.59
    },
    {
      "symbol": "ZION",
      "name": "Zions Bancorp NA",
      "pct": 1.58
    },
    {
      "symbol": "VLY",
      "name": "Valley National Bancorp",
      "pct": 1.55
    },
    {
      "symbol": "ASB",
      "name": "Associated Banc-Corp",
      "pct": 1.55
    },
    {
      "symbol": "UMBF",
      "name": "UMB Financial Corp",
      "pct": 1.54
    },
    {
      "symbol": "FLG",
      "name": "Flagstar Bank NA",
      "pct": 1.54
    }
  ],
  "SOXX": [
    {
      "symbol": "AMD",
      "name": "Advanced Micro Devices Inc",
      "pct": 8.03
    },
    {
      "symbol": "AVGO",
      "name": "Broadcom Inc",
      "pct": 7.95
    },
    {
      "symbol": "MU",
      "name": "Micron Technology Inc",
      "pct": 7.63
    },
    {
      "symbol": "NVDA",
      "name": "NVIDIA Corp",
      "pct": 6.85
    },
    {
      "symbol": "INTC",
      "name": "Intel Corp",
      "pct": 6.3
    },
    {
      "symbol": "MRVL",
      "name": "Marvell Technology Inc",
      "pct": 6.15
    },
    {
      "symbol": "AMAT",
      "name": "Applied Materials Inc",
      "pct": 4.81
    },
    {
      "symbol": "MPWR",
      "name": "Monolithic Power Systems Inc",
      "pct": 4.3
    },
    {
      "symbol": "TXN",
      "name": "Texas Instruments Inc",
      "pct": 4.03
    }
  ],
  "SMH": [
    {
      "symbol": "NVDA",
      "name": "NVIDIA Corp",
      "pct": 17.0
    },
    {
      "symbol": "TSM",
      "name": "Taiwan Semiconductor Manufacturing Co ADR",
      "pct": 10.49
    },
    {
      "symbol": "AVGO",
      "name": "Broadcom Inc",
      "pct": 7.95
    },
    {
      "symbol": "INTC",
      "name": "Intel Corp",
      "pct": 7.02
    },
    {
      "symbol": "AMD",
      "name": "Advanced Micro Devices Inc",
      "pct": 6.17
    },
    {
      "symbol": "TXN",
      "name": "Texas Instruments Inc",
      "pct": 5.05
    },
    {
      "symbol": "MU",
      "name": "Micron Technology Inc",
      "pct": 4.89
    },
    {
      "symbol": "ADI",
      "name": "Analog Devices Inc",
      "pct": 4.49
    },
    {
      "symbol": "QCOM",
      "name": "Qualcomm Inc",
      "pct": 4.31
    }
  ],
  "OIH": [
    {
      "symbol": "SLB",
      "name": "SLB Ltd",
      "pct": 20.25
    },
    {
      "symbol": "BKR",
      "name": "Baker Hughes Co",
      "pct": 12.06
    },
    {
      "symbol": "HAL",
      "name": "Halliburton Co",
      "pct": 6.91
    },
    {
      "symbol": "FTI",
      "name": "TechnipFMC PLC",
      "pct": 6.29
    },
    {
      "symbol": "TS",
      "name": "Tenaris SA ADR",
      "pct": 5.03
    },
    {
      "symbol": "WFRD",
      "name": "Weatherford International PLC",
      "pct": 4.59
    },
    {
      "symbol": "NE",
      "name": "Noble Corp PLC",
      "pct": 4.34
    },
    {
      "symbol": "RIG",
      "name": "Transocean Ltd",
      "pct": 4.17
    },
    {
      "symbol": "VAL",
      "name": "Valaris Ltd",
      "pct": 3.76
    }
  ],
  "GDX": [
    {
      "symbol": "AEM",
      "name": "Agnico Eagle Mines Ltd",
      "pct": 11.59
    },
    {
      "symbol": "NEM",
      "name": "Newmont Corp",
      "pct": 11.43
    },
    {
      "symbol": "GOLD",
      "name": "Barrick Mining Corp",
      "pct": 7.61
    },
    {
      "symbol": "AU",
      "name": "Anglogold Ashanti PLC",
      "pct": 5.07
    },
    {
      "symbol": "FNV",
      "name": "Franco-Nevada Corp",
      "pct": 4.98
    },
    {
      "symbol": "WPM",
      "name": "Wheaton Precious Metals Corp",
      "pct": 4.89
    },
    {
      "symbol": "KGC",
      "name": "Kinross Gold Corp",
      "pct": 4.8
    },
    {
      "symbol": "GFI",
      "name": "Gold Fields Ltd ADR",
      "pct": 4.34
    },
    {
      "symbol": "PAAS",
      "name": "Pan American Silver Corp",
      "pct": 3.16
    }
  ],
  "GDXJ": [
    {
      "symbol": "AGI",
      "name": "Alamos Gold Inc",
      "pct": 6.52
    },
    {
      "symbol": "EQX",
      "name": "Equinox Gold Corp",
      "pct": 6.52
    },
    {
      "symbol": "CDE",
      "name": "Coeur Mining Inc",
      "pct": 6.5
    },
    {
      "symbol": "IAG",
      "name": "Iamgold Corp",
      "pct": 2.16
    },
    {
      "symbol": "AG",
      "name": "First Majestic Silver Corp",
      "pct": 2.63
    },
    {
      "symbol": "HL",
      "name": "Hecla Mining Co",
      "pct": 2.23
    }
  ],
  "SIL": [
    {
      "symbol": "WPM",
      "name": "Wheaton Precious Metals Corp",
      "pct": 22.48
    },
    {
      "symbol": "PAAS",
      "name": "Pan American Silver Corp",
      "pct": 12.26
    },
    {
      "symbol": "CDE",
      "name": "Coeur Mining Inc",
      "pct": 7.32
    },
    {
      "symbol": "AG",
      "name": "First Majestic Silver Corp",
      "pct": 5.51
    },
    {
      "symbol": "HL",
      "name": "Hecla Mining Co",
      "pct": 5.08
    },
    {
      "symbol": "SSRM",
      "name": "SSR Mining Inc",
      "pct": 4.28
    }
  ],
  "SILJ": [
    {
      "symbol": "AG",
      "name": "First Majestic Silver Corp",
      "pct": 10.34
    },
    {
      "symbol": "CDE",
      "name": "Coeur Mining Inc",
      "pct": 9.61
    },
    {
      "symbol": "HL",
      "name": "Hecla Mining Co",
      "pct": 8.75
    },
    {
      "symbol": "WPM",
      "name": "Wheaton Precious Metals Corp",
      "pct": 5.87
    },
    {
      "symbol": "HYMC",
      "name": "Hycroft Mining Holding Corp",
      "pct": 4.23
    },
    {
      "symbol": "EXK",
      "name": "Endeavour Silver Corp",
      "pct": 4.12
    },
    {
      "symbol": "PAAS",
      "name": "Pan American Silver Corp",
      "pct": 3.72
    }
  ],
  "COPX": [
    {
      "symbol": "FCX",
      "name": "Freeport-McMoRan Inc",
      "pct": 5.06
    },
    {
      "symbol": "HBM",
      "name": "Hudbay Minerals Inc",
      "pct": 4.95
    },
    {
      "symbol": "BHP",
      "name": "BHP Group Ltd ADR",
      "pct": 4.92
    },
    {
      "symbol": "TECK",
      "name": "Teck Resources Ltd",
      "pct": 4.86
    }
  ],
  "URA": [
    {
      "symbol": "CCJ",
      "name": "Cameco Corp",
      "pct": 23.13
    },
    {
      "symbol": "OKLO",
      "name": "Oklo Inc",
      "pct": 7.31
    },
    {
      "symbol": "NXE",
      "name": "NexGen Energy Ltd",
      "pct": 6.27
    },
    {
      "symbol": "UEC",
      "name": "Uranium Energy Corp",
      "pct": 5.79
    },
    {
      "symbol": "UUUU",
      "name": "Energy Fuels Inc",
      "pct": 4.24
    }
  ],
  "XLB": [
    {
      "symbol": "LIN",
      "name": "Linde PLC",
      "pct": 14.14
    },
    {
      "symbol": "NEM",
      "name": "Newmont Corp",
      "pct": 7.33
    },
    {
      "symbol": "NUE",
      "name": "Nucor Corp",
      "pct": 5.68
    },
    {
      "symbol": "FCX",
      "name": "Freeport-McMoRan Inc",
      "pct": 5.02
    },
    {
      "symbol": "CRH",
      "name": "CRH PLC",
      "pct": 4.93
    },
    {
      "symbol": "VMC",
      "name": "Vulcan Materials Co",
      "pct": 4.85
    },
    {
      "symbol": "APD",
      "name": "Air Products and Chemicals Inc",
      "pct": 4.68
    },
    {
      "symbol": "MLM",
      "name": "Martin Marietta Materials Inc",
      "pct": 4.49
    },
    {
      "symbol": "SHW",
      "name": "Sherwin-Williams Co",
      "pct": 4.48
    }
  ],
  "XLC": [
    {
      "symbol": "META",
      "name": "Meta Platforms Inc",
      "pct": 13.49
    },
    {
      "symbol": "GOOGL",
      "name": "Alphabet Inc Class A",
      "pct": 9.88
    },
    {
      "symbol": "GOOG",
      "name": "Alphabet Inc Class C",
      "pct": 7.88
    },
    {
      "symbol": "TTWO",
      "name": "Take-Two Interactive Software Inc",
      "pct": 4.62
    },
    {
      "symbol": "DIS",
      "name": "The Walt Disney Co",
      "pct": 4.59
    },
    {
      "symbol": "LYV",
      "name": "Live Nation Entertainment Inc",
      "pct": 4.44
    },
    {
      "symbol": "OMC",
      "name": "Omnicom Group Inc",
      "pct": 4.25
    },
    {
      "symbol": "NFLX",
      "name": "Netflix Inc",
      "pct": 4.2
    }
  ],
  "XLE": [
    {
      "symbol": "XOM",
      "name": "Exxon Mobil Corp",
      "pct": 22.18
    },
    {
      "symbol": "CVX",
      "name": "Chevron Corp",
      "pct": 16.61
    },
    {
      "symbol": "COP",
      "name": "ConocoPhillips",
      "pct": 7.06
    },
    {
      "symbol": "SLB",
      "name": "SLB Ltd",
      "pct": 4.62
    },
    {
      "symbol": "WMB",
      "name": "Williams Companies Inc",
      "pct": 4.37
    },
    {
      "symbol": "VLO",
      "name": "Valero Energy Corp",
      "pct": 4.19
    },
    {
      "symbol": "EOG",
      "name": "EOG Resources Inc",
      "pct": 4.14
    },
    {
      "symbol": "MPC",
      "name": "Marathon Petroleum Corp",
      "pct": 3.98
    },
    {
      "symbol": "PSX",
      "name": "Phillips 66",
      "pct": 3.92
    }
  ],
  "XLF": [
    {
      "symbol": "BRK.B",
      "name": "Berkshire Hathaway Inc Class B",
      "pct": 11.66
    },
    {
      "symbol": "JPM",
      "name": "JPMorgan Chase & Co",
      "pct": 11.34
    },
    {
      "symbol": "V",
      "name": "Visa Inc Class A",
      "pct": 7.44
    },
    {
      "symbol": "MA",
      "name": "Mastercard Inc Class A",
      "pct": 5.5
    },
    {
      "symbol": "BAC",
      "name": "Bank of America Corp",
      "pct": 4.76
    },
    {
      "symbol": "GS",
      "name": "The Goldman Sachs Group Inc",
      "pct": 3.72
    },
    {
      "symbol": "WFC",
      "name": "Wells Fargo & Co",
      "pct": 3.41
    },
    {
      "symbol": "MS",
      "name": "Morgan Stanley",
      "pct": 3.08
    },
    {
      "symbol": "C",
      "name": "Citigroup Inc",
      "pct": 3.0
    }
  ],
  "XLI": [
    {
      "symbol": "CAT",
      "name": "Caterpillar Inc",
      "pct": 7.61
    },
    {
      "symbol": "GE",
      "name": "GE Aerospace",
      "pct": 5.58
    },
    {
      "symbol": "GEV",
      "name": "GE Vernova Inc",
      "pct": 5.36
    },
    {
      "symbol": "RTX",
      "name": "RTX Corp",
      "pct": 4.34
    },
    {
      "symbol": "BA",
      "name": "Boeing Co",
      "pct": 3.3
    },
    {
      "symbol": "ETN",
      "name": "Eaton Corp PLC",
      "pct": 3.09
    },
    {
      "symbol": "UNP",
      "name": "Union Pacific Corp",
      "pct": 2.94
    },
    {
      "symbol": "UBER",
      "name": "Uber Technologies Inc",
      "pct": 2.82
    },
    {
      "symbol": "DE",
      "name": "Deere & Co",
      "pct": 2.73
    }
  ],
  "XLK": [
    {
      "symbol": "NVDA",
      "name": "NVIDIA Corp",
      "pct": 14.78
    },
    {
      "symbol": "AAPL",
      "name": "Apple Inc",
      "pct": 12.14
    },
    {
      "symbol": "MSFT",
      "name": "Microsoft Corp",
      "pct": 9.23
    },
    {
      "symbol": "AVGO",
      "name": "Broadcom Inc",
      "pct": 6.03
    },
    {
      "symbol": "MU",
      "name": "Micron Technology Inc",
      "pct": 4.32
    },
    {
      "symbol": "AMD",
      "name": "Advanced Micro Devices Inc",
      "pct": 4.29
    },
    {
      "symbol": "INTC",
      "name": "Intel Corp",
      "pct": 3.29
    },
    {
      "symbol": "CSCO",
      "name": "Cisco Systems Inc",
      "pct": 2.68
    },
    {
      "symbol": "LRCX",
      "name": "Lam Research Corp",
      "pct": 2.39
    }
  ],
  "XLP": [
    {
      "symbol": "WMT",
      "name": "Walmart Inc",
      "pct": 12.14
    },
    {
      "symbol": "COST",
      "name": "Costco Wholesale Corp",
      "pct": 9.45
    },
    {
      "symbol": "PG",
      "name": "Procter & Gamble Co",
      "pct": 7.18
    },
    {
      "symbol": "KO",
      "name": "Coca-Cola Co",
      "pct": 6.4
    },
    {
      "symbol": "PM",
      "name": "Philip Morris International Inc",
      "pct": 5.39
    },
    {
      "symbol": "MDLZ",
      "name": "Mondelez International Inc",
      "pct": 4.93
    },
    {
      "symbol": "MO",
      "name": "Altria Group Inc",
      "pct": 4.87
    },
    {
      "symbol": "PEP",
      "name": "PepsiCo Inc",
      "pct": 4.55
    },
    {
      "symbol": "CL",
      "name": "Colgate-Palmolive Co",
      "pct": 4.23
    }
  ],
  "XLU": [
    {
      "symbol": "NEE",
      "name": "NextEra Energy Inc",
      "pct": 14.0
    },
    {
      "symbol": "SO",
      "name": "Southern Co",
      "pct": 7.31
    },
    {
      "symbol": "DUK",
      "name": "Duke Energy Corp",
      "pct": 6.92
    },
    {
      "symbol": "CEG",
      "name": "Constellation Energy Corp",
      "pct": 6.7
    },
    {
      "symbol": "AEP",
      "name": "American Electric Power Co Inc",
      "pct": 5.09
    },
    {
      "symbol": "SRE",
      "name": "Sempra",
      "pct": 4.26
    },
    {
      "symbol": "D",
      "name": "Dominion Energy Inc",
      "pct": 3.78
    },
    {
      "symbol": "ETR",
      "name": "Entergy Corp",
      "pct": 3.66
    },
    {
      "symbol": "VST",
      "name": "Vistra Corp",
      "pct": 3.45
    }
  ],
  "XLV": [
    {
      "symbol": "LLY",
      "name": "Eli Lilly and Co",
      "pct": 14.07
    },
    {
      "symbol": "JNJ",
      "name": "Johnson & Johnson",
      "pct": 10.52
    },
    {
      "symbol": "ABBV",
      "name": "AbbVie Inc",
      "pct": 7.1
    },
    {
      "symbol": "UNH",
      "name": "UnitedHealth Group Inc",
      "pct": 6.38
    },
    {
      "symbol": "MRK",
      "name": "Merck & Co Inc",
      "pct": 5.15
    },
    {
      "symbol": "AMGN",
      "name": "Amgen Inc",
      "pct": 3.54
    },
    {
      "symbol": "TMO",
      "name": "Thermo Fisher Scientific Inc",
      "pct": 3.42
    },
    {
      "symbol": "ISRG",
      "name": "Intuitive Surgical Inc",
      "pct": 3.09
    },
    {
      "symbol": "GILD",
      "name": "Gilead Sciences Inc",
      "pct": 3.08
    }
  ],
  "XLY": [
    {
      "symbol": "AMZN",
      "name": "Amazon.com Inc",
      "pct": 27.58
    },
    {
      "symbol": "TSLA",
      "name": "Tesla Inc",
      "pct": 17.93
    },
    {
      "symbol": "HD",
      "name": "The Home Depot Inc",
      "pct": 5.47
    },
    {
      "symbol": "TJX",
      "name": "TJX Companies Inc",
      "pct": 3.99
    },
    {
      "symbol": "MCD",
      "name": "McDonald's Corp",
      "pct": 3.91
    },
    {
      "symbol": "BKNG",
      "name": "Booking Holdings Inc",
      "pct": 3.11
    },
    {
      "symbol": "LOW",
      "name": "Lowe's Companies Inc",
      "pct": 3.07
    },
    {
      "symbol": "SBUX",
      "name": "Starbucks Corp",
      "pct": 2.75
    },
    {
      "symbol": "ORLY",
      "name": "O'Reilly Automotive Inc",
      "pct": 1.92
    }
  ],
  "XOP": [
    {
      "symbol": "APA",
      "name": "APA Corp",
      "pct": 2.94
    },
    {
      "symbol": "MUR",
      "name": "Murphy Oil Corp",
      "pct": 2.92
    },
    {
      "symbol": "SM",
      "name": "SM Energy Co",
      "pct": 2.88
    },
    {
      "symbol": "DINO",
      "name": "HF Sinclair Corp",
      "pct": 2.84
    },
    {
      "symbol": "CHRD",
      "name": "Chord Energy Corp",
      "pct": 2.78
    },
    {
      "symbol": "FANG",
      "name": "Diamondback Energy Inc",
      "pct": 2.77
    },
    {
      "symbol": "CTRA",
      "name": "Coterra Energy Inc",
      "pct": 2.73
    },
    {
      "symbol": "DVN",
      "name": "Devon Energy Corp",
      "pct": 2.7
    },
    {
      "symbol": "MTDR",
      "name": "Matador Resources Co",
      "pct": 2.69
    }
  ],
  "XBI": [
    {
      "symbol": "APLS",
      "name": "Apellis Pharmaceuticals Inc",
      "pct": 1.87
    },
    {
      "symbol": "RVMD",
      "name": "Revolution Medicines Inc",
      "pct": 1.65
    },
    {
      "symbol": "TVTX",
      "name": "Travere Therapeutics Inc",
      "pct": 1.62
    },
    {
      "symbol": "ARWR",
      "name": "Arrowhead Pharmaceuticals Inc",
      "pct": 1.44
    },
    {
      "symbol": "TWST",
      "name": "Twist Bioscience Corp",
      "pct": 1.42
    },
    {
      "symbol": "SMMT",
      "name": "Summit Therapeutics Inc",
      "pct": 1.4
    },
    {
      "symbol": "ALKS",
      "name": "Alkermes PLC",
      "pct": 1.38
    },
    {
      "symbol": "TGTX",
      "name": "TG Therapeutics Inc",
      "pct": 1.37
    },
    {
      "symbol": "MDGL",
      "name": "Madrigal Pharmaceuticals Inc",
      "pct": 1.36
    }
  ],
  "HACK": [
    {
      "symbol": "AVGO",
      "name": "Broadcom Inc",
      "pct": 8.73
    },
    {
      "symbol": "CSCO",
      "name": "Cisco Systems Inc",
      "pct": 6.5
    },
    {
      "symbol": "PANW",
      "name": "Palo Alto Networks Inc",
      "pct": 6.2
    },
    {
      "symbol": "CRWD",
      "name": "CrowdStrike Holdings Inc",
      "pct": 5.95
    },
    {
      "symbol": "NET",
      "name": "Cloudflare Inc",
      "pct": 5.45
    },
    {
      "symbol": "FTNT",
      "name": "Fortinet Inc",
      "pct": 4.91
    },
    {
      "symbol": "FFIV",
      "name": "F5 Inc",
      "pct": 4.78
    },
    {
      "symbol": "GD",
      "name": "General Dynamics Corp",
      "pct": 4.78
    },
    {
      "symbol": "FSLY",
      "name": "Fastly Inc",
      "pct": 4.51
    }
  ],
  "QTUM": [
    {
      "symbol": "INTC",
      "name": "Intel Corp",
      "pct": 2.39
    },
    {
      "symbol": "STM",
      "name": "STMicroelectronics NV ADR",
      "pct": 2.16
    },
    {
      "symbol": "NOK",
      "name": "Nokia Oyj ADR",
      "pct": 2.14
    },
    {
      "symbol": "MU",
      "name": "Micron Technology Inc",
      "pct": 2.02
    },
    {
      "symbol": "ON",
      "name": "ON Semiconductor Corp",
      "pct": 1.89
    },
    {
      "symbol": "MRVL",
      "name": "Marvell Technology Inc",
      "pct": 1.84
    },
    {
      "symbol": "ONTO",
      "name": "Onto Innovation Inc",
      "pct": 1.81
    },
    {
      "symbol": "TSEM",
      "name": "Tower Semiconductor Ltd",
      "pct": 1.8
    }
  ],
  "TAN": [
    {
      "symbol": "FSLR",
      "name": "First Solar Inc",
      "pct": 9.81
    },
    {
      "symbol": "ENPH",
      "name": "Enphase Energy Inc",
      "pct": 5.36
    },
    {
      "symbol": "RUN",
      "name": "Sunrun Inc",
      "pct": 4.67
    },
    {
      "symbol": "SEDG",
      "name": "SolarEdge Technologies Inc",
      "pct": 4.5
    },
    {
      "symbol": "HASI",
      "name": "HA Sustainable Infrastructure Capital Inc",
      "pct": 4.5
    }
  ],
  "ITA": [
    {
      "symbol": "GE",
      "name": "GE Aerospace",
      "pct": 19.43
    },
    {
      "symbol": "RTX",
      "name": "RTX Corp",
      "pct": 15.1
    },
    {
      "symbol": "BA",
      "name": "Boeing Co",
      "pct": 10.25
    },
    {
      "symbol": "GD",
      "name": "General Dynamics Corp",
      "pct": 4.78
    },
    {
      "symbol": "HWM",
      "name": "Howmet Aerospace Inc",
      "pct": 4.75
    },
    {
      "symbol": "TDG",
      "name": "TransDigm Group Inc",
      "pct": 4.53
    },
    {
      "symbol": "LHX",
      "name": "L3Harris Technologies Inc",
      "pct": 4.32
    },
    {
      "symbol": "LMT",
      "name": "Lockheed Martin Corp",
      "pct": 3.92
    },
    {
      "symbol": "NOC",
      "name": "Northrop Grumman Corp",
      "pct": 3.88
    }
  ]
};


// ── 인증 체크
function authCheck(request, env) {
  const secret = request.headers.get('x-admin-secret');
  return secret === (env.INIT_SECRET || 'drbalance-init-2026');
}

// ── 공통 JSON 응답
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
    },
  });
}

// ============================================
// 라우터
// ============================================
export async function handleAdmin(path, request, env) {
  if (!authCheck(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // ── GET  /api/admin/stats
  if (path === '/api/admin/stats' && request.method === 'GET') {
    return handleStats(env);
  }

  // ════════════════════════════════════════
  // GROUPS
  // ════════════════════════════════════════

  // ── GET  /api/admin/groups
  if (path === '/api/admin/groups' && request.method === 'GET') {
    return handleGetGroups(env);
  }

  // ── POST /api/admin/groups
  if (path === '/api/admin/groups' && request.method === 'POST') {
    return handleAddGroup(request, env);
  }

  // ── PATCH /api/admin/groups/:id
  const groupPatch = path.match(/^\/api\/admin\/groups\/(\d+)$/);
  if (groupPatch && request.method === 'PATCH') {
    return handleUpdateGroup(Number(groupPatch[1]), request, env);
  }

  // ── DELETE /api/admin/groups/:id
  const groupDel = path.match(/^\/api\/admin\/groups\/(\d+)$/);
  if (groupDel && request.method === 'DELETE') {
    return handleDeleteGroup(Number(groupDel[1]), env);
  }

  // ── GET  /api/admin/groups/:id/symbols
  const groupSymsGet = path.match(/^\/api\/admin\/groups\/(\d+)\/symbols$/);
  if (groupSymsGet && request.method === 'GET') {
    return handleGetGroupSymbols(Number(groupSymsGet[1]), env);
  }

  // ── POST /api/admin/groups/:id/symbols
  const groupSymsPost = path.match(/^\/api\/admin\/groups\/(\d+)\/symbols$/);
  if (groupSymsPost && request.method === 'POST') {
    return handleAddGroupSymbol(Number(groupSymsPost[1]), request, env);
  }

  // ── DELETE /api/admin/groups/:id/symbols/:symbol
  const groupSymDel = path.match(/^\/api\/admin\/groups\/(\d+)\/symbols\/([A-Z0-9.\-]+)$/);
  if (groupSymDel && request.method === 'DELETE') {
    return handleRemoveGroupSymbol(Number(groupSymDel[1]), groupSymDel[2], env);
  }

  // ════════════════════════════════════════
  // SYMBOLS
  // ════════════════════════════════════════

  // ── GET  /api/admin/symbols
  if (path === '/api/admin/symbols' && request.method === 'GET') {
    return handleGetSymbols(env);
  }

  // ── POST /api/admin/symbols
  if (path === '/api/admin/symbols' && request.method === 'POST') {
    return handleAddSymbol(request, env);
  }

  // ── PATCH /api/admin/symbols/:sym
  const symPatch = path.match(/^\/api\/admin\/symbols\/([A-Z0-9.\-]+)$/);
  if (symPatch && request.method === 'PATCH') {
    return handleUpdateSymbol(symPatch[1], request, env);
  }

  // ── DELETE /api/admin/symbols/:sym
  const symDel = path.match(/^\/api\/admin\/symbols\/([A-Z0-9.\-]+)$/);
  if (symDel && request.method === 'DELETE') {
    return handleDeleteSymbol(symDel[1], env);
  }

  // ── POST /api/admin/symbols/refresh
  if (path === '/api/admin/symbols/refresh' && request.method === 'POST') {
    return handleRefreshSymbols(env);
  }

  // ════════════════════════════════════════
  // BB MAP SYMBOLS
  // ════════════════════════════════════════

  // ── GET  /api/admin/bb-map
  if (path === '/api/admin/bb-map' && request.method === 'GET') {
    return handleGetBBMap(env);
  }

  // ── POST /api/admin/bb-map
  if (path === '/api/admin/bb-map' && request.method === 'POST') {
    return handleAddBBMap(request, env);
  }

  // ── PATCH /api/admin/bb-map/:sym
  const bbPatch = path.match(/^\/api\/admin\/bb-map\/([A-Z0-9.\-]+)$/);
  if (bbPatch && request.method === 'PATCH') {
    return handleUpdateBBMap(bbPatch[1], request, env);
  }

  // ── DELETE /api/admin/bb-map/:sym
  const bbDel = path.match(/^\/api\/admin\/bb-map\/([A-Z0-9.\-]+)$/);
  if (bbDel && request.method === 'DELETE') {
    return handleDeleteBBMap(bbDel[1], env);
  }

  // ════════════════════════════════════════
  // ETF 구성종목 조회
  // ════════════════════════════════════════

  // ── GET /api/admin/etf-holdings/:sym
  const etfHoldings = path.match(/^\/api\/admin\/etf-holdings\/([A-Z0-9.\-]+)$/);
  if (etfHoldings && request.method === 'GET') {
    return handleGetETFHoldings(etfHoldings[1], env);
  }

  // ════════════════════════════════════════
  // 수집 대상 (Railway trigger용)
  // ════════════════════════════════════════

  // ── GET /api/admin/collect-targets
  if (path === '/api/admin/collect-targets' && request.method === 'GET') {
    return handleGetCollectTargets(env);
  }

  return json({ error: 'Not found' }, 404);
}

// ============================================
// STATS
// ============================================
async function handleStats(env) {
  const [symbols, groups, bbmap, flow] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as n FROM symbols').first(),
    env.DB.prepare('SELECT COUNT(*) as n FROM groups').first(),
    env.DB.prepare('SELECT COUNT(*) as n FROM bb_map_symbols WHERE is_active=1').first(),
    env.DB.prepare("SELECT COUNT(*) as n FROM options_flow WHERE date=date('now')").first(),
  ]);
  return json({
    symbols:    symbols.n,
    groups:     groups.n,
    bb_map:     bbmap.n,
    flow_today: flow.n,
  });
}

// ============================================
// GROUPS
// ============================================
async function handleGetGroups(env) {
  const rows = await env.DB.prepare(`
    SELECT g.*, COUNT(sg.symbol) as symbol_count
    FROM groups g
    LEFT JOIN symbol_groups sg ON g.id = sg.group_id
    GROUP BY g.id
    ORDER BY g.code
  `).all();
  return json({ groups: rows.results });
}

async function handleAddGroup(request, env) {
  const { code, name, color, comment } = await request.json();
  if (!code || !name) return json({ error: 'code, name 필수' }, 400);

  const code_upper = code.toUpperCase().trim();
  const exists = await env.DB.prepare(
    'SELECT id FROM groups WHERE code=?'
  ).bind(code_upper).first();
  if (exists) return json({ error: `${code_upper} 코드가 이미 존재합니다` }, 409);

  const result = await env.DB.prepare(`
    INSERT INTO groups (code, name, color, comment)
    VALUES (?, ?, ?, ?)
  `).bind(code_upper, name.trim(), color || null, comment || null).run();

  return json({ ok: true, id: result.meta.last_row_id, code: code_upper });
}

async function handleUpdateGroup(id, request, env) {
  const { name, color, comment } = await request.json();
  await env.DB.prepare(
    'UPDATE groups SET name=?, color=?, comment=? WHERE id=?'
  ).bind(name, color || null, comment || null, id).run();
  return json({ ok: true, id });
}

async function handleDeleteGroup(id, env) {
  // symbol_groups는 CASCADE로 자동 삭제됨
  await env.DB.prepare('DELETE FROM groups WHERE id=?').bind(id).run();

  // 고아 심볼 (어느 그룹에도 속하지 않은) 정리
  const orphans = await env.DB.prepare(`
    SELECT symbol FROM symbols
    WHERE symbol NOT IN (SELECT DISTINCT symbol FROM symbol_groups)
  `).all();

  if (orphans.results.length > 0) {
    const syms = orphans.results.map(r => r.symbol);
    const delStmts = syms.flatMap(sym => [
      env.DB.prepare('DELETE FROM symbols WHERE symbol=?').bind(sym),
      env.DB.prepare('DELETE FROM options_flow WHERE symbol=?').bind(sym),
      env.DB.prepare('DELETE FROM price_indicators WHERE symbol=?').bind(sym),
      env.DB.prepare('DELETE FROM screener_scores WHERE symbol=?').bind(sym),
    ]);
    for (const chunk of chunkArray(delStmts, 100)) {
      await env.DB.batch(chunk);
    }
    return json({ ok: true, id, orphans_removed: syms });
  }

  return json({ ok: true, id, orphans_removed: [] });
}

async function handleGetGroupSymbols(id, env) {
  const rows = await env.DB.prepare(`
    SELECT s.symbol, s.name, s.type, s.comment
    FROM symbol_groups sg
    JOIN symbols s ON sg.symbol = s.symbol
    WHERE sg.group_id = ?
    ORDER BY s.type DESC, s.symbol
  `).bind(id).all();
  return json({ group_id: id, symbols: rows.results });
}

async function handleAddGroupSymbol(id, request, env) {
  const { symbol } = await request.json();
  if (!symbol) return json({ error: 'symbol 필수' }, 400);

  const sym = symbol.toUpperCase().trim();

  // symbols에 없으면 자동 등록
  await env.DB.prepare(`
    INSERT OR IGNORE INTO symbols (symbol, added_date)
    VALUES (?, date('now'))
  `).bind(sym).run();

  // 그룹에 추가
  await env.DB.prepare(`
    INSERT OR IGNORE INTO symbol_groups (symbol, group_id)
    VALUES (?, ?)
  `).bind(sym, id).run();

  // Yahoo에서 name/type 자동수집
  const info = await refreshOneSymbol(env.DB, sym);

  return json({ ok: true, symbol: sym, group_id: id, name: info?.name, type: info?.type });
}

async function handleRemoveGroupSymbol(id, symbol, env) {
  await env.DB.prepare(
    'DELETE FROM symbol_groups WHERE group_id=? AND symbol=?'
  ).bind(id, symbol).run();

  // 고아가 되었으면 모든 데이터 삭제
  const stillExists = await env.DB.prepare(
    'SELECT 1 FROM symbol_groups WHERE symbol=? LIMIT 1'
  ).bind(symbol).first();

  if (!stillExists) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM symbols WHERE symbol=?').bind(symbol),
      env.DB.prepare('DELETE FROM options_flow WHERE symbol=?').bind(symbol),
      env.DB.prepare('DELETE FROM price_indicators WHERE symbol=?').bind(symbol),
      env.DB.prepare('DELETE FROM screener_scores WHERE symbol=?').bind(symbol),
    ]);
    return json({ ok: true, symbol, group_id: id, orphan_removed: true });
  }

  return json({ ok: true, symbol, group_id: id, orphan_removed: false });
}

// ============================================
// SYMBOLS
// ============================================
async function handleGetSymbols(env) {
  const rows = await env.DB.prepare(`
    SELECT
      s.symbol, s.name, s.type, s.comment, s.added_date,
      GROUP_CONCAT(g.code) as groups
    FROM symbols s
    LEFT JOIN symbol_groups sg ON s.symbol = sg.symbol
    LEFT JOIN groups g ON sg.group_id = g.id
    GROUP BY s.symbol
    ORDER BY s.type DESC, s.symbol
  `).all();
  return json({ symbols: rows.results });
}

async function handleAddSymbol(request, env) {
  const { symbol, group_id } = await request.json();
  if (!symbol) return json({ error: 'symbol 필수' }, 400);

  const sym = symbol.toUpperCase().trim();

  await env.DB.prepare(`
    INSERT OR IGNORE INTO symbols (symbol, added_date)
    VALUES (?, date('now'))
  `).bind(sym).run();

  if (group_id) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO symbol_groups (symbol, group_id)
      VALUES (?, ?)
    `).bind(sym, group_id).run();
  }

  const info = await refreshOneSymbol(env.DB, sym);
  return json({ ok: true, symbol: sym, name: info?.name, type: info?.type });
}

async function handleUpdateSymbol(symbol, request, env) {
  const { comment } = await request.json();
  await env.DB.prepare(
    'UPDATE symbols SET comment=? WHERE symbol=?'
  ).bind(comment || null, symbol).run();
  return json({ ok: true, symbol });
}

async function handleDeleteSymbol(symbol, env) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM symbol_groups WHERE symbol=?').bind(symbol),
    env.DB.prepare('DELETE FROM symbols WHERE symbol=?').bind(symbol),
    env.DB.prepare('DELETE FROM options_flow WHERE symbol=?').bind(symbol),
    env.DB.prepare('DELETE FROM price_indicators WHERE symbol=?').bind(symbol),
    env.DB.prepare('DELETE FROM screener_scores WHERE symbol=?').bind(symbol),
  ]);
  return json({ ok: true, symbol });
}

async function handleRefreshSymbols(env) {
  const rows = await env.DB.prepare('SELECT symbol FROM symbols').all();
  const results = { updated: [], failed: [] };

  for (const { symbol } of rows.results) {
    const info = await refreshOneSymbol(env.DB, symbol);
    if (info) results.updated.push(symbol);
    else results.failed.push(symbol);
    await sleep(200);
  }

  return json({ ok: true, ...results });
}

// ── Yahoo Finance로 단일 심볼 name/type 수집
async function refreshOneSymbol(db, symbol) {
  try {
    const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const data   = await res.json();
    const meta   = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const name = meta.longName || meta.shortName || symbol;
    const type = (meta.instrumentType === 'ETF') ? 'etf' : 'stock';

    await db.prepare(
      'UPDATE symbols SET name=?, type=? WHERE symbol=?'
    ).bind(name, type, symbol).run();

    return { name, type };
  } catch {
    return null;
  }
}

// ============================================
// BB MAP SYMBOLS
// ============================================
async function handleGetBBMap(env) {
  const rows = await env.DB.prepare(
    'SELECT * FROM bb_map_symbols ORDER BY sort_order, symbol'
  ).all();
  return json({ bb_map: rows.results });
}

async function handleAddBBMap(request, env) {
  const { symbol, name, color, sort_order } = await request.json();
  if (!symbol) return json({ error: 'symbol 필수' }, 400);

  const sym = symbol.toUpperCase().trim();

  // Yahoo에서 name 자동수집
  let resolvedName = name || sym;
  try {
    const url = `${YAHOO_BASE}/${encodeURIComponent(sym)}?interval=1d&range=5d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta) resolvedName = meta.longName || meta.shortName || sym;
    }
  } catch { /* 실패 시 입력값 사용 */ }

  await env.DB.prepare(`
    INSERT OR REPLACE INTO bb_map_symbols (symbol, name, color, sort_order, is_active, added_date)
    VALUES (?, ?, ?, ?, 1, date('now'))
  `).bind(sym, resolvedName, color || null, sort_order ?? 99).run();

  // price_indicators 2개월치 백필 (비동기, 응답을 기다리지 않음)
  // Cloudflare Workers에서는 ctx.waitUntil로 처리하는 게 이상적이나
  // admin.js에서는 ctx 접근이 없으므로 await로 처리
  await backfillPriceIndicators(env.DB, sym);

  return json({ ok: true, symbol: sym, name: resolvedName });
}

async function handleUpdateBBMap(symbol, request, env) {
  const { name, color, sort_order, is_active } = await request.json();
  await env.DB.prepare(`
    UPDATE bb_map_symbols SET name=?, color=?, sort_order=?, is_active=? WHERE symbol=?
  `).bind(name, color || null, sort_order ?? 99, is_active ?? 1, symbol).run();
  return json({ ok: true, symbol });
}

async function handleDeleteBBMap(symbol, env) {
  await env.DB.prepare('DELETE FROM bb_map_symbols WHERE symbol=?').bind(symbol).run();
  // price_indicators는 유지 (옵션 수집 종목과 공유할 수 있으므로)
  return json({ ok: true, symbol });
}

// ── price_indicators 과거 2개월치 백필
async function backfillPriceIndicators(db, symbol) {
  try {
    const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return;

    const data   = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return;

    const timestamps = result.timestamp ?? [];
    const closes     = (result.indicators?.quote?.[0]?.close ?? []);

    const candles = timestamps
      .map((ts, i) => ({
        date:  new Date(ts * 1000).toISOString().slice(0, 10),
        close: closes[i] ?? null,
      }))
      .filter(c => c.close != null);

    if (candles.length < 20) return;

    const stmts = [];
    for (let i = 19; i < candles.length; i++) {
      const slice      = candles.slice(i - 19, i + 1).map(c => c.close);
      const { date, close } = candles[i];
      const bb         = calcBollinger(slice);
      if (!bb) continue;

      const bbRange    = bb.upper2 - bb.lower2;
      const bbPosition = bbRange > 0 ? (close - bb.lower2) / bbRange : 0.5;

      stmts.push(
        db.prepare(`
          INSERT OR IGNORE INTO price_indicators
            (date, symbol, close, bb_mid, bb_upper1, bb_lower1, bb_upper2, bb_lower2, bb_position)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          date, symbol, close,
          bb.mid, bb.upper1, bb.lower1, bb.upper2, bb.lower2,
          +bbPosition.toFixed(4)
        )
      );
    }

    for (const chunk of chunkArray(stmts, 100)) {
      await db.batch(chunk);
    }

    console.log(`[backfill] ${symbol}: ${stmts.length}개 저장`);
  } catch (err) {
    console.error(`[backfill] ${symbol}:`, err.message);
  }
}

// ============================================
// ETF 구성종목 조회 — 정적 데이터 (하드코딩)
// 2026-04-30 Finnhub 위젯 기준, 미국 상장 종목만 수록
// ============================================
async function handleGetETFHoldings(symbol, env) {
  const ticker   = symbol.toUpperCase();
  const holdings = ETF_HOLDINGS_DB[ticker];
  if (!holdings) {
    const supported = Object.keys(ETF_HOLDINGS_DB).join(', ');
    return json({ error: `${ticker} ETF 데이터 없음. 지원 목록: ${supported}` }, 404);
  }
  return json({ etf: ticker, holdings });
}

// ============================================
// 수집 대상 심볼 목록
// ============================================
async function handleGetCollectTargets(env) {
  const rows = await env.DB.prepare(`
    SELECT DISTINCT s.symbol, s.name, s.type
    FROM symbols s
    JOIN symbol_groups sg ON s.symbol = sg.symbol
    ORDER BY s.type DESC, s.symbol
  `).all();
  return json({ symbols: rows.results });
}

// ============================================
// 볼린저밴드 계산
// ============================================
function calcBollinger(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma   = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + (b - sma) ** 2, 0) / period);
  return {
    mid:    +sma.toFixed(4),
    upper1: +(sma + std).toFixed(4),
    lower1: +(sma - std).toFixed(4),
    upper2: +(sma + std * 2).toFixed(4),
    lower2: +(sma - std * 2).toFixed(4),
  };
}

// ============================================
// 유틸
// ============================================
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
