// DexBoard - Railway entry point v3
// POST /calculate        → CBOE SPY DEX 계산 → CF KV
// POST /analyze          → Gemini API 분석
// POST /collect-screener → 개별종목 스크리너 수집 → D1 저장
// GET  /screener-status  → 오늘 수집 여부 확인
// setInterval 스케줄러   → fetchSnapshot (Yahoo→KV), snapshotOpen, triggerScreener

import http from "http";
import { calculateAndStore, collectSymbol, getTodayET } from "./vanna_analyzer.js";
import { runScreenerCollection, fetchScreenerSymbols, analyzeSymbol, saveSymbolRows, updateScreenedTicker, runWatchlistScan, pruneWatchlistGroup } from "./screener-engine.js";
import { fetchChartData, VALID_RESOLUTIONS } from "./chart-api.js";

const TWELVE_KEY = process.env.TWELVE_KEY || "";
const PORT        = process.env.PORT        || 8080;
const CRON_SECRET = process.env.CRON_SECRET || "";
const GEMINI_KEY  = process.env.GEMINI_KEY  || "";
const CF_WORKER_URL = process.env.CF_WORKER_URL || "";
const CF_KV_SECRET  = process.env.CF_KV_SECRET  || "";

// ─────────────────────────────────────────────────────────────────
// 가격 수집 + BB 계산 → CF Worker D1 저장
// ─────────────────────────────────────────────────────────────────
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';

async function collectPriceIndicators(symbol, cfWorkerUrl, cronSecret) {
try {
const url = `${YAHOO_CHART}/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;
const res = await fetch(url, {
headers: { 'User-Agent': 'Mozilla/5.0' },
signal: AbortSignal.timeout(10000),
});
if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);

const json   = await res.json();
const result = json?.chart?.result?.[0];
if (!result) throw new Error('Yahoo: no result');

const timestamps = result.timestamp ?? [];
const closes     = result.indicators?.quote?.[0]?.close ?? [];
const highs      = result.indicators?.quote?.[0]?.high  ?? [];
const lows       = result.indicators?.quote?.[0]?.low   ?? [];

const candles = timestamps
  .map((ts, i) => ({
    date:  new Date(ts * 1000).toISOString().slice(0, 10),
    close: closes[i] ?? null,
    high:  highs[i]  ?? null,
    low:   lows[i]   ?? null,
  }))
  .filter(c => c.close != null);

if (candles.length < 20) throw new Error('insufficient_data');

const cls = candles.map(c => c.close);

// 캔들 전체에 대해 BB/ATR 계산 → 전체 행 생성 (INSERT OR IGNORE로 기존 보존)
const rows = [];
for (let i = 19; i < candles.length; i++) {
  const { date, close, high, low } = candles[i];

  // 볼린저밴드 (20일 rolling)
  const slice = cls.slice(i - 19, i + 1);
  const sma   = slice.reduce((a, b) => a + b, 0) / 20;
  const std   = Math.sqrt(slice.reduce((a, b) => a + (b - sma) ** 2, 0) / 20);
  const upper2 = sma + std * 2;
  const lower2 = sma - std * 2;
  const bbRange    = upper2 - lower2;
  const bbPosition = bbRange > 0 ? (close - lower2) / bbRange : 0.5;

  // ATR (5일/20일) -- i 기준 슬라이스
  const atr = (n) => {
    if (i < n - 1) return null;
    const s = candles.slice(i - n + 1, i + 1);
    return s.reduce((a, c) => a + (c.high - c.low), 0) / n;
  };
  const atr5  = atr(5);
  const atr20 = atr(20);

  rows.push({
    date,
    symbol,
    close,
    bb_mid:      +sma.toFixed(4),
    bb_upper1:   +(sma + std).toFixed(4),
    bb_lower1:   +(sma - std).toFixed(4),
    bb_upper2:   +upper2.toFixed(4),
    bb_lower2:   +lower2.toFixed(4),
    bb_position: +bbPosition.toFixed(4),
    atr5:        atr5  ? +atr5.toFixed(4)  : null,
    atr20:       atr20 ? +atr20.toFixed(4) : null,
    vol_ratio:   (atr5 && atr20) ? +(atr5 / atr20).toFixed(4) : null,
  });
}

// CF Worker D1 저장 -- INSERT OR IGNORE (기존 날짜 데이터 보존, 신규만 추가)
const writeRes = await fetch(`${cfWorkerUrl}/d1/price-indicators`, {
  method:  'POST',
  headers: {
    'Content-Type':  'application/json',
    'x-cron-secret': cronSecret,
  },
  body: JSON.stringify({ rows, mode: 'replace' }),
  signal: AbortSignal.timeout(15000),
});
if (!writeRes.ok) throw new Error(`D1 write failed: ${writeRes.status}`);

// 반환값은 가장 최신 캔들 기준
const latest = rows[rows.length - 1];
return { symbol, close: latest.close, bbPosition: latest.bb_position, volRatio: latest.vol_ratio };

} catch (err) {
console.error(`[${symbol}] 가격 수집 실패:`, err.message);
return null;
}
}

const GEMINI_URL =
"https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent";

// ─────────────────────────────────────────────────────────────────
// Rate Limiter
// ─────────────────────────────────────────────────────────────────
const _analyzeRateMap = new Map();
const RATE_LIMIT_MAX    = 5;
const RATE_LIMIT_WINDOW = 60_000;

function checkRateLimit(ip) {
const now = Date.now();
const entry = _analyzeRateMap.get(ip);
if (!entry || now > entry.resetAt) {
_analyzeRateMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
return true;
}
if (entry.count >= RATE_LIMIT_MAX) return false;
entry.count++;
return true;
}

// ─────────────────────────────────────────────────────────────────
// Gemini
// ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGeminiWithRetry(payload, retries = 3) {
for (let i = 0; i < retries; i++) {
try {
return await callGemini(payload);
} catch (err) {
const is429 = err.message?.includes("429");
if (is429 && i < retries - 1) {
const wait = Math.pow(2, i) * 1500;
console.warn(`[Gemini] 429 -- ${wait}ms 후 재시도 (${i + 1}/${retries - 1})`);
await sleep(wait);
continue;
}
throw err;
}
}
}

async function callGemini(payload) {
if (!GEMINI_KEY) throw new Error("GEMINI_KEY not set");

const compressedStrikes = (payload.strikes ?? [])
.sort((a, b) => Math.abs(b.dex) - Math.abs(a.dex))
.slice(0, 10)
.map(s => ({
s:  s.strike,
cd: s.type === 'C' ? +(s.dex / 1e6).toFixed(1) : 0,
pd: s.type === 'P' ? +(s.dex / 1e6).toFixed(1) : 0,
g:  +(s.gex   / 1e6).toFixed(1),
v:  +(s.vanna  / 1e6).toFixed(1),
c:  +(s.charm  / 1e6).toFixed(1),
}));

const fullPrompt = `
[역할 및 출력 규칙]
너는 옵션 시장과 현물 거래량의 상관관계를 분석하는 퀀트 전문가야.
DEX 히트맵의 장벽(Wall)과 VOLD의 에너지를 비교하여 시장의 페이크 상승/하락을 포착하고
시나리오별 확률을 도출하는 것이 네 임무야.
반드시 아래 JSON 형식으로만 응답해야 하며, 마크다운 코드블록이나 다른 텍스트는 절대 포함하지 마.

[키 매핑]
s=strike, cd=call_dex(M), pd=put_dex(M), g=gex(M), v=vanna(M), c=charm(M)

[현재 시장 상태]

- 장 상태: ${payload.marketState} / ET: ${payload.etTime}
- SPY: $${payload.spot} (${payload.spyChangePct}%)
- VIX: ${payload.vix} (${payload.vixChangePct}%)

[딜러 포지션 (0DTE 합산, 단위 M)]

- DEX: ${(payload.dex / 1e6).toFixed(1)}M
- GEX: ${(payload.gex / 1e6).toFixed(1)}M
- Vanna: ${(payload.vanna / 1e6).toFixed(1)}M
- Charm: ${(payload.charm / 1e6).toFixed(1)}M
- VOLD(RSP): ${(payload.vold / 1e6).toFixed(1)}M

[Strike 데이터 (DEX 상위 10개)]
${JSON.stringify(compressedStrikes)}

[응답 JSON 형식 -- 한국어, 각 필드를 구체적이고 충분히 서술할 것]
{
"market_regime": {
"phase": "시장 국면 (예: 감마 압축 구간, 언와인드 진행 중 등)",
"volatility_context": "현재 VIX 수준과 변동성 방향성에 대한 구체적 설명",
"dominance": "Dealer-Driven 또는 Flow-Driven -- 근거 포함"
},
"deep_dive": {
"dealer_inventory": {
"gamma_exposure": "GEX 부호 및 크기, 핵심 위험 스트라이크, 딜러 헷지 방향을 상세히 설명",
"vanna_flow": "현재 VIX 방향에 따른 Vanna 흐름이 딜러 델타 헷지에 미치는 압력 분석"
},
"breadth_analysis": {
"vold_signal": "VOLD와 SPY 가격 간 다이버전스 여부, 강도, 지속 가능성 평가",
"interpretation": "현물 수급 에너지의 질적 해석 -- 진짜 매수/매도 vs 파생 헷지 유발 흐름 구분"
}
},
"scenarios": [
{
"case": "상승 시나리오",
"trigger": "구체적인 발생 조건",
"target": "목표 스트라이크 또는 Call Wall 레벨",
"probability": 60
},
{
"case": "하락 시나리오",
"trigger": "구체적인 발생 조건",
"target": "주요 지지선 또는 Put Wall 레벨",
"probability": 40
}
],
"expert_insight": "딜러 헷징 메커니즘 관점에서 현 국면의 핵심 리스크와 트레이딩 함의를 3~4문장으로 서술"
}`.trim();

const url = `${GEMINI_URL}?key=${GEMINI_KEY}`;
const res = await fetch(url, {
method:  "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({
contents: [{ parts: [{ text: fullPrompt }] }],
generationConfig: {
temperature:     0.15,
topP:            0.8,
maxOutputTokens: 8192,
},
}),
signal: AbortSignal.timeout(30_000),
});

if (!res.ok) {
const txt = await res.text();
throw new Error(`Gemini ${res.status}: ${txt.slice(0, 200)}`);
}

const json = await res.json();
const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
if (!text) throw new Error("Gemini: 응답 텍스트 없음");

try {
const cleaned = text
.replace(/^`json\s*/i, "") .replace(/^`\s*/i, "")
.replace(/```\s*$/, "")
.trim();
return JSON.parse(cleaned);
} catch {
const raw = text.slice(0, 500);
const chunkSize = 80;
for (let i = 0; i < raw.length; i += chunkSize) {
console.log("[Gemini RAW] chunk" + Math.floor(i/chunkSize) + ": " + raw.slice(i, i + chunkSize));
}
throw new Error("Gemini: JSON 파싱 실패");
}
}

