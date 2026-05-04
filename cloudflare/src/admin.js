// ============================================
// admin.js — 관리자 API 핸들러 (v2)
// 새 스키마: groups, symbol_groups, bb_map_symbols
// worker.js에서 import해서 사용
// ============================================

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

// ── 인증 체크
function authCheck(request, env) {
  const secret = request.headers.get('x-admin-secret');
  return secret === (env.INIT_SECRET || 'drbalance-init-2026');
}

// ── 공통 JSON 응답
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
    },
  });
}

// ============================================
// 라우터
// ============================================
export async function handleAdmin(path, request, env) {
  if (!authCheck(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // ── GET  /api/admin/stats
  if (path === '/api/admin/stats' && request.method === 'GET') {
    return handleStats(env);
  }

  // ════════════════════════════════════════
  // GROUPS
  // ════════════════════════════════════════

  // ── GET  /api/admin/groups
  if (path === '/api/admin/groups' && request.method === 'GET') {
    return handleGetGroups(env);
  }

  // ── POST /api/admin/groups
  if (path === '/api/admin/groups' && request.method === 'POST') {
    return handleAddGroup(request, env);
  }

  // ── PATCH /api/admin/groups/:id
  const groupPatch = path.match(/^\/api\/admin\/groups\/(\d+)$/);
  if (groupPatch && request.method === 'PATCH') {
    return handleUpdateGroup(Number(groupPatch[1]), request, env);
  }

  // ── DELETE /api/admin/groups/:id
  const groupDel = path.match(/^\/api\/admin\/groups\/(\d+)$/);
  if (groupDel && request.method === 'DELETE') {
    return handleDeleteGroup(Number(groupDel[1]), env);
  }

  // ── GET  /api/admin/groups/:id/symbols
  const groupSymsGet = path.match(/^\/api\/admin\/groups\/(\d+)\/symbols$/);
  if (groupSymsGet && request.method === 'GET') {
    return handleGetGroupSymbols(Number(groupSymsGet[1]), env);
  }

  // ── POST /api/admin/groups/:id/symbols
  const groupSymsPost = path.match(/^\/api\/admin\/groups\/(\d+)\/symbols$/);
  if (groupSymsPost && request.method === 'POST') {
    return handleAddGroupSymbol(Number(groupSymsPost[1]), request, env);
  }

  // ── DELETE /api/admin/groups/:id/symbols/:symbol
  const groupSymDel = path.match(/^\/api\/admin\/groups\/(\d+)\/symbols\/([A-Z0-9.\-]+)$/);
  if (groupSymDel && request.method === 'DELETE') {
    return handleRemoveGroupSymbol(Number(groupSymDel[1]), groupSymDel[2], env);
  }

  // ════════════════════════════════════════
  // SYMBOLS
  // ════════════════════════════════════════

  // ── GET  /api/admin/symbols
  if (path === '/api/admin/symbols' && request.method === 'GET') {
    return handleGetSymbols(env);
  }

  // ── POST /api/admin/symbols
  if (path === '/api/admin/symbols' && request.method === 'POST') {
    return handleAddSymbol(request, env);
  }

  // ── PATCH /api/admin/symbols/:sym
  const symPatch = path.match(/^\/api\/admin\/symbols\/([A-Z0-9.\-]+)$/);
  if (symPatch && request.method === 'PATCH') {
    return handleUpdateSymbol(symPatch[1], request, env);
  }

  // ── DELETE /api/admin/symbols/:sym
  const symDel = path.match(/^\/api\/admin\/symbols\/([A-Z0-9.\-]+)$/);
  if (symDel && request.method === 'DELETE') {
    return handleDeleteSymbol(symDel[1], env);
  }

  // ── POST /api/admin/symbols/refresh
  if (path === '/api/admin/symbols/refresh' && request.method === 'POST') {
    return handleRefreshSymbols(env);
  }

  // ════════════════════════════════════════
  // BB MAP SYMBOLS
  // ════════════════════════════════════════

  // ── GET  /api/admin/bb-map
  if (path === '/api/admin/bb-map' && request.method === 'GET') {
    return handleGetBBMap(env);
  }

  // ── POST /api/admin/bb-map
  if (path === '/api/admin/bb-map' && request.method === 'POST') {
    return handleAddBBMap(request, env);
  }

  // ── PATCH /api/admin/bb-map/:sym
  const bbPatch = path.match(/^\/api\/admin\/bb-map\/([A-Z0-9.\-]+)$/);
  if (bbPatch && request.method === 'PATCH') {
    return handleUpdateBBMap(bbPatch[1], request, env);
  }

  // ── DELETE /api/admin/bb-map/:sym
  const bbDel = path.match(/^\/api\/admin\/bb-map\/([A-Z0-9.\-]+)$/);
  if (bbDel && request.method === 'DELETE') {
    return handleDeleteBBMap(bbDel[1], env);
  }

  // ════════════════════════════════════════
  // ETF 구성종목 조회
  // ════════════════════════════════════════

  // ── GET /api/admin/etf-holdings/:sym
  const etfHoldings = path.match(/^\/api\/admin\/etf-holdings\/([A-Z0-9.\-]+)$/);
  if (etfHoldings && request.method === 'GET') {
    return handleGetETFHoldings(etfHoldings[1], env);
  }

  // ════════════════════════════════════════
  // 수집 대상 (Railway trigger용)
  // ════════════════════════════════════════

  // ── GET /api/admin/collect-targets
  if (path === '/api/admin/collect-targets' && request.method === 'GET') {
    return handleGetCollectTargets(env);
  }

  return json({ error: 'Not found' }, 404);
}

// ============================================
// STATS
// ============================================
async function handleStats(env) {
  const [symbols, groups, bbmap, flow] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as n FROM symbols').first(),
    env.DB.prepare('SELECT COUNT(*) as n FROM groups').first(),
    env.DB.prepare('SELECT COUNT(*) as n FROM bb_map_symbols WHERE is_active=1').first(),
    env.DB.prepare("SELECT COUNT(*) as n FROM options_flow WHERE date=date('now')").first(),
  ]);
  return json({
    symbols:    symbols.n,
    groups:     groups.n,
    bb_map:     bbmap.n,
    flow_today: flow.n,
  });
}

