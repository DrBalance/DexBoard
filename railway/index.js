// DexBoard – Railway entry point
// CF Workers cron calls POST /calculate every 15 min during market hours
// This service: fetches CBOE option chain → filters → calculates Greeks → writes to CF KV
// WebSocket /ws → Finnhub WSS 중계 (SPY + RSP 틱)
// POST /analyze  → Gemini API 호출 (키 보호)

import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { calculateAndStore } from "./vanna_analyzer.js";

const PORT        = process.env.PORT        || 3000;
const CRON_SECRET = process.env.CRON_SECRET || "";
const FINNHUB_KEY = process.env.FINNHUB_KEY || "";
const GEMINI_KEY  = process.env.GEMINI_KEY  || "";

const GEMINI_URL  =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent";

// ─────────────────────────────────────────────────────────────────
// Gemini 분석 요청
// ─────────────────────────────────────────────────────────────────
async function callGemini(payload) {
  if (!GEMINI_KEY) throw new Error("GEMINI_KEY not set");

  // Strike 요약: DEX 절대값 상위 5개만 추출
  const topStrikes = (payload.strikes ?? [])
    .sort((a, b) => Math.abs(b.dex) - Math.abs(a.dex))
    .slice(0, 5)
    .map(s => `  Strike ${s.strike}: DEX ${(s.dex/1e6).toFixed(1)}M, GEX ${(s.gex/1e6).toFixed(1)}M`)
    .join("\n");

  const prompt = `
당신은 옵션 딜러 헤징 메커니즘 전문가입니다.
아래 SPY 옵션 데이터를 보고 현재 딜러들의 헤징 방향과 압력을 분석해주세요.
한국어로 4~5문장으로 간결하게 답해주세요.
수식이나 불릿포인트 없이 자연스러운 문장으로만 작성해주세요.

[현재 시장 상태]
- 장 상태: ${payload.marketState}
- ET 시각: ${payload.etTime}
- SPY 현재가: $${payload.spot} (전일 대비 ${payload.spyChangePct}%)
- VIX: ${payload.vix} (전일 대비 ${payload.vixChangePct}%)

[딜러 포지션 요약 (0DTE)]
- DEX 총합: ${(payload.dex/1e6).toFixed(1)}M (${payload.dex >= 0 ? "양수: 딜러 매수 헤지" : "음수: 딜러 매도 헤지"})
- GEX 총합: ${(payload.gex/1e6).toFixed(1)}M
- Vanna 총합: ${(payload.vanna/1e6).toFixed(1)}M
- Charm 총합: ${(payload.charm/1e6).toFixed(1)}M
- VOLD(RSP breadth): ${(payload.vold/1e6).toFixed(1)}M

[주요 Strike (DEX 상위 5개)]
${topStrikes || "  데이터 없음"}

질문: 지금 딜러들은 어떤 방향으로 헤징하고 있고, 어떤 압력이 예상되나요?
`.trim();

  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature:     0.4,
        maxOutputTokens: 400,
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gemini ${res.status}: ${txt.slice(0, 200)}`);
  }

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini: 응답 텍스트 없음");
  return text.trim();
}

// ─────────────────────────────────────────────────────────────────
// Finnhub WebSocket 중계
// ─────────────────────────────────────────────────────────────────
const FINNHUB_WS_URL = `wss://ws.finnhub.io?token=${FINNHUB_KEY}`;
const SYMBOLS        = ["SPY", "RSP"];   // 구독 심볼

let _finnhub          = null;   // Finnhub WS 인스턴스
let _finnhubReady     = false;  // 연결 완료 여부
let _reconnectTimer   = null;

// 연결된 브라우저 클라이언트 목록
const _clients = new Set();

// ── Finnhub 연결 ──────────────────────────────────────────────────
function connectFinnhub() {
  if (!FINNHUB_KEY) {
    console.warn("[Finnhub] FINNHUB_KEY 없음 — WS 비활성화");
    return;
  }

  console.log("[Finnhub] 연결 시도…");
  _finnhub      = new WebSocket(FINNHUB_WS_URL);
  _finnhubReady = false;

  _finnhub.on("open", () => {
    _finnhubReady = true;
    console.log("[Finnhub] 연결됨 — 심볼 구독:", SYMBOLS.join(", "));
    SYMBOLS.forEach((s) => {
      _finnhub.send(JSON.stringify({ type: "subscribe", symbol: s }));
    });
  });

  _finnhub.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type !== "trade" || !Array.isArray(msg.data)) return;

      // 브라우저 클라이언트에 중계
      // 형식: { type: "tick", data: [{ s, p, v, t }] }
      const payload = JSON.stringify({ type: "tick", data: msg.data });
      for (const client of _clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      }
    } catch (e) {
      console.warn("[Finnhub] 메시지 파싱 오류:", e.message);
    }
  });

  _finnhub.on("close", () => {
    _finnhubReady = false;
    console.warn("[Finnhub] 연결 종료 — 15초 후 재연결");
    if (!_reconnectTimer) {
      _reconnectTimer = setTimeout(() => {
        _reconnectTimer = null;
        connectFinnhub();
      }, 15_000);
    }
  });

  _finnhub.on("error", (err) => {
    console.error("[Finnhub] 오류:", err.message);
    _finnhub.close();
  });
}

// ─────────────────────────────────────────────────────────────────
// HTTP 서버
// ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status:        "ok",
      ts:            new Date().toISOString(),
      finnhub:       _finnhubReady ? "connected" : "disconnected",
      clients:       _clients.size,
    }));
    return;
  }

  // ── POST /analyze  (브라우저 → Gemini AI 분석) ──────────────────
  if (req.method === "POST" && req.url === "/analyze") {
    const corsHeaders = {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const analysis = await callGemini(payload);
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ ok: true, analysis }));
      } catch (err) {
        console.error("[Gemini] 오류:", err.message);
        res.writeHead(500, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // ── POST /calculate  (CF Workers 크론 트리거) ─────────────────────
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
// WebSocket 서버 (/ws)
// ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  _clients.add(ws);
  console.log(`[WS] 클라이언트 연결 (총 ${_clients.size}개) — ${req.socket.remoteAddress}`);

  // 연결 즉시 현재 Finnhub 상태 전송
  ws.send(JSON.stringify({
    type:   "status",
    finnhub: _finnhubReady ? "connected" : "disconnected",
  }));

  ws.on("close", () => {
    _clients.delete(ws);
    console.log(`[WS] 클라이언트 해제 (총 ${_clients.size}개)`);
  });

  ws.on("error", (err) => {
    console.warn("[WS] 클라이언트 오류:", err.message);
    _clients.delete(ws);
  });
});

// ─────────────────────────────────────────────────────────────────
// 시작
// ─────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`DexBoard Railway service listening on port ${PORT}`);
  connectFinnhub();
});
