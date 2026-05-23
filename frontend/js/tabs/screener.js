// ============================================
// js/tabs/screener.js — Screener 탭 v5
//
// 변경사항 (v4 대비):
//   - watchlist JOIN 필드 표시 (회사명, 섹터, 시가총액, Short Float, Beta)
//   - 시가총액 B/M 단위 자동 변환 (fmtMarketCap)
//   - Short Float ≥20% → red, ≥10% → amber 색상 구분
//   - Beta ≥1.5 → red, ≤0.5 → green 색상 구분
//   - 테이블 헤더 컬럼 순서 재정렬
// ============================================

import { state } from '../state.js';
import { CF_API, RAILWAY_URL, CRON_SECRET } from '../config.js';
import { fmt } from '../fmt.js';
import { drillTo } from './structure.js';
import { goToTab } from '../tabs.js';

// ── 내부 상태
let allSymbols     = [];   // 종목 단위로 집계된 데이터
let sortCol        = 'concentration_count';
let sortDir        = 'desc';
let isLoading      = false;
let statusPollTimer = null;

// ============================================
// 진입점
// ============================================
export function initScreener() {
  renderShell();
  checkCollectionStatus();
  loadScreener();
  loadBbMap();
}

export function refreshScreener() {
  loadScreener();
}

// ============================================
// HTML 뼈대
// ============================================
function renderShell() {
  const el = document.getElementById('tab-screener');
  if (!el || el.dataset.ready === '1') return;
  el.dataset.ready = '1';

  el.innerHTML = `
<div class="screener-container">

  <!-- ── 수집 패널 ── -->
  <div class="sc-collect-panel" id="sc-collect-panel">
    <div class="sc-collect-left">
      <div class="sc-collect-title">GEX 수집</div>
      <div class="sc-collect-info" id="sc-collect-info">
        <span class="sc-status-dot idle" id="sc-status-dot"></span>
        <span id="sc-collect-msg">마지막 수집 정보 확인 중...</span>
      </div>
      <div class="sc-progress-wrap" id="sc-progress-wrap" style="display:none">
        <div class="sc-progress-track">
          <div class="sc-progress-fill" id="sc-progress-fill" style="width:0%"></div>
        </div>
        <span class="sc-progress-label" id="sc-progress-label">0 / 0</span>
      </div>
    </div>
    <div class="sc-collect-right">
      <div class="sc-collect-meta" id="sc-collect-meta"></div>
      <button class="sc-btn sc-btn-collect" id="sc-collect-btn">▶ 지금 수집</button>
      <button class="sc-btn sc-btn-force"   id="sc-force-btn" style="display:none">↻ 강제 재수집</button>
      <a href="/admin.html" class="sc-btn" style="text-decoration:none;opacity:.7">⚙ 설정</a>
    </div>
  </div>

  <!-- ── BB 히트맵 ── -->
  <div class="bb-map-section" id="bb-map-section">
    <div class="bb-map-header">
      <span class="bb-map-title">섹터 ETF BB 위치 히트맵
        <span class="bb-map-sub">최근 3주 · 우측 숫자 = 최신값</span>
      </span>
    </div>
    <div class="bb-map-heatmap" id="bb-map-heatmap">
      <div class="bb-map-loading" id="bb-map-loading">BB 히트맵 데이터 불러오는 중...</div>
    </div>
  </div>

  <!-- ── 상단 컨트롤 바 ── -->
  <div class="screener-top-bar">
    <div class="screener-title-row">
      <span class="screener-title">딜러 헤징 압력 스크리너</span>
      <span class="screener-date" id="sc-date">-</span>
    </div>
    <div class="screener-controls">
      <div class="sc-filter-pills" id="sc-filter-pills">
        <button class="pill active" data-f="all">전체</button>
        <button class="pill" data-f="callwall">Call Wall (4+)</button>
        <button class="pill" data-f="above">플립존 위</button>
        <button class="pill" data-f="below">플립존 아래</button>
        <button class="pill" data-f="near">근접 (±3%)</button>
      </div>
      <button class="screener-run-btn" id="sc-refresh-btn">↻ 새로고침</button>
    </div>
  </div>

  <!-- ── 요약 카드 ── -->
  <div class="screener-summary" id="sc-summary"></div>

  <!-- ── 로딩 / 비어있음 ── -->
  <div id="sc-state" class="sc-state-box">
    <div class="sc-state-icon">◌</div>
    <div class="sc-state-msg">스크리너 데이터를 불러오는 중...</div>
  </div>

  <!-- ── 결과 테이블 ── -->
  <div id="sc-content" class="sc-content" style="display:none">
    <div class="sc-legend">
      <span class="legend-item"><span class="legend-dot green"></span> 플립존 위: 딜러 <span class="green">롱감마</span></span>
      <span class="legend-item"><span class="legend-dot red"></span> 플립존 아래: 딜러 <span class="red">숏감마</span></span>
      <span class="legend-item"><span class="legend-dot amber"></span> Call Wall: 동일 스트라이크 콜 DEX 집중</span>
    </div>

    <div class="sc-table-wrap"></div>

    <div class="sc-footer" id="sc-footer"></div>
  </div>

</div>
`;

  bindEvents();
}

