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

// 종목 목록 (config에서 가져오거나 여기서 정의)
// 실제 운영 시 config.js의 SCREENER_SYMBOLS 로 분리 권장
const SYMBOL_LIST = [
  // ── 대형주
  { symbol: 'AAPL',  name: 'Apple',           type: 'stock', sector: 'technology',            sector_etf: 'XLK'  },
  { symbol: 'MSFT',  name: 'Microsoft',        type: 'stock', sector: 'technology',            sector_etf: 'XLK'  },
  { symbol: 'NVDA',  name: 'NVIDIA',           type: 'stock', sector: 'semiconductors',        sector_etf: 'SOXX' },
  { symbol: 'AMZN',  name: 'Amazon',           type: 'stock', sector: 'consumer_discretionary',sector_etf: 'XLY'  },
  { symbol: 'GOOGL', name: 'Alphabet',         type: 'stock', sector: 'communication_services',sector_etf: 'XLC'  },
  { symbol: 'META',  name: 'Meta',             type: 'stock', sector: 'communication_services',sector_etf: 'XLC'  },
  { symbol: 'TSLA',  name: 'Tesla',            type: 'stock', sector: 'consumer_discretionary',sector_etf: 'XLY'  },
  { symbol: 'JPM',   name: 'JPMorgan',         type: 'stock', sector: 'financials',            sector_etf: 'XLF'  },
  { symbol: 'V',     name: 'Visa',             type: 'stock', sector: 'financials',            sector_etf: 'XLF'  },
  { symbol: 'UNH',   name: 'UnitedHealth',     type: 'stock', sector: 'health_care',           sector_etf: 'XLV'  },
  { symbol: 'XOM',   name: 'Exxon',            type: 'stock', sector: 'energy',                sector_etf: 'XLE'  },
  { symbol: 'WMT',   name: 'Walmart',          type: 'stock', sector: 'consumer_staples',      sector_etf: 'XLP'  },
  { symbol: 'MA',    name: 'Mastercard',       type: 'stock', sector: 'financials',            sector_etf: 'XLF'  },
  { symbol: 'LLY',   name: 'Eli Lilly',        type: 'stock', sector: 'health_care',           sector_etf: 'XLV'  },
  { symbol: 'AVGO',  name: 'Broadcom',         type: 'stock', sector: 'semiconductors',        sector_etf: 'SOXX' },
  { symbol: 'AMD',   name: 'AMD',              type: 'stock', sector: 'semiconductors',        sector_etf: 'SOXX' },
  { symbol: 'COST',  name: 'Costco',           type: 'stock', sector: 'consumer_staples',      sector_etf: 'XLP'  },
  { symbol: 'NFLX',  name: 'Netflix',          type: 'stock', sector: 'communication_services',sector_etf: 'XLC'  },
  { symbol: 'CRM',   name: 'Salesforce',       type: 'stock', sector: 'technology',            sector_etf: 'XLK'  },
  { symbol: 'ORCL',  name: 'Oracle',           type: 'stock', sector: 'technology',            sector_etf: 'XLK'  },
  // ── 섹터 ETF
  { symbol: 'SPY',   name: 'S&P 500 ETF',      type: 'etf',   sector: 'broad_market',          sector_etf: 'SPY'  },
  { symbol: 'QQQ',   name: 'Nasdaq 100 ETF',   type: 'etf',   sector: 'broad_market',          sector_etf: 'QQQ'  },
  { symbol: 'IWM',   name: 'Russell 2000 ETF', type: 'etf',   sector: 'broad_market',          sector_etf: 'IWM'  },
  { symbol: 'XLK',   name: 'Tech ETF',         type: 'etf',   sector: 'technology',            sector_etf: 'XLK'  },
  { symbol: 'XLF',   name: 'Finance ETF',      type: 'etf',   sector: 'financials',            sector_etf: 'XLF'  },
  { symbol: 'XLE',   name: 'Energy ETF',       type: 'etf',   sector: 'energy',                sector_etf: 'XLE'  },
  { symbol: 'XLV',   name: 'Health ETF',       type: 'etf',   sector: 'health_care',           sector_etf: 'XLV'  },
  { symbol: 'SOXX',  name: 'Semi ETF',         type: 'etf',   sector: 'semiconductors',        sector_etf: 'SOXX' },
  { symbol: 'GLD',   name: 'Gold ETF',         type: 'etf',   sector: 'broad_market',          sector_etf: 'GLD'  },
  { symbol: 'TLT',   name: '20Y Bond ETF',     type: 'etf',   sector: 'broad_market',          sector_etf: 'TLT'  },
];

