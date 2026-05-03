// DexBoard – vanna_analyzer.js
// Runs on Railway: fetch CBOE → filter → Black-Scholes → DEX/GEX/Vanna/Charm → CF KV
// v2: 개별종목 스크리너 수집 엔진 추가

// ─────────────────────────────────────────────────────────────────
// Environment
// ─────────────────────────────────────────────────────────────────
const CBOE_BASE    = process.env.CBOE_BASE    || "https://cdn.cboe.com/api/global/delayed_quotes/options";
const CF_KV_URL    = process.env.CF_KV_URL;
const CF_KV_SECRET = process.env.CF_KV_SECRET || "";
const TWELVE_KEY   = process.env.TWELVE_KEY   || "";

// ─────────────────────────────────────────────────────────────────
// 다음 거래일 날짜 계산 (Twelve Data market_state 활용)
// ─────────────────────────────────────────────────────────────────
export async function getNextTradingDate() {
  try {
    const url = `https://api.twelvedata.com/market_state?exchange=NYSE&apikey=${TWELVE_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    const nyse = Array.isArray(json)
      ? (json.find(e => e.code === "XNYS") ?? json[0])
      : json;
    if (!nyse) throw new Error("NYSE 데이터 없음");

    const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));

    if (nyse.is_market_open) {
      const dateStr = _formatDate(nowET);
      console.log(`[TradingDate] 장 중 → 오늘 ${dateStr}`);
      return dateStr;
    }

    const timeToOpen = nyse.time_to_open;
    if (!timeToOpen) throw new Error("time_to_open 없음");

    const totalSec = _parseHMS(timeToOpen);
    if (totalSec === null) throw new Error(`time_to_open 파싱 실패: ${timeToOpen}`);

    const nextOpenET = new Date(nowET.getTime() + totalSec * 1000);
    const dateStr    = _formatDate(nextOpenET);

    console.log(`[TradingDate] 장 마감 (time_to_open=${timeToOpen}) → 다음 거래일 ${dateStr}`);
    return dateStr;

  } catch (e) {
    console.warn(`[TradingDate] Twelve Data 조회 실패: ${e.message} → ET 날짜 폴백`);
    return _etDateFallback();
  }
}

function _parseHMS(hms) {
  if (!hms) return null;
  const parts = hms.split(":").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function _formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function _etDateFallback() {
  const nowET   = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dow     = nowET.getDay();
  const addDays = dow === 0 ? 1 : dow === 6 ? 2 : 0;
  nowET.setDate(nowET.getDate() + addDays);
  const result = _formatDate(nowET);
  console.warn(`[TradingDate] 폴백 사용 → ${result}`);
  return result;
}

// 오늘 ET 날짜 (UTC 기준 ET 변환)
export function getTodayET() {
  const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return _formatDate(nowET);
}

// ─────────────────────────────────────────────────────────────────
// Black-Scholes helpers
// ─────────────────────────────────────────────────────────────────
function normCDF(x) {
  const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function normPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export function calcGreeks(spot, strike, dte, iv, r = 0.05) {
  const T_MIN = 2 / (365 * 24);  // 2시간 — Charm 폭발 방지
  const T = Math.max(dte / 365, T_MIN);
  if (iv <= 0 || spot <= 0 || strike <= 0) return null;

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (r + (iv * iv) / 2) * T) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;

  const phi = normPDF(d1);
  const Nd1 = normCDF(d1);

  const delta = Nd1;
  const gamma = phi / (spot * iv * sqrtT);
  const vanna = phi * d2 / iv;
  const charmRaw = -phi * (r / (iv * sqrtT) - d2 / (2 * T));
  const charm = isFinite(charmRaw) ? charmRaw : 0;

  return { delta, gamma, vanna, charm };
}

// ─────────────────────────────────────────────────────────────────
// Option string parser
// ─────────────────────────────────────────────────────────────────
export function parseOption(optionStr) {
  const match = optionStr.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const [, symbol, dateStr, type, strikeStr] = match;
  const yy = dateStr.slice(0, 2);
  const mm = dateStr.slice(2, 4);
  const dd = dateStr.slice(4, 6);
  const expiry = `20${yy}-${mm}-${dd}`;
  const strike = parseInt(strikeStr, 10) / 1000;
  const expiryDate = new Date(`${expiry}T16:00:00-05:00`);
  const dte = Math.max(0, Math.round((expiryDate - new Date()) / 86_400_000));
  return { symbol, expiry, type, strike, dte };
}

// ─────────────────────────────────────────────────────────────────
// classifyExpiry
// ─────────────────────────────────────────────────────────────────
export function classifyExpiry(dte, expiry, nextTradingDate) {
  if (expiry === nextTradingDate) return "0dte";
  if (dte <= 7)  return "weekly";
  if (dte <= 35) return "monthly";
  return "quarterly";
}

// ─────────────────────────────────────────────────────────────────
// Filter options (SPY 0DTE 포함 필터)
// ─────────────────────────────────────────────────────────────────
export function filterOptions(options, nextTradingDate) {
  return options.filter((o) => {
    const parsed = parseOption(o.option);
    if (!parsed) return false;
    if (parsed.dte < 0) return false;
    if (o.iv <= 0) return false;
    if (nextTradingDate && parsed.expiry === nextTradingDate) {
      return (o.open_interest > 0 || o.volume > 0);
    }
    return o.gamma > 0 && o.open_interest > 0;
  });
}

// ─────────────────────────────────────────────────────────────────
// Screener용 필터 (3~60DTE, OI > 0)
// 0~2DTE는 당일/익일 만기라 스크리너 목적에 무의미하므로 제외
// ─────────────────────────────────────────────────────────────────
export function filterOptionsScreener(options) {
  return options.filter((o) => {
    const parsed = parseOption(o.option);
    if (!parsed) return false;
    if (parsed.dte < 3 || parsed.dte > 60) return false;
    if (o.open_interest <= 0) return false;
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────
// Fetch CBOE option chain (단일 심볼)
// ─────────────────────────────────────────────────────────────────
export async function fetchCBOESymbol(symbol) {
  const url = `${CBOE_BASE}/${symbol}.json`;
  const res = await fetch(url, {
    headers: { "User-Agent": "DexBoard/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`CBOE fetch failed for ${symbol}: ${res.status}`);
  return res.json();
}

// ─────────────────────────────────────────────────────────────────
// Write to CF KV
// ─────────────────────────────────────────────────────────────────
async function kvPut(key, value) {
  if (!CF_KV_URL) {
    console.warn("CF_KV_URL not set – skipping KV write for", key);
    return;
  }
  const res = await fetch(`${CF_KV_URL}/kv-write`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-kv-secret": CF_KV_SECRET,
    },
    body: JSON.stringify({ key, value: JSON.stringify(value) }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KV write failed for ${key}: ${res.status} ${text}`);
  }
}

