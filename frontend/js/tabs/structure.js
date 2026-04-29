// ============================================
// js/tabs/structure.js — Structure 탭
// 종목 선택 → 1~2개월 만기 스펙트럼 딜러 헷지 지형 분석
// ============================================

import { state } from '../state.js';
import { CF_API } from '../config.js'
import { fmt } from '../fmt.js';

// ── 내부 상태
let currentSymbol = null;
let currentData   = null;
let expiryFilter  = 'all';   // 'all' | '0-30' | '31-60'
let chartInstance = null;
let heatChartInst = null;

// ============================================
// 진입점 — tabs.js에서 탭 전환 시 호출
// ============================================
export function initStructure() {
  renderShell();
  bindEvents();
}

export function refreshStructure() {
  if (currentSymbol) loadStructure(currentSymbol);
}

// Structure 탭으로 이동하면서 종목 프리셋 (Screener → Structure 드릴다운)
export function drillTo(symbol) {
  currentSymbol = symbol;
  const inp = document.getElementById('struct-sym-input');
  if (inp) inp.value = symbol;
  loadStructure(symbol);
}

// ============================================
// HTML 뼈대 렌더
// ============================================
function renderShell() {
  const el = document.getElementById('tab-structure');
  if (!el || el.dataset.ready === '1') return;
  el.dataset.ready = '1';

  el.innerHTML = `
<div class="struct-container">

  <!-- 검색 바 -->
  <div class="struct-search-bar">
    <div class="sym-search-wrap">
      <span class="sym-search-icon">⌕</span>
      <input id="struct-sym-input" class="struct-sym-input"
        placeholder="종목 입력 (예: AAPL, NVDA)"
        autocomplete="off" spellcheck="false">
      <div class="struct-sym-dd" id="struct-sym-dd"></div>
    </div>
    <div class="struct-filter-pills" id="struct-expiry-pills">
      <button class="pill active" data-f="all">전체</button>
      <button class="pill" data-f="0-30">1개월 이내</button>
      <button class="pill" data-f="31-60">1~2개월</button>
    </div>
    <button class="struct-refresh-btn" id="struct-refresh-btn" title="새로고침">↻</button>
  </div>

  <!-- 로딩 / 에러 / 비어있음 상태 -->
  <div id="struct-state" class="struct-state-box">
    <div class="struct-state-icon">◈</div>
    <div class="struct-state-msg">종목을 선택하면 딜러 헷지 지형을 분석합니다</div>
  </div>

  <!-- 실제 콘텐츠 (숨김) -->
  <div id="struct-content" class="struct-content" style="display:none">

    <!-- 심볼 헤더 -->
    <div class="struct-sym-header">
      <div class="struct-sym-title">
        <span id="struct-sym-name" class="struct-sym-ticker">-</span>
        <span id="struct-sym-fullname" class="struct-sym-fullname">-</span>
        <span id="struct-updated" class="struct-updated-ts"></span>
      </div>
      <div class="struct-score-strip" id="struct-score-strip"></div>
    </div>

    <!-- 메트릭 카드 행 -->
    <div class="struct-metrics" id="struct-metrics"></div>

    <!-- IV 스큐 커브 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">◉</span> ATM IV 만기 스펙트럼
        <span class="panel-sub" id="struct-iv-note"></span>
      </div>
      <div class="struct-chart-wrap" style="height:220px">
        <canvas id="struct-iv-chart"
          role="img" aria-label="만기별 ATM IV 및 IV스큐 차트">
          만기별 IV 데이터가 없습니다.
        </canvas>
      </div>
    </div>

    <!-- PCR / OI 분포 차트 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">◈</span> 만기별 Put/Call 비율 & OI
        <span class="panel-sub">PCR OI (막대) / PCR Vol (라인)</span>
      </div>
      <div class="struct-chart-wrap" style="height:220px">
        <canvas id="struct-pcr-chart"
          role="img" aria-label="만기별 PCR OI 및 PCR Vol 차트">
          만기별 PCR 데이터가 없습니다.
        </canvas>
      </div>
    </div>

    <!-- 히트맵: ATM 풋 OI 집중도 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">⬡</span> ATM ±5% 풋 OI 집중도
        <span class="panel-sub">ATM 풋 OI / 전체 풋 OI</span>
      </div>
      <div id="struct-atm-bars" class="struct-atm-bars"></div>
    </div>

    <!-- 점수 분해 테이블 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">▤</span> 스크리너 점수 분해
      </div>
      <div id="struct-score-table" class="struct-score-table"></div>
    </div>

  </div>
</div>
`;
}

