// ============================================
// js/tabs/screener.js — Screener 탭 v3
// GEX 추세 + 플립존 근접도 기반 스크리너
// ============================================

import { state } from '../state.js';
import { CF_API, RAILWAY_URL, CRON_SECRET } from '../config.js';
import { fmt } from '../fmt.js';
import { drillTo } from './structure.js';
import { goToTab } from '../tabs.js';

// ── 내부 상태
let allResults     = [];   // 오늘 스냅샷
let historyCache   = {};   // { symbol: [...90일 rows] }
let sortCol        = 'abs_gex';
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
        <button class="pill" data-f="above">플립존 위</button>
        <button class="pill" data-f="below">플립존 아래</button>
        <button class="pill" data-f="near">근접 (±3%)</button>
        <button class="pill" data-f="manual">수동 추가</button>
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
      <span class="legend-item"><span class="legend-dot green"></span> 플립존 위: 딜러 <span class="green">롱감마</span> (상방 지지)</span>
      <span class="legend-item"><span class="legend-dot red"></span> 플립존 아래: 딜러 <span class="red">숏감마</span> (변동성 증폭)</span>
      <span class="legend-item"><span class="legend-dot amber"></span> GEX 급증: 헤징 압력 축적 중</span>
    </div>

    <div class="sc-table-wrap">
      <table class="sc-tbl" id="sc-tbl">
        <thead>
          <tr>
            <th class="sc-th sortable" data-col="symbol">종목</th>
            <th class="sc-th sortable" data-col="spot_price">현재가</th>
            <th class="sc-th sortable" data-col="flip_strike">플립존</th>
            <th class="sc-th sortable" data-col="distance_pct">거리</th>
            <th class="sc-th sortable" data-col="net_gex">Net GEX</th>
            <th class="sc-th" style="min-width:110px">GEX 추세</th>
            <th class="sc-th sortable" data-col="gex_1d">1일 변화</th>
            <th class="sc-th sortable" data-col="gex_5d">5일 변화</th>
            <th class="sc-th sortable" data-col="gex_10d">10일 변화</th>
            <th class="sc-th">방향</th>
            <th class="sc-th sortable" data-col="atm_iv">ATM IV</th>
            <th class="sc-th">분석</th>
          </tr>
        </thead>
        <tbody id="sc-tbody"></tbody>
      </table>
    </div>

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

  document.getElementById('sc-tbl')?.addEventListener('click', e => {
    const th = e.target.closest('.sortable');
    if (!th) return;
    const col = th.dataset.col;
    sortDir = (sortCol === col && sortDir === 'desc') ? 'asc' : 'desc';
    sortCol = col;
    updateSortIndicators();
    renderTable(getActiveFilter());
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
    const symRes  = await fetch(`${CF_API}/api/screener/symbols`, {
      headers: { 'x-cron-secret': CRON_SECRET },
    });
    const symData = await symRes.json();
    const symbols = (symData.symbols ?? []).map(s => s.symbol ?? s);

    if (!symbols.length) {
      setCollectMsg('수집 대상이 없습니다. 설정에서 심볼을 추가해주세요.', 'error');
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
    const [snapRes, histRes] = await Promise.all([
      fetch(`${CF_API}/api/screener/latest`),
      fetch(`${CF_API}/api/screener/history`),
    ]);

    const snapData = await snapRes.json();
    const histData = await histRes.json();

    if (!Array.isArray(snapData) || !snapData.length) {
      showState('empty', '스크리너 데이터가 없습니다. 위의 [지금 수집] 버튼을 눌러 수집을 시작하세요.');
      return;
    }

    // 히스토리 캐시 구축
    historyCache = {};
    if (Array.isArray(histData)) {
      for (const row of histData) {
        if (!historyCache[row.symbol]) historyCache[row.symbol] = [];
        historyCache[row.symbol].push(row);
      }
      for (const sym of Object.keys(historyCache)) {
        historyCache[sym].sort((a, b) => a.date.localeCompare(b.date));
      }
    }

    allResults = snapData.map(r => enrichWithChanges(r));

    const latestDate = snapData[0]?.date ?? null;
    if (latestDate) {
      document.getElementById('sc-date').textContent = `기준일: ${latestDate}`;
    }

    renderSummary(allResults);
    showContent();
    renderTable(getActiveFilter());

  } catch (err) {
    showState('error', '데이터 로드 실패: ' + err.message);
  } finally {
    isLoading = false;
    if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '↻ 새로고침'; }
  }
}