function sum(arr, field) {
  return arr.reduce((acc, item) => acc + (item[field] || 0), 0);
}

// ─────────────────────────────────────────────────────────────────
// 개별 종목 옵션 집계 — 만기일별 DEX/GEX/PCR/IV스큐
// ─────────────────────────────────────────────────────────────────
export function aggregateByExpiry(options, spot) {
  // 필터: 60DTE 이내, OI > 0
  const filtered = filterOptionsScreener(options);

  // 만기별 strike 맵
  const expiryMap = {};

  for (const o of filtered) {
    const parsed = parseOption(o.option);
    if (!parsed) continue;
    const { strike, dte, type, expiry } = parsed;

    if (!expiryMap[expiry]) {
      expiryMap[expiry] = { dte, expiry, strikes: {} };
    }
    if (!expiryMap[expiry].strikes[strike]) {
      expiryMap[expiry].strikes[strike] = {
        strike, dte, expiry,
        callOI: 0, putOI: 0,
        callVol: 0, putVol: 0,
        callIV: 0, putIV: 0,
        callIVCount: 0, putIVCount: 0,
      };
    }

    const s = expiryMap[expiry].strikes[strike];
    const oi  = o.open_interest || 0;
    const vol = o.volume        || 0;

    if (type === "C") {
      s.callOI  += oi;
      s.callVol += vol;
      if (o.iv > 0) { s.callIV += o.iv; s.callIVCount++; }
    } else {
      s.putOI  += oi;
      s.putVol += vol;
      if (o.iv > 0) { s.putIV += o.iv; s.putIVCount++; }
    }
  }

  // 만기별 집계
  const results = [];

  for (const [expiry, em] of Object.entries(expiryMap)) {
    const strikes = Object.values(em.strikes);
    const { dte } = em;

    // ATM 스트라이크 결정
    const atmStrike = strikes.reduce((best, s) => {
      return Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best;
    }, strikes[0]);
    if (!atmStrike) continue;

    const atmCallIV = atmStrike.callIVCount > 0 ? atmStrike.callIV / atmStrike.callIVCount : 0;
    const atmPutIV  = atmStrike.putIVCount  > 0 ? atmStrike.putIV  / atmStrike.putIVCount  : 0;
    const atmIV     = (atmCallIV + atmPutIV) / 2 || 0;

    // OI 극소 만기(콜+풋 합산 1000 미만)는 iv_skew 신뢰 불가 → 0 처리
    const callOI  = strikes.reduce((s, r) => s + r.callOI,  0);
    const putOI   = strikes.reduce((s, r) => s + r.putOI,   0);
    const totalOI = callOI + putOI;
    const ivSkew  = (atmIV > 0 && totalOI >= 1000) ? (atmCallIV - atmPutIV) / atmIV : 0;

    // OTM IV (ATM±5%)
    const otmRange = spot * 0.05;
    const otmCallStrikes = strikes.filter(s => s.strike > spot && s.strike <= spot + otmRange);
    const otmPutStrikes  = strikes.filter(s => s.strike < spot && s.strike >= spot - otmRange);

    const avgOTMCallIV = _avgIV(otmCallStrikes, "call");
    const avgOTMPutIV  = _avgIV(otmPutStrikes,  "put");

    const callVol = strikes.reduce((s, r) => s + r.callVol, 0);
    const putVol  = strikes.reduce((s, r) => s + r.putVol,  0);

    const pcrOI  = callOI  > 0 ? putOI  / callOI  : null;
    const pcrVol = callVol > 0 ? putVol / callVol : null;

    // ATM±5% 풋 OI 집중도
    const atmPutRange  = spot * 0.05;
    const atmPutOI     = strikes
      .filter(s => Math.abs(s.strike - spot) <= atmPutRange)
      .reduce((acc, s) => acc + s.putOI, 0);
    const atmPutRatio  = putOI > 0 ? atmPutOI / putOI : 0;

    // Greeks 합산 (DEX/GEX/Vanna/Charm)
    let dex = 0, gex = 0, vanna = 0, charm = 0;

    for (const s of strikes) {
      const iv = _strikeAvgIV(s);
      if (iv <= 0) continue;
      const dteForGreeks = dte === 0 ? 0.001 : dte;
      const g = calcGreeks(spot, s.strike, dteForGreeks, iv);
      if (!g) continue;

      const netOI = s.callOI - s.putOI;
      dex   += (g.delta * s.callOI * 100 - g.delta * s.putOI * 100) / 1e6;
      gex   += netOI * g.gamma * 100 * spot / 1e6;
      vanna += g.vanna * netOI * 100 * spot / 1e6;
      charm += g.charm * netOI * 100 / 1e6;
    }

    results.push({
      expiry_date:      expiry,
      dte,
      call_oi:          callOI,
      put_oi:           putOI,
      call_vol:         callVol,
      put_vol:          putVol,
      pcr_oi:           pcrOI  != null ? +pcrOI.toFixed(4)  : null,
      pcr_vol:          pcrVol != null ? +pcrVol.toFixed(4) : null,
      iv_skew:          +ivSkew.toFixed(4),
      atm_iv:           atmIV > 0 ? +atmIV.toFixed(4) : null,
      otm_call_iv:      avgOTMCallIV > 0 ? +avgOTMCallIV.toFixed(4) : null,
      otm_put_iv:       avgOTMPutIV  > 0 ? +avgOTMPutIV.toFixed(4)  : null,
      dex:              +dex.toFixed(6),
      gex:              +gex.toFixed(6),
      vanna:            +vanna.toFixed(6),
      charm:            +charm.toFixed(6),
      atm_put_oi:       atmPutOI,
      atm_put_oi_ratio: +atmPutRatio.toFixed(4),
    });
  }

  return results.sort((a, b) => a.dte - b.dte);
}

