// ============================================
// js/tabs/structure.js — Structure 탭
// 종목 선택 → 1~2개월 만기 스펙트럼 딜러 헷지 지형 분석
// ============================================

import { state } from '../state.js';
import { CF_API, RAILWAY_URL, CRON_SECRET } from '../config.js';
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
  renderVannaDistChart,
} from '../options-charts.js';

// ── 내부 상태
let currentSymbol = null;

// ── LW 차트 전역 상태
let _stLwChart        = null;
let _stLwCandle       = null;
let _stLwVolChart     = null;
let _stLwVolSeries    = null;
let _stLwBB           = { upper2:null, lower2:null, upper1:null, lower1:null, mid:null };
let _stChartSymbol    = null;
let _stChartRes       = '30';
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
    <button class="struct-collect-btn" id="struct-collect-btn" title="옵션체인 새로 수집">⬇ 수집</button>
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

    <!-- 섹션 4: 만기별 DEX 히트맵 + EM 차트 -->
    <div class="struct-panel">
      <div class="struct-panel-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <span>
          <span class="panel-icon">▦</span> DEX 히트맵 · EM 분포
          <span class="panel-sub">만기 선택 합산 · 딜러 헤징 압력 · Expected Move</span>
        </span>
        <div style="display:flex;gap:6px">
          <button id="st-all-btn"   style="font-size:10px;padding:2px 8px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text);cursor:pointer">전체선택</button>
          <button id="st-none-btn"  style="font-size:10px;padding:2px 8px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text);cursor:pointer">전체해제</button>
          <button id="st-apply-btn" style="font-size:10px;padding:2px 10px;background:var(--accent);border:1px solid var(--accent);border-radius:4px;color:#fff;cursor:pointer;font-weight:600">적용</button>
        </div>
      </div>
      <div id="st-expiry-panel" style="padding:8px 14px;border-bottom:1px solid var(--border)"></div>
      <div id="st-peak-verify" style="padding:4px 14px;font-size:11px;font-family:var(--mono)"></div>
      <div id="st-heatmap-canvas" style="padding:4px 0"></div>
      <div style="padding:8px 14px 4px;font-size:11px;color:var(--text3)">선택만기 합산 · Expected Move</div>
      <div id="st-expiry-em" style="padding:0 14px 14px"></div>
    </div>

    <!-- 섹션 4-1: LW 캔들 차트 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">📈</span> 가격 차트
        <div id="struct-chart-itv" class="toggle-group" style="margin-left:auto">
          <button class="chart-itv-btn" data-res="5">5분</button>
          <button class="chart-itv-btn active" data-res="30">30분</button>
          <button class="chart-itv-btn" data-res="D">일봉</button>
          <button class="chart-itv-btn" data-res="W">주봉</button>
        </div>
      </div>
      <div id="struct-chart-empty" style="display:flex;align-items:center;justify-content:center;height:120px;color:var(--text3);font-size:13px">
        종목을 선택하면 차트를 표시합니다
      </div>
      <div id="struct-lw-wrap" style="width:100%;height:420px;display:none"></div>
      <div id="struct-vol-wrap" style="width:100%;height:100px;display:none"></div>
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

  document.getElementById('struct-collect-btn')?.addEventListener('click', async () => {
    if (!currentSymbol) return;
    const btn = document.getElementById('struct-collect-btn');
    btn.disabled = true;
    btn.textContent = '수집 중...';
    try {
      await collectAndReload(currentSymbol);
    } finally {
      btn.disabled = false;
      btn.textContent = '⬇ 수집';
    }
  });

  // LW 차트 interval 버튼
  document.getElementById('struct-chart-itv')?.addEventListener('click', e => {
    const btn = e.target.closest('.chart-itv-btn');
    if (!btn) return;
    document.querySelectorAll('#struct-chart-itv .chart-itv-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _stChartRes = btn.dataset.res;
    if (_stChartSymbol) _stLoadAndRenderLWChart(_stChartSymbol, _stChartRes);
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
// 단일 종목 옵션체인 수집 후 화면 갱신
// ============================================
async function collectAndReload(symbol) {
  try {
    const res = await fetch(`${RAILWAY_URL}/analyze-symbol`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
      body:    JSON.stringify({ symbol, save: true }),
      signal:  AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`수집 실패: ${res.status}`);
    await loadStructure(symbol);
  } catch (err) {
    console.error('[collect] error:', err);
    alert(`${symbol} 수집 실패: ${err.message}`);
  }
}

// ============================================
// 데이터 로드
// ============================================
let _loadToken = 0;

async function loadStructure(symbol) {
  symbol = symbol.toUpperCase();
  const token = ++_loadToken;
  currentSymbol = symbol;

  showState('loading', `${symbol} 분석 중...`);

  try {
    const [screenerRes, flowRes] = await Promise.all([
      fetch(`${CF_API}/api/screener/latest`),
      fetch(`${CF_API}/api/structure/${symbol}`),
    ]);

    if (token !== _loadToken) return;

    const screenerAll = await screenerRes.json();
    const flowData    = flowRes.ok ? await flowRes.json() : null;

    if (token !== _loadToken) return;

    const scoreRow = Array.isArray(screenerAll)
      ? screenerAll.find(r => r.symbol === symbol)
      : null;

    // 새 API: { monthly, weekly, context } 구조
    const monthly = flowData?.monthly ?? [];
    const weekly  = flowData?.weekly  ?? null;
    const context = flowData?.context ?? null;

    if (!scoreRow && !monthly.length) {
      showOneTimePrompt(symbol);
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
// 일회성 조회 프롬프트
// ============================================
function showOneTimePrompt(symbol) {
  document.getElementById('struct-content').style.display = 'none';
  const el = document.getElementById('struct-state');
  el.style.display = 'flex';
  el.dataset.promptSymbol = symbol;  // 현재 심볼 저장 (클로저 버그 방지)
  el.innerHTML = `
    <div style="
      display:flex;flex-direction:column;align-items:center;gap:16px;
      padding:32px;max-width:420px;text-align:center;
    ">
      <div style="font-size:32px">🔍</div>
      <div style="font-size:16px;font-weight:600;color:var(--color-text-primary)">
        ${symbol} 저장된 데이터가 없습니다
      </div>
      <div style="font-size:13px;color:var(--color-text-secondary);line-height:1.6">
        지금 바로 CBOE에서 실시간 데이터를 조회할 수 있습니다.<br>
        지속적인 모니터링을 원하시면 스크리너에 추가하세요.
      </div>
      <label style="
        display:flex;align-items:center;gap:8px;
        font-size:13px;color:var(--color-text-secondary);
        cursor:pointer;padding:8px 12px;
        border:1px solid var(--color-border-tertiary);border-radius:8px;
      ">
        <input type="checkbox" id="st-add-to-screener" style="width:16px;height:16px;cursor:pointer">
        스크리너에 추가 (CHECK 그룹)
      </label>
      <button id="st-onetime-btn" style="
        padding:10px 28px;border-radius:8px;border:none;cursor:pointer;
        background:var(--color-primary,#3b82f6);color:#fff;
        font-size:14px;font-weight:600;
      ">지금 조회</button>
      <div id="st-onetime-msg" style="font-size:12px;color:var(--color-text-secondary)"></div>
    </div>
  `;

  document.getElementById('st-onetime-btn').addEventListener('click', () => {
    const sym = document.getElementById('struct-state').dataset.promptSymbol;
    loadOneTime(sym);
  });
}

async function loadOneTime(symbol) {
  const btn     = document.getElementById('st-onetime-btn');
  const msg     = document.getElementById('st-onetime-msg');
  const addChk  = document.getElementById('st-add-to-screener');
  const addToScreener = addChk?.checked ?? false;

  if (btn) { btn.disabled = true; btn.textContent = '조회 중...'; }
  if (msg) msg.textContent = 'CBOE에서 데이터 수집 중... (약 5~10초 소요)';

  try {
    const res  = await fetch(`${RAILWAY_URL}/analyze-symbol`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-cron-secret': CRON_SECRET,
      },
      body: JSON.stringify({ symbol }),
      signal: AbortSignal.timeout(30000),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

    // 스크리너 추가 요청
    if (addToScreener) {
      try {
        await fetch(`${CF_API}/api/symbols/add`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'x-cron-secret': CRON_SECRET,
          },
          body: JSON.stringify({ symbol, group: 'CHECK' }),
        });
      } catch (e) {
        console.warn('[structure] 스크리너 추가 실패:', e.message);
      }
    }

    // 결과로 페이지 구성
    // scoreRow 형태로 변환
    const scoreRow = {
      symbol,
      name:        data.symbol,
      spot_price:  data.spot_price,
      net_gex:     data.net_gex,
      flip_strike: data.flip_strike,
      distance_pct:data.distance_pct,
      atm_iv:      data.atm_iv,
      date:        data.date,
    };

    currentData = { symbol, scoreRow, monthly: data.rows ?? [], weekly: null, context: null };
    renderContent(currentData);

    // 스트라이크 데이터 → 히트맵
    if (data.strikeRows?.length) {
      const strikesExpirations = {};
      data.strikeRows.forEach(s => {
        if (!strikesExpirations[s.expiry_date]) {
          strikesExpirations[s.expiry_date] = { strikes: [], flip_strike: null };
        }
        strikesExpirations[s.expiry_date].strikes.push({
          strike: s.strike,
          dex:    s.dex    ?? 0,
          gex:    s.gex    ?? 0,
          vanna:  s.vanna  ?? 0,
          charm:  s.charm  ?? 0,
          callOI: s.call_oi ?? 0,
          putOI:  s.put_oi  ?? 0,
        });
      });
      _stRenderHeatmapSection(strikesExpirations, data.spot_price, symbol);
    }

  } catch (err) {
    console.error('[structure] 일회성 조회 실패:', err);
    if (btn)  { btn.disabled = false; btn.textContent = '다시 시도'; }
    if (msg)  msg.textContent = `조회 실패: ${err.message}`;
  }
}
function renderContent({ symbol, scoreRow, monthly, weekly, context }) {
  document.getElementById('struct-state').style.display   = 'none';
  document.getElementById('struct-content').style.display = 'block';

  // 헤더
  document.getElementById('struct-sym-name').textContent     = symbol;
  document.getElementById('struct-sym-fullname').textContent = scoreRow?.name || '';
  document.getElementById('struct-updated').textContent      = scoreRow?.date
    ? `기준일: ${scoreRow.date}` : '';

  loadAndRenderCharts(symbol, scoreRow);

  // LW 차트 갱신
  _stChartSymbol = symbol;
  _stLoadAndRenderLWChart(symbol, _stChartRes);
}


// ── 상태 표시 (loading / empty / error)
function showState(type, msg) {
  document.getElementById('struct-content').style.display = 'none';
  const box = document.getElementById('struct-state');
  box.style.display = 'flex';

  // showOneTimePrompt가 innerHTML을 교체했을 수 있으므로 원래 구조 복원
  if (!box.querySelector('.struct-state-icon')) {
    box.innerHTML = `
      <div class="struct-state-icon"></div>
      <div class="struct-state-msg"></div>
    `;
  }

  const icon = box.querySelector('.struct-state-icon');
  const txt  = box.querySelector('.struct-state-msg');

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
  ['struct-term', 'struct-skew', 'struct-heatmap', 'struct-weekly-oi'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<div style="padding:16px;color:var(--text3);font-size:12px">로딩 중...</div>`;
  });

  try {
    // 오늘 + 전일 + analyze-symbol(strikeRows) 동시 로드
    const [res, histRes, analyzeRes] = await Promise.all([
      fetch(`${CF_API}/api/options-dex/${symbol}`),
      fetch(`${CF_API}/api/options-dex/${symbol}/history?days=3`),
      fetch(`${RAILWAY_URL}/analyze-symbol`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
        body:    JSON.stringify({ symbol }),
      }),
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
      ['struct-term', 'struct-skew', 'struct-heatmap', 'struct-weekly-oi'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = `<div style="padding:16px;color:var(--text3);font-size:12px">데이터 없음</div>`;
      });
      return;
    }

    const spot = scoreRow?.spot_price ?? null;

    // analyze-symbol strikeRows → expirations 객체 변환 (히트맵/EM용)
    let strikesExpirations = {};
    if (analyzeRes?.ok) {
      const analyzeData = await analyzeRes.json();
      const strikeRows  = analyzeData.strikeRows ?? [];
      strikeRows.forEach(s => {
        if (!strikesExpirations[s.expiry_date]) {
          strikesExpirations[s.expiry_date] = { strikes: [], flip_strike: null };
        }
        strikesExpirations[s.expiry_date].strikes.push({
          strike: s.strike,
          dex:    s.dex    ?? 0,
          gex:    s.gex    ?? 0,
          vanna:  s.vanna  ?? 0,
          charm:  s.charm  ?? 0,
          callOI: s.call_oi ?? 0,
          putOI:  s.put_oi  ?? 0,
        });
      });
    }

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
    renderVerdict({ termData, skewData, emData: [], spot, flipStrike, vannaSum, rows });
    _stRenderHeatmapSection(strikesExpirations, spot, symbol);

    // ── peak_call_dex_strike 검증 메시지 (임시)
    // D1에 저장된 peak_call_dex_strike vs 히트맵 실시간 계산값 비교
    if (analyzeRes?.ok) {
      const analyzeData = await analyzeRes.json().catch(() => null);
      const verifyEl = document.getElementById('st-peak-verify');
      if (verifyEl && analyzeData?.strikeRows?.length) {
        const mismatches = [];
        for (const row of rows) {
          const stored = row.peak_call_dex_strike ?? null;
          if (stored == null) continue;
          // 히트맵과 동일한 방식으로 해당 만기 최대 콜DEX 스트라이크 계산
          const expiryStrikes = strikesExpirations[row.expiry_date]?.strikes ?? [];
          const above = expiryStrikes.filter(s => s.dex > 0);
          const M = above.length ? above.reduce((a, b) => a.dex > b.dex ? a : b) : null;
          if (M && M.strike !== stored) {
            mismatches.push(`${row.expiry_date}: 저장=${stored} / 히트맵=${M.strike}`);
          }
        }
        if (mismatches.length === 0) {
          verifyEl.textContent = `✅ peak_call_dex_strike 일치 (${rows.filter(r => r.peak_call_dex_strike).length}개 만기)`;
          verifyEl.style.color = '#22c55e';
        } else {
          verifyEl.textContent = `⚠️ 불일치 : ${mismatches.join(' | ')}`;
          verifyEl.style.color = '#f59e0b';
        }
      }
    }
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

  const spot = scoreRow?.spot_price ?? null;
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

// ============================================
// 히트맵 + EM 차트 섹션 (market.js 로직 포팅)
// ============================================

// ── 색상 상수 ──────────────────────────────────────────────
const _ST_C_CALL   = { r: 63,  g: 185, b: 80  };
const _ST_C_PUT    = { r: 248, g: 81,  b: 73  };
const _ST_C_SPOT   = 'rgba(210,153,34,0.9)';
const _ST_C_BORDER = 'rgba(255,255,255,0.06)';
const _ST_ROW_COLORS = [
  '#58a6ff','#3fb950','#d29922','#bc64dc',
  '#f0883e','#2dd4bf','#a78bfa','#fb8f44',
  '#39d353','#ff6b6b',
];

// ── 상태 ──────────────────────────────────────────────────
let _stExpiryConfig = {};
let _stEmInst       = null;
let _stLastSymbol   = null;

// ── DTE 계산 ──────────────────────────────────────────────
function _stCalcDTE(expiry) {
  const exp = new Date(`${expiry}T16:00:00-05:00`);
  return Math.max(0, Math.round((exp - new Date()) / 86_400_000));
}

// ── 만기 설정 초기화 ─────────────────────────────────────
function _stInitExpiryConfig(expirations) {
  const existing = Object.keys(_stExpiryConfig);
  Object.keys(expirations).forEach((expiry, i) => {
    if (_stExpiryConfig[expiry]) return;
    const dte = _stCalcDTE(expiry);
    _stExpiryConfig[expiry] = {
      enabled: dte <= 65,
      weight:  1.0,
      dte,
      color: _ST_ROW_COLORS[i % _ST_ROW_COLORS.length],
    };
  });
  existing.forEach(e => {
    if (!expirations[e]) delete _stExpiryConfig[e];
  });
}

// ── 만기 선택 패널 렌더링 ────────────────────────────────
function _stRenderExpiryPanel() {
  const container = document.getElementById('st-expiry-panel');
  if (!container) return;

  const sorted = Object.entries(_stExpiryConfig)
    .sort(([a], [b]) => a.localeCompare(b));

  container.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      ${sorted.map(([expiry, cfg]) => {
        const dteStr = cfg.dte === 0 ? '0DTE' : `D-${cfg.dte}`;
        return `
          <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;
            background:${cfg.enabled ? cfg.color + '22' : 'var(--bg3)'};
            border:1px solid ${cfg.enabled ? cfg.color + '66' : 'var(--border)'};
            border-radius:4px;padding:3px 8px;font-size:10px;color:var(--text);
            transition:background 0.15s">
            <input type="checkbox" data-expiry="${expiry}"
              ${cfg.enabled ? 'checked' : ''}
              style="width:10px;height:10px;cursor:pointer;accent-color:${cfg.color}">
            <span style="font-family:var(--mono)">${expiry.slice(5)}</span>
            <span style="color:var(--text3)">${dteStr}</span>
          </label>`;
      }).join('')}
    </div>`;

  container.querySelectorAll('input[type=checkbox]').forEach(chk => {
    chk.addEventListener('change', (e) => {
      const exp = e.target.dataset.expiry;
      if (_stExpiryConfig[exp]) _stExpiryConfig[exp].enabled = e.target.checked;
      _stRenderExpiryPanel();
    });
  });
}

// ── 가중합산 계산 ────────────────────────────────────────
function _stBuildWeighted(expirations) {
  const strikeMap = {};
  for (const [expiry, expiryData] of Object.entries(expirations)) {
    const cfg = _stExpiryConfig[expiry];
    if (!cfg?.enabled) continue;
    const w = cfg.weight;
    const strikes = Array.isArray(expiryData) ? expiryData : (expiryData.strikes ?? []);
    for (const s of strikes) {
      if (!strikeMap[s.strike]) {
        strikeMap[s.strike] = { strike: s.strike, callDex: 0, putDex: 0, netDex: 0, gex: 0, vanna: 0, charm: 0 };
      }
      const e = strikeMap[s.strike];
      e.callDex += s.dex > 0 ? s.dex * w : 0;
      e.putDex  += s.dex < 0 ? s.dex * w : 0;
      e.netDex  += s.dex   * w;
      e.gex     += (s.gex   ?? 0) * w;
      e.vanna   += (s.vanna ?? 0) * w;
      e.charm   += (s.charm ?? 0) * w;
    }
  }
  return Object.values(strikeMap).sort((a, b) => a.strike - b.strike);
}

// ── Key Level 추출 ───────────────────────────────────────
function _stExtractKeyLevels({ strikes, flip_strike }, spot) {
  const above = strikes.filter(s => s.dex > 0 && s.strike > (spot || 0));
  const M     = above.length ? above.reduce((a, b) => a.dex > b.dex ? a : b) : null;
  const below = strikes.filter(s => s.dex < 0 && s.strike <= (spot || Infinity));
  const m     = below.length ? below.reduce((a, b) => Math.abs(a.dex) > Math.abs(b.dex) ? a : b) : null;
  return { M: M?.strike ?? null, m: m?.strike ?? null, G: flip_strike ?? null };
}

// ── 드래그 스크롤 ────────────────────────────────────────
function _stAttachDragScroll(el) {
  let isDown = false, startX = 0, scrollLeft = 0;
  el.addEventListener('mousedown', (e) => {
    isDown = true; el.style.cursor = 'grabbing';
    startX = e.pageX - el.offsetLeft; scrollLeft = el.scrollLeft;
  });
  el.addEventListener('mouseleave', () => { isDown = false; el.style.cursor = ''; });
  el.addEventListener('mouseup',    () => { isDown = false; el.style.cursor = ''; });
  el.addEventListener('mousemove',  (e) => {
    if (!isDown) return;
    e.preventDefault();
    el.scrollLeft = scrollLeft - (e.pageX - el.offsetLeft - startX) * 1.2;
  });
  let tx = 0, ts = 0;
  el.addEventListener('touchstart', (e) => { tx = e.touches[0].pageX; ts = el.scrollLeft; }, { passive: true });
  el.addEventListener('touchmove',  (e) => { el.scrollLeft = ts + (tx - e.touches[0].pageX); }, { passive: true });
}

// ── 히트맵 렌더링 ────────────────────────────────────────
function _stRenderHeatmap(expirations, weighted, spot) {
  const container = document.getElementById('st-heatmap-canvas');
  if (!container) return;

  const allStrikes = [...new Set(
    Object.values(expirations)
      .flatMap(e => Array.isArray(e) ? e : (e.strikes ?? []))
      .map(s => s.strike)
  )].sort((a, b) => a - b);

  if (!allStrikes.length) return;

  const enabledExpiries = Object.entries(_stExpiryConfig)
    .filter(([, cfg]) => cfg.enabled)
    .sort(([a], [b]) => a.localeCompare(b));

  if (!enabledExpiries.length) return;

  const ROW_H = 28, LABEL_W = 72, CELL_W = 28, HEADER_H = 22, SUM_H = 32, LEGEND_H = 18;
  const rows    = enabledExpiries.length;
  const canvasW = allStrikes.length * CELL_W;
  const canvasH = HEADER_H + rows * ROW_H + SUM_H + LEGEND_H + 10;
  const spotCol = spot ? allStrikes.findIndex(s => s >= spot) : -1;

  const maxVal = Math.max(...Object.values(expirations)
    .flatMap(e => Array.isArray(e) ? e : (e.strikes ?? []))
    .map(s => Math.abs(s.dex ?? 0)), 1);
  const maxSum = Math.max(...weighted.map(s => Math.abs(s.netDex)), 1);

  const C_M = `rgb(${_ST_C_CALL.r},${_ST_C_CALL.g},${_ST_C_CALL.b})`;
  const C_m = `rgb(${_ST_C_PUT.r},${_ST_C_PUT.g},${_ST_C_PUT.b})`;
  const C_G = 'rgb(139,92,246)';

  function drawMarker(ctx, x, y, cellW, cellH, hasM, hasm, hasG) {
    if (!hasM && !hasm && !hasG) return;
    const x1 = x+1, y1 = y+1, w = cellW-2, h = cellH-2;
    ctx.save();
    ctx.beginPath(); ctx.rect(x1,y1,w,h); ctx.clip();
    if ((hasM&&hasG)||( hasm&&hasG&&!hasM)) {
      ctx.strokeStyle=C_G; ctx.lineWidth=1.5; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x1,y1+h); ctx.lineTo(x1+w,y1); ctx.stroke();
    }
    if (hasM&&hasm&&!hasG) {
      ctx.strokeStyle=C_m; ctx.lineWidth=1.5; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x1,y1+h); ctx.lineTo(x1+w,y1); ctx.stroke();
    }
    if (hasM&&hasm&&hasG) {
      ctx.strokeStyle=C_m; ctx.lineWidth=1.5;
      ctx.beginPath(); ctx.moveTo(x1,y1+h); ctx.lineTo(x1+w,y1); ctx.stroke();
      ctx.strokeStyle=C_G;
      ctx.beginPath(); ctx.moveTo(x1+w,y1+h); ctx.lineTo(x1,y1); ctx.stroke();
    }
    ctx.restore();
    ctx.lineWidth=1.8; ctx.setLineDash([]);
    const cnt = [hasM,hasm,hasG].filter(Boolean).length;
    if (cnt===1) {
      ctx.strokeStyle = hasM?C_M:hasm?C_m:C_G;
      ctx.strokeRect(x1,y1,w,h);
    } else {
      let cA,cB;
      if (hasM&&hasG&&!hasm)      { cA=C_M; cB=C_G; }
      else if (hasm&&hasG&&!hasM) { cA=C_m; cB=C_G; }
      else                        { cA=C_M; cB=C_m; }
      ctx.strokeStyle=cA; ctx.beginPath(); ctx.moveTo(x1+w,y1); ctx.lineTo(x1,y1); ctx.lineTo(x1,y1+h); ctx.stroke();
      ctx.strokeStyle=cB; ctx.beginPath(); ctx.moveTo(x1,y1+h); ctx.lineTo(x1+w,y1+h); ctx.lineTo(x1+w,y1); ctx.stroke();
    }
    const label=[hasM?'M':'',hasm?'m':'',hasG?'G':''].filter(Boolean).join('');
    ctx.fillStyle='#fff'; ctx.font=`bold ${label.length>=3?7:8}px monospace`;
    ctx.textAlign='right'; ctx.fillText(label,x1+w-1,y1+9);
  }

  // sticky 라벨 캔버스
  const lblCanvas = document.createElement('canvas');
  lblCanvas.width = LABEL_W; lblCanvas.height = canvasH;
  lblCanvas.style.cssText = `display:block;flex-shrink:0;width:${LABEL_W}px;height:${canvasH}px;position:sticky;left:0;z-index:2;`;
  const lctx = lblCanvas.getContext('2d');
  lctx.fillStyle = '#0d1117'; lctx.fillRect(0,0,LABEL_W,canvasH);
  enabledExpiries.forEach(([expiry,cfg], rowIdx) => {
    const y = HEADER_H + rowIdx * ROW_H;
    lctx.fillStyle=cfg.color; lctx.font='15px monospace'; lctx.textAlign='right';
    lctx.fillText(expiry.slice(5), LABEL_W-4, y+ROW_H/2+3);
    lctx.fillStyle='#aaa'; lctx.font='12px monospace';
    lctx.fillText(cfg.dte===0?'0DTE':`${cfg.dte}d`, LABEL_W-4, y+ROW_H/2+16);
  });
  const sumY = HEADER_H + rows * ROW_H + 4;
  lctx.strokeStyle='rgba(255,255,255,0.12)'; lctx.lineWidth=1; lctx.setLineDash([]);
  lctx.beginPath(); lctx.moveTo(0,sumY-4); lctx.lineTo(LABEL_W,sumY-4); lctx.stroke();
  lctx.fillStyle='#fff'; lctx.font='15px monospace'; lctx.textAlign='right';
  lctx.fillText('합산', LABEL_W-4, sumY+SUM_H/2+4);

  // 데이터 캔버스
  const dataCanvas = document.createElement('canvas');
  dataCanvas.width = canvasW; dataCanvas.height = canvasH;
  dataCanvas.style.cssText = `display:block;width:${canvasW}px;height:${canvasH}px;`;
  const ctx = dataCanvas.getContext('2d');
  ctx.fillStyle='#0d1117'; ctx.fillRect(0,0,canvasW,canvasH);

  // 스트라이크 헤더
  ctx.font='13px monospace'; ctx.textAlign='center';
  allStrikes.forEach((strike, i) => {
    const x = i*CELL_W + CELL_W/2;
    const isSpot = i===spotCol;
    ctx.fillStyle = isSpot ? _ST_C_SPOT : (strike%5===0?'#ffffff':'transparent');
    if (isSpot||strike%5===0) ctx.fillText(`${strike}`,x,HEADER_H-5);
  });

  // 만기별 행
  enabledExpiries.forEach(([expiry,cfg], rowIdx) => {
    const expiryData = expirations[expiry] ?? {};
    const rawStrikes = Array.isArray(expiryData)?expiryData:(expiryData.strikes??[]);
    const flipStrike = Array.isArray(expiryData)?null:(expiryData.flip_strike??null);
    const strikeMap  = {}; rawStrikes.forEach(s=>{strikeMap[s.strike]=s;});
    const kl = _stExtractKeyLevels({strikes:rawStrikes,flip_strike:flipStrike},spot);
    const y  = HEADER_H + rowIdx*ROW_H;
    allStrikes.forEach((strike,i) => {
      const x = i*CELL_W;
      const s = strikeMap[strike];
      ctx.fillStyle=_ST_C_BORDER; ctx.fillRect(x+1,y+2,CELL_W-2,ROW_H-4);
      if (s) {
        const dex = (s.dex??0)*cfg.weight;
        const intensity = Math.min(Math.abs(dex)/maxVal,1);
        const c = dex>=0?_ST_C_CALL:_ST_C_PUT;
        ctx.fillStyle=`rgba(${c.r},${c.g},${c.b},${(intensity*0.8+0.1).toFixed(2)})`;
        ctx.fillRect(x+1,y+2,CELL_W-2,ROW_H-4);
      }
      drawMarker(ctx,x,y+2,CELL_W,ROW_H-4,strike===kl.M,strike===kl.m,strike===kl.G);
    });
  });

  // 구분선
  ctx.strokeStyle='rgba(255,255,255,0.12)'; ctx.lineWidth=1; ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(0,sumY-4); ctx.lineTo(canvasW,sumY-4); ctx.stroke();

  // 합산 행
  const weightedAsRaw = weighted.map(s=>({strike:s.strike,dex:s.netDex}));
  const sumKl = _stExtractKeyLevels({strikes:weightedAsRaw,flip_strike:null},spot);
  ctx.fillStyle='rgba(255,255,255,0.03)'; ctx.fillRect(0,sumY,canvasW,SUM_H);
  allStrikes.forEach((strike,i) => {
    const x = i*CELL_W;
    const s = weighted.find(w=>w.strike===strike);
    ctx.fillStyle=_ST_C_BORDER; ctx.fillRect(x+1,sumY+2,CELL_W-2,SUM_H-4);
    if (s&&s.netDex!==0) {
      const intensity=Math.min(Math.abs(s.netDex)/maxSum,1);
      const c=s.netDex>=0?_ST_C_CALL:_ST_C_PUT;
      ctx.fillStyle=`rgba(${c.r},${c.g},${c.b},${(intensity*0.9+0.1).toFixed(2)})`;
      ctx.fillRect(x+1,sumY+2,CELL_W-2,SUM_H-4);
    }
    drawMarker(ctx,x,sumY+2,CELL_W,SUM_H-4,strike===sumKl.M,strike===sumKl.m,strike===sumKl.G);
  });

  // spot 선
  if (spot&&spotCol>=0) {
    const sx=spotCol*CELL_W, mx=sx+CELL_W/2;
    ctx.save(); ctx.strokeStyle=_ST_C_SPOT; ctx.lineWidth=1.5; ctx.setLineDash([]); ctx.globalAlpha=0.85;
    ctx.beginPath(); ctx.moveTo(sx,HEADER_H); ctx.lineTo(sx,sumY+SUM_H); ctx.stroke();
    ctx.globalAlpha=1; ctx.restore();
    ctx.fillStyle=_ST_C_SPOT;
    ctx.beginPath(); ctx.moveTo(mx,sumY-2); ctx.lineTo(mx-5,sumY-9); ctx.lineTo(mx+5,sumY-9);
    ctx.closePath(); ctx.fill();
    ctx.font='13px monospace'; ctx.textAlign='center';
    ctx.fillText(`$${spot.toFixed(0)}`,mx,sumY-11);
  }

  // DOM 조립
  const scrollDiv = document.createElement('div');
  scrollDiv.style.cssText='overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;flex:1;min-width:0;';
  scrollDiv.appendChild(dataCanvas);
  container.innerHTML='';
  container.style.cssText='display:flex;flex-direction:row;align-items:stretch;border-top:1px solid var(--border);border-bottom:1px solid var(--border);';
  container.appendChild(lblCanvas);
  container.appendChild(scrollDiv);

  // 범례 (기존 범례 제거 후 재삽입)
  const legId = 'st-heatmap-legend';
  document.getElementById(legId)?.remove();
  const legDiv = document.createElement('div');
  legDiv.id = legId;
  legDiv.style.cssText='padding:4px 8px;display:flex;justify-content:space-between;font-size:10px;color:var(--text3)';
  legDiv.innerHTML='<span>■ 녹색: 딜러 매수 헤지 &nbsp;■ 빨간색: 딜러 매도 헤지</span><span>색상 농도 = 헤징 압력 강도</span>';
  container.parentElement?.insertBefore(legDiv, container.nextSibling);

  if (spotCol>=0) {
    const scrollTarget = spotCol*CELL_W - scrollDiv.clientWidth/2 + CELL_W/2;
    scrollDiv.scrollLeft = Math.max(0,scrollTarget);
  }
  if (!scrollDiv._dragScrollBound) {
    _stAttachDragScroll(scrollDiv);
    scrollDiv._dragScrollBound = true;
  }
}

// ── EM 차트 렌더링 ───────────────────────────────────────
function _stRenderEM(weighted, spot) {
  const el = document.getElementById('st-expiry-em');
  if (!el||!weighted?.length||!spot) return;

  const strikes = weighted.map(s => ({
    strike: s.strike,
    dex:    s.netDex,
    vanna:  s.vanna,
    gex:    s.gex,
    avg_iv: null,
  }));

  if (_stEmInst) {
    _stEmInst.update(strikes, spot, { vixDir: 'neutral' });
  } else {
    _stEmInst = renderVannaDistChart(el, strikes, spot, {
      mode:  'combined',
      vixDir: 'neutral',
      dte:    30,
      label:  '합산 만기 EM · Vanna 기반',
    });
  }
}

// ── 전체 히트맵 섹션 진입점 ──────────────────────────────
function _stRenderHeatmapSection(expirations, spot, symbol) {
  if (!Object.keys(expirations).length) {
    const panel = document.getElementById('st-expiry-panel');
    if (panel) panel.innerHTML = '<div style="padding:12px;color:var(--text3);font-size:12px">Strike 데이터 없음 (스크리너 실행 후 조회하세요)</div>';
    return;
  }

  // 심볼 변경 시 EM 인스턴스 초기화
  if (_stLastSymbol !== symbol) {
    _stEmInst?.detach?.();
    _stEmInst = null;
    _stExpiryConfig = {};
    _stLastSymbol = symbol;
  }

  _stInitExpiryConfig(expirations);
  _stRenderExpiryPanel();

  const weighted = _stBuildWeighted(expirations);
  _stRenderHeatmap(expirations, weighted, spot);
  _stRenderEM(weighted, spot);

  // 버튼 이벤트 (최초 1회만)
  const applyBtn = document.getElementById('st-apply-btn');
  const allBtn   = document.getElementById('st-all-btn');
  const noneBtn  = document.getElementById('st-none-btn');

  if (applyBtn && !applyBtn._bound) {
    applyBtn._bound = true;
    applyBtn.addEventListener('click', () => {
      const w2 = _stBuildWeighted(expirations);
      _stRenderHeatmap(expirations, w2, spot);
      _stRenderEM(w2, spot);
    });
  }
  if (allBtn && !allBtn._bound) {
    allBtn._bound = true;
    allBtn.addEventListener('click', () => {
      Object.keys(_stExpiryConfig).forEach(e => { _stExpiryConfig[e].enabled = true; });
      _stRenderExpiryPanel();
    });
  }
  if (noneBtn && !noneBtn._bound) {
    noneBtn._bound = true;
    noneBtn.addEventListener('click', () => {
      Object.keys(_stExpiryConfig).forEach(e => { _stExpiryConfig[e].enabled = false; });
      _stRenderExpiryPanel();
    });
  }
}

// ══════════════════════════════════════════════════════════
// LW 캔들 차트 (EM 차트 아래, Term Structure 위)
// ══════════════════════════════════════════════════════════
async function _stLoadAndRenderLWChart(symbol, res) {
  const empty  = document.getElementById('struct-chart-empty');
  const lwWrap = document.getElementById('struct-lw-wrap');
  const volWrap = document.getElementById('struct-vol-wrap');
  if (!lwWrap) return;

  if (empty) { empty.style.display = 'flex'; empty.textContent = `${symbol} 차트 로딩 중...`; }
  lwWrap.style.display  = 'none';
  volWrap.style.display = 'none';

  try {
    const url  = `${RAILWAY_URL}/api/chart?symbol=${encodeURIComponent(symbol)}&resolution=${res}`;
    const r    = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (!data.candles?.length) throw new Error('데이터 없음');

    if (empty) empty.style.display = 'none';
    lwWrap.style.display  = 'block';
    volWrap.style.display = 'block';

    _stRenderLWChart(data, lwWrap, volWrap);
  } catch (e) {
    if (empty) { empty.style.display = 'flex'; empty.textContent = `차트 로드 실패: ${e.message}`; }
  }
}

function _stRenderLWChart(data, lwWrap, volWrap) {
  const UP   = '#26a69a';
  const DOWN = '#ef5350';
  const BB2  = '#2196f3';
  const BB1  = 'rgba(66,165,245,0.45)';
  const BBMID = '#f5a623';

  const _hex2rgba = (hex, a) => {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${a})`;
  };

  if (!_stLwChart) {
    // 메인 캔들 차트
    _stLwChart = LightweightCharts.createChart(lwWrap, {
      width:  lwWrap.clientWidth,
      height: 420,
      layout:   { background:{ color:'#131722' }, textColor:'#b2b5be' },
      grid:     { vertLines:{ color:'#1e222d' }, horzLines:{ color:'#1e222d' } },
      crosshair:{ mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor:'#2a2e39', autoScale:true },
      timeScale: { borderColor:'#2a2e39', timeVisible:true, secondsVisible:false, timezone: 'Asia/Seoul' },
    });

    _stLwCandle = _stLwChart.addCandlestickSeries({
      upColor:UP, downColor:DOWN,
      borderUpColor:UP, borderDownColor:DOWN,
      wickUpColor:UP, wickDownColor:DOWN,
    });

    const bbLine = (color, lw, opts={}) => _stLwChart.addLineSeries({
      color, lineWidth:lw,
      priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false,
      ...opts,
    });
    _stLwBB.upper2 = bbLine(BB2, 1);
    _stLwBB.lower2 = bbLine(BB2, 1);
    _stLwBB.upper1 = bbLine(BB1, 1, { lineStyle: 1 });
    _stLwBB.lower1 = bbLine(BB1, 1, { lineStyle: 1 });
    _stLwBB.mid    = bbLine(BBMID, 1.5);

    // 거래량 차트
    _stLwVolChart = LightweightCharts.createChart(volWrap, {
      width:  volWrap.clientWidth || lwWrap.clientWidth,
      height: 100,
      layout:   { background:{ color:'#131722' }, textColor:'#6b7280' },
      grid:     { vertLines:{ color:'#1e222d' }, horzLines:{ color:'#1e222d' } },
      rightPriceScale: { borderColor:'#2a2e39', scaleMargins:{ top:0.1, bottom:0.02 }, autoScale:true },
      timeScale: { borderColor:'#2a2e39', timeVisible:true, secondsVisible:false, visible:false },
      handleScroll: false, handleScale: false,
    });

    _stLwVolSeries = _stLwVolChart.addHistogramSeries({
      priceFormat: { type:'volume' }, priceScaleId:'right',
    });

    // 두 차트 타임스케일 동기화
    let _sync = false;
    _stLwChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (_sync || !range || !_stLwVolChart) return;
      _sync = true; _stLwVolChart.timeScale().setVisibleLogicalRange(range); _sync = false;
    });
    _stLwVolChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (_sync || !range || !_stLwChart) return;
      _sync = true; _stLwChart.timeScale().setVisibleLogicalRange(range); _sync = false;
    });

    // 리사이즈
    new ResizeObserver(() => {
      if (_stLwChart  && lwWrap.clientWidth > 0)  _stLwChart.applyOptions({ width: lwWrap.clientWidth });
      if (_stLwVolChart && volWrap.clientWidth > 0) _stLwVolChart.applyOptions({ width: volWrap.clientWidth });
    }).observe(lwWrap);

  } else {
    _stLwChart.applyOptions({ width: lwWrap.clientWidth });
  }

  const candles = data.candles;
  _stLwCandle.setData(candles.map(c => ({ time:c.time, open:c.open, high:c.high, low:c.low, close:c.close })));
  _stLwVolSeries.setData(candles.map(c => ({
    time:c.time, value:c.volume||0,
    color: c.close >= c.open ? _hex2rgba(UP, 0.4) : _hex2rgba(DOWN, 0.4),
  })));

  const bbF = key => candles.filter(c => c[key] != null).map(c => ({ time:c.time, value:c[key] }));
  _stLwBB.upper2.setData(bbF('bbUpper2'));
  _stLwBB.lower2.setData(bbF('bbLower2'));
  _stLwBB.upper1.setData(bbF('bbUpper1'));
  _stLwBB.lower1.setData(bbF('bbLower1'));
  _stLwBB.mid.setData(bbF('bbMid'));

  _stLwChart.timeScale().fitContent();
  setTimeout(() => {
    const range = _stLwChart.timeScale().getVisibleLogicalRange();
    if (_stLwVolChart && range) _stLwVolChart.timeScale().setVisibleLogicalRange(range);
  }, 50);
}