// ── 변화량 + 방향 계산
function enrichWithChanges(row) {
  const hist     = historyCache[row.symbol] ?? [];
  const todayGex = row.net_gex ?? 0;

  const getGexAt = (daysAgo) => {
    if (hist.length <= daysAgo) return null;
    return hist[hist.length - 1 - daysAgo]?.net_gex ?? null;
  };

  const gex1d  = getGexAt(1);
  const gex5d  = getGexAt(5);
  const gex10d = getGexAt(10);

  // 방향: 최근 3일 평균 대비 오늘
  let direction = 'flat';
  if (hist.length >= 3) {
    const recent3 = hist.slice(-3).map(h => h.net_gex ?? 0);
    const avg3    = recent3.reduce((a, b) => a + b, 0) / 3;
    const diff    = todayGex - avg3;
    const threshold = Math.abs(avg3) * 0.05;
    if      (diff >  threshold) direction = 'up';
    else if (diff < -threshold) direction = 'down';
  }

  return {
    ...row,
    abs_gex:  Math.abs(todayGex),
    gex_1d:   gex1d  != null ? todayGex - gex1d  : null,
    gex_5d:   gex5d  != null ? todayGex - gex5d  : null,
    gex_10d:  gex10d != null ? todayGex - gex10d : null,
    direction,
    history:  hist.map(h => h.net_gex),
  };
}

// ============================================
// 요약 카드
// ============================================
function renderSummary(data) {
  const el = document.getElementById('sc-summary');
  if (!el) return;

  const above   = data.filter(r => (r.distance_pct ?? 0) > 0).length;
  const below   = data.filter(r => (r.distance_pct ?? 0) < 0).length;
  const near    = data.filter(r => Math.abs(r.distance_pct ?? 999) <= 3).length;
  const gexUp   = data.filter(r => r.direction === 'up').length;
  const gexDown = data.filter(r => r.direction === 'down').length;
  const manual  = data.filter(r => r.is_manual === 1).length;

  el.innerHTML = `
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
      <div class="sc-sum-num green">${gexUp}</div>
      <div class="sc-sum-label">GEX 축적 중</div>
    </div>
    <div class="sc-sum-card">
      <div class="sc-sum-num red">${gexDown}</div>
      <div class="sc-sum-label">GEX 해소 중</div>
    </div>
    <div class="sc-sum-card">
      <div class="sc-sum-num muted">${data.length}</div>
      <div class="sc-sum-label">모니터링 종목 (수동 ${manual})</div>
    </div>
  `;
}

