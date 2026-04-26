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

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

// ─────────────────────────────────────────────────────────────────
// Gemini 분석 요청
// ─────────────────────────────────────────────────────────────────
async function callGemini(payload) {
  if (!GEMINI_KEY) throw new Error("GEMINI_KEY not set");

  // Strike 압축 전송 (상위 10개, 축약 키)
  // s=strike, cd=callDex, pd=putDex, g=gex, v=vanna, c=charm
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

  const systemInstruction =
    "너는 옵션 시장과 현물 거래량의 상관관계를 분석하는 퀀트 전문가야. " +
    "DEX 히트맵의 장벽(Wall)과 VOLD의 에너지를 비교하여 시장의 페이크 상승/하락을 포착하고 " +
    "시나리오별 확률을 도출하는 것이 네 임무야. " +
    "반드시 지정된 JSON 형식으로만 응답해야 하며, 다른 텍스트는 포함하지 마.";

  const userPrompt = `
# 키 매핑
s=strike, cd=call_dex(M), pd=put_dex(M), g=gex(M), v=vanna(M), c=charm(M)
최신 데이터(시계열 끝)가 현재 상태를 가장 잘 반영함.

# 현재 시장 상태
- 장 상태: ${payload.marketState} / ET: ${payload.etTime}
- SPY: $${payload.spot} (${payload.spyChangePct}%)
- VIX: ${payload.vix} (${payload.vixChangePct}%)

# 딜러 포지션 (0DTE 합산, 단위 M)
- DEX: ${(payload.dex / 1e6).toFixed(1)}M
- GEX: ${(payload.gex / 1e6).toFixed(1)}M
- Vanna: ${(payload.vanna / 1e6).toFixed(1)}M
- Charm: ${(payload.charm / 1e6).toFixed(1)}M
- VOLD(RSP): ${(payload.vold / 1e6).toFixed(1)}M

# Strike 데이터 (DEX 상위 10개)
${JSON.stringify(compressedStrikes)}

# 응답 형식 (JSON만, 한국어)
{
  "market_regime": {
    "phase": "시장 국면 (예: Gamma Pin, Vanna Squeeze 등)",
    "volatility_context": "변동성 환경 한 줄 요약",
    "dominance": "Dealer-Driven 또는 Flow-Driven"
  },
  "deep_dive": {
    "dealer_inventory": {
      "gamma_exposure": "GEX 상태 및 위험 구간 설명",
      "vanna_flow": "VIX 변화에 따른 딜러 강제 매수/매도 압력"
    },
    "breadth_analysis": {
      "vold_signal": "VOLD 다이버전스 여부 및 강도",
      "interpretation": "현물 수급 에너지 해석"
    }
  },
  "scenarios": [
    {
      "case": "상승 시나리오",
      "trigger": "발생 조건",
      "target": "목표가 또는 저항선",
      "probability": 60
    },
    {
      "case": "하락 시나리오",
      "trigger": "발생 조건",
      "target": "지지선 또는 Put Wall",
      "probability": 40
    }
  ],
  "expert_insight": "최종 전문가 결론 및 주의사항 (2~3문장)"
}`.trim();

  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemInstruction }] },
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature:      0.15,
        topP:             0.8,
        maxOutputTokens:  1024,
        responseMimeType: "application/json",
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gemini ${res.status}: ${txt.slice(0, 200)}`);
  }

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini: 응답 텍스트 없음");

  // JSON 파싱 검증
  try {
    const parsed = JSON.parse(text);
    return parsed;
  } catch {
    throw new Error("Gemini: JSON 파싱 실패");
  }
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
