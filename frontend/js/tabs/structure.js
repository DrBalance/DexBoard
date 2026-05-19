// ============================================
// js/tabs/structure.js — Structure 탭
// 종목 선택 → 1~2개월 만기 스펙트럼 딜러 헷지 지형 분석
// ============================================

import { state } from '../state.js';
import { CF_API } from '../config.js';
import { fmt } from '../fmt.js';
import {
  isMonthlyExpiry,
  classifyExpiry,
  calculateTermStructure,
  calculateSkew,
  calculateExpectedMove,
  evaluateStatus,
  renderTermStructure,
  renderDexTermStructure,
  renderSkewChart,
  renderSkewChartImproved,
  renderSmileSelector,
  renderOIDistribution,
} from '../options-charts.js';

// ── 내부 상태
let currentSymbol = null;
let currentData   = null;

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
<div class="struct-container" style="width:100%;max-width:100%;box-sizing:border-box">

  <!-- 검색 바 -->
  <div class="struct-search-bar">
    <div class="sym-search-wrap">
      <span class="sym-search-icon">⌕</span>
      <input id="struct-sym-input" class="struct-sym-input"
        placeholder="종목 입력 (예: AAPL, NVDA)"
        autocomplete="off" spellcheck="false">
      <div class="struct-sym-dd" id="struct-sym-dd"></div>
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

    <!-- 섹션 1: 종합 판단 -->
    <div class="struct-panel" style="border:1px solid var(--border);border-radius:12px;padding:0">
      <div class="struct-panel-title" style="border-radius:12px 12px 0 0">
        <span class="panel-icon">★</span> 종합 판단
        <span class="panel-sub">Term Structure · Skew · Flip Zone · Vanna 결합 분석</span>
      </div>
      <div id="struct-verdict"></div>
    </div>

    <!-- 섹션 4: OI 확률 분포 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">◈</span> OI 확률 분포
        <span class="panel-sub">Monthly 합산 · Call Wall · Flip Zone · EM 범위</span>
      </div>
      <div id="struct-oi-dist"></div>
    </div>

    <!-- 섹션 5: Term Structure 곡선 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">〜</span> Term Structure
        <span class="panel-sub">만기별 ATM IV 곡선 · 콘탱고/백워데이션</span>
      </div>
      <div id="struct-term"></div>
    </div>

    <!-- 섹션 6: IV Skew 차트 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">◐</span> IV Skew
        <span class="panel-sub">만기별 Put/Call IV 비대칭 · 공포/탐욕 농도</span>
      </div>
      <div id="struct-skew"></div>
    </div>

    <!-- 섹션 6b: Volatility Smile 곡선 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">◡</span> Volatility Smile
        <span class="panel-sub">만기 선택 → 스트라이크별 IV 곡선</span>
      </div>
      <div id="struct-smile"></div>
    </div>

    <!-- 섹션 7: Vanna/Charm 분석 — 만기 구조 카드 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">◉</span> Vanna / Charm 분석
        <span class="panel-sub">Monthly 강조 · 만기별 딜러 헤징 방향</span>
      </div>
      <div id="struct-expiry-cards"></div>
    </div>

    <!-- 섹션 8: DEX 히트맵 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">▦</span> DEX 히트맵
        <span class="panel-sub">만기 × 구간별 딜러 헤징 압력 · Monthly 강조</span>
      </div>
      <div id="struct-heatmap"></div>
    </div>

    <!-- 섹션 9: 주간 OI 분포 선택기 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">📅</span> 주간 OI 분포
        <span class="panel-sub">위클리 만기별 OI · 이상 베팅 감지</span>
      </div>
      <div id="struct-weekly-oi"></div>
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
    const [screenerRes, flowRes] = await Promise.all([
      fetch(`${CF_API}/api/screener`),
      fetch(`${CF_API}/api/structure/${symbol}`),
    ]);

    const screenerAll = await screenerRes.json();
    const flowData    = flowRes.ok ? await flowRes.json() : null;

    const scoreRow = Array.isArray(screenerAll)
      ? screenerAll.find(r => r.symbol === symbol)
      : null;

    // 새 API: { monthly, weekly, context } 구조
    const monthly = flowData?.monthly ?? [];
    const weekly  = flowData?.weekly  ?? null;
    const context = flowData?.context ?? null;

    if (!scoreRow && !monthly.length) {
      showState('empty', `${symbol} 데이터가 없습니다. 스크리너 실행 후 조회하세요.`);
      return;
    }

    currentData = { symbol, scoreRow, monthly, weekly, context };
    renderContent(currentData);

  } catch (err) {
    console.error('[structure] load error:', err);
    showState('error', '데이터 로드 실패: ' + err.message);
  }
}

