// DexBoard – vanna_analyzer.js
// Runs on Railway: fetch CBOE → filter → Black-Scholes → DEX/GEX/Vanna/Charm → CF KV

import fetch from "node-fetch";

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
  // Vanna: 예전 공식과 동일 — nd1 * (d2/sigma), spot은 밖에서 곱함
  const vanna = phi * d2 / iv;
  // Charm: 예전 공식과 동일
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
// classifyExpiry — nextTradingDate 날짜 직접 비교
// ─────────────────────────────────────────────────────────────────
export function classifyExpiry(dte, expiry, nextTradingDate) {
  if (expiry === nextTradingDate) return "0dte";
  if (dte <= 7)  return "weekly";
  if (dte <= 35) return "monthly";
  return "quarterly";
}

// ─────────────────────────────────────────────────────────────────
// Filter options
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
// Fetch CBOE option chain
// ─────────────────────────────────────────────────────────────────
async function fetchCBOE() {
  const url = `${CBOE_BASE}/SPY.json`;
  const res = await fetch(url, { headers: { "User-Agent": "DexBoard/1.0" } });
  if (!res.ok) throw new Error(`CBOE fetch failed: ${res.status}`);
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
// Main: calculateAndStore
// ─────────────────────────────────────────────────────────────────
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
  // 구조: expiryMap[expiry][strike] = { callOI, putOI, callVol, putVol, iv, dte, expiry }
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

  // 5. 그룹 분류 + Greeks 계산 (strike별 netOI 방식)
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

      const netOI = callOI - putOI;  // 예전 방식: netOI = callOI - putOI

      groups[group].push({
        strike,
        expiry,
        dte,
        callOI,
        putOI,
        // DEX: Call Delta*OI - Put Delta*OI
        dex:   greeks.delta * callOI * 100 - greeks.delta * putOI * 100,
        // GEX: netOI 기반 (예전 방식)
        gex:   netOI * greeks.gamma * 100 * spot,
        // Vanna: 예전 공식 nd1*(d2/sigma)*netOI*100*spot
        vanna: greeks.vanna * netOI * 100 * spot,
        // Charm: 예전 공식 -nd1*(r/(sigma*sqrtT)-d2/(2*T))*netOI*100
        charm: greeks.charm * netOI * 100,
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