// ─────────────────────────────────────────────────────────────────
// CF Worker D1 write 헬퍼
// ─────────────────────────────────────────────────────────────────
async function d1Write(endpoint, body) {
if (!CF_WORKER_URL) throw new Error("CF_WORKER_URL not set");
const res = await fetch(`${CF_WORKER_URL}${endpoint}`, {
method:  "POST",
headers: {
"Content-Type":  "application/json",
"x-cron-secret": CRON_SECRET,
},
body: JSON.stringify(body),
signal: AbortSignal.timeout(60_000),
});
if (!res.ok) {
const txt = await res.text();
throw new Error(`D1 write ${endpoint} failed: ${res.status} ${txt.slice(0, 200)}`);
}
return res.json();
}

// ─────────────────────────────────────────────────────────────────
// 스크리너 수집 엔진
// ─────────────────────────────────────────────────────────────────

// 동시 수집 제한 -- CBOE rate limit 방지
async function batchCollect(symbols, concurrency = 5) {
const results = [];
const errors  = [];

for (let i = 0; i < symbols.length; i += concurrency) {
const batch = symbols.slice(i, i + concurrency);
const settled = await Promise.allSettled(
batch.map(s => collectSymbol(s.symbol, s.date))
);

for (let j = 0; j < settled.length; j++) {
  const r = settled[j];
  if (r.status === "fulfilled") {
    results.push(r.value);
  } else {
    const sym = batch[j].symbol;
    console.error(`[Screener] ${sym} 수집 실패:`, r.reason?.message);
    errors.push({ symbol: sym, error: r.reason?.message });
  }
}

// CBOE 요청 간격 -- 배치 사이 200ms 대기
if (i + concurrency < symbols.length) {
  await sleep(200);
}

}

return { results, errors };
}

// saveToD1 -- 레거시, 미사용 (Whale 필터 기준으로 교체)

// ─────────────────────────────────────────────────────────────────
// 수집 진행 상태 (메모리 내 -- Railway 재시작 시 초기화)
// ─────────────────────────────────────────────────────────────────
let collectState = {
running:   false,
startedAt: null,
progress:  null,   // { done, total, errors }
lastRun:   null,   // { date, ok, count, errors, ts }
};

// ─────────────────────────────────────────────────────────────────
// watchlist 스캔 상태 (메모리 내 — Railway 재시작 시 초기화)
// ─────────────────────────────────────────────────────────────────
let watchlistScanState = {
  running:   false,
  startedAt: null,
  progress:  null,   // { done, total, promoted, errors }
  lastRun:   null,   // { date, ok, scanned, promoted, errors, ts }
};

// ─────────────────────────────────────────────────────────────────
// HTTP 서버
// ─────────────────────────────────────────────────────────────────
const corsHeaders = {
"Access-Control-Allow-Origin":  "*",
"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
"Access-Control-Allow-Headers": "Content-Type, x-cron-secret",
"Content-Type": "application/json",
};

function sendJSON(res, status, data) {
res.writeHead(status, corsHeaders);
res.end(JSON.stringify(data));
}

async function readBody(req) {
return new Promise((resolve) => {
let body = "";
req.on("data", c => (body += c));
req.on("end", () => {
try { resolve(JSON.parse(body || "{}")); }
catch { resolve({}); }
});
});
}

