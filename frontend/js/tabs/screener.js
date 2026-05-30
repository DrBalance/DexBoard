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

  <!-- ── 롤업 이력 ── -->
  <div id="sc-rollup-section" class="sc-rollup-section" style="display:none">
    <div class="sc-rollup-header">
      <span class="sc-rollup-title">📈 롤업 이력</span>
      <div class="sc-rollup-toggle">
        <button class="pill active" data-rollup="active">현재 종목만</button>
        <button class="pill" data-rollup="all">전체 이력</button>
      </div>
    </div>
    <div id="sc-rollup-body" class="sc-rollup-body"></div>
  </div>

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

  document.getElementById('sc-rollup-section')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-rollup]');
    if (!btn) return;
    document.querySelectorAll('[data-rollup]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadRollupHistory(btn.dataset.rollup === 'active');
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

    // 만기별 rows를 종목 단위로 집계 (screened_tickers 집계값 직접 사용)
    allSymbols = aggregateBySymbol(rows);

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

    // 롤업 이력 섹션 표시
    const rollupSection = document.getElementById('sc-rollup-section');
    if (rollupSection) {
      rollupSection.style.display = 'block';
      loadRollupHistory(true);
    }

  } catch (err) {
    showState('error', '데이터 로드 실패: ' + err.message);
  } finally {
    isLoading = false;
    if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '↻ 새로고침'; }
  }
}

