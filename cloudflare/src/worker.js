// DexBoard – Cloudflare Workers main
// Routes:
//   GET  /api/snapshot        → latest 1min snapshot from KV (SPY + VIX)
//   GET  /api/snapshot/prev   → previous snapshot from KV
//   GET  /api/dex/:group      → DEX data (0dte | weekly | monthly | quarterly | structure)
//   GET  /api/dex/open        → opening snapshot
//   GET  /api/dex/0dte/prev   → 15분 전 0dte 스냅샷 (delta15m 계산용)
//   GET  /api/ai-analysis     → 최신 AI 분석 결과 KV 캐시 (ai:analysis)
//   GET  /api/spy-price       → SPY 현재가 프록시 (Twelve Data REST → CORS 우회)
//   GET  /api/prevclose       → 전날 SPY/VIX 종가 (KV snapshot:prevclose)
//   GET  /api/screener        → 스크리너 점수 결과 (?date=YYYY-MM-DD)
//   GET  /api/screener/sector → 섹터별 필터 (?sector=Technology&date=...)
//   POST /api/screener/run    → 수동 스크리너 실행 (테스트용)
//   POST /kv-write            → internal: Railway writes KV through here
// Cron:
//   */1  13-20 * * 1-5  → fetchSnapshot (정규장 1분, SPY+VIX → KV)
//   */3  4-13  * * 1-5  → fetchSnapshot (프리마켓 3분, SPY+VIX → KV)
//   */3  20-23 * * 1-5  → fetchSnapshot (애프터 3분, SPY+VIX → KV)
//   */15 13-20 * * 1-5  → triggerRailway (DEX 계산)
//   0    13    * * 1-5  → snapshotOpen  (장 시작 스냅샷)
//   30   20    * * 1-5  → runScreener   (장 마감 후 스크리너)

