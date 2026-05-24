// DexBoard – Cloudflare Workers main
// Routes:
//   GET  /api/snapshot        → latest 1min snapshot from KV (SPY + VIX)
//   GET  /api/snapshot/prev   → previous snapshot from KV
//   GET  /api/dex/0dte        → 0DTE SPY 전용 KV (oi15m/oiOpen 포함)
//   GET  /api/dex/:symbol     → DEX 전체 만기 data (날짜조회 탭용)
//   GET  /api/oi/open         → opening snapshot
//   GET  /api/ai-analysis     → 최신 AI 분석 결과 KV 캐시 (ai:analysis)
//   GET  /api/spy-price       → SPY 현재가 프록시 (Twelve Data REST → CORS 우회)
//   GET  /api/prevclose       → 전날 SPY/VIX 종가 (KV snapshot:prevclose)
//   GET  /api/trading-date    → 현재 거래일 날짜 (Twelve Data 기준)
// SCREENER v4 (watchlist 기반)
//   GET  /api/screener/symbols        → is_watchlist=TRUE 심볼 목록
//   GET  /api/screener/latest         → 최신 GEX 스냅샷 (만기별)
//   POST /d1/screener-gex-daily       → Railway → D1 저장 (DELETE+INSERT)
//
// WATCHLIST
//   GET  /api/watchlist               → 전체 목록
//   GET  /api/watchlist/candidates    → is_watchlist=FALSE 후보
//   POST /api/watchlist               → 후보 수동 추가
//   POST /api/watchlist/scan-result   → 스캔 결과 저장
//   POST /api/watchlist/demote        → 관심종목 → 후보 되돌리기
//   DELETE /api/watchlist/:ticker     → 삭제
//   POST /api/calculate       → Railway DEX 계산 프록시 (CORS 우회)
//   POST /kv-write            → internal: Railway writes KV through here
//   GET  /kv-read             → internal: Railway reads KV through here

import { handleAdmin } from './admin.js';