const server = http.createServer(async (req, res) => {
// Health check
// ── GET /api/chart ───────────────────────────────────────────────
if (req.method === "GET" && req.url.startsWith("/api/chart")) {
  const urlObj     = new URL(req.url, `http://localhost`);
  const symbol     = urlObj.searchParams.get("symbol")?.toUpperCase();
  const resolution = urlObj.searchParams.get("resolution") ?? "D";
  if (!symbol) return sendJSON(res, 400, { error: "symbol 필요" });
  if (!VALID_RESOLUTIONS.includes(resolution)) return sendJSON(res, 400, { error: "유효하지 않은 resolution" });
  try {
    const data = await fetchChartData(symbol, resolution);
    return sendJSON(res, 200, data);
  } catch (e) {
    const status = e.message === "no_data" ? 404 : 502;
    return sendJSON(res, status, { error: e.message });
  }
}

// ── GET /live-prices ─────────────────────────────────────────────
// Yahoo Finance batch quote 프록시 (Railway IP 사용 → CF Worker IP 차단 우회)
// ?symbols=AAPL,NVDA,MSFT
if (req.method === "GET" && req.url.startsWith("/live-prices")) {
  const auth = req.headers["x-cron-secret"];
  if (CRON_SECRET && auth !== CRON_SECRET) {
    res.writeHead(401);
    return res.end("Unauthorized");
  }
  try {
    const urlObj      = new URL(req.url, `http://localhost`);
    const symbolsParam = urlObj.searchParams.get("symbols") ?? "";
    if (!symbolsParam) return sendJSON(res, 400, { error: "symbols 파라미터 필요" });

    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbolsParam)}&fields=regularMarketPrice,marketState`;
    const yRes = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(12000),
    });
    if (!yRes.ok) throw new Error(`Yahoo HTTP ${yRes.status}`);

    const data   = await yRes.json();
    const result = data?.quoteResponse?.result ?? [];
    const quotes = result.map(q => ({
      symbol:             q.symbol,
      regularMarketPrice: q.regularMarketPrice ?? null,
      marketState:        q.marketState        ?? null,
    }));
    return sendJSON(res, 200, { ok: true, quotes });
  } catch (err) {
    return sendJSON(res, 500, { ok: false, error: err.message });
  }
}

// ── GET /health ──────────────────────────────────────────────────
if (req.method === "GET" && req.url === "/health") {
return sendJSON(res, 200, { status: "ok", ts: new Date().toISOString() });
}

// CORS preflight
if (req.method === "OPTIONS") {
res.writeHead(204, corsHeaders);
return res.end();
}

// ── GET /screener-status ─────────────────────────────────────────
if (req.method === "GET" && req.url === "/screener-status") {
const todayET = getTodayET();
return sendJSON(res, 200, {
today:    todayET,
running:  collectState.running,
progress: collectState.progress,
last_run: collectState.lastRun,
});
}

// ── POST /analyze ────────────────────────────────────────────────
if (req.method === "POST" && req.url === "/analyze") {
const body = await readBody(req);
try {
const ip = req.socket.remoteAddress ?? "unknown";
if (!checkRateLimit(ip)) {
return sendJSON(res, 429, { ok: false, error: "서버 요청 한도 초과 (IP 기반)" });
}

  const analysis = await callGeminiWithRetry(body);

  // AI 분석 결과 KV 캐싱
  if (CF_WORKER_URL && CF_KV_SECRET) {
    try {
      await fetch(`${CF_WORKER_URL}/kv-write`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "x-kv-secret": CF_KV_SECRET },
        body: JSON.stringify({
          key:   "ai:analysis",
          value: JSON.stringify({ analysis, ts: new Date().toISOString() }),
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (kvErr) {
      console.warn("[AI] KV 캐시 저장 실패:", kvErr.message);
    }
  }

  return sendJSON(res, 200, { ok: true, analysis });
} catch (err) {
  console.error("[Gemini] 분석 실패:", err.message);
  const is429 = err.message?.includes("429");
  return sendJSON(res, is429 ? 429 : 500, {
    ok: false,
    error: is429 ? "Gemini API 할당량이 일시적으로 소진되었습니다." : err.message,
  });
}

}

// ── POST /webhook/prevclose ───────────────────────────────────────
// Google Sheets Apps Script → 장 마감 후 전일 종가 수신
if (req.method === "POST" && req.url === "/webhook/prevclose") {
  const body = await readBody(req);
  const { spy, vix, qqq, iwm, sentAt } = body;

  if (!spy || !vix) {
    return sendJSON(res, 400, { ok: false, error: "spy, vix 필수" });
  }

  const data = {
    spy:  Math.round(parseFloat(spy)  * 100) / 100,
    vix:  Math.round(parseFloat(vix)  * 100) / 100,
    qqq:  qqq ? Math.round(parseFloat(qqq) * 100) / 100 : null,
    iwm:  iwm ? Math.round(parseFloat(iwm) * 100) / 100 : null,
    date: getTodayET(),
    ts:   sentAt ?? new Date().toISOString(),
  };

  // _cache 즉시 적용
  _cache.spy.prevClose = data.spy;
  _cache.vix.prevClose = data.vix;
  if (data.qqq) _cache.qqq.prevClose = data.qqq;
  if (data.iwm) _cache.iwm.prevClose = data.iwm;

  // KV 저장 (비동기)
  savePrevClose(data).catch(e => console.error('[prevClose] KV 저장 실패:', e.message));

  console.log(`[prevClose] Google Sheets 수신: SPY=${data.spy} VIX=${data.vix} QQQ=${data.qqq} IWM=${data.iwm}`);
  return sendJSON(res, 200, { ok: true, spy: data.spy, vix: data.vix, qqq: data.qqq, iwm: data.iwm });
}

// ── POST /webhook/tradingview ────────────────────────────────────
// TradingView Alert → SPY / QQQ / IWM / VIX / VOLD 수신 → _cache 갱신 → KV 저장
// payload 구조: { spy:{price, prev}, qqq:{price, prev}, iwm:{price, prev}, vix:{price, prev}, vold, time }
if (req.method === "POST" && req.url === "/webhook/tradingview") {
  const body = await readBody(req);

  // 필수 필드 검증
  if (body.spy == null && body.vix == null) {
    return sendJSON(res, 400, { ok: false, error: "spy 또는 vix 값이 필요합니다." });
  }

  // 심볼별 가격 갱신 헬퍼 (flat 구조: price + prev 별도 필드)
  const updatePrice = (cacheKey, price, prev) => {
    const p = parseFloat(price);
    if (isNaN(p) || p <= 0) return;
    const prevClose = parseFloat(prev) || _cache[cacheKey]?.prevClose || null;
    const change    = prevClose != null ? Math.round((p - prevClose) * 100) / 100 : null;
    const changePct = prevClose != null ? Math.round((p - prevClose) / prevClose * 10000) / 100 : null;
    _cache[cacheKey] = { ..._cache[cacheKey], price: p, prevClose, change, changePct };
    console.log(`[webhook] ${cacheKey.toUpperCase()}: $${p} prev=$${prevClose} (${changePct ?? '?'}%)`);
  };

  const { spy, spy_prev, qqq, qqq_prev, iwm, iwm_prev, vix, vix_prev, vold, time } = body;

  updatePrice('spy', spy, spy_prev);
  updatePrice('qqq', qqq, qqq_prev);
  updatePrice('iwm', iwm, iwm_prev);
  updatePrice('vix', vix, vix_prev);

  // VOLD 갱신 (USI:VOLD — 부호 있는 누적값, 0 제외)
  if (vold != null) {
    const v = parseFloat(vold);
    if (!isNaN(v) && v !== 0) {
      _cache.vold = v;
      console.log(`[webhook] VOLD: ${v}`);
    }
  }

  _cache._lastWebhookTs = time ?? new Date().toISOString();

  // KV 즉시 저장 (비동기, 응답 블로킹 안 함)
  saveSnapshot().catch(e => console.error('[webhook] saveSnapshot 실패:', e.message));

  return sendJSON(res, 200, {
    ok:        true,
    spy:       { price: _cache.spy.price, changePct: _cache.spy.changePct },
    qqq:       { price: _cache.qqq?.price, changePct: _cache.qqq?.changePct },
    iwm:       { price: _cache.iwm?.price, changePct: _cache.iwm?.changePct },
    vix:       { price: _cache.vix.price, changePct: _cache.vix.changePct },
    vold:      _cache.vold,
    ts:        _cache._lastWebhookTs,
  });
}

// ── POST /calculate ──────────────────────────────────────────────
if (req.method === "POST" && req.url === "/calculate") {
const auth = req.headers["x-cron-secret"];
if (CRON_SECRET && auth !== CRON_SECRET) {
res.writeHead(401);
return res.end("Unauthorized");
}
try {
console.log(`[${new Date().toISOString()}] /calculate 시작`);
const result = await calculateAndStore();
return sendJSON(res, 200, { ok: true, date: result.date, updated_at: result.updated_at });
} catch (err) {
console.error("calculateAndStore error:", err);
return sendJSON(res, 500, { ok: false, error: err.message });
}
}

// ── GET /etf-holdings/:ticker ─────────────────────────────────────
// CF Worker IP는 Yahoo에서 차단 → Railway에서 직접 호출
const etfMatch = req.url.match(/^\/etf-holdings\/([A-Z0-9.-]+)$/i);
if (req.method === "GET" && etfMatch) {
const auth = req.headers["x-cron-secret"];
if (CRON_SECRET && auth !== CRON_SECRET) {
res.writeHead(401);
return res.end("Unauthorized");
}

const ticker = etfMatch[1].toUpperCase();
try {
  const holdings = await fetchETFHoldings(ticker);
  return sendJSON(res, 200, { etf: ticker, holdings });
} catch (err) {
  console.error(`[ETF] ${ticker} 조회 실패:`, err.message);
  return sendJSON(res, 502, { error: err.message });
}

}

// ── POST /rescore (deprecated — screener v3에서 제거됨) ─────────

// ── GET /watchlist-scan-status ────────────────────────────────────
if (req.method === "GET" && req.url === "/watchlist-scan-status") {
  return sendJSON(res, 200, {
    running:  watchlistScanState.running,
    progress: watchlistScanState.progress,
    last_run: watchlistScanState.lastRun,
  });
}

// ── POST /scan-watchlist ─────────────────────────────────────────
// watchlist.is_watchlist=FALSE 후보 스캔 → Call Wall 통과 시 승격
if (req.method === "POST" && req.url === "/scan-watchlist") {
  const auth = req.headers["x-cron-secret"];
  if (CRON_SECRET && auth !== CRON_SECRET) {
    res.writeHead(401);
    return res.end("Unauthorized");
  }

  if (watchlistScanState.running) {
    return sendJSON(res, 409, {
      ok:    false,
      error: "watchlist 스캔이 이미 진행 중입니다.",
      progress: watchlistScanState.progress,
    });
  }

  // 즉시 202 응답 후 백그라운드 실행
  watchlistScanState = {
    running:   true,
    startedAt: new Date().toISOString(),
    progress:  { done: 0, total: 0, promoted: 0, errors: 0 },
    lastRun:   watchlistScanState.lastRun,
  };

  sendJSON(res, 202, {
    ok:         true,
    accepted:   true,
    message:    "watchlist 스캔 시작. /watchlist-scan-status 로 진행상황 확인.",
    started_at: watchlistScanState.startedAt,
  });

  // 백그라운드 스캔 실행
  (async () => {
    try {
      const result = await runWatchlistScan(
        CF_WORKER_URL,
        CRON_SECRET,
        ({ done, total, promoted, errors }) => {
          watchlistScanState.progress = { done, total, promoted, errors };
        }
      );

      watchlistScanState = {
        running:   false,
        startedAt: null,
        progress:  null,
        lastRun: {
          date:     getTodayET(),
          ok:       result.ok,
          scanned:  result.scanned,
          promoted: result.promoted,
          errors:   result.errors,
          promoted_list: result.promotedList?.slice(0, 20) ?? [],
          ts:       new Date().toISOString(),
        },
      };

      console.log(
        `[watchlist scan] 완료 — 스캔 ${result.scanned}개, 승격 ${result.promoted}개, 오류 ${result.errors}개`
      );

      // 트리거 1: 스캔 완료 후 is_watchlist 동기화
      try {
        await fetch(`${CF_WORKER_URL}/api/watchlist/sync-is-watchlist`, {
          method:  'POST',
          headers: { 'x-cron-secret': CRON_SECRET },
          signal:  AbortSignal.timeout(8000),
        });
      } catch (e) {
        console.warn('[watchlist scan] is_watchlist 동기화 실패 (계속 진행):', e.message);
      }

      // 트리거 2: 전체 스캔 완료 후 기준 미달 종목 자동 정리
      try {
        const pruneResult = await pruneWatchlistGroup(CF_WORKER_URL, CRON_SECRET);
        console.log(`[watchlist scan] prune 완료 — 제거 ${pruneResult.removed.length}개`);
      } catch (e) {
        console.warn('[watchlist scan] prune 실패 (계속 진행):', e.message);
      }
    } catch (err) {
      console.error("[watchlist scan] 치명적 오류:", err.message);
      watchlistScanState = {
        running:   false,
        startedAt: null,
        progress:  null,
        lastRun: {
          date:  getTodayET(),
          ok:    false,
          error: err.message,
          ts:    new Date().toISOString(),
        },
      };
    }
  })();

  return;
}

// ── POST /collect-screener ───────────────────────────────────────
// body: { symbols: [{symbol, name, type, sector, sector_etf}], force?: boolean }
if (req.method === "POST" && req.url === "/collect-screener") {
const auth = req.headers["x-cron-secret"];
if (CRON_SECRET && auth !== CRON_SECRET) {
res.writeHead(401);
return res.end("Unauthorized");
}

if (collectState.running) {
  return sendJSON(res, 409, {
    ok: false,
    error: "수집이 이미 진행 중입니다.",
    progress: collectState.progress,
  });
}

const body = await readBody(req);
const { symbols, force = false } = body;

if (!Array.isArray(symbols) || !symbols.length) {
  return sendJSON(res, 400, { ok: false, error: "symbols 배열이 필요합니다." });
}

const date = getTodayET();

// force=false: 이미 수집된 날짜면 스킵 안내 후 수집 실행
// (이미 오늘 수집됐는지는 CF Worker의 D1 쿼리로 확인 -- 여기선 lastRun 메모리로 판단)
if (!force && collectState.lastRun?.date === date && collectState.lastRun?.ok) {
  return sendJSON(res, 200, {
    ok:       false,
    skipped:  true,
    date,
    message:  `오늘(${date}) 이미 수집 완료됐습니다. force=true로 강제 수집 가능합니다.`,
    last_run: collectState.lastRun,
  });
}

// 비동기 수집 시작 (응답 즉시 반환, 백그라운드 실행)
collectState = {
  running:   true,
  startedAt: new Date().toISOString(),
  progress:  { done: 0, total: symbols.length, errors: 0 },
  lastRun:   collectState.lastRun,
};

// 응답 먼저 반환
sendJSON(res, 202, {
  ok:         true,
  accepted:   true,
  date,
  total:      symbols.length,
  message:    `${symbols.length}개 종목 수집 시작. /screener-status 로 진행상황 확인.`,
  started_at: collectState.startedAt,
});

// 백그라운드 수집 실행
runCollect(symbols, date).catch(e => console.error('[collect-screener] error:', e.message));

return;

}

// ── GET /analyze-symbol ───────────────────────────────────────────
// 일회성 실시간 조회 — D1 저장 없이 결과만 반환
// structure.js에서 저장되지 않은 종목 조회 시 사용
if (req.method === "GET" && req.url.startsWith("/analyze-symbol")) {
  const urlObj = new URL(req.url, `http://localhost`);
  const symbol = urlObj.searchParams.get("symbol")?.toUpperCase();

  if (!symbol) {
    sendJSON(res, 400, { error: "symbol 파라미터 필요" });
    return;
  }

  try {
    sendJSON(res, 200, { ok: true, symbol, status: "collecting" });

    // 이미 응답 전송 후 계산 불가 — 동기식으로 처리
  } catch (err) {
    sendJSON(res, 500, { ok: false, error: err.message });
    return;
  }
}

// ── POST /analyze-symbol ──────────────────────────────────────────
// 일회성 실시간 조회 — collectSymbol + analyzeSymbol 동시 실행
if (req.method === "POST" && req.url === "/analyze-symbol") {
  const auth = req.headers["x-cron-secret"];
  if (CRON_SECRET && auth !== CRON_SECRET) {
    sendJSON(res, 401, { error: "Unauthorized" });
    return;
  }

  let body = {};
  try {
    const raw = await new Promise((resolve, reject) => {
      let d = '';
      req.on('data', c => d += c);
      req.on('end', () => resolve(d));
      req.on('error', reject);
    });
    body = JSON.parse(raw || '{}');
  } catch { body = {}; }

  const symbol = body.symbol?.toUpperCase();
  const save   = body.save === true;
  if (!symbol) {
    sendJSON(res, 400, { error: "symbol 필요" });
    return;
  }

  try {
    const date = getTodayET();

    const [collectResult, analyzeResult] = await Promise.allSettled([
      collectSymbol(symbol, date),
      analyzeSymbol(symbol),
    ]);

    const collected = collectResult.status === 'fulfilled' ? collectResult.value : null;
    const analyzed  = analyzeResult.status  === 'fulfilled' ? analyzeResult.value  : null;

    if (!collected && !analyzed) {
      sendJSON(res, 404, { ok: false, error: `${symbol} 데이터를 가져올 수 없습니다` });
      return;
    }

    // save:true 면 DB에도 저장
    if (save && analyzed) {
      const { rows, callWall, upside, squeeze, spot } = analyzed;
      const updatedAt = new Date().toISOString();
      try {
        await saveSymbolRows(CF_WORKER_URL, CRON_SECRET, symbol, rows, updatedAt);
        await updateScreenedTicker(CF_WORKER_URL, CRON_SECRET, symbol, spot, callWall, upside, rows, squeeze);
      } catch (e) {
        console.warn(`[analyze-symbol] ${symbol} DB 저장 실패:`, e.message);
      }
    }

    sendJSON(res, 200, {
      ok: true,
      symbol,
      date,
      // screener 카드용
      spot_price:   analyzed?.spot_price   ?? collected?.spot ?? null,
      net_gex:      analyzed?.net_gex      ?? null,
      flip_strike:  analyzed?.flip_strike  ?? null,
      upside:       analyzed?.upside       ?? null,
      atm_iv:       analyzed?.atm_iv       ?? null,
      // structure 탭용 (히트맵/텀스트럭처)
      rows:        collected?.rows        ?? [],
      strikeRows:  collected?.strikeRows  ?? [],
    });

  } catch (err) {
    console.error(`[analyze-symbol] ${symbol} 오류:`, err.message);
    sendJSON(res, 500, { ok: false, error: err.message });
  }

  return;
}

res.writeHead(404);
res.end("Not found");
});