// ============================================
// 렌더링
// ============================================
function renderContent({ symbol, scoreRow, monthly, weekly, context }) {
  document.getElementById('struct-state').style.display   = 'none';
  document.getElementById('struct-content').style.display = 'block';

  // 헤더
  document.getElementById('struct-sym-name').textContent     = symbol;
  document.getElementById('struct-sym-fullname').textContent = scoreRow?.name || '';
  document.getElementById('struct-updated').textContent      = scoreRow?.date
    ? `기준일: ${scoreRow.date}` : '';

  loadAndRenderCharts(symbol, scoreRow);
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

// ============================================
// 공통 분석 함수 (SPY/개별종목 공용)
// ============================================

// ── 선형 회귀 기울기 계산 (x=DTE, y=ATM IV)

// ── 이벤트 만기 감지 (주변 만기 대비 IV가 튀는 구간)

// Term Structure: 만기별 ATM IV → 콘탱고/백워데이션 판단
// prevRows: 전일 데이터 (있으면 slope 변화 계산)

// IV Skew: 만기별 Put/Call IV 비대칭 측정


// 종합 상태 판단 (🟢🟡🟠🔴)

// ============================================
// D1에서 options_dex 데이터 로드 → 차트 렌더링
// ============================================
async function loadAndRenderCharts(symbol, scoreRow) {
  // 로딩 표시
  ['struct-term', 'struct-skew', 'struct-heatmap', 'struct-oi-dist', 'struct-weekly-oi'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<div style="padding:16px;color:var(--text3);font-size:12px">로딩 중...</div>`;
  });

  try {
    // 오늘 + 전일 데이터 동시 로드
    const [res, histRes] = await Promise.all([
      fetch(`${CF_API}/api/options-dex/${symbol}`),
      fetch(`${CF_API}/api/options-dex/${symbol}/history?days=3`),
    ]);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rows = data.rows ?? [];

    // 전일 데이터 (히스토리 API 없으면 null)
    let prevRows = null;
    if (histRes.ok) {
      const histData = await histRes.json();
      // 오늘 제외한 가장 최근 날짜 데이터
      const today = rows[0]?.date ?? '';
      const prevDate = (histData.dates ?? []).find(d => d !== today);
      if (prevDate) {
        prevRows = (histData.rows ?? []).filter(r => r.date === prevDate);
      }
    }

    if (!rows.length) {
      ['struct-term', 'struct-skew', 'struct-heatmap', 'struct-oi-dist', 'struct-weekly-oi'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = `<div style="padding:16px;color:var(--text3);font-size:12px">데이터 없음</div>`;
      });
      return;
    }

    const spot = scoreRow?.close ?? null;

    // 공통 계산
    const termData   = calculateTermStructure(rows, prevRows);
    const skewData   = calculateSkew(rows);
    const vannaSum   = rows.reduce((s, r) => s + (r.vanna ?? 0), 0);
    const flipStrike = scoreRow?.flip_strike ?? null;
    const statusResult = evaluateStatus({ termStructure: termData, skewRows: skewData, spot, flipStrike, vannaSum });

    // 상태 뱃지를 헤더에 업데이트
    const strip = document.getElementById('struct-score-strip');
    if (strip) {
      strip.innerHTML = '';
      strip.innerHTML += `
        <span style="
          background:${statusResult.color}22;color:${statusResult.color};
          border:1px solid ${statusResult.color}44;
          border-radius:6px;padding:4px 10px;font-size:12px;font-weight:700;margin-left:8px
        ">${statusResult.label}</span>
        <span style="font-size:11px;color:var(--text3);margin-left:6px">
          ${statusResult.reasons.join(' · ')}
        </span>
      `;
    }

    // 각 섹션 렌더링
    renderVerdict({ termData, skewData, emData: [], spot, flipStrike, vannaSum, rows });  // 작업3: 종합판단 개선
    renderOIDistribution(symbol, rows, spot, flipStrike, []);                        // 작업2: OI 확률 분포
    renderDexTermStructure(
      rows.map(r => ({ ...r, expiry_type: r.expiry_type ?? classifyExpiry(r.expiry_date, rows.map(x => x.expiry_date)) })),
      {
        mode:   'stock',
        maxDTE: 90,
        el:     document.getElementById('struct-term'),
      }
    );
    renderSkewChartImproved(skewData, rows);                                          // 작업6: Skew 판정 수정
    renderSmileSelector(symbol, rows, scoreRow);
    renderExpiryCardsMonthlyFocus(rows, scoreRow);                                    // Vanna/Charm Monthly 강조
    renderDexHeatmap2D(rows);                                                         // 작업4: 2D 히트맵
    renderWeeklyOISelector(rows, spot);                                               // 작업5: 주간 OI 선택기

  } catch (err) {
    console.error('[structure] chart load error:', err);
    ['struct-term', 'struct-skew', 'struct-heatmap'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<div style="padding:16px;color:#ef4444;font-size:12px">로드 실패: ${err.message}</div>`;
    });
  }
}

// ============================================
// 섹션 4 — Term Structure SVG 차트
// ============================================

// ============================================
// 섹션 5 — IV Skew 차트
// ============================================

// ============================================
// ============================================

