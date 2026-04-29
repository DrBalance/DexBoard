// ============================================
// js/tabs/screener.js — Screener 탭
// 섹터별 스크리너 결과 → Structure 드릴다운 연동
// ============================================

import { state } from '../state.js';
import { CF_API } from '../config.js';
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

// ============================================
// 진입점
// ============================================
export function initScreener() {
  renderShell();
  loadScreener();
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

  <!-- 상단 컨트롤 바 -->
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

  <!-- 요약 카드 행 -->
  <div class="screener-summary" id="sc-summary"></div>

  <!-- 로딩 / 비어있음 -->
  <div id="sc-state" class="sc-state-box">
    <div class="sc-state-icon">◌</div>
    <div class="sc-state-msg">스크리너 데이터를 불러오는 중...</div>
  </div>

  <!-- 결과 테이블 -->
  <div id="sc-content" class="sc-content" style="display:none">

    <!-- 범례 + 컬럼 안내 -->
    <div class="sc-legend">
      <span class="legend-item"><span class="legend-dot green"></span> 7-10점: 강한 매수 신호</span>
      <span class="legend-item"><span class="legend-dot amber"></span> 4-6점: 중립 관찰</span>
      <span class="legend-item"><span class="legend-dot red"></span> 0-3점: 약한 신호</span>
      <span class="legend-item"><span class="legend-dot flash"></span> BREAKDOWN: -2σ 이탈</span>
    </div>

    <div class="sc-table-wrap">
      <table class="sc-tbl" id="sc-tbl">
        <thead>
          <tr>
            <th class="sc-th sortable" data-col="symbol">종목</th>
            <th class="sc-th">섹터 ETF</th>
            <th class="sc-th sortable" data-col="total_score">총점 ↕</th>
            <th class="sc-th sortable" data-col="score_skew_weeks">A 스큐</th>
            <th class="sc-th sortable" data-col="score_bb">B BB</th>
            <th class="sc-th sortable" data-col="score_atm_put">C ATM풋</th>
            <th class="sc-th sortable" data-col="score_vol_squeeze">D 변동</th>
            <th class="sc-th sortable" data-col="bb_position">BB위치</th>
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
}