// ============================================
// GROUPS
// ============================================
async function handleGetGroups(env) {
  const rows = await env.DB.prepare(`
    SELECT g.*, COUNT(sg.symbol) as symbol_count
    FROM groups g
    LEFT JOIN symbol_groups sg ON g.id = sg.group_id
    GROUP BY g.id
    ORDER BY g.code
  `).all();
  return json({ groups: rows.results });
}

async function handleAddGroup(request, env) {
  const { code, name, color, comment } = await request.json();
  if (!code || !name) return json({ error: 'code, name 필수' }, 400);

  const code_upper = code.toUpperCase().trim();
  const exists = await env.DB.prepare(
    'SELECT id FROM groups WHERE code=?'
  ).bind(code_upper).first();
  if (exists) return json({ error: `${code_upper} 코드가 이미 존재합니다` }, 409);

  const result = await env.DB.prepare(`
    INSERT INTO groups (code, name, color, comment)
    VALUES (?, ?, ?, ?)
  `).bind(code_upper, name.trim(), color || null, comment || null).run();

  return json({ ok: true, id: result.meta.last_row_id, code: code_upper });
}

async function handleUpdateGroup(id, request, env) {
  const { name, color, comment } = await request.json();
  await env.DB.prepare(
    'UPDATE groups SET name=?, color=?, comment=? WHERE id=?'
  ).bind(name, color || null, comment || null, id).run();
  return json({ ok: true, id });
}