// ============================================
// 섹션 7 — 만기별 DEX 히트맵
// ============================================
function renderDexHeatmap(rows) {
  const el = document.getElementById('struct-heatmap');
  if (!el) return;

  if (!rows.length) {
    el.innerHTML = '<div style="padding:16px;color:var(--text3)">데이터 없음</div>';
    return;
  }

  const sorted = [...rows].sort((a, b) => a.dte - b.dte);

  // DEX 절대값 최대치 (색상 스케일 기준)
  const dexVals = sorted.map(r => r.dex).filter(v => v != null);
  const maxDex  = Math.max(...dexVals.map(Math.abs)) || 1;

  function dexColor(val) {
    if (val == null) return 'var(--bg3)';
    const t = Math.min(Math.abs(val) / maxDex, 1);
    if (val > 0) {
      // 초록 (콜 DEX)
      const g = Math.round(80 + t * 105);
      const r = Math.round(30 + (1 - t) * 33);
      return `rgb(${r},${g},${Math.round(30 + (1-t)*50)})`;
    } else {
      // 빨강 (풋 DEX)
      const rv = Math.round(80 + t * 168);
      return `rgb(${rv},${Math.round(30 + (1-t)*51)},${Math.round(30 + (1-t)*73)})`;
    }
  }

  const rows_html = sorted.map(r => {
    const dexCol   = dexColor(r.dex);
    const gexCol   = dexColor(r.gex);
    const vannaCol = dexColor(r.vanna);
    const charmCol = dexColor(r.charm);

    const pcrColor = (r.pcr_oi ?? 1) > 1.2 ? '#ef4444' : (r.pcr_oi ?? 1) < 0.8 ? '#22c55e' : 'var(--text3)';

    return `
      <tr>
        <td style="padding:5px 8px;font-family:var(--mono);font-size:11px;white-space:nowrap">
          ${r.expiry_date}
        </td>
        <td style="padding:5px 8px;text-align:center;font-size:10px;color:var(--text3)">D-${r.dte}</td>
        <td style="padding:3px 4px">
          <div style="background:${dexCol};border-radius:4px;padding:4px 8px;text-align:right;font-size:11px;font-weight:700;font-family:var(--mono);color:#fff;white-space:nowrap">
            ${r.dex != null ? (r.dex > 0 ? '+' : '') + r.dex.toFixed(1) : '—'}
          </div>
        </td>
        <td style="padding:3px 4px">
          <div style="background:${gexCol};border-radius:4px;padding:4px 8px;text-align:right;font-size:11px;font-family:var(--mono);color:#fff;white-space:nowrap">
            ${r.gex != null ? (r.gex > 0 ? '+' : '') + r.gex.toFixed(1) : '—'}
          </div>
        </td>
        <td style="padding:3px 4px">
          <div style="background:${vannaCol};border-radius:4px;padding:4px 8px;text-align:right;font-size:11px;font-family:var(--mono);color:#fff;white-space:nowrap">
            ${r.vanna != null ? (r.vanna > 0 ? '+' : '') + r.vanna.toFixed(2) : '—'}
          </div>
        </td>
        <td style="padding:3px 4px">
          <div style="background:${charmCol};border-radius:4px;padding:4px 8px;text-align:right;font-size:11px;font-family:var(--mono);color:#fff;white-space:nowrap">
            ${r.charm != null ? (r.charm > 0 ? '+' : '') + r.charm.toFixed(2) : '—'}
          </div>
        </td>
        <td style="padding:5px 8px;text-align:right;font-size:11px;color:${pcrColor};font-family:var(--mono)">
          ${r.pcr_oi != null ? r.pcr_oi.toFixed(2) : '—'}
        </td>
        <td style="padding:5px 8px;text-align:right;font-size:11px;font-family:var(--mono);color:var(--text2)">
          ${r.flip_strike != null ? '$' + r.flip_strike.toFixed(0) : '—'}
        </td>
      </tr>
    `;
  }).join('');

  el.innerHTML = `
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:var(--bg3)">
            <th style="padding:6px 8px;text-align:left;font-size:10px;color:var(--text3);font-weight:600">만기</th>
            <th style="padding:6px 8px;text-align:center;font-size:10px;color:var(--text3);font-weight:600">DTE</th>
            <th style="padding:6px 8px;text-align:center;font-size:10px;color:#58a6ff;font-weight:600">DEX</th>
            <th style="padding:6px 8px;text-align:center;font-size:10px;color:#3fb950;font-weight:600">GEX</th>
            <th style="padding:6px 8px;text-align:center;font-size:10px;color:#d29922;font-weight:600">Vanna</th>
            <th style="padding:6px 8px;text-align:center;font-size:10px;color:#bc64dc;font-weight:600">Charm</th>
            <th style="padding:6px 8px;text-align:right;font-size:10px;color:var(--text3);font-weight:600">PCR</th>
            <th style="padding:6px 8px;text-align:right;font-size:10px;color:var(--text3);font-weight:600">Flip</th>
          </tr>
        </thead>
        <tbody>
          ${rows_html}
        </tbody>
      </table>
    </div>
    <div style="margin-top:8px;font-size:10px;color:var(--text3)">
      ■ 초록 = 콜 DEX 우세 (딜러 매수 헤징 압력) &nbsp;|&nbsp; ■ 빨강 = 풋 DEX 우세 (딜러 매도 헤징 압력)
    </div>
  `;
}

// ============================================
// 섹션 5b — Volatility Smile 곡선
// ============================================



// ============================================
// 섹션 8 — 종합 판단
// ============================================
// ============================================
// 작업 2: OI 확률 분포 차트 (Monthly 합산, VRVP 스타일)
// ============================================


// ============================================
// 작업 3: 종합 판단 섹션 개선 (스윙/옵션 시나리오)
// renderVerdict를 override하여 새 포맷 적용
// ============================================
// 기존 renderVerdict는 그대로 유지하고,
// loadAndRenderCharts에서 새 버전을 호출하도록 이미 변경됨.
// 아래가 새 버전 renderVerdict (같은 이름으로 재정의 → 마지막 정의가 우선)

