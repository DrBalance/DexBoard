// DexBoard – Cloudflare Workers main
// Routes:
//   GET  /api/snapshot      → latest 1min snapshot from KV
//   GET  /api/snapshot/prev → previous snapshot from KV
//   GET  /api/dex/:group    → DEX data (0dte | weekly | monthly | quarterly | structure)
//   GET  /api/dex/open      → opening snapshot
//   GET  /api/vix-tick      → VIX 1분봉 포인트 배열 (vc-chart.js용)
//   POST /kv-write          → internal: Railway writes KV through here
// Cron:
//   */1  13-20 * * 1-5  → fetchSnapshot (정규장 1분)
//   */3  4-13  * * 1-5  → fetchSnapshot (프리마켓 3분)
//   */3  20-23 * * 1-5  → fetchSnapshot (애프터 3분)
//   */15 13-20 * * 1-5  → triggerRailway (DEX 계산)
//   0    13    * * 1-5  → snapshotOpen  (장 시작 스냅샷)

export default {
  // ─────────────────────────────────────────
  // HTTP fetch handler
  // ─────────────────────────────────────────
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin":  "*",
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
      if (!data) return json({ error: "No snapshot yet" }, 200, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/snapshot/prev ──────────────────────────────────
    if (request.method === "GET" && path === "/api/snapshot/prev") {
      const data = await env.DEX_KV.get("snapshot:prev", { type: "json" });
      if (!data) return json({ error: "No prev snapshot" }, 200, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/dex/:group ─────────────────────────────────────
    const dexMatch = path.match(/^\/api\/dex\/(0dte|weekly|monthly|quarterly|structure)$/);
    if (request.method === "GET" && dexMatch) {
      const group = dexMatch[1];
      const data  = await env.DEX_KV.get(`dex:spy:${group}`, { type: "json" });
      if (!data) return json({ error: `No data for ${group}` }, 200, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/dex/open ───────────────────────────────────────
    if (request.method === "GET" && path === "/api/dex/open") {
      const data = await env.DEX_KV.get("options:spy:open", { type: "json" });
      if (!data) return json({ error: "No open snapshot" }, 200, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/vix-tick ───────────────────────────────────────
    // VIX 1분봉 포인트 배열 반환 (vc-chart.js용)
    // { prevClose: number, points: [{ ts: ISOstring, v: number }] }
    if (request.method === "GET" && path === "/api/vix-tick") {
      try {
        const url = `${env.YAHOO_BASE}/%5EVIX?interval=1m&range=1d`;
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!res.ok) return json({ error: `Yahoo VIX: ${res.status}` }, 502, corsHeaders);

        const data      = await res.json();
        const result    = data?.chart?.result?.[0];
        if (!result)    return json({ error: "Yahoo VIX: no result" }, 502, corsHeaders);

        const meta       = result.meta;
        const timestamps = result.timestamp ?? [];
        const closes     = result.indicators?.quote?.[0]?.close ?? [];
        const prevClose  = meta.chartPreviousClose ?? meta.previousClose ?? null;

        // timestamp(Unix초) → ET ISO 문자열 + 유효한 close만 추출
        const points = timestamps
          .map((ts, i) => ({ ts, v: closes[i] }))
          .filter(d => d.v != null && !isNaN(d.v))
          .map(d => ({
            ts: new Date(d.ts * 1000).toISOString(),
            v:  round2(d.v),
          }));

        return json({ prevClose, points }, 200, corsHeaders);
      } catch (e) {
        return json({ error: e.message }, 502, corsHeaders);
      }
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

    if (cron === "0 13 * * 1-5") {
      ctx.waitUntil(snapshotOpen(env));
      return;
    }

    if (cron === "*/15 13-20 * * 1-5") {
      ctx.waitUntil(triggerRailway(env));
      return;
    }

    ctx.waitUntil(fetchSnapshot(env));
  },
};

// ─────────────────────────────────────────────────────────────────
// fetchSnapshot – SPY (Twelve Data /quote) + VIX (Yahoo Finance)
// ─────────────────────────────────────────────────────────────────
async function fetchSnapshot(env) {
  try {
    const [spy, vix] = await Promise.all([
      fetchSPYQuote(env),
      fetchVIX(env),
    ]);

    const current = await env.DEX_KV.get("snapshot:1min", { type: "json" });
    if (current) {
      await env.DEX_KV.put("snapshot:prev", JSON.stringify(current));
    }

    const snapshot = { spy, vix, ts: new Date().toISOString() };
    await env.DEX_KV.put("snapshot:1min", JSON.stringify(snapshot));
    console.log(`[snapshot] SPY=${spy.price} (${spy.changePct}%) VIX=${vix.price} (${vix.changePct}%)`);
  } catch (e) {
    console.error("[snapshot] error:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// snapshotOpen
// ─────────────────────────────────────────────────────────────────
async function snapshotOpen(env) {
  try {
    const snapshot = await env.DEX_KV.get("snapshot:1min", { type: "json" });
    if (!snapshot) { console.warn("[snapshotOpen] No snapshot:1min yet"); return; }
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
// triggerRailway
// ─────────────────────────────────────────────────────────────────
async function triggerRailway(env) {
  try {
    const snapshot = await env.DEX_KV.get("snapshot:1min", { type: "json" });
    if (!snapshot) { console.warn("[railway] No snapshot yet, skipping trigger"); return; }

    const res = await fetch(`${env.RAILWAY_URL}/calculate`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "x-cron-secret": env.CRON_SECRET || "",
      },
      body: JSON.stringify({
        spot: snapshot.spy.price,
        vix:  snapshot.vix.price,
      }),
    });

    const text = await res.text();
    console.log(`[railway] ${res.status}: ${text.slice(0, 200)}`);
  } catch (e) {
    console.error("[railway] error:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// fetchSPYQuote – Twelve Data /quote
// ─────────────────────────────────────────────────────────────────
async function fetchSPYQuote(env) {
  const url = `https://api.twelvedata.com/quote?symbol=SPY&apikey=${env.TWELVE_DATA_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Twelve Data /quote: ${res.status}`);

  const data = await res.json();
  if (data.status === "error") throw new Error(`Twelve Data: ${data.message}`);

  const price     = parseFloat(data.close);
  const change    = parseFloat(data.change);
  const changePct = parseFloat(data.percent_change);
  if (isNaN(price)) throw new Error("Twelve Data: invalid price");

  return { price: round2(price), change: round2(change), changePct: round2(changePct) };
}

// ─────────────────────────────────────────────────────────────────
// fetchVIX – Yahoo Finance
// ─────────────────────────────────────────────────────────────────
async function fetchVIX(env) {
  const url = `${env.YAHOO_BASE}/%5EVIX?interval=1m&range=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo VIX: ${res.status}`);

  const data   = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo VIX: no result");

  const meta      = result.meta;
  const quotes    = result.indicators?.quote?.[0]?.close ?? [];
  const price     = quotes.filter(Boolean).pop();
  if (!price) throw new Error("Yahoo VIX: no close data");

  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
  const change    = prevClose != null ? round2(price - prevClose) : null;
  const changePct = prevClose != null ? round2((price - prevClose) / prevClose * 100) : null;

  return { price: round2(price), change, changePct };
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
function round2(n) {
  return Math.round(n * 100) / 100;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