// ============================================
// 이벤트 바인딩
// ============================================
function bindEvents() {
  // 심볼 검색 자동완성
  const inp = document.getElementById('struct-sym-input');
  if (!inp) return;

  let debounceT = null;
  inp.addEventListener('input', () => {
    clearTimeout(debounceT);
    debounceT = setTimeout(() => fetchSymbolSuggestions(inp.value), 250);
  });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const v = inp.value.trim().toUpperCase();
      if (v) { hideDd(); loadStructure(v); }
    }
    if (e.key === 'Escape') hideDd();
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.sym-search-wrap')) hideDd();
  });

  // 만기 필터 pills
  document.getElementById('struct-expiry-pills')?.addEventListener('click', e => {
    const btn = e.target.closest('.pill');
    if (!btn) return;
    document.querySelectorAll('#struct-expiry-pills .pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    expiryFilter = btn.dataset.f;
    if (currentData) renderContent(currentData);
  });

  // 새로고침
  document.getElementById('struct-refresh-btn')?.addEventListener('click', () => {
    if (currentSymbol) loadStructure(currentSymbol);
  });
}

// ── 자동완성
async function fetchSymbolSuggestions(q) {
  q = q.trim().toUpperCase();
  if (q.length < 1) { hideDd(); return; }
  try {
    const res  = await fetch(`${CF_API}/api/symbols?q=${q}`);
    const data = await res.json();
    renderDd(data.symbols || []);
  } catch { hideDd(); }
}

function renderDd(items) {
  const dd = document.getElementById('struct-sym-dd');
  if (!dd) return;
  if (!items.length) { dd.style.display = 'none'; return; }
  dd.innerHTML = items.slice(0, 8).map(s => `
    <div class="struct-dd-item" data-sym="${s.symbol}" data-name="${s.name}">
      <span class="dd-sym">${s.symbol}</span>
      <span class="dd-name">${s.name}</span>
      <span class="dd-type ${s.type}">${s.type}</span>
    </div>
  `).join('');
  dd.style.display = 'block';
  dd.querySelectorAll('.struct-dd-item').forEach(item => {
    item.addEventListener('click', () => {
      document.getElementById('struct-sym-input').value = item.dataset.sym;
      hideDd();
      loadStructure(item.dataset.sym);
    });
  });
}

function hideDd() {
  const dd = document.getElementById('struct-sym-dd');
  if (dd) dd.style.display = 'none';
}

// ============================================
// 데이터 로드
// ============================================
async function loadStructure(symbol) {
  symbol = symbol.toUpperCase();
  currentSymbol = symbol;

  showState('loading', `${symbol} 분석 중...`);

  try {
    // D1 스크리너 데이터 + 옵션 플로우 조회
    const [screenerRes, flowRes] = await Promise.all([
      fetch(`${CF_API}/api/screener`),
      fetch(`${CF_API}/api/structure/${symbol}`),
    ]);

    const screenerAll = await screenerRes.json();
    const flowData    = flowRes.ok ? await flowRes.json() : null;

    // 해당 종목 스크리너 점수
    const scoreRow = Array.isArray(screenerAll)
      ? screenerAll.find(r => r.symbol === symbol)
      : null;

    if (!scoreRow && (!flowData || !flowData.length)) {
      showState('empty', `${symbol} 데이터가 없습니다. 스크리너 실행 후 조회하세요.`);
      return;
    }

    currentData = { symbol, scoreRow, flowData };
    renderContent(currentData);

  } catch (err) {
    console.error('[structure] load error:', err);
    showState('error', '데이터 로드 실패: ' + err.message);
  }
}