function renderVerdict({ termData, skewData, emData, spot, flipStrike, vannaSum, rows }) {
  const el = document.getElementById('struct-verdict');
  if (!el) return;

  // ── 기본 신호 수집 (기존 로직 유지)
  const aboveFlip  = flipStrike && spot ? spot > flipStrike : null;
  const avgSkew    = skewData.length ? skewData.reduce((s, r) => s + r.skew, 0) / skewData.length : 0;
  const vannaOk    = vannaSum > 0;
  const termOk     = termData.status === 'contango';
  const nearestEM  = emData[0] ?? null;

  // Monthly GEX 합산 (rows에서 Monthly만)
  const monthlyRows = rows.filter(r => isMonthlyExpiry(r.expiry_date));
  const monthlyGEX  = monthlyRows.reduce((s, r) => s + (r.gex ?? 0), 0);
  const isLongGamma = monthlyGEX > 0;

  // Monthly DTE 최소값 (피닝 판단용)
  const nearestMonthlyDTE = monthlyRows.length ? Math.min(...monthlyRows.map(r => r.dte)) : null;
  const isPinning = isLongGamma && nearestMonthlyDTE != null && nearestMonthlyDTE <= 5;

  // Call Wall 계산 (rows에서 flip_strike 기준 위 최대 OI 만기)
  const callWallStrike = rows.reduce((m, r) =>
    (r.flip_strike ?? 0) > (m ?? 0) ? r.flip_strike : m, null);

  // 가중 점수
  const signals = [
    { label: 'Flip Zone 위',       ok: aboveFlip === true,  weight: 3 },
    { label: 'Term 콘탱고',        ok: termOk,              weight: 2 },
    { label: 'Skew 완화',          ok: avgSkew < 0.01,      weight: 1 },
    { label: 'Vanna 양수',         ok: vannaOk,             weight: 2 },
    { label: 'EM 상단 여유',       ok: nearestEM && spot ? (nearestEM.upper - spot) / spot * 100 > 2 : false, weight: 1 },
  ];
  const maxScore = signals.reduce((s, x) => s + x.weight, 0);
  const score    = signals.reduce((s, x) => s + (x.ok ? x.weight : 0), 0);
  const scorePct = score / maxScore;

  // ── 시장 구조 요약
  const structureLines = [];
  if (isPinning)          structureLines.push('피닝 가능성 높음');
  if (isLongGamma)        structureLines.push('Long Gamma');
  else                    structureLines.push('Short Gamma');
  if (!vannaOk)           structureLines.push('Vanna 음수');
  else                    structureLines.push('Vanna 양수');

  let structComment = '';
  if (!vannaOk && !aboveFlip) {
    structComment = 'VIX 상승 시 Flip Zone 테스트 가능성';
  } else if (isLongGamma && termOk) {
    structComment = '딜러 매수 헤징 + 콘탱고 — 상승 구조 유지';
  } else if (!isLongGamma) {
    structComment = '변동성 확대 가능 — 방향성 주의';
  } else {
    structComment = '구조 혼재 — 타이밍 확인 필요';
  }

  // ── 스윙 트레이딩 시나리오
  const callWallDist = (spot && callWallStrike) ? (callWallStrike - spot) / spot * 100 : null;
  const flipDist     = (spot && flipStrike) ? (spot - flipStrike) / spot * 100 : null;

  let swingEntry   = '';
  let swingBuyZone = '';
  let swingStop    = flipStrike ? `$${flipStrike.toFixed(0)}` : '—';
  let swingBreakout = '';

  if (callWallDist !== null && callWallDist < 3) {
    swingEntry = '🔴 현재 진입 비추천 (Call Wall 근처)';
  } else if (aboveFlip && termOk) {
    swingEntry = '🟢 진입 후보 조건 충족';
  } else if (!aboveFlip) {
    swingEntry = '🟡 Flip Zone 하단 — 반등 확인 후 진입';
  } else {
    swingEntry = '🟡 조건 불완전 — 부분 진입 검토';
  }

  if (flipStrike && spot) {
    const buyLow  = (flipStrike * 1.005).toFixed(0);
    const buyHigh = (flipStrike * 1.02).toFixed(0);
    swingBuyZone = `$${buyLow} ~ $${buyHigh}`;
  }

  if (callWallStrike) {
    swingBreakout = `$${callWallStrike.toFixed(0)} 돌파 확인 후, 손절 $${flipStrike ? flipStrike.toFixed(0) : '—'}`;
  }

  // ── 옵션 트레이딩 시나리오
  const optionLines = [];
  if (isLongGamma && callWallStrike && spot) {
    const shortCall = callWallStrike.toFixed(0);
    const longCall  = (callWallStrike * 1.02).toFixed(0);
    optionLines.push(`✅ Bear Call Spread $${shortCall} / $${longCall}`);
  }
  if (termOk && avgSkew < 0.03 && callWallStrike && flipStrike) {
    const putStrike1 = (flipStrike * 0.99).toFixed(0);
    const putStrike2 = (flipStrike * 0.97).toFixed(0);
    optionLines.push(`✅ Iron Condor $${callWallStrike.toFixed(0)} / ${((callWallStrike)*1.02).toFixed(0)} / $${putStrike1} / $${putStrike2}`);
  }
  if (!isLongGamma && !vannaOk) {
    optionLines.push('⚠️ Short Gamma + Vanna 음수 — 매도 전략 자제 권고');
  }
  if (!optionLines.length) {
    optionLines.push('— 현재 조건에서 명확한 옵션 전략 없음');
  }

  // ── 주의 사항
  const warnings = [];
  const eventExpiries = termData.eventExpiries ?? new Set();
  if (eventExpiries.size > 0) warnings.push(`⚡ 이벤트 만기 감지 (${[...eventExpiries].join(', ')})`);
  if (!vannaOk) warnings.push('VIX 상승 시 Vanna 헤징 역풍 가능');
  if (nearestMonthlyDTE != null && nearestMonthlyDTE <= 7) warnings.push(`Monthly OPEX D-${nearestMonthlyDTE} — Charm 압력 피크`);

  // ── 최종 판정 색상
  let verdictColor, verdictLabel;
  if (scorePct >= 0.8)      { verdictColor = '#22c55e'; verdictLabel = '🟢 진입 후보'; }
  else if (scorePct >= 0.6) { verdictColor = '#f59e0b'; verdictLabel = '🟡 상승세 지속'; }
  else if (scorePct >= 0.4) { verdictColor = '#f97316'; verdictLabel = '🟠 청산 근접'; }
  else                      { verdictColor = '#ef4444'; verdictLabel = '🔴 관망'; }

  el.innerHTML = `
    <div style="padding:16px">

      <!-- 시장 구조 요약 -->
      <div style="background:${verdictColor}22;border:1px solid ${verdictColor}44;border-radius:10px;padding:14px;margin-bottom:12px">
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px;font-weight:600">【시장 구조 요약】</div>
        <div style="font-size:18px;font-weight:800;color:${verdictColor};margin-bottom:6px">${verdictLabel}</div>
        <div style="font-size:12px;color:var(--text2);margin-bottom:6px">${structureLines.join(' · ')}</div>
        <div style="font-size:11px;color:var(--text3)">→ ${structComment}</div>
        <div style="margin-top:8px;font-size:10px;color:var(--text3)">종합 점수: <strong style="color:${verdictColor}">${score}/${maxScore}</strong></div>
      </div>

      <!-- 스윙 트레이딩 시나리오 -->
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:10px">
        <div style="font-size:11px;color:var(--text3);margin-bottom:8px;font-weight:600">【스윙 트레이딩 시나리오】</div>
        <div style="font-size:13px;font-weight:700;margin-bottom:8px">${swingEntry}</div>
        ${swingBuyZone ? `
        <div style="font-size:11px;color:var(--text2);margin-bottom:4px">
          ✅ 매수 조건: <span style="font-family:var(--mono)">${swingBuyZone}</span> 구간,
          손절 <span style="font-family:var(--mono);color:#ef4444">${swingStop}</span>
        </div>` : ''}
        ${swingBreakout ? `
        <div style="font-size:11px;color:var(--text2)">
          ✅ 돌파 조건: <span style="font-family:var(--mono)">${swingBreakout}</span>
        </div>` : ''}
      </div>

      <!-- 옵션 트레이딩 시나리오 -->
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:10px">
        <div style="font-size:11px;color:var(--text3);margin-bottom:8px;font-weight:600">【옵션 트레이딩 시나리오】</div>
        ${optionLines.map(l => `<div style="font-size:11px;color:var(--text2);margin-bottom:4px">${l}</div>`).join('')}
      </div>

      <!-- 주의 -->
      ${warnings.length ? `
      <div style="background:#f59e0b11;border:1px solid #f59e0b33;border-radius:8px;padding:12px">
        <div style="font-size:11px;color:var(--text3);margin-bottom:6px;font-weight:600">【주의】</div>
        ${warnings.map(w => `<div style="font-size:11px;color:#f59e0b;margin-bottom:3px">${w}</div>`).join('')}
      </div>` : ''}

    </div>
  `;
}

