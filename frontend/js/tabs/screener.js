// ============================================
// js/tabs/screener.js — Screener 탭 v2
// 수집 버튼 + 진행상황 표시 + 스크리너 테이블
// ============================================

import { state } from '../state.js';
import { CF_API, RAILWAY_URL, CRON_SECRET } from '../config.js';
import { fmt } from '../fmt.js';
import { drillTo } from './structure.js';
import { goToTab } from '../tabs.js';

// ── 내부 상태
let allResults     = [];
let sectorFilter   = 'all';
let sortCol        = 'total_score';
let sortDir        = 'desc';
let isLoading      = false;
let lastDate       = null;
let statusPollTimer = null;



// ============================================
// 진입점
// ============================================
export function initScreener() {
  renderShell();
  checkCollectionStatus();
  loadScreener();
  initBbMap();
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
      <div class="sc-collect-title">데이터 수집</div>
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
      <button class="sc-btn sc-btn-collect" id="sc-collect-btn">
        ▶ 지금 수집
      </button>
      <button class="sc-btn sc-btn-force" id="sc-force-btn" style="display:none">
        ↻ 강제 재수집
      </button>
      <button class="sc-btn sc-btn-rescore" id="sc-rescore-btn" title="기존 데이터로 점수만 재계산">⚡ 재평가</button>
      <a href="/admin.html" class="sc-btn" style="text-decoration:none;opacity:.7">⚙ 설정</a>
    </div>
  </div>

  <!-- ── BB 히트맵 ── -->
  <div class="bb-map-section" id="bb-map-section">
    <div class="bb-map-header">
      <span class="bb-map-title">섹터 ETF BB 위치 히트맵 <span class="bb-map-sub">최근 3주 · 우측 숫자 = 최신값</span></span>
    </div>
    <div class="bb-map-heatmap" id="bb-map-heatmap">
      <div class="bb-map-loading" id="bb-map-loading">BB 히트맵 데이터 불러오는 중...</div>
    </div>
  </div>

  <!-- ── 상단 컨트롤 바 ── -->
  <div class="screener-top-bar">
    <div class="screener-title-row">
      <span class="screener-title">딜러 헷지 압력 스크리너</span>
      <span class="screener-date" id="sc-date">-</span>
    </div>
    <div class="screener-controls">
      <div class="sc-sector-pills" id="sc-sector-pills">
        <button class="pill active" data-s="all">전체</button>
      </div>
      <button class="screener-run-btn" id="sc-refresh-btn" title="새로고침">↻ 새로고침</button>
    </div>
  </div>

  <!-- ── 요약 카드 행 ── -->
  <div class="screener-summary" id="sc-summary"></div>

  <!-- ── 로딩 / 비어있음 ── -->
  <div id="sc-state" class="sc-state-box">
    <div class="sc-state-icon">◌</div>
    <div class="sc-state-msg">스크리너 데이터를 불러오는 중...</div>
  </div>

  <!-- ── 결과 테이블 ── -->
  <div id="sc-content" class="sc-content" style="display:none">

    <div class="sc-legend">
      <span class="legend-item"><span class="legend-dot green"></span> 8-10점: 강한 매수 신호</span>
      <span class="legend-item"><span class="legend-dot amber"></span> 5-7점: 중립 관찰</span>
      <span class="legend-item"><span class="legend-dot red"></span> 0-4점: 약한 신호</span>
      <span class="legend-item"><span class="legend-dot flash"></span> BREAKDOWN: -2σ 이탈</span>
    </div>

    <div class="sc-table-wrap">
      <table class="sc-tbl" id="sc-tbl">
        <thead>
          <tr>
            <th class="sc-th sortable" data-col="symbol">종목</th>
            <th class="sc-th">섹터 ETF</th>
            <th class="sc-th sortable" data-col="total_score">총점 ↕</th>
            <th class="sc-th sortable" data-col="score_skew_count">A 스큐만기</th>
            <th class="sc-th sortable" data-col="score_bet_ratio">B 베팅비율</th>
            <th class="sc-th sortable" data-col="score_flip_dist">C Flip안정</th>
            <th class="sc-th sortable" data-col="score_premium_gate">D $200K</th>
            <th class="sc-th sortable" data-col="total_call_premium">총프리미엄</th>
            <th class="sc-th sortable" data-col="call_skew_count">스큐만기수</th>
            <th class="sc-th sortable" data-col="iv_skew">IV스큐</th>
            <th class="sc-th sortable" data-col="close">현재가</th>
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
  // 수집 버튼
  document.getElementById('sc-collect-btn')?.addEventListener('click', () => startCollection(false));
  document.getElementById('sc-force-btn')?.addEventListener('click', () => startCollection(true));
  document.getElementById('sc-rescore-btn')?.addEventListener('click', () => startRescore());

  // 새로고침
  document.getElementById('sc-refresh-btn')?.addEventListener('click', () => loadScreener());

  // 섹터 필터 pills
  document.getElementById('sc-sector-pills')?.addEventListener('click', e => {
    const btn = e.target.closest('.pill');
    if (!btn) return;
    document.querySelectorAll('#sc-sector-pills .pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    sectorFilter = btn.dataset.s;
    renderTable();
  });

  // 테이블 정렬
  document.getElementById('sc-tbl')?.addEventListener('click', e => {
    const th = e.target.closest('.sortable');
    if (!th) return;
    const col = th.dataset.col;
    if (sortCol === col) {
      sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    } else {
      sortCol = col;
      sortDir = 'desc';
    }
    updateSortIndicators();
    renderTable();
  });
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
  } catch (err) {
    console.warn('[screener] status check failed:', err.message);
    setCollectMsg('Railway 연결 실패 — 수집 버튼으로 시작하세요', 'error');
    // 연결 실패 시에도 수집 버튼은 반드시 표시
    const collectBtn = document.getElementById('sc-collect-btn');
    const forceBtn   = document.getElementById('sc-force-btn');
    if (collectBtn) {
      collectBtn.style.display = 'inline-flex';
      collectBtn.disabled      = false;
      collectBtn.textContent   = '▶ 지금 수집';
    }
    if (forceBtn) forceBtn.style.display = 'none';
  }
}

