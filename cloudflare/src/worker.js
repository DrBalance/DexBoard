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
// SCREENER v5 (screened_tickers 기반)
//   GET  /api/screener/symbols        → screened_tickers 심볼 목록
//   GET  /api/screener/latest         → daily_screener + screened_tickers JOIN
//   POST /d1/daily-screener           → Railway → D1 저장 (DELETE+INSERT)
//   POST /d1/screened-tickers/update  → screened_tickers 집계값 업데이트
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

    // ── GET /api/options-dex/:symbol ───────────────────────────
    // Structure 탭용: daily_screener 기반
    const optDexMatch = path.match(/^\/api\/options-dex\/([a-zA-Z0-9.\-]+)$/i);
    if (request.method === "GET" && optDexMatch) {
      const sym = optDexMatch[1].toUpperCase();

      const rows = await env.DB.prepare(`
        SELECT
          updated_at as date, ticker as symbol, expiry_date, dte, expiry_type,
          call_oi, put_oi, call_vol, put_vol,
          pcr_oi, null as pcr_vol,
          iv_skew, atm_iv, otm_call_iv, otm_put_iv,
          null as atm_put_oi, null as atm_put_oi_ratio,
          dex, net_gex as gex, vanna, charm,
          flip_strike,
          null as otm_call_oi_d, null as otm_put_oi_d, null as hedge_ratio
        FROM daily_screener
        WHERE ticker = ?
        ORDER BY dte ASC
      `).bind(sym).all();

      return json({ symbol: sym, rows: rows.results ?? [] }, 200, corsHeaders);
    }

    // ── GET /api/options-dex/:symbol/history ───────────────────
    // daily_screener는 최신 데이터만 보관하므로 history는 현재 데이터 반환
    const optDexHistMatch = path.match(/^\/api\/options-dex\/([a-zA-Z0-9.\-]+)\/history$/i);
    if (request.method === "GET" && optDexHistMatch) {
      const sym = optDexHistMatch[1].toUpperCase();

      const rows = await env.DB.prepare(`
        SELECT
          updated_at as date, ticker as symbol, expiry_date, dte, expiry_type,
          call_oi, put_oi, call_vol, put_vol,
          pcr_oi, null as pcr_vol,
          iv_skew, atm_iv, otm_call_iv, otm_put_iv,
          dex, net_gex as gex, vanna, charm, flip_strike
        FROM daily_screener
        WHERE ticker = ?
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
        SELECT w.ticker as symbol, w.company as name,
          GROUP_CONCAT(DISTINCT st.group_code) as groups
        FROM watchlist w
        LEFT JOIN screened_tickers st ON w.ticker = st.ticker
        WHERE (w.ticker LIKE ? OR w.company LIKE ?)
        GROUP BY w.ticker
        ORDER BY w.ticker
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
        SELECT DISTINCT st.ticker as symbol, w.company as name
        FROM screened_tickers st
        LEFT JOIN watchlist w ON w.ticker = st.ticker
        ORDER BY st.ticker
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

    // ── POST /api/screener/rollup-check ─────────────────────────
    // ET 09:50 롤업 감지: 현재 target_strike vs 새 target_strike 비교
    // 변경 시 rollup_history 테이블에 기록
    if (request.method === "POST" && path === "/api/screener/rollup-check") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const { ticker, new_strike, new_spot } = await request.json();
        if (!ticker || !new_strike) return json({ error: "ticker, new_strike 필요" }, 400, corsHeaders);
        const sym = ticker.toUpperCase();

        // 현재 저장된 target_strike 조회
        const current = await env.DB.prepare(
          "SELECT target_strike FROM screened_tickers WHERE ticker = ? LIMIT 1"
        ).bind(sym).first();

        if (!current) return json({ ok: false, reason: "not_found" }, 200, corsHeaders);

        const oldStrike = current.target_strike;
        const changed   = new_strike !== oldStrike;
        const direction = new_strike > oldStrike ? 'rollup' : 'rolldown';

        if (changed) {
          // rollup_history 기록
          await env.DB.prepare(`
            INSERT INTO rollup_history (ticker, old_strike, new_strike, spot_price, direction, detected_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(sym, oldStrike, new_strike, new_spot ?? null, direction, new Date().toISOString()).run();

          // screened_tickers target_strike 항상 업데이트
          await env.DB.prepare(
            "UPDATE screened_tickers SET target_strike = ? WHERE ticker = ?"
          ).bind(new_strike, sym).run();
        }

        return json({ ok: true, ticker: sym, changed, direction: changed ? direction : null, old_strike: oldStrike, new_strike }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/screener/market-snapshot ───────────────────────
    // 커버드콜 활성 종목 수를 rollup_history(ticker='MARKET')에 기록
    if (request.method === "POST" && path === "/api/screener/market-snapshot") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const { count } = await request.json();
        if (count == null) return json({ error: "count 필요" }, 400, corsHeaders);

        // 직전 MARKET row 조회 (old_strike = 전날 수치)
        const prev = await env.DB.prepare(
          "SELECT new_strike FROM rollup_history WHERE ticker = 'MARKET' ORDER BY detected_at DESC LIMIT 1"
        ).first();

        const oldCount  = prev?.new_strike ?? null;
        const direction = oldCount == null ? 'init'
          : count > oldCount ? 'rollup'
          : count < oldCount ? 'rolldown'
          : 'flat';

        await env.DB.prepare(`
          INSERT INTO rollup_history (ticker, old_strike, new_strike, spot_price, direction, detected_at)
          VALUES ('MARKET', ?, ?, ?, ?, ?)
        `).bind(oldCount, count, count, direction, new Date().toISOString()).run();

        return json({ ok: true, old: oldCount, new: count, direction }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── GET /api/screener/rollup-history ─────────────────────────
    // 롤업 이력 조회 (active_only=true 시 현재 screened_tickers 종목만)
    if (request.method === "GET" && path === "/api/screener/rollup-history") {
      const activeOnly = url.searchParams.get("active_only") === "true";
      try {
        let query;
        if (activeOnly) {
          query = `
            SELECT rh.id, rh.ticker, rh.old_strike, rh.new_strike, rh.spot_price, rh.detected_at
            FROM rollup_history rh
            INNER JOIN screened_tickers st ON st.ticker = rh.ticker
            WHERE rh.ticker != 'MARKET'
            ORDER BY rh.detected_at DESC
            LIMIT 200
          `;
        } else {
          query = `
            SELECT id, ticker, old_strike, new_strike, spot_price, detected_at
            FROM rollup_history
            WHERE ticker != 'MARKET'
            ORDER BY detected_at DESC
            LIMIT 200
          `;
        }
        const rows = await env.DB.prepare(query).all();
        return json({ history: rows.results ?? [] }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── GET /api/events ───────────────────────────────────────────
    // 향후 N일간 이벤트 (Finnhub, KV 1시간 캐시)
    // - earnings: watchlist 종목으로 한정, screened 종목은 프론트에서 강조
    // - economic: FOMC/CPI/NFP/GDP 화이트리스트 필터 + 날짜×카테고리 그룹핑
    // - screenedSymbols 목록도 함께 반환 (프론트 강조용)
    if (request.method === "GET" && path === "/api/events") {
      const days     = Math.min(parseInt(url.searchParams.get("days") ?? "14"), 30);
      const force    = url.searchParams.get("force") === "1";
      const cacheKey = `events:finnhub:${days}`;

      // KV 캐시 확인 (force=1이면 스킵)
      if (!force) {
        try {
          const cached = await env.DEX_KV.get(cacheKey);
          if (cached) {
            return new Response(cached, { headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "HIT" } });
          }
        } catch {}
      }

      const today  = new Date();
      const toDate = new Date(today);
      toDate.setDate(today.getDate() + days);
      const from = today.toISOString().slice(0, 10);
      const to   = toDate.toISOString().slice(0, 10);
      const FINNHUB = env.FINNHUB_KEY;

      // screened_tickers 심볼 목록 조회 (프론트 강조용)
      let screenedSymbols = [];
      try {
        const rows = await env.DB.prepare(
          `SELECT DISTINCT symbol FROM screened_tickers`
        ).all();
        screenedSymbols = (rows.results ?? []).map(r => r.symbol);
      } catch {}

      // watchlist 심볼 목록 + 메타데이터 조회 (earnings 필터 및 기업정보용)
      let watchlistSymbols = new Set();
      let watchlistMeta = {}; // ticker → { company, beta, short_float }
      try {
        const rows = await env.DB.prepare(
          `SELECT ticker, company, beta, short_float FROM watchlist`
        ).all();
        (rows.results ?? []).forEach(r => {
          watchlistSymbols.add(r.ticker);
          watchlistMeta[r.ticker] = {
            company:     r.company ?? null,
            beta:        r.beta ?? null,
            short_float: r.short_float ?? null,
          };
        });
      } catch {}

      try {
        // ── ① Finnhub earnings calendar (워치리스트 종목만)
        const earningsRes = await fetch(
          `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${FINNHUB}`,
          { signal: AbortSignal.timeout(10000) }
        );
        const earningsData = earningsRes.ok ? await earningsRes.json() : { earningsCalendar: [] };
        const earningsList = (earningsData.earningsCalendar ?? [])
          .filter(e => watchlistSymbols.has(e.symbol))
          .map(e => ({
            type:        'earnings',
            date:        e.date,
            symbol:      e.symbol,
            company:     watchlistMeta[e.symbol]?.company ?? null,
            beta:        watchlistMeta[e.symbol]?.beta ?? null,
            short_float: watchlistMeta[e.symbol]?.short_float ?? null,
            eps_estimate: e.epsEstimate ?? null,
            timing:      e.hour?.toUpperCase() ?? null, // 'bmo'→'BMO', 'amc'→'AMC'
          }));

        // ── ② Finnhub economic calendar (화이트리스트 필터 + 그룹핑)
        const MACRO_WHITELIST = [
          { key: 'FOMC',  patterns: ['fomc', 'federal reserve', 'fed rate', 'federal open market', 'powell', 'waller', 'barkin', 'kashkari', 'daly', 'bostic', 'williams', 'jefferson', 'cook', 'kugler', 'logan', 'musalem', 'schmid', 'hammack'] },
          { key: 'CPI',   patterns: ['cpi', 'consumer price', 'ppi', 'producer price', 'core inflation', 'inflation'] },
          { key: 'NFP',   patterns: ['nonfarm', 'non-farm', 'nfp', 'unemployment', 'jobless', 'payroll', 'labor'] },
          { key: 'GDP',   patterns: ['gdp', 'gross domestic'] },
          { key: 'RETAIL',patterns: ['retail sales'] },
        ];

        const getCategory = (eventName) => {
          const lower = (eventName ?? '').toLowerCase();
          for (const { key, patterns } of MACRO_WHITELIST) {
            if (patterns.some(p => lower.includes(p))) return key;
          }
          return null;
        };

        const ecoRes = await fetch(
          `https://finnhub.io/api/v1/calendar/economic?token=${FINNHUB}`,
          { signal: AbortSignal.timeout(10000) }
        );
        const ecoData = ecoRes.ok ? await ecoRes.json() : { economicCalendar: [] };

        // 날짜 범위 필터 + 카테고리 분류
        // 같은 날짜 × 카테고리로 그룹핑
        const ecoGroupMap = {}; // key: `${date}:${category}`
        for (const e of (ecoData.economicCalendar ?? [])) {
          if (!e.eventName || !e.time) continue;
          const dateStr = e.time.slice(0, 10);
          if (dateStr < from || dateStr > to) continue;
          const category = getCategory(e.eventName);
          if (!category) continue;

          const groupKey = `${dateStr}:${category}`;
          if (!ecoGroupMap[groupKey]) {
            ecoGroupMap[groupKey] = { date: dateStr, category, names: [] };
          }
          // 중복 이름 방지
          const shortName = e.eventName.trim();
          if (!ecoGroupMap[groupKey].names.includes(shortName)) {
            ecoGroupMap[groupKey].names.push(shortName);
          }
        }

        // 그룹핑된 경제 이벤트 → events 배열로 변환
        const economicList = Object.values(ecoGroupMap).map(g => ({
          type:     'economic',
          date:     g.date,
          category: g.category,
          // "FOMC - Waller, Powell, Barkin" 형식
          title:    `${g.category} - ${g.names.join(', ')}`,
        }));

        // ── 합산 + 날짜순 정렬
        const events = [...earningsList, ...economicList]
          .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

        const payload = JSON.stringify({ ok: true, from, to, events, screenedSymbols });

        // KV 캐시 저장 (24시간)
        try { await env.DEX_KV.put(cacheKey, payload, { expirationTtl: 86400 }); } catch {}

        return new Response(payload, { headers: { ...corsHeaders, "Content-Type": "application/json" } });

      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── GET /api/live-prices ─────────────────────────────────────
    // Yahoo Finance batch quote 프록시 (CORS 우회)
    // ?symbols=AAPL,NVDA,MSFT
    // 반환: { quotes: [{ symbol, regularMarketPrice, marketState }, ...] }
    if (request.method === "GET" && path === "/api/live-prices") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const symbolsParam = new URL(request.url).searchParams.get("symbols") ?? "";
        if (!symbolsParam) return json({ error: "symbols 파라미터 필요" }, 400, corsHeaders);

        const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbolsParam)}&fields=regularMarketPrice,marketState`;
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal:  AbortSignal.timeout(12000),
        });
        if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);

        const data   = await res.json();
        const result = data?.quoteResponse?.result ?? [];
        const quotes = result.map(q => ({
          symbol:              q.symbol,
          regularMarketPrice:  q.regularMarketPrice ?? null,
          marketState:         q.marketState        ?? null,
        }));
        return json({ ok: true, quotes }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── GET /api/screener/price-targets ─────────────────────────
    // updateLivePrices() 전용: target_strike + flip_strike만 반환 (경량)
    // screener/latest 전체 조회 대신 사용 (인증 불필요 — 읽기 전용 공개 데이터)
    if (request.method === "GET" && path === "/api/screener/price-targets") {
      try {
        const rows = await env.DB.prepare(`
          SELECT ticker as symbol, target_strike, flip_strike, spot_price
          FROM screened_tickers
          ORDER BY ticker ASC
        `).all();
        return json({ targets: rows.results ?? [] }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── GET /api/screener/symbols ───────────────────────────────
    if (request.method === "GET" && path === "/api/screener/symbols") {
      const rows = await env.DB.prepare(`
        SELECT DISTINCT ticker as symbol
        FROM screened_tickers
        ORDER BY ticker
      `).all();
      return json({ symbols: rows.results ?? [] }, 200, corsHeaders);
    }

    // ── GET /api/screener/prune-candidates ─────────────────────
    // pruneWatchlistGroup에서 사용: WATCHLIST 그룹의 기준 미달 후보
    if (request.method === "GET" && path === "/api/screener/prune-candidates") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const rows = await env.DB.prepare(`
        SELECT ticker, concentration_count, upside
        FROM screened_tickers
        WHERE group_code = 'WATCHLIST'
        AND (concentration_count <= 3 OR upside < 3)
        AND ticker NOT IN (
          SELECT ticker FROM screened_tickers WHERE group_code = 'MONITOR'
        )
      `).all();
      return json({ candidates: rows.results ?? [] }, 200, corsHeaders);
    }

    // ── POST /api/watchlist/sync-is-watchlist ───────────────────
    // screened_tickers 기준으로 is_watchlist 동기화
    if (request.method === "POST" && path === "/api/watchlist/sync-is-watchlist") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        await env.DB.batch([
          env.DB.prepare("UPDATE watchlist SET is_watchlist = 0"),
          env.DB.prepare(`
            UPDATE watchlist SET is_watchlist = 1
            WHERE ticker IN (
              SELECT ticker FROM screened_tickers WHERE group_code = 'WATCHLIST'
            )
          `),
        ]);
        return json({ ok: true }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── GET /api/screener/symbol/:sym ──────────────────────────
    // structure 탭용: 특정 종목의 집계 데이터 반환 (만기별 rows 포함)
    const screenerSymMatch = path.match(/^\/api\/screener\/symbol\/([A-Z0-9.\-]+)$/i);
    if (request.method === "GET" && screenerSymMatch) {
      const sym = screenerSymMatch[1].toUpperCase();
      const rows = await env.DB.prepare(`
        SELECT
          d.ticker as symbol, st.spot_price, d.expiry_date, d.dte, d.expiry_type,
          d.net_gex, d.flip_strike, d.atm_iv, d.call_oi, d.put_oi, d.pcr_oi,
          d.dex, d.vanna, d.charm, d.iv_skew, d.otm_call_iv, d.otm_put_iv,
          st.target_strike, st.concentration_count, st.upside, d.updated_at,
          w.company, w.sector, w.market_cap, w.short_float, w.beta
        FROM daily_screener d
        LEFT JOIN screened_tickers st ON st.ticker = d.ticker
        LEFT JOIN watchlist w ON w.ticker = d.ticker
        WHERE d.ticker = ?
      `).bind(sym).all();

      const all = rows.results ?? [];
      if (!all.length) return json(null, 404, corsHeaders);

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
        upside:              first.upside ?? null,
        updated_at:          first.updated_at,
        expiries:            all,
      }, 200, corsHeaders);
    }

    // ── GET /api/screener/latest ────────────────────────────────
    if (request.method === "GET" && path === "/api/screener/latest") {
      const symbolFilter = url.searchParams.get("symbol")?.toUpperCase() ?? null;
      const baseQuery = `
        SELECT
          d.ticker as symbol, st.spot_price, d.expiry_date, d.dte, d.expiry_type,
          d.net_gex, d.flip_strike, d.atm_iv,
          d.call_oi, d.put_oi, d.pcr_oi, d.dex, d.vanna, d.charm,
          d.peak_call_dex_strike, d.peak_call_dex_value,
          st.target_strike, st.concentration_count, st.upside,
          st.squeeze_stars, st.squeeze_flags,
          st.vanna_limit, st.vanna_coverage, st.call_dex_sum,
          d.updated_at,
          w.company, w.sector, w.market_cap, w.short_float, w.beta,
          GROUP_CONCAT(DISTINCT st.group_code) as groups,
          GROUP_CONCAT(DISTINCT g.name) as group_names
        FROM daily_screener d
        LEFT JOIN screened_tickers st ON st.ticker = d.ticker
        LEFT JOIN groups g ON g.code = st.group_code
        LEFT JOIN watchlist w ON w.ticker = d.ticker
        ${symbolFilter ? 'WHERE d.ticker = ?' : ''}
        GROUP BY d.ticker, d.expiry_date
        ORDER BY d.ticker ASC, d.dte ASC
      `;
      const rows = symbolFilter
        ? await env.DB.prepare(baseQuery).bind(symbolFilter).all()
        : await env.DB.prepare(baseQuery).all();
      return json(rows.results ?? [], 200, corsHeaders);
    }

    // ── POST /d1/daily-screener ────────────────────────────────
    // body: { ticker, rows: [...만기별 행], updated_at }
    if (request.method === "POST" && path === "/d1/daily-screener") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const { ticker, rows, updated_at } = await request.json();
        if (!ticker || !Array.isArray(rows) || !rows.length)
          return json({ ok: false, error: "ticker, rows 필요" }, 400, corsHeaders);

        const deleteStmt = env.DB.prepare("DELETE FROM daily_screener WHERE ticker = ?").bind(ticker);
        const insertStmts = rows.map(r => env.DB.prepare(`
          INSERT INTO daily_screener (
            ticker, expiry_date, dte, expiry_type,
            net_gex, flip_strike, atm_iv, call_oi, put_oi, pcr_oi,
            dex, vanna, charm,
            call_vol, put_vol, iv_skew, otm_call_iv, otm_put_iv,
            strike_data, peak_call_dex_strike, peak_call_dex_value, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          ticker,
          r.expiry_date ?? null, r.dte ?? null, r.expiry_type ?? null,
          r.net_gex       ?? null, r.flip_strike ?? null, r.atm_iv      ?? null,
          r.call_oi       ?? null, r.put_oi      ?? null, r.pcr_oi      ?? null,
          r.dex           ?? null, r.vanna       ?? null, r.charm       ?? null,
          r.call_vol      ?? null, r.put_vol     ?? null, r.iv_skew     ?? null,
          r.otm_call_iv   ?? null, r.otm_put_iv  ?? null,
          r.strike_data        ?? null,
          r.peak_call_dex_strike ?? null,
          r.peak_call_dex_value  ?? null,
          updated_at      ?? new Date().toISOString()
        ));
        await env.DB.batch([deleteStmt, ...insertStmts]);
        return json({ ok: true, inserted: rows.length }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── POST /d1/screened-tickers/spot-price ─────────────────────
    // 장중 가격 업데이트 전용: spot_price + upside만 갱신
    // 옵션 구조 필드(target_strike, gex 등)는 건드리지 않음
    if (request.method === "POST" && path === "/d1/screened-tickers/spot-price") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const { ticker, spot_price, upside } = await request.json();
        if (!ticker) return json({ ok: false, error: "ticker 필요" }, 400, corsHeaders);
        await env.DB.prepare(`
          UPDATE screened_tickers
          SET spot_price = ?, upside = ?
          WHERE ticker = ?
        `).bind(
          spot_price ?? null,
          upside     ?? null,
          ticker.toUpperCase()
        ).run();
        return json({ ok: true, ticker: ticker.toUpperCase() }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // body: { ticker, spot_price, upside, concentration_count, target_strike, total_gex, atm_iv, flip_strike }
    if (request.method === "POST" && path === "/d1/screened-tickers/update") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const { ticker, spot_price, upside, concentration_count, target_strike, total_gex, atm_iv, flip_strike, squeeze_stars, squeeze_flags, vanna_limit, vanna_sum, call_dex_sum, vanna_power, vanna_coverage } = await request.json();
        if (!ticker) return json({ ok: false, error: "ticker 필요" }, 400, corsHeaders);
        await env.DB.prepare(`
          UPDATE screened_tickers
          SET spot_price = ?, upside = ?, concentration_count = ?,
              target_strike = ?, total_gex = ?, atm_iv = ?, flip_strike = ?,
              squeeze_stars = ?, squeeze_flags = ?,
              vanna_limit = ?, vanna_sum = ?, call_dex_sum = ?,
              vanna_power = ?, vanna_coverage = ?
          WHERE ticker = ?
        `).bind(
          spot_price ?? null, upside ?? null, concentration_count ?? null,
          target_strike ?? null, total_gex ?? null, atm_iv ?? null, flip_strike ?? null,
          squeeze_stars ?? 0, squeeze_flags ?? null,
          vanna_limit ?? null, vanna_sum ?? null, call_dex_sum ?? null,
          vanna_power ?? null, vanna_coverage ?? null,
          ticker.toUpperCase()
        ).run();
        return json({ ok: true, ticker: ticker.toUpperCase() }, 200, corsHeaders);
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
        FROM watchlist
        WHERE ticker NOT IN (
          SELECT ticker FROM screened_tickers WHERE group_code IN ('WATCHLIST', 'MONITOR')
        )
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

    // ── POST /api/watchlist/group-reset ────────────────────────
    // 스캔 시작 전 WATCHLIST 그룹 screened_tickers 전체 초기화
    if (request.method === "POST" && path === "/api/watchlist/group-reset") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        await env.DB.prepare(
          "DELETE FROM screened_tickers WHERE group_code = 'WATCHLIST'"
        ).run();
        return json({ ok: true }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/symbols/add ────────────────────────────────────
    // 종목을 screened_tickers에 추가 (group_code 지정)
    // body: { symbol, group }  group 기본값: 'CHECK'
    if (request.method === "POST" && path === "/api/symbols/add") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const { symbol, group = "CHECK" } = await request.json();
        if (!symbol) return json({ ok: false, error: "symbol 필요" }, 400, corsHeaders);
        const ticker = symbol.toUpperCase();

        // watchlist에도 없으면 먼저 추가
        await env.DB.prepare(
          "INSERT OR IGNORE INTO watchlist (ticker, is_watchlist) VALUES (?, 0)"
        ).bind(ticker).run();

        // screened_tickers에 추가
        await env.DB.prepare(
          "INSERT OR IGNORE INTO screened_tickers (ticker, group_code) VALUES (?, ?)"
        ).bind(ticker, group.toUpperCase()).run();

        return json({ ok: true, ticker, group }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/watchlist/enroll-group ───────────────────────
    // 승격 종목을 screened_tickers(WATCHLIST 그룹)에 자동 편입
    if (request.method === "POST" && path === "/api/watchlist/enroll-group") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const { ticker } = await request.json();
        if (!ticker) return json({ error: "ticker 필요" }, 400, corsHeaders);
        const sym = ticker.toUpperCase();

        // screened_tickers에 WATCHLIST 그룹으로 추가
        await env.DB.prepare(
          "INSERT OR IGNORE INTO screened_tickers (ticker, group_code) VALUES (?, 'WATCHLIST')"
        ).bind(sym).run();

        // is_watchlist 동기화
        await env.DB.prepare(
          "UPDATE watchlist SET is_watchlist = 1 WHERE ticker = ?"
        ).bind(sym).run();

        return json({ ok: true, ticker: sym }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── POST /api/watchlist/prune ───────────────────────────
    // 기준 미달 종목을 screened_tickers에서 제거 (6번 로직)
    if (request.method === "POST" && path === "/api/watchlist/prune") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const { ticker } = await request.json();
        if (!ticker) return json({ error: "ticker 필요" }, 400, corsHeaders);
        const sym = ticker.toUpperCase();

        // 1. WATCHLIST 그룹에서 제거
        await env.DB.prepare(
          "DELETE FROM screened_tickers WHERE ticker = ? AND group_code = 'WATCHLIST'"
        ).bind(sym).run();

        // 2. 다른 그룹에 남아있는지 확인
        const remaining = await env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM screened_tickers WHERE ticker = ?"
        ).bind(sym).first();

        if ((remaining?.cnt ?? 0) > 0) {
          // 다른 그룹에 있음: is_watchlist = 0만
          await env.DB.prepare(
            "UPDATE watchlist SET is_watchlist = 0 WHERE ticker = ?"
          ).bind(sym).run();
        } else {
          // 고아: is_watchlist = 0 + daily_screener 데이터 삭제
          await env.DB.batch([
            env.DB.prepare("UPDATE watchlist SET is_watchlist = 0 WHERE ticker = ?").bind(sym),
            env.DB.prepare("DELETE FROM daily_screener WHERE ticker = ?").bind(sym),
          ]);
        }

        return json({ ok: true, ticker: sym }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }


    // ── POST /api/watchlist/move-to-monitor ─────────────────────
    // upside < 3% 종목을 WATCHLIST → MONITOR 그룹으로 이동
    // MONITOR 그룹은 스캔 제외, 수동 삭제 전까지 유지
    if (request.method === "POST" && path === "/api/watchlist/move-to-monitor") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const { ticker } = await request.json();
        if (!ticker) return json({ error: "ticker 필요" }, 400, corsHeaders);
        const sym = ticker.toUpperCase();

        // WATCHLIST → MONITOR: group_code 변경
        await env.DB.prepare(`
          UPDATE screened_tickers SET group_code = 'MONITOR'
          WHERE ticker = ? AND group_code = 'WATCHLIST'
        `).bind(sym).run();

        // MONITOR에 없으면 새로 삽입 (혹시 WATCHLIST 행이 없었던 경우)
        await env.DB.prepare(`
          INSERT OR IGNORE INTO screened_tickers (ticker, group_code) VALUES (?, 'MONITOR')
        `).bind(sym).run();

        return json({ ok: true, ticker: sym, group: 'MONITOR' }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }

    // ── DELETE /api/watchlist/monitor/:ticker ────────────────────
    // MONITOR 종목 수동 삭제 (완전 제거)
    const monitorDelMatch = path.match(/^\/api\/watchlist\/monitor\/([A-Z0-9.\-]+)$/i);
    if (request.method === "DELETE" && monitorDelMatch) {
      const secret = request.headers.get("x-cron-secret") || request.headers.get("x-admin-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET && secret !== env.ADMIN_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const sym = monitorDelMatch[1].toUpperCase();
      try {
        // MONITOR 그룹에서 제거
        await env.DB.prepare(
          "DELETE FROM screened_tickers WHERE ticker = ? AND group_code = 'MONITOR'"
        ).bind(sym).run();

        // 다른 그룹에 남아있는지 확인
        const remaining = await env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM screened_tickers WHERE ticker = ?"
        ).bind(sym).first();

        if ((remaining?.cnt ?? 0) === 0) {
          // 고아: daily_screener 삭제 + is_watchlist = 0
          await env.DB.batch([
            env.DB.prepare("UPDATE watchlist SET is_watchlist = 0 WHERE ticker = ?").bind(sym),
            env.DB.prepare("DELETE FROM daily_screener WHERE ticker = ?").bind(sym),
          ]);
        }

        return json({ ok: true, ticker: sym }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err.message }, 500, corsHeaders);
      }
    }



    // ── POST /api/watchlist/demote ───────────────────────────────
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
      // screened_tickers에서 해당 ticker의 모든 그룹 제거
      await env.DB.prepare("DELETE FROM screened_tickers WHERE ticker = ?").bind(ticker).run();
      // daily_screener 데이터 삭제
      await env.DB.prepare("DELETE FROM daily_screener WHERE ticker = ?").bind(ticker).run();
      // watchlist에서 완전 삭제
      await env.DB.prepare("DELETE FROM watchlist WHERE ticker = ?").bind(ticker).run();
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
        pcr, flip_zone, max_pain,
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
             pcr, flip_zone, max_pain,
             strike, call_oi, put_oi, call_oi_15m, put_oi_15m,
             call_volume, put_volume,
             dex, gex, vanna, charm)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
          max_pain ?? null,
        )
      );

      await env.DB.batch(stmts);
      return json({ ok: true, inserted: stmts.length }, 200, corsHeaders);
    }

    // ── POST /d1/spy-daily-close ─────────────────────────────────
    // 장마감 후 일별 종가 + 최종 옵션 지표 저장 (가설 검증용)
    if (request.method === "POST" && path === "/d1/spy-daily-close") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const {
        date, close, max_pain, flip_zone,
        put_wall, call_wall, pcr,
        total_gex, total_vanna, total_charm, total_dex,
        vix_close,
        saved_at_et, saved_at_kst, saved_at_utc,
      } = await request.json();

      if (!date || !close) {
        return json({ error: "date, close 필수" }, 400, corsHeaders);
      }

      await env.DB.prepare(`
        INSERT OR REPLACE INTO spy_daily_close
          (date, close, max_pain, flip_zone,
           put_wall, call_wall, pcr,
           total_gex, total_vanna, total_charm, total_dex,
           vix_close,
           saved_at_et, saved_at_kst, saved_at_utc)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        date,
        close         ?? null,
        max_pain      ?? null,
        flip_zone     ?? null,
        put_wall      ?? null,
        call_wall     ?? null,
        pcr           ?? null,
        total_gex     ?? null,
        total_vanna   ?? null,
        total_charm   ?? null,
        total_dex     ?? null,
        vix_close     ?? null,
        saved_at_et   ?? null,
        saved_at_kst  ?? null,
        saved_at_utc  ?? new Date().toISOString(),
      ).run();

      return json({ ok: true, date }, 200, corsHeaders);
    }

    // ── PATCH /d1/spy-daily-close ────────────────────────────────
    // ES 야간 세션 데이터 업데이트 (ET 01:00 웹훅 수신 시)
    if (request.method === "PATCH" && path === "/d1/spy-daily-close") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const {
        date,
        es_session_low, es_session_high,
        es_session_et, es_session_kst, es_session_utc,
      } = await request.json();

      if (!date) return json({ error: "date 필수" }, 400, corsHeaders);

      await env.DB.prepare(`
        UPDATE spy_daily_close
        SET es_session_low  = ?,
            es_session_high = ?,
            es_session_et   = ?,
            es_session_kst  = ?,
            es_session_utc  = ?
        WHERE date = ?
      `).bind(
        es_session_low  ?? null,
        es_session_high ?? null,
        es_session_et   ?? null,
        es_session_kst  ?? null,
        es_session_utc  ?? null,
        date,
      ).run();

      return json({ ok: true, date }, 200, corsHeaders);
    }

    // ── GET /d1/spy-daily-close ──────────────────────────────────
    // 일별 종가 + 지표 조회 (최근 60일)
    if (request.method === "GET" && path === "/d1/spy-daily-close") {
      const rows = await env.DB.prepare(`
        SELECT * FROM spy_daily_close
        ORDER BY date DESC
        LIMIT 60
      `).all();
      return json({ ok: true, rows: rows.results ?? [] }, 200, corsHeaders);
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
        SELECT ticker as symbol, company as name FROM watchlist
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
          updated_at as date, ticker as symbol, expiry_date, dte, expiry_type,
          call_oi, put_oi, call_vol, put_vol, pcr_oi,
          iv_skew, atm_iv, otm_call_iv, otm_put_iv,
          dex, net_gex as gex, vanna, charm, flip_strike,
          (SELECT spot_price FROM screened_tickers WHERE ticker = d.ticker LIMIT 1) as spot_price
        FROM daily_screener d
        WHERE ticker = ? AND dte BETWEEN 0 AND 65
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
