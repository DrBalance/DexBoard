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
const TWELVE_KEY  = process.env.TWELVE_KEY  || "";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

// ─────────────────────────────────────────────────────────────────
// 장 상태 확인 (Twelve Data)
// returns: 'REGULAR' | 'PRE' | 'AFTER' | 'CLOSED'
// ─────────────────────────────────────────────────────────────────
async function fetchMarketState() {
  try {
    const url = `https://api.twelvedata.com/market_state?exchange=NYSE&apikey=${TWELVE_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    console.log("[MarketState] 원본 응답:", JSON.stringify(json));  // ← 추가
    
    const nyse = Array.isArray(json)
      ? (json.find(e => e.code === "XNYS") ?? json[0])
      : json;


    console.log("[MarketState] nyse 객체:", JSON.stringify(nyse));  // ← 추가
    console.log("[MarketState] is_market_open:", nyse?.is_market_open);  // ← 추가

    
    if (!nyse) throw new Error("NYSE 데이터 없음");

    if (nyse.is_market_open) return "REGULAR";

    // time_after_open > 0 이면 애프터마켓
    const afterSec = _parseHMS(nyse.time_after_open);
    if (afterSec > 0) return "AFTER";

    // time_to_open 으로 프리마켓 판단 (ET 04:00~09:30)
    const nowET  = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const etHour = nowET.getHours() + nowET.getMinutes() / 60;
    if (etHour >= 4.0 && etHour < 9.5) return "PRE";

    return "CLOSED";
  } catch (e) {
    console.warn("[MarketState] 조회 실패:", e.message, "→ ET 시각 기반 폴백");
    return _etMarketStateFallback();
  }
}

function _parseHMS(hms) {
  if (!hms) return 0;
  const parts = hms.split(":").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function _etMarketStateFallback() {
  const nowET  = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dow    = nowET.getDay();
  const etHour = nowET.getHours() + nowET.getMinutes() / 60;

  if (dow === 0 || dow === 6) return "CLOSED";
  if (etHour >= 9.5  && etHour < 16.0) return "REGULAR";
  if (etHour >= 4.0  && etHour < 9.5)  return "PRE";
  if (etHour >= 16.0 && etHour < 20.0) return "AFTER";
  return "CLOSED";
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
        maxOutputTokens:  2048,
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
    return JSON.parse(text);
  } catch {
    throw new Error("Gemini: JSON 파싱 실패");
  }
}

// ─────────────────────────────────────────────────────────────────
// Finnhub WebSocket 중계
// ─────────────────────────────────────────────────────────────────
const FINNHUB_WS_URL = `wss://ws.finnhub.io?token=${FINNHUB_KEY}`;
const SYMBOLS        = ["SPY", "RSP"];

let _finnhub        = null;
let _finnhubReady   = false;
let _reconnectTimer = null;
let _marketCheckTimer = null;  // 장 상태 주기적 확인 타이머

const _clients = new Set();

// ── Finnhub 연결 ──────────────────────────────────────────────────
export function connectFinnhub() {
  if (!FINNHUB_KEY) {
    console.warn("[Finnhub] FINNHUB_KEY 없음 — WS 비활성화");
    return;
  }
  if (_finnhub && (
    _finnhub.readyState === WebSocket.OPEN ||
    _finnhub.readyState === WebSocket.CONNECTING
  )) return;

  console.log("[Finnhub] 연결 시도…");
  _finnhub      = new WebSocket(FINNHUB_WS_URL);
  _finnhubReady = false;

  _finnhub.on("open", () => {
    _finnhubReady = true;
    console.log("[Finnhub] 연결됨 — 심볼 구독:", SYMBOLS.join(", "));
    SYMBOLS.forEach((s) => {
      _finnhub.send(JSON.stringify({ type: "subscribe", symbol: s }));
    });
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }
  });

  _finnhub.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type !== "trade" || !Array.isArray(msg.data)) return;
      const payload = JSON.stringify({ type: "tick", data: msg.data });
      for (const client of _clients) {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      }
    } catch (e) {
      console.warn("[Finnhub] 메시지 파싱 오류:", e.message);
    }
  });

  _finnhub.on("close", () => {
    _finnhubReady = false;
    console.warn("[Finnhub] 연결 종료");

    // 재연결 전 장 상태 확인
    if (_reconnectTimer) return;
    _reconnectTimer = setTimeout(async () => {
      _reconnectTimer = null;
      const state = await fetchMarketState();
      if (state === "REGULAR" || state === "PRE") {
        console.log(`[Finnhub] 재연결 (장 상태: ${state})`);
        connectFinnhub();
      } else {
        console.log(`[Finnhub] 재연결 취소 (장 상태: ${state})`);
      }
    }, 15_000);
  });

  _finnhub.on("error", (err) => {
    console.error("[Finnhub] 오류:", err.message);
    _finnhub.close();
  });
}

// ── Finnhub 해제 ──────────────────────────────────────────────────
function disconnectFinnhub() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  if (_finnhub) {
    // onclose 핸들러가 재연결 시도 안 하도록 플래그
    _finnhub.removeAllListeners("close");
    _finnhub.close();
    _finnhub      = null;
    _finnhubReady = false;
    console.log("[Finnhub] 연결 해제");
  }
}

// ── 장 상태 주기적 감시 (5분) ────────────────────────────────────
// PRE/REGULAR → connectFinnhub()
// AFTER/CLOSED → disconnectFinnhub()
async function startMarketWatch() {
  const check = async () => {
    const state = await fetchMarketState();
    console.log(`[MarketWatch] 장 상태: ${state}`);

    if (state === "REGULAR" || state === "PRE") {
      if (!_finnhubReady) {
        console.log(`[MarketWatch] 장 열림 (${state}) → Finnhub 연결`);
        connectFinnhub();
      }
    } else {
      if (_finnhubReady || _finnhub) {
        console.log(`[MarketWatch] 장 마감 (${state}) → Finnhub 해제`);
        disconnectFinnhub();
      }
    }
  };

  // 즉시 1회 실행
  await check();

  // 이후 5분마다 반복
  _marketCheckTimer = setInterval(check, 5 * 60 * 1000);
}

// ─────────────────────────────────────────────────────────────────
// HTTP 서버
// ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status:   "ok",
      ts:       new Date().toISOString(),
      finnhub:  _finnhubReady ? "connected" : "disconnected",
      clients:  _clients.size,
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
        const payload  = JSON.parse(body || "{}");
        const analysis = await callGemini(payload);
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ ok: true, analysis }));
      } catch (err) {
        console.error("[Gemini] 오류:", err.message);
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
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
// WebSocket 서버 (/ws)
// ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  _clients.add(ws);
  console.log(`[WS] 클라이언트 연결 (총 ${_clients.size}개) — ${req.socket.remoteAddress}`);

  ws.send(JSON.stringify({
    type:    "status",
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
// 시작 — connectFinnhub() 직접 호출 대신 startMarketWatch() 로 대체
// ─────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`DexBoard Railway service listening on port ${PORT}`);
  startMarketWatch();  // 장 상태 확인 후 조건부 연결
});