// ─────────────────────────────────────────────────────────────────
// 시작
// ─────────────────────────────────────────────────────────────────
/* server.listen(PORT, () => {
console.log(`DexBoard Railway service listening on port ${PORT}`);
}); */
// ============================================
// ETF 구성종목 조회 (Yahoo Finance)
// Railway 서버에서 직접 호출 -- CF Worker IP 우회
// ============================================
async function fetchETFHoldings(ticker) {
// ── 시도 1: Yahoo Finance v1 quoteSummary
try {
const url = `https://query1.finance.yahoo.com/v1/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=topHoldings`;
const res = await fetch(url, {
headers: {
'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
'Accept': 'application/json',
'Accept-Language': 'en-US,en;q=0.9',
},
signal: AbortSignal.timeout(10000),
});

if (res.ok) {
  const data     = await res.json();
  const holdings = data?.quoteSummary?.result?.[0]?.topHoldings?.holdings ?? [];
  if (holdings.length > 0) {
    console.log(`[ETF] ${ticker}: Yahoo v1 성공 (${holdings.length}개)`);
    return holdings.map(h => ({
      symbol: h.symbol,
      name:   h.holdingName,
      pct:    h.holdingPercent ? +(h.holdingPercent * 100).toFixed(2) : null,
    }));
  }
}
console.warn(`[ETF] ${ticker}: Yahoo v1 실패 (${res.status}), v10 시도`);

} catch (e) {
console.warn(`[ETF] ${ticker}: Yahoo v1 오류 (${e.message}), v10 시도`);
}

// ── 시도 2: Yahoo Finance v10
try {
const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=topHoldings`;
const res = await fetch(url, {
headers: {
'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
'Accept': 'application/json',
},
signal: AbortSignal.timeout(10000),
});

if (res.ok) {
  const data     = await res.json();
  const holdings = data?.quoteSummary?.result?.[0]?.topHoldings?.holdings ?? [];
  if (holdings.length > 0) {
    console.log(`[ETF] ${ticker}: Yahoo v10 성공 (${holdings.length}개)`);
    return holdings.map(h => ({
      symbol: h.symbol,
      name:   h.holdingName,
      pct:    h.holdingPercent ? +(h.holdingPercent * 100).toFixed(2) : null,
    }));
  }
}
console.warn(`[ETF] ${ticker}: Yahoo v10 실패 (${res.status})`);

} catch (e) {
console.warn(`[ETF] ${ticker}: Yahoo v10 오류 (${e.message})`);
}

throw new Error(`${ticker} ETF 구성종목을 가져올 수 없습니다 (Yahoo Finance 차단 또는 데이터 없음)`);
}

server.listen(PORT, '0.0.0.0', () => {
console.log(`DexBoard Railway service listening on port ${PORT}`);
startScheduler();
});

// ─────────────────────────────────────────────────────────────────
// 시장 시간 유틸 (ET 기준)
// ─────────────────────────────────────────────────────────────────
function getETHour() {
const etStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
return new Date(etStr).getHours();
}

function getETDay() {
const etStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
return new Date(etStr).getDay(); // 0=일, 1=월 ... 5=금, 6=토
}

function isWeekday() {
const day = getETDay();
return day >= 1 && day <= 5;
}

function isRegularSession() {
return getMarketSession() === 'REGULAR';
}

function getMarketSession() {
if (!isWeekday()) return 'CLOSED';
const etStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
const etDate = new Date(etStr);
const h = etDate.getHours();
const m = etDate.getMinutes();
if (h >= 4  && h < 9)               return 'PRE';      // 04:00~08:59
if (h === 9 && m < 30)              return 'PRE';      // 09:00~09:29
if ((h === 9 && m >= 30) || (h >= 10 && h < 16)) return 'REGULAR'; // 09:30~15:59
if (h >= 16 && h < 20)              return 'AFTER';    // 16:00~19:59
if (h >= 20 && h < 24)              return 'AFTER';    // 20:00~23:59
return 'CLOSED';
}

// ─────────────────────────────────────────────────────────────────
// Yahoo Finance → CF KV 스냅샷 저장
// ─────────────────────────────────────────────────────────────────
const YAHOO_BASE = process.env.YAHOO_BASE || 'https://query1.finance.yahoo.com/v8/finance/chart';

async function fetchYahoo(symbol) {
const url = `${YAHOO_BASE}/${symbol}?interval=1m&range=1d`;
const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
if (!res.ok) throw new Error(`Yahoo ${symbol}: ${res.status}`);
const data = await res.json();
const result = data?.chart?.result?.[0];
if (!result) throw new Error(`Yahoo ${symbol}: no result`);
const timestamps = result.timestamp ?? [];
const quotes     = result.indicators?.quote?.[0]?.close ?? [];
const price      = quotes.filter(Boolean).pop();
if (!price) throw new Error(`Yahoo ${symbol}: no close data`);

// 전날 종가(prevClose) -- interval=1d&range=2d로 별도 조회
let prevClose = null;
const dayRes = await fetch(`${YAHOO_BASE}/${symbol}?interval=1d&range=2d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
if (dayRes.ok) {
const dayData  = await dayRes.json();
const dayClose = dayData?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
// 마지막에서 두 번째 = 전일 확정 종가 (마지막은 당일 미확정일 수 있음)
const validClose = dayClose.filter(v => v != null);
if (validClose.length >= 2) prevClose = Math.round(validClose[validClose.length - 2] * 100) / 100;
}

const change    = prevClose != null ? Math.round((price - prevClose) * 100) / 100 : null;
const changePct = prevClose != null ? Math.round((price - prevClose) / prevClose * 10000) / 100 : null;
// 1분봉 시리즈 (VIX 차트용)
const series = timestamps
.map((ts, i) => ({ ts: new Date(ts * 1000).toISOString(), v: quotes[i] }))
.filter(d => d.v != null);
return { price: Math.round(price * 100) / 100, change, changePct, prevClose, series };
}

// ─────────────────────────────────────────────────────────────────
// 스냅샷 메모리 캐시 (정규장 30초 루프용)
// SPY: Twelve Data 30초, VIX: Yahoo 1분 -- 각자 독립 갱신, KV는 30초마다 합산 저장
// ─────────────────────────────────────────────────────────────────
const _cache = {
spy:  { price: null, change: null, changePct: null, prevClose: null },
qqq:  { price: null, change: null, changePct: null, prevClose: null },
iwm:  { price: null, change: null, changePct: null, prevClose: null },
vix:  { price: null, change: null, changePct: null, prevClose: null, series: [] },
vold: null,           // TradingView 웹훅 수신값 (USI:VOLD)
_lastWebhookTs: null, // 마지막 웹훅 수신 시각 (ISO)
};

// VIX 현재가 -- Yahoo Finance (1분)
async function fetchVixYahoo() {
try {
const data = await fetchYahoo('%5EVIX');
_cache.vix = {
price:     data.price,
change:    data.change,
changePct: data.changePct,
prevClose: data.prevClose,
series:    data.series ?? [],
};
console.log(`[vix] Yahoo: ${data.price} (${data.changePct}%)`);
} catch (e) {
console.warn('[vix] Yahoo 실패 (직전값 유지):', e.message);
}
}

// ─────────────────────────────────────────────────────────────────
// prevClose 관리
// ─────────────────────────────────────────────────────────────────

// KV에서 prevClose 읽기
async function loadPrevClose() {
try {
  const res = await fetch(`${CF_WORKER_URL}/kv-read?key=snapshot%3Aprevclose`, {
    headers: { 'x-kv-secret': CF_KV_SECRET },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.value) return null;
  return JSON.parse(data.value);
} catch (e) {
  console.warn('[prevClose] KV 읽기 실패:', e.message);
  return null;
}
}

// KV에 prevClose 저장
async function savePrevClose(data) {
try {
  await fetch(`${CF_WORKER_URL}/kv-write`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-kv-secret': CF_KV_SECRET },
    body:    JSON.stringify({ key: 'snapshot:prevclose', value: JSON.stringify(data) }),
    signal:  AbortSignal.timeout(5000),
  });
  console.log(`[prevClose] KV 저장 완료: SPY=${data.spy} QQQ=${data.qqq} IWM=${data.iwm} VIX=${data.vix} date=${data.date}`);
} catch (e) {
  console.warn('[prevClose] KV 저장 실패:', e.message);
}
}

// 초기화: KV 읽기 → 없으면 Yahoo 조회
async function initPrevClose() {
const kv = await loadPrevClose();
if (kv) {
  _cache.spy.prevClose = kv.spy;
  _cache.qqq.prevClose = kv.qqq;
  _cache.iwm.prevClose = kv.iwm;
  _cache.vix.prevClose = kv.vix;
  console.log(`[prevClose] KV 로드: SPY=${kv.spy} date=${kv.date}`);
} else {
  console.log('[prevClose] KV 없음 — Google Sheets 웹훅 대기 중');
}
}

// KV 저장 -- _cache 합산 → snapshot:1min (현재값) + ts:market (링버퍼)
async function saveSnapshot() {
if (!_cache.spy.price && !_cache.vix.price) return;
try {
const ts = new Date().toISOString();
const snapshot = {
spy:  _cache.spy,
qqq:  _cache.qqq,
iwm:  _cache.iwm,
vix:  _cache.vix,
vold: _cache.vold,
ts,
};

// 1. 현재값 덮어쓰기 (기존)
await fetch(`${CF_WORKER_URL}/kv-write`, {
method:  'POST',
headers: { 'Content-Type': 'application/json', 'x-kv-secret': CF_KV_SECRET },
body:    JSON.stringify({ key: 'snapshot:1min', value: JSON.stringify(snapshot) }),
signal:  AbortSignal.timeout(5000),
});

// 2. 링버퍼 누적 (당일 시계열 최대 780개)
try {
  const bufRes = await fetch(`${CF_WORKER_URL}/kv-read?key=ts%3Amarket`, {
    headers: { 'x-kv-secret': CF_KV_SECRET },
    signal: AbortSignal.timeout(4000),
  });
  let buf = [];
  if (bufRes.ok) {
    const bufData = await bufRes.json();
    if (bufData.value) buf = JSON.parse(bufData.value);
  }
  buf.push({
    ts,
    spy:  _cache.spy.price,
    qqq:  _cache.qqq?.price ?? null,
    iwm:  _cache.iwm?.price ?? null,
    vix:  _cache.vix.price,
    vold: _cache.vold ?? null,
  });
  if (buf.length > 780) buf = buf.slice(buf.length - 780);
  await fetch(`${CF_WORKER_URL}/kv-write`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-kv-secret': CF_KV_SECRET },
    body:    JSON.stringify({ key: 'ts:market', value: JSON.stringify(buf) }),
    signal:  AbortSignal.timeout(5000),
  });
} catch (bufErr) {
  console.warn('[snapshot] 링버퍼 저장 실패 (현재값은 저장됨):', bufErr.message);
}

console.log(`[snapshot] saved SPY=${_cache.spy.price} VIX=${_cache.vix.price} VOLD=${_cache.vold}`);
} catch (e) {
console.error('[snapshot] KV 저장 실패:', e.message);
}
}

