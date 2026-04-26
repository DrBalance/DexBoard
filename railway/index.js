// DexBoard – Railway entry point
// CF Workers cron calls POST /calculate every 15 min during market hours
// This service: fetches CBOE option chain → filters → calculates Greeks → writes to CF KV
// WebSocket /ws → Finnhub WSS 중계 (SPY + RSP 틱)

import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { calculateAndStore } from "./vanna_analyzer.js";

const PORT        = process.env.PORT        || 3000;
const CRON_SECRET = process.env.CRON_SECRET || "";
const FINNHUB_KEY = process.env.FINNHUB_KEY || "";

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

  // Main trigger from CF Workers
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