// ============================================
// 작업 4: DEX 히트맵 2D 스타일 (market.js 스타일 적용)
// Monthly 행 강조, 만기 구간별 핵심 지표 표시
// ============================================
function renderDexHeatmap2D(rows) {
  const el = document.getElementById('struct-heatmap');
  if (!el) return;

  if (!rows.length) {
    el.innerHTML = '<div style="padding:16px;color:var(--text3)">데이터 없음</div>';
    return;
  }

  const sorted = [...rows].sort((a, b) => a.dte - b.dte);
  const dexVals = sorted.map(r => r.dex).filter(v => v != null);
  const maxDex  = Math.max(...dexVals.map(Math.abs), 1);

  function heatColor(val, alpha = 1) {
    if (val == null) return `rgba(40,40,40,${alpha})`;
    const t = Math.min(Math.abs(val) / maxDex, 1);
    if (val > 0) {
      const r = Math.round(30  + (1 - t) * 20);
      const g = Math.round(100 + t * 100);
      const b = Math.round(50  + (1 - t) * 30);
      return `rgba(${r},${g},${b},${alpha})`;
    } else {
      const r = Math.round(120 + t * 120);
      const g = Math.round(30  + (1 - t) * 30);
      const b = Math.round(40  + (1 - t) * 30);
      return `rgba(${r},${g},${b},${alpha})`;
    }
  }

  // 구간별 강조 컬럼 결정
  function emphasisCol(dte) {
    if (dte <= 7)  return 'charm';   // D-0~7: Charm 강조
    if (dte <= 21) return 'dex';     // D-8~21: DEX + GEX 강조
    return 'vanna';                   // D-22+: Vanna 강조
  }

  const rowsHtml = sorted.map(r => {
    const isMonthly = isMonthlyExpiry(r.expiry_date);
    const emph      = emphasisCol(r.dte);
    const monthlyBorder = isMonthly
      ? 'outline:2px solid #3b82f6;outline-offset:-2px;'
      : '';

    function cell(val, col) {
      const isEmph = emph === col;
      const bg     = heatColor(val);
      const fw     = isEmph ? 'font-weight:900;' : '';
      const border = isEmph ? 'border:1px solid rgba(255,255,255,0.4);' : '';
      return `<td style="padding:3px 4px">
        <div style="background:${bg};border-radius:4px;padding:4px 7px;text-align:right;
          font-size:${isEmph ? '12' : '11'}px;${fw}font-family:var(--mono);
          color:#fff;white-space:nowrap;${border}">
          ${val != null ? (val > 0 ? '+' : '') + val.toFixed(col === 'vanna' || col === 'charm' ? 2 : 1) : '—'}
        </div>
      </td>`;
    }

    const pcrColor = (r.pcr_oi ?? 1) > 1.2 ? '#ef4444' : (r.pcr_oi ?? 1) < 0.8 ? '#22c55e' : 'var(--text3)';
    const monthlyTag = isMonthly
      ? '<span style="background:#3b82f622;color:#3b82f6;border:1px solid #3b82f644;border-radius:3px;padding:1px 4px;font-size:9px;margin-left:4px">M</span>'
      : '';

    return `
      <tr style="${isMonthly ? 'background:rgba(59,130,246,0.06);' : ''}${monthlyBorder}">
        <td style="padding:5px 8px;font-family:var(--mono);font-size:11px;white-space:nowrap">
          ${r.expiry_date}${monthlyTag}
        </td>
        <td style="padding:5px 6px;text-align:center;font-size:10px;color:var(--text3)">D-${r.dte}</td>
        ${cell(r.dex,   'dex')}
        ${cell(r.gex,   'dex')}
        ${cell(r.vanna, 'vanna')}
        ${cell(r.charm, 'charm')}
        <td style="padding:5px 8px;text-align:right;font-size:11px;color:${pcrColor};font-family:var(--mono)">
          ${r.pcr_oi != null ? r.pcr_oi.toFixed(2) : '—'}
        </td>
        <td style="padding:5px 8px;text-align:right;font-size:11px;font-family:var(--mono);color:var(--text2)">
          ${r.flip_strike != null ? '$' + r.flip_strike.toFixed(0) : '—'}
        </td>
      </tr>
    `;
  }).join('');

  el.innerHTML = `
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:var(--bg3)">
            <th style="padding:6px 8px;text-align:left;font-size:10px;color:var(--text3);font-weight:600">만기</th>
            <th style="padding:6px 8px;text-align:center;font-size:10px;color:var(--text3);font-weight:600">DTE</th>
            <th style="padding:6px 8px;text-align:center;font-size:10px;color:#58a6ff;font-weight:600">DEX <span style="font-size:9px;color:var(--text3)">(D8-21)</span></th>
            <th style="padding:6px 8px;text-align:center;font-size:10px;color:#3fb950;font-weight:600">GEX <span style="font-size:9px;color:var(--text3)">(D8-21)</span></th>
            <th style="padding:6px 8px;text-align:center;font-size:10px;color:#d29922;font-weight:600">Vanna <span style="font-size:9px;color:var(--text3)">(D22+)</span></th>
            <th style="padding:6px 8px;text-align:center;font-size:10px;color:#bc64dc;font-weight:600">Charm <span style="font-size:9px;color:var(--text3)">(D0-7)</span></th>
            <th style="padding:6px 8px;text-align:right;font-size:10px;color:var(--text3);font-weight:600">PCR</th>
            <th style="padding:6px 8px;text-align:right;font-size:10px;color:var(--text3);font-weight:600">Flip</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
    <div style="margin-top:8px;display:flex;gap:14px;font-size:10px;color:var(--text3);flex-wrap:wrap">
      <span>■ 초록 = 콜 DEX (딜러 매수 헤징)</span>
      <span>■ 빨강 = 풋 DEX (딜러 매도 헤징)</span>
      <span style="color:#3b82f6">■ 파란 테두리 = Monthly 만기</span>
      <span>굵은 셀 = 해당 DTE 구간 핵심 지표</span>
    </div>
  `;
}