// ============================================
// 이벤트 바인딩
// ============================================
function bindEvents() {
  document.getElementById('sc-collect-btn')?.addEventListener('click', () => startCollection(false));
  document.getElementById('sc-force-btn')?.addEventListener('click',   () => startCollection(true));
  document.getElementById('sc-refresh-btn')?.addEventListener('click', () => loadScreener());

  document.getElementById('sc-filter-pills')?.addEventListener('click', e => {
    const btn = e.target.closest('.pill');
    if (!btn) return;
    document.querySelectorAll('#sc-filter-pills .pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderTable(btn.dataset.f);
  });
}

function getActiveFilter() {
  return document.querySelector('#sc-filter-pills .pill.active')?.dataset.f ?? 'all';
}

function updateSortIndicators() {
  document.querySelectorAll('.sc-th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === sortCol) {
      th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

// ============================================
// 수집 상태 확인
// ============================================
async function checkCollectionStatus() {
  try {
    const res  = await fetch(`${RAILWAY_URL}/screener-status`);
    const data = await res.json();
    updateCollectUI(data);
  } catch {
    setCollectMsg('Railway 연결 실패', 'error');
    const btn = document.getElementById('sc-collect-btn');
    if (btn) { btn.style.display = 'inline-flex'; btn.disabled = false; }
  }
}

function updateCollectUI(data) {
  const { running, progress, last_run, today } = data;
  const collectBtn   = document.getElementById('sc-collect-btn');
  const forceBtn     = document.getElementById('sc-force-btn');
  const progressWrap = document.getElementById('sc-progress-wrap');
  const dot          = document.getElementById('sc-status-dot');

  if (running) {
    dot.className          = 'sc-status-dot running';
    collectBtn.disabled    = true;
    collectBtn.textContent = '수집 중...';
    forceBtn.style.display = 'none';
    progressWrap.style.display = 'flex';

    if (progress) {
      const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
      document.getElementById('sc-progress-fill').style.width  = pct + '%';
      document.getElementById('sc-progress-label').textContent =
        `${progress.done} / ${progress.total}${progress.errors > 0 ? ` (오류: ${progress.errors})` : ''}`;
      setCollectMsg(`GEX 수집 중… ${progress.done}/${progress.total}건`, 'running');
    }

    if (!statusPollTimer) {
      statusPollTimer = setInterval(async () => {
        const r = await fetch(`${RAILWAY_URL}/screener-status`).then(x => x.json()).catch(() => null);
        if (!r) return;
        updateCollectUI(r);
        if (!r.running) {
          clearInterval(statusPollTimer);
          statusPollTimer = null;
          if (r.last_run?.ok) loadScreener();
        }
      }, 3000);
    }

  } else {
    dot.className          = 'sc-status-dot idle';
    collectBtn.disabled    = false;
    collectBtn.textContent = '▶ 지금 수집';
    progressWrap.style.display = 'none';

    if (last_run) {
      const isToday = last_run.date === today;
      if (last_run.ok) {
        const ts = last_run.ts ? new Date(last_run.ts).toLocaleTimeString('ko-KR') : '';
        setCollectMsg(
          `마지막 수집: ${last_run.date} (${last_run.count}종목${last_run.errors > 0 ? `, 오류: ${last_run.errors}` : ''}) ${ts}`,
          'ok'
        );
        forceBtn.style.display   = isToday ? 'inline-flex' : 'none';
        collectBtn.style.display = isToday ? 'none' : 'inline-flex';
      } else {
        setCollectMsg(`마지막 수집 실패: ${last_run.error ?? '알 수 없는 오류'}`, 'error');
        forceBtn.style.display   = 'none';
        collectBtn.style.display = 'inline-flex';
      }
      document.getElementById('sc-collect-meta').innerHTML = last_run.ok
        ? `<span class="sc-meta-tag ok">✓ ${last_run.count}종목</span>`
        : `<span class="sc-meta-tag err">✕ 실패</span>`;
    } else {
      setCollectMsg('수집 이력 없음 — 첫 수집을 시작하세요', 'idle');
      forceBtn.style.display   = 'none';
      collectBtn.style.display = 'inline-flex';
    }
  }
}

function setCollectMsg(msg, type = 'idle') {
  const el = document.getElementById('sc-collect-msg');
  if (el) el.textContent = msg;
}

// ============================================
// 수집 시작
// ============================================
async function startCollection(force = false) {
  const collectBtn = document.getElementById('sc-collect-btn');
  const forceBtn   = document.getElementById('sc-force-btn');
  const btn        = force ? forceBtn : collectBtn;
  if (btn) { btn.disabled = true; btn.textContent = '요청 중...'; }

  try {
    setCollectMsg('심볼 목록 조회 중...', 'running');

    // watchlist에서 is_watchlist=TRUE 종목만 가져옴
    const symRes  = await fetch(`${CF_API}/api/screener/symbols`, {
      headers: { 'x-cron-secret': CRON_SECRET },
    });
    const symData = await symRes.json();
    const symbols = (symData.symbols ?? []).map(s => s.symbol ?? s);

    if (!symbols.length) {
      setCollectMsg('수집 대상이 없습니다. watchlist에 종목을 추가해주세요.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = force ? '↻ 강제 재수집' : '▶ 지금 수집'; }
      return;
    }

    const res  = await fetch(`${RAILWAY_URL}/collect-screener`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
      body:    JSON.stringify({ symbols, force }),
    });
    const data = await res.json();

    if (res.status === 202) {
      setCollectMsg(`수집 시작 — ${data.total}개 종목`, 'running');
      document.getElementById('sc-status-dot').className        = 'sc-status-dot running';
      document.getElementById('sc-progress-wrap').style.display = 'flex';
      document.getElementById('sc-progress-label').textContent  = `0 / ${data.total}`;
      if (collectBtn) { collectBtn.disabled = true; collectBtn.textContent = '수집 중...'; }
      if (forceBtn)   forceBtn.style.display = 'none';

      if (!statusPollTimer) {
        statusPollTimer = setInterval(async () => {
          const r = await fetch(`${RAILWAY_URL}/screener-status`).then(x => x.json()).catch(() => null);
          if (!r) return;
          updateCollectUI(r);
          if (!r.running) {
            clearInterval(statusPollTimer);
            statusPollTimer = null;
            if (r.last_run?.ok) loadScreener();
          }
        }, 3000);
      }
    } else if (res.status === 200 && data.skipped) {
      setCollectMsg(data.message, 'ok');
      document.getElementById('sc-force-btn').style.display = 'inline-flex';
      if (collectBtn) { collectBtn.disabled = false; collectBtn.style.display = 'none'; }
    } else if (res.status === 409) {
      setCollectMsg('수집이 이미 진행 중입니다.', 'running');
      if (btn) { btn.disabled = false; btn.textContent = force ? '↻ 강제 재수집' : '▶ 지금 수집'; }
    } else {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
  } catch (err) {
    setCollectMsg(`수집 시작 실패: ${err.message}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = force ? '↻ 강제 재수집' : '▶ 지금 수집'; }
  }
}

// ============================================
// 데이터 로드
// ============================================
async function loadScreener() {
  if (isLoading) return;
  isLoading = true;

  const refreshBtn = document.getElementById('sc-refresh-btn');
  if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = '↻ 로딩 중...'; }
  showState('loading', '스크리너 데이터를 불러오는 중...');

  try {
    const res  = await fetch(`${CF_API}/api/screener/latest`);
    const rows = await res.json();

    if (!Array.isArray(rows) || !rows.length) {
      showState('empty', '스크리너 데이터가 없습니다. 위의 [지금 수집] 버튼을 눌러 수집을 시작하세요.');
      return;
    }

    // 만기별 rows를 종목 단위로 그룹핑
    allSymbols = groupBySymbol(rows);

    // 기준 시각 표시 (가장 최근 updated_at)
    const latestUpdated = rows.reduce((latest, r) =>
      r.updated_at > latest ? r.updated_at : latest, ''
    );
    if (latestUpdated) {
      const d = new Date(latestUpdated);
      document.getElementById('sc-date').textContent =
        `기준: ${d.toLocaleDateString('ko-KR')} ${d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;
    }

    renderSummary(allSymbols);
    showContent();
    renderTable(getActiveFilter());

  } catch (err) {
    showState('error', '데이터 로드 실패: ' + err.message);
  } finally {
    isLoading = false;
    if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '↻ 새로고침'; }
  }
}

// ============================================
// 만기별 rows → 종목 단위 집계
// ============================================
function groupBySymbol(rows) {
  const map = {};

  for (const r of rows) {
    if (!map[r.symbol]) {
      map[r.symbol] = {
        symbol:              r.symbol,
        spot_price:          r.spot_price,
        company:             r.company    ?? null,
        sector:              r.sector     ?? null,
        market_cap:          r.market_cap ?? null,
        short_float:         r.short_float ?? null,
        beta:                r.beta       ?? null,
        target_strike:       r.target_strike,
        concentration_count: r.concentration_count ?? 0,
        distance_pct:        r.distance_pct,
        updated_at:          r.updated_at,
        // 그룹 정보
        is_watchlist_group:  r.is_watchlist_group === 1,
        is_manual_group:     r.is_manual_group === 1,
        // watchlist 그룹이면서 다른 그룹에도 속하면 겹침
        is_overlap:          r.is_watchlist_group === 1 && r.is_manual_group === 1,
        expiries:            [],
        _gexSum:   0,
        _flipList: [],
        _atmIvList: [],
      };
    }

    const sym = map[r.symbol];
    sym.expiries.push({
      expiry_date:  r.expiry_date,
      dte:          r.dte,
      expiry_type:  r.expiry_type,
      net_gex:      r.net_gex,
      flip_strike:  r.flip_strike,
      atm_iv:       r.atm_iv,
      call_oi:      r.call_oi,
      put_oi:       r.put_oi,
      pcr_oi:       r.pcr_oi,
      dex:          r.dex,
    });

    sym._gexSum += r.net_gex ?? 0;
    if (r.flip_strike) sym._flipList.push(r.flip_strike);
    if (r.atm_iv)      sym._atmIvList.push(r.atm_iv);
  }

  return Object.values(map).map(sym => {
    const totalGex      = sym._gexSum;
    const nearestExpiry = sym.expiries.reduce((a, b) => (a.dte ?? 999) < (b.dte ?? 999) ? a : b, sym.expiries[0]);
    const flipStrike    = nearestExpiry?.flip_strike ?? null;
    const atmIv         = sym._atmIvList.length
      ? sym._atmIvList.reduce((a, b) => a + b, 0) / sym._atmIvList.length
      : null;
    const distPct = (sym.spot_price && flipStrike)
      ? Math.round(((sym.spot_price - flipStrike) / flipStrike) * 10000) / 100
      : null;

    delete sym._gexSum;
    delete sym._flipList;
    delete sym._atmIvList;

    return {
      ...sym,
      total_gex:   totalGex,
      abs_gex:     Math.abs(totalGex),
      flip_strike: flipStrike,
      dist_pct:    distPct,
      atm_iv:      atmIv,
    };
  });
}

// ============================================
// 요약 카드
// ============================================
function renderSummary(data) {
  const el = document.getElementById('sc-summary');
  if (!el) return;

  const callWalls = data.filter(r => (r.concentration_count ?? 0) >= 4).length;
  const above     = data.filter(r => (r.dist_pct ?? 0) > 0).length;
  const below     = data.filter(r => (r.dist_pct ?? 0) < 0).length;
  const near      = data.filter(r => Math.abs(r.dist_pct ?? 999) <= 3).length;
  const posGex    = data.filter(r => (r.total_gex ?? 0) > 0).length;

  el.innerHTML = `
    <div class="sc-sum-card">
      <div class="sc-sum-num" style="color:#eab308">${callWalls}</div>
      <div class="sc-sum-label">Call Wall 감지 (4+ 만기)</div>
    </div>
    <div class="sc-sum-card">
      <div class="sc-sum-num green">${above}</div>
      <div class="sc-sum-label">플립존 위 (롱감마)</div>
    </div>
    <div class="sc-sum-card">
      <div class="sc-sum-num red">${below}</div>
      <div class="sc-sum-label">플립존 아래 (숏감마)</div>
    </div>
    <div class="sc-sum-card">
      <div class="sc-sum-num" style="color:#eab308">${near}</div>
      <div class="sc-sum-label">플립존 근접 (±3%)</div>
    </div>
    <div class="sc-sum-card">
      <div class="sc-sum-num green">${posGex}</div>
      <div class="sc-sum-label">Net GEX 양수</div>
    </div>
    <div class="sc-sum-card">
      <div class="sc-sum-num muted">${data.length}</div>
      <div class="sc-sum-label">모니터링 종목</div>
    </div>
  `;
}

// ============================================
// 테이블 렌더 — 그룹별 분리
// ============================================
function renderTable(filter = 'all') {
  const content = document.getElementById('sc-content');
  if (!content) return;

  let rows = [...allSymbols];
  if (filter === 'callwall') rows = rows.filter(r => (r.concentration_count ?? 0) >= 4);
  if (filter === 'above')    rows = rows.filter(r => (r.dist_pct ?? 0) > 0);
  if (filter === 'below')    rows = rows.filter(r => (r.dist_pct ?? 0) < 0);
  if (filter === 'near')     rows = rows.filter(r => Math.abs(r.dist_pct ?? 999) <= 3);

  // 그룹 분리: watchlist 그룹 / 수동 지정 그룹
  const watchlistRows = rows.filter(r => r.is_watchlist_group);
  const manualRows    = rows.filter(r => !r.is_watchlist_group);

  const sortFn = (a, b) => {
    const av  = a[sortCol] ?? -Infinity;
    const bv  = b[sortCol] ?? -Infinity;
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return sortDir === 'asc' ? cmp : -cmp;
  };
  watchlistRows.sort(sortFn);
  manualRows.sort(sortFn);

  const theadHtml = `
    <thead>
      <tr>
        <th class="sc-th sortable" data-col="symbol">종목</th>
        <th class="sc-th sortable" data-col="company">회사명</th>
        <th class="sc-th sortable" data-col="sector">섹터</th>
        <th class="sc-th sortable" data-col="market_cap">시가총액</th>
        <th class="sc-th sortable" data-col="short_float">Short%</th>
        <th class="sc-th sortable" data-col="beta">Beta</th>
        <th class="sc-th sortable" data-col="spot_price">현재가</th>
        <th class="sc-th sortable" data-col="flip_strike">플립존</th>
        <th class="sc-th sortable" data-col="dist_pct">플립존 거리</th>
        <th class="sc-th sortable" data-col="total_gex">Net GEX</th>
        <th class="sc-th sortable" data-col="atm_iv">ATM IV</th>
        <th class="sc-th sortable" data-col="concentration_count">Call Wall</th>
        <th class="sc-th sortable" data-col="target_strike">집중 스트라이크</th>
        <th class="sc-th sortable" data-col="distance_pct">CW 거리</th>
        <th class="sc-th">만기 수</th>
        <th class="sc-th">분석</th>
      </tr>
    </thead>`;

  const buildTable = (dataRows) => `
    <table class="sc-tbl">
      ${theadHtml}
      <tbody>${dataRows.map(buildRow).join('')}</tbody>
    </table>`;

  const tableWrap = content.querySelector('.sc-table-wrap');
  if (!tableWrap) return;

  let html = '';

  // ── 수동 지정 그룹
  if (manualRows.length) {
    html += `<div class="sc-group-header">📌 관심 종목 <span class="sc-group-count">${manualRows.length}</span></div>`;
    html += buildTable(manualRows);
  }

  // ── Watchlist 그룹
  if (watchlistRows.length) {
    html += `<div class="sc-group-header" style="margin-top:24px">⭐ Watchlist <span class="sc-group-count">${watchlistRows.length}</span></div>`;
    html += buildTable(watchlistRows);
  }

  if (!html) {
    html = '<div class="sc-empty">조건에 맞는 종목이 없습니다.</div>';
  }

  tableWrap.innerHTML = html;

  // 이벤트 바인딩
  tableWrap.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      sortDir = (sortCol === col && sortDir === 'desc') ? 'asc' : 'desc';
      sortCol = col;
      updateSortIndicators();
      renderTable(getActiveFilter());
    });
  });
  tableWrap.querySelectorAll('.sc-drill-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); drillToStructure(btn.dataset.sym); });
  });
  tableWrap.querySelectorAll('.sc-row').forEach(row => {
    row.addEventListener('click', () => drillToStructure(row.dataset.sym));
  });

  updateSortIndicators();
  document.getElementById('sc-footer').textContent = `${rows.length}개 종목 표시`;
}

