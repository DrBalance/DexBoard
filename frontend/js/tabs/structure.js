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

    <!-- 섹션 1: 만기 구조 카드 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">◉</span> 만기 구조
        <span class="panel-sub">Monthly 2개 + 이상 베팅 Weekly</span>
      </div>
      <div id="struct-expiry-cards"></div>
    </div>

    <!-- 섹션 2: 타이밍 컨텍스트 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">⏱</span> 타이밍 컨텍스트
        <span class="panel-sub">OPEX 사이클 · Vanna/Charm 방향</span>
      </div>
      <div id="struct-timing"></div>
    </div>

    <!-- 섹션 3: 메카닉 판단 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">▤</span> 딜러 메카닉 판단
      </div>
      <div id="struct-mechanic"></div>
    </div>

    <!-- 섹션 4: Term Structure 곡선 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">〜</span> Term Structure
        <span class="panel-sub">만기별 ATM IV 곡선 · 콘탱고/백워데이션</span>
      </div>
      <div id="struct-term"></div>
    </div>

    <!-- 섹션 5: IV Skew 차트 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">◐</span> IV Skew
        <span class="panel-sub">만기별 Put/Call IV 비대칭 · 공포/탐욕 농도</span>
      </div>
      <div id="struct-skew"></div>
    </div>

    <!-- 섹션 6: Expected Move -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">◎</span> Expected Move
        <span class="panel-sub">만기별 기대 움직임 범위</span>
      </div>
      <div id="struct-em"></div>
    </div>

    <!-- 섹션 7: DEX 히트맵 -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">▦</span> 만기별 DEX 히트맵
        <span class="panel-sub">딜러 헤징 압력 분포</span>
      </div>
      <div id="struct-heatmap"></div>
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

  // 섹션 1: 만기 구조 카드
  renderExpiryCards(monthly, weekly, scoreRow);

  // 섹션 2: 타이밍 컨텍스트
  renderTimingContext(context, scoreRow);

  // 섹션 3: 메카닉 판단 요약
  renderMechanicSummary(scoreRow, context, monthly);

  // 섹션 4~7: Term Structure / Skew / Expected Move / DEX 히트맵
  loadAndRenderCharts(symbol, scoreRow);
}

// ── 만기 필터 (제거됨 — 새 구조에서는 백엔드가 분류)
function filterByExpiry(rows) { return rows; }

// ============================================
// 섹션 1 — 만기 구조 카드
// ============================================
function renderExpiryCards(monthly, weekly, scoreRow) {
  const el = document.getElementById('struct-expiry-cards');
  if (!el) return;

  const spot = scoreRow?.close ?? null;
  const rows = [...monthly];
  if (weekly) rows.push({ ...weekly, _isFeaturedWeekly: true });

  if (!rows.length) {
    el.innerHTML = '<div class="no-data" style="padding:16px;color:var(--text3)">만기 데이터 없음</div>';
    return;
  }

  el.innerHTML = rows.map(r => {
    const isWeekly  = r._isFeaturedWeekly;
    const netOI     = (r.call_oi || 0) - (r.put_oi || 0);
    const netDir    = netOI > 0 ? 'CALL' : netOI < 0 ? 'PUT' : '중립';
    const netColor  = netOI > 0 ? '#22c55e' : netOI < 0 ? '#ef4444' : '#6e7681';

    const flip      = r.flip_strike ?? null;
    const aboveFlip = spot && flip ? spot > flip : null;
    const flipColor = aboveFlip === true ? '#22c55e' : aboveFlip === false ? '#ef4444' : '#6e7681';
    const flipLabel = aboveFlip === true ? '위 ▲ 롱감마' : aboveFlip === false ? '아래 ▼ 숏감마' : '—';

    const skew      = r.iv_skew ?? null;
    const skewColor = skew > 0 ? '#22c55e' : skew < 0 ? '#ef4444' : '#6e7681';
    const skewLabel = skew > 0 ? '콜 프리미엄 ▲' : skew < 0 ? '풋 프리미엄 ▼' : '중립';

    const vanna     = r.vanna ?? 0;
    const charm     = r.charm ?? 0;
    const vannaDir  = vanna > 0 ? '▲' : vanna < 0 ? '▼' : '—';
    const charmDir  = charm > 0 ? '▲' : charm < 0 ? '▼' : '—';
    const vannaColor= vanna > 0 ? '#22c55e' : vanna < 0 ? '#ef4444' : '#6e7681';
    const charmColor= charm > 0 ? '#22c55e' : charm < 0 ? '#ef4444' : '#6e7681';

    const tag = isWeekly
      ? `<span style="background:#f59e0b22;color:#f59e0b;border:1px solid #f59e0b44;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700">⚡ WEEKLY 이상 베팅</span>`
      : `<span style="background:#3b82f622;color:#3b82f6;border:1px solid #3b82f644;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700">MONTHLY</span>`;

    return `
      <div style="
        background:var(--bg2);border:1px solid var(--border);border-radius:8px;
        padding:14px 16px;margin-bottom:10px;
      ">
        <!-- 헤더 -->
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          ${tag}
          <span style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--text)">
            ${r.expiry_date ?? '—'}
          </span>
          <span style="font-size:12px;color:var(--text3)">D-${r.dte ?? '?'}</span>
        </div>

        <!-- 데이터 그리드 -->
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">

          <!-- Net OI -->
          <div style="background:var(--bg3);border-radius:6px;padding:10px">
            <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Net OI 방향</div>
            <div style="font-size:16px;font-weight:800;color:${netColor}">${netDir}</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px">
              C ${fmtK(r.call_oi)} / P ${fmtK(r.put_oi)}
            </div>
          </div>

          <!-- 플립존 -->
          <div style="background:var(--bg3);border-radius:6px;padding:10px">
            <div style="font-size:10px;color:var(--text3);margin-bottom:4px">플립존</div>
            <div style="font-size:16px;font-weight:800;font-family:var(--mono);color:${flipColor}">
              ${flip ? '$' + flip.toFixed(0) : '—'}
            </div>
            <div style="font-size:11px;color:${flipColor};margin-top:2px">${flipLabel}</div>
          </div>

          <!-- IV 스큐 -->
          <div style="background:var(--bg3);border-radius:6px;padding:10px">
            <div style="font-size:10px;color:var(--text3);margin-bottom:4px">IV 스큐</div>
            <div style="font-size:16px;font-weight:800;color:${skewColor}">
              ${skew != null ? (skew > 0 ? '+' : '') + (skew * 100).toFixed(1) + '%' : '—'}
            </div>
            <div style="font-size:11px;color:${skewColor};margin-top:2px">${skewLabel}</div>
          </div>

          <!-- Vanna -->
          <div style="background:var(--bg3);border-radius:6px;padding:10px">
            <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Vanna</div>
            <div style="font-size:15px;font-weight:700;font-family:var(--mono);color:${vannaColor}">
              ${vannaDir} ${Math.abs(vanna).toFixed(3)}
            </div>
            <div style="font-size:10px;color:var(--text3);margin-top:2px">
              VIX↓ → 딜러 ${vanna > 0 ? '매수' : '매도'} 헤징
            </div>
          </div>

          <!-- Charm -->
          <div style="background:var(--bg3);border-radius:6px;padding:10px">
            <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Charm</div>
            <div style="font-size:15px;font-weight:700;font-family:var(--mono);color:${charmColor}">
              ${charmDir} ${Math.abs(charm).toFixed(3)}
            </div>
            <div style="font-size:10px;color:var(--text3);margin-top:2px">
              만기 수렴 → 딜러 ${charm > 0 ? '매수' : '매도'} 압력
            </div>
          </div>

          <!-- ATM IV -->
          <div style="background:var(--bg3);border-radius:6px;padding:10px">
            <div style="font-size:10px;color:var(--text3);margin-bottom:4px">ATM IV</div>
            <div style="font-size:15px;font-weight:700;font-family:var(--mono);color:var(--text)">
              ${r.atm_iv != null ? (r.atm_iv * 100).toFixed(1) + '%' : '—'}
            </div>
            <div style="font-size:10px;color:var(--text3);margin-top:2px">
              C ${r.otm_call_iv != null ? (r.otm_call_iv*100).toFixed(1)+'%' : '—'}
              / P ${r.otm_put_iv != null ? (r.otm_put_iv*100).toFixed(1)+'%' : '—'}
            </div>
          </div>

        </div>
      </div>
    `;
  }).join('');
}