async function handleDeleteGroup(id, env) {
  // symbol_groups는 CASCADE로 자동 삭제됨
  await env.DB.prepare('DELETE FROM groups WHERE id=?').bind(id).run();

  // 고아 심볼 (어느 그룹에도 속하지 않은) 정리
  const orphans = await env.DB.prepare(`
    SELECT symbol FROM symbols
    WHERE symbol NOT IN (SELECT DISTINCT symbol FROM symbol_groups)
  `).all();

  if (orphans.results.length > 0) {
    const syms = orphans.results.map(r => r.symbol);
    const delStmts = syms.flatMap(sym => [
      env.DB.prepare('DELETE FROM symbols WHERE symbol=?').bind(sym),
      env.DB.prepare('DELETE FROM options_flow WHERE symbol=?').bind(sym),
      env.DB.prepare('DELETE FROM price_indicators WHERE symbol=?').bind(sym),
      env.DB.prepare('DELETE FROM screener_scores WHERE symbol=?').bind(sym),
    ]);
    for (const chunk of chunkArray(delStmts, 100)) {
      await env.DB.batch(chunk);
    }
    return json({ ok: true, id, orphans_removed: syms });
  }

  return json({ ok: true, id, orphans_removed: [] });
}

async function handleGetGroupSymbols(id, env) {
  const rows = await env.DB.prepare(`
    SELECT s.symbol, s.name, s.type, s.comment
    FROM symbol_groups sg
    JOIN symbols s ON sg.symbol = s.symbol
    WHERE sg.group_id = ?
    ORDER BY s.type DESC, s.symbol
  `).bind(id).all();
  return json({ group_id: id, symbols: rows.results });
}

async function handleAddGroupSymbol(id, request, env) {
  const { symbol } = await request.json();
  if (!symbol) return json({ error: 'symbol 필수' }, 400);

  const sym = symbol.toUpperCase().trim();

  // symbols에 없으면 자동 등록
  await env.DB.prepare(`
    INSERT OR IGNORE INTO symbols (symbol, added_date)
    VALUES (?, date('now'))
  `).bind(sym).run();

  // 그룹에 추가
  await env.DB.prepare(`
    INSERT OR IGNORE INTO symbol_groups (symbol, group_id)
    VALUES (?, ?)
  `).bind(sym, id).run();

  // Yahoo에서 name/type 자동수집
  const info = await refreshOneSymbol(env.DB, sym);

  return json({ ok: true, symbol: sym, group_id: id, name: info?.name, type: info?.type });
}

async function handleRemoveGroupSymbol(id, symbol, env) {
  await env.DB.prepare(
    'DELETE FROM symbol_groups WHERE group_id=? AND symbol=?'
  ).bind(id, symbol).run();

  // 고아가 되었으면 모든 데이터 삭제
  const stillExists = await env.DB.prepare(
    'SELECT 1 FROM symbol_groups WHERE symbol=? LIMIT 1'
  ).bind(symbol).first();

  if (!stillExists) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM symbols WHERE symbol=?').bind(symbol),
      env.DB.prepare('DELETE FROM options_flow WHERE symbol=?').bind(symbol),
      env.DB.prepare('DELETE FROM price_indicators WHERE symbol=?').bind(symbol),
      env.DB.prepare('DELETE FROM screener_scores WHERE symbol=?').bind(symbol),
    ]);
    return json({ ok: true, symbol, group_id: id, orphan_removed: true });
  }

  return json({ ok: true, symbol, group_id: id, orphan_removed: false });
}

// ============================================
// SYMBOLS
// ============================================
async function handleGetSymbols(env) {
  const rows = await env.DB.prepare(`
    SELECT
      s.symbol, s.name, s.type, s.comment, s.added_date,
      GROUP_CONCAT(g.code) as groups
    FROM symbols s
    LEFT JOIN symbol_groups sg ON s.symbol = sg.symbol
    LEFT JOIN groups g ON sg.group_id = g.id
    GROUP BY s.symbol
    ORDER BY s.type DESC, s.symbol
  `).all();
  return json({ symbols: rows.results });
}

