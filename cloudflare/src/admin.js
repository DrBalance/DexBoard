// ============================================
// admin.js — 관리자 API 핸들러
// worker.js에서 import해서 사용
// ============================================

const TWELVE_BASE = 'https://api.twelvedata.com';

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
    },
  });
}

// ============================================
// 라우터 — worker.js fetch 핸들러에서 호출
// ============================================
export async function handleAdmin(path, request, env) {
  if (!authCheck(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // ── GET /api/admin/stats
  if (path === '/api/admin/stats' && request.method === 'GET') {
    return handleStats(env);
  }

  // ── GET /api/admin/sectors
  if (path === '/api/admin/sectors' && request.method === 'GET') {
    return handleGetSectors(env);
  }

  // ── POST /api/admin/sectors  (추가)
  if (path === '/api/admin/sectors' && request.method === 'POST') {
    return handleAddSector(request, env);
  }

  // ── DELETE /api/admin/sectors/:key
  const sectorDel = path.match(/^\/api\/admin\/sectors\/(.+)$/);
  if (sectorDel && request.method === 'DELETE') {
    return handleDeleteSector(sectorDel[1], env);
  }

  // ── GET /api/admin/symbols
  if (path === '/api/admin/symbols' && request.method === 'GET') {
    return handleGetSymbols(env);
  }

  // ── POST /api/admin/symbols  (추가)
  if (path === '/api/admin/symbols' && request.method === 'POST') {
    return handleAddSymbol(request, env);
  }

  // ── DELETE /api/admin/symbols/:sym
  const symDel = path.match(/^\/api\/admin\/symbols\/([A-Z0-9.\-]+)$/);
  if (symDel && request.method === 'DELETE') {
    return handleDeleteSymbol(symDel[1], env);
  }

  // ── PATCH /api/admin/symbols/:sym  (활성/비활성 토글)
  const symPatch = path.match(/^\/api\/admin\/symbols\/([A-Z0-9.\-]+)$/);
  if (symPatch && request.method === 'PATCH') {
    return handleToggleSymbol(symPatch[1], request, env);
  }

  // ── POST /api/admin/symbols/refresh  (Twelve Data로 name 갱신)
  if (path === '/api/admin/symbols/refresh' && request.method === 'POST') {
    return handleRefreshSymbols(env);
  }

  // ── GET /api/admin/symbol-etf-map/:sym
  const mapGet = path.match(/^\/api\/admin\/symbol-etf-map\/([A-Z0-9.\-]+)$/);
  if (mapGet && request.method === 'GET') {
    return handleGetEtfMap(mapGet[1], env);
  }

  // ── POST /api/admin/symbol-etf-map  (ETF 매핑 추가)
  if (path === '/api/admin/symbol-etf-map' && request.method === 'POST') {
    return handleAddEtfMap(request, env);
  }

  // ── DELETE /api/admin/symbol-etf-map
  if (path === '/api/admin/symbol-etf-map' && request.method === 'DELETE') {
    return handleDeleteEtfMap(request, env);
  }

  // ── POST /api/admin/bulk-import  (CSV 데이터 일괄 등록)
  if (path === '/api/admin/bulk-import' && request.method === 'POST') {
    return handleBulkImport(request, env);
  }

  // ── GET /api/symbols  (자동완성용 — 인증 불필요)
  // → worker.js에서 별도 처리

  return json({ error: 'Not found' }, 404);
}

// ============================================
// 핸들러 구현
// ============================================

async function handleStats(env) {
  const [total, active, etf, stock, flow] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as n FROM symbols').first(),
    env.DB.prepare('SELECT COUNT(*) as n FROM symbols WHERE is_active=1').first(),
    env.DB.prepare("SELECT COUNT(*) as n FROM symbols WHERE type='etf'").first(),
    env.DB.prepare("SELECT COUNT(*) as n FROM symbols WHERE type='stock'").first(),
    env.DB.prepare("SELECT COUNT(*) as n FROM options_flow WHERE date=date('now')").first(),
  ]);
  return json({
    total:      total.n,
    active:     active.n,
    etf:        etf.n,
    stock:      stock.n,
    flow_today: flow.n,
  });
}