// screener-v2.js 제거 — Railway 수집 엔진으로 대체
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

    // ── GET /api/dex/0dte/prev ──────────────────────────────────
    // 15분 전 0dte 스냅샷 — delta15m 계산용
    if (request.method === "GET" && path === "/api/dex/0dte/prev") {
      const data = await env.DEX_KV.get("dex:spy:0dte:prev", { type: "json" });
      if (!data) return json({ error: "No prev 0dte data" }, 200, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/oi/open ────────────────────────────────────────
    if (request.method === "GET" && path === "/api/oi/open") {
      const data = await env.DEX_KV.get("oi:spy:open", { type: "json" });
      if (!data) return json({ error: "No OI open snapshot" }, 200, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/ai-analysis ────────────────────────────────────
    // KV에 캐싱된 최신 AI 분석 결과 반환
    // { analysis, ts, error? }
    if (request.method === "GET" && path === "/api/ai-analysis") {
      const data = await env.DEX_KV.get("ai:analysis", { type: "json" });
      if (!data) return json({ error: "No analysis yet" }, 200, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/spy-price  (Twelve Data REST 프록시) ───────────
    // Response: { price, change, changePct, source: 'twelvedata'|'kv', ts }
    if (request.method === "GET" && path === "/api/spy-price") {
      try {
        // 1) Twelve Data /quote 시도 (실시간 US ETF)
        const tdUrl =
          `https://api.twelvedata.com/quote?symbol=SPY&apikey=${env.TWELVE_KEY_SPY}`;
        const tdRes = await fetch(tdUrl, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(5000),
        });
        if (tdRes.ok) {
          const td = await tdRes.json();
          // close=현재가, previous_close=전일종가
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

      // 2) KV 폴백
      const snap = await env.DEX_KV.get("snapshot:1min", { type: "json" });
      if (snap?.spy?.price) {
        return json({ ...snap.spy, source: "kv", ts: snap.ts }, 200, corsHeaders);
      }
      return json({ error: "SPY 가격 없음" }, 503, corsHeaders);
    }

    // ── GET /api/prevclose ─────────────────────────────────────
    // 전날 종가 반환 (프리마켓 VIX 차트 baseline용)
    // { spy: number, vix: number, date: string }
    if (request.method === "GET" && path === "/api/prevclose") {
      const data = await env.DEX_KV.get("snapshot:prevclose", { type: "json" });
      if (!data) return json({ error: "No prevclose yet" }, 200, corsHeaders);
      return json(data, 200, corsHeaders);
    }

    // ── GET /api/symbols (자동완성 — 인증 불필요) ───────────────
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

    // ── GET /api/admin/quote (티커 → 회사명, 인증 필요) ────────
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

    // ── GET /api/bb-map-symbols (Railway용 — CRON_SECRET 인증) ──
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

    // ── POST /d1/price-indicators (Railway → D1 저장) ────────────
    if (request.method === "POST" && path === "/d1/price-indicators") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const { rows, mode } = await request.json();
      if (!Array.isArray(rows) || !rows.length) {
        return json({ ok: false, error: "rows 배열 필요" }, 400, corsHeaders);
      }
      // mode='ignore': 기존 날짜 데이터 보존 (백필용)
      // mode 미지정 or 'replace': 기존 데이터 덮어쓰기 (당일 갱신용)
      const insertMode = mode === 'ignore' ? 'INSERT OR IGNORE' : 'INSERT OR REPLACE';
      const stmts = rows.map(r =>
        env.DB.prepare(`
          ${insertMode} INTO price_indicators
            (date, symbol, close, bb_mid, bb_upper1, bb_lower1,
             bb_upper2, bb_lower2, bb_position, atr5, atr20, vol_ratio)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          r.date, r.symbol, r.close,
          r.bb_mid ?? null, r.bb_upper1 ?? null, r.bb_lower1 ?? null,
          r.bb_upper2 ?? null, r.bb_lower2 ?? null, r.bb_position ?? null,
          r.atr5 ?? null, r.atr20 ?? null, r.vol_ratio ?? null
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

    // ── GET /api/collect-targets (CRON_SECRET 인증 — 프론트엔드용) ─
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
    // ?group=TECH&date=YYYY-MM-DD
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

    // ── POST /d1/options-dex (Railway → D1 저장) ────────────────
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
              otm_call_theo, otm_call_delta
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).bind(
            r.date, r.symbol, r.expiry_date, r.dte,
            r.call_oi ?? 0, r.put_oi ?? 0, r.call_vol ?? 0, r.put_vol ?? 0,
            r.pcr_oi ?? null, r.pcr_vol ?? null,
            r.iv_skew ?? null, r.atm_iv ?? null,
            r.otm_call_iv ?? null, r.otm_put_iv ?? null,
            r.dex ?? null, r.gex ?? null, r.vanna ?? null, r.charm ?? null,
            r.atm_put_oi ?? null, r.atm_put_oi_ratio ?? null,
            r.otm_call_theo ?? null, r.otm_call_delta ?? null,
          )
        );
        await env.DB.batch(stmts);
        inserted += chunk.length;
      }
      return json({ ok: true, inserted }, 200, corsHeaders);
    }

    // ── POST /d1/screener-scores (Railway → D1 저장) ─────────────
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
              skew_strength, total_score
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
          `).bind(
            r.date, r.symbol,
            r.close ?? null, r.bb_position ?? null,
            r.bb_flag ?? null, r.iv_skew ?? null,
            r.score_skew ?? 0, r.score_bb ?? 0, r.score_vol_squeeze ?? 0,
            r.skew_strength ?? null, r.total_score ?? 0,
          )
        );
        await env.DB.batch(stmts);
        inserted += chunk.length;
      }
      return json({ ok: true, inserted }, 200, corsHeaders);
    }

  // ── GET /api/bb-map-chart ───────────────────────────────────────
  // BB 위치 시계열 차트 데이터 (스크리너 탭 BB맵용)
  // ?range=1m|3m|6m|1y|all  (기본: 3m)
  // Response: { symbols: [...], dates: [...], series: { SYMBOL: [bb_position, ...] } }
  if (request.method === "GET" && path === "/api/bb-map-chart") {
    const range = url.searchParams.get("range") || "3m";

    // 기간 → 날짜 계산
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

    // bb_map_symbols 목록 조회
    const symRows = await env.DB.prepare(
      "SELECT symbol, name FROM bb_map_symbols WHERE is_active=1 ORDER BY sort_order, symbol"
    ).all();
    const symbols = symRows.results ?? [];
    if (!symbols.length) return json({ symbols: [], dates: [], series: {} }, 200, corsHeaders);

    const symList = symbols.map(s => s.symbol);

    // price_indicators에서 시계열 조회
    const placeholders = symList.map(() => "?").join(",");
    const binds = fromDate
      ? [...symList, fromDate]
      : symList;
    const whereDate = fromDate ? "AND date >= ?" : "";

    const rows = await env.DB.prepare(`
      SELECT date, symbol, bb_position
      FROM price_indicators
      WHERE symbol IN (${placeholders}) ${whereDate}
        AND bb_position IS NOT NULL
      ORDER BY date ASC
    `).bind(...binds).all();

    // date 목록 (중복 제거)
    const dateSet = [...new Set((rows.results ?? []).map(r => r.date))].sort();

    // symbol별 시계열 맵 구성
    const seriesMap = {};
    for (const sym of symList) seriesMap[sym] = {};
    for (const r of (rows.results ?? [])) {
      if (seriesMap[r.symbol]) seriesMap[r.symbol][r.date] = r.bb_position;
    }

    // 날짜 배열 기준으로 각 심볼 시계열 정렬 (없는 날짜는 null)
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

  // ── GET /api/rescore-data (Railway → 재평가용 원본 데이터 조회) ──
    if (request.method === "GET" && path === "/api/rescore-data") {
      const secret = request.headers.get("x-cron-secret");
      if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
        return json({ error: "Unauthorized" }, 401, corsHeaders);
      }

      // options_dex 최신 날짜 기준 전체 조회
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

      // price_indicators 최신 날짜 기준 조회
      const latestPI = await env.DB.prepare(
        "SELECT MAX(date) as d FROM price_indicators"
      ).first();
      const piDate = latestPI?.d;
      const piRows = piDate ? await env.DB.prepare(`
        SELECT symbol, bb_position, vol_ratio, close
        FROM price_indicators
        WHERE date = ?
      `).bind(piDate).all() : { results: [] };

      // symbols 메타 조회 (실제 컬럼만: symbol, name, type)
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

  // ── GET /api/structure/:symbol ─────────────────────────────
  const structMatch = path.match(/^\/api\/structure\/([A-Z0-9.\-]+)$/);
  if (request.method === "GET" && structMatch) {
    const symbol = structMatch[1].toUpperCase();

    const latestRow = await env.DB.prepare(`
      SELECT MAX(date) as latest FROM options_dex WHERE symbol = ?
    `).bind(symbol).first();

    if (!latestRow?.latest) {
      return json([], 200, corsHeaders);
    }

    const rows = await env.DB.prepare(`
      SELECT
        date, symbol, expiry_date, dte,
        call_vol, put_vol, call_oi, put_oi,
        pcr_vol, pcr_oi,
        atm_iv, otm_call_iv, otm_put_iv,
        atm_put_oi, atm_put_oi_ratio, iv_skew,
        dex, gex, vanna, charm
      FROM options_dex
      WHERE symbol = ? AND date = ? AND dte BETWEEN 0 AND 65
      ORDER BY dte ASC
    `).bind(symbol, latestRow.latest).all();

    return json(rows.results ?? [], 200, corsHeaders);
  }

    
    // ── Health check ────────────────────────────────────────────
    if (path === "/health") {
      return json({ status: "ok", ts: new Date().toISOString() }, 200, corsHeaders);
    }

    return json({ error: "Not found" }, 404, corsHeaders);
  },

};

// fetchSnapshot → Railway setInterval로 이전됨

/* snapshotOpen, triggerRailway, fetchSPY, fetchVIX, triggerScreenerCollect
   → Railway setInterval로 이전됨 */
async function snapshotOpen_UNUSED(env) {
  try {
    const snapshot = await env.DEX_KV.get("snapshot:1min", { type: "json" });
    if (!snapshot) { console.warn("[snapshotOpen] No snapshot:1min yet"); return; }
    await env.DEX_KV.put("options:spy:open", JSON.stringify({
      ...snapshot,
      saved_at: new Date().toISOString(),
    }));
    console.log("[snapshotOpen] saved opening snapshot");

    // 장 시작 OI 스냅샷 저장 (OI 증감 계산용)
    const dex0dte = await env.DEX_KV.get("dex:spy:0dte", { type: "json" });
    if (dex0dte?.strikes?.length) {
      const oiMap = Object.fromEntries(
        dex0dte.strikes.map(s => [s.strike, { c: s.callOI, p: s.putOI }])
      );
      await env.DEX_KV.put("oi:spy:open", JSON.stringify({
        oiMap,
        saved_at: new Date().toISOString(),
      }));
      console.log(`[snapshotOpen] saved OI open map (${Object.keys(oiMap).length} strikes)`);
    } else {
      console.warn("[snapshotOpen] dex:spy:0dte 없음 — OI open map 저장 생략");
    }
  } catch (e) {
    console.error("[snapshotOpen] error:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// triggerRailway
// ─────────────────────────────────────────────────────────────────
async function triggerRailway(env) {
  try {
    // SPY + VIX 모두 KV snapshot에서 가져옴 (fetchSnapshot이 둘 다 저장)
    const snapshot = await env.DEX_KV.get("snapshot:1min", { type: "json" });
    const spyPrice = snapshot?.spy?.price ?? null;
    const vixPrice = snapshot?.vix?.price ?? null;

    if (!spyPrice || !vixPrice) {
      console.warn("[railway] SPY 또는 VIX 없음 → trigger 생략", { spyPrice, vixPrice });
      return;
    }

    // Railway 호출 전 현재 0dte를 prev로 저장 (delta15m 계산용)
    const current0dte = await env.DEX_KV.get("dex:spy:0dte", { type: "json" });
    if (current0dte) {
      await env.DEX_KV.put("dex:spy:0dte:prev", JSON.stringify(current0dte));
      console.log("[railway] dex:spy:0dte:prev 저장 완료");
    }

    const res = await fetch(`${env.RAILWAY_URL}/calculate`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "x-cron-secret": env.CRON_SECRET || "",
      },
      body: JSON.stringify({
        spot: spyPrice,
        vix:  vixPrice,
      }),
    });

    const text = await res.text();
    console.log(`[railway] ${res.status}: ${text.slice(0, 200)}`);
  } catch (e) {
    console.error("[railway] error:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// fetchSPY – Yahoo Finance
// ─────────────────────────────────────────────────────────────────
async function fetchSPY(env) {
  const url = `${env.YAHOO_BASE}/SPY?interval=1m&range=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo SPY: ${res.status}`);

  const data   = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo SPY: no result");

  const meta      = result.meta;
  const quotes    = result.indicators?.quote?.[0]?.close ?? [];
  const price     = quotes.filter(Boolean).pop();
  if (!price) throw new Error("Yahoo SPY: no close data");

  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
  const change    = prevClose != null ? round2(price - prevClose) : null;
  const changePct = prevClose != null ? round2((price - prevClose) / prevClose * 100) : null;

  return { price: round2(price), change, changePct };
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
// ─────────────────────────────────────────────────────────────────
// triggerScreenerCollect — 장 마감 후 Railway 스크리너 수집 트리거
// ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────
// triggerScreenerCollect — 장 마감 후 Railway 스크리너 수집 트리거
// 심볼 목록을 D1 groups/symbol_groups에서 읽어옴
// ─────────────────────────────────────────────────────────────────
async function triggerScreenerCollect(env) {
  try {
    // D1에서 수집 대상 심볼 조회 (어느 그룹에든 속한 심볼 전체)
    const rows = await env.DB.prepare(`
      SELECT DISTINCT s.symbol, s.name, s.type
      FROM symbols s
      JOIN symbol_groups sg ON s.symbol = sg.symbol
      ORDER BY s.type DESC, s.symbol
    `).all();

    const symbols = rows.results ?? [];
    if (!symbols.length) {
      console.warn("[screener-cron] D1에 수집 대상 심볼 없음 — 생략");
      return;
    }

    const res = await fetch(`${env.RAILWAY_URL}/collect-screener`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "x-cron-secret": env.CRON_SECRET || "",
      },
      body: JSON.stringify({ symbols, force: false }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    console.log(`[screener-cron] ${symbols.length}종목 → Railway ${res.status}: ${text.slice(0, 200)}`);
  } catch (e) {
    console.error("[screener-cron] error:", e.message);
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