function updateCollectUI(data) {
  const { running, progress, last_run, today } = data;

  const collectBtn = document.getElementById('sc-collect-btn');
  const forceBtn   = document.getElementById('sc-force-btn');
  const progressWrap = document.getElementById('sc-progress-wrap');
  const dot = document.getElementById('sc-status-dot');

  if (running) {
    // 수집 중
    dot.className = 'sc-status-dot running';
    collectBtn.disabled = true;
    collectBtn.textContent = '수집 중...';
    forceBtn.style.display = 'none';
    progressWrap.style.display = 'flex';

    if (progress) {
      const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
      document.getElementById('sc-progress-fill').style.width  = pct + '%';
      document.getElementById('sc-progress-label').textContent =
        `${progress.done} / ${progress.total}${progress.errors > 0 ? ` (오류: ${progress.errors})` : ''}`;
      const stageLabel = progress.stage === 'bb_map'
        ? 'BB맵 가격 수집 중'
        : `옵션 수집 중… ${progress.done}/${progress.total}건`;
      setCollectMsg(stageLabel, 'running');
    }

    // 폴링
    if (!statusPollTimer) {
      statusPollTimer = setInterval(async () => {
        const r = await fetch(`${RAILWAY_URL}/screener-status`).then(x => x.json()).catch(() => null);
        if (!r) return;
        updateCollectUI(r);
        if (!r.running) {
          clearInterval(statusPollTimer);
          statusPollTimer = null;
          if (r.last_run?.ok) loadScreener();  // 수집 완료 시 자동 갱신
        }
      }, 3000);
    }

  } else {
    dot.className = 'sc-status-dot idle';
    collectBtn.disabled = false;
    collectBtn.textContent = '▶ 지금 수집';
    progressWrap.style.display = 'none';

    if (last_run) {
      const isToday = last_run.date === today;
      if (last_run.ok) {
        const ts = last_run.ts ? new Date(last_run.ts).toLocaleTimeString('ko-KR') : '';
        const bbPart = last_run.bb_count != null
          ? ` · BB맵 ${last_run.bb_count}종목`
          : '';
        setCollectMsg(
          `마지막 수집: ${last_run.date} (옵션 ${last_run.count}종목${bbPart}${last_run.errors > 0 ? `, 오류: ${last_run.errors}` : ''}) ${ts}`,
          'ok'
        );
        if (isToday) {
          forceBtn.style.display = 'inline-flex';
          collectBtn.style.display = 'none';
        } else {
          forceBtn.style.display = 'none';
          collectBtn.style.display = 'inline-flex';
        }
      } else {
        setCollectMsg(`마지막 수집 실패: ${last_run.error ?? '알 수 없는 오류'}`, 'error');
        forceBtn.style.display = 'none';
        collectBtn.style.display = 'inline-flex';
      }

      // 메타 정보
      document.getElementById('sc-collect-meta').innerHTML =
        last_run.ok
          ? `<span class="sc-meta-tag ok">✓ ${last_run.count}종목</span>`
          : `<span class="sc-meta-tag err">✕ 실패</span>`;
    } else {
      setCollectMsg('수집 이력 없음 — 첫 수집을 시작하세요', 'idle');
      forceBtn.style.display = 'none';
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
  const btn = force ? forceBtn : collectBtn;
  if (btn) { btn.disabled = true; btn.textContent = '요청 중...'; }

  try {
    // D1에서 수집 대상 심볼 목록 조회 (CRON_SECRET 인증)
    setCollectMsg('심볼 목록 조회 중...', 'running');
    const symRes = await fetch(`${CF_API}/api/collect-targets`, {
      headers: { 'x-cron-secret': CRON_SECRET },
    });
    const symData = await symRes.json();
    const symbols = symData.symbols ?? [];

    if (!symbols.length) {
      setCollectMsg('수집 대상 심볼이 없습니다. 설정 탭에서 그룹/심볼을 먼저 추가해주세요.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = force ? '↻ 강제 재수집' : '▶ 지금 수집'; }
      return;
    }

    const res = await fetch(`${RAILWAY_URL}/collect-screener`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-cron-secret': CRON_SECRET,
      },
      body: JSON.stringify({ symbols, force }),
    });

    const data = await res.json();

    if (res.status === 202) {
      // 수집 시작됨
      setCollectMsg(`수집 시작 — ${data.total}개 종목`, 'running');
      document.getElementById('sc-status-dot').className = 'sc-status-dot running';
      document.getElementById('sc-progress-wrap').style.display = 'flex';
      document.getElementById('sc-progress-label').textContent  = `0 / ${data.total}`;
      if (collectBtn) { collectBtn.disabled = true; collectBtn.textContent = '수집 중...'; }
      if (forceBtn)   forceBtn.style.display = 'none';

      // 폴링 시작
      if (!statusPollTimer) {
        statusPollTimer = setInterval(async () => {
          const r = await fetch(`${RAILWAY_URL}/screener-status`).then(x => x.json()).catch(() => null);
          if (!r) return;
          updateCollectUI(r);
          if (!r.running) {
            clearInterval(statusPollTimer);
            statusPollTimer = null;
            if (r.last_run?.ok) {
              loadScreener();
            }
          }
        }, 3000);
      }
    } else if (res.status === 200 && data.skipped) {
      // 이미 오늘 수집됨
      setCollectMsg(data.message, 'ok');
      const forceB = document.getElementById('sc-force-btn');
      if (forceB) forceB.style.display = 'inline-flex';
      if (collectBtn) { collectBtn.disabled = false; collectBtn.style.display = 'none'; }
    } else if (res.status === 409) {
      setCollectMsg('수집이 이미 진행 중입니다.', 'running');
      if (btn) { btn.disabled = false; btn.textContent = force ? '↻ 강제 재수집' : '▶ 지금 수집'; }
    } else {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
  } catch (err) {
    console.error('[screener] 수집 시작 실패:', err.message);
    setCollectMsg(`수집 시작 실패: ${err.message}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = force ? '↻ 강제 재수집' : '▶ 지금 수집'; }
  }
}


// ============================================
// 재평가 (기존 데이터로 점수만 재계산)
// ============================================
async function startRescore() {
  const btn = document.getElementById('sc-rescore-btn');
  if (btn) { btn.disabled = true; btn.textContent = '재평가 중...'; }
  setCollectMsg('기존 데이터로 점수 재계산 중...', 'running');
  try {
    const res = await fetch(`${RAILWAY_URL}/rescore`, {
      method:  'POST',
      headers: { 'x-cron-secret': CRON_SECRET },
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      setCollectMsg(`재평가 완료 — ${data.count}개 종목 (기준일: ${data.date})`, 'ok');
      await loadScreener();
    } else {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
  } catch (err) {
    console.error('[screener] 재평가 실패:', err.message);
    setCollectMsg(`재평가 실패: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ 재평가'; }
  }
}

// ============================================
// 데이터 로드 (CF Worker D1 조회)
// ============================================
async function loadScreener() {
  if (isLoading) return;
  isLoading = true;

  // 새로고침 버튼 로딩 상태
  const refreshBtn = document.getElementById('sc-refresh-btn');
  if (refreshBtn) {
    refreshBtn.disabled    = true;
    refreshBtn.textContent = '↻ 로딩 중...';
  }

  showState('loading', '스크리너 데이터를 불러오는 중...');

  try {
    const res  = await fetch(`${CF_API}/api/screener`);
    const data = await res.json();

    if (!Array.isArray(data) || !data.length) {
      showState('empty', '스크리너 데이터가 없습니다. 위의 [지금 수집] 버튼을 눌러 수집을 시작하세요.');
      isLoading = false;
      return;
    }

    allResults = data;
    lastDate   = data[0]?.date ?? null;

    if (lastDate) {
      document.getElementById('sc-date').textContent = `기준일: ${lastDate}`;
    }

    renderSummary(data);
    showContent();
    renderTable();

  } catch (err) {
    console.error('[screener] load error:', err);
    showState('error', '데이터 로드 실패: ' + err.message);
  } finally {
    isLoading = false;
    const refreshBtn = document.getElementById('sc-refresh-btn');
    if (refreshBtn) {
      refreshBtn.disabled    = false;
      refreshBtn.textContent = '↻ 새로고침';
    }
  }
}

// ── 요약 카드
function renderSummary(data) {
  const el = document.getElementById('sc-summary');
  if (!el) return;

  const strong     = data.filter(r => r.total_score >= 8).length;
  const moderate   = data.filter(r => r.total_score >= 5 && r.total_score < 8).length;
  const weak       = data.filter(r => r.total_score < 5).length;
  const breakdowns = data.filter(r => r.bb_flag === 'BREAKDOWN').length;
  const avgScore   = data.length
    ? (data.reduce((s, r) => s + (r.total_score || 0), 0) / data.length).toFixed(1)
    : '-';

  el.innerHTML = `
    <div class="sc-sum-card">
      <div class="sc-sum-num green">${strong}</div>
      <div class="sc-sum-label">강한 신호 (8+)</div>
    </div>
    <div class="sc-sum-card">
      <div class="sc-sum-num amber">${moderate}</div>
      <div class="sc-sum-label">중립 관찰 (5~7)</div>
    </div>
    <div class="sc-sum-card">
      <div class="sc-sum-num muted">${weak}</div>
      <div class="sc-sum-label">약한 신호 (~4)</div>
    </div>
    <div class="sc-sum-card">
      <div class="sc-sum-num red">${breakdowns}</div>
      <div class="sc-sum-label">BREAKDOWN</div>
    </div>
    <div class="sc-sum-card">
      <div class="sc-sum-num">${avgScore}</div>
      <div class="sc-sum-label">평균 점수</div>
    </div>
    <div class="sc-sum-card">
      <div class="sc-sum-num muted">${data.length}</div>
      <div class="sc-sum-label">종목 수</div>
    </div>
  `;
}

// ── 테이블 렌더
function renderTable() {
  const tbody = document.getElementById('sc-tbody');
  if (!tbody) return;

  let rows = sectorFilter === 'all'
    ? [...allResults]
    : allResults.filter(r => r.sector === sectorFilter);

  rows.sort((a, b) => {
    const av = a[sortCol] ?? -Infinity;
    const bv = b[sortCol] ?? -Infinity;
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="sc-no-data">해당 섹터에 데이터가 없습니다</td></tr>`;
    document.getElementById('sc-footer').textContent = '';
    return;
  }

  tbody.innerHTML = rows.map((r) => {
    const scoreColor = r.total_score >= 8 ? 'green' : r.total_score >= 5 ? 'amber' : 'red';
    const bbPct      = r.bb_position != null ? (r.bb_position * 100).toFixed(0) + '%' : '-';
    const ivSkewStr  = r.iv_skew != null
      ? `<span style="color:${r.iv_skew > 0 ? '#22c55e' : '#ef4444'}">${r.iv_skew > 0 ? '+' : ''}${(r.iv_skew * 100).toFixed(1)}%</span>`
      : '-';
    const breakdown = r.bb_flag === 'BREAKDOWN' ? '<span class="bd-tag">⚡BD</span>' : '';

    return `
      <tr class="sc-row" data-sym="${r.symbol}">
        <td class="sc-td-sym">
          <span class="sc-sym">${r.symbol}</span>
          <span class="sc-name">${r.name || ''}</span>
          <span class="sc-type ${r.type}">${r.type}</span>
          ${breakdown}
        </td>
        <td class="sc-td-etf">
          ${r.sector_etf ? `<span class="sc-etf-tag">${r.sector_etf}</span>` : '-'}
        </td>
        <td class="sc-td-score">
          <div class="score-badge ${scoreColor}">${r.total_score}</div>
          <div class="mini-score-bar">
            <div class="mini-score-fill ${scoreColor}" style="width:${(r.total_score / 10) * 100}%"></div>
          </div>
        </td>
        <td class="sc-td-sub">${scoreCell(r.score_skew_count ?? r.score_skew, 3)}</td>
        <td class="sc-td-sub">${scoreCell(r.score_bet_ratio ?? r.score_bb, 3)}</td>
        <td class="sc-td-sub">${scoreCell(r.score_flip_dist ?? r.score_vol_squeeze, 3)}</td>
        <td class="sc-td-sub">${scoreCell(r.score_premium_gate ?? 0, 1)}</td>
        <td class="sc-td-price">${r.total_call_premium
          ? '$' + Number(r.total_call_premium).toLocaleString()
          : '-'}</td>
        <td class="sc-td-price">${r.call_skew_count ?? '-'}</td>

        <td>${ivSkewStr}</td>
        <td class="sc-td-price">${r.close ? '$' + r.close.toFixed(2) : '-'}</td>
        <td>
          <button class="sc-drill-btn" data-sym="${r.symbol}" title="Structure 탭에서 분석">
            ▶ 분석
          </button>
        </td>
      </tr>
    `;
  }).join('');

  // 드릴다운 이벤트
  tbody.querySelectorAll('.sc-drill-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      drillToStructure(btn.dataset.sym);
    });
  });
  tbody.querySelectorAll('.sc-row').forEach(row => {
    row.addEventListener('click', () => drillToStructure(row.dataset.sym));
  });

  document.getElementById('sc-footer').textContent =
    `${rows.length}개 종목 표시${sectorFilter !== 'all' ? ` · 섹터: ${sectorFilter}` : ''}`;
}

function drillToStructure(symbol) {
  goToTab('structure');
  setTimeout(() => drillTo(symbol), 50);
}

function scoreCell(score, max) {
  const c = score >= max ? 'green' : score > 0 ? 'amber' : 'muted';
  return `<span class="sc-sub-score ${c}">${score ?? 0}/${max}</span>`;
}

function showState(type, msg) {
  document.getElementById('sc-content').style.display = 'none';
  const box  = document.getElementById('sc-state');
  const icon = box.querySelector('.sc-state-icon');
  const txt  = box.querySelector('.sc-state-msg');
  box.style.display = 'flex';
  icon.textContent  = type === 'loading' ? '◌' : type === 'error' ? '✕' : '◈';
  icon.style.animation = type === 'loading' ? 'spin 1s linear infinite' : '';
  txt.textContent   = msg;
}

function showContent() {
  document.getElementById('sc-state').style.display   = 'none';
  document.getElementById('sc-content').style.display = 'block';
}

// ============================================
// BB 맵 차트
// ============================================
// BB 히트맵
// ============================================

// bb_position → 색상 변환 (0=빨강, 0.5=노랑, 1=초록)
function bbColor(val) {
  if (val == null) return '#1e293b'; // 데이터 없음 → 어두운 회색
  const v = Math.max(0, Math.min(1, val));
  let r, g, b;
  if (v <= 0.5) {
    // 빨강(0) → 노랑(0.5)
    const t = v / 0.5;
    r = 220;
    g = Math.round(60 + t * (200 - 60));  // 60→200
    b = 30;
  } else {
    // 노랑(0.5) → 초록(1)
    const t = (v - 0.5) / 0.5;
    r = Math.round(220 - t * (220 - 34)); // 220→34
    g = Math.round(200 + t * (197 - 200)); // 200→197 (거의 고정)
    b = Math.round(30 + t * (94 - 30));   // 30→94
  }
  return `rgb(${r},${g},${b})`;
}

// 텍스트 가독성 위한 대비색 (밝으면 어둡게, 어두우면 밝게)
function bbTextColor(val) {
  if (val == null) return '#475569';
  const v = Math.max(0, Math.min(1, val));
  // 0.3~0.7 구간은 어두운 텍스트, 나머지는 밝은 텍스트
  return (v > 0.25 && v < 0.75) ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)';
}

function initBbMap() {
  loadBbMap();
}

async function loadBbMap() {
  const heatmapEl = document.getElementById('bb-map-heatmap');
  const loading   = document.getElementById('bb-map-loading');
  if (loading) { loading.style.display = 'flex'; loading.textContent = 'BB 히트맵 데이터 불러오는 중...'; }

  try {
    // 3주 고정
    const res  = await fetch(`${CF_API}/api/bb-map-chart?range=3w`);
    const data = await res.json();

    if (!data.dates?.length || !data.symbols?.length) {
      if (loading) { loading.textContent = 'BB 히트맵 데이터 없음 (bb_map_symbols 등록 필요)'; }
      return;
    }

    if (loading) loading.style.display = 'none';
    renderBbHeatmap(heatmapEl, data);
  } catch (err) {
    console.error('[bbmap] load error:', err);
    if (loading) { loading.textContent = 'BB 히트맵 로드 실패: ' + err.message; }
  }
}

function renderBbHeatmap(container, data) {
  const { symbols, dates, series } = data;

  // 날짜 레이블 (M/D 형식)
  const dateLabels = dates.map(d => {
    const [, m, day] = d.split('-');
    return `${+m}/${+day}`;
  });

  // 날짜 헤더 표시 간격 — 셀이 많으면 일부만 표시
  const totalCols = dateLabels.length;
  // 약 7개 레이블만 표시 (첫날, 마지막날 포함)
  const labelStep = Math.max(1, Math.floor(totalCols / 6));

  const rows = symbols.map(s => {
    const vals = series[s.symbol] ?? [];
    const lastVal = [...vals].reverse().find(v => v != null);
    const lastPct = lastVal != null ? (lastVal * 100).toFixed(0) : '-';

    const cells = vals.map((v, i) => {
      const bg   = bbColor(v);
      //const show = (i === totalCols - 1); // 마지막 셀에만 숫자 표시
      const show = false;
      return `<div class="bb-hm-cell" style="background:${bg}" title="${dateLabels[i]}: ${v != null ? (v*100).toFixed(0)+'%' : '-'}">${show ? `<span class="bb-hm-last" style="color:${bbTextColor(lastVal)}">${lastPct}%</span>` : ''}</div>`;
    }).join('');

    // 점수 색상
    const scoreColor = lastVal == null ? '#64748b'
      : lastVal >= 0.8 ? '#22c55e'
      : lastVal <= 0.2 ? '#ef4444'
      : '#f59e0b';

    return `
      <div class="bb-hm-row">
        <div class="bb-hm-sym">${s.symbol}</div>
        <div class="bb-hm-cells">${cells}</div>
        <div class="bb-hm-score" style="color:${scoreColor}">${lastPct}%</div>
      </div>`;
  }).join('');

  // 날짜 헤더 행
  const headerCells = dateLabels.map((lbl, i) => {
    const show = (i === 0 || i === totalCols - 1 || i % labelStep === 0);
    return `<div class="bb-hm-cell bb-hm-header-cell">${show ? lbl : ''}</div>`;
  }).join('');

  container.innerHTML = `
    <div class="bb-hm-row bb-hm-header">
      <div class="bb-hm-sym"></div>
      <div class="bb-hm-cells">${headerCells}</div>
      <div class="bb-hm-score" style="font-size:10px;color:var(--text3)">최신</div>
    </div>
    ${rows}
    <div class="bb-hm-legend-bar">
      <span style="color:#dc3c1e">0% (BB 하단)</span>
      <div class="bb-hm-gradient"></div>
      <span style="color:#22c55e">100% (BB 상단)</span>
    </div>
  `;
}