// ── 시가총액 B/M 변환
function fmtMarketCap(val) {
  if (val == null) return '<span class="muted">-</span>';
  const abs = Math.abs(val);
  if (abs >= 1e9) return `$${(val / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(val / 1e6).toFixed(0)}M`;
  return `$${val.toLocaleString()}`;
}

// ── 행 렌더
function buildRow(r) {
  const spot      = r.spot_price;
  const flip      = r.flip_strike;
  const distPct   = r.dist_pct;
  const totalGex  = r.total_gex;
  const callCount = r.concentration_count ?? 0;
  const targetSt  = r.target_strike;
  const callDist  = r.distance_pct;   // Call Wall 스트라이크 vs 현재가

  // ── watchlist 필드
  const companyStr    = r.company    ? `<span class="sc-company" title="${r.company}">${r.company}</span>` : '<span class="muted">-</span>';
  const sectorStr     = r.sector     ? `<span class="sc-sector-tag">${r.sector}</span>` : '<span class="muted">-</span>';
  const mcapStr       = fmtMarketCap(r.market_cap);
  const shortFloatStr = r.short_float != null
    ? `<span class="${r.short_float >= 20 ? 'red' : r.short_float >= 10 ? 'amber' : 'muted'}">${r.short_float.toFixed(1)}%</span>`
    : '<span class="muted">-</span>';
  const betaStr = r.beta != null
    ? `<span class="${r.beta >= 1.5 ? 'red' : r.beta <= 0.5 ? 'green' : ''}">${r.beta.toFixed(2)}</span>`
    : '<span class="muted">-</span>';

  // 플립존 거리
  const isNear     = distPct != null && Math.abs(distPct) <= 3;
  const distColor  = distPct == null ? 'muted' : distPct > 0 ? 'green' : 'red';
  const distStr    = distPct != null
    ? isNear
      ? `<span style="color:#eab308">${distPct > 0 ? '+' : ''}${distPct.toFixed(1)}% ⚡</span>`
      : `<span class="${distColor}">${distPct > 0 ? '+' : ''}${distPct.toFixed(1)}%</span>`
    : '<span class="muted">-</span>';

  // Net GEX
  const gexColor = totalGex == null ? 'muted' : totalGex > 0 ? 'green' : 'red';
  const gexStr   = totalGex != null
    ? `<span class="${gexColor}">${totalGex > 0 ? '+' : ''}${totalGex.toFixed(2)}</span>`
    : '<span class="muted">-</span>';

  // ATM IV
  const ivStr = r.atm_iv != null
    ? `${(r.atm_iv * 100).toFixed(1)}%`
    : '<span class="muted">-</span>';

  // Call Wall 배지
  const callWallBadge = callCount >= 4
    ? `<span class="sc-callwall-badge" title="${callCount}개 만기 집중">⭐ ${callCount}</span>`
    : `<span class="muted">${callCount}</span>`;

  // Call Wall 스트라이크
  const targetStr = targetSt != null
    ? `$${targetSt.toFixed(0)}`
    : '<span class="muted">-</span>';

  // 현재가 vs Call Wall 거리
  const callDistColor = callDist == null ? 'muted' : callDist > 0 ? 'green' : 'red';
  const callDistStr   = callDist != null
    ? `<span class="${callDistColor}">${callDist > 0 ? '+' : ''}${callDist.toFixed(1)}%</span>`
    : '<span class="muted">-</span>';

  const flipStr = flip ? `$${flip.toFixed(0)}` : '<span class="muted">-</span>';

  return `
    <tr class="sc-row${callCount >= 4 ? ' sc-row-callwall' : ''}" data-sym="${r.symbol}">
      <td class="sc-td-sym">
        <span class="sc-sym">${r.symbol}</span>${r.is_overlap ? ' <span class="sc-overlap-star" title="수동 지정 + Watchlist 겹침">⭐</span>' : ''}
      </td>
      <td class="sc-td-company">${companyStr}</td>
      <td class="sc-td-sector">${sectorStr}</td>
      <td class="sc-td-mcap">${mcapStr}</td>
      <td class="sc-td-short">${shortFloatStr}</td>
      <td class="sc-td-beta">${betaStr}</td>
      <td class="sc-td-price">${spot ? '$' + spot.toFixed(2) : '-'}</td>
      <td class="sc-td-price">${flipStr}</td>
      <td class="sc-td-dist">${distStr}</td>
      <td class="sc-td-gex">${gexStr}</td>
      <td class="sc-td-iv">${ivStr}</td>
      <td class="sc-td-cw">${callWallBadge}</td>
      <td class="sc-td-price">${targetStr}</td>
      <td class="sc-td-dist">${callDistStr}</td>
      <td class="sc-td-num">${r.expiries?.length ?? '-'}</td>
      <td>
        <button class="sc-drill-btn" data-sym="${r.symbol}" title="Structure 탭에서 분석">▶</button>
      </td>
    </tr>
  `;
}

