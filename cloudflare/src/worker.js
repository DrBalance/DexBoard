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
//   GET  /api/screener        → 스크리너 점수 결과 (?date=YYYY-MM-DD)
//   GET  /api/screener/sector → 섹터별 필터 (?sector=Technology&date=...)
//   POST /api/screener/run    → 수동 스크리너 실행 (테스트용)
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
    // Structure 탭 Smile 곡선용: 스트라이크별 IV 데이터
    const strikesMatch = path.match(/^\/api\/options-strikes\/([a-zA-Z]+)$/);
    if (request.method === "GET" && strikesMatch) {
      const sym    = strikesMatch[1].toUpperCase();
      const expiry = url.searchParams.get("expiry") || null;
      const date   = url.searchParams.get("date")   || null;

      let query, params;
      if (expiry && date) {
        query  = `SELECT * FROM options_strikes WHERE symbol=? AND date=? AND expiry_date=? ORDER BY strike ASC`;
        params = [sym, date, expiry];
      } else if (expiry) {
        query  = `SELECT * FROM options_strikes WHERE symbol=? AND expiry_date=? AND date=(SELECT MAX(date) FROM options_strikes WHERE symbol=? AND expiry_date=?) ORDER BY strike ASC`;
        params = [sym, expiry, sym, expiry];
      } else {
        // expiry 없으면 가장 최신 날짜의 첫번째 만기
        query  = `SELECT * FROM options_strikes WHERE symbol=? AND date=(SELECT MAX(date) FROM options_strikes WHERE symbol=?) ORDER BY dte ASC, strike ASC`;
        params = [sym, sym];
      }

      const rows = await env.DB.prepare(query).bind(...params).all();
      return json({ symbol: sym, rows: rows.results ?? [] }, 200, corsHeaders);
    }

    // ── POST /d1/options-strikes ────────────────────────────────
    // Railway → D1 스트라이크별 IV 저장
    if (request.method === "POST" && path === "/d1/options-strikes") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const { rows } = await request.json();
      if (!Array.isArray(rows) || !rows.length) {
        return json({ ok: false, error: "rows 배열 필요" }, 400, corsHeaders);
      }

      // 배치 INSERT (100행씩)
      const BATCH = 100;
      let inserted = 0;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const placeholders = batch.map(() =>
          '(?,?,?,?,?,?,?,?,?,?,?)'
        ).join(',');
        const values = batch.flatMap(r => [
          r.date, r.symbol, r.expiry_date, r.dte,
          r.strike, r.call_iv, r.put_iv, r.avg_iv,
          r.call_delta, r.call_oi, r.put_oi,
        ]);
        await env.DB.prepare(`
          INSERT OR REPLACE INTO options_strikes
          (date, symbol, expiry_date, dte, strike, call_iv, put_iv, avg_iv, call_delta, call_oi, put_oi)
          VALUES ${placeholders}
        `).bind(...values).run();
        inserted += batch.length;
      }
      return json({ ok: true, inserted }, 200, corsHeaders);
    }

    // ── GET /api/options-dex/:symbol ───────────────────────────
    // Structure 탭용: 종목의 만기별 options_dex 데이터 반환
    const optDexMatch = path.match(/^\/api\/options-dex\/([a-zA-Z]+)$/);
    if (request.method === "GET" && optDexMatch) {
      const sym  = optDexMatch[1].toUpperCase();
      const date = url.searchParams.get("date") || null;

      let query, params;
      if (date) {
        query  = `SELECT * FROM options_dex WHERE symbol=? AND date=? ORDER BY dte ASC`;
        params = [sym, date];
      } else {
        query  = `SELECT * FROM options_dex WHERE symbol=? AND date=(SELECT MAX(date) FROM options_dex WHERE symbol=?) ORDER BY dte ASC`;
        params = [sym, sym];
      }

      const rows = await env.DB.prepare(query).bind(...params).all();
      return json({ symbol: sym, rows: rows.results ?? [] }, 200, corsHeaders);
    }

    // ── GET /api/options-dex/:symbol/history ───────────────────
    // Term Structure 전일 비교용: 최근 N일 데이터 반환
    const optDexHistMatch = path.match(/^\/api\/options-dex\/([a-zA-Z]+)\/history$/);
    if (request.method === "GET" && optDexHistMatch) {
      const sym  = optDexHistMatch[1].toUpperCase();
      const days = parseInt(url.searchParams.get("days") || "3");

      // 최근 N개 날짜 조회
      const datesRes = await env.DB.prepare(`
        SELECT DISTINCT date FROM options_dex
        WHERE symbol=?
        ORDER BY date DESC
        LIMIT ?
      `).bind(sym, days).all();

      const dates = (datesRes.results ?? []).map(r => r.date);
      if (!dates.length) return json({ symbol: sym, dates: [], rows: [] }, 200, corsHeaders);

      // 해당 날짜들의 전체 데이터 조회
      const placeholders = dates.map(() => '?').join(',');
      const rowsRes = await env.DB.prepare(`
        SELECT * FROM options_dex
        WHERE symbol=? AND date IN (${placeholders})
        ORDER BY date DESC, dte ASC
      `).bind(sym, ...dates).all();

      return json({
        symbol: sym,
        dates,
        rows: rowsRes.results ?? [],
      }, 200, corsHeaders);
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

    // ── GET /api/screener ───────────────────────────────────────
    if (request.method === "GET" && path === "/api/screener") {
      let targetDate = url.searchParams.get("date");
      if (!targetDate) {
        const latest = await env.DB.prepare(
          "SELECT MAX(date) as d FROM screener_scores"
        ).first();
        targetDate = latest?.d;
      }
      if (!targetDate) return json([], 200, corsHeaders);
      const rows = await env.DB.prepare(`
        SELECT * FROM screener_scores
        WHERE date = ?
        ORDER BY total_score DESC
      `).bind(targetDate).all();
      return json(rows.results ?? [], 200, corsHeaders);
    }

    // ── GET /api/screener/group ─────────────────────────────────
    if (request.method === "GET" && path === "/api/screener/group") {
      const groupCode = url.searchParams.get("group");
      let targetDate  = url.searchParams.get("date");
      if (!targetDate) {
        const latest = await env.DB.prepare(
          "SELECT MAX(date) as d FROM screener_scores"
        ).first();
        targetDate = latest?.d;
      }
      if (!groupCode)   return json({ error: "group param required" }, 400, corsHeaders);
      if (!targetDate)  return json([], 200, corsHeaders);

      const rows = await env.DB.prepare(`
        SELECT sc.*
        FROM screener_scores sc
        JOIN symbol_groups sg ON sc.symbol = sg.symbol
        JOIN groups g ON sg.group_id = g.id
        WHERE sc.date = ? AND g.code = ?
        ORDER BY sc.total_score DESC
      `).bind(targetDate, groupCode.toUpperCase()).all();
      return json(rows.results ?? [], 200, corsHeaders);
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

      const latestRow = await env.DB.prepare(`
        SELECT MAX(date) as latest FROM options_dex WHERE symbol = ?
      `).bind(symbol).first();

      if (!latestRow?.latest) {
        return json({ monthly: [], weekly: null, context: null }, 200, corsHeaders);
      }

      const rows = await env.DB.prepare(`
        SELECT
          date, symbol, expiry_date, dte,
          call_vol, put_vol, call_oi, put_oi,
          pcr_vol, pcr_oi,
          atm_iv, otm_call_iv, otm_put_iv,
          atm_put_oi, atm_put_oi_ratio, iv_skew,
          dex, gex, vanna, charm,
          flip_strike, otm_call_oi_d, otm_put_oi_d
        FROM options_dex
        WHERE symbol = ? AND date = ? AND dte BETWEEN 0 AND 65
        ORDER BY dte ASC
      `).bind(symbol, latestRow.latest).all();

      const all = rows.results ?? [];

      // ── isMonthly: 매월 3번째 금요일 판별 ──────────────────────
      function isMonthly(dateStr) {
        const d = new Date(dateStr + 'T00:00:00Z');
        if (d.getUTCDay() !== 5) return false;
        const day = d.getUTCDate();
        return day >= 15 && day <= 21;
      }

      // ── 각 행에 is_monthly + net_oi 추가 ──────────────────────
      const enriched = all.map(r => ({
        ...r,
        is_monthly: isMonthly(r.expiry_date) ? 1 : 0,
        net_oi: (r.call_oi || 0) - (r.put_oi || 0),
      }));

      // ── Monthly: 가장 가까운 2개 ───────────────────────────────
      const monthlyRows = enriched
        .filter(r => r.is_monthly === 1)
        .sort((a, b) => a.dte - b.dte)
        .slice(0, 2);

      // ── Weekly 목록 (Monthly 제외) ─────────────────────────────
      const weeklyRows = enriched.filter(r => r.is_monthly === 0);

      // ── Weekly 평균 net OI → 1.5배 초과만 표시 ────────────────
      let featuredWeekly = null;
      if (weeklyRows.length > 0) {
        const avgNetOI = weeklyRows.reduce((s, r) => s + Math.abs(r.net_oi), 0) / weeklyRows.length;
        const threshold = avgNetOI * 1.5;
        const candidates = weeklyRows
          .filter(r => Math.abs(r.net_oi) > threshold)
          .sort((a, b) => Math.abs(b.net_oi) - Math.abs(a.net_oi));
        if (candidates.length > 0) featuredWeekly = candidates[0];
      }

      // ── OPEX까지 남은 일수 (가장 가까운 Monthly 기준) ──────────
      const nextMonthly = monthlyRows[0] ?? null;
      const opexDte = nextMonthly?.dte ?? null;

      // ── 이번 주 위클리 만기 (DTE 0~6 중 가장 가까운 것) ────────
      const thisWeekExpiry = weeklyRows
        .filter(r => r.dte >= 0 && r.dte <= 6)
        .sort((a, b) => a.dte - b.dte)[0] ?? null;

      // ── Vanna/Charm 방향 판단 (Monthly 합산) ───────────────────
      const vannaSum = monthlyRows.reduce((s, r) => s + (r.vanna || 0), 0);
      const charmSum = monthlyRows.reduce((s, r) => s + (r.charm || 0), 0);

      // ── Monthly IV스큐 방향 일치 여부 ──────────────────────────
      const monthlySkews = monthlyRows.map(r => r.iv_skew).filter(v => v != null);
      const skewAligned = monthlySkews.length >= 2
        ? (monthlySkews[0] > 0) === (monthlySkews[1] > 0)
        : false;

      return json({
        date:    latestRow.latest,
        symbol,
        monthly: monthlyRows,
        weekly:  featuredWeekly,
        context: {
          opex_dte:          opexDte,
          this_week_expiry:  thisWeekExpiry ? thisWeekExpiry.expiry_date : null,
          this_week_dte:     thisWeekExpiry?.dte ?? null,
          vanna_sum:         +vannaSum.toFixed(4),
          charm_sum:         +charmSum.toFixed(4),
          skew_aligned:      skewAligned,
          weekly_featured:   featuredWeekly != null,
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
