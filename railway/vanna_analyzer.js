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
//
// 핵심 아이디어:
//   is_market_open = true  → 오늘이 거래일 → ET 기준 오늘 날짜 반환
//   is_market_open = false → time_to_open 으로 다음 장 시작 시각 역산
//                           → 그 날짜가 다음 거래일 (공휴일 자동 처리)
// ─────────────────────────────────────────────────────────────────
export async function getNextTradingDate() {
  try {
    const url = `https://api.twelvedata.com/market_state?exchange=NYSE&apikey=${TWELVE_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();

    // 응답이 배열인 경우 NYSE(XNYS) 찾기, 단일 객체이면 그대로 사용
    const nyse = Array.isArray(json)
      ? (json.find(e => e.code === "XNYS") ?? json[0])
      : json;

    if (!nyse) throw new Error("NYSE 데이터 없음");

    // ET 기준 현재 날짜/시각
    const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));

    if (nyse.is_market_open) {
      // 장이 열려있음 → 오늘이 거래일
      const dateStr = _formatDate(nowET);
      console.log(`[TradingDate] 장 중 → 오늘 ${dateStr}`);
      return dateStr;
    }

    // 장이 닫혀있음 → time_to_open 으로 다음 장 시작 시각 계산
    const timeToOpen = nyse.time_to_open; // "HH:MM:SS" 형식
    if (!timeToOpen) throw new Error("time_to_open 없음");

    const totalSec = _parseHMS(timeToOpen);
    if (totalSec === null) throw new Error(`time_to_open 파싱 실패: ${timeToOpen}`);

    // 현재 ET 시각 + time_to_open = 다음 장 시작 시각
    const nextOpenET = new Date(nowET.getTime() + totalSec * 1000);
    const dateStr    = _formatDate(nextOpenET);

    console.log(`[TradingDate] 장 마감 (time_to_open=${timeToOpen}) → 다음 거래일 ${dateStr}`);
    return dateStr;

  } catch (e) {
    console.warn(`[TradingDate] Twelve Data 조회 실패: ${e.message} → ET 날짜 폴백`);
    return _etDateFallback();
  }
}

// "HH:MM:SS" → 초 (HH가 24 이상도 처리)
function _parseHMS(hms) {
  if (!hms) return null;
  const parts = hms.split(":").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// Date → "YYYY-MM-DD"
function _formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Twelve Data 실패 시 폴백: ET 기준 날짜 (주말이면 월요일로)
function _etDateFallback() {
  const nowET   = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dow     = nowET.getDay(); // 0=일, 6=토
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
  const T = dte / 365;
  if (T <= 0 || iv <= 0 || spot <= 0 || strike <= 0) return null;

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (r + (iv * iv) / 2) * T) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;

  const phi  = normPDF(d1);
  const Nd1  = normCDF(d1);

  const delta = Nd1;
  const gamma = phi / (spot * iv * sqrtT);
  const vanna = -phi * d2 / iv;
  const charm = -phi * (2 * r * T - d2 * iv * sqrtT) / (2 * T * iv * sqrtT);

  return { delta, gamma, vanna, charm };
}

// ─────────────────────────────────────────────────────────────────
// Option string parser
// "SPY260428C00590000" → { symbol, expiry, type, strike, dte }
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
// classifyExpiry — nextTradingDate 기준으로 0dte 판단
//
// nextTradingDate: "YYYY-MM-DD" (getNextTradingDate() 반환값)
// expiry:          "YYYY-MM-DD" (parseOption() 반환값)
// ─────────────────────────────────────────────────────────────────
export function classifyExpiry(dte, expiry, nextTradingDate) {
  // 다음 거래일 만기 = 0dte
  if (expiry === nextTradingDate) return "0dte";
  if (dte <= 7)  return "weekly";
  if (dte <= 35) return "monthly";
  return "quarterly";
}

// ─────────────────────────────────────────────────────────────────
// Filter options: ATM ±10%, DTE 0–60, valid IV/Gamma/OI
// ─────────────────────────────────────────────────────────────────
export function filterOptions(options, spot) {
  const lo = spot * 0.90;
  const hi = spot * 1.10;
  return options.filter((o) => {
    const parsed = parseOption(o.option);
    if (!parsed) return false;
    return (
      o.iv > 0 &&
      o.gamma > 0 &&
      o.open_interest > 0 &&
      parsed.strike >= lo &&
      parsed.strike <= hi &&
      parsed.dte >= 0 &&
      parsed.dte <= 60
    );
  });
}

// ─────────────────────────────────────────────────────────────────
// Fetch CBOE option chain for SPY
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
  // 1. 다음 거래일 날짜 조회 (Twelve Data)
  const nextTradingDate = await getNextTradingDate();
  console.log(`[Calc] 기준 거래일: ${nextTradingDate}`);

  // 2. CBOE 옵션체인 fetch
  const raw      = await fetchCBOE();
  const all      = raw?.data?.options ?? [];
  if (all.length === 0) throw new Error("CBOE returned empty options array");

  const filtered = filterOptions(all, spot);
  console.log(`Filtered ${filtered.length} / ${all.length} options`);

  // 3. 그룹 분류 + Greeks 계산
  const groups = {
    "0dte":      [],
    "weekly":    [],
    "monthly":   [],
    "quarterly": [],
  };

  for (const o of filtered) {
    const parsed = parseOption(o.option);
    if (!parsed) continue;

    const { strike, dte, type, expiry } = parsed;

    // nextTradingDate 기준으로 0dte 판단
    const group  = classifyExpiry(dte, expiry, nextTradingDate);
    const greeks = calcGreeks(spot, strike, dte === 0 ? 0.0027 : dte, o.iv);
    // 0DTE는 dte=0이면 T→0이 되어 계산 불가 → 1시간(1/365 * 1/6.5) 로 대체
    const greeksSafe = calcGreeks(
      spot, strike,
      dte === 0 ? (1 / 365 / 6.5) * (16 - Math.min(new Date().getHours(), 16)) || 0.001 : dte,
      o.iv
    ) ?? greeks;

    if (!greeksSafe) continue;

    const isCall = type === "C";
    const sign   = isCall ? 1 : -1;

    groups[group].push({
      strike,
      expiry,
      dte,
      type,
      oi:    o.open_interest,                                    // ← OI 차트용
      dex:   sign * (o.delta ?? greeksSafe.delta) * o.open_interest * 100,
      gex:   greeksSafe.gamma * o.open_interest * 100,
      vanna: greeksSafe.vanna * o.open_interest * 100,
      charm: greeksSafe.charm * o.open_interest * 100,
    });
  }

  // 4. KV 저장
  const updatedAt = new Date().toISOString();
  const results   = {};

  for (const [group, items] of Object.entries(groups)) {
    const summary = {
      dex_total:        sum(items, "dex"),
      gex_total:        sum(items, "gex"),
      vanna_total:      sum(items, "vanna"),
      charm_total:      sum(items, "charm"),
      spot,
      vix,
      count:            items.length,
      strikes:          items,
      next_trading_date: nextTradingDate,
      updated_at:       updatedAt,
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
      ` → DEX=${summary.dex_total.toFixed(0)} GEX=${summary.gex_total.toFixed(0)}`
    );
  }

  // 5. Structure 합산
  const structure = {
    "0dte":      results["0dte"],
    weekly:      results["weekly"],
    monthly:     results["monthly"],
    quarterly:   results["quarterly"],
    next_trading_date: nextTradingDate,
    updated_at:  updatedAt,
  };
  await kvPut("dex:spy:structure", structure);

  return { ok: true, updated_at: updatedAt, next_trading_date: nextTradingDate, groups: results };
}