async function handleAddSymbol(request, env) {
  const { symbol, group_id } = await request.json();
  if (!symbol) return json({ error: 'symbol 필수' }, 400);

  const sym = symbol.toUpperCase().trim();

  await env.DB.prepare(`
    INSERT OR IGNORE INTO symbols (symbol, added_date)
    VALUES (?, date('now'))
  `).bind(sym).run();

  if (group_id) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO symbol_groups (symbol, group_id)
      VALUES (?, ?)
    `).bind(sym, group_id).run();
  }

  const info = await refreshOneSymbol(env.DB, sym);
  return json({ ok: true, symbol: sym, name: info?.name, type: info?.type });
}

async function handleUpdateSymbol(symbol, request, env) {
  const { comment } = await request.json();
  await env.DB.prepare(
    'UPDATE symbols SET comment=? WHERE symbol=?'
  ).bind(comment || null, symbol).run();
  return json({ ok: true, symbol });
}

async function handleDeleteSymbol(symbol, env) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM symbol_groups WHERE symbol=?').bind(symbol),
    env.DB.prepare('DELETE FROM symbols WHERE symbol=?').bind(symbol),
    env.DB.prepare('DELETE FROM options_flow WHERE symbol=?').bind(symbol),
    env.DB.prepare('DELETE FROM price_indicators WHERE symbol=?').bind(symbol),
    env.DB.prepare('DELETE FROM screener_scores WHERE symbol=?').bind(symbol),
  ]);
  return json({ ok: true, symbol });
}

async function handleRefreshSymbols(env) {
  const rows = await env.DB.prepare('SELECT symbol FROM symbols').all();
  const results = { updated: [], failed: [] };

  for (const { symbol } of rows.results) {
    const info = await refreshOneSymbol(env.DB, symbol);
    if (info) results.updated.push(symbol);
    else results.failed.push(symbol);
    await sleep(200);
  }

  return json({ ok: true, ...results });
}

// ── Yahoo Finance로 단일 심볼 name/type 수집
async function refreshOneSymbol(db, symbol) {
  try {
    const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const data   = await res.json();
    const meta   = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const name = meta.longName || meta.shortName || symbol;
    const type = (meta.instrumentType === 'ETF') ? 'etf' : 'stock';

    await db.prepare(
      'UPDATE symbols SET name=?, type=? WHERE symbol=?'
    ).bind(name, type, symbol).run();

    return { name, type };
  } catch {
    return null;
  }
}

// ============================================
// BB MAP SYMBOLS
// ============================================
async function handleGetBBMap(env) {
  const rows = await env.DB.prepare(
    'SELECT * FROM bb_map_symbols ORDER BY sort_order, symbol'
  ).all();
  return json({ bb_map: rows.results });
}

async function handleAddBBMap(request, env) {
  const { symbol, name, color, sort_order } = await request.json();
  if (!symbol) return json({ error: 'symbol 필수' }, 400);

  const sym = symbol.toUpperCase().trim();

  // Yahoo에서 name 자동수집
  let resolvedName = name || sym;
  try {
    const url = `${YAHOO_BASE}/${encodeURIComponent(sym)}?interval=1d&range=5d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta) resolvedName = meta.longName || meta.shortName || sym;
    }
  } catch { /* 실패 시 입력값 사용 */ }

  await env.DB.prepare(`
    INSERT OR REPLACE INTO bb_map_symbols (symbol, name, color, sort_order, is_active, added_date)
    VALUES (?, ?, ?, ?, 1, date('now'))
  `).bind(sym, resolvedName, color || null, sort_order ?? 99).run();

  // price_indicators 2개월치 백필 (비동기, 응답을 기다리지 않음)
  // Cloudflare Workers에서는 ctx.waitUntil로 처리하는 게 이상적이나
  // admin.js에서는 ctx 접근이 없으므로 await로 처리
  await backfillPriceIndicators(env.DB, sym);

  return json({ ok: true, symbol: sym, name: resolvedName });
}