function _avgIV(strikes, type) {
  const vals = strikes
    .map(s => type === "call"
      ? (s.callIVCount > 0 ? s.callIV / s.callIVCount : 0)
      : (s.putIVCount  > 0 ? s.putIV  / s.putIVCount  : 0))
    .filter(v => v > 0);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

function _strikeAvgIV(s) {
  const cIV = s.callIVCount > 0 ? s.callIV / s.callIVCount : 0;
  const pIV = s.putIVCount  > 0 ? s.putIV  / s.putIVCount  : 0;
  if (cIV > 0 && pIV > 0) return (cIV + pIV) / 2;
  return cIV || pIV;
}

// ─────────────────────────────────────────────────────────────────
// 스크리너 점수 계산
// ─────────────────────────────────────────────────────────────────
export function calcScreenerScore(rows, priceData = {}) {
  // rows: aggregateByExpiry 결과 (만기별 집계)
  if (!rows || !rows.length) return null;

  // A. 콜 스큐 지속 (최대 3점)
  //    30DTE 이내 만기에서 iv_skew > 0.05 (의미있는 콜 프리미엄) 만기 수
  //    원거리 만기는 구조적 콜 스큐가 존재하므로 제외
  const nearTermRows = rows.filter(r => r.dte <= 30);
  const callSkewCount = nearTermRows.filter(r => r.iv_skew > 0.05).length;
  const score_skew_weeks = Math.min(callSkewCount, 3);

  // B. 볼린저 위치 (최대 3점) — priceData에서 bb_position 받음
  const bb = priceData.bb_position ?? null;
  const bb_flag = (bb != null && bb < 0) ? "BREAKDOWN" : null;
  let score_bb = 0;
  if (bb != null) {
    if (!bb_flag) {
      if (bb >= 0.7) score_bb = 3;
      else if (bb >= 0.4) score_bb = 2;
      else if (bb >= 0.2) score_bb = 1;
    }
  }

  // C. ATM 풋 집중도 (최대 2점)
  //    가장 가까운 만기의 atm_put_oi_ratio
  const nearRow = rows[0];  // dte 오름차순이므로 첫 번째가 최근
  const atmRatio = nearRow?.atm_put_oi_ratio ?? 0;
  let score_atm_put = 0;
  if (atmRatio < 0.3) score_atm_put = 2;
  else if (atmRatio < 0.5) score_atm_put = 1;

  // D. 변동폭 수축 (최대 2점) — priceData에서 vol_squeeze 받음
  const squeeze = priceData.vol_squeeze ?? null;
  let score_vol_squeeze = 0;
  if (squeeze != null) {
    if (squeeze < 0.7) score_vol_squeeze = 2;
    else if (squeeze < 0.9) score_vol_squeeze = 1;
  }

  const total_score = score_skew_weeks + score_bb + score_atm_put + score_vol_squeeze;

  return {
    score_skew_weeks,
    score_bb,
    score_atm_put,
    score_vol_squeeze,
    total_score,
    bb_position: bb,
    bb_flag,
    skew_weeks:  callSkewCount,
    iv_skew:     rows.length ? rows[0].iv_skew : null,
  };
}

// ─────────────────────────────────────────────────────────────────
// 단일 종목 수집 + D1 저장 (CF Worker D1 write 엔드포인트 활용)
// ─────────────────────────────────────────────────────────────────
export async function collectSymbol(symbol, date) {
  const raw = await fetchCBOESymbol(symbol);
  const all = raw?.data?.options ?? [];
  if (!all.length) throw new Error(`CBOE: ${symbol} 옵션 데이터 없음`);

  const spot = raw?.data?.current_price;
  if (!spot) throw new Error(`CBOE: ${symbol} 현재가 없음`);

  const rows = aggregateByExpiry(all, spot);
  if (!rows.length) throw new Error(`${symbol}: 60DTE 이내 데이터 없음`);

  return { symbol, spot, date, rows };
}

// ─────────────────────────────────────────────────────────────────
// Main: calculateAndStore (SPY DEX — 기존 로직 유지)
// ─────────────────────────────────────────────────────────────────
async function fetchCBOE() {
  const url = `${CBOE_BASE}/SPY.json`;
  const res = await fetch(url, { headers: { "User-Agent": "DexBoard/1.0" } });
  if (!res.ok) throw new Error(`CBOE fetch failed: ${res.status}`);
  return res.json();
}

export async function calculateAndStore(spot, vix) {
  // 1. 다음 거래일 날짜 조회
  const nextTradingDate = await getNextTradingDate();
  console.log(`[Calc] 기준 거래일: ${nextTradingDate}`);

  // 2. CBOE 옵션체인 fetch
  const raw = await fetchCBOE();
  const all = raw?.data?.options ?? [];
  if (all.length === 0) throw new Error("CBOE returned empty options array");

  // spot을 CBOE current_price로 대체
  const cboeSpot = raw?.data?.current_price;
  if (cboeSpot) spot = cboeSpot;
  console.log(`[Calc] spot=${spot} (CBOE: ${cboeSpot})`);

  // 3. 필터링
  const filtered = filterOptions(all, nextTradingDate);
  console.log(`Filtered ${filtered.length} / ${all.length} options`);

  // 4. 만기별 strike 맵 구성
  const expiryMap = {};

  for (const o of filtered) {
    const parsed = parseOption(o.option);
    if (!parsed) continue;
    const { strike, dte, type, expiry } = parsed;

    if (!expiryMap[expiry]) expiryMap[expiry] = {};
    if (!expiryMap[expiry][strike]) {
      expiryMap[expiry][strike] = {
        strike, dte, expiry,
        callOI: 0, putOI: 0,
        callVol: 0, putVol: 0,
        iv: 0, ivCount: 0,
      };
    }

    const s = expiryMap[expiry][strike];
    const oi  = o.open_interest || 0;
    const vol = o.volume        || 0;
    const oiEff = oi > 0 ? oi : vol;

    if (type === "C") {
      s.callOI  += oiEff;
      s.callVol += vol;
    } else {
      s.putOI   += oiEff;
      s.putVol  += vol;
    }
    if (o.iv > 0) { s.iv += o.iv; s.ivCount++; }
  }

  // 5. 그룹 분류 + Greeks 계산
  const groups = {
    "0dte":      [],
    "weekly":    [],
    "monthly":   [],
    "quarterly": [],
  };

  for (const [expiry, strikeMap] of Object.entries(expiryMap)) {
    for (const s of Object.values(strikeMap)) {
      const { strike, dte, callOI, putOI } = s;
      const iv = s.ivCount > 0 ? s.iv / s.ivCount : 0.20;
      const group = classifyExpiry(dte, expiry, nextTradingDate);

      const dteForGreeks = dte === 0 ? 0.001 : dte;
      const greeks = calcGreeks(spot, strike, dteForGreeks, iv);
      if (!greeks) continue;

      const netOI = callOI - putOI;

      groups[group].push({
        strike,
        expiry,
        dte,
        callOI,
        putOI,
        dex:   (greeks.delta * callOI * 100 - greeks.delta * putOI * 100) / 1e6,
        gex:   netOI * greeks.gamma * 100 * spot / 1e6,
        vanna: greeks.vanna * netOI * 100 * spot / 1e6,
        charm: greeks.charm * netOI * 100 / 1e6,
      });
    }
  }

  // 6. KV 저장
  const updatedAt = new Date().toISOString();
  const results   = {};

  for (const [group, items] of Object.entries(groups)) {
    const summary = {
      dex_total:         sum(items, "dex"),
      gex_total:         sum(items, "gex"),
      vanna_total:       sum(items, "vanna"),
      charm_total:       sum(items, "charm"),
      spot,
      vix,
      count:             items.length,
      strikes:           items,
      next_trading_date: nextTradingDate,
      updated_at:        updatedAt,
    };

    results[group] = {
      dex_total:   summary.dex_total,
      gex_total:   summary.gex_total,
      vanna_total: summary.vanna_total,
      charm_total: summary.charm_total,
      count:       summary.count,
    };

    await kvPut(`dex:spy:${group}`, summary);
    console.log(
      `[KV] dex:spy:${group} (${items.length}건, 기준일:${nextTradingDate})` +
      ` → DEX=${summary.dex_total.toFixed(0)} GEX=${summary.gex_total.toFixed(0)}` +
      ` Vanna=${summary.vanna_total.toFixed(0)} Charm=${summary.charm_total.toFixed(0)}`
    );
  }

  // 7. Structure 합산
  await kvPut("dex:spy:structure", {
    "0dte":            results["0dte"],
    weekly:            results["weekly"],
    monthly:           results["monthly"],
    quarterly:         results["quarterly"],
    next_trading_date: nextTradingDate,
    updated_at:        updatedAt,
  });

  return { ok: true, updated_at: updatedAt, next_trading_date: nextTradingDate, groups: results };
}