// ============================================
// 진입점
// ============================================
export function initScreener() {
  renderShell();
  checkCollectionStatus();
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

  bindEvents();
}

// ============================================
// 이벤트 바인딩
// ============================================
function bindEvents() {
  // 수집 버튼
  document.getElementById('sc-collect-btn')?.addEventListener('click', () => startCollection(false));
  document.getElementById('sc-force-btn')?.addEventListener('click', () => startCollection(true));

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
    setCollectMsg('상태 확인 실패 — Railway 연결 확인 필요', 'error');
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
      setCollectMsg(`수집 중… ${progress.done}/${progress.total}건`, 'running');
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
        setCollectMsg(
          `마지막 수집: ${last_run.date} (${last_run.count}종목${last_run.errors > 0 ? `, 오류: ${last_run.errors}` : ''}) ${ts}`,
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
    const res = await fetch(`${RAILWAY_URL}/collect-screener`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-cron-secret': CRON_SECRET,
      },
      body: JSON.stringify({ symbols: SYMBOL_LIST, force }),
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
// 데이터 로드 (CF Worker D1 조회)
// ============================================
async function loadScreener() {
  if (isLoading) return;
  isLoading = true;

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

    buildSectorPills(data);
    renderSummary(data);
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

  el.innerHTML = `<button class="pill${sectorFilter === 'all' ? ' active' : ''}" data-s="all">전체</button>` +
    sectors.map(s => {
      const label = sectorShortName(s);
      return `<button class="pill${sectorFilter === s ? ' active' : ''}" data-s="${s}">${label}</button>`;
    }).join('');

  // pills 이벤트 재바인딩
  el.addEventListener('click', e => {
    const btn = e.target.closest('.pill');
    if (!btn) return;
    el.querySelectorAll('.pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    sectorFilter = btn.dataset.s;
    renderTable();
  });
}

function sectorShortName(sector) {
  const map = {
    technology:              'Tech',
    energy:                  'Energy',
    financials:              'Finance',
    health_care:             'Health',
    utilities:               'Util',
    industrials:             'Indust',
    materials:               'Mater',
    consumer_discretionary:  'Disc',
    consumer_staples:        'Staple',
    real_estate:             'REIT',
    communication_services:  'Comm',
    broad_market:            'Broad',
    semiconductors:          'Semi',
    software:                'SW',
  };
  return map[sector] || sector;
}

// ── 요약 카드
function renderSummary(data) {
  const el = document.getElementById('sc-summary');
  if (!el) return;

  const strong     = data.filter(r => r.total_score >= 7).length;
  const moderate   = data.filter(r => r.total_score >= 4 && r.total_score < 7).length;
  const weak       = data.filter(r => r.total_score < 4).length;
  const breakdowns = data.filter(r => r.bb_flag === 'BREAKDOWN').length;
  const avgScore   = data.length
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
    const scoreColor = r.total_score >= 7 ? 'green' : r.total_score >= 4 ? 'amber' : 'red';
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
        <td class="sc-td-sub">${scoreCell(r.score_skew_weeks, 3)}</td>
        <td class="sc-td-sub">${scoreCell(r.score_bb, 3)}</td>
        <td class="sc-td-sub">${scoreCell(r.score_atm_put, 2)}</td>
        <td class="sc-td-sub">${scoreCell(r.score_vol_squeeze, 2)}</td>
        <td class="sc-td-bb">
          <div class="bb-pos-wrap">
            <div class="bb-pos-track">
              <div class="bb-pos-fill" style="left:${bbPct}"></div>
            </div>
            <span class="bb-pos-val">${bbPct}</span>
          </div>
        </td>
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