// ============================================
// 작업 4 보조: Vanna/Charm 카드 — Monthly 강조 버전
// ============================================
function renderExpiryCardsMonthlyFocus(rows, scoreRow) {
  const el = document.getElementById('struct-expiry-cards');
  if (!el) return;

  const spot = scoreRow?.close ?? null;
  const sorted = [...rows].sort((a, b) => a.dte - b.dte);

  if (!sorted.length) {
    el.innerHTML = '<div class="no-data" style="padding:16px;color:var(--text3)">만기 데이터 없음</div>';
    return;
  }

  // Monthly Vanna/Charm 합산
  const monthlyRows = sorted.filter(r => isMonthlyExpiry(r.expiry_date));
  const monthlyVanna = monthlyRows.reduce((s, r) => s + (r.vanna ?? 0), 0);
  const monthlyCharm = monthlyRows.reduce((s, r) => s + (r.charm ?? 0), 0);
  const loopActive   = (monthlyVanna > 0 && monthlyCharm > 0) || (monthlyVanna < 0 && monthlyCharm < 0);

  const summaryHtml = monthlyRows.length ? `
    <div style="background:var(--bg2);border:1px solid ${loopActive ? '#f59e0b44' : 'var(--border)'};
      border-radius:8px;padding:12px 16px;margin-bottom:12px">
      <div style="font-size:10px;color:var(--text3);margin-bottom:6px">Monthly 합산 Vanna + Charm</div>
      <div style="display:flex;gap:20px;align-items:center">
        <div>
          <span style="font-size:10px;color:var(--text3)">Vanna </span>
          <span style="font-size:15px;font-weight:700;font-family:var(--mono);
            color:${monthlyVanna > 0 ? '#22c55e' : '#ef4444'}">
            ${monthlyVanna > 0 ? '▲' : '▼'} ${Math.abs(monthlyVanna).toFixed(3)}
          </span>
        </div>
        <span style="color:var(--text3)">+</span>
        <div>
          <span style="font-size:10px;color:var(--text3)">Charm </span>
          <span style="font-size:15px;font-weight:700;font-family:var(--mono);
            color:${monthlyCharm > 0 ? '#22c55e' : '#ef4444'}">
            ${monthlyCharm > 0 ? '▲' : '▼'} ${Math.abs(monthlyCharm).toFixed(3)}
          </span>
        </div>
        <div style="margin-left:auto;font-size:12px;font-weight:700;color:${loopActive ? '#f59e0b' : '#6e7681'}">
          ${loopActive ? '⚡ 자기강화 루프 조건' : '방향 불일치'}
        </div>
      </div>
    </div>
  ` : '';

  el.innerHTML = summaryHtml + sorted.map(r => {
    const isMonthly = isMonthlyExpiry(r.expiry_date);
    const netOI     = (r.call_oi || 0) - (r.put_oi || 0);
    const netDir    = netOI > 0 ? 'CALL' : netOI < 0 ? 'PUT' : '중립';
    const netColor  = netOI > 0 ? '#22c55e' : netOI < 0 ? '#ef4444' : '#6e7681';
    const flip      = r.flip_strike ?? null;
    const aboveFlip = spot && flip ? spot > flip : null;
    const flipColor = aboveFlip === true ? '#22c55e' : aboveFlip === false ? '#ef4444' : '#6e7681';
    const vanna     = r.vanna ?? 0;
    const charm     = r.charm ?? 0;
    const vannaColor = vanna > 0 ? '#22c55e' : vanna < 0 ? '#ef4444' : '#6e7681';
    const charmColor = charm > 0 ? '#22c55e' : charm < 0 ? '#ef4444' : '#6e7681';

    const tag = isMonthly
      ? `<span style="background:#3b82f622;color:#3b82f6;border:1px solid #3b82f644;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700">MONTHLY</span>`
      : `<span style="background:#6e768122;color:#6e7681;border:1px solid #6e768144;border-radius:4px;padding:1px 6px;font-size:10px">weekly</span>`;

    const borderStyle = isMonthly ? 'border:2px solid #3b82f644;' : 'border:1px solid var(--border);';

    return `
      <div style="background:var(--bg2);${borderStyle}border-radius:8px;padding:14px 16px;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          ${tag}
          <span style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--text)">${r.expiry_date}</span>
          <span style="font-size:12px;color:var(--text3)">D-${r.dte}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
          <div style="background:var(--bg3);border-radius:6px;padding:9px">
            <div style="font-size:10px;color:var(--text3);margin-bottom:3px">Net OI</div>
            <div style="font-size:15px;font-weight:800;color:${netColor}">${netDir}</div>
            <div style="font-size:10px;color:var(--text3)">C ${fmtK(r.call_oi)} / P ${fmtK(r.put_oi)}</div>
          </div>
          <div style="background:var(--bg3);border-radius:6px;padding:9px">
            <div style="font-size:10px;color:var(--text3);margin-bottom:3px">플립존</div>
            <div style="font-size:15px;font-weight:800;font-family:var(--mono);color:${flipColor}">
              ${flip ? '$' + flip.toFixed(0) : '—'}
            </div>
            <div style="font-size:10px;color:${flipColor}">${aboveFlip === true ? '위 ▲' : aboveFlip === false ? '아래 ▼' : '—'}</div>
          </div>
          <div style="background:var(--bg3);border-radius:6px;padding:9px">
            <div style="font-size:10px;color:var(--text3);margin-bottom:3px">ATM IV</div>
            <div style="font-size:15px;font-weight:700;font-family:var(--mono);color:var(--text)">
              ${r.atm_iv != null ? (r.atm_iv * 100).toFixed(1) + '%' : '—'}
            </div>
          </div>
          <div style="background:var(--bg3);border-radius:6px;padding:9px;${isMonthly ? 'border:1px solid #22c55e44' : ''}">
            <div style="font-size:10px;color:${isMonthly ? '#22c55e' : 'var(--text3)'};margin-bottom:3px">
              Vanna${isMonthly ? ' ★' : ''}
            </div>
            <div style="font-size:14px;font-weight:700;font-family:var(--mono);color:${vannaColor}">
              ${vanna > 0 ? '▲' : vanna < 0 ? '▼' : '—'} ${Math.abs(vanna).toFixed(3)}
            </div>
          </div>
          <div style="background:var(--bg3);border-radius:6px;padding:9px;${isMonthly ? 'border:1px solid #22c55e44' : ''}">
            <div style="font-size:10px;color:${isMonthly ? '#22c55e' : 'var(--text3)'};margin-bottom:3px">
              Charm${isMonthly ? ' ★' : ''}
            </div>
            <div style="font-size:14px;font-weight:700;font-family:var(--mono);color:${charmColor}">
              ${charm > 0 ? '▲' : charm < 0 ? '▼' : '—'} ${Math.abs(charm).toFixed(3)}
            </div>
          </div>
          <div style="background:var(--bg3);border-radius:6px;padding:9px">
            <div style="font-size:10px;color:var(--text3);margin-bottom:3px">IV Skew</div>
            <div style="font-size:14px;font-weight:700;color:${(r.iv_skew ?? 0) > 0 ? '#ef4444' : '#22c55e'}">
              ${r.iv_skew != null ? ((r.iv_skew > 0 ? '+' : '') + (r.iv_skew * 100).toFixed(1) + '%') : '—'}
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ============================================
// 작업 5: 주간 OI 분포 선택기
// ============================================
function renderWeeklyOISelector(rows, spot) {
  const el = document.getElementById('struct-weekly-oi');
  if (!el) return;

  // Weekly 만기 추출 (Monthly 제외, DTE ≤ 30)
  const weeklyRows = rows
    .filter(r => !isMonthlyExpiry(r.expiry_date) && r.dte <= 30)
    .sort((a, b) => a.dte - b.dte);

  if (!weeklyRows.length) {
    el.innerHTML = '<div style="padding:16px;color:var(--text3);font-size:12px">위클리 만기 없음</div>';
    return;
  }

  // Net OI 계산 및 이상 베팅 감지
  const netOI    = r => (r.call_oi ?? 0) + (r.put_oi ?? 0);
  const avgNetOI = weeklyRows.reduce((s, r) => s + netOI(r), 0) / weeklyRows.length;
  const threshold = avgNetOI * 1.5;
  const highlighted = new Set(weeklyRows.filter(r => netOI(r) > threshold).map(r => r.expiry_date));

  el.innerHTML = `
    <div style="margin-bottom:10px">
      <div style="display:flex;gap:6px;flex-wrap:wrap" id="weekly-tab-wrap">
        ${weeklyRows.map((r, i) => {
          const isHot = highlighted.has(r.expiry_date);
          return `
            <button class="weekly-tab-btn ${i === 0 ? 'active' : ''}"
              data-expiry="${r.expiry_date}"
              data-idx="${i}"
              style="padding:4px 10px;font-size:11px;border-radius:6px;cursor:pointer;
                background:${i === 0 ? 'var(--accent)' : isHot ? '#f59e0b22' : 'var(--bg3)'};
                color:${i === 0 ? '#fff' : isHot ? '#f59e0b' : 'var(--text3)'};
                border:${i === 0 ? '1px solid var(--accent)' : isHot ? '1px solid #f59e0b44' : '1px solid var(--border)'};">
              ${r.expiry_date.slice(5)} D-${r.dte}${isHot ? ' ⚡' : ''}
            </button>
          `;
        }).join('')}
      </div>
      ${highlighted.size > 0 ? `
        <div style="margin-top:8px;padding:8px 12px;background:#f59e0b11;border:1px solid #f59e0b33;border-radius:6px;font-size:11px;color:#f59e0b">
          ⚡ 이상 베팅 감지: ${[...highlighted].join(', ')} — 평균 대비 1.5배 이상 Net OI
        </div>
      ` : ''}
    </div>
    <div id="weekly-chart-area">
      <div style="padding:16px;color:var(--text3);font-size:12px">만기를 선택하면 OI 분포를 표시합니다</div>
    </div>
  `;

  // 탭 이벤트
  el.querySelectorAll('.weekly-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.weekly-tab-btn').forEach(b => {
        const isHotB = highlighted.has(b.dataset.expiry);
        b.style.background = isHotB ? '#f59e0b22' : 'var(--bg3)';
        b.style.color      = isHotB ? '#f59e0b'   : 'var(--text3)';
        b.style.border     = isHotB ? '1px solid #f59e0b44' : '1px solid var(--border)';
      });
      btn.style.background = 'var(--accent)';
      btn.style.color      = '#fff';
      btn.style.border     = '1px solid var(--accent)';

      const expiry = btn.dataset.expiry;
      const row    = weeklyRows.find(r => r.expiry_date === expiry);
      renderWeeklyOIChart(row, spot, highlighted.has(expiry));
    });
  });

  // 첫번째 자동 렌더
  renderWeeklyOIChart(weeklyRows[0], spot, highlighted.has(weeklyRows[0].expiry_date));
}

function renderWeeklyOIChart(row, spot, isHighlighted) {
  const area = document.getElementById('weekly-chart-area');
  if (!area || !row) return;

  const callOI = row.call_oi ?? 0;
  const putOI  = row.put_oi  ?? 0;
  const total  = callOI + putOI;
  const callPct = total ? ((callOI / total) * 100).toFixed(1) : '—';
  const putPct  = total ? ((putOI  / total) * 100).toFixed(1) : '—';
  const pcr     = row.pcr_oi;
  const flip    = row.flip_strike;
  const aboveFlip = spot && flip ? spot > flip : null;

  // 간단한 Call/Put 비율 바 차트
  const callBarPct = total ? (callOI / total) * 100 : 50;
  const putBarPct  = 100 - callBarPct;

  area.innerHTML = `
    <div style="background:var(--bg2);border:1px solid ${isHighlighted ? '#f59e0b44' : 'var(--border)'};
      border-radius:8px;padding:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-size:13px;font-weight:700;color:var(--text)">${row.expiry_date} <span style="color:var(--text3)">D-${row.dte}</span></span>
        ${isHighlighted ? '<span style="font-size:11px;color:#f59e0b;font-weight:700">⚡ 이상 베팅</span>' : ''}
      </div>

      <!-- Call/Put OI 비율 바 -->
      <div style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3);margin-bottom:4px">
          <span style="color:#22c55e">Call OI ${callPct}%</span>
          <span style="color:#ef4444">Put OI ${putPct}%</span>
        </div>
        <div style="display:flex;height:12px;border-radius:6px;overflow:hidden">
          <div style="width:${callBarPct.toFixed(1)}%;background:#22c55e;opacity:0.7"></div>
          <div style="width:${putBarPct.toFixed(1)}%;background:#ef4444;opacity:0.7"></div>
        </div>
      </div>

      <!-- 지표 그리드 -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
        <div style="background:var(--bg3);border-radius:6px;padding:9px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:3px">Call OI</div>
          <div style="font-size:14px;font-weight:700;font-family:var(--mono);color:#22c55e">${fmtK(callOI)}</div>
        </div>
        <div style="background:var(--bg3);border-radius:6px;padding:9px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:3px">Put OI</div>
          <div style="font-size:14px;font-weight:700;font-family:var(--mono);color:#ef4444">${fmtK(putOI)}</div>
        </div>
        <div style="background:var(--bg3);border-radius:6px;padding:9px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:3px">PCR (OI)</div>
          <div style="font-size:14px;font-weight:700;font-family:var(--mono);
            color:${pcr > 1.2 ? '#ef4444' : pcr < 0.8 ? '#22c55e' : 'var(--text)'}">
            ${pcr != null ? pcr.toFixed(2) : '—'}
          </div>
        </div>
        <div style="background:var(--bg3);border-radius:6px;padding:9px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:3px">Flip Zone</div>
          <div style="font-size:14px;font-weight:700;font-family:var(--mono);
            color:${aboveFlip === true ? '#22c55e' : aboveFlip === false ? '#ef4444' : 'var(--text)'}">
            ${flip ? '$' + flip.toFixed(0) : '—'}
          </div>
          <div style="font-size:10px;color:${aboveFlip === true ? '#22c55e' : '#ef4444'}">
            ${aboveFlip === true ? '위 ▲' : aboveFlip === false ? '아래 ▼' : ''}
          </div>
        </div>
        <div style="background:var(--bg3);border-radius:6px;padding:9px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:3px">ATM IV</div>
          <div style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--text)">
            ${row.atm_iv != null ? (row.atm_iv * 100).toFixed(1) + '%' : '—'}
          </div>
        </div>
        <div style="background:var(--bg3);border-radius:6px;padding:9px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:3px">IV Skew</div>
          <div style="font-size:14px;font-weight:700;color:${(row.iv_skew ?? 0) > 0 ? '#ef4444' : '#22c55e'}">
            ${row.iv_skew != null ? ((row.iv_skew > 0 ? '+' : '') + (row.iv_skew * 100).toFixed(1) + '%') : '—'}
          </div>
        </div>
      </div>
    </div>
  `;
}

// ============================================
// 작업 6: IV Skew 판정 수정 (역사적 평균 대비)
// renderSkewChart를 개선한 새 버전
// ============================================