// ============================================
// 이벤트 바인딩 (renderShell 후 호출)
// ============================================
function bindEvents() {
  // 새로고침 버튼
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
// 데이터 로드
// ============================================
async function loadScreener() {
  if (isLoading) return;
  isLoading = true;

  showState('loading', '스크리너 데이터를 불러오는 중...');

  try {
    const res  = await fetch(`${CF_API}/api/screener`);
    const data = await res.json();

    if (!Array.isArray(data) || !data.length) {
      showState('empty', '스크리너 데이터가 없습니다. 장 마감 후 자동으로 갱신됩니다.');
      isLoading = false;
      return;
    }

    allResults = data;
    lastDate   = data[0]?.date ?? null;

    // 날짜 표시
    if (lastDate) {
      document.getElementById('sc-date').textContent = `기준일: ${lastDate}`;
    }

    // 섹터 pill 동적 생성
    buildSectorPills(data);

    // 이벤트 바인딩 (최초 1회)
    bindEvents();

    // 요약 카드
    renderSummary(data);

    // 테이블
    showContent();
    renderTable();

  } catch (err) {
    console.error('[screener] load error:', err);
    showState('error', '데이터 로드 실패: ' + err.message);
  } finally {
    isLoading = false;
  }
}

// ── 섹터 pills 생성
function buildSectorPills(data) {
  const sectors = [...new Set(data.map(r => r.sector).filter(Boolean))].sort();
  const el = document.getElementById('sc-sector-pills');
  if (!el) return;

  // 기존 전체 버튼 유지, 나머지 재생성
  const activeBtn = el.querySelector('.pill.active');
  const activeSector = activeBtn?.dataset.s || 'all';

  el.innerHTML = `<button class="pill${activeSector === 'all' ? ' active' : ''}" data-s="all">전체</button>` +
    sectors.map(s => {
      const label = sectorShortName(s);
      return `<button class="pill${activeSector === s ? ' active' : ''}" data-s="${s}">${label}</button>`;
    }).join('');
}

function sectorShortName(sector) {
  const map = {
    technology:            'Tech',
    energy:                'Energy',
    financials:            'Finance',
    health_care:           'Health',
    utilities:             'Util',
    industrials:           'Indust',
    materials:             'Mater',
    consumer_discretionary:'Disc',
    consumer_staples:      'Staple',
    real_estate:           'REIT',
    communication_services:'Comm',
    broad_market:          'Broad',
    semiconductors:        'Semi',
    software:              'SW',
  };
  return map[sector] || sector;
}

// ── 요약 카드
function renderSummary(data) {
  const el = document.getElementById('sc-summary');
  if (!el) return;

  const strong   = data.filter(r => r.total_score >= 7).length;
  const moderate = data.filter(r => r.total_score >= 4 && r.total_score < 7).length;
  const weak     = data.filter(r => r.total_score < 4).length;
  const breakdowns = data.filter(r => r.bb_flag === 'BREAKDOWN').length;
  const avgScore = data.length
    ? (data.reduce((s, r) => s + (r.total_score || 0), 0) / data.length).toFixed(1)
    : '-';

  el.innerHTML = `
    <div class="sc-sum-card">
      <div class="sc-sum-num green">${strong}</div>
      <div class="sc-sum-label">강한 신호 (7+)</div>
    </div>
    <div class="sc-sum-card">
      <div class="sc-sum-num amber">${moderate}</div>
      <div class="sc-sum-label">중립 관찰 (4~6)</div>
    </div>
    <div class="sc-sum-card">
      <div class="sc-sum-num muted">${weak}</div>
      <div class="sc-sum-label">약한 신호 (~3)</div>
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

  // 필터
  let rows = sectorFilter === 'all'
    ? [...allResults]
    : allResults.filter(r => r.sector === sectorFilter);

  // 정렬
  rows.sort((a, b) => {
    const av = a[sortCol] ?? -Infinity;
    const bv = b[sortCol] ?? -Infinity;
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  if (!rows.length) {
    tbody.innerHTML = `
      <tr><td colspan="11" class="sc-no-data">해당 섹터에 데이터가 없습니다</td></tr>
    `;
    document.getElementById('sc-footer').textContent = '';
    return;
  }

  tbody.innerHTML = rows.map((r, i) => {
    const scoreColor = r.total_score >= 7 ? 'green' : r.total_score >= 4 ? 'amber' : 'red';
    const bbPct      = r.bb_position != null ? (r.bb_position * 100).toFixed(0) + '%' : '-';
    const ivSkewStr  = r.iv_skew != null
      ? `<span style="color:${r.iv_skew > 0 ? '#22c55e' : '#ef4444'}">${r.iv_skew > 0 ? '+' : ''}${(r.iv_skew * 100).toFixed(1)}%</span>`
      : '-';

    const breakdown = r.bb_flag === 'BREAKDOWN'
      ? '<span class="bd-tag">⚡BD</span>' : '';

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
        <td class="sc-td-sub">${scoreCell(r.score_skew_weeks, 3)}</td>
        <td class="sc-td-sub">${scoreCell(r.score_bb, 3)}</td>
        <td class="sc-td-sub">${scoreCell(r.score_atm_put, 2)}</td>
        <td class="sc-td-sub">${scoreCell(r.score_vol_squeeze, 2)}</td>
        <td class="sc-td-bb">
          <div class="bb-pos-wrap">
            <div class="bb-pos-track"><div class="bb-pos-fill" style="left:${bbPct}"></div></div>
            <span class="bb-pos-val">${bbPct}</span>
          </div>
        </td>
        <td>${ivSkewStr}</td>
        <td class="sc-td-price">$${r.close ? r.close.toFixed(2) : '-'}</td>
        <td>
          <button class="sc-drill-btn" data-sym="${r.symbol}" title="Structure 탭에서 분석">
            ▶ 분석
          </button>
        </td>
      </tr>
    `;
  }).join('');

  // 드릴다운 버튼 이벤트
  tbody.querySelectorAll('.sc-drill-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const sym = btn.dataset.sym;
      drillToStructure(sym);
    });
  });

  // 행 클릭도 동일하게
  tbody.querySelectorAll('.sc-row').forEach(row => {
    row.addEventListener('click', () => {
      drillToStructure(row.dataset.sym);
    });
  });

  // 푸터
  document.getElementById('sc-footer').textContent =
    `${rows.length}개 종목 표시${sectorFilter !== 'all' ? ` · 섹터: ${sectorFilter}` : ''}`;
}

// ── Screener → Structure 드릴다운
function drillToStructure(symbol) {
  goToTab('structure');
  setTimeout(() => drillTo(symbol), 50);
}



// ── 점수 셀
function scoreCell(score, max) {
  const pct  = max > 0 ? ((score ?? 0) / max * 100) : 0;
  const c    = score >= max ? 'green' : score > 0 ? 'amber' : 'muted';
  return `<span class="sc-sub-score ${c}">${score ?? 0}/${max}</span>`;
}

// ── 상태 표시
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