export default {
  // ─────────────────────────────────────────
  // HTTP fetch handler
  // ─────────────────────────────────────────
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-kv-secret, x-admin-secret, x-cron-secret",
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

    // ── GET /kv-read  (Railway → CF KV 읽기) ───────────────────
    // Railway의 kvGet()이 호출 — dex:spy:0dte 직전 스냅샷 조회용
    if (request.method === "GET" && path === "/kv-read") {
      const secret = request.headers.get("x-kv-secret");
      if (secret !== env.CF_KV_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const key = url.searchParams.get("key");
      if (!key) return json({ error: "key required" }, 400, corsHeaders);
      const value = await env.DEX_KV.get(key);
      return json({ key, value: value ?? null }, 200, corsHeaders);
    }

    // ── GET /api/snapshot ───────────────────────────────────────
    if (request.method === "GET" && path === "/api/snapshot") {
      const data = await env.DEX_KV.get("snapshot:1min", { type: "json" });
      if (!data) return json({ error: "No snapshot yet" }, 200, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/timeseries ─────────────────────────────────────
    // 당일 링버퍼 시계열 [{ts, spy, qqq, iwm, vix, vold}, ...]
    if (request.method === "GET" && path === "/api/timeseries") {
      const data = await env.DEX_KV.get("ts:market", { type: "json" });
      if (!data) return json({ series: [] }, 200, corsHeaders);
      return json({ series: data }, 200, corsHeaders);
    }

    // ── GET /api/prevclose ─────────────────────────────────────
    // 전일 종가 KV (snapshot:prevclose) 조회
    if (request.method === "GET" && path === "/api/prevclose") {
      const data = await env.DEX_KV.get("snapshot:prevclose", { type: "json" });
      if (!data) return json({ error: "No prevclose data" }, 200, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/snapshot/prev ──────────────────────────────────
    if (request.method === "GET" && path === "/api/snapshot/prev") {
      const data = await env.DEX_KV.get("snapshot:prev", { type: "json" });
      if (!data) return json({ error: "No prev snapshot" }, 200, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/dex/0dte ───────────────────────────────────────
    // Live 탭 전용: 0DTE SPY strikes (oi15m, oiOpen 포함)
    // dex:spy 전체 만기보다 용량 작음 → 빠른 폴링 가능
    if (request.method === "GET" && path === "/api/dex/0dte") {
      const data = await env.DEX_KV.get("dex:spy:0dte", { type: "json" });
      if (!data) return json({ error: "No 0DTE data yet" }, 200, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/dex/:symbol ────────────────────────────────────
    // 날짜조회 탭용: 전체 만기 expirations 구조
    // /api/dex/0dte 는 위에서 먼저 매칭되므로 여기선 0dte 제외
    const dexMatch = path.match(/^\/api\/dex\/([a-zA-Z]+)$/);
    if (request.method === "GET" && dexMatch) {
      const symbol = dexMatch[1].toLowerCase();
      const data = await env.DEX_KV.get(`dex:${symbol}`, { type: "json" });
      if (!data) return json({ error: `No data for ${symbol}` }, 200, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/oi/open ────────────────────────────────────────
    if (request.method === "GET" && path === "/api/oi/open") {
      const data = await env.DEX_KV.get("oi:spy:open", { type: "json" });
      if (!data) return json({ error: "No OI open snapshot" }, 200, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/ai-analysis ────────────────────────────────────
    if (request.method === "GET" && path === "/api/ai-analysis") {
      const data = await env.DEX_KV.get("ai:analysis", { type: "json" });
      if (!data) return json({ error: "No analysis yet" }, 200, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/spy-price  (Twelve Data REST 프록시) ───────────
    if (request.method === "GET" && path === "/api/spy-price") {
      try {
        const tdUrl =
          `https://api.twelvedata.com/quote?symbol=SPY&apikey=${env.TWELVE_KEY_SPY}`;
        const tdRes = await fetch(tdUrl, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(5000),
        });
        if (tdRes.ok) {
          const td = await tdRes.json();
          const price = parseFloat(td.close);
          if (!isNaN(price) && price > 0) {
            const prevClose = parseFloat(td.previous_close);
            const change    = !isNaN(prevClose) ? round2(price - prevClose) : null;
            const changePct = !isNaN(prevClose) ? round2((price - prevClose) / prevClose * 100) : null;
            return json({
              price,
              change,
              changePct,
              source: "twelvedata",
              ts:     new Date().toISOString(),
            }, 200, corsHeaders);
          }
        }
      } catch (_) { /* Twelve Data 실패 → KV 폴백 */ }

      const snap = await env.DEX_KV.get("snapshot:1min", { type: "json" });
      if (snap?.spy?.price) {
        return json({ ...snap.spy, source: "kv", ts: snap.ts }, 200, corsHeaders);
      }
      return json({ error: "SPY 가격 없음" }, 503, corsHeaders);
    }

    // ── GET /api/trading-date ──────────────────────────────────
    // Twelve Data 기준 현재 거래일 반환 (단일 기준)
    if (request.method === "GET" && path === "/api/trading-date") {
      try {
        const url = `https://api.twelvedata.com/market_state?exchange=NYSE&apikey=${env.TWELVE_KEY_SPY}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        const nyse = Array.isArray(data)
          ? (data.find(e => e.code === "XNYS") ?? data[0])
          : data;
        if (!nyse) throw new Error("NYSE 데이터 없음");

        const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
        const fmt = (d) => {
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, "0");
          const dd = String(d.getDate()).padStart(2, "0");
          return `${y}-${m}-${dd}`;
        };

        if (nyse.is_market_open) {
          return json({ date: fmt(nowET) }, 200, corsHeaders);
        }

        const hms = nyse.time_to_open;
        if (!hms) throw new Error("time_to_open 없음");
        const parts = hms.split(":").map(Number);
        const totalSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
        const nextOpenET = new Date(nowET.getTime() + totalSec * 1000);
        return json({ date: fmt(nextOpenET) }, 200, corsHeaders);

      } catch (e) {
        const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
        const dow = nowET.getDay();
        if (dow === 0) nowET.setDate(nowET.getDate() + 1);
        if (dow === 6) nowET.setDate(nowET.getDate() + 2);
        const y = nowET.getFullYear();
        const m = String(nowET.getMonth() + 1).padStart(2, "0");
        const d = String(nowET.getDate()).padStart(2, "0");
        return json({ date: `${y}-${m}-${d}`, fallback: true }, 200, corsHeaders);
      }
    }

    // ── POST /api/calculate (Railway 프록시) ───────────────────
    if (request.method === "POST" && path === "/api/calculate") {
      try {
        const res = await fetch(`${env.RAILWAY_URL}/calculate`, {
          method:  "POST",
          headers: {
            "Content-Type":  "application/json",
            "x-cron-secret": env.CRON_SECRET || "",
          },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(60_000),
        });
        const data = await res.json();
        return json(data, res.status, corsHeaders);
      } catch (e) {
        return json({ ok: false, error: e.message }, 500, corsHeaders);
      }
    }

    // ── GET /api/prevclose ─────────────────────────────────────
    if (request.method === "GET" && path === "/api/prevclose") {
      const data = await env.DEX_KV.get("snapshot:prevclose", { type: "json" });
      if (!data) return json({ error: "No prevclose yet" }, 200, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/options-strikes/:symbol ───────────────────────
    // Structure 탭 히트맵용: screener_gex_daily의 strike_data 파싱해서 반환
    const strikesMatch = path.match(/^\/api\/options-strikes\/([a-zA-Z0-9.\-]+)$/i);
    if (request.method === "GET" && strikesMatch) {
      const sym = strikesMatch[1].toUpperCase();

      const rows = await env.DB.prepare(`
        SELECT expiry_date, dte, flip_strike, strike_data
        FROM screener_gex_daily
        WHERE symbol = ? AND strike_data IS NOT NULL
        ORDER BY dte ASC
      `).bind(sym).all();

      const result = [];
      for (const row of (rows.results ?? [])) {
        let strikes = [];
        try { strikes = JSON.parse(row.strike_data); } catch { strikes = []; }
        for (const s of strikes) {
          result.push({
            expiry_date: row.expiry_date,
            dte:         row.dte,
            flip_strike: row.flip_strike,
            ...s,
          });
        }
      }

      return json({ symbol: sym, rows: result }, 200, corsHeaders);
    }

    // ── POST /d1/options-strikes ────────────────────────────────
    // Railway → D1 스트라이크별 IV 저장
    if (request.method === "POST" && path === "/d1/options-strikes") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const { rows } = await request.json();
        if (!Array.isArray(rows) || !rows.length) {
          return json({ ok: false, error: "rows 배열 필요" }, 400, corsHeaders);
        }

        // D1 batch — 한 번의 네트워크 요청으로 전체 INSERT
        const stmts = rows.map(r =>
          env.DB.prepare(`
            INSERT OR REPLACE INTO options_strikes
            (date, symbol, expiry_date, dte, strike, call_iv, put_iv, avg_iv, call_delta, call_oi, put_oi, dex, gex, vanna, charm)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).bind(
            r.date, r.symbol, r.expiry_date, r.dte,
            r.strike, r.call_iv ?? null, r.put_iv ?? null, r.avg_iv ?? null,
            r.call_delta ?? null, r.call_oi ?? null, r.put_oi ?? null,
            r.dex ?? null, r.gex ?? null, r.vanna ?? null, r.charm ?? null,
          )
        );
        await env.DB.batch(stmts);
        return json({ ok: true, inserted: rows.length }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── GET /api/options-dex/:symbol ───────────────────────────
    // Structure 탭용: screener_gex_daily 기반으로 교체
    const optDexMatch = path.match(/^\/api\/options-dex\/([a-zA-Z0-9.\-]+)$/i);
    if (request.method === "GET" && optDexMatch) {
      const sym = optDexMatch[1].toUpperCase();

      const rows = await env.DB.prepare(`
        SELECT
          updated_at as date, symbol, expiry_date, dte, expiry_type,
          call_oi, put_oi, call_vol, put_vol,
          pcr_oi, null as pcr_vol,
          iv_skew, atm_iv, otm_call_iv, otm_put_iv,
          null as atm_put_oi, null as atm_put_oi_ratio,
          dex, net_gex as gex, vanna, charm,
          flip_strike,
          null as otm_call_oi_d, null as otm_put_oi_d, null as hedge_ratio
        FROM screener_gex_daily
        WHERE symbol = ?
        ORDER BY dte ASC
      `).bind(sym).all();

      return json({ symbol: sym, rows: rows.results ?? [] }, 200, corsHeaders);
    }

    // ── GET /api/options-dex/:symbol/history ───────────────────
    // screener_gex_daily는 최신 데이터만 보관하므로 history는 현재 데이터 반환
    const optDexHistMatch = path.match(/^\/api\/options-dex\/([a-zA-Z0-9.\-]+)\/history$/i);
    if (request.method === "GET" && optDexHistMatch) {
      const sym = optDexHistMatch[1].toUpperCase();

      const rows = await env.DB.prepare(`
        SELECT
          updated_at as date, symbol, expiry_date, dte, expiry_type,
          call_oi, put_oi, call_vol, put_vol,
          pcr_oi, null as pcr_vol,
          iv_skew, atm_iv, otm_call_iv, otm_put_iv,
          dex, net_gex as gex, vanna, charm, flip_strike
        FROM screener_gex_daily
        WHERE symbol = ?
        ORDER BY dte ASC
      `).bind(sym).all();

      const result = rows.results ?? [];
      const dates  = result.length ? [result[0].date] : [];

      return json({ symbol: sym, dates, rows: result }, 200, corsHeaders);
    }

    // ── GET /api/symbols (자동완성) ─────────────────────────────
    if (request.method === "GET" && path === "/api/symbols") {
      const q    = url.searchParams.get("q")?.toUpperCase() || "";
      const rows = await env.DB.prepare(`
        SELECT s.symbol, s.name, s.type,
          GROUP_CONCAT(g.code) as groups
        FROM symbols s
        LEFT JOIN symbol_groups sg ON s.symbol = sg.symbol
        LEFT JOIN groups g ON sg.group_id = g.id
        WHERE (s.symbol LIKE ? OR s.name LIKE ?)
        GROUP BY s.symbol
        ORDER BY s.type DESC, s.symbol
        LIMIT 20
      `).bind(q + "%", q + "%").all();
      return json({ symbols: rows.results }, 200, corsHeaders);
    }

    // ── GET /api/admin/quote ────────────────────────────────────
    if (request.method === "GET" && path === "/api/admin/quote") {
      const secret = request.headers.get("x-admin-secret");
      if (secret !== (env.INIT_SECRET || "drbalance-init-2026")) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const sym = url.searchParams.get("symbol");
      if (!sym) return json({ error: "symbol required" }, 400, corsHeaders);
      try {
        const r = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
          { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }
        );
        if (!r.ok) return json({ symbol: sym, name: null }, 200, corsHeaders);
        const d    = await r.json();
        const meta = d?.chart?.result?.[0]?.meta;
        const name = meta?.longName || meta?.shortName || null;
        const type = meta?.instrumentType === "ETF" ? "etf" : "stock";
        return json({ symbol: sym, name, type }, 200, corsHeaders);
      } catch {
        return json({ symbol: sym, name: null }, 200, corsHeaders);
      }
    }

    // ── GET /api/bb-map-symbols ─────────────────────────────────
    if (request.method === "GET" && path === "/api/bb-map-symbols") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const rows = await env.DB.prepare(
        "SELECT symbol, name FROM bb_map_symbols WHERE is_active=1 ORDER BY sort_order, symbol"
      ).all();
      return json({ symbols: rows.results ?? [] }, 200, corsHeaders);
    }

    // ── POST /d1/price-indicators ───────────────────────────────
    if (request.method === "POST" && path === "/d1/price-indicators") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const { rows, mode } = await request.json();
      if (!Array.isArray(rows) || !rows.length) {
        return json({ ok: false, error: "rows 배열 필요" }, 400, corsHeaders);
      }
      const insertMode = mode === 'ignore' ? 'INSERT OR IGNORE' : 'INSERT OR REPLACE';
      const stmts = rows.map(r =>
        env.DB.prepare(`
          ${insertMode} INTO price_indicators
            (date, symbol, close, bb_mid, bb_upper1, bb_lower1,
             bb_upper2, bb_lower2, bb_position, atr5, atr20, vol_ratio,
             avg_volume)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          r.date, r.symbol, r.close,
          r.bb_mid ?? null, r.bb_upper1 ?? null, r.bb_lower1 ?? null,
          r.bb_upper2 ?? null, r.bb_lower2 ?? null, r.bb_position ?? null,
          r.atr5 ?? null, r.atr20 ?? null, r.vol_ratio ?? null,
          r.avg_volume ?? null
        )
      );
      const CHUNK = 50;
      let inserted = 0;
      for (let i = 0; i < stmts.length; i += CHUNK) {
        await env.DB.batch(stmts.slice(i, i + CHUNK));
        inserted += Math.min(CHUNK, stmts.length - i);
      }
      return json({ ok: true, inserted }, 200, corsHeaders);
    }

    // ── GET /api/collect-targets ────────────────────────────────
    if (request.method === "GET" && path === "/api/collect-targets") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const rows = await env.DB.prepare(`
        SELECT DISTINCT s.symbol, s.name, s.type
        FROM symbols s
        JOIN symbol_groups sg ON s.symbol = sg.symbol
        ORDER BY s.type DESC, s.symbol
      `).all();
      return json({ symbols: rows.results ?? [] }, 200, corsHeaders);
    }

    // ── /api/admin/* ────────────────────────────────────────────
    if (path.startsWith("/api/admin/")) {
      return handleAdmin(path, request, env);
    }

    // ════════════════════════════════════════════════════════════
    // SCREENER v4 — watchlist 기반, 만기별 저장
    // ════════════════════════════════════════════════════════════

    // ── GET /api/screener/symbols ───────────────────────────────
    if (request.method === "GET" && path === "/api/screener/symbols") {
      const rows = await env.DB.prepare(`
        SELECT DISTINCT sg.symbol
        FROM symbol_groups sg
        ORDER BY sg.symbol
      `).all();
      return json({ symbols: rows.results ?? [] }, 200, corsHeaders);
    }

    // ── GET /api/screener/symbol/:sym ──────────────────────────
    // structure 탭용: 특정 종목의 집계 데이터 반환 (만기별 rows 포함)
    const screenerSymMatch = path.match(/^\/api\/screener\/symbol\/([A-Z0-9.\-]+)$/i);
    if (request.method === "GET" && screenerSymMatch) {
      const sym = screenerSymMatch[1].toUpperCase();
      const rows = await env.DB.prepare(`
        SELECT
          g.symbol, g.spot_price, g.expiry_date, g.dte, g.expiry_type,
          g.net_gex, g.flip_strike, g.atm_iv, g.call_oi, g.put_oi, g.pcr_oi,
          g.dex, g.vanna, g.charm, g.iv_skew, g.otm_call_iv, g.otm_put_iv,
          g.target_strike, g.concentration_count, g.distance_pct, g.updated_at,
          w.company, w.sector, w.market_cap, w.short_float, w.beta
        FROM screener_gex_daily g
        LEFT JOIN watchlist w ON w.ticker = g.symbol
        WHERE g.symbol = ?
        ORDER BY g.dte ASC
      `).bind(sym).all();

      const all = rows.results ?? [];
      if (!all.length) return json(null, 404, corsHeaders);

      // 종목 단위 집계
      const first    = all[0];
      const totalGex = all.reduce((s, r) => s + (r.net_gex ?? 0), 0);
      const nearestFlip = all.find(r => r.flip_strike)?.flip_strike ?? null;
      const distPct = (first.spot_price && nearestFlip)
        ? Math.round(((first.spot_price - nearestFlip) / nearestFlip) * 10000) / 100
        : null;
      const atmIvAvg = all.filter(r => r.atm_iv).reduce((s, r, _, a) => s + r.atm_iv / a.length, 0) || null;

      return json({
        symbol:              sym,
        spot_price:          first.spot_price,
        company:             first.company    ?? null,
        sector:              first.sector     ?? null,
        market_cap:          first.market_cap ?? null,
        short_float:         first.short_float ?? null,
        beta:                first.beta       ?? null,
        total_gex:           totalGex,
        flip_strike:         nearestFlip,
        distance_pct:        distPct,
        atm_iv:              atmIvAvg,
        target_strike:       first.target_strike,
        concentration_count: first.concentration_count ?? 0,
        updated_at:          first.updated_at,
        expiries:            all,
      }, 200, corsHeaders);
    }

    // ── GET /api/screener/latest ────────────────────────────────
    if (request.method === "GET" && path === "/api/screener/latest") {
      const rows = await env.DB.prepare(`
        SELECT
          g.symbol, g.spot_price, g.expiry_date, g.dte, g.expiry_type,
          g.net_gex, g.flip_strike, g.atm_iv,
          g.call_oi, g.put_oi, g.pcr_oi, g.dex, g.vanna, g.charm,
          g.target_strike, g.concentration_count, g.distance_pct, g.updated_at,
          w.company, w.sector, w.market_cap, w.short_float, w.beta,
          GROUP_CONCAT(DISTINCT gr.code) as groups
        FROM screener_gex_daily g
        LEFT JOIN watchlist w ON w.ticker = g.symbol
        LEFT JOIN symbol_groups sg ON sg.symbol = g.symbol
        LEFT JOIN groups gr ON gr.id = sg.group_id
        GROUP BY g.symbol, g.expiry_date
        ORDER BY g.symbol ASC, g.dte ASC
      `).all();
      return json(rows.results ?? [], 200, corsHeaders);
    }

    // ── POST /d1/screener-gex-daily ────────────────────────────
    // body: { symbol, rows: [...만기별 행], updated_at }
    if (request.method === "POST" && path === "/d1/screener-gex-daily") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const { symbol, rows, updated_at } = await request.json();
        if (!symbol || !Array.isArray(rows) || !rows.length)
          return json({ ok: false, error: "symbol, rows 필요" }, 400, corsHeaders);

        const deleteStmt = env.DB.prepare("DELETE FROM screener_gex_daily WHERE symbol = ?").bind(symbol);
        const insertStmts = rows.map(r => env.DB.prepare(`
          INSERT INTO screener_gex_daily (
            symbol, spot_price, expiry_date, dte, expiry_type,
            net_gex, flip_strike, atm_iv, call_oi, put_oi, pcr_oi,
            dex, vanna, charm,
            call_vol, put_vol, iv_skew, otm_call_iv, otm_put_iv,
            strike_data,
            target_strike, concentration_count, distance_pct, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          symbol,
          r.spot_price    ?? null, r.expiry_date ?? null, r.dte ?? null, r.expiry_type ?? null,
          r.net_gex       ?? null, r.flip_strike ?? null, r.atm_iv      ?? null,
          r.call_oi       ?? null, r.put_oi      ?? null, r.pcr_oi      ?? null,
          r.dex           ?? null, r.vanna       ?? null, r.charm       ?? null,
          r.call_vol      ?? null, r.put_vol     ?? null, r.iv_skew     ?? null,
          r.otm_call_iv   ?? null, r.otm_put_iv  ?? null,
          r.strike_data   ?? null,
          r.target_strike ?? null, r.concentration_count ?? null, r.distance_pct ?? null,
          updated_at      ?? new Date().toISOString()
        ));
        await env.DB.batch([deleteStmt, ...insertStmts]);
        return json({ ok: true, inserted: rows.length }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ════════════════════════════════════════════════════════════
    // WATCHLIST
    // ════════════════════════════════════════════════════════════

    // ════════════════════════════════════════════════════════════
    // RAILWAY 프록시 — admin에서 Railway를 직접 호출하지 않도록
    // RAILWAY_URL, CRON_SECRET은 Workers 환경변수로만 관리
    // ════════════════════════════════════════════════════════════

    // ── GET /api/proxy/watchlist-scan-status ────────────────────
    if (request.method === "GET" && path === "/api/proxy/watchlist-scan-status") {
      const secret = request.headers.get("x-admin-secret");
      if (env.ADMIN_SECRET && secret !== env.ADMIN_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const res = await fetch(`${env.RAILWAY_URL}/watchlist-scan-status`, {
          headers: { "x-cron-secret": env.CRON_SECRET ?? "" },
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json();
        return json(data, 200, corsHeaders);
      } catch (err) {
        return json({ error: err.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/proxy/scan-watchlist ──────────────────────────
    if (request.method === "POST" && path === "/api/proxy/scan-watchlist") {
      const secret = request.headers.get("x-admin-secret");
      if (env.ADMIN_SECRET && secret !== env.ADMIN_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const res = await fetch(`${env.RAILWAY_URL}/scan-watchlist`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-cron-secret": env.CRON_SECRET ?? "",
          },
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json();
        return json(data, res.status, corsHeaders);
      } catch (err) {
        return json({ error: err.message }, 500, corsHeaders);
      }
    }

    // ── GET /api/watchlist ──────────────────────────────────────
    if (request.method === "GET" && path === "/api/watchlist") {
      const rows = await env.DB.prepare(`
        SELECT ticker, company, sector, market_cap, short_float, beta, last_scan_date, is_watchlist
        FROM watchlist ORDER BY is_watchlist DESC, ticker ASC
      `).all();
      return json({ watchlist: rows.results ?? [] }, 200, corsHeaders);
    }

    // ── GET /api/watchlist/candidates ──────────────────────────
    if (request.method === "GET" && path === "/api/watchlist/candidates") {
      const rows = await env.DB.prepare(`
        SELECT ticker, company, sector, market_cap, short_float, beta, last_scan_date
        FROM watchlist WHERE is_watchlist = 0
        ORDER BY last_scan_date ASC NULLS FIRST, ticker ASC
      `).all();
      return json({ candidates: rows.results ?? [] }, 200, corsHeaders);
    }

    // ── POST /api/watchlist ─────────────────────────────────────
    if (request.method === "POST" && path === "/api/watchlist") {
      try {
        const { ticker, is_watchlist } = await request.json();
        if (!ticker) return json({ error: "ticker 필요" }, 400, corsHeaders);
        await env.DB.prepare(`
          INSERT OR IGNORE INTO watchlist (ticker, is_watchlist) VALUES (?, ?)
        `).bind(ticker.toUpperCase(), is_watchlist ? 1 : 0).run();
        return json({ ok: true, ticker: ticker.toUpperCase() }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/watchlist/scan-result ────────────────────────
    if (request.method === "POST" && path === "/api/watchlist/scan-result") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const { ticker, last_scan_date, promote } = await request.json();
        if (!ticker) return json({ error: "ticker 필요" }, 400, corsHeaders);
        if (promote) {
          await env.DB.prepare(`
            UPDATE watchlist SET last_scan_date = ?, is_watchlist = 1 WHERE ticker = ?
          `).bind(last_scan_date, ticker.toUpperCase()).run();
        } else {
          await env.DB.prepare(`
            UPDATE watchlist SET last_scan_date = ? WHERE ticker = ?
          `).bind(last_scan_date, ticker.toUpperCase()).run();
        }
        return json({ ok: true, ticker: ticker.toUpperCase(), promoted: promote ?? false }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── DELETE /api/watchlist/group-reset ──────────────────────
    // 스캔 시작 전 watchlist 그룹 symbol_groups 전체 초기화
    if (request.method === "POST" && path === "/api/watchlist/group-reset") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const group = await env.DB.prepare(
          "SELECT id FROM groups WHERE UPPER(code) = 'WATCHLIST' LIMIT 1"
        ).first();
        if (!group) return json({ ok: false, error: "WATCHLIST 그룹이 존재하지 않습니다." }, 400, corsHeaders);
        await env.DB.prepare(
          "DELETE FROM symbol_groups WHERE group_id = ?"
        ).bind(group.id).run();
        return json({ ok: true, group_id: group.id }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/watchlist/enroll-group ───────────────────────
    // 승격 종목을 symbols + symbol_groups(watchlist 그룹)에 자동 편입
    if (request.method === "POST" && path === "/api/watchlist/enroll-group") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const { ticker } = await request.json();
        if (!ticker) return json({ error: "ticker 필요" }, 400, corsHeaders);
        const sym = ticker.toUpperCase();

        // 1. watchlist 그룹 조회 (대소문자 무관, 수동 생성된 그룹 사용)
        const group = await env.DB.prepare(
          "SELECT id FROM groups WHERE UPPER(code) = 'WATCHLIST' LIMIT 1"
        ).first();
        if (!group) return json({ ok: false, error: "WATCHLIST 그룹이 존재하지 않습니다. admin에서 먼저 생성해주세요." }, 400, corsHeaders);
        const groupId = group.id;

        // 2. symbols 테이블에 추가
        await env.DB.prepare(
          "INSERT OR IGNORE INTO symbols (symbol) VALUES (?)"
        ).bind(sym).run();

        // 2-1. name/type 없으면 Yahoo Finance로 보완
        const existing = await env.DB.prepare(
          "SELECT name, type FROM symbols WHERE symbol = ?"
        ).bind(sym).first();
        if (!existing?.name || !existing?.type) {
          try {
            const yRes = await fetch(
              `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
              { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
            );
            if (yRes.ok) {
              const yData = await yRes.json();
              const meta  = yData?.chart?.result?.[0]?.meta;
              if (meta) {
                const name = meta.longName || meta.shortName || sym;
                const type = meta.instrumentType === 'ETF' ? 'etf' : 'stock';
                await env.DB.prepare(
                  "UPDATE symbols SET name=?, type=? WHERE symbol=?"
                ).bind(name, type, sym).run();
              }
            }
          } catch (e) {
            console.warn(`[enroll-group] ${sym} name/type 갱신 실패:`, e.message);
          }
        }

        // 3. symbol_groups에 연결
        await env.DB.prepare(
          "INSERT OR IGNORE INTO symbol_groups (symbol, group_id) VALUES (?, ?)"
        ).bind(sym, groupId).run();

        return json({ ok: true, ticker: sym, group_id: groupId }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/watchlist/prune ───────────────────────────
    // 기준 미달 종목을 watchlist 그룹에서 제거 + is_watchlist = 0
    if (request.method === "POST" && path === "/api/watchlist/prune") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const { ticker } = await request.json();
        if (!ticker) return json({ error: "ticker 필요" }, 400, corsHeaders);
        const sym = ticker.toUpperCase();

        // watchlist 그룹 ID 조회
        const group = await env.DB.prepare(
          "SELECT id FROM groups WHERE UPPER(code) = 'WATCHLIST' LIMIT 1"
        ).first();

        if (group) {
          await env.DB.prepare(
            "DELETE FROM symbol_groups WHERE group_id = ? AND symbol = ?"
          ).bind(group.id, sym).run();
        }

        // watchlist 테이블 is_watchlist = 0 재설정
        await env.DB.prepare(
          "UPDATE watchlist SET is_watchlist = 0 WHERE ticker = ?"
        ).bind(sym).run();

        // screener_gex_daily 데이터 삭제
        await env.DB.prepare(
          "DELETE FROM screener_gex_daily WHERE symbol = ?"
        ).bind(sym).run();

        return json({ ok: true, ticker: sym }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }


    if (request.method === "POST" && path === "/api/watchlist/demote") {
      try {
        const { ticker } = await request.json();
        if (!ticker) return json({ error: "ticker 필요" }, 400, corsHeaders);
        await env.DB.prepare(`UPDATE watchlist SET is_watchlist = 0 WHERE ticker = ?`).bind(ticker.toUpperCase()).run();
        return json({ ok: true, ticker: ticker.toUpperCase() }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── DELETE /api/watchlist/:ticker ───────────────────────────
    const watchlistDelMatch = path.match(/^\/api\/watchlist\/([A-Z0-9.\-]+)$/i);
    if (request.method === "DELETE" && watchlistDelMatch) {
      const ticker = watchlistDelMatch[1].toUpperCase();
      await env.DB.prepare("DELETE FROM watchlist WHERE ticker = ?").bind(ticker).run();
      await env.DB.prepare("DELETE FROM screener_gex_daily WHERE symbol = ?").bind(ticker).run();
      return json({ ok: true, ticker }, 200, corsHeaders);
    }

    // ── POST /d1/options-dex ────────────────────────────────────
    if (request.method === "POST" && path === "/d1/options-dex") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const { rows } = await request.json();
      if (!Array.isArray(rows) || !rows.length) {
        return json({ ok: false, error: "rows 배열 필요" }, 400, corsHeaders);
      }
      const CHUNK = 50;
      let inserted = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const stmts = chunk.map(r =>
          env.DB.prepare(`
            INSERT OR REPLACE INTO options_dex (
              date, symbol, expiry_date, dte,
              call_oi, put_oi, call_vol, put_vol,
              pcr_oi, pcr_vol, iv_skew, atm_iv, otm_call_iv, otm_put_iv,
              dex, gex, vanna, charm,
              atm_put_oi, atm_put_oi_ratio,
              otm_call_theo, otm_call_delta,
              flip_strike, otm_call_oi_d, otm_put_oi_d, hedge_ratio
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).bind(
            r.date, r.symbol, r.expiry_date, r.dte,
            r.call_oi ?? 0, r.put_oi ?? 0, r.call_vol ?? 0, r.put_vol ?? 0,
            r.pcr_oi ?? null, r.pcr_vol ?? null,
            r.iv_skew ?? null, r.atm_iv ?? null,
            r.otm_call_iv ?? null, r.otm_put_iv ?? null,
            r.dex ?? null, r.gex ?? null, r.vanna ?? null, r.charm ?? null,
            r.atm_put_oi ?? null, r.atm_put_oi_ratio ?? null,
            r.otm_call_theo ?? null, r.otm_call_delta ?? null,
            r.flip_strike ?? null, r.otm_call_oi_d ?? null,
            r.otm_put_oi_d ?? null, r.hedge_ratio ?? null,
          )
        );
        await env.DB.batch(stmts);
        inserted += chunk.length;
      }
      return json({ ok: true, inserted }, 200, corsHeaders);
    }

    // ── POST /d1/spy-snapshot ────────────────────────────────────
    if (request.method === "POST" && path === "/d1/spy-snapshot") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const payload = await request.json();
      const {
        ts, date, spot,
        total_gex, total_vanna, total_charm, total_dex,
        total_call_volume, total_put_volume,
        pcr, flip_zone,
        strikes,
      } = payload;

      if (!ts || !date || !Array.isArray(strikes) || strikes.length === 0) {
        return json({ error: "ts, date, strikes 필수" }, 400, corsHeaders);
      }

      const stmts = strikes.map(s =>
        env.DB.prepare(`
          INSERT OR REPLACE INTO spy_strikes_snapshot
            (ts, date, spot,
             total_gex, total_vanna, total_charm, total_dex,
             total_call_volume, total_put_volume,
             pcr, flip_zone,
             strike, call_oi, put_oi, call_oi_15m, put_oi_15m,
             call_volume, put_volume,
             dex, gex, vanna, charm)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          ts, date, spot ?? null,
          total_gex ?? null, total_vanna ?? null, total_charm ?? null, total_dex ?? null,
          total_call_volume ?? null, total_put_volume ?? null,
          pcr ?? null, flip_zone ?? null,
          s.strike,
          s.call_oi ?? null, s.put_oi ?? null,
          s.call_oi_15m ?? null, s.put_oi_15m ?? null,
          s.call_volume ?? null, s.put_volume ?? null,
          s.dex ?? null, s.gex ?? null, s.vanna ?? null, s.charm ?? null,
        )
      );

      await env.DB.batch(stmts);
      return json({ ok: true, inserted: stmts.length }, 200, corsHeaders);
    }

    // ── POST /d1/screener-scores ────────────────────────────────
    if (request.method === "POST" && path === "/d1/screener-scores") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const { rows } = await request.json();
      if (!Array.isArray(rows) || !rows.length) {
        return json({ ok: false, error: "rows 배열 필요" }, 400, corsHeaders);
      }
      const CHUNK = 50;
      let inserted = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const stmts = chunk.map(r =>
          env.DB.prepare(`
            INSERT OR REPLACE INTO screener_scores (
              date, symbol,
              close, bb_position, bb_flag, iv_skew,
              score_skew, score_bb, score_vol_squeeze,
              skew_strength, total_score,
              strength_score, timing_grade, flip_strike, monthly_count
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).bind(
            r.date, r.symbol,
            r.close ?? null, r.bb_position ?? null,
            r.bb_flag ?? null, r.iv_skew ?? null,
            r.score_skew ?? 0, r.score_bb ?? 0, r.score_vol_squeeze ?? 0,
            r.skew_strength ?? null, r.total_score ?? 0,
            r.strength_score ?? null, r.timing_grade ?? null,
            r.flip_strike ?? null, r.monthly_count ?? null,
          )
        );
        await env.DB.batch(stmts);
        inserted += chunk.length;
      }
      return json({ ok: true, inserted }, 200, corsHeaders);
    }

    // ── GET /api/bb-map-chart ───────────────────────────────────
    if (request.method === "GET" && path === "/api/bb-map-chart") {
      const range = url.searchParams.get("range") || "3m";

      const now = new Date();
      let fromDate = null;
      if (range !== "all") {
        const d = new Date(now);
        if      (range === "3w") d.setDate(d.getDate() - 21);
        else if (range === "2w") d.setDate(d.getDate() - 14);
        else if (range === "1m") d.setMonth(d.getMonth() - 1);
        else if (range === "3m") d.setMonth(d.getMonth() - 3);
        else if (range === "6m") d.setMonth(d.getMonth() - 6);
        else if (range === "1y") d.setFullYear(d.getFullYear() - 1);
        fromDate = d.toISOString().slice(0, 10);
      }

      const symRows = await env.DB.prepare(
        "SELECT symbol, name FROM bb_map_symbols WHERE is_active=1 ORDER BY sort_order, symbol"
      ).all();
      const symbols = symRows.results ?? [];
      if (!symbols.length) return json({ symbols: [], dates: [], series: {} }, 200, corsHeaders);

      const symList = symbols.map(s => s.symbol);
      const placeholders = symList.map(() => "?").join(",");
      const binds = fromDate ? [...symList, fromDate] : symList;
      const whereDate = fromDate ? "AND date >= ?" : "";

      const rows = await env.DB.prepare(`
        SELECT date, symbol, bb_position
        FROM price_indicators
        WHERE symbol IN (${placeholders}) ${whereDate}
          AND bb_position IS NOT NULL
        ORDER BY date ASC
      `).bind(...binds).all();

      const dateSet = [...new Set((rows.results ?? []).map(r => r.date))].sort();
      const seriesMap = {};
      for (const sym of symList) seriesMap[sym] = {};
      for (const r of (rows.results ?? [])) {
        if (seriesMap[r.symbol]) seriesMap[r.symbol][r.date] = r.bb_position;
      }
      const series = {};
      for (const sym of symList) {
        series[sym] = dateSet.map(d => seriesMap[sym][d] ?? null);
      }

      return json({
        symbols: symbols.map(s => ({ symbol: s.symbol, name: s.name })),
        dates:   dateSet,
        series,
      }, 200, corsHeaders);
    }

    // ── GET /api/rescore-data ───────────────────────────────────
    if (request.method === "GET" && path === "/api/rescore-data") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const latestDex = await env.DB.prepare(
        "SELECT MAX(date) as d FROM options_dex"
      ).first();
      const dexDate = latestDex?.d;
      if (!dexDate) return json({ dex: [], pi: [], meta: [] }, 200, corsHeaders);

      const dexRows = await env.DB.prepare(`
        SELECT symbol, expiry_date, dte,
               call_oi, put_oi, iv_skew, atm_iv,
               otm_call_iv, otm_put_iv, atm_put_oi_ratio,
               otm_call_theo, otm_call_delta,
               dex, gex, vanna, charm
        FROM options_dex
        WHERE date = ?
        ORDER BY symbol, dte ASC
      `).bind(dexDate).all();

      const latestPI = await env.DB.prepare(
        "SELECT MAX(date) as d FROM price_indicators"
      ).first();
      const piDate = latestPI?.d;
      const piRows = piDate ? await env.DB.prepare(`
        SELECT symbol, bb_position, vol_ratio, close
        FROM price_indicators
        WHERE date = ?
      `).bind(piDate).all() : { results: [] };

      const metaRows = await env.DB.prepare(`
        SELECT symbol, name, type FROM symbols
      `).all();

      return json({
        dex_date: dexDate,
        pi_date:  piDate,
        dex:      dexRows.results  ?? [],
        pi:       piRows.results   ?? [],
        meta:     metaRows.results ?? [],
      }, 200, corsHeaders);
    }

    // ── GET /api/structure/:symbol ──────────────────────────────
    const structMatch = path.match(/^\/api\/structure\/([A-Z0-9.\-]+)$/);
    if (request.method === "GET" && structMatch) {
      const symbol = structMatch[1].toUpperCase();

      const rows = await env.DB.prepare(`
        SELECT
          updated_at as date, symbol, expiry_date, dte, expiry_type,
          call_oi, put_oi, call_vol, put_vol, pcr_oi,
          iv_skew, atm_iv, otm_call_iv, otm_put_iv,
          dex, net_gex as gex, vanna, charm, flip_strike,
          spot_price
        FROM screener_gex_daily
        WHERE symbol = ? AND dte BETWEEN 0 AND 65
        ORDER BY dte ASC
      `).bind(symbol).all();

      const all = rows.results ?? [];

      if (!all.length) {
        return json({ monthly: [], weekly: null, context: null }, 200, corsHeaders);
      }

      const latestDate = all[0]?.date ?? null;

      // expiry_type 기반으로 monthly/weekly 분류
      const enriched = all.map(r => ({
        ...r,
        is_monthly: r.expiry_type === 'monthly' ? 1 : 0,
        net_oi: (r.call_oi || 0) - (r.put_oi || 0),
      }));

      const monthlyRows = enriched
        .filter(r => r.is_monthly === 1)
        .sort((a, b) => a.dte - b.dte)
        .slice(0, 2);

      const weeklyRows = enriched.filter(r => r.is_monthly === 0);

      let featuredWeekly = null;
      if (weeklyRows.length > 0) {
        const avgNetOI  = weeklyRows.reduce((s, r) => s + Math.abs(r.net_oi), 0) / weeklyRows.length;
        const threshold = avgNetOI * 1.5;
        const candidates = weeklyRows
          .filter(r => Math.abs(r.net_oi) > threshold)
          .sort((a, b) => Math.abs(b.net_oi) - Math.abs(a.net_oi));
        if (candidates.length > 0) featuredWeekly = candidates[0];
      }

      const nextMonthly   = monthlyRows[0] ?? null;
      const opexDte       = nextMonthly?.dte ?? null;
      const thisWeekExpiry = weeklyRows
        .filter(r => r.dte >= 0 && r.dte <= 6)
        .sort((a, b) => a.dte - b.dte)[0] ?? null;

      const vannaSum  = monthlyRows.reduce((s, r) => s + (r.vanna || 0), 0);
      const charmSum  = monthlyRows.reduce((s, r) => s + (r.charm || 0), 0);
      const monthlySkews = monthlyRows.map(r => r.iv_skew).filter(v => v != null);
      const skewAligned  = monthlySkews.length >= 2
        ? (monthlySkews[0] > 0) === (monthlySkews[1] > 0)
        : false;

      return json({
        date:    latestDate,
        symbol,
        monthly: monthlyRows,
        weekly:  featuredWeekly,
        context: {
          opex_dte:         opexDte,
          this_week_expiry: thisWeekExpiry ? thisWeekExpiry.expiry_date : null,
          this_week_dte:    thisWeekExpiry?.dte ?? null,
          vanna_sum:        +vannaSum.toFixed(4),
          charm_sum:        +charmSum.toFixed(4),
          skew_aligned:     skewAligned,
          weekly_featured:  featuredWeekly != null,
        },
      }, 200, corsHeaders);
    }

    // ── GET /api/etf-holdings/:ticker ───────────────────────────
    // 인증 없음 — 프론트 BB맵에서 직접 호출
    const etfMatch = path.match(/^\/api\/etf-holdings\/([A-Z0-9.\-]+)$/i);
    if (request.method === "GET" && etfMatch) {
      const ticker = etfMatch[1].toUpperCase();
      const rows = await env.DB.prepare(
        "SELECT symbol, name, pct FROM etf_holdings WHERE etf = ? ORDER BY pct DESC"
      ).bind(ticker).all();
      if (!rows.results?.length) {
        return json({ etf: ticker, holdings: [] }, 200, corsHeaders);
      }
      return json({ etf: ticker, holdings: rows.results }, 200, corsHeaders);
    }

    // ── Health check ────────────────────────────────────────────
    if (path === "/health") {
      return json({ status: "ok", ts: new Date().toISOString() }, 200, corsHeaders);
    }

    return json({ error: "Not found" }, 404, corsHeaders);
  },

};

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