// ============================================
// 섹션 2 — 타이밍 컨텍스트
// ============================================
function renderTimingContext(context, scoreRow) {
  const el = document.getElementById('struct-timing');
  if (!el || !context) {
    if (el) el.innerHTML = '<div class="no-data" style="padding:16px;color:var(--text3)">컨텍스트 데이터 없음</div>';
    return;
  }

  const opexDte   = context.opex_dte ?? null;
  const weekDte   = context.this_week_dte ?? null;
  const weekExp   = context.this_week_expiry ?? null;
  const vannaSum  = context.vanna_sum ?? 0;
  const charmSum  = context.charm_sum ?? 0;
  const aligned   = context.skew_aligned;
  const featured  = context.weekly_featured;

  // OPEX 긴박도 색상
  const opexColor = opexDte != null
    ? (opexDte <= 7 ? '#ef4444' : opexDte <= 14 ? '#f59e0b' : '#22c55e')
    : '#6e7681';

  // 이번 주 위클리 Charm 피크 여부
  const charmPeak = weekDte != null && weekDte <= 2;

  // Vanna + Charm 방향 일치 여부
  const vannaDir = vannaSum > 0 ? 1 : vannaSum < 0 ? -1 : 0;
  const charmDir = charmSum > 0 ? 1 : charmSum < 0 ? -1 : 0;
  const loopActive = vannaDir !== 0 && vannaDir === charmDir;

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:12px">

      <!-- OPEX D-day -->
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:14px">
        <div style="font-size:11px;color:var(--text3);margin-bottom:6px">다음 OPEX</div>
        <div style="font-size:28px;font-weight:800;font-family:var(--mono);color:${opexColor}">
          D-${opexDte ?? '?'}
        </div>
        <div style="font-size:11px;color:${opexColor};margin-top:4px">
          ${opexDte != null
            ? (opexDte <= 7 ? '⚡ Vanna flow 최대 수렴 구간' : opexDte <= 14 ? '◎ Vanna flow 강화 중' : '○ OPEX 준비 구간')
            : '—'}
        </div>
      </div>

      <!-- 이번 주 위클리 -->
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:14px">
        <div style="font-size:11px;color:var(--text3);margin-bottom:6px">이번 주 위클리 만기</div>
        <div style="font-size:20px;font-weight:800;font-family:var(--mono);color:${charmPeak ? '#ef4444' : 'var(--text)'}">
          ${weekExp ? weekExp.slice(5) : '없음'}
          ${weekDte != null ? `<span style="font-size:14px;color:var(--text3)"> D-${weekDte}</span>` : ''}
        </div>
        <div style="font-size:11px;margin-top:4px;color:${charmPeak ? '#ef4444' : 'var(--text3)'}">
          ${charmPeak ? '⚡ Charm 압력 피크 — 자기강화 루프 경계' : weekDte != null ? 'Charm 작동 중' : '이번 주 위클리 없음'}
        </div>
      </div>

      <!-- Monthly IV 스큐 일치 -->
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:14px">
        <div style="font-size:11px;color:var(--text3);margin-bottom:6px">Monthly IV스큐 일치</div>
        <div style="font-size:22px;font-weight:800;color:${aligned ? '#22c55e' : '#6e7681'}">
          ${aligned ? '✓ 일치' : '✗ 불일치'}
        </div>
        <div style="font-size:11px;color:var(--text3);margin-top:4px">
          기관 방향성 베팅 ${aligned ? '확인' : '미확인'}
        </div>
      </div>

      <!-- Weekly 이상 베팅 -->
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:14px">
        <div style="font-size:11px;color:var(--text3);margin-bottom:6px">Weekly 이상 베팅</div>
        <div style="font-size:22px;font-weight:800;color:${featured ? '#f59e0b' : '#6e7681'}">
          ${featured ? '⚡ 감지' : '없음'}
        </div>
        <div style="font-size:11px;color:var(--text3);margin-top:4px">
          ${featured ? 'Charm 자기강화 연료 존재' : '평균 수준 OI'}
        </div>
      </div>

    </div>

    <!-- Vanna/Charm 복합 방향 -->
    <div style="background:var(--bg2);border:1px solid ${loopActive ? '#f59e0b44' : 'var(--border)'};border-radius:8px;padding:14px">
      <div style="font-size:11px;color:var(--text3);margin-bottom:8px">Vanna + Charm 복합 방향 (Monthly 합산)</div>
      <div style="display:flex;gap:20px;align-items:center">
        <div>
          <span style="font-size:11px;color:var(--text3)">Vanna </span>
          <span style="font-size:15px;font-weight:700;font-family:var(--mono);color:${vannaSum > 0 ? '#22c55e' : vannaSum < 0 ? '#ef4444' : '#6e7681'}">
            ${vannaSum > 0 ? '▲' : vannaSum < 0 ? '▼' : '—'} ${Math.abs(vannaSum).toFixed(3)}
          </span>
        </div>
        <div style="color:var(--text3)">+</div>
        <div>
          <span style="font-size:11px;color:var(--text3)">Charm </span>
          <span style="font-size:15px;font-weight:700;font-family:var(--mono);color:${charmSum > 0 ? '#22c55e' : charmSum < 0 ? '#ef4444' : '#6e7681'}">
            ${charmSum > 0 ? '▲' : charmSum < 0 ? '▼' : '—'} ${Math.abs(charmSum).toFixed(3)}
          </span>
        </div>
        <div style="margin-left:auto;font-size:13px;font-weight:700;color:${loopActive ? '#f59e0b' : '#6e7681'}">
          ${loopActive ? '⚡ 자기강화 루프 조건 충족' : '방향 불일치 — 루프 없음'}
        </div>
      </div>
    </div>
  `;
}

// ============================================
// 섹션 3 — 딜러 메카닉 판단
// ============================================
function renderMechanicSummary(scoreRow, context, monthly) {
  const el = document.getElementById('struct-mechanic');
  if (!el) return;

  const strength  = scoreRow?.strength_score ?? 0;
  const grade     = scoreRow?.timing_grade   ?? 'C';
  const flip      = scoreRow?.flip_strike    ?? null;
  const spot      = scoreRow?.close          ?? null;
  const ivSkew    = scoreRow?.iv_skew        ?? null;

  const dir       = strength > 0 ? '콜 방향 ▲' : strength < 0 ? '풋 방향 ▼' : '중립';
  const dirColor  = strength > 0 ? '#22c55e'   : strength < 0 ? '#ef4444'   : '#6e7681';

  const gradeColor = grade === 'A' ? '#f59e0b' : grade === 'B' ? '#3b82f6' : '#6e7681';
  const gradeDesc  = {
    'A': '즉시 진입 — Monthly 2개 + Weekly 방향 일치',
    'B': '준비 단계 — Monthly 2개 방향 일치',
    'C': '관찰 — 타이밍 신호 없음',
  };

  const aboveFlip = spot && flip ? spot > flip : null;

  // 종합 메카닉 상태 판단
  const vannaSum  = context?.vanna_sum ?? 0;
  const charmSum  = context?.charm_sum ?? 0;
  const loopActive = (vannaSum > 0 && charmSum > 0) || (vannaSum < 0 && charmSum < 0);
  const opexDte   = context?.opex_dte ?? null;
  const featured  = context?.weekly_featured ?? false;

  // 컨디션 체크리스트
  const checks = [
    {
      label: '딜러 롱감마 (플립존 위)',
      ok: aboveFlip === true,
      desc: aboveFlip === true ? `현재가 $${spot?.toFixed(0)} > 플립존 $${flip?.toFixed(0)}` : flip ? `현재가 $${spot?.toFixed(0)} < 플립존 $${flip?.toFixed(0)}` : '플립존 없음',
    },
    {
      label: 'Vanna + Charm 동방향',
      ok: loopActive,
      desc: loopActive ? '자기강화 루프 작동 가능' : '두 힘이 상충 — 루프 없음',
    },
    {
      label: 'Monthly IV스큐 일치',
      ok: context?.skew_aligned ?? false,
      desc: context?.skew_aligned ? '기관 방향성 베팅 확인' : '방향성 미확인',
    },
    {
      label: 'OPEX 2주 이내',
      ok: opexDte != null && opexDte <= 14,
      desc: opexDte != null ? `D-${opexDte}` : '—',
    },
    {
      label: 'Weekly 이상 베팅',
      ok: featured,
      desc: featured ? 'Charm 연료 확인' : '평균 수준',
    },
  ];

  const passCount = checks.filter(c => c.ok).length;
  const totalCount = checks.length;
  const overallColor = passCount >= 4 ? '#22c55e' : passCount >= 3 ? '#f59e0b' : '#ef4444';

  el.innerHTML = `
    <!-- 강도 + 타이밍 -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:14px">
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px">강도 점수</div>
        <div style="font-size:36px;font-weight:800;font-family:var(--mono);color:${dirColor}">
          ${strength > 0 ? '+' : ''}${strength}
        </div>
        <div style="font-size:12px;color:${dirColor};margin-top:2px">${dir}</div>
        <div style="margin-top:8px;height:5px;background:var(--bg3);border-radius:3px;overflow:hidden">
          <div style="width:${(Math.abs(strength)/3)*100}%;height:100%;background:${dirColor};border-radius:3px"></div>
        </div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:14px">
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px">타이밍 등급</div>
        <div style="font-size:36px;font-weight:800;color:${gradeColor}">${grade}</div>
        <div style="font-size:11px;color:${gradeColor};margin-top:2px">${gradeDesc[grade] ?? ''}</div>
      </div>
    </div>

    <!-- 컨디션 체크리스트 -->
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <span style="font-size:12px;font-weight:700;color:var(--text2)">메카닉 조건 체크</span>
        <span style="font-size:13px;font-weight:800;color:${overallColor}">${passCount}/${totalCount} 충족</span>
      </div>
      ${checks.map(c => `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
          <div style="font-size:16px;color:${c.ok ? '#22c55e' : '#ef4444'};flex-shrink:0;margin-top:1px">
            ${c.ok ? '✓' : '✗'}
          </div>
          <div style="flex:1">
            <div style="font-size:12px;font-weight:600;color:${c.ok ? 'var(--text)' : 'var(--text3)'}">${c.label}</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px">${c.desc}</div>
          </div>
        </div>
      `).join('')}
    </div>
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

// ============================================
// 공통 분석 함수 (SPY/개별종목 공용)
// ============================================

// ── 선형 회귀 기울기 계산 (x=DTE, y=ATM IV)
function linearRegressionSlope(rows) {
  const n  = rows.length;
  if (n < 2) return 0;
  const xMean = rows.reduce((s, r) => s + r.dte, 0) / n;
  const yMean = rows.reduce((s, r) => s + r.atm_iv, 0) / n;
  const num   = rows.reduce((s, r) => s + (r.dte - xMean) * (r.atm_iv - yMean), 0);
  const den   = rows.reduce((s, r) => s + (r.dte - xMean) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

// ── 이벤트 만기 감지 (주변 만기 대비 IV가 튀는 구간)
function detectEventExpiries(rows) {
  if (rows.length < 3) return new Set();
  const eventSet = new Set();
  for (let i = 1; i < rows.length - 1; i++) {
    const prev = rows[i - 1].atm_iv;
    const curr = rows[i].atm_iv;
    const next = rows[i + 1].atm_iv;
    const localAvg = (prev + next) / 2;
    // 주변 평균 대비 15% 이상 튀면 이벤트 만기
    if (curr > localAvg * 1.15) {
      eventSet.add(rows[i].expiry_date);
    }
  }
  return eventSet;
}

// Term Structure: 만기별 ATM IV → 콘탱고/백워데이션 판단
// prevRows: 전일 데이터 (있으면 slope 변화 계산)
export function calculateTermStructure(expiryRows, prevRows = null) {
  const sorted = [...expiryRows]
    .filter(r => r.atm_iv != null && r.dte != null)
    .sort((a, b) => a.dte - b.dte);
  if (sorted.length < 2) return { status: 'unknown', slope: null, rows: sorted };

  // 이벤트 만기 감지
  const eventExpiries = detectEventExpiries(sorted);

  // 이벤트 만기 제외 후 선형 회귀 기울기 계산
  const cleanRows = sorted.filter(r => !eventExpiries.has(r.expiry_date));
  const regSlope  = linearRegressionSlope(cleanRows.length >= 2 ? cleanRows : sorted);

  // 기울기 해석: 양수=우상향=콘탱고, 음수=우하향=백워데이션
  // regSlope 단위: IV/DTE (매우 작은 값)
  let status, label, color;
  if (regSlope > 0.0003) {
    status = 'contango';      label = '콘탱고 ✓';      color = '#22c55e';
  } else if (regSlope < -0.0003) {
    status = 'backwardation'; label = '백워데이션 ⚠️'; color = '#ef4444';
  } else {
    status = 'flat';          label = '플랫 — 변곡점'; color = '#f59e0b';
  }

  // 전일 slope 비교 → 변화 방향
  let slopeChange = null;
  let slopeTrend  = null;
  let priceComment = null;

  if (prevRows && prevRows.length >= 2) {
    const prevSorted = [...prevRows]
      .filter(r => r.atm_iv != null && r.dte != null)
      .sort((a, b) => a.dte - b.dte);
    const prevEventExpiries = detectEventExpiries(prevSorted);
    const prevClean = prevSorted.filter(r => !prevEventExpiries.has(r.expiry_date));
    const prevSlope = linearRegressionSlope(prevClean.length >= 2 ? prevClean : prevSorted);

    slopeChange = regSlope - prevSlope;

    // 변화 방향 판단
    if (status === 'backwardation') {
      if (slopeChange < -0.0001) {
        slopeTrend   = '심화 중 ↓';
        priceComment = { text: '하락 추세 지속', color: '#ef4444', icon: '🔴' };
      } else if (slopeChange > 0.0001) {
        slopeTrend   = '완화 중 ↑';
        priceComment = { text: '반등 가능성 탐색', color: '#f59e0b', icon: '🟡' };
      } else {
        slopeTrend   = '유지';
        priceComment = { text: '하락 추세 지속', color: '#ef4444', icon: '🔴' };
      }
    } else if (status === 'contango') {
      if (slopeChange > 0.0001) {
        slopeTrend   = '강화 중 ↑';
        priceComment = { text: '상승 추세 지속', color: '#22c55e', icon: '🟢' };
      } else if (slopeChange < -0.0001) {
        slopeTrend   = '약화 중 ↓';
        priceComment = { text: '추세 약화 주의', color: '#f97316', icon: '🟠' };
      } else {
        slopeTrend   = '유지';
        priceComment = { text: '상승 추세 지속', color: '#22c55e', icon: '🟢' };
      }
    } else {
      // flat
      if (slopeChange > 0.0001) {
        slopeTrend   = '콘탱고 전환 중 ↑';
        priceComment = { text: '반등 시작 신호', color: '#22c55e', icon: '🟢' };
      } else if (slopeChange < -0.0001) {
        slopeTrend   = '백워데이션 전환 중 ↓';
        priceComment = { text: '반전 하락 주의', color: '#ef4444', icon: '🔴' };
      } else {
        slopeTrend   = '방향 탐색 중';
        priceComment = { text: '방향 불확실', color: '#f59e0b', icon: '🟡' };
      }
    }
  }

  return {
    status, label, color,
    slope: regSlope,
    slopeChange, slopeTrend, priceComment,
    eventExpiries,
    rows: sorted,
  };
}

// IV Skew: 만기별 Put/Call IV 비대칭 측정
export function calculateSkew(expiryRows) {
  return expiryRows
    .filter(r => r.atm_iv != null && r.otm_call_iv != null && r.otm_put_iv != null)
    .sort((a, b) => a.dte - b.dte)
    .map(r => ({
      expiry_date: r.expiry_date,
      dte:         r.dte,
      atm_iv:      r.atm_iv,
      call_iv:     r.otm_call_iv,
      put_iv:      r.otm_put_iv,
      skew:        r.otm_put_iv - r.otm_call_iv,  // 양수 = Put 프리미엄 (하방 공포)
      iv_skew:     r.iv_skew,
    }));
}

// Expected Move: ATM IV × 현재가 × √(DTE/365)
export function calculateExpectedMove(expiryRows, spot) {
  if (!spot) return [];
  return expiryRows
    .filter(r => r.atm_iv != null && r.dte != null && r.dte > 0)
    .sort((a, b) => a.dte - b.dte)
    .map(r => {
      const em     = spot * r.atm_iv * Math.sqrt(r.dte / 365);
      const upper  = spot + em;
      const lower  = spot - em;
      // Skew 보정: Put IV가 높으면 하방 편향
      const skewBias = (r.otm_put_iv != null && r.otm_call_iv != null)
        ? (r.otm_put_iv - r.otm_call_iv) * spot * Math.sqrt(r.dte / 365) * 0.5
        : 0;
      return {
        expiry_date:   r.expiry_date,
        dte:           r.dte,
        em:            +em.toFixed(2),
        upper:         +(upper - skewBias * 0.3).toFixed(2),
        lower:         +(lower - skewBias).toFixed(2),
        em_pct:        +((em / spot) * 100).toFixed(2),
        atm_iv:        r.atm_iv,
      };
    });
}

// 종합 상태 판단 (🟢🟡🟠🔴)
export function evaluateStatus({ termStructure, skewRows, spot, flipStrike, vannaSum }) {
  let score = 0;
  const reasons = [];

  // 1. Flip Zone 위
  if (flipStrike && spot > flipStrike) {
    score += 2; reasons.push('플립존 위');
  }

  // 2. Term Structure 콘탱고
  if (termStructure?.status === 'contango') {
    score += 2; reasons.push('콘탱고');
  } else if (termStructure?.status === 'backwardation') {
    score -= 1; reasons.push('백워데이션');
  }

  // 3. Skew 완화 (Put 프리미엄 낮음)
  const avgSkew = skewRows.length
    ? skewRows.reduce((s, r) => s + r.skew, 0) / skewRows.length
    : null;
  if (avgSkew != null && avgSkew < 0.02) {
    score += 1; reasons.push('Skew 완화');
  } else if (avgSkew != null && avgSkew > 0.05) {
    score -= 1; reasons.push('Skew 과열');
  }

  // 4. Vanna 양수
  if (vannaSum > 0) {
    score += 1; reasons.push('Vanna 양수');
  }

  let status, label, color;
  if (score >= 4)      { status = 'entry';   label = '🟢 진입 후보';    color = '#22c55e'; }
  else if (score >= 2) { status = 'hold';    label = '🟡 상승세 지속';  color = '#f59e0b'; }
  else if (score >= 0) { status = 'caution'; label = '🟠 청산 근접';    color = '#f97316'; }
  else                 { status = 'avoid';   label = '🔴 관망';          color = '#ef4444'; }

  return { status, label, color, score, reasons };
}

// ============================================
// D1에서 options_dex 데이터 로드 → 차트 렌더링
// ============================================
async function loadAndRenderCharts(symbol, scoreRow) {
  // 로딩 표시
  ['struct-term', 'struct-skew', 'struct-em', 'struct-heatmap'].forEach(id => {
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
      ['struct-term', 'struct-skew', 'struct-em', 'struct-heatmap'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = `<div style="padding:16px;color:var(--text3);font-size:12px">데이터 없음</div>`;
      });
      return;
    }

    const spot = scoreRow?.close ?? null;

    // 공통 계산
    const termData   = calculateTermStructure(rows, prevRows);
    const skewData   = calculateSkew(rows);
    const emData     = calculateExpectedMove(rows, spot);
    const vannaSum   = rows.reduce((s, r) => s + (r.vanna ?? 0), 0);
    const flipStrike = scoreRow?.flip_strike ?? null;
    const statusResult = evaluateStatus({ termStructure: termData, skewRows: skewData, spot, flipStrike, vannaSum });

    // 상태 뱃지를 헤더에 업데이트
    const strip = document.getElementById('struct-score-strip');
    if (strip) {
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
    renderTermStructure(termData);
    renderSkewChart(skewData);
    renderExpectedMove(emData, spot);
    renderDexHeatmap(rows);

  } catch (err) {
    console.error('[structure] chart load error:', err);
    ['struct-term', 'struct-skew', 'struct-em', 'struct-heatmap'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<div style="padding:16px;color:#ef4444;font-size:12px">로드 실패: ${err.message}</div>`;
    });
  }
}

// ============================================
// 섹션 4 — Term Structure SVG 차트
// ============================================
function renderTermStructure(termData) {
  const el = document.getElementById('struct-term');
  if (!el) return;

  const { status, label, color, slope, slopeChange, slopeTrend, priceComment, eventExpiries, rows } = termData;

  if (!rows.length) {
    el.innerHTML = '<div style="padding:16px;color:var(--text3)">데이터 없음</div>';
    return;
  }

  const W = 520, H = 180, PL = 48, PR = 16, PT = 16, PB = 36;
  const cW = W - PL - PR, cH = H - PT - PB;

  const ivs  = rows.map(r => r.atm_iv);
  const dtes = rows.map(r => r.dte);
  const minIV  = Math.min(...ivs) * 0.88;
  const maxIV  = Math.max(...ivs) * 1.08;
  const minDTE = Math.min(...dtes);
  const maxDTE = Math.max(...dtes);

  const xScale = dte => PL + ((dte - minDTE) / (maxDTE - minDTE || 1)) * cW;
  const yScale = iv  => PT + (1 - (iv - minIV) / (maxIV - minIV || 1)) * cH;

  const pts = rows.map(r => `${xScale(r.dte).toFixed(1)},${yScale(r.atm_iv).toFixed(1)}`).join(' ');

  const step = Math.ceil(rows.length / 6);
  const xLabels = rows.filter((_, i) => i % step === 0).map(r => `
    <text x="${xScale(r.dte).toFixed(1)}" y="${H - 4}"
      text-anchor="middle" font-size="9" fill="var(--text3)">${r.dte}d</text>
  `).join('');

  const yTicks = [minIV, (minIV + maxIV) / 2, maxIV].map(iv => `
    <text x="${PL - 4}" y="${(yScale(iv) + 4).toFixed(1)}"
      text-anchor="end" font-size="9" fill="var(--text3)">${(iv * 100).toFixed(0)}%</text>
    <line x1="${PL}" y1="${yScale(iv).toFixed(1)}" x2="${W - PR}" y2="${yScale(iv).toFixed(1)}"
      stroke="var(--border)" stroke-width="0.5" stroke-dasharray="3,3"/>
  `).join('');

  // 이벤트 만기 강조 + 일반 포인트
  const circles = rows.map(r => {
    const isEvent = eventExpiries?.has(r.expiry_date);
    return isEvent
      ? `<circle cx="${xScale(r.dte).toFixed(1)}" cy="${yScale(r.atm_iv).toFixed(1)}"
           r="5" fill="#f59e0b" stroke="#fff" stroke-width="1" opacity="0.9">
           <title>⚡ 이벤트 리스크: ${r.expiry_date} (D-${r.dte}) IV ${(r.atm_iv*100).toFixed(1)}%</title>
         </circle>
         <text x="${xScale(r.dte).toFixed(1)}" y="${(yScale(r.atm_iv) - 8).toFixed(1)}"
           text-anchor="middle" font-size="8" fill="#f59e0b">⚡</text>`
      : `<circle cx="${xScale(r.dte).toFixed(1)}" cy="${yScale(r.atm_iv).toFixed(1)}"
           r="3" fill="${color}" opacity="0.8">
           <title>${r.expiry_date} (D-${r.dte}): IV ${(r.atm_iv*100).toFixed(1)}%</title>
         </circle>`;
  }).join('');

  // slope 변화 표시
  const trendHtml = slopeTrend ? `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 16px;flex:1;min-width:140px">
      <div style="font-size:10px;color:var(--text3);margin-bottom:4px">전일 대비 변화</div>
      <div style="font-size:13px;font-weight:700;color:var(--text)">${slopeTrend}</div>
      <div style="font-size:10px;color:var(--text3);margin-top:2px">
        기울기 변화: ${slopeChange > 0 ? '+' : ''}${(slopeChange * 10000).toFixed(1)}
      </div>
    </div>
  ` : '';

  // 가격 방향성 코멘트
  const commentHtml = priceComment ? `
    <div style="
      background:${priceComment.color}22;border:1px solid ${priceComment.color}44;
      border-radius:8px;padding:10px 16px;flex:1;min-width:140px
    ">
      <div style="font-size:10px;color:var(--text3);margin-bottom:4px">가격 방향성 전망</div>
      <div style="font-size:15px;font-weight:800;color:${priceComment.color}">
        ${priceComment.icon} ${priceComment.text}
      </div>
      <div style="font-size:10px;color:var(--text3);margin-top:2px">Term Structure 기반</div>
    </div>
  ` : '';

  // 이벤트 만기 목록
  const eventList = eventExpiries?.size > 0
    ? `<div style="margin-top:8px;padding:8px 12px;background:#f59e0b11;border:1px solid #f59e0b33;border-radius:6px;font-size:11px;color:#f59e0b">
        ⚡ 이벤트 리스크 감지: ${[...eventExpiries].join(', ')} — 어닝/FOMC 등 단기 이벤트 가능성
       </div>`
    : '';

  el.innerHTML = `
    <!-- 상태 요약 카드 -->
    <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <div style="background:${color}22;border:1px solid ${color}44;border-radius:8px;padding:10px 16px;flex:1;min-width:140px">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Term Structure</div>
        <div style="font-size:16px;font-weight:800;color:${color}">${label}</div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">
          ${status === 'contango' ? '단기 IV < 장기 IV · 정상 구조' : status === 'backwardation' ? '단기 IV > 장기 IV · 공포 집중' : '단기 ≈ 장기 IV · 방향 탐색'}
        </div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 16px;flex:1;min-width:140px">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">IV 범위</div>
        <div style="font-size:14px;font-weight:700;color:var(--text)">
          ${(Math.min(...ivs)*100).toFixed(1)}% ~ ${(Math.max(...ivs)*100).toFixed(1)}%
        </div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">D-${minDTE} ~ D-${maxDTE} · ${rows.length}개 만기</div>
      </div>
      ${trendHtml}
      ${commentHtml}
    </div>

    ${eventList}

    <!-- SVG 차트 -->
    <div style="overflow-x:auto;margin-top:10px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block">
        ${yTicks}
        <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" opacity="0.9"/>
        <polyline points="${PL},${PT+cH} ${pts} ${xScale(maxDTE).toFixed(1)},${PT+cH}"
          fill="${color}" opacity="0.07"/>
        ${circles}
        ${xLabels}
        <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${PT+cH}" stroke="var(--border)" stroke-width="1"/>
        <line x1="${PL}" y1="${PT+cH}" x2="${W-PR}" y2="${PT+cH}" stroke="var(--border)" stroke-width="1"/>
        <!-- 범례 -->
        <circle cx="${W-PR-70}" cy="${PT+6}" r="3" fill="${color}"/>
        <text x="${W-PR-63}" y="${PT+10}" font-size="9" fill="var(--text3)">ATM IV</text>
        <circle cx="${W-PR-30}" cy="${PT+6}" r="5" fill="#f59e0b" stroke="#fff" stroke-width="1"/>
        <text x="${W-PR-22}" y="${PT+10}" font-size="9" fill="#f59e0b">이벤트</text>
      </svg>
    </div>

    <!-- 만기별 상세 테이블 -->
    <div style="margin-top:12px;overflow-x:auto">
      <table style="width:100%;font-size:11px;border-collapse:collapse">
        <thead>
          <tr style="background:var(--bg3)">
            <th style="text-align:left;padding:5px 8px;color:var(--text3);font-weight:600">만기</th>
            <th style="text-align:right;padding:5px 8px;color:var(--text3);font-weight:600">DTE</th>
            <th style="text-align:right;padding:5px 8px;color:var(--text3);font-weight:600">ATM IV</th>
            <th style="text-align:right;padding:5px 8px;color:#22c55e;font-weight:600">Call IV</th>
            <th style="text-align:right;padding:5px 8px;color:#ef4444;font-weight:600">Put IV</th>
            <th style="text-align:right;padding:5px 8px;color:var(--text3);font-weight:600">Skew</th>
            <th style="text-align:center;padding:5px 8px;color:var(--text3);font-weight:600">비고</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => {
            const skew      = (r.otm_put_iv ?? 0) - (r.otm_call_iv ?? 0);
            const skewColor = skew > 0.03 ? '#ef4444' : skew < -0.01 ? '#22c55e' : 'var(--text3)';
            const rowBg     = i % 2 === 0 ? 'var(--bg2)' : 'var(--bg3)';
            const isEvent   = eventExpiries?.has(r.expiry_date);
            return `
              <tr style="background:${isEvent ? '#f59e0b11' : rowBg}">
                <td style="padding:5px 8px;font-family:var(--mono);color:${isEvent ? '#f59e0b' : 'var(--text)'}">
                  ${r.expiry_date}
                </td>
                <td style="padding:5px 8px;text-align:right;color:var(--text3)">D-${r.dte}</td>
                <td style="padding:5px 8px;text-align:right;font-weight:700;color:${isEvent ? '#f59e0b' : 'var(--text)'}">
                  ${(r.atm_iv * 100).toFixed(1)}%
                </td>
                <td style="padding:5px 8px;text-align:right;color:#22c55e">
                  ${r.otm_call_iv != null ? (r.otm_call_iv*100).toFixed(1)+'%' : '—'}
                </td>
                <td style="padding:5px 8px;text-align:right;color:#ef4444">
                  ${r.otm_put_iv != null ? (r.otm_put_iv*100).toFixed(1)+'%' : '—'}
                </td>
                <td style="padding:5px 8px;text-align:right;color:${skewColor}">
                  ${(skew*100).toFixed(1)}%
                </td>
                <td style="padding:5px 8px;text-align:center;font-size:10px">
                  ${isEvent ? '<span style="color:#f59e0b">⚡ 이벤트</span>' : ''}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ============================================
// 섹션 5 — IV Skew 차트
// ============================================
function renderSkewChart(skewData) {
  const el = document.getElementById('struct-skew');
  if (!el) return;

  if (!skewData.length) {
    el.innerHTML = '<div style="padding:16px;color:var(--text3)">데이터 없음</div>';
    return;
  }

  const W = 520, H = 160, PL = 48, PR = 16, PT = 16, PB = 36;
  const cW = W - PL - PR, cH = H - PT - PB;

  const skews = skewData.map(r => r.skew);
  const dtes  = skewData.map(r => r.dte);
  const maxAbs = Math.max(...skews.map(Math.abs)) * 1.2 || 0.1;
  const minDTE = Math.min(...dtes), maxDTE = Math.max(...dtes);

  const xScale = dte  => PL + ((dte - minDTE) / (maxDTE - minDTE || 1)) * cW;
  const yScale = skew => PT + (1 - (skew + maxAbs) / (2 * maxAbs)) * cH;
  const zeroY  = yScale(0);

  // 바 차트 (만기별 Skew)
  const barW = Math.max(4, cW / skewData.length * 0.6);
  const bars = skewData.map(r => {
    const x    = xScale(r.dte);
    const y0   = zeroY;
    const y1   = yScale(r.skew);
    const barH = Math.abs(y1 - y0);
    const barY = Math.min(y0, y1);
    const col  = r.skew > 0 ? '#ef4444' : '#22c55e';
    return `
      <rect x="${(x - barW / 2).toFixed(1)}" y="${barY.toFixed(1)}"
        width="${barW.toFixed(1)}" height="${barH.toFixed(1)}"
        fill="${col}" opacity="0.7" rx="1">
        <title>${r.expiry_date} Skew: ${(r.skew * 100).toFixed(1)}%
Put IV: ${(r.put_iv * 100).toFixed(1)}% / Call IV: ${(r.call_iv * 100).toFixed(1)}%</title>
      </rect>
      <text x="${x.toFixed(1)}" y="${H - 4}" text-anchor="middle" font-size="9" fill="var(--text3)">
        ${r.dte}d
      </text>
    `;
  }).join('');

  // 평균 Skew 라인
  const avgSkew = skews.reduce((a, b) => a + b, 0) / skews.length;
  const avgY = yScale(avgSkew);
  const avgColor = avgSkew > 0.03 ? '#ef4444' : avgSkew < 0 ? '#22c55e' : '#f59e0b';

  // 요약
  const maxSkewRow = skewData.reduce((m, r) => r.skew > m.skew ? r : m, skewData[0]);
  const skewStatus = avgSkew > 0.05
    ? { label: '공포 과열 ⚠️', color: '#ef4444', desc: '하방 보험료 급등 — 반등 가능성 탐색' }
    : avgSkew > 0.02
    ? { label: '보통 Put 편향', color: '#f59e0b', desc: '완만한 하방 우려' }
    : { label: 'Skew 완화 ✓', color: '#22c55e', desc: '공포 진정 — 상승 구조 우호적' };

  el.innerHTML = `
    <!-- 요약 -->
    <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <div style="background:${skewStatus.color}22;border:1px solid ${skewStatus.color}44;border-radius:8px;padding:10px 16px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Skew 상태</div>
        <div style="font-size:15px;font-weight:800;color:${skewStatus.color}">${skewStatus.label}</div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">${skewStatus.desc}</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 16px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">평균 Skew</div>
        <div style="font-size:15px;font-weight:700;color:${avgColor}">${avgSkew > 0 ? '+' : ''}${(avgSkew * 100).toFixed(2)}%</div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">Put IV − Call IV</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 16px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">최대 Skew 만기</div>
        <div style="font-size:14px;font-weight:700;color:#ef4444">${maxSkewRow.expiry_date}</div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">${(maxSkewRow.skew * 100).toFixed(1)}% (D-${maxSkewRow.dte})</div>
      </div>
    </div>

    <!-- SVG 바 차트 -->
    <div style="overflow-x:auto">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block">
        <!-- 제로 라인 -->
        <line x1="${PL}" y1="${zeroY.toFixed(1)}" x2="${W - PR}" y2="${zeroY.toFixed(1)}"
          stroke="var(--text3)" stroke-width="0.8" stroke-dasharray="4,2"/>
        <text x="${PL - 4}" y="${(zeroY + 4).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text3)">0%</text>
        <!-- 평균 라인 -->
        <line x1="${PL}" y1="${avgY.toFixed(1)}" x2="${W - PR}" y2="${avgY.toFixed(1)}"
          stroke="${avgColor}" stroke-width="1" stroke-dasharray="6,3" opacity="0.7"/>
        ${bars}
        <!-- 축 -->
        <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${PT + cH}" stroke="var(--border)" stroke-width="1"/>
        <!-- Y 레이블 -->
        <text x="${PL - 4}" y="${(PT + 4).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text3)">+${(maxAbs * 100 / 1.2).toFixed(0)}%</text>
        <text x="${PL - 4}" y="${(PT + cH + 4).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text3)">-${(maxAbs * 100 / 1.2).toFixed(0)}%</text>
        <!-- 범례 -->
        <rect x="${W - PR - 80}" y="${PT}" width="10" height="10" fill="#ef4444" rx="1"/>
        <text x="${W - PR - 66}" y="${PT + 9}" font-size="9" fill="var(--text3)">Put 프리미엄</text>
        <rect x="${W - PR - 80}" y="${PT + 14}" width="10" height="10" fill="#22c55e" rx="1"/>
        <text x="${W - PR - 66}" y="${PT + 23}" font-size="9" fill="var(--text3)">Call 프리미엄</text>
      </svg>
    </div>
  `;
}

// ============================================
// 섹션 6 — Expected Move 시각화
// ============================================
function renderExpectedMove(emData, spot) {
  const el = document.getElementById('struct-em');
  if (!el) return;

  if (!emData.length || !spot) {
    el.innerHTML = '<div style="padding:16px;color:var(--text3)">현재가 데이터 필요</div>';
    return;
  }

  // 카드 형식으로 만기별 EM 표시
  const cards = emData.map(r => {
    const pct    = r.em_pct;
    const barPct = Math.min(pct * 4, 100); // 최대 25%를 100%로 스케일
    const col    = pct > 10 ? '#ef4444' : pct > 5 ? '#f59e0b' : '#22c55e';

    return `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px;min-width:140px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:6px">
          ${r.expiry_date} <span style="color:var(--text3)">D-${r.dte}</span>
        </div>
        <!-- 종 모양 단순화: 상단/하단 범위 -->
        <div style="text-align:center;margin:8px 0">
          <div style="font-size:11px;color:#22c55e;font-weight:700">▲ $${r.upper.toFixed(1)}</div>
          <div style="margin:4px 0;height:32px;position:relative">
            <!-- 종 모양 SVG -->
            <svg viewBox="0 0 80 32" width="80" style="display:block;margin:0 auto">
              <path d="M40,2 C52,2 64,8 68,20 L72,30 L8,30 L12,20 C16,8 28,2 40,2 Z"
                fill="${col}" opacity="0.2" stroke="${col}" stroke-width="1"/>
              <line x1="40" y1="2" x2="40" y2="30" stroke="${col}" stroke-width="1" stroke-dasharray="2,2" opacity="0.5"/>
            </svg>
          </div>
          <div style="font-size:13px;font-weight:800;color:var(--text)">$${spot.toFixed(1)}</div>
          <div style="margin:4px 0;height:32px;position:relative">
            <svg viewBox="0 0 80 32" width="80" style="display:block;margin:0 auto;transform:scaleY(-1)">
              <path d="M40,2 C52,2 64,8 68,20 L72,30 L8,30 L12,20 C16,8 28,2 40,2 Z"
                fill="${col}" opacity="0.2" stroke="${col}" stroke-width="1"/>
            </svg>
          </div>
          <div style="font-size:11px;color:#ef4444;font-weight:700">▼ $${r.lower.toFixed(1)}</div>
        </div>
        <!-- EM % 바 -->
        <div style="margin-top:8px">
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3);margin-bottom:3px">
            <span>기대 움직임</span>
            <span style="color:${col};font-weight:700">±${pct}%</span>
          </div>
          <div style="height:4px;background:var(--bg3);border-radius:2px;overflow:hidden">
            <div style="width:${barPct}%;height:100%;background:${col};border-radius:2px"></div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  el.innerHTML = `
    <div style="margin-bottom:10px;font-size:11px;color:var(--text3)">
      현재가 <strong style="color:var(--text)">$${spot.toFixed(2)}</strong> 기준 · ATM IV 내재 기대 범위 · Skew 편향 보정 포함
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      ${cards}
    </div>
  `;
}

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