// ============================================
// 드릴다운
// ============================================
function drillToStructure(symbol) {
  goToTab('structure');
  setTimeout(() => drillTo(symbol), 50);
}

// ============================================
// UI 상태 전환
// ============================================
function showState(type, msg) {
  document.getElementById('sc-content').style.display = 'none';
  const box  = document.getElementById('sc-state');
  const icon = box.querySelector('.sc-state-icon');
  const txt  = box.querySelector('.sc-state-msg');
  box.style.display    = 'flex';
  icon.textContent     = type === 'loading' ? '◌' : type === 'error' ? '✕' : '◈';
  icon.style.animation = type === 'loading' ? 'spin 1s linear infinite' : '';
  txt.textContent      = msg;
}

function showContent() {
  document.getElementById('sc-state').style.display   = 'none';
  document.getElementById('sc-content').style.display = 'block';
}

// ============================================
// BB 히트맵 (기존 로직 유지)
// ============================================
function bbColor(val) {
  if (val == null) return '#1e293b';
  const v = Math.max(0, Math.min(1, val));
  let r, g, b;
  if (v <= 0.5) { const t = v / 0.5; r = 220; g = Math.round(60 + t * 140); b = 30; }
  else          { const t = (v - 0.5) / 0.5; r = Math.round(220 - t * 186); g = 197; b = Math.round(30 + t * 64); }
  return `rgb(${r},${g},${b})`;
}