async function handleUpdateBBMap(symbol, request, env) {
  const { name, color, sort_order, is_active } = await request.json();
  await env.DB.prepare(`
    UPDATE bb_map_symbols SET name=?, color=?, sort_order=?, is_active=? WHERE symbol=?
  `).bind(name, color || null, sort_order ?? 99, is_active ?? 1, symbol).run();
  return json({ ok: true, symbol });
}

async function handleDeleteBBMap(symbol, env) {
  await env.DB.prepare('DELETE FROM bb_map_symbols WHERE symbol=?').bind(symbol).run();
  // price_indicators는 유지 (옵션 수집 종목과 공유할 수 있으므로)
  return json({ ok: true, symbol });
}

// ── price_indicators 과거 2개월치 백필
async function backfillPriceIndicators(db, symbol) {
  try {
    const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return;

    const data   = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return;

    const timestamps = result.timestamp ?? [];
    const closes     = (result.indicators?.quote?.[0]?.close ?? []);

    const candles = timestamps
      .map((ts, i) => ({
        date:  new Date(ts * 1000).toISOString().slice(0, 10),
        close: closes[i] ?? null,
      }))
      .filter(c => c.close != null);

    if (candles.length < 20) return;

    const stmts = [];
    for (let i = 19; i < candles.length; i++) {
      const slice      = candles.slice(i - 19, i + 1).map(c => c.close);
      const { date, close } = candles[i];
      const bb         = calcBollinger(slice);
      if (!bb) continue;

      const bbRange    = bb.upper2 - bb.lower2;
      const bbPosition = bbRange > 0 ? (close - bb.lower2) / bbRange : 0.5;

      stmts.push(
        db.prepare(`
          INSERT OR IGNORE INTO price_indicators
            (date, symbol, close, bb_mid, bb_upper1, bb_lower1, bb_upper2, bb_lower2, bb_position)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          date, symbol, close,
          bb.mid, bb.upper1, bb.lower1, bb.upper2, bb.lower2,
          +bbPosition.toFixed(4)
        )
      );
    }

    for (const chunk of chunkArray(stmts, 100)) {
      await db.batch(chunk);
    }

    console.log(`[backfill] ${symbol}: ${stmts.length}개 저장`);
  } catch (err) {
    console.error(`[backfill] ${symbol}:`, err.message);
  }
}

// ============================================
// ETF 구성종목 조회 — Railway 프록시
// CF Worker IP는 Yahoo에서 차단되므로 Railway로 위임
// ============================================
async function handleGetETFHoldings(symbol, env) {
  if (!env.RAILWAY_URL) {
    return json({ error: 'RAILWAY_URL 환경변수 없음' }, 500);
  }
  try {
    const url = `${env.RAILWAY_URL}/etf-holdings/${encodeURIComponent(symbol)}`;
    const res = await fetch(url, {
      headers: { 'x-cron-secret': env.CRON_SECRET || '' },
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    if (!res.ok) return json(data, res.status);
    return json(data);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// ============================================
// 수집 대상 심볼 목록
// ============================================
async function handleGetCollectTargets(env) {
  const rows = await env.DB.prepare(`
    SELECT DISTINCT s.symbol, s.name, s.type
    FROM symbols s
    JOIN symbol_groups sg ON s.symbol = sg.symbol
    ORDER BY s.type DESC, s.symbol
  `).all();
  return json({ symbols: rows.results });
}

// ============================================
// 볼린저밴드 계산
// ============================================
function calcBollinger(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma   = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + (b - sma) ** 2, 0) / period);
  return {
    mid:    +sma.toFixed(4),
    upper1: +(sma + std).toFixed(4),
    lower1: +(sma - std).toFixed(4),
    upper2: +(sma + std * 2).toFixed(4),
    lower2: +(sma - std * 2).toFixed(4),
  };
}

// ============================================
// 유틸
// ============================================
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