// ============================================
// 렌더링
// ============================================
function renderContent({ symbol, scoreRow, flowData }) {
  document.getElementById('struct-state').style.display   = 'none';
  document.getElementById('struct-content').style.display = 'block';

  // 헤더
  document.getElementById('struct-sym-name').textContent     = symbol;
  document.getElementById('struct-sym-fullname').textContent = scoreRow?.name || '';
  document.getElementById('struct-updated').textContent      = scoreRow?.date
    ? `기준일: ${scoreRow.date}` : '';

  // 만기 필터 적용
  const rows = filterByExpiry(flowData || []);

  // 메트릭 카드
  renderMetrics(scoreRow, rows);

  // 차트들
  renderIVChart(rows);
  renderPCRChart(rows);
  renderATMBars(rows);

  // 점수 테이블
  if (scoreRow) renderScoreTable(scoreRow);
}

// ── 만기 필터
function filterByExpiry(rows) {
  if (expiryFilter === 'all')   return rows;
  if (expiryFilter === '0-30')  return rows.filter(r => r.dte <= 30);
  if (expiryFilter === '31-60') return rows.filter(r => r.dte > 30 && r.dte <= 60);
  return rows;
}

// ── 메트릭 카드
function renderMetrics(score, flowRows) {
  const el = document.getElementById('struct-metrics');
  if (!el) return;

  const avgAtmIV    = avg(flowRows.map(r => r.atm_iv).filter(Boolean));
  const avgSkew     = avg(flowRows.map(r => r.iv_skew).filter(v => v != null));
  const totalCallOI = flowRows.reduce((s, r) => s + (r.call_oi || 0), 0);
  const totalPutOI  = flowRows.reduce((s, r) => s + (r.put_oi  || 0), 0);
  const overallPCR  = totalCallOI > 0 ? totalPutOI / totalCallOI : null;
  const avgATMPut   = avg(flowRows.map(r => r.atm_put_oi_ratio).filter(v => v != null));

  const close    = score?.close;
  const bbPos    = score?.bb_position;
  const totalSc  = score?.total_score;
  const bbFlag   = score?.bb_flag;

  el.innerHTML = `
    ${metricCard('총점', totalSc != null ? `${totalSc}/10` : '-', totalSc >= 7 ? 'green' : totalSc >= 4 ? 'amber' : 'red')}
    ${metricCard('현재가', close ? `$${fmt.price(close)}` : '-', 'neutral')}
    ${metricCard('BB 위치', bbPos != null ? `${(bbPos * 100).toFixed(0)}%` : '-', bbPosCss(bbPos), bbFlag ? '⚡ BREAKDOWN' : '')}
    ${metricCard('ATM IV', avgAtmIV ? `${(avgAtmIV * 100).toFixed(1)}%` : '-', 'neutral')}
    ${metricCard('IV 스큐', avgSkew != null ? `${(avgSkew * 100).toFixed(1)}%` : '-', avgSkew > 0 ? 'green' : avgSkew < 0 ? 'red' : 'neutral', avgSkew > 0 ? '콜 프리미엄' : avgSkew < 0 ? '풋 프리미엄' : '')}
    ${metricCard('PCR OI', overallPCR != null ? overallPCR.toFixed(2) : '-', overallPCR > 1.2 ? 'red' : overallPCR < 0.8 ? 'green' : 'neutral')}
    ${metricCard('ATM풋집중', avgATMPut != null ? `${(avgATMPut * 100).toFixed(0)}%` : '-', avgATMPut > 0.5 ? 'red' : 'neutral')}
  `;
}

function metricCard(label, value, colorClass = 'neutral', sub = '') {
  const colors = {
    green:   '#22c55e',
    red:     '#ef4444',
    amber:   '#f59e0b',
    purple:  '#a78bfa',
    neutral: 'var(--text)',
  };
  const c = colors[colorClass] || colors.neutral;
  return `
    <div class="struct-metric-card">
      <div class="smc-label">${label}</div>
      <div class="smc-value" style="color:${c}">${value}</div>
      ${sub ? `<div class="smc-sub">${sub}</div>` : ''}
    </div>
  `;
}

function bbPosCss(v) {
  if (v == null) return 'neutral';
  if (v < 0.05) return 'green';
  if (v < 0.32) return 'amber';
  return 'neutral';
}

