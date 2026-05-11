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