// ============================================
// 만기별 rows → 종목 단위 집계
// screened_tickers의 집계값(upside, concentration_count 등) 직접 사용
// ============================================
function aggregateBySymbol(rows) {
  const map = {};

  for (const r of rows) {
    if (!map[r.symbol]) {
      // groups: GROUP_CONCAT 결과 (콤마 문자열) → 배열
      const groups = (r.groups ?? '').split(',').map(g => g.trim()).filter(Boolean);
      map[r.symbol] = {
        symbol:              r.symbol,
        spot_price:          r.spot_price,
        company:             r.company     ?? null,
        sector:              r.sector      ?? null,
        market_cap:          r.market_cap  ?? null,
        short_float:         r.short_float ?? null,
        beta:                r.beta        ?? null,
        target_strike:       r.target_strike,
        concentration_count: r.concentration_count ?? 0,
        upside:              r.upside,          // screened_tickers에서 직접
        squeeze_stars:       r.squeeze_stars ?? 0,
        squeeze_flags:       r.squeeze_flags ?? null,
        updated_at:          r.updated_at,
        groups,
        expiries:  [],
        _gexSum:   0,
        _flipList: [],
        _atmIvList: [],
      };
    }

    const sym = map[r.symbol];
    sym.expiries.push({
      expiry_date: r.expiry_date,
      dte:         r.dte,
      expiry_type: r.expiry_type,
      net_gex:     r.net_gex,
      flip_strike: r.flip_strike,
      atm_iv:      r.atm_iv,
      call_oi:     r.call_oi,
      put_oi:      r.put_oi,
      pcr_oi:      r.pcr_oi,
      dex:         r.dex,
      peak_call_dex_strike: r.peak_call_dex_strike ?? null,
      peak_call_dex_value:  r.peak_call_dex_value  ?? null,
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
    // 플립존 거리 (현재가 vs 플립존)
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

  // 그룹별 동적 분리 (groups 문자열 기반)
  // 그룹 우선순위: watchlist가 아닌 그룹 먼저, watchlist 마지막
  const groupMap = {};
  for (const r of rows) {
    const grps = r.groups ?? [];
    if (!grps.length) {
      // 그룹 없는 종목은 watchlist로 처리
      if (!groupMap['watchlist']) groupMap['watchlist'] = [];
      groupMap['watchlist'].push(r);
    } else {
      for (const g of grps) {
        if (!groupMap[g]) groupMap[g] = [];
        // 중복 방지 (여러 그룹에 속한 종목)
        if (!groupMap[g].find(x => x.symbol === r.symbol)) groupMap[g].push(r);
      }
    }
  }

  const sortFn = (a, b) => {
    const av  = a[sortCol] ?? -Infinity;
    const bv  = b[sortCol] ?? -Infinity;
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return sortDir === 'asc' ? cmp : -cmp;
  };

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
        <th class="sc-th sortable" data-col="target_strike">목표가</th>
        <th class="sc-th sortable" data-col="upside">상승여력</th>
        <th class="sc-th sortable" data-col="concentration_count">집중도</th>
        <th class="sc-th sortable" data-col="flip_strike">플립존</th>
        <th class="sc-th sortable" data-col="dist_pct">플립존 거리</th>
        <th class="sc-th sortable" data-col="total_gex">Net GEX</th>
        <th class="sc-th sortable" data-col="atm_iv">ATM IV</th>
        <th class="sc-th sortable" data-col="squeeze_stars">스퀴즈</th>
        <th class="sc-th">만기 수</th>
        <th class="sc-th">히트맵</th>
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

  // watchlist를 제외한 그룹 먼저, watchlist 마지막
  const groupOrder = Object.keys(groupMap).filter(g => g !== 'watchlist');
  groupOrder.push('watchlist');

  const groupLabels = {
    watchlist: '⭐ Watchlist',
  };

  for (const g of groupOrder) {
    if (!groupMap[g]?.length) continue;
    const gRows = [...groupMap[g]].sort(sortFn);
    const label = groupLabels[g] ?? `📌 ${g}`;
    const marginTop = html ? 'margin-top:24px' : '';
    html += `<div class="sc-group-header" style="${marginTop}">${label} <span class="sc-group-count">${gRows.length}</span></div>`;
    html += buildTable(gRows);
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
  tableWrap.querySelectorAll('.sc-heatmap-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      showCallWallHeatmap(btn.dataset.sym, Number(btn.dataset.strike), btn);
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
  // 상승여력: screened_tickers.upside 직접 사용
  const upside    = r.upside ?? null;

  // ── 기본 필드
  const companyStr = r.company
    ? `<span class="sc-company" title="${r.company}">${r.company}</span>`
    : '<span class="muted">-</span>';
  const sectorStr  = r.sector
    ? `<span class="sc-sector-tag">${r.sector}</span>`
    : '<span class="muted">-</span>';
  const mcapStr    = fmtMarketCap(r.market_cap);

  // SHORT% — 15% 미만: 회색, 15% 이상: 빨간색
  const shortFloatStr = r.short_float != null
    ? (() => {
        const sf = r.short_float;
        const cls = sf >= 15 ? 'red' : 'muted';
        return `<span class="${cls}">${sf.toFixed(1)}%</span>`;
      })()
    : '<span class="muted">-</span>';

  const betaStr = r.beta != null
    ? `<span class="${r.beta >= 1.5 ? 'red' : r.beta <= 0.5 ? 'green' : ''}">${r.beta.toFixed(2)}</span>`
    : '<span class="muted">-</span>';

  // 플립존 거리
  const isNear    = distPct != null && Math.abs(distPct) <= 3;
  const distColor = distPct == null ? 'muted' : distPct > 0 ? 'green' : 'red';
  const distStr   = distPct != null
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

  // 목표가
  const targetStr = targetSt != null
    ? `$${targetSt.toFixed(0)}`
    : '<span class="muted">-</span>';

  // 상승여력 — 컬러바 + % (최대 +30% 기준)
  const upsideStr = upside != null
    ? (() => {
        const pct     = Math.max(0, Math.min(upside, 30));
        const barPct  = Math.round((pct / 30) * 100);
        const color   = upside >= 15 ? '#22c55e' : upside >= 5 ? '#4ade80' : '#86efac';
        return `
          <span style="display:inline-flex;align-items:center;gap:5px;white-space:nowrap">
            <span style="
              display:inline-block;width:48px;height:6px;
              background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden;
              vertical-align:middle;
            ">
              <span style="
                display:block;height:100%;width:${barPct}%;
                background:${color};border-radius:3px;
              "></span>
            </span>
            <span style="color:${color}">${upside > 0 ? '+' : ''}${upside.toFixed(1)}%</span>
          </span>`;
      })()
    : '<span class="muted">-</span>';

  // 집중도 — 4: 회색, 5: 흰색, 6: 노란색, 7+: 노란색+⚡
  const concentrationStr = (() => {
    if (callCount <= 0) return '<span class="muted">-</span>';
    if (callCount <= 4) return `<span class="muted">${callCount}</span>`;
    if (callCount === 5) return `<span>${callCount}</span>`;
    if (callCount === 6) return `<span style="color:#eab308">${callCount}</span>`;
    return `<span style="color:#eab308">${callCount} ⚡</span>`;
  })();

  const flipStr = flip ? `$${flip.toFixed(0)}` : '<span class="muted">-</span>';

  return `
    <tr class="sc-row${callCount >= 4 ? ' sc-row-callwall' : ''}" data-sym="${r.symbol}">
      <td class="sc-td-sym">
        <span class="sc-sym">${r.symbol}</span>
      </td>
      <td class="sc-td-company">${companyStr}</td>
      <td class="sc-td-sector">${sectorStr}</td>
      <td class="sc-td-mcap">${mcapStr}</td>
      <td class="sc-td-short">${shortFloatStr}</td>
      <td class="sc-td-beta">${betaStr}</td>
      <td class="sc-td-price">${spot ? '$' + spot.toFixed(2) : '-'}</td>
      <td class="sc-td-price">${targetStr}</td>
      <td class="sc-td-dist">${upsideStr}</td>
      <td class="sc-td-cw">${concentrationStr}</td>
      <td class="sc-td-price">${flipStr}</td>
      <td class="sc-td-dist">${distStr}</td>
      <td class="sc-td-gex">${gexStr}</td>
      <td class="sc-td-iv">${ivStr}</td>
      <td class="sc-td-squeeze">${'★'.repeat(r.squeeze_stars ?? 0) || '-'}</td>
      <td class="sc-td-num">${r.expiries?.length ?? '-'}</td>
      <td>
        <button class="sc-heatmap-btn" data-sym="${r.symbol}" data-strike="${r.target_strike ?? ''}" title="콜월 히트맵">▦</button>
      </td>
      <td>
        <button class="sc-drill-btn" data-sym="${r.symbol}" title="Structure 탭에서 분석">▶</button>
      </td>
    </tr>
  `;
}

// ============================================
// 롤업 이력 로드
// ============================================
async function loadRollupHistory(activeOnly = true) {
  const body = document.getElementById('sc-rollup-body');
  if (!body) return;
  body.innerHTML = '<div class="sc-rollup-loading">불러오는 중...</div>';

  try {
    const res  = await fetch(`${CF_API}/api/screener/rollup-history?active_only=${activeOnly}`);
    const data = await res.json();
    const rows = data.history ?? [];

    if (!rows.length) {
      body.innerHTML = '<div class="sc-rollup-empty">롤업 이력이 없습니다.</div>';
      return;
    }

    const fmt = (dt) => {
      const d = new Date(dt);
      return d.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })
        + ' ' + d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
    };

    body.innerHTML = `
      <table class="sc-tbl sc-rollup-tbl">
        <thead>
          <tr>
            <th class="sc-th">종목</th>
            <th class="sc-th">이전 목표가</th>
            <th class="sc-th">새 목표가</th>
            <th class="sc-th">현재가</th>
            <th class="sc-th">감지 시각</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => {
            const isUp = r.new_strike > r.old_strike;
            const arrow = isUp ? '↑' : '↓';
            const arrowColor = isUp ? 'var(--green)' : 'var(--red)';
            return `
            <tr class="sc-row">
              <td class="sc-td-price" style="font-weight:700">${r.ticker}</td>
              <td class="sc-td-price" style="color:var(--text3)">$${r.old_strike}</td>
              <td class="sc-td-price"><span style="color:${arrowColor}">${arrow}</span> $${r.new_strike}</td>
              <td class="sc-td-price">${r.spot_price ? '$' + r.spot_price.toFixed(2) : '-'}</td>
              <td style="padding:9px 12px;font-size:12px;color:var(--text3);white-space:nowrap">${fmt(r.detected_at)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    body.innerHTML = `<div class="sc-rollup-error">이력 로드 실패: ${e.message}</div>`;
  }
}

// ============================================
// 콜월 히트맵 팝오버
// ============================================
let _heatmapPopover = null;

function showCallWallHeatmap(symbol, targetStrike, triggerEl) {
  // 기존 팝오버 닫기
  if (_heatmapPopover) {
    _heatmapPopover.remove();
    _heatmapPopover = null;
    if (_heatmapPopover?._sym === symbol) return;
  }

  const pop = document.createElement('div');
  pop.className = 'sc-heatmap-pop';
  pop.innerHTML = `<div class="sc-heatmap-pop-title">${symbol} · $${targetStrike} 콜월</div>
    <div class="sc-heatmap-pop-body">로딩 중...</div>`;
  document.body.appendChild(pop);
  _heatmapPopover = pop;
  _heatmapPopover._sym = symbol;

  // 위치 계산
  const rect = triggerEl.getBoundingClientRect();
  pop.style.top  = `${rect.bottom + window.scrollY + 4}px`;
  pop.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 180)}px`;

  // 외부 클릭 시 닫기
  const close = (e) => {
    if (!pop.contains(e.target) && e.target !== triggerEl) {
      pop.remove();
      _heatmapPopover = null;
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);

  try {
    // D1에 저장된 peak_call_dex_strike/value 사용 (실시간 API 호출 불필요)
    const symData = allSymbols.find(s => s.symbol === symbol);
    const expiries = (symData?.expiries ?? []).sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));

    if (!expiries.length) {
      pop.querySelector('.sc-heatmap-pop-body').innerHTML =
        '<div style="color:#999;font-size:11px;padding:8px">데이터 없음</div>';
      return;
    }

    // 강도 계산용 최대 DEX
    const activeDex = expiries
      .filter(e => Number(e.peak_call_dex_strike) === Number(targetStrike))
      .map(e => e.peak_call_dex_value ?? 0);
    const maxDex = Math.max(...activeDex, 0.0001);

    const rows = expiries.map(exp => {
      const isMax  = Number(exp.peak_call_dex_strike) === Number(targetStrike);
      const dex    = isMax ? (exp.peak_call_dex_value ?? 0) : 0;
      const label  = exp.expiry_date.slice(5);

      let bg, borderStyle, textColor, display;

      if (isMax && dex > 0.001) {
        // target_strike가 이 만기의 최대 DEX → 초록
        const intensity = Math.min(dex / maxDex, 1);
        bg          = `rgba(34,197,94,${(intensity * 0.8 + 0.2).toFixed(2)})`;
        borderStyle = '';
        textColor   = intensity > 0.5 ? '#fff' : '#333';
        display     = String(Math.round(dex * 100));
      } else {
        // 다른 스트라이크가 더 크거나 없음 → 점선
        bg          = 'transparent';
        borderStyle = 'border:1.5px dashed #ccc;';
        textColor   = 'transparent';
        display     = '0';
      }

      return `<div class="sc-hm-row">
        <span class="sc-hm-label">${label}</span>
        <div class="sc-hm-cell" style="background:${bg};color:${textColor};${borderStyle}">
          ${display}
        </div>
      </div>`;
    }).join('');

    pop.querySelector('.sc-heatmap-pop-body').innerHTML = rows;

  } catch (e) {
    pop.querySelector('.sc-heatmap-pop-body').innerHTML =
      `<div style="color:#e55;font-size:11px;padding:8px">로드 실패: ${e.message}</div>`;
  }
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