// ── ATM IV 스펙트럼 차트
function renderIVChart(rows) {
  const canvas = document.getElementById('struct-iv-chart');
  if (!canvas) return;

  // 기존 차트 제거
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  if (!rows.length) return;

  const sorted   = [...rows].sort((a, b) => a.dte - b.dte);
  const labels   = sorted.map(r => `${r.dte}d\n${r.expiry_date?.slice(5)}`);
  const atmIVs   = sorted.map(r => r.atm_iv  != null ? +(r.atm_iv  * 100).toFixed(2) : null);
  const callIVs  = sorted.map(r => r.otm_call_iv != null ? +(r.otm_call_iv * 100).toFixed(2) : null);
  const putIVs   = sorted.map(r => r.otm_put_iv  != null ? +(r.otm_put_iv  * 100).toFixed(2) : null);

  document.getElementById('struct-iv-note').textContent =
    `${sorted[0]?.dte ?? '-'}~${sorted[sorted.length-1]?.dte ?? '-'}DTE / ${rows.length}개 만기`;

  chartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'ATM IV',
          data: atmIVs,
          borderColor: '#a78bfa',
          backgroundColor: 'rgba(167,139,250,0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: '#a78bfa',
          fill: true,
          tension: 0.3,
        },
        {
          label: 'OTM Call IV',
          data: callIVs,
          borderColor: '#22c55e',
          borderWidth: 1.5,
          borderDash: [4, 3],
          pointRadius: 3,
          pointBackgroundColor: '#22c55e',
          fill: false,
          tension: 0.3,
        },
        {
          label: 'OTM Put IV',
          data: putIVs,
          borderColor: '#ef4444',
          borderWidth: 1.5,
          borderDash: [4, 3],
          pointRadius: 3,
          pointBackgroundColor: '#ef4444',
          fill: false,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1) ?? '-'}%`,
          },
        },
      },
      scales: {
        x: { ticks: { color: '#8b949e', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: {
          ticks: {
            color: '#8b949e', font: { size: 11 },
            callback: v => v + '%',
          },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
      },
    },
  });
}

// ── PCR 차트
function renderPCRChart(rows) {
  const canvas = document.getElementById('struct-pcr-chart');
  if (!canvas) return;
  if (heatChartInst) { heatChartInst.destroy(); heatChartInst = null; }
  if (!rows.length) return;

  const sorted  = [...rows].sort((a, b) => a.dte - b.dte);
  const labels  = sorted.map(r => `${r.dte}d`);
  const pcrOI   = sorted.map(r => r.pcr_oi  != null ? +r.pcr_oi.toFixed(3)  : null);
  const pcrVol  = sorted.map(r => r.pcr_vol != null ? +r.pcr_vol.toFixed(3) : null);

  heatChartInst = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'PCR OI',
          data: pcrOI,
          backgroundColor: pcrOI.map(v =>
            v > 1.2 ? 'rgba(239,68,68,0.6)' : v < 0.8 ? 'rgba(34,197,94,0.6)' : 'rgba(148,163,184,0.4)'
          ),
          borderWidth: 0,
          yAxisID: 'y',
        },
        {
          label: 'PCR Vol',
          data: pcrVol,
          type: 'line',
          borderColor: '#f59e0b',
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: '#f59e0b',
          fill: false,
          tension: 0.3,
          yAxisID: 'y',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(2) ?? '-'}`,
          },
        },
        annotation: {
          annotations: {
            neutral: {
              type: 'line',
              yMin: 1, yMax: 1,
              borderColor: 'rgba(255,255,255,0.2)',
              borderWidth: 1,
              borderDash: [4, 4],
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: '#8b949e', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#8b949e', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
      },
    },
  });
}

// ── ATM 풋 OI 집중도 바
function renderATMBars(rows) {
  const el = document.getElementById('struct-atm-bars');
  if (!el || !rows.length) { if (el) el.innerHTML = '<div class="no-data">데이터 없음</div>'; return; }

  const sorted = [...rows].sort((a, b) => a.dte - b.dte);

  el.innerHTML = sorted.map(r => {
    const ratio = r.atm_put_oi_ratio ?? 0;
    const pct   = (ratio * 100).toFixed(0);
    const color = ratio > 0.7 ? '#ef4444' : ratio > 0.5 ? '#f59e0b' : '#22c55e';
    return `
      <div class="atm-bar-row">
        <div class="atm-bar-label">${r.dte}d <span class="atm-expiry">${r.expiry_date?.slice(5) ?? ''}</span></div>
        <div class="atm-bar-track">
          <div class="atm-bar-fill" style="width:${pct}%;background:${color}"></div>
        </div>
        <div class="atm-bar-val" style="color:${color}">${pct}%</div>
        <div class="atm-bar-oi">Put OI: ${fmtK(r.put_oi)}</div>
      </div>
    `;
  }).join('');
}