// ============================================
// 테이블 렌더
// ============================================
function renderTable(filter = 'all') {
  const tbody = document.getElementById('sc-tbody');
  if (!tbody) return;

  let rows = [...allResults];
  if (filter === 'above')  rows = rows.filter(r => (r.distance_pct ?? 0) > 0);
  if (filter === 'below')  rows = rows.filter(r => (r.distance_pct ?? 0) < 0);
  if (filter === 'near')   rows = rows.filter(r => Math.abs(r.distance_pct ?? 999) <= 3);
  if (filter === 'manual') rows = rows.filter(r => r.is_manual === 1);

  rows.sort((a, b) => {
    const av  = a[sortCol] ?? -Infinity;
    const bv  = b[sortCol] ?? -Infinity;
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="sc-no-data">데이터가 없습니다</td></tr>`;
    document.getElementById('sc-footer').textContent = '';
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const dist = r.distance_pct;
    const gex  = r.net_gex;

    const isNear    = dist != null && Math.abs(dist) <= 3;
    const distColor = dist == null ? 'muted' : dist > 0 ? 'green' : 'red';
    const distStr   = dist != null
      ? isNear
        ? `<span style="color:#eab308">${dist > 0 ? '+' : ''}${dist.toFixed(1)}% ⚡</span>`
        : `<span class="${distColor}">${dist > 0 ? '+' : ''}${dist.toFixed(1)}%</span>`
      : '-';

    const gexColor = gex == null ? 'muted' : gex > 0 ? 'green' : 'red';
    const gexStr   = gex != null
      ? `<span class="${gexColor}">${gex > 0 ? '+' : ''}${gex.toFixed(1)}M</span>`
      : '-';

    const changeCell = (val) => {
      if (val == null) return '<span class="muted">-</span>';
      const c    = val > 0 ? 'green' : val < 0 ? 'red' : 'muted';
      const sign = val > 0 ? '+' : '';
      return `<span class="${c}">${sign}${val.toFixed(1)}M</span>`;
    };

    const dirBadge = r.direction === 'up'
      ? '<span class="sc-dir-badge up">↑ 축적</span>'
      : r.direction === 'down'
      ? '<span class="sc-dir-badge down">↓ 해소</span>'
      : '<span class="sc-dir-badge flat">→ 횡보</span>';

    const manualTag = r.is_manual === 1 ? '<span class="sc-manual-tag">★</span>' : '';
    const flipStr   = r.flip_strike ? `$${r.flip_strike.toFixed(0)}` : '-';
    const ivStr     = r.atm_iv != null ? `${(r.atm_iv * 100).toFixed(1)}%` : '-';

    return `
      <tr class="sc-row" data-sym="${r.symbol}">
        <td class="sc-td-sym">
          <span class="sc-sym">${r.symbol}${manualTag}</span>
          <span class="sc-name">${r.name ?? ''}</span>
        </td>
        <td class="sc-td-price">${r.spot_price ? '$' + r.spot_price.toFixed(2) : '-'}</td>
        <td class="sc-td-price">${flipStr}</td>
        <td class="sc-td-dist">${distStr}</td>
        <td class="sc-td-gex">${gexStr}</td>
        <td class="sc-td-spark">${buildSparkline(r.history ?? [], r.direction)}</td>
        <td class="sc-td-chg">${changeCell(r.gex_1d)}</td>
        <td class="sc-td-chg">${changeCell(r.gex_5d)}</td>
        <td class="sc-td-chg">${changeCell(r.gex_10d)}</td>
        <td class="sc-td-dir">${dirBadge}</td>
        <td class="sc-td-iv">${ivStr}</td>
        <td>
          <button class="sc-drill-btn" data-sym="${r.symbol}" title="Structure 탭에서 분석">▶</button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.sc-drill-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); drillToStructure(btn.dataset.sym); });
  });
  tbody.querySelectorAll('.sc-row').forEach(row => {
    row.addEventListener('click', () => drillToStructure(row.dataset.sym));
  });

  document.getElementById('sc-footer').textContent = `${rows.length}개 종목 표시`;
}

// ============================================
// 스파크라인 SVG
// ============================================
function buildSparkline(vals, direction) {
  const clean = (vals ?? []).filter(v => v != null);
  if (clean.length < 2) return '<span class="sc-spark-empty">-</span>';

  const w   = 100, h = 28, pad = 3;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const rng = max - min || 1;

  const pts = clean.map((v, i) => {
    const x = pad + (i / (clean.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / rng) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const color  = direction === 'up' ? '#22c55e' : direction === 'down' ? '#ef4444' : '#94a3b8';
  const lastPt = pts.split(' ').pop().split(',');

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;overflow:visible">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="2.5" fill="${color}"/>
  </svg>`;
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
    const scoreColor = lastVal == null ? '#64748b' : lastVal >= 0.8 ? '#22c55e' : lastVal <= 0.2 ? '#ef4444' : '#f59e0b';
    const tooltipParts = vals.map((v, i) => {
      const [, m, day] = (dates[i] ?? '').split('-');
      return `${+m}/${+day}: ${v != null ? (v*100).toFixed(0)+'%' : '-'}`;
    }).join('\n');
    return `
      <div class="bb-hm-row" data-sym="${s.symbol}">
        <div class="bb-hm-sym">${s.symbol}</div>
        <div class="bb-hm-bar-wrap" title="${tooltipParts}">
          <div class="bb-hm-bar-track">
            <div class="bb-hm-bar-fill" style="width:100%;background:${buildGradientBar(vals, 10)}"></div>
          </div>
        </div>
        <div class="bb-hm-score" style="color:${scoreColor}">${lastPct}%</div>
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
