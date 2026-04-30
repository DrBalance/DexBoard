// DexBoard – Railway entry point
// CF Workers cron calls POST /calculate every 15 min during market hours
// This service: fetches CBOE option chain → filters → calculates Greeks → writes to CF KV
// POST /analyze  → Gemini API 호출 (키 보호)
// (Finnhub WebSocket 중계 제거 — SPY는 CF Worker /api/spy-price 프록시로 분리)

import http from "http";
import { calculateAndStore } from "./vanna_analyzer.js";

const PORT        = process.env.PORT        || 3000;
const CRON_SECRET = process.env.CRON_SECRET || "";
const GEMINI_KEY  = process.env.GEMINI_KEY  || "";
const TWELVE_KEY  = process.env.TWELVE_KEY  || "";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

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
// Gemini Backoff 래퍼
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

// ─────────────────────────────────────────────────────────────────
// Gemini 분석 요청
// ─────────────────────────────────────────────────────────────────
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
      "trigger": "구체적인 발생 조건 (예: VIX 하락 + GEX 양전환 구간 돌파)",
      "target": "목표 스트라이크 또는 Call Wall 레벨",
      "probability": 60
    },
    {
      "case": "하락 시나리오",
      "trigger": "구체적인 발생 조건 (예: Put Wall 하방 이탈 + VOLD 음전환)",
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
        temperature:      0.15,
        topP:             0.8,
        maxOutputTokens:  8192,
        responseMimeType: "application/json",
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
    // Railway 로그 truncation 우회 — 문자열을 쪼개서 출력
    const raw = text.slice(0, 500);
    const chunkSize = 80;
    for (let i = 0; i < raw.length; i += chunkSize) {
      console.log("[Gemini RAW] chunk" + Math.floor(i/chunkSize) + ": " + raw.slice(i, i + chunkSize));
    }
    throw new Error("Gemini: JSON 파싱 실패");
  }
}

// ─────────────────────────────────────────────────────────────────
// HTTP 서버
// ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      ts:     new Date().toISOString(),
    }));
    return;
  }

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // ── POST /analyze ────────────────────────────────────────────────
  if (req.method === "POST" && req.url === "/analyze") {
    const corsHeaders = {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
    };
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const ip = req.socket.remoteAddress ?? "unknown";
        if (!checkRateLimit(ip)) {
          res.writeHead(429, corsHeaders);
          return res.end(JSON.stringify({ ok: false, error: "서버 요청 한도 초과 (IP 기반)" }));
        }

        let payload;
        try {
          payload = JSON.parse(body || "{}");
        } catch {
          res.writeHead(400, corsHeaders);
          return res.end(JSON.stringify({ ok: false, error: "잘못된 JSON 형식입니다." }));
        }

        const analysis = await callGeminiWithRetry(payload);

        // 분석 결과를 CF KV에 캐싱 (ai:analysis)
        const CF_WORKER_URL = process.env.CF_WORKER_URL || "";
        const CF_KV_SECRET  = process.env.CF_KV_SECRET  || "";
        if (CF_WORKER_URL && CF_KV_SECRET) {
          try {
            await fetch(`${CF_WORKER_URL}/kv-write`, {
              method:  "POST",
              headers: {
                "Content-Type": "application/json",
                "x-kv-secret":  CF_KV_SECRET,
              },
              body: JSON.stringify({
                key:   "ai:analysis",
                value: JSON.stringify({ analysis, ts: new Date().toISOString() }),
              }),
              signal: AbortSignal.timeout(5000),
            });
            console.log("[AI] KV 캐시 저장 완료");
          } catch (kvErr) {
            console.warn("[AI] KV 캐시 저장 실패:", kvErr.message);
          }
        }

        if (!res.writableEnded) {
          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify({ ok: true, analysis }));
        }
      } catch (err) {
        console.error("[Gemini] 최종 분석 실패:", err.message);
        const isQuotaError = err.message?.includes("429");
        if (!res.headersSent) {
          res.writeHead(isQuotaError ? 429 : 500, corsHeaders);
        }
        res.end(JSON.stringify({
          ok: false,
          error: isQuotaError
            ? "Gemini API 할당량이 일시적으로 소진되었습니다."
            : err.message,
        }));
      }
    });
    return;
  }

  // ── POST /calculate ──────────────────────────────────────────────
  if (req.method === "POST" && req.url === "/calculate") {
    const auth = req.headers["x-cron-secret"];
    if (CRON_SECRET && auth !== CRON_SECRET) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { spot, vix } = JSON.parse(body || "{}");
        if (!spot || !vix) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "spot and vix required" }));
          return;
        }
        console.log(`[${new Date().toISOString()}] /calculate → spot=${spot} vix=${vix}`);
        const result = await calculateAndStore(spot, vix);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error("calculateAndStore error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
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
