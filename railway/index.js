// DexBoard – Railway entry point v3
// POST /calculate        → CBOE SPY DEX 계산 → CF KV
// POST /analyze          → Gemini API 분석
// POST /collect-screener → 개별종목 스크리너 수집 → D1 저장
// GET  /screener-status  → 오늘 수집 여부 확인
// setInterval 스케줄러   → fetchSnapshot (Yahoo→KV), snapshotOpen, triggerScreener

import http from "http";
import { calculateAndStore, collectSymbol, calcScreenerScore, getTodayET } from "./vanna_analyzer.js";

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

      // ATR (5일/20일) — i 기준 슬라이스
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

    // CF Worker D1 저장 — INSERT OR IGNORE (기존 날짜 데이터 보존, 신규만 추가)
    const writeRes = await fetch(`${cfWorkerUrl}/d1/price-indicators`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-cron-secret': cronSecret,
      },
      body: JSON.stringify({ rows, mode: 'ignore' }),
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
        console.warn(`[Gemini] 429 — ${wait}ms 후 재시도 (${i + 1}/${retries - 1})`);
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

[응답 JSON 형식 — 한국어, 각 필드를 구체적이고 충분히 서술할 것]
{
  "market_regime": {
    "phase": "시장 국면 (예: 감마 압축 구간, 언와인드 진행 중 등)",
    "volatility_context": "현재 VIX 수준과 변동성 방향성에 대한 구체적 설명",
    "dominance": "Dealer-Driven 또는 Flow-Driven — 근거 포함"
  },
  "deep_dive": {
    "dealer_inventory": {
      "gamma_exposure": "GEX 부호 및 크기, 핵심 위험 스트라이크, 딜러 헷지 방향을 상세히 설명",
      "vanna_flow": "현재 VIX 방향에 따른 Vanna 흐름이 딜러 델타 헷지에 미치는 압력 분석"
    },
    "breadth_analysis": {
      "vold_signal": "VOLD와 SPY 가격 간 다이버전스 여부, 강도, 지속 가능성 평가",
      "interpretation": "현물 수급 에너지의 질적 해석 — 진짜 매수/매도 vs 파생 헷지 유발 흐름 구분"
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
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
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
    signal: AbortSignal.timeout(30_000),
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

// 동시 수집 제한 — CBOE rate limit 방지
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

    // CBOE 요청 간격 — 배치 사이 200ms 대기
    if (i + concurrency < symbols.length) {
      await sleep(200);
    }
  }

  return { results, errors };
}

// 수집 결과 → CF Worker D1 저장
async function saveToD1(collected, date) {
  const rows = [];
  const scores = [];

  for (const { symbol, rows: expiryRows } of collected) {
    // options_dex 행 구성
    for (const r of expiryRows) {
      rows.push({ date, symbol, ...r });
    }

    // screener_scores 계산
    const scoreData = calcScreenerScore(expiryRows);
    if (scoreData) {
      scores.push({ date, symbol, ...scoreData });
    }
  }

  // D1 batch write
  await d1Write("/d1/options-dex", { rows });
  await d1Write("/d1/screener-scores", { rows: scores });

  return { dex_rows: rows.length, score_rows: scores.length };
}

// ─────────────────────────────────────────────────────────────────
// 수집 진행 상태 (메모리 내 — Railway 재시작 시 초기화)
// ─────────────────────────────────────────────────────────────────
let collectState = {
  running:   false,
  startedAt: null,
  progress:  null,   // { done, total, errors }
  lastRun:   null,   // { date, ok, count, errors, ts }
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

  // ── POST /calculate ──────────────────────────────────────────────
  if (req.method === "POST" && req.url === "/calculate") {
    const auth = req.headers["x-cron-secret"];
    if (CRON_SECRET && auth !== CRON_SECRET) {
      res.writeHead(401);
      return res.end("Unauthorized");
    }
    const body = await readBody(req);
    const { spot, vix } = body;
    if (!spot || !vix) {
      return sendJSON(res, 400, { error: "spot and vix required" });
    }
    try {
      console.log(`[${new Date().toISOString()}] /calculate → spot=${spot} vix=${vix}`);
      const result = await calculateAndStore(spot, vix);
      return sendJSON(res, 200, result);
    } catch (err) {
      console.error("calculateAndStore error:", err);
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // ── POST /rescore ────────────────────────────────────────────────
  // 기존 options_dex + price_indicators 데이터로 점수만 재계산
  if (req.method === "POST" && req.url === "/rescore") {
    const auth = req.headers["x-cron-secret"];
    if (CRON_SECRET && auth !== CRON_SECRET) {
      res.writeHead(401);
      return res.end("Unauthorized");
    }

    try {
      const dataRes = await fetch(`${CF_WORKER_URL}/api/rescore-data`, {
        headers: { "x-cron-secret": CRON_SECRET },
        signal: AbortSignal.timeout(15000),
      });
      if (!dataRes.ok) throw new Error(`rescore-data fetch failed: ${dataRes.status}`);
      const { dex_date, dex, pi, meta } = await dataRes.json();

      if (!dex?.length) {
        return sendJSON(res, 200, { ok: false, error: "options_dex 데이터 없음" });
      }

      // price_indicators → symbol별 Map
      const piMap = new Map();
      for (const r of pi) {
        piMap.set(r.symbol, {
          bb_position: r.bb_position ?? null,
          vol_squeeze: r.vol_ratio   ?? null,
          close:       r.close       ?? null,
        });
      }

      // symbols meta → symbol별 Map
      const metaMap = new Map();
      for (const r of meta) metaMap.set(r.symbol, r);

      // options_dex → symbol별 그룹핑
      const symbolMap = new Map();
      for (const row of dex) {
        if (!symbolMap.has(row.symbol)) symbolMap.set(row.symbol, []);
        symbolMap.get(row.symbol).push(row);
      }

      // 심볼별 점수 재계산
      const scoreRows = [];
      for (const [symbol, rows] of symbolMap) {
        const priceData = piMap.get(symbol) ?? {};
        const scoreData = calcScreenerScore(rows, priceData);
        if (scoreData) {
          scoreRows.push({
            date:   dex_date,
            symbol,
            close:  priceData.close ?? null,
            ...scoreData,
          });
        }
      }

      await d1Write("/d1/screener-scores", { rows: scoreRows });
      console.log(`[Rescore] 완료 — ${scoreRows.length}개 종목 (기준일: ${dex_date})`);
      return sendJSON(res, 200, {
        ok:      true,
        date:    dex_date,
        count:   scoreRows.length,
        message: `${scoreRows.length}개 종목 점수 재계산 완료`,
      });

    } catch (err) {
      console.error("[Rescore] 실패:", err.message);
      return sendJSON(res, 500, { ok: false, error: err.message });
    }
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
    // (이미 오늘 수집됐는지는 CF Worker의 D1 쿼리로 확인 — 여기선 lastRun 메모리로 판단)
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

    // 백그라운드 수집
    (async () => {
      try {
        // ── 1. BB 맵 전용 종목 price_indicators 수집
        let bbCount = 0;
        try {
          const bbRes = await fetch(`${CF_WORKER_URL}/api/bb-map-symbols`, {
            headers: { 'x-cron-secret': CRON_SECRET },
            signal: AbortSignal.timeout(10000),
          });
          if (bbRes.ok) {
            const bbData = await bbRes.json();
            const optionSymSet = new Set(symbols.map(s => s.symbol));
            const bbOnly = (bbData.symbols ?? []).filter(s => !optionSymSet.has(s.symbol));

            console.log(`[Screener] BB 맵 전용 종목 ${bbOnly.length}개 가격 수집`);
            // BB 맵 단계 표시 (screener-status에서 stage:'bb_map' 반환)
            collectState.progress = { stage: 'bb_map', done: 0, total: bbOnly.length, errors: 0 };
            for (const { symbol: sym } of bbOnly) {
              await collectPriceIndicators(sym, CF_WORKER_URL, CRON_SECRET);
              bbCount++;
              collectState.progress = { stage: 'bb_map', done: bbCount, total: bbOnly.length, errors: 0 };
              await sleep(200);
            }
          }
        } catch (bbErr) {
          console.warn('[Screener] BB 맵 수집 실패 (계속 진행):', bbErr.message);
        }

        // ── 2. 옵션 수집 종목 처리
        const symbolsWithDate = symbols.map(s => ({ ...s, date }));
        const BATCH = 5;
        const allResults = [];
        const allErrors  = [];

        for (let i = 0; i < symbolsWithDate.length; i += BATCH) {
          const batch = symbolsWithDate.slice(i, i + BATCH);
          const settled = await Promise.allSettled(
            batch.map(s => collectSymbol(s.symbol, date))
          );

          for (let j = 0; j < settled.length; j++) {
            const r = settled[j];
            if (r.status === "fulfilled") {
              allResults.push({ ...r.value, meta: batch[j] });
            } else {
              allErrors.push({ symbol: batch[j].symbol, error: r.reason?.message });
            }
          }

          collectState.progress = {
            done:   Math.min(i + BATCH, symbolsWithDate.length),
            total:  symbolsWithDate.length,
            errors: allErrors.length,
          };

          if (i + BATCH < symbolsWithDate.length) await sleep(300);
        }

        // ── 3. 옵션 수집 종목 price_indicators 수집 (결과를 Map으로 보관)
        console.log(`[Screener] 옵션 종목 ${symbols.length}개 가격 수집`);
        const priceMap = new Map(); // symbol → { bbPosition, volRatio }
        for (const { symbol: sym } of symbols) {
          const pi = await collectPriceIndicators(sym, CF_WORKER_URL, CRON_SECRET);
          if (pi) {
            priceMap.set(sym, {
              bb_position: pi.bbPosition ?? null,
              vol_squeeze: pi.volRatio   ?? null,
            });
          }
          await sleep(200);
        }

        // ── 4. D1 저장
        if (allResults.length) {
          console.log(`[Screener] ${allResults.length}개 종목 수집 완료 → D1 저장 시작`);

          const dexRows   = [];
          const scoreRows = [];

          for (const { symbol, rows, meta } of allResults) {
            for (const r of rows) {
              dexRows.push({ date, symbol, ...r });
            }
            // price_indicators에서 수집한 BB/변동성 데이터를 점수 계산에 반영
            const priceData = priceMap.get(symbol) ?? {};
            const scoreData = calcScreenerScore(rows, priceData);
            if (scoreData) {
              scoreRows.push({
                date,
                symbol,
                name:       meta?.name       ?? symbol,
                type:       meta?.type       ?? "stock",
                sector:     meta?.sector     ?? null,
                sector_etf: meta?.sector_etf ?? null,
                ...scoreData,
              });
            }
          }

          await d1Write("/d1/options-dex",    { rows: dexRows });
          await d1Write("/d1/screener-scores", { rows: scoreRows });

          console.log(`[Screener] D1 저장 완료 — DEX: ${dexRows.length}행, Scores: ${scoreRows.length}행`);
        }

        collectState = {
          running:   false,
          startedAt: null,
          progress:  null,
          lastRun: {
            date,
            ok:       true,
            count:    allResults.length,
            bb_count: bbCount,
            errors:   allErrors.length,
            error_list: allErrors.slice(0, 10),
            ts:       new Date().toISOString(),
          },
        };

        console.log(`[Screener] 완료 — 성공: ${allResults.length}, 실패: ${allErrors.length}`);

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
    })();

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

function getMarketSession() {
  if (!isWeekday()) return 'CLOSED';
  const h = getETHour();
  if (h >= 4  && h < 9)  return 'PRE';      // 04:00~08:59
  if (h === 9)           return 'PRE';      // 09:00~09:29 (분 체크 생략)
  if (h >= 9  && h < 16) return 'REGULAR';  // 09:30~15:59
  if (h >= 16 && h < 20) return 'AFTER';    // 16:00~19:59
  if (h >= 20 && h < 24) return 'AFTER';    // 20:00~23:59
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
  const meta = result.meta;
  const quotes = result.indicators?.quote?.[0]?.close ?? [];
  const price = quotes.filter(Boolean).pop();
  if (!price) throw new Error(`Yahoo ${symbol}: no close data`);
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
  const change    = prevClose != null ? Math.round((price - prevClose) * 100) / 100 : null;
  const changePct = prevClose != null ? Math.round((price - prevClose) / prevClose * 10000) / 100 : null;
  return { price: Math.round(price * 100) / 100, change, changePct };
}

async function fetchSnapshot() {
  try {
    const [spy, vix] = await Promise.all([
      fetchYahoo('SPY'),
      fetchYahoo('%5EVIX'),
    ]);
    const snapshot = { spy, vix, ts: new Date().toISOString() };

    // CF KV에 저장
    await fetch(`${CF_WORKER_URL}/kv-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-kv-secret': CF_KV_SECRET },
      body: JSON.stringify({ key: 'snapshot:1min', value: JSON.stringify(snapshot) }),
      signal: AbortSignal.timeout(5000),
    });
    console.log(`[snapshot] SPY=${spy.price} (${spy.changePct}%) VIX=${vix.price} (${vix.changePct}%)`);
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
// 스케줄러
// ─────────────────────────────────────────────────────────────────
function startScheduler() {
  let lastSession  = null;
  let lastDexHour  = null;   // 15분 DEX 계산 추적
  let screenerDone = false;  // 당일 스크리너 수집 여부
  let openDone     = false;  // 당일 장 시작 스냅샷 여부

  // 매일 자정 플래그 초기화
  setInterval(() => {
    const h = getETHour();
    if (h === 0) { screenerDone = false; openDone = false; }
  }, 60_000);

  // 1분마다 세션 체크 → 폴링 주기 동적 조정
  let snapshotTimer = null;

  function scheduleSnapshot() {
    if (snapshotTimer) clearInterval(snapshotTimer);
    const session = getMarketSession();

    if (session === 'CLOSED') {
      console.log('[scheduler] CLOSED — snapshot 중지');
      snapshotTimer = null;
      return;
    }

    const interval = session === 'REGULAR' ? 60_000 : 3 * 60_000;
    console.log(`[scheduler] ${session} — snapshot ${interval / 1000}초 주기 시작`);
    fetchSnapshot(); // 즉시 1회 실행
    snapshotTimer = setInterval(fetchSnapshot, interval);
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

      // 장 마감(AFTER 첫 진입) → 스크리너 수집
      if (session === 'AFTER' && !screenerDone) {
        screenerDone = true;
        console.log('[scheduler] 장 마감 → 스크리너 수집 트리거');

        // D1에서 수집 대상 심볼 조회 후 수집 트리거
        (async () => {
          try {
            const symRes = await fetch(`${CF_WORKER_URL}/api/collect-targets`, {
              headers: { 'x-cron-secret': CRON_SECRET },
              signal: AbortSignal.timeout(10000),
            });
            if (!symRes.ok) throw new Error(`collect-targets: ${symRes.status}`);
            const symData = await symRes.json();
            const symbols = symData.symbols ?? [];

            if (!symbols.length) {
              console.warn('[scheduler] 수집 대상 심볼 없음 — 스크리너 수집 생략');
              return;
            }

            console.log(`[scheduler] ${symbols.length}개 심볼 수집 시작`);
            await fetch(`http://localhost:${PORT}/collect-screener`, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
              body:    JSON.stringify({ symbols, force: false }),
              signal:  AbortSignal.timeout(10000),
            });
          } catch (e) {
            console.error('[scheduler] screener trigger error:', e.message);
          }
        })();
      }
    }

    // 정규장 중 15분마다 DEX 계산 트리거
    if (session === 'REGULAR' && h !== lastDexHour && h % 1 === 0) {
      const now = new Date();
      const min = now.getMinutes();
      if (min % 15 === 0) {
        lastDexHour = h + '_' + min;
        console.log('[scheduler] 15분 DEX 계산 트리거');
        fetch(`http://localhost:${PORT}/calculate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
          body: JSON.stringify({}),
        }).catch(e => console.error('[scheduler] calculate trigger error:', e.message));
      }
    }
  }, 60_000);

  // 최초 실행
  lastSession = getMarketSession();
  scheduleSnapshot();
}

// ─────────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────────
