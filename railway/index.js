// DexBoard – Railway entry point v2
// POST /calculate       → CF cron: CBOE SPY DEX 계산 → CF KV
// POST /analyze         → Gemini API 분석
// POST /collect-screener → 개별종목 스크리너 수집 → D1 저장
// GET  /screener-status → 오늘 수집 여부 확인

import http from "http";
import { calculateAndStore, collectSymbol, calcScreenerScore, getTodayET } from "./vanna_analyzer.js";

const PORT        = process.env.PORT        || 8080;
const CRON_SECRET = process.env.CRON_SECRET || "";
const GEMINI_KEY  = process.env.GEMINI_KEY  || "";
const CF_WORKER_URL = process.env.CF_WORKER_URL || "";
const CF_KV_SECRET  = process.env.CF_KV_SECRET  || "";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent";

server.listen(PORT, '0.0.0.0', () => {
  console.log(`DexBoard Railway service listening on port ${PORT}`);
});



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

        // D1 저장
        if (allResults.length) {
          console.log(`[Screener] ${allResults.length}개 종목 수집 완료 → D1 저장 시작`);

          // options_dex rows
          const dexRows = [];
          const scoreRows = [];

          for (const { symbol, rows, meta } of allResults) {
            for (const r of rows) {
              dexRows.push({ date, symbol, ...r });
            }
            const scoreData = calcScreenerScore(rows);
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

          await d1Write("/d1/options-dex",       { rows: dexRows });
          await d1Write("/d1/screener-scores",    { rows: scoreRows });

          console.log(`[Screener] D1 저장 완료 — DEX: ${dexRows.length}행, Scores: ${scoreRows.length}행`);
        }

        collectState = {
          running:   false,
          startedAt: null,
          progress:  null,
          lastRun: {
            date,
            ok:     true,
            count:  allResults.length,
            errors: allErrors.length,
            error_list: allErrors.slice(0, 10),
            ts:     new Date().toISOString(),
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
server.listen(PORT, () => {
  console.log(`DexBoard Railway service listening on port ${PORT}`);
});