// PRE/AFTER -- Yahoo SPY+VIX 묶음 (기존 방식 유지)
async function fetchSnapshot() {
try {
const [spy, vix] = await Promise.all([
fetchYahoo('SPY'),
fetchYahoo('%5EVIX'),
]);
_cache.spy = { price: spy.price, change: spy.change, changePct: spy.changePct, prevClose: spy.prevClose };
_cache.vix = { price: vix.price, change: vix.change, changePct: vix.changePct, prevClose: vix.prevClose, series: vix.series ?? [] };
await saveSnapshot();
} catch (e) {
console.error('[snapshot] error:', e.message);
}
}

async function saveSnapshotOpen() {
try {
// 현재 snapshot:1min을 options:spy:open으로 복사
const res = await fetch(`${CF_WORKER_URL}/api/snapshot`);
if (!res.ok) return;
const snap = await res.json();
if (!snap?.spy) return;
await fetch(`${CF_WORKER_URL}/kv-write`, {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-kv-secret': CF_KV_SECRET },
body: JSON.stringify({ key: 'options:spy:open', value: JSON.stringify({ ...snap, saved_at: new Date().toISOString() }) }),
signal: AbortSignal.timeout(5000),
});
console.log('[snapshotOpen] saved opening snapshot');
} catch (e) {
console.error('[snapshotOpen] error:', e.message);
}
}