function buildGradientBar(vals, maxDays = 10) {
  const slice = vals.slice(-maxDays);
  if (!slice.length) return 'transparent';
  const stops = slice.map((v, i) => {
    const pct = (i / (slice.length - 1 || 1)) * 100;
    return `${v != null ? bbColor(v) : '#1e293b'} ${pct.toFixed(1)}%`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

const _etfHoldingsCache = {};

async function fetchEtfHoldings(etf) {
  if (_etfHoldingsCache[etf]) return _etfHoldingsCache[etf];
  try {
    const res  = await fetch(`${CF_API}/api/etf-holdings/${etf}`);
    const data = await res.json();
    _etfHoldingsCache[etf] = data.holdings ?? [];
    return _etfHoldingsCache[etf];
  } catch { return []; }
}

function toggleHoldingsPanel(etf, btn) {
  const existing = document.getElementById(`holdings-panel-${etf}`);
  if (existing) { existing.remove(); btn.textContent = '종목 ▼'; return; }
  const row   = btn.closest('.bb-hm-row');
  const panel = document.createElement('div');
  panel.id        = `holdings-panel-${etf}`;
  panel.className = 'bb-holdings-panel';
  panel.innerHTML = '<span style="color:var(--text3);font-size:12px">로딩 중...</span>';
  row.after(panel);
  btn.textContent = '종목 ▲';
  fetchEtfHoldings(etf).then(holdings => {
    panel.innerHTML = holdings.length
      ? holdings.map(h => `
          <div class="bb-holding-item">
            <span class="bb-holding-sym">${h.symbol}</span>
            <span class="bb-holding-name">${h.name}</span>
            <span class="bb-holding-pct">${h.pct.toFixed(1)}%</span>
          </div>`).join('')
      : '<span style="color:var(--text3);font-size:12px">구성종목 없음</span>';
  });
}

function renderBbHeatmap(container, data) {
  const { symbols, dates, series } = data;
  const rows = symbols.map(s => {
    const vals    = series[s.symbol] ?? [];
    const lastVal = [...vals].reverse().find(v => v != null);
    const lastPct = lastVal != null ? (lastVal * 100).toFixed(0) : '-';

    // 30% 이하 = 주목 대상 (정상 표시), 초과 = 흐릿하게
    const isLow      = lastVal == null || lastVal <= 0.3;
    const scoreColor = lastVal == null ? '#64748b' : lastVal >= 0.8 ? '#22c55e' : lastVal <= 0.2 ? '#ef4444' : '#f59e0b';

    // 흐릿 처리: grayscale + opacity
    const dimStyle = isLow ? '' : 'filter:grayscale(1);opacity:0.3;';

    const tooltipParts = vals.map((v, i) => {
      const [, m, day] = (dates[i] ?? '').split('-');
      return `${+m}/${+day}: ${v != null ? (v*100).toFixed(0)+'%' : '-'}`;
    }).join('\n');
    return `
      <div class="bb-hm-row${isLow ? '' : ' bb-hm-row-dim'}" data-sym="${s.symbol}" style="${dimStyle}">
        <div class="bb-hm-sym">${s.symbol}</div>
        <div class="bb-hm-bar-wrap" title="${tooltipParts}">
          <div class="bb-hm-bar-track">
            <div class="bb-hm-bar-fill" style="width:100%;background:${buildGradientBar(vals, 10)}"></div>
          </div>
        </div>
        <div class="bb-hm-score" style="color:${isLow ? scoreColor : '#475569'}">${lastPct}%</div>
        <div class="bb-hm-actions">
          <button class="bb-holdings-btn" data-etf="${s.symbol}" type="button">종목 ▼</button>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `${rows}
    <div class="bb-hm-legend-bar">
      <span style="color:#ef4444;font-size:11px">0% (BB 하단)</span>
      <div class="bb-hm-gradient"></div>
      <span style="color:#22c55e;font-size:11px">100% (BB 상단)</span>
    </div>`;

  container.addEventListener('click', e => {
    const btn = e.target.closest('.bb-holdings-btn');
    if (!btn) return;
    toggleHoldingsPanel(btn.dataset.etf, btn);
  });
}

async function loadBbMap() {
  const heatmapEl = document.getElementById('bb-map-heatmap');
  const loading   = document.getElementById('bb-map-loading');
  if (loading) { loading.style.display = 'flex'; loading.textContent = 'BB 히트맵 데이터 불러오는 중...'; }
  try {
    const res  = await fetch(`${CF_API}/api/bb-map-chart?range=3w`);
    const data = await res.json();
    if (!data.dates?.length || !data.symbols?.length) {
      if (loading) loading.textContent = 'BB 히트맵 데이터 없음';
      return;
    }
    if (loading) loading.style.display = 'none';
    renderBbHeatmap(heatmapEl, data);
  } catch (err) {
    if (loading) loading.textContent = 'BB 히트맵 로드 실패: ' + err.message;
  }
}