// ── 점수 분해 테이블
function renderScoreTable(s) {
  const el = document.getElementById('struct-score-table');
  if (!el) return;

  const rows = [
    {
      label: 'A. 콜 스큐 지속',
      score: s.score_skew_weeks,
      max: 3,
      detail: `${s.skew_weeks ?? 0}주 연속 콜 스큐`,
      color: s.score_skew_weeks >= 2 ? '#22c55e' : s.score_skew_weeks >= 1 ? '#f59e0b' : '#8b949e',
    },
    {
      label: 'B. 볼린저 위치',
      score: s.score_bb,
      max: 3,
      detail: `BB Position ${s.bb_position != null ? (s.bb_position * 100).toFixed(0) : '-'}%${s.bb_flag ? ' ⚡BREAKDOWN' : ''}`,
      color: s.score_bb >= 2 ? '#22c55e' : s.score_bb >= 1 ? '#f59e0b' : '#8b949e',
    },
    {
      label: 'C. ATM 풋 집중도',
      score: s.score_atm_put,
      max: 2,
      detail: `ATM±5% 풋 비중`,
      color: s.score_atm_put >= 2 ? '#ef4444' : s.score_atm_put >= 1 ? '#f59e0b' : '#8b949e',
    },
    {
      label: 'D. 변동폭 수축',
      score: s.score_vol_squeeze,
      max: 2,
      detail: 'ATR5 / ATR20 비율',
      color: s.score_vol_squeeze >= 2 ? '#22c55e' : s.score_vol_squeeze >= 1 ? '#f59e0b' : '#8b949e',
    },
  ];

  el.innerHTML = `
    <table class="score-tbl">
      <thead>
        <tr>
          <th>항목</th>
          <th>점수</th>
          <th>상세</th>
          <th>바</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td class="score-item-label">${r.label}</td>
            <td class="score-item-val" style="color:${r.color}">${r.score} / ${r.max}</td>
            <td class="score-item-detail">${r.detail}</td>
            <td class="score-item-bar-cell">
              <div class="score-bar-track">
                <div class="score-bar-fill" style="width:${(r.score/r.max)*100}%;background:${r.color}"></div>
              </div>
            </td>
          </tr>
        `).join('')}
        <tr class="score-total-row">
          <td>합계</td>
          <td style="color:${s.total_score >= 7 ? '#22c55e' : s.total_score >= 4 ? '#f59e0b' : '#ef4444'}">
            <strong>${s.total_score} / 10</strong>
          </td>
          <td colspan="2"></td>
        </tr>
      </tbody>
    </table>
    ${s.iv_skew != null ? `
      <div class="score-iv-note">
        IV 스큐: <strong style="color:${s.iv_skew > 0 ? '#22c55e' : '#ef4444'}">
          ${s.iv_skew > 0 ? '+' : ''}${(s.iv_skew * 100).toFixed(1)}%
        </strong>
        (${s.iv_skew > 0 ? '콜 프리미엄 — 업사이드 기대' : '풋 프리미엄 — 하방 헷지 집중'})
      </div>
    ` : ''}
  `;
}

// ── 상태 표시 (loading / empty / error)
function showState(type, msg) {
  document.getElementById('struct-content').style.display = 'none';
  const box  = document.getElementById('struct-state');
  const icon = box.querySelector('.struct-state-icon');
  const txt  = box.querySelector('.struct-state-msg');
  box.style.display = 'flex';

  if (type === 'loading') {
    icon.textContent = '◌';
    icon.style.animation = 'spin 1s linear infinite';
  } else {
    icon.textContent = type === 'error' ? '✕' : '◈';
    icon.style.animation = '';
  }
  txt.textContent = msg;
}

// ============================================
// 유틸
// ============================================
function avg(arr) {
  const v = arr.filter(x => x != null && !isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function fmtK(n) {
  if (!n) return '-';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(0)     + 'K';
  return String(n);
}