// ─────────────────────────────────────────────────────────────────
// 스크리너 백그라운드 수집 (HTTP 핸들러·스케줄러 공용)
// ─────────────────────────────────────────────────────────────────
// BB맵 종목 가격 지표 일괄 수집
async function collectBbMapIndicators() {
  const res = await fetch(`${CF_WORKER_URL}/api/bb-map-symbols`, {
    headers: { 'x-cron-secret': CRON_SECRET },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`bb-map-symbols: ${res.status}`);
  const data = await res.json();
  const symbols = (data.symbols ?? data ?? []).map(s => s.symbol ?? s);
  if (!symbols.length) { console.warn('[BB맵] 대상 심볼 없음'); return; }

  console.log(`[BB맵] ${symbols.length}개 종목 가격 지표 수집 시작`);
  let ok = 0, fail = 0;
  for (const sym of symbols) {
    try {
      await collectPriceIndicators(sym, CF_WORKER_URL, CRON_SECRET);
      ok++;
    } catch (e) {
      console.warn(`[BB맵] ${sym} 실패:`, e.message);
      fail++;
    }
  }
  console.log(`[BB맵] 완료 — 성공: ${ok}, 실패: ${fail}`);
}

async function runCollect(symbols, date) {
  try {
    // 심볼 배열 정규화 (문자열 또는 객체 모두 허용)
    const symList = symbols.map(s => (typeof s === 'string' ? s : s.symbol));

    const result = await runScreenerCollection(
      CF_WORKER_URL,
      CRON_SECRET,
      symList,
      // 진행상황 콜백 → collectState 실시간 업데이트
      ({ done, total, errors }) => {
        collectState.progress = { done, total, errors };
      }
    );

    collectState = {
      running:   false,
      startedAt: null,
      progress:  null,
      lastRun: {
        date,
        ok:         result.ok,
        count:      result.count,
        errors:     result.errors,
        error_list: result.errorList?.slice(0, 10) ?? [],
        ts:         new Date().toISOString(),
      },
    };

    console.log(`[Screener] 완료 -- 성공: ${result.count}, 실패: ${result.errors}`);

    // 트리거 1: 수집 완료 후 is_watchlist 동기화
    try {
      await fetch(`${CF_WORKER_URL}/api/watchlist/sync-is-watchlist`, {
        method:  'POST',
        headers: { 'x-cron-secret': CRON_SECRET },
        signal:  AbortSignal.timeout(8000),
      });
      console.log('[Screener] is_watchlist 동기화 완료');
    } catch (e) {
      console.warn('[Screener] is_watchlist 동기화 실패 (계속 진행):', e.message);
    }

    // 트리거 2: 매일 수집 후 기준 미달 종목 자동 정리
    try {
      const pruneResult = await pruneWatchlistGroup(CF_WORKER_URL, CRON_SECRET);
      console.log(`[Screener] prune 완료 — 제거 ${pruneResult.removed.length}개`);
    } catch (e) {
      console.warn('[Screener] prune 실패 (계속 진행):', e.message);
    }

    // 트리거 3: BB맵 종목 가격 지표 수집
    try {
      await collectBbMapIndicators();
    } catch (e) {
      console.warn('[Screener] BB맵 수집 실패 (계속 진행):', e.message);
    }

    // 트리거 4: 커버드콜 활성 종목 수 스냅샷 저장
    try {
      const countRes = await fetch(`${CF_WORKER_URL}/api/screener/market-snapshot`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
        body:    JSON.stringify({ count: result.count }),
        signal:  AbortSignal.timeout(8000),
      });
      const countData = await countRes.json();
      console.log(`[Screener] market-snapshot 저장 완료 — ${countData.old} → ${countData.new} (${countData.direction})`);
    } catch (e) {
      console.warn('[Screener] market-snapshot 저장 실패 (계속 진행):', e.message);
    }

  } catch (err) {
    console.error("[Screener] 수집 중 치명적 오류:", err.message);
    collectState = {
      running:   false,
      startedAt: null,
      progress:  null,
      lastRun: {
        date,
        ok:    false,
        error: err.message,
        ts:    new Date().toISOString(),
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// 스케줄러
// ─────────────────────────────────────────────────────────────────
function startScheduler() {
let lastSession  = null;
let screenerDone = false;  // 당일 스크리너 수집 여부
let openDone     = false;  // 당일 장 시작 스냅샷 여부
let livePriceDone = false; // 당일 장중 가격 업데이트 여부 (자정 초기화)

// 매일 자정 플래그 초기화
setInterval(() => {
const h = getETHour();
if (h === 0) { screenerDone = false; openDone = false; livePriceDone = false; }
}, 60_000);

// ─────────────────────────────────────────────────────────────────
// 장중 실시간 가격 업데이트
//
// 흐름:
//   1. Yahoo batch quote → screened_tickers 전체 spot_price + upside 갱신
//   2. 돌파 종목(spot > target_strike) → analyzeSymbol() 재실행
//      → saveSymbolRows() + updateScreenedTicker() + rollup-check
//
// 호출 시점: ET 10:00 이후, 5분마다 (1분 루프에서 min % 5 === 0 조건)
// CBOE 보호: 평상시 Yahoo만 호출, 돌파 시에만 CBOE 재조회
// ─────────────────────────────────────────────────────────────────
let _livePriceRunning = false;

async function updateLivePrices() {
  console.log('[livePrices] 실행 시작');
  if (_livePriceRunning) {
    console.log('[livePrices] 이전 실행 중 — 스킵');
    return;
  }
  _livePriceRunning = true;

  try {
    // 1. screened_tickers 전체 종목 + 현재 target_strike 조회
    const symRes = await fetch(`${CF_WORKER_URL}/api/screener/symbols`, {
      headers: { 'x-cron-secret': CRON_SECRET },
      signal:  AbortSignal.timeout(10000),
    });
    if (!symRes.ok) throw new Error(`screener/symbols HTTP ${symRes.status}`);
    const symData = await symRes.json();
    const symbols = (symData.symbols ?? []).map(s => s.symbol ?? s);
    if (!symbols.length) { console.log('[livePrices] 대상 종목 없음 — 스킵'); return; }

    // 2. screened_tickers에서 target_strike + flip_strike 경량 조회
    const stRes = await fetch(`${CF_WORKER_URL}/api/screener/price-targets`, {
      headers: { 'x-cron-secret': CRON_SECRET },
      signal:  AbortSignal.timeout(10000),
    });
    const stData = stRes.ok ? await stRes.json() : {};
    // symbol → { target_strike, flip_strike, spot_price } 맵
    const stMap = {};
    for (const r of (stData.targets ?? [])) {
      stMap[r.symbol] = r;
    }

    // 3. Yahoo batch quote (Railway에서 직접 호출 — CF Worker IP 차단 우회)
    const yahooUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}&fields=regularMarketPrice,marketState`;
    const yahooRes = await fetch(yahooUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(15000),
    });
    if (!yahooRes.ok) throw new Error(`Yahoo HTTP ${yahooRes.status}`);
    const yahooData = await yahooRes.json();
    const quotes = {};
    for (const q of (yahooData?.quoteResponse?.result ?? [])) {
      if (q.symbol && q.regularMarketPrice != null) {
        quotes[q.symbol] = {
          price:       Math.round(q.regularMarketPrice * 100) / 100,
          marketState: q.marketState ?? 'UNKNOWN',
        };
      }
    }

    // 장이 REGULAR가 아닌 경우 (Yahoo marketState 기준) 조기 종료
    const states = Object.values(quotes).map(q => q.marketState);
    const isRegular = states.some(s => s === 'REGULAR');
    if (!isRegular) {
      console.log('[livePrices] 정규장 아님 — 스킵');
      return;
    }

    console.log(`[livePrices] ${symbols.length}개 종목 가격 업데이트 시작`);

    const breached = []; // 돌파 종목
    const updatedAt = new Date().toISOString();

    for (const sym of symbols) {
      const q = quotes[sym];
      if (!q?.price) continue;

      const newSpot     = q.price;
      const st          = stMap[sym];
      const targetStrike = st?.target_strike ?? null;
      const flipStrike   = st?.flip_strike   ?? null;

      // upside 재계산
      const upside = (targetStrike && newSpot)
        ? Math.round(((targetStrike - newSpot) / newSpot) * 10000) / 100
        : null;

      // spot_price + upside만 업데이트 (옵션 구조는 건드리지 않음)
      try {
        await fetch(`${CF_WORKER_URL}/d1/screened-tickers/spot-price`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
          body: JSON.stringify({ ticker: sym, spot_price: newSpot, upside }),
          signal: AbortSignal.timeout(8000),
        });
      } catch (e) {
        console.warn(`[livePrices] ${sym} spot 업데이트 실패:`, e.message);
      }

      // 돌파 감지: 새 현재가가 목표가(Call Wall)를 넘었을 때
      if (targetStrike && newSpot > targetStrike) {
        breached.push({ sym, newSpot, targetStrike });
      }
    }

    console.log(`[livePrices] 가격 업데이트 완료 — 돌파 종목: ${breached.length}개`);

    // 4. 돌파 종목 → CBOE 재조회 + 전체 갱신 + rollup-check
    for (const { sym, newSpot, targetStrike } of breached) {
      console.log(`[livePrices] 돌파 감지: ${sym} (현재가 $${newSpot} > 목표가 $${targetStrike}) → CBOE 재조회`);
      try {
        const result = await analyzeSymbol(sym);
        const { rows, callWall, upside: newUpside, squeeze, spot } = result;

        await saveSymbolRows(CF_WORKER_URL, CRON_SECRET, sym, rows, updatedAt);
        await updateScreenedTicker(CF_WORKER_URL, CRON_SECRET, sym, spot, callWall, newUpside, rows, squeeze);

        // rollup-check (target_strike 변경 여부 → rollup_history 기록)
        if (callWall.target_strike) {
          const res = await fetch(`${CF_WORKER_URL}/api/screener/rollup-check`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
            body:    JSON.stringify({ ticker: sym, new_strike: callWall.target_strike, new_spot: spot }),
            signal:  AbortSignal.timeout(8000),
          });
          const data = await res.json();
          if (data.changed) {
            console.log(`[livePrices] 롤업: ${sym} $${data.old_strike} → $${data.new_strike} (${data.direction})`);
          }
        }

        // CBOE 부하 분산
        await sleep(1500 + Math.random() * 500);
      } catch (e) {
        console.warn(`[livePrices] ${sym} CBOE 재조회 실패:`, e.message);
      }
    }

  } catch (err) {
    console.error('[livePrices] 오류:', err.message);
  } finally {
    _livePriceRunning = false;
  }
}

// 1분마다 세션 체크 → 폴링 주기 동적 조정
let snapshotTimer = null;

function scheduleSnapshot() {
if (snapshotTimer) clearInterval(snapshotTimer);

const session = getMarketSession();

if (session === 'CLOSED') {
  console.log('[scheduler] CLOSED -- snapshot 중지');
  snapshotTimer = null;
  return;
}

if (session === 'REGULAR') {
  // ── REGULAR: TradingView 웹훅 수신 대기 (1분봉 Alert)
  // SPY / VIX / VOLD 는 /webhook/tradingview 로 수신됨
  // 웹훅이 끊겼을 때를 대비해 5분 무수신 시 Yahoo fallback 실행
  console.log('[scheduler] REGULAR -- TradingView 웹훅 대기 중 (fallback: Yahoo 5분)');

  // 즉시 1회 Yahoo fallback (서버 재시작 직후 _cache가 비어 있을 수 있음)
  fetchSnapshot();

  // 5분마다 웹훅 수신 여부 확인 → 미수신 시 Yahoo fallback
  snapshotTimer = setInterval(async () => {
    const lastTs  = _cache._lastWebhookTs ? new Date(_cache._lastWebhookTs).getTime() : 0;
    const staleSec = (Date.now() - lastTs) / 1000;
    if (staleSec > 5 * 60) {
      console.warn(`[scheduler] 웹훅 ${Math.round(staleSec / 60)}분 미수신 → Yahoo fallback`);
      await fetchSnapshot();
    }
  }, 5 * 60_000);

} else {
  // ── PRE / AFTER: TradingView 웹훅 수신 대기 (REGULAR와 동일)
  // 웹훅이 끊겼을 때를 대비해 5분 무수신 시 Yahoo fallback
  console.log(`[scheduler] ${session} -- TradingView 웹훅 대기 중 (fallback: Yahoo 5분)`);

  // 즉시 1회 Yahoo fallback (서버 재시작 직후 _cache가 비어 있을 수 있음)
  fetchSnapshot();

  // 5분마다 웹훅 수신 여부 확인 → 미수신 시 Yahoo fallback
  snapshotTimer = setInterval(async () => {
    const lastTs   = _cache._lastWebhookTs ? new Date(_cache._lastWebhookTs).getTime() : 0;
    const staleSec = (Date.now() - lastTs) / 1000;
    if (staleSec > 5 * 60) {
      console.warn(`[scheduler] 웹훅 ${Math.round(staleSec / 60)}분 미수신 → Yahoo fallback`);
      await fetchSnapshot();
    }
  }, 5 * 60_000);
}

}

// 세션 변화 감지 (1분마다)
setInterval(() => {
const session = getMarketSession();
const h = getETHour();

if (session !== lastSession) {
  console.log(`[scheduler] 세션 변경: ${lastSession} → ${session}`);
  lastSession = session;
  scheduleSnapshot();

  // 장 시작(REGULAR 첫 진입) → snapshotOpen
  if (session === 'REGULAR' && !openDone) {
    openDone = true;
    saveSnapshotOpen();
  }

  // ET 17:30 — 스크리너 수집 자동 실행
  if (isWeekday() && h === 17 && new Date().getMinutes() === 30 && !screenerDone) {
    screenerDone = true;
    savePrevClose({
      spy:  _cache.spy.price,
      qqq:  _cache.qqq?.price ?? null,
      iwm:  _cache.iwm?.price ?? null,
      vix:  _cache.vix.price,
      date: getTodayET(),
      ts:   new Date().toISOString(),
    }).catch(e => console.error('[prevClose] 저장 실패:', e.message));
    console.log('[scheduler] ET 17:30 → 스크리너 수집 트리거');

    (async () => {
      try {
        const symRes = await fetch(`${CF_WORKER_URL}/api/screener/symbols`, {
          headers: { 'x-cron-secret': CRON_SECRET },
          signal: AbortSignal.timeout(10000),
        });
        if (!symRes.ok) throw new Error(`screener/symbols: ${symRes.status}`);
        const symData = await symRes.json();
        const symbols = (symData.symbols ?? []).map(s => s.symbol ?? s);

        if (!symbols.length) {
          console.warn('[scheduler] 수집 대상 심볼 없음 -- 스크리너 수집 생략');
          return;
        }

        console.log(`[scheduler] ${symbols.length}개 심볼 수집 시작`);
        if (collectState.running) {
          console.warn('[scheduler] 수집 이미 진행 중 -- 스킵');
          return;
        }
        const date = getTodayET();
        collectState = {
          running:   true,
          startedAt: new Date().toISOString(),
          progress:  { done: 0, total: symbols.length, errors: 0 },
          lastRun:   collectState.lastRun,
        };
        runCollect(symbols, date).catch(e => console.error('[scheduler] collect error:', e.message));
      } catch (e) {
        console.error('[scheduler] screener trigger error:', e.message);
      }
    })();
  }

  // 장 마감(AFTER 첫 진입) → prevClose 저장만
  if (session === 'AFTER' && !screenerDone) {
    screenerDone = true;
    savePrevClose({
      spy:  _cache.spy.price,
      qqq:  _cache.qqq?.price ?? null,
      iwm:  _cache.iwm?.price ?? null,
      vix:  _cache.vix.price,
      date: getTodayET(),
      ts:   new Date().toISOString(),
    }).catch(e => console.error('[prevClose] 장 마감 저장 실패:', e.message));
    console.log('[scheduler] 장 마감 → prevClose 저장 완료 (수집은 ET 17:30에 처리)');
  }
}  // if (session !== lastSession)

// 평일 ET 18:00 — 전체 watchlist 스캔 자동 실행
if (isWeekday() && h === 18 && new Date().getMinutes() === 0) {
  if (!watchlistScanState.running) {
    console.log('[scheduler] ET 18:00 — 전체 watchlist 스캔 시작');
    watchlistScanState = {
      running:   true,
      startedAt: new Date().toISOString(),
      progress:  { done: 0, total: 0, promoted: 0, errors: 0 },
      lastRun:   watchlistScanState.lastRun,
    };
    (async () => {
      try {
        const result = await runWatchlistScan(
          CF_WORKER_URL,
          CRON_SECRET,
          ({ done, total, promoted, errors }) => {
            watchlistScanState.progress = { done, total, promoted, errors };
          }
        );
        watchlistScanState = {
          running:   false,
          startedAt: null,
          progress:  null,
          lastRun: {
            date:     getTodayET(),
            ok:       result.ok,
            scanned:  result.scanned,
            promoted: result.promoted,
            errors:   result.errors,
            promoted_list: result.promotedList?.slice(0, 20) ?? [],
            ts:       new Date().toISOString(),
          },
        };
        console.log(`[scheduler] watchlist 스캔 완료 — 스캔 ${result.scanned}개, 승격 ${result.promoted}개`);

        // 스캔 완료 후 is_watchlist 동기화
        try {
          await fetch(`${CF_WORKER_URL}/api/watchlist/sync-is-watchlist`, {
            method:  'POST',
            headers: { 'x-cron-secret': CRON_SECRET },
            signal:  AbortSignal.timeout(8000),
          });
        } catch (e) {
          console.warn('[scheduler] is_watchlist 동기화 실패 (계속 진행):', e.message);
        }

        // 스캔 완료 후 기준 미달 종목 자동 정리
        try {
          const pruneResult = await pruneWatchlistGroup(CF_WORKER_URL, CRON_SECRET);
          console.log(`[scheduler] prune 완료 — 제거 ${pruneResult.removed.length}개`);
        } catch (e) {
          console.warn('[scheduler] prune 실패 (계속 진행):', e.message);
        }
      } catch (err) {
        console.error('[scheduler] watchlist 스캔 오류:', err.message);
        watchlistScanState = {
          running:   false,
          startedAt: null,
          progress:  null,
          lastRun: {
            date:  getTodayET(),
            ok:    false,
            error: err.message,
            ts:    new Date().toISOString(),
          },
        };
      }
    })();
  } else {
    console.warn('[scheduler] ET 18:00 watchlist 스캔 — 이미 진행 중, 스킵');
  }
}

// 평일 ET 09:50 — 롤업 감지
if (isWeekday() && h === 9 && new Date().getMinutes() === 50) {
  console.log('[scheduler] ET 09:50 — 롤업 감지 시작');
  (async () => {
    try {
      const symRes = await fetch(`${CF_WORKER_URL}/api/screener/symbols`, {
        headers: { 'x-cron-secret': CRON_SECRET },
        signal: AbortSignal.timeout(10000),
      });
      if (!symRes.ok) throw new Error(`screener/symbols: ${symRes.status}`);
      const symData = await symRes.json();
      const symbols = (symData.symbols ?? []).map(s => s.symbol ?? s);

      if (!symbols.length) { console.warn('[rollup] 대상 심볼 없음 — 스킵'); return; }

      let rolled = 0;
      for (const sym of symbols) {
        try {
          const result = await analyzeSymbol(sym);
          const newStrike = result.callWall?.target_strike;
          const newSpot   = result.spot;
          if (!newStrike) continue;

          const res = await fetch(`${CF_WORKER_URL}/api/screener/rollup-check`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
            body:    JSON.stringify({ ticker: sym, new_strike: newStrike, new_spot: newSpot }),
            signal:  AbortSignal.timeout(8000),
          });
          const data = await res.json();
          if (data.changed) {
            rolled++;
            console.log(`[rollup] ${sym}: ${data.old_strike} → ${data.new_strike} (${data.direction})`);
          }
        } catch (e) {
          console.warn(`[rollup] ${sym} 오류:`, e.message);
        }
      }
      console.log(`[rollup] 감지 완료 — ${symbols.length}개 중 ${rolled}개 변경`);

      // 롤업 완료 후 BB맵 종목 가격 지표 수집
      try {
        await collectBbMapIndicators();
      } catch (e) {
        console.warn('[rollup] BB맵 수집 실패 (계속 진행):', e.message);
      }
    } catch (e) {
      console.error('[rollup] 스케줄러 오류:', e.message);
    }
  })();
}

// 평일 ET 09:00~16:59, 15분마다 DEX 계산
if (isWeekday()) {
  const now = new Date();
  const min = now.getMinutes();
  if (h >= 9 && h < 17 && min % 15 === 1) {
    console.log('[scheduler] 15분 DEX 계산 트리거');
    calculateAndStore().catch(e => console.error('[scheduler] calculateAndStore error:', e.message));
  }
}

}, 60_000);

// 최초 실행
lastSession = getMarketSession();
scheduleSnapshot();

// 장중 가격 업데이트 — 독립 5분 타이머 (1분 루프 타이밍 미스 방지)
setInterval(() => {
  if (isWeekday() && getMarketSession() === 'REGULAR') {
    updateLivePrices().catch(e => console.error('[livePrices] 오류:', e.message));
  }
}, 5 * 60_000);

// 서버 시작 시 즉시 1회 실행 (장중인 경우)
if (isWeekday() && getMarketSession() === 'REGULAR') {
  console.log('[livePrices] 서버 시작 즉시 실행');
  updateLivePrices().catch(e => console.error('[livePrices] 초기 실행 오류:', e.message));
}

// 서버 시작 시 prevClose 초기화 (KV → Yahoo 폴백)
initPrevClose().catch(e => console.error('[prevClose] 초기화 실패:', e.message));

// 서버 시작 시 즉시 1회 DEX 계산
console.log('[scheduler] 서버 시작 -- DEX 즉시 1회 실행');
calculateAndStore().catch(e => console.error('[scheduler] calculateAndStore error (init):', e.message));
}

// ─────────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────────