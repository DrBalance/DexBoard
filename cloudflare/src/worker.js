// DexBoard – Cloudflare Workers main
// Routes:
//   GET  /api/snapshot      → latest 1min snapshot from KV
//   GET  /api/dex/:group    → DEX data (0dte | weekly | monthly | quarterly | structure)
//   POST /kv-write          → internal: Railway writes KV through here
// Cron:
//   */1  13-20 → fetchSnapshot (Twelve Data + Yahoo VIX)
//   */15 13-20 → triggerRailway (POST /calculate to Railway)
//   0    13    → snapshotOpen  (장 시작 스냅샷 저장)
//   30   20    → (future) EOD individual stocks

export default {
  // ─────────────────────────────────────────
  // HTTP fetch handler
  // ─────────────────────────────────────────
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-kv-secret",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ── POST /kv-write  (Railway → CF KV) ──────────────────────
    if (request.method === "POST" && path === "/kv-write") {
      const secret = request.headers.get("x-kv-secret");
      if (secret !== env.CF_KV_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const body = await request.json();
      const { key, value } = body;
      if (!key || value === undefined) {
        return json({ error: "key and value required" }, 400, corsHeaders);
      }
      await env.DEX_KV.put(key, value);
      return json({ ok: true, key }, 200, corsHeaders);
    }

    // ── GET /api/snapshot ───────────────────────────────────────
    if (request.method === "GET" && path === "/api/snapshot") {
      const data = await env.DEX_KV.get("snapshot:1min", { type: "json" });
      if (!data) return json({ error: "No snapshot yet" }, 404, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/dex/:group ─────────────────────────────────────
    const dexMatch = path.match(/^\/api\/dex\/(0dte|weekly|monthly|quarterly|structure)$/);
    if (request.method === "GET" && dexMatch) {
      const group = dexMatch[1];
      const data  = await env.DEX_KV.get(`dex:spy:${group}`, { type: "json" });
      if (!data) return json({ error: `No data for ${group}` }, 404, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/dex/open ───────────────────────────────────────
    if (request.method === "GET" && path === "/api/dex/open") {
      const data = await env.DEX_KV.get("options:spy:open", { type: "json" });
      if (!data) return json({ error: "No open snapshot" }, 404, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── Health check ────────────────────────────────────────────
    if (path === "/health") {
      return json({ status: "ok", ts: new Date().toISOString() }, 200, corsHeaders);
    }

    return json({ error: "Not found" }, 404, corsHeaders);
  },

  // ─────────────────────────────────────────
  // Scheduled cron handler
  // ─────────────────────────────────────────
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    console.log(`[cron] ${cron} fired at ${new Date().toISOString()}`);

    // 장 시작 스냅샷 (0 13 * * 1-5)
    if (cron === "0 13 * * 1-5") {
      ctx.waitUntil(snapshotOpen(env));
      return;
    }

    // 15분마다 Railway 트리거 (*/15 13-20 * * 1-5)
    if (cron === "*/15 13-20 * * 1-5") {
      ctx.waitUntil(triggerRailway(env));
      return;
    }

    // 나머지 (1분, 3분) → 스냅샷 갱신
    ctx.waitUntil(fetchSnapshot(env));
  },
};

// ─────────────────────────────────────────────────────────────────
// fetchSnapshot – SPY price (Twelve Data) + VIX (Yahoo)
// ─────────────────────────────────────────────────────────────────
async function fetchSnapshot(env) {
  try {
    const [spy, vix] = await Promise.all([
      fetchSPYPrice(env),
      fetchVIX(env),
    ]);

    // Roll prev
    const current = await env.DEX_KV.get("snapshot:1min", { type: "json" });
    if (current) {
      await env.DEX_KV.put("snapshot:prev", JSON.stringify(current));
    }

    const snapshot = {
      spy,
      vix,
      ts: new Date().toISOString(),
    };
    await env.DEX_KV.put("snapshot:1min", JSON.stringify(snapshot));
    console.log(`[snapshot] SPY=${spy} VIX=${vix}`);
  } catch (e) {
    console.error("[snapshot] error:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// snapshotOpen – save opening snapshot as DEXopen baseline
// ─────────────────────────────────────────────────────────────────
async function snapshotOpen(env) {
  try {
    const snapshot = await env.DEX_KV.get("snapshot:1min", { type: "json" });
    if (!snapshot) {
      console.warn("[snapshotOpen] No snapshot:1min yet");
      return;
    }
    await env.DEX_KV.put("options:spy:open", JSON.stringify({
      ...snapshot,
      saved_at: new Date().toISOString(),
    }));
    console.log("[snapshotOpen] saved opening snapshot");
  } catch (e) {
    console.error("[snapshotOpen] error:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// triggerRailway – call Railway /calculate with current spot+vix
// ─────────────────────────────────────────────────────────────────
async function triggerRailway(env) {
  try {
    const snapshot = await env.DEX_KV.get("snapshot:1min", { type: "json" });
    if (!snapshot) {
      console.warn("[railway] No snapshot yet, skipping trigger");
      return;
    }

    const res = await fetch(`${env.RAILWAY_URL}/calculate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": env.CRON_SECRET || "",
      },
      body: JSON.stringify({ spot: snapshot.spy, vix: snapshot.vix }),
    });

    const text = await res.text();
    console.log(`[railway] ${res.status}: ${text.slice(0, 200)}`);
  } catch (e) {
    console.error("[railway] error:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// fetchSPYPrice – Twelve Data REST (1min bar close)
// ─────────────────────────────────────────────────────────────────
async function fetchSPYPrice(env) {
  const url = `https://api.twelvedata.com/price?symbol=SPY&apikey=${env.TWELVE_DATA_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Twelve Data: ${res.status}`);
  const json = await res.json();
  const price = parseFloat(json.price);
  if (isNaN(price)) throw new Error("Twelve Data: invalid price");
  return price;
}

// ─────────────────────────────────────────────────────────────────
// fetchVIX – Yahoo Finance fallback
// ─────────────────────────────────────────────────────────────────
async function fetchVIX(env) {
  const url = `${env.YAHOO_BASE}/%5EVIX?interval=1m&range=1d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`Yahoo VIX: ${res.status}`);
  const json = await res.json();
  const quotes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
  const last = quotes.filter(Boolean).pop();
  if (!last) throw new Error("Yahoo VIX: no data");
  return last;
}

// ─────────────────────────────────────────────────────────────────
// Helper: JSON response
// ─────────────────────────────────────────────────────────────────
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}