async function handleGetSectors(env) {
  const rows = await env.DB.prepare(
    'SELECT * FROM sectors ORDER BY sort_order, sector_key'
  ).all();
  return json({ sectors: rows.results });
}

async function handleAddSector(request, env) {
  const { sector_key, sector_name, primary_etf, sort_order } = await request.json();
  if (!sector_key || !sector_name) return json({ error: 'sector_key, sector_name 필수' }, 400);

  await env.DB.prepare(`
    INSERT OR REPLACE INTO sectors (sector_key, sector_name, primary_etf, sort_order)
    VALUES (?, ?, ?, ?)
  `).bind(sector_key, sector_name, primary_etf || null, sort_order || 99).run();

  return json({ ok: true, sector_key });
}

async function handleDeleteSector(sector_key, env) {
  await env.DB.prepare('DELETE FROM sectors WHERE sector_key=?').bind(sector_key).run();
  return json({ ok: true, sector_key });
}

async function handleGetSymbols(env) {
  const rows = await env.DB.prepare(`
    SELECT s.*, GROUP_CONCAT(m.etf) as etf_list
    FROM symbols s
    LEFT JOIN symbol_etf_map m ON s.symbol = m.symbol
    GROUP BY s.symbol
    ORDER BY s.type DESC, s.sector, s.symbol
  `).all();
  return json({ symbols: rows.results });
}

async function handleAddSymbol(request, env) {
  const { symbol, name, type, sector, is_active } = await request.json();
  if (!symbol || !name || !type || !sector) {
    return json({ error: 'symbol, name, type, sector 필수' }, 400);
  }

  await env.DB.prepare(`
    INSERT OR REPLACE INTO symbols (symbol, name, type, sector, is_active, added_date)
    VALUES (?, ?, ?, ?, ?, date('now'))
  `).bind(symbol.toUpperCase(), name, type, sector, is_active ?? 1).run();

  return json({ ok: true, symbol });
}

async function handleDeleteSymbol(symbol, env) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM symbols WHERE symbol=?').bind(symbol),
    env.DB.prepare('DELETE FROM symbol_etf_map WHERE symbol=?').bind(symbol),
    env.DB.prepare('DELETE FROM options_flow WHERE symbol=?').bind(symbol),
    env.DB.prepare('DELETE FROM options_baseline WHERE symbol=?').bind(symbol),
    env.DB.prepare('DELETE FROM price_indicators WHERE symbol=?').bind(symbol),
    env.DB.prepare('DELETE FROM screener_scores WHERE symbol=?').bind(symbol),
  ]);
  return json({ ok: true, symbol });
}

async function handleToggleSymbol(symbol, request, env) {
  const { is_active } = await request.json();
  await env.DB.prepare(
    'UPDATE symbols SET is_active=? WHERE symbol=?'
  ).bind(is_active, symbol).run();
  return json({ ok: true, symbol, is_active });
}

