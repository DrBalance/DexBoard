// DexBoard - vanna_analyzer.js
// Runs on Railway: fetch CBOE → filter → Black-Scholes → DEX/GEX/Vanna/Charm → CF KV
// v2: 개별종목 스크리너 수집 엔진 추가
// v3: 0DTE KV 별도 저장 (dex:spy:0dte) + oi15m/oiOpen 계산

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
const T_MIN = 2 / (365 * 24);  // 2시간 -- Charm 폭발 방지
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
const dte = Math.round((expiryDate - new Date()) / 86_400_000);  // 음수 허용 (만기 지난 항목 필터용)
return { symbol, expiry, type, strike, dte };
}

// ─────────────────────────────────────────────────────────────────
// getThirdFriday: 해당 월의 3번째 금요일 날짜 문자열 반환
// ─────────────────────────────────────────────────────────────────
function getThirdFriday(year, month) {
  let count = 0;
  for (let d = 1; d <= 31; d++) {
    const date = new Date(year, month, d);
    if (date.getMonth() !== month) break;
    if (date.getDay() === 5) {
      count++;
      if (count === 3) {
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        return `${date.getFullYear()}-${m}-${dd}`;
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// classifyExpiry
// expiry_date: 'YYYY-MM-DD'
// allExpiries: 전체 만기일 문자열 배열 (Object.keys(expirations))
// ─────────────────────────────────────────────────────────────────
export function classifyExpiry(expiry_date, allExpiries) {
  const d   = new Date(expiry_date);
  const day = d.getDay();  // 0=일,1=월,2=화,3=수,4=목,5=금

  // 월/화/수 → 무조건 0DTE
  if (day <= 3) return '0dte';

  // 목요일 → 같은 주 금요일이 데이터에 있으면 0DTE
  if (day === 4) {
    const friday = new Date(d);
    friday.setDate(d.getDate() + 1);
    const m  = String(friday.getMonth() + 1).padStart(2, '0');
    const dd = String(friday.getDate()).padStart(2, '0');
    const fridayStr = `${friday.getFullYear()}-${m}-${dd}`;
    if (allExpiries.includes(fridayStr)) return '0dte';
  }

  // 금요일 or 당겨진 목요일 → 3째주 금요일과 비교
  const thirdFriday = getThirdFriday(d.getFullYear(), d.getMonth());

  // 3째주 금요일이면 먼슬리
  if (expiry_date === thirdFriday) return 'monthly';

  // 3째주 금요일이 휴장 → 목요일로 당겨진 경우
  if (thirdFriday) {
    const tf = new Date(thirdFriday);
    tf.setDate(tf.getDate() - 1);
    const m  = String(tf.getMonth() + 1).padStart(2, '0');
    const dd = String(tf.getDate()).padStart(2, '0');
    const thirdThursdayStr = `${tf.getFullYear()}-${m}-${dd}`;
    if (expiry_date === thirdThursdayStr && !allExpiries.includes(thirdFriday)) {
      return 'monthly';
    }
  }

  return 'weekly';
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
if (parsed.dte < 0 || parsed.dte > 60) return false;
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
console.warn("CF_KV_URL not set - skipping KV write for", key);
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

// ─────────────────────────────────────────────────────────────────
// Read from CF KV
// ─────────────────────────────────────────────────────────────────
async function kvGet(key) {
if (!CF_KV_URL) return null;
try {
const res = await fetch(`${CF_KV_URL}/kv-read?key=${encodeURIComponent(key)}`, {
headers: { "x-kv-secret": CF_KV_SECRET },
signal: AbortSignal.timeout(8_000),
});
if (!res.ok) return null;
const data = await res.json();
return data?.value ? JSON.parse(data.value) : null;
} catch {
return null;
}
}

function sum(arr, field) {
return arr.reduce((acc, item) => acc + (item[field] || 0), 0);
}

// ─────────────────────────────────────────────────────────────────
// 개별 종목 옵션 집계 -- 만기일별 DEX/GEX/PCR/IV스큐
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
    callTheo: 0, callTheoCount: 0,
    callDelta: 0, callDeltaCount: 0,
  };
}

const s = expiryMap[expiry].strikes[strike];
const oi  = o.open_interest || 0;
const vol = o.volume        || 0;

if (type === "C") {
  s.callOI  += oi;
  s.callVol += vol;
  if (o.iv > 0)    { s.callIV    += o.iv;    s.callIVCount++;    }
  if (o.theo  > 0) { s.callTheo  += o.theo;  s.callTheoCount++;  }
  if (o.delta > 0) { s.callDelta += o.delta; s.callDeltaCount++; }
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

const callOI  = strikes.reduce((s, r) => s + r.callOI,  0);
const putOI   = strikes.reduce((s, r) => s + r.putOI,   0);
const totalOI = callOI + putOI;
const ivSkew  = (atmIV > 0 && totalOI >= 1000) ? (atmCallIV - atmPutIV) / atmIV : 0;

const otmRange = spot * 0.05;
const otmCallStrikes = strikes.filter(s => s.strike > spot && s.strike <= spot + otmRange);
const otmPutStrikes  = strikes.filter(s => s.strike < spot && s.strike >= spot - otmRange);

const avgOTMCallIV = _avgIV(otmCallStrikes, "call");
const avgOTMPutIV  = _avgIV(otmPutStrikes,  "put");

const otmCallTheoVals  = otmCallStrikes
  .map(s => s.callTheoCount  > 0 ? s.callTheo  / s.callTheoCount  : null)
  .filter(v => v != null && v > 0);
const otmCallDeltaVals = otmCallStrikes
  .map(s => s.callDeltaCount > 0 ? s.callDelta / s.callDeltaCount : null)
  .filter(v => v != null && v > 0);
const avgOTMCallTheo  = otmCallTheoVals.length
  ? otmCallTheoVals.reduce((a, b) => a + b, 0) / otmCallTheoVals.length : null;
const avgOTMCallDelta = otmCallDeltaVals.length
  ? otmCallDeltaVals.reduce((a, b) => a + b, 0) / otmCallDeltaVals.length : null;

const callVol = strikes.reduce((s, r) => s + r.callVol, 0);
const putVol  = strikes.reduce((s, r) => s + r.putVol,  0);

const pcrOI  = callOI  > 0 ? putOI  / callOI  : null;
const pcrVol = callVol > 0 ? putVol / callVol : null;

const atmPutRange  = spot * 0.05;
const atmPutOI     = strikes
  .filter(s => Math.abs(s.strike - spot) <= atmPutRange)
  .reduce((acc, s) => acc + s.putOI, 0);
const atmPutRatio  = putOI > 0 ? atmPutOI / putOI : 0;

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

// Strike별 GEX 목록으로 플립존 계산
const strikeGexList = strikes.map(s => {
  const iv = _strikeAvgIV(s);
  if (iv <= 0) return null;
  const dteForGreeks = dte === 0 ? 0.001 : dte;
  const g = calcGreeks(spot, s.strike, dteForGreeks, iv);
  if (!g) return null;
  const netOI = s.callOI - s.putOI;
  return { strike: s.strike, gex: netOI * g.gamma * 100 * spot / 1e6 };
}).filter(Boolean);

const flipStrike = calcFlipStrike(strikeGexList);

// ── 스트라이크별 IV 곡선 데이터 (Smile 곡선용 + 히트맵/EM용 Greeks 포함)
// ATM ± 20% 범위 내, IV가 있는 스트라이크만
const smileRange = spot * 0.20;
const strikeIVRows = strikes
  .filter(s => Math.abs(s.strike - spot) <= smileRange)
  .map(s => {
    const cIV = s.callIVCount > 0 ? +(s.callIV / s.callIVCount).toFixed(4) : null;
    const pIV = s.putIVCount  > 0 ? +(s.putIV  / s.putIVCount).toFixed(4)  : null;
    const avgIV = (cIV && pIV) ? +((cIV + pIV) / 2).toFixed(4)
                : cIV ?? pIV ?? null;
    if (!avgIV) return null;
    const delta = s.callDeltaCount > 0
      ? +(s.callDelta / s.callDeltaCount).toFixed(4) : null;

    // Greeks 계산 (히트맵 / EM 차트용)
    const dteG = dte === 0 ? 0.001 : dte;
    const g    = calcGreeks(spot, s.strike, dteG, avgIV);
    const netOI = s.callOI - s.putOI;
    const sDex   = g ? +((g.delta * s.callOI * 100 - g.delta * s.putOI * 100) / 1e6).toFixed(6) : null;
    const sGex   = g ? +(netOI * g.gamma * 100 * spot / 1e6).toFixed(6) : null;
    const sVanna = g ? +(g.vanna * netOI * 100 * spot / 1e6).toFixed(6) : null;
    const sCharm = g ? +(g.charm * netOI * 100 / 1e6).toFixed(6) : null;

    return {
      strike:     s.strike,
      call_iv:    cIV,
      put_iv:     pIV,
      avg_iv:     avgIV,
      call_delta: delta,
      call_oi:    s.callOI,
      put_oi:     s.putOI,
      dex:        sDex,
      gex:        sGex,
      vanna:      sVanna,
      charm:      sCharm,
    };
  })
  .filter(Boolean)
  .sort((a, b) => a.strike - b.strike);

results.push({
  expiry_date:      expiry,
  dte,
  expiry_type:      classifyExpiry(expiry, Object.keys(expiryMap)),
  flip_strike:      flipStrike,
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
  otm_call_theo:    avgOTMCallTheo  != null ? +avgOTMCallTheo.toFixed(4)  : null,
  otm_call_delta:   avgOTMCallDelta != null ? +avgOTMCallDelta.toFixed(4) : null,
  // Smile 곡선용 스트라이크별 데이터
  _strikeRows:      strikeIVRows,
});

}

return results.sort((a, b) => a.dte - b.dte);
}

// ─────────────────────────────────────────────────────────────────
// GEX 누적합 부호 전환점 계산 (표준 Flip Zone)
// market.js의 _extractKeyLevels()와 동일한 알고리즘
//
// strikeGexList: [{ strike, gex }, ...]
// 낮은 Strike부터 GEX를 누적 — 음수→양수 전환 Strike가 Flip Zone
// ─────────────────────────────────────────────────────────────────
export function calcFlipStrike(strikeGexList) {
  if (!strikeGexList?.length) return null;

  const sorted = [...strikeGexList].sort((a, b) => a.strike - b.strike);

  let cumGex   = 0;
  let prevSign = null;

  for (const s of sorted) {
    cumGex += (s.gex ?? 0);
    const sign = cumGex >= 0 ? 1 : -1;
    if (prevSign !== null && sign !== prevSign) {
      return s.strike;
    }
    prevSign = sign;
  }

  return null;
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
// 스크리너 점수 계산 v2 -- Charm 기반 상승 구조 탐색 (10점 만점)
//
// 필수 조건 (미충족 시 null 반환)
//   1. 최소 1개 만기에서 GEX > 0 && DEX > 0 (Flip Zone 위 구조)
//   2. 최소 1개 만기에서 Call 스큐 양수 (otm_call_iv > otm_put_iv)
//
// 점수 조건
//   A. Call 스큐 충족 만기 수   3점 (1개→1, 2개→2, 3개+→3)
//   B. Call 베팅 비율           3점 (총CallPremium / spot×totalOI×100)
//   C. Flip Zone 안정성         3점 (Flip 위 만기 비율)
//   D. 총 Call 프리미엄 > $200K 1점 (기관 레벨 베팅 확인)
// ─────────────────────────────────────────────────────────────────
export function calcScreenerScore(rows, spot) {
if (!rows?.length || !spot) return null;

// 6주(42일) 이내 만기만 사용
const valid = rows.filter(r => r.dte >= 0 && r.dte <= 42);
if (!valid.length) return null;

// ── 필수 조건 1: Flip Zone 위 구조 ───────────────────────────────
// GEX > 0 (딜러 Long Gamma) && DEX > 0 (딜러 net Long)
// = 해당 만기에서 현재가가 Flip Zone 위에 있을 가능성
const flipAboveCount = valid.filter(r => r.gex > 0 && r.dex > 0).length;
if (flipAboveCount === 0) return null;

// ── 필수 조건 2: Call 스큐 양수 만기 수 ──────────────────────────
const callSkewRows = valid.filter(r =>
r.otm_call_iv != null &&
r.otm_put_iv  != null &&
r.otm_call_iv > r.otm_put_iv
);
if (callSkewRows.length === 0) return null;

// ── A. Call 스큐 충족 만기 수 (3점) ──────────────────────────────
let score_skew_count = 0;
if      (callSkewRows.length >= 3) score_skew_count = 3;
else if (callSkewRows.length === 2) score_skew_count = 2;
else                                score_skew_count = 1;

// ── B. Call 베팅 비율 (3점) ───────────────────────────────────────
// = 총 Call 프리미엄 / (spot × 총OI × 100)
let totalCallPremium = 0;
let totalOI = 0;
for (const r of valid) {
if (r.otm_call_theo != null && r.otm_call_theo > 0 && r.call_oi > 0) {
totalCallPremium += r.otm_call_theo * r.call_oi * 100;
}
totalOI += (r.call_oi || 0) + (r.put_oi || 0);
}
const callBetRatio = (totalOI > 0)
? totalCallPremium / (spot * totalOI * 100)
: 0;

let score_bet_ratio = 0;
if      (callBetRatio >= 0.003) score_bet_ratio = 3;
else if (callBetRatio >= 0.001) score_bet_ratio = 2;
else if (callBetRatio >  0)     score_bet_ratio = 1;

// ── C. Flip Zone 안정성 (3점) ─────────────────────────────────────
// Flip 위에 있는 만기 비율로 구조 안정성 판단
const flipRatio = flipAboveCount / valid.length;
let score_flip_dist = 0;
if      (flipRatio >= 0.6) score_flip_dist = 3;
else if (flipRatio >= 0.3) score_flip_dist = 2;
else                       score_flip_dist = 1;

// ── D. 총 Call 프리미엄 > $200,000 (1점) ─────────────────────────
const score_premium_gate = totalCallPremium >= 200_000 ? 1 : 0;

// ── 총점 ──────────────────────────────────────────────────────────
const total_score =
score_skew_count +
score_bet_ratio  +
score_flip_dist  +
score_premium_gate;

// 가장 짧은 만기의 iv_skew
const shortestRow = valid.reduce((a, b) => a.dte < b.dte ? a : b, valid[0]);

return {
// 새 점수 필드
score_skew_count,
score_bet_ratio,
score_flip_dist,
score_premium_gate,
total_score,

// 진단용
call_skew_count:    callSkewRows.length,
total_call_premium: +totalCallPremium.toFixed(0),
call_bet_ratio:     +callBetRatio.toFixed(6),
flip_above_count:   flipAboveCount,
valid_expiry_count: valid.length,

// 기존 호환 필드 (D1 스키마 및 screener.js 테이블 호환)
score_skew:        score_skew_count,
score_bb:          score_bet_ratio,
score_vol_squeeze: score_flip_dist,
bb_position:       null,
bb_flag:           null,
iv_skew:           shortestRow?.iv_skew ?? null,
skew_strength:     totalCallPremium,

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

// _strikeRows를 별도로 추출 (D1 저장용)
const strikeRows = [];
for (const r of rows) {
  if (r._strikeRows?.length) {
    for (const s of r._strikeRows) {
      strikeRows.push({
        date,
        symbol,
        expiry_date: r.expiry_date,
        dte:         r.dte,
        strike:      s.strike,
        call_iv:     s.call_iv,
        put_iv:      s.put_iv,
        avg_iv:      s.avg_iv,
        call_delta:  s.call_delta,
        call_oi:     s.call_oi,
        put_oi:      s.put_oi,
        dex:         s.dex,
        gex:         s.gex,
        vanna:       s.vanna,
        charm:       s.charm,
      });
    }
  }
  // D1 저장 시 _strikeRows 제거 (options_dex 스키마에 없는 필드)
  delete r._strikeRows;
}

return { symbol, spot, date, rows, strikeRows };
}

// ─────────────────────────────────────────────────────────────────
// Main: calculateAndStore (SPY DEX)
// 1. 기존 dex:spy KV 유지 (전체 만기)
// 2. 신규 dex:spy:0dte KV 저장 (0DTE만, oi15m/oiOpen 포함)
// ─────────────────────────────────────────────────────────────────
async function fetchCBOE() {
const url = `${CBOE_BASE}/SPY.json`;
const res = await fetch(url, { headers: { "User-Agent": "DexBoard/1.0" } });
if (!res.ok) throw new Error(`CBOE fetch failed: ${res.status}`);
return res.json();
}

export async function calculateAndStore() {
// 1. CBOE 옵션체인 fetch
const raw = await fetchCBOE();
const all = raw?.data?.options ?? [];
if (all.length === 0) throw new Error("CBOE returned empty options array");

const spot = raw?.data?.current_price;
if (!spot) throw new Error("CBOE current_price 없음");
console.log(`[Calc] spot=${spot}`);

// 저장 기준일: Twelve Data 기준 다음 거래일 (= 0DTE 만기일)
const nextTradingDate = await getNextTradingDate();
const todayET         = getTodayET();
console.log(`[Calc] 기준일: ${todayET}, 0DTE 만기일: ${nextTradingDate}`);

// 2. 필터링
const filtered = all.filter((o) => {
const parsed = parseOption(o.option);
if (!parsed) return false;
if (parsed.dte < 0) return false;
if (o.iv <= 0) return false;
return o.open_interest > 0 || o.volume > 0;
});
console.log(`Filtered ${filtered.length} / ${all.length} options`);

// 3. 만기별 strike 맵 구성
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
    callVolume: 0, putVolume: 0,
    iv: 0, ivCount: 0,
  };
}

const s = expiryMap[expiry][strike];
const oi  = o.open_interest || 0;
const vol = o.volume        || 0;
const oiEff = oi > 0 ? oi : vol;

if (type === "C") { s.callOI += oiEff; s.callVolume += vol; }
else              { s.putOI  += oiEff; s.putVolume  += vol; }
if (o.iv > 0) { s.iv += o.iv; s.ivCount++; }

}

// 4. Greeks 계산 -- 만기일별 strikes 배열 구성
const expirations = {};

for (const [expiry, strikeMap] of Object.entries(expiryMap)) {
const strikes = [];

for (const s of Object.values(strikeMap)) {
  const { strike, dte, callOI, putOI, callVolume, putVolume } = s;
  const iv = s.ivCount > 0 ? s.iv / s.ivCount : 0.20;
  const dteForGreeks = dte === 0 ? 0.001 : dte;
  const greeks = calcGreeks(spot, strike, dteForGreeks, iv);
  if (!greeks) continue;

  const netOI = callOI - putOI;

  strikes.push({
    strike,
    expiry,
    callOI,
    putOI,
    callVolume,
    putVolume,
    avg_iv: +iv.toFixed(4),
    dex:   (greeks.delta * callOI * 100 - greeks.delta * putOI * 100) / 1e6,
    gex:   netOI * greeks.gamma * 100 * spot / 1e6,
    vanna: greeks.vanna * netOI * 100 * spot / 1e6,
    charm: greeks.charm * netOI * 100 / 1e6,
  });
}

if (strikes.length > 0) {
  expirations[expiry] = strikes;
}

}

// 5. 만기별 플립존 계산 + atm_iv/dte 직접 계산 후 expirations에 포함
for (const [expiry, strikes] of Object.entries(expirations)) {
  const flipStrike = calcFlipStrike(strikes);

  const dte = strikes[0]?.dte ?? null;

  const atmStrike = strikes.reduce((best, s) =>
    Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best
  , strikes[0]);
  const atmIV = atmStrike?.avg_iv ?? null;

  const otmRange   = spot * 0.05;
  const otmCallIVs = strikes.filter(s => s.strike > spot && s.strike <= spot + otmRange).map(s => s.avg_iv).filter(Boolean);
  const otmPutIVs  = strikes.filter(s => s.strike < spot && s.strike >= spot - otmRange).map(s => s.avg_iv).filter(Boolean);
  const otmCallIV  = otmCallIVs.length ? otmCallIVs.reduce((a,b) => a+b,0) / otmCallIVs.length : null;
  const otmPutIV   = otmPutIVs.length  ? otmPutIVs.reduce((a,b)  => a+b,0) / otmPutIVs.length  : null;
  const ivSkew     = (atmIV && otmCallIV && otmPutIV) ? (otmCallIV - otmPutIV) / atmIV : null;

  const allExpiries = Object.keys(expirations);

  expirations[expiry] = {
    strikes,
    flip_strike:  flipStrike,
    dte,
    expiry_type:  classifyExpiry(expiry, allExpiries),
    atm_iv:       atmIV,
    otm_call_iv:  otmCallIV != null ? +otmCallIV.toFixed(4) : null,
    otm_put_iv:   otmPutIV  != null ? +otmPutIV.toFixed(4)  : null,
    iv_skew:      ivSkew    != null ? +ivSkew.toFixed(4)     : null,
  };
}

// 기존 dex:spy KV 저장 (전체 만기 -- 날짜조회 탭용)
const updatedAt = new Date().toISOString();
const fullPayload = {
updated_at:  updatedAt,
date:        todayET,
expirations,
};
await kvPut('dex:spy', fullPayload);
console.log(`[KV] dex:spy 저장 완료 -- 만기일 ${Object.keys(expirations).length}개`);

// 6. 0DTE strikes 추출 (nextTradingDate 기준)
const zeroStrikes = expirations[nextTradingDate]?.strikes ?? [];
if (zeroStrikes.length === 0) {
console.warn(`[KV] 0DTE strikes 없음 (만기일: ${nextTradingDate}) -- dex:spy:0dte 저장 생략`);
} else {
// 7. 직전 dex:spy:0dte KV 읽기 (oi15m, oiOpen 계산용)
const prev0dte = await kvGet('dex:spy:0dte');

// 직전 스냅샷이 같은 만기일 데이터인지 확인
const prevStrikes = (prev0dte?.expiry === nextTradingDate && Array.isArray(prev0dte?.strikes))
  ? prev0dte.strikes
  : null;

// 직전 스냅샷을 strike 키맵으로 변환
const prevMap = {};
if (prevStrikes) {
  for (const s of prevStrikes) {
    prevMap[s.strike] = { callOI: s.callOI, putOI: s.putOI };
  }
}

// 8. oi15m / oiOpen 계산하여 새 strikes 배열 구성
const newStrikes = zeroStrikes.map(s => {
  const prev = prevMap[s.strike];

  // oi15m: 직전 스냅샷 대비 증감
  const callOi15m = prev != null ? s.callOI - prev.callOI : 0;
  const putOi15m  = prev != null ? s.putOI  - prev.putOI  : 0;

  // oiOpen: 누적 증감 = 직전 oiOpen + 이번 oi15m
  // 직전 스냅샷이 없으면 oiOpen = 0 (기준점)
  const prevEntry  = prevStrikes ? prevStrikes.find(p => p.strike === s.strike) : null;
  const callOiOpen = prevEntry != null ? (prevEntry.callOiOpen ?? 0) + callOi15m : 0;
  const putOiOpen  = prevEntry != null ? (prevEntry.putOiOpen  ?? 0) + putOi15m  : 0;

  return {
    strike:      s.strike,
    expiry:      s.expiry,
    callOI:      s.callOI,
    putOI:       s.putOI,
    callVolume:  s.callVolume ?? 0,
    putVolume:   s.putVolume  ?? 0,
    callOi15m,   // 15분 증감 (계약수)
    putOi15m,    // 15분 증감 (계약수)
    callOiOpen,  // 장 시작 대비 누적 증감 (계약수)
    putOiOpen,   // 장 시작 대비 누적 증감 (계약수)
    dex:         s.dex,
    gex:         s.gex,
    vanna:       s.vanna,
    charm:       s.charm,
  };
});

// 9. dex:spy:0dte 저장
const payload0dte = {
  updated_at: updatedAt,
  date:       todayET,
  expiry:     nextTradingDate,  // 0DTE 만기일 명시
  strikes:    newStrikes,
};
await kvPut('dex:spy:0dte', payload0dte);
console.log(`[KV] dex:spy:0dte 저장 완료 -- 만기일 ${nextTradingDate}, ${newStrikes.length}건`);

}

const expiryCount  = Object.keys(expirations).length;
const totalStrikes = Object.values(expirations).reduce((a, b) => a + b.length, 0);

// ── 10. SPY 0DTE 스트라이크 스냅샷 D1 저장 ──────────────────────
// 매 평일 15분마다 실행 — 나중에 그날을 리뷰하기 위한 아카이브
if (zeroStrikes.length > 0 && CF_KV_URL) {
  try {
    // 전체 집계값 계산
    const totalGex   = zeroStrikes.reduce((a, s) => a + (s.gex   ?? 0), 0);
    const totalVanna = zeroStrikes.reduce((a, s) => a + (s.vanna ?? 0), 0);
    const totalCharm = zeroStrikes.reduce((a, s) => a + (s.charm ?? 0), 0);
    const totalDex   = zeroStrikes.reduce((a, s) => a + (s.dex   ?? 0), 0);
    const totalCallOI     = zeroStrikes.reduce((a, s) => a + (s.callOI     ?? 0), 0);
    const totalPutOI      = zeroStrikes.reduce((a, s) => a + (s.putOI      ?? 0), 0);
    const totalCallVolume = zeroStrikes.reduce((a, s) => a + (s.callVolume ?? 0), 0);
    const totalPutVolume  = zeroStrikes.reduce((a, s) => a + (s.putVolume  ?? 0), 0);
    const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : null;

    // flip_zone: expirations[nextTradingDate].flip_strike
    const flipZone = expirations[nextTradingDate]?.flip_strike ?? null;

    // 스트라이크별 데이터 구성 (newStrikes 기반 — oi15m 포함)
    const snapshotStrikes = newStrikes.map(s => ({
      strike:      s.strike,
      call_oi:     s.callOI,
      put_oi:      s.putOI,
      call_oi_15m: s.callOi15m,
      put_oi_15m:  s.putOi15m,
      call_volume: s.callVolume ?? 0,
      put_volume:  s.putVolume  ?? 0,
      dex:         s.dex,
      gex:         s.gex,
      vanna:       s.vanna,
      charm:       s.charm,
    }));

    const snapshotPayload = {
      ts:                updatedAt,
      date:              todayET,
      spot,
      total_gex:         +totalGex.toFixed(4),
      total_vanna:       +totalVanna.toFixed(4),
      total_charm:       +totalCharm.toFixed(4),
      total_dex:         +totalDex.toFixed(4),
      total_call_volume: totalCallVolume,
      total_put_volume:  totalPutVolume,
      pcr:               pcr != null ? +pcr.toFixed(4) : null,
      flip_zone:         flipZone,
      strikes:           snapshotStrikes,
    };

    const snapRes = await fetch(`${CF_KV_URL}/d1/spy-snapshot`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-cron-secret': CF_KV_SECRET,
      },
      body:   JSON.stringify(snapshotPayload),
      signal: AbortSignal.timeout(15000),
    });
    if (snapRes.ok) {
      const snapData = await snapRes.json();
      console.log(`[D1] spy-snapshot 저장 완료 — ${snapData.inserted}건 (${updatedAt})`);
    } else {
      console.warn(`[D1] spy-snapshot 저장 실패 — ${snapRes.status}`);
    }
  } catch (snapErr) {
    // 스냅샷 저장 실패해도 메인 흐름에 영향 없음
    console.warn(`[D1] spy-snapshot 예외:`, snapErr.message);
  }
}

return {
ok:          true,
updated_at:  updatedAt,
date:        todayET,
expiry_0dte: nextTradingDate,
expirations: expiryCount,
strikes:     totalStrikes,
strikes_0dte: zeroStrikes.length,
};
}