// ── 종목 갱신: Twelve Data /quote로 name 업데이트
async function handleRefreshSymbols(env) {
  const rows = await env.DB.prepare(
    'SELECT symbol FROM symbols WHERE is_active=1'
  ).all();

  const symbols = rows.results.map(r => r.symbol);
  const results = { updated: [], failed: [] };

  // Twelve Data는 콤마로 여러 종목 한번에 조회 가능 (최대 8개)
  const chunks = chunkArray(symbols, 8);

  for (const chunk of chunks) {
    try {
      const url = `${TWELVE_BASE}/quote?symbol=${chunk.join(',')}&apikey=${env.TWELVE_DATA_KEY}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await res.json();

      // 단일 종목이면 배열로 통일
      const items = Array.isArray(data) ? data : [data];

      const updates = [];
      for (const item of items) {
        if (item.status === 'error' || !item.symbol || !item.name) {
          results.failed.push(item.symbol || '?');
          continue;
        }
        updates.push(
          env.DB.prepare('UPDATE symbols SET name=? WHERE symbol=?')
            .bind(item.name, item.symbol)
        );
        results.updated.push(item.symbol);
      }

      if (updates.length) await env.DB.batch(updates);

    } catch (err) {
      results.failed.push(...chunk);
    }

    // API 레이트 리밋 방지 (8req/min)
    await sleep(500);
  }

  return json({ ok: true, ...results });
}

async function handleGetEtfMap(symbol, env) {
  const rows = await env.DB.prepare(
    'SELECT * FROM symbol_etf_map WHERE symbol=? ORDER BY is_primary DESC, etf'
  ).bind(symbol).all();
  return json({ symbol, etfs: rows.results });
}

async function handleAddEtfMap(request, env) {
  const { symbol, etf, is_primary } = await request.json();
  if (!symbol || !etf) return json({ error: 'symbol, etf 필수' }, 400);

  // is_primary=1이면 기존 primary 해제
  if (is_primary) {
    await env.DB.prepare(
      'UPDATE symbol_etf_map SET is_primary=0 WHERE symbol=?'
    ).bind(symbol).run();
  }

  await env.DB.prepare(`
    INSERT OR REPLACE INTO symbol_etf_map (symbol, etf, is_primary)
    VALUES (?, ?, ?)
  `).bind(symbol, etf.toUpperCase(), is_primary ? 1 : 0).run();

  // symbols.sector_etf도 primary ETF로 동기화
  if (is_primary) {
    await env.DB.prepare(
      'UPDATE symbols SET sector_etf=? WHERE symbol=?'
    ).bind(etf.toUpperCase(), symbol).run();
  }

  return json({ ok: true, symbol, etf });
}

async function handleDeleteEtfMap(request, env) {
  const { symbol, etf } = await request.json();
  await env.DB.prepare(
    'DELETE FROM symbol_etf_map WHERE symbol=? AND etf=?'
  ).bind(symbol, etf).run();
  return json({ ok: true, symbol, etf });
}

// ── CSV 데이터 일괄 등록
// body: { rows: [{etf, etf_name, ticker}] }
async function handleBulkImport(request, env) {
  const { rows } = await request.json();
  if (!Array.isArray(rows) || !rows.length) return json({ error: 'rows 필요' }, 400);

  // 섹터 ETF → sector_key 매핑
  const sectors = await env.DB.prepare('SELECT sector_key, primary_etf FROM sectors').all();
  const etfToSector = {};
  for (const s of sectors.results) {
    if (s.primary_etf) etfToSector[s.primary_etf] = s.sector_key;
  }

  const symbolStmts = [];
  const mapStmts    = [];
  const seen        = new Set();

  for (const row of rows) {
    const etf    = row.etf?.toUpperCase();
    const ticker = row.ticker?.toUpperCase();
    const name   = row.etf_name || '';

    if (!etf || !ticker) continue;

    // ETF 자체 등록
    if (!seen.has(etf)) {
      seen.add(etf);
      const sectorKey = etfToSector[etf] || 'broad_market';
      symbolStmts.push(
        env.DB.prepare(`
          INSERT OR IGNORE INTO symbols (symbol, name, type, sector, is_active, added_date)
          VALUES (?, ?, 'etf', ?, 1, date('now'))
        `).bind(etf, name + ' ETF', sectorKey)
      );
    }

    // 종목 등록
    if (!seen.has(ticker)) {
      seen.add(ticker);
      const sectorKey = etfToSector[etf] || 'broad_market';
      symbolStmts.push(
        env.DB.prepare(`
          INSERT OR IGNORE INTO symbols (symbol, name, type, sector, sector_etf, is_active, added_date)
          VALUES (?, ?, 'stock', ?, ?, 1, date('now'))
        `).bind(ticker, ticker, sectorKey, etf)
      );
    }

    // ETF 매핑 등록
    mapStmts.push(
      env.DB.prepare(`
        INSERT OR IGNORE INTO symbol_etf_map (symbol, etf, is_primary)
        VALUES (?, ?, 0)
      `).bind(ticker, etf)
    );
  }

  // 배치 실행 (D1 최대 100개씩)
  const allStmts = [...symbolStmts, ...mapStmts];
  for (const chunk of chunkArray(allStmts, 100)) {
    await env.DB.batch(chunk);
  }

  return json({ ok: true, symbols: symbolStmts.length, maps: mapStmts.length });
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
