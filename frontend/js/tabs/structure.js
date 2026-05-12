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

    <!-- 섹션 1: 종합 판단 -->
    <div class="struct-panel" style="border:1px solid var(--border);border-radius:12px;padding:0">
      <div class="struct-panel-title" style="border-radius:12px 12px 0 0">
        <span class="panel-icon">★</span> 종합 판단
        <span class="panel-sub">Term Structure · Skew · Flip Zone · Vanna 결합 분석</span>
      </div>
      <div id="struct-verdict"></div>
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

    <!-- 섹션 10: Expected Move -->
    <div class="struct-panel">
      <div class="struct-panel-title">
        <span class="panel-icon">◎</span> Expected Move
        <span class="panel-sub">만기별 기대 움직임 범위</span>
      </div>
      <div id="struct-em"></div>
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
  ['struct-term', 'struct-skew', 'struct-em', 'struct-heatmap', 'struct-oi-dist', 'struct-weekly-oi'].forEach(id => {
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
      ['struct-term', 'struct-skew', 'struct-em', 'struct-heatmap', 'struct-oi-dist', 'struct-weekly-oi'].forEach(id => {
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
    renderVerdict({ termData, skewData, emData, spot, flipStrike, vannaSum, rows });  // 작업3: 종합판단 개선
    renderOIDistribution(symbol, rows, spot, flipStrike, emData);                    // 작업2: OI 확률 분포
    renderTermStructure(termData);
    renderSkewChartImproved(skewData, rows);                                          // 작업6: Skew 판정 수정
    renderSmileSelector(symbol, rows, scoreRow);
    renderExpiryCardsMonthlyFocus(rows, scoreRow);                                    // Vanna/Charm Monthly 강조
    renderDexHeatmap2D(rows);                                                         // 작업4: 2D 히트맵
    renderWeeklyOISelector(rows, spot);                                               // 작업5: 주간 OI 선택기
    renderExpectedMove(emData, spot);

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

// ============================================
// 섹션 5b — Volatility Smile 곡선
// ============================================
function renderSmileSelector(symbol, expiryRows, scoreRow) {
  const el = document.getElementById('struct-smile');
  if (!el) return;

  if (!expiryRows.length) {
    el.innerHTML = '<div style="padding:16px;color:var(--text3)">데이터 없음</div>';
    return;
  }

  const spot = scoreRow?.close ?? null;

  // 만기 선택 탭 렌더링
  el.innerHTML = `
    <div style="margin-bottom:12px">
      <div style="display:flex;gap:6px;flex-wrap:wrap" id="smile-tab-wrap">
        ${expiryRows.map((r, i) => `
          <button class="smile-tab-btn ${i === 0 ? 'active' : ''}"
            data-expiry="${r.expiry_date}"
            style="
              padding:4px 10px;font-size:11px;border-radius:6px;cursor:pointer;
              background:${i === 0 ? 'var(--accent)' : 'var(--bg3)'};
              color:${i === 0 ? '#fff' : 'var(--text3)'};
              border:1px solid ${i === 0 ? 'var(--accent)' : 'var(--border)'};
            ">
            ${r.expiry_date.slice(5)} D-${r.dte}
          </button>
        `).join('')}
      </div>
    </div>
    <div id="smile-chart-area">
      <div style="padding:16px;color:var(--text3);font-size:12px">만기를 선택하면 Smile 곡선을 표시합니다</div>
    </div>
  `;

  // 탭 클릭 이벤트
  el.querySelectorAll('.smile-tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      // 탭 활성화 스타일
      el.querySelectorAll('.smile-tab-btn').forEach(b => {
        b.style.background = 'var(--bg3)';
        b.style.color      = 'var(--text3)';
        b.style.border     = '1px solid var(--border)';
      });
      btn.style.background = 'var(--accent)';
      btn.style.color      = '#fff';
      btn.style.border     = '1px solid var(--accent)';

      const expiry = btn.dataset.expiry;
      await loadSmileChart(symbol, expiry, spot);
    });
  });

  // 첫번째 만기 자동 로드
  loadSmileChart(symbol, expiryRows[0].expiry_date, spot);
}

async function loadSmileChart(symbol, expiry, spot) {
  const area = document.getElementById('smile-chart-area');
  if (!area) return;
  area.innerHTML = `<div style="padding:16px;color:var(--text3);font-size:12px">로딩 중...</div>`;

  try {
    const res  = await fetch(`${CF_API}/api/options-strikes/${symbol}?expiry=${expiry}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rows = data.rows ?? [];

    if (!rows.length) {
      area.innerHTML = `<div style="padding:16px;color:var(--text3);font-size:12px">
        스트라이크 데이터 없음 — 다음 수집 후 이용 가능합니다
      </div>`;
      return;
    }

    renderSmileCurve(area, rows, spot, expiry);
  } catch (err) {
    area.innerHTML = `<div style="padding:16px;color:#ef4444;font-size:12px">로드 실패: ${err.message}</div>`;
  }
}

function renderSmileCurve(container, rows, spot, expiry) {
  const W = 520, H = 200, PL = 52, PR = 16, PT = 16, PB = 36;
  const cW = W - PL - PR, cH = H - PT - PB;

  // avg_iv 기준으로 정렬
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  const strikes = sorted.map(r => r.strike);
  const ivs     = sorted.map(r => r.avg_iv ?? 0);

  const minS  = Math.min(...strikes);
  const maxS  = Math.max(...strikes);
  const minIV = Math.min(...ivs.filter(v => v > 0)) * 0.9;
  const maxIV = Math.max(...ivs) * 1.1;

  const xScale = s  => PL + ((s - minS) / (maxS - minS || 1)) * cW;
  const yScale = iv => PT + (1 - (iv - minIV) / (maxIV - minIV || 1)) * cH;

  // ATM 라인
  const atmX = spot ? xScale(spot) : null;

  // Call IV / Put IV / Avg IV 세 곡선
  const callPts = sorted
    .filter(r => r.call_iv)
    .map(r => `${xScale(r.strike).toFixed(1)},${yScale(r.call_iv).toFixed(1)}`).join(' ');
  const putPts = sorted
    .filter(r => r.put_iv)
    .map(r => `${xScale(r.strike).toFixed(1)},${yScale(r.put_iv).toFixed(1)}`).join(' ');
  const avgPts = sorted
    .filter(r => r.avg_iv)
    .map(r => `${xScale(r.strike).toFixed(1)},${yScale(r.avg_iv).toFixed(1)}`).join(' ');

  // X축 레이블 (최대 8개)
  const step = Math.ceil(sorted.length / 8);
  const xLabels = sorted.filter((_, i) => i % step === 0).map(r => `
    <text x="${xScale(r.strike).toFixed(1)}" y="${H - 4}"
      text-anchor="middle" font-size="9" fill="var(--text3)">
      $${r.strike}
    </text>
  `).join('');

  // Y축 레이블
  const yTicks = [minIV, (minIV + maxIV) / 2, maxIV].map(iv => `
    <text x="${PL - 4}" y="${(yScale(iv) + 4).toFixed(1)}"
      text-anchor="end" font-size="9" fill="var(--text3)">${(iv * 100).toFixed(0)}%</text>
    <line x1="${PL}" y1="${yScale(iv).toFixed(1)}" x2="${W - PR}" y2="${yScale(iv).toFixed(1)}"
      stroke="var(--border)" stroke-width="0.5" stroke-dasharray="3,3"/>
  `).join('');

  // Skew 방향 판단 (ATM 기준 좌우 비대칭)
  const atmStrike = spot
    ? sorted.reduce((a, b) => Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a, sorted[0])
    : null;
  const otmPutRows  = spot ? sorted.filter(r => r.strike < spot  && r.put_iv) : [];
  const otmCallRows = spot ? sorted.filter(r => r.strike > spot  && r.call_iv) : [];
  const avgPutIV    = otmPutRows.length  ? otmPutRows.reduce((s, r) => s + r.put_iv, 0)   / otmPutRows.length  : null;
  const avgCallIV   = otmCallRows.length ? otmCallRows.reduce((s, r) => s + r.call_iv, 0) / otmCallRows.length : null;
  const skewDir     = (avgPutIV && avgCallIV)
    ? (avgPutIV > avgCallIV ? 'put' : 'call')
    : null;
  const skewLabel   = skewDir === 'put'  ? '🔴 Put Skew — 하방 공포 우세'
                    : skewDir === 'call' ? '🟢 Call Skew — 상승 기대 우세'
                    : '균형';
  const skewColor   = skewDir === 'put'  ? '#ef4444'
                    : skewDir === 'call' ? '#22c55e'
                    : '#f59e0b';

  container.innerHTML = `
    <!-- Skew 방향 요약 -->
    <div style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap">
      <div style="background:${skewColor}22;border:1px solid ${skewColor}44;border-radius:8px;padding:8px 14px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:2px">${expiry} Smile 방향</div>
        <div style="font-size:14px;font-weight:800;color:${skewColor}">${skewLabel}</div>
      </div>
      ${atmStrike ? `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:8px 14px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:2px">ATM IV</div>
        <div style="font-size:14px;font-weight:700;color:var(--text)">
          ${atmStrike.avg_iv ? (atmStrike.avg_iv * 100).toFixed(1) + '%' : '—'}
          <span style="font-size:10px;color:var(--text3)"> @ $${atmStrike.strike}</span>
        </div>
      </div>
      ` : ''}
      ${avgPutIV && avgCallIV ? `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:8px 14px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:2px">OTM Put / Call IV</div>
        <div style="font-size:12px;font-weight:700">
          <span style="color:#ef4444">${(avgPutIV * 100).toFixed(1)}%</span>
          <span style="color:var(--text3)"> / </span>
          <span style="color:#22c55e">${(avgCallIV * 100).toFixed(1)}%</span>
        </div>
      </div>
      ` : ''}
    </div>

    <!-- SVG Smile 곡선 -->
    <div style="overflow-x:auto">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block">
        ${yTicks}
        <!-- ATM 수직선 -->
        ${atmX ? `
          <line x1="${atmX.toFixed(1)}" y1="${PT}" x2="${atmX.toFixed(1)}" y2="${PT + cH}"
            stroke="#d29922" stroke-width="1" stroke-dasharray="4,3" opacity="0.7"/>
          <text x="${atmX.toFixed(1)}" y="${PT - 3}" text-anchor="middle" font-size="8" fill="#d29922">ATM</text>
        ` : ''}
        <!-- Put IV 곡선 -->
        ${putPts ? `<polyline points="${putPts}" fill="none" stroke="#ef4444" stroke-width="1.5" opacity="0.7" stroke-dasharray="4,2"/>` : ''}
        <!-- Call IV 곡선 -->
        ${callPts ? `<polyline points="${callPts}" fill="none" stroke="#22c55e" stroke-width="1.5" opacity="0.7" stroke-dasharray="4,2"/>` : ''}
        <!-- Avg IV 곡선 (메인) -->
        ${avgPts ? `<polyline points="${avgPts}" fill="none" stroke="#58a6ff" stroke-width="2" opacity="0.9"/>` : ''}
        ${xLabels}
        <!-- 축 -->
        <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${PT + cH}" stroke="var(--border)" stroke-width="1"/>
        <line x1="${PL}" y1="${PT + cH}" x2="${W - PR}" y2="${PT + cH}" stroke="var(--border)" stroke-width="1"/>
        <!-- 범례 -->
        <line x1="${W-PR-110}" y1="${PT+7}" x2="${W-PR-96}" y2="${PT+7}" stroke="#58a6ff" stroke-width="2"/>
        <text x="${W-PR-92}" y="${PT+11}" font-size="9" fill="var(--text3)">Avg IV</text>
        <line x1="${W-PR-65}" y1="${PT+7}" x2="${W-PR-51}" y2="${PT+7}" stroke="#22c55e" stroke-width="1.5" stroke-dasharray="4,2"/>
        <text x="${W-PR-47}" y="${PT+11}" font-size="9" fill="var(--text3)">Call</text>
        <line x1="${W-PR-25}" y1="${PT+7}" x2="${W-PR-11}" y2="${PT+7}" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="4,2"/>
        <text x="${W-PR-7}" y="${PT+11}" font-size="9" fill="var(--text3)">Put</text>
      </svg>
    </div>
  `;
}

// ============================================
// 섹션 8 — 종합 판단
// ============================================
function renderVerdict({ termData, skewData, emData, spot, flipStrike, vannaSum, rows }) {
  const el = document.getElementById('struct-verdict');
  if (!el) return;

  // ── 신호 수집
  const signals = [];

  // 1. Flip Zone
  const aboveFlip = flipStrike && spot ? spot > flipStrike : null;
  signals.push({
    label: 'Flip Zone',
    value: aboveFlip === true ? '현재가 위 ▲' : aboveFlip === false ? '현재가 아래 ▼' : '—',
    ok:    aboveFlip === true,
    color: aboveFlip === true ? '#22c55e' : aboveFlip === false ? '#ef4444' : '#6e7681',
    weight: 3,
  });

  // 2. Term Structure
  const termOk = termData.status === 'contango';
  const termNeutral = termData.status === 'flat';
  signals.push({
    label: 'Term Structure',
    value: termData.label,
    ok:    termOk,
    color: termData.color,
    weight: 2,
  });

  // 3. Skew 방향
  const avgSkew = skewData.length
    ? skewData.reduce((s, r) => s + r.skew, 0) / skewData.length : 0;
  const skewOk = avgSkew < 0.01; // Call 편향 or 균형
  signals.push({
    label: 'IV Skew',
    value: avgSkew < -0.01 ? 'Call 과열' : avgSkew < 0.01 ? 'Put/Call 균형' : 'Put 프리미엄',
    ok:    skewOk,
    color: avgSkew < -0.01 ? '#f59e0b' : avgSkew < 0.01 ? '#22c55e' : '#ef4444',
    weight: 1,
  });

  // 4. Vanna
  const vannaOk = vannaSum > 0;
  signals.push({
    label: 'Vanna',
    value: vannaSum > 0 ? `양수 ▲ ${vannaSum.toFixed(2)}` : `음수 ▼ ${vannaSum.toFixed(2)}`,
    ok:    vannaOk,
    color: vannaOk ? '#22c55e' : '#ef4444',
    weight: 2,
  });

  // 5. Expected Move 여유
  const nearestEM  = emData[0] ?? null;
  const emHeadroom = (nearestEM && spot && flipStrike)
    ? ((nearestEM.upper - spot) / spot * 100) : null;
  const emOk = emHeadroom !== null && emHeadroom > 2;
  signals.push({
    label: 'EM 상단 여유',
    value: emHeadroom !== null ? `+${emHeadroom.toFixed(1)}%` : '—',
    ok:    emOk,
    color: emOk ? '#22c55e' : '#f59e0b',
    weight: 1,
  });

  // ── 가중 점수 계산
  const maxScore  = signals.reduce((s, sig) => s + sig.weight, 0);
  const score     = signals.reduce((s, sig) => s + (sig.ok ? sig.weight : 0), 0);
  const scorePct  = score / maxScore;

  // ── 최종 판정
  let verdict, verdictColor, verdictDesc, strategy;
  if (scorePct >= 0.8) {
    verdict      = '🟢 진입 후보';
    verdictColor = '#22c55e';
    verdictDesc  = '딜러 메카닉과 옵션 구조 모두 상승에 우호적';
    strategy     = termData.status === 'contango' && Math.abs(avgSkew) < 0.03
      ? 'Bull Put Spread 또는 Iron Condor (Call Wall 확인 후)'
      : 'Bull Put Spread';
  } else if (scorePct >= 0.6) {
    verdict      = '🟡 상승세 지속 (단기 주의)';
    verdictColor = '#f59e0b';
    verdictDesc  = '상승 구조이나 일부 신호 불일치 — 포지션 크기 조절 권고';
    strategy     = 'Bull Put Spread (좁은 폭)';
  } else if (scorePct >= 0.4) {
    verdict      = '🟠 청산 근접 또는 관망';
    verdictColor = '#f97316';
    verdictDesc  = '신호 혼재 — 신규 진입 자제, 기존 포지션 청산 검토';
    strategy     = '신규 진입 자제';
  } else {
    verdict      = '🔴 관망';
    verdictColor = '#ef4444';
    verdictDesc  = '하락 구조 — 포지션 청산 또는 Bear Call Spread 고려';
    strategy     = aboveFlip === false
      ? 'Bear Call Spread (Flip Zone 위 저항)'
      : '관망';
  }

  // ── 이벤트 경고
  const eventExpiries = termData.eventExpiries ?? new Set();
  const nearestExpiry = rows.find(r => r.dte <= 14);
  const eventWarning  = eventExpiries.size > 0
    ? `<div style="margin-top:10px;padding:10px 14px;background:#f59e0b11;border:1px solid #f59e0b33;border-radius:8px;font-size:11px;color:#f59e0b">
        ⚡ 이벤트 리스크 감지 (${[...eventExpiries].join(', ')}) — 해당 만기 옵션 전략 회피 권고
       </div>`
    : '';

  el.innerHTML = `
    <div style="padding:16px">

      <!-- 최종 판정 -->
      <div style="background:${verdictColor}22;border:1px solid ${verdictColor}44;border-radius:10px;padding:16px;margin-bottom:14px">
        <div style="font-size:20px;font-weight:800;color:${verdictColor};margin-bottom:6px">${verdict}</div>
        <div style="font-size:12px;color:var(--text2);margin-bottom:10px">${verdictDesc}</div>
        <div style="font-size:11px;color:var(--text3)">
          종합 점수: <strong style="color:${verdictColor}">${score}/${maxScore}</strong>
        </div>
      </div>

      <!-- 추천 전략 -->
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:14px">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">추천 옵션 전략</div>
        <div style="font-size:15px;font-weight:700;color:var(--text)">📋 ${strategy}</div>
        ${nearestEM ? `
        <div style="font-size:11px;color:var(--text3);margin-top:6px">
          최근 만기(D-${nearestEM.dte}) 기대 범위:
          <span style="color:#22c55e">▲ $${nearestEM.upper.toFixed(1)}</span> ~
          <span style="color:#ef4444">▼ $${nearestEM.lower.toFixed(1)}</span>
          (±${nearestEM.em_pct}%)
        </div>
        ` : ''}
      </div>

      <!-- 신호 체크리스트 -->
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px 16px">
        <div style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:10px">신호 체크리스트</div>
        ${signals.map(sig => `
          <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
            <div style="font-size:15px;color:${sig.color};flex-shrink:0">${sig.ok ? '✓' : '✗'}</div>
            <div style="flex:1">
              <span style="font-size:11px;font-weight:600;color:${sig.ok ? 'var(--text)' : 'var(--text3)'}">${sig.label}</span>
              <span style="font-size:11px;color:${sig.color};margin-left:8px">${sig.value}</span>
            </div>
            <div style="font-size:10px;color:var(--text3)">가중치 ${sig.weight}</div>
          </div>
        `).join('')}
      </div>

      ${eventWarning}

    </div>
  `;
}

// ============================================
// 작업 2: OI 확률 분포 차트 (Monthly 합산, VRVP 스타일)
// ============================================
function isMonthlyExpiry(expiry_date) {
  const d = new Date(expiry_date + 'T00:00:00Z');
  if (d.getUTCDay() !== 5) return false;
  const day = d.getUTCDate();
  return day >= 15 && day <= 21;
}

async function renderOIDistribution(symbol, expiryRows, spot, flipStrike, emData) {
  const el = document.getElementById('struct-oi-dist');
  if (!el) return;

  // Monthly 만기 2개 추출
  const monthlyExpiries = expiryRows
    .filter(r => isMonthlyExpiry(r.expiry_date))
    .sort((a, b) => a.dte - b.dte)
    .slice(0, 2);

  if (!monthlyExpiries.length) {
    el.innerHTML = '<div style="padding:16px;color:var(--text3);font-size:12px">Monthly 만기 데이터 없음</div>';
    return;
  }

  el.innerHTML = '<div style="padding:16px;color:var(--text3);font-size:12px">스트라이크 데이터 로딩 중...</div>';

  try {
    // Monthly 2개 strikes 병렬 로드
    const results = await Promise.all(
      monthlyExpiries.map(exp =>
        fetch(`${CF_API}/api/options-strikes/${symbol}?expiry=${exp.expiry_date}`)
          .then(r => r.ok ? r.json() : { rows: [] })
          .then(d => d.rows ?? [])
      )
    );

    // 합산
    const strikeMap = {};
    for (const rows of results) {
      for (const r of rows) {
        const k = r.strike;
        if (!strikeMap[k]) strikeMap[k] = { strike: k, call_oi: 0, put_oi: 0, avg_iv: 0, count: 0 };
        strikeMap[k].call_oi += r.call_oi ?? 0;
        strikeMap[k].put_oi  += r.put_oi  ?? 0;
        if (r.avg_iv) { strikeMap[k].avg_iv += r.avg_iv; strikeMap[k].count++; }
      }
    }
    const strikes = Object.values(strikeMap)
      .map(r => ({ ...r, avg_iv: r.count ? r.avg_iv / r.count : 0 }))
      .sort((a, b) => a.strike - b.strike);

    if (!strikes.length) {
      el.innerHTML = '<div style="padding:16px;color:var(--text3);font-size:12px">스트라이크 데이터 없음 — 수집 후 이용 가능</div>';
      return;
    }

    // Call Wall (Call OI 최대 스트라이크)
    const callWall = strikes.reduce((m, r) => r.call_oi > m.call_oi ? r : m, strikes[0]);
    // Put Wall (Put OI 최대 스트라이크)
    const putWall  = strikes.reduce((m, r) => r.put_oi > m.put_oi ? r : m, strikes[0]);

    // D-7 EM 범위 (emData에서 dte <= 7 중 가장 가까운 것, 없으면 첫번째)
    const nearEM = emData.find(r => r.dte <= 7) ?? emData[0] ?? null;

    // IV Smile 기반 정규분포 확률 밀도 (스트라이크별)
    const probDist = spot ? strikes.map(r => {
      if (!r.avg_iv || !spot) return 0;
      const dte = monthlyExpiries[0]?.dte ?? 30;
      const sigma = spot * r.avg_iv * Math.sqrt(dte / 365);
      const diff = r.strike - spot;
      return Math.exp(-0.5 * (diff / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI));
    }) : [];
    const maxProb = Math.max(...probDist, 1e-10);
    const normProb = probDist.map(p => p / maxProb);

    // SVG 렌더링
    const W = 560, H = 300, PL = 56, PR = 16, PT = 20, PB = 40;
    const cW = W - PL - PR, cH = H - PT - PB;
    const midY = PT + cH / 2; // 중앙 (Call 위/Put 아래)

    const minS = strikes[0].strike, maxS = strikes[strikes.length - 1].strike;
    const maxCallOI = Math.max(...strikes.map(r => r.call_oi), 1);
    const maxPutOI  = Math.max(...strikes.map(r => r.put_oi), 1);
    const maxOI     = Math.max(maxCallOI, maxPutOI);

    const xScale = s => PL + ((s - minS) / (maxS - minS || 1)) * cW;
    const barH   = (cH / 2) * 0.85; // 최대 막대 높이

    // 막대 너비
    const barW = Math.max(2, cW / strikes.length * 0.75);

    // Call 막대 (위쪽)
    const callBars = strikes.map(r => {
      const x = xScale(r.strike);
      const h = (r.call_oi / maxOI) * barH;
      return `<rect x="${(x - barW/2).toFixed(1)}" y="${(midY - h).toFixed(1)}"
        width="${barW.toFixed(1)}" height="${h.toFixed(1)}"
        fill="#22c55e" opacity="0.6" rx="1">
        <title>Strike $${r.strike} Call OI: ${fmtK(r.call_oi)}</title>
      </rect>`;
    }).join('');

    // Put 막대 (아래쪽)
    const putBars = strikes.map(r => {
      const x = xScale(r.strike);
      const h = (r.put_oi / maxOI) * barH;
      return `<rect x="${(x - barW/2).toFixed(1)}" y="${midY.toFixed(1)}"
        width="${barW.toFixed(1)}" height="${h.toFixed(1)}"
        fill="#ef4444" opacity="0.6" rx="1">
        <title>Strike $${r.strike} Put OI: ${fmtK(r.put_oi)}</title>
      </rect>`;
    }).join('');

    // IV Smile 확률 분포 곡선 (파란 곡선, 위쪽)
    const probPts = strikes.map((r, i) =>
      `${xScale(r.strike).toFixed(1)},${(midY - normProb[i] * barH * 0.9).toFixed(1)}`
    ).join(' ');

    // 수직선들
    const spotX      = spot    ? xScale(spot)            : null;
    const callWallX  = callWall ? xScale(callWall.strike) : null;
    const flipX      = flipStrike ? xScale(Math.max(minS, Math.min(maxS, flipStrike))) : null;
    const emUpperX   = nearEM && spot ? xScale(Math.min(maxS, nearEM.upper)) : null;
    const emLowerX   = nearEM && spot ? xScale(Math.max(minS, nearEM.lower)) : null;

    // X축 레이블
    const step = Math.ceil(strikes.length / 8);
    const xLabels = strikes.filter((_, i) => i % step === 0).map(r => `
      <text x="${xScale(r.strike).toFixed(1)}" y="${H - 6}"
        text-anchor="middle" font-size="9" fill="var(--text3)">$${r.strike}</text>
    `).join('');

    // Y축 레이블
    const yLabels = `
      <text x="${PL - 4}" y="${(midY - barH).toFixed(1)}" text-anchor="end" font-size="9" fill="#22c55e">▲ Call</text>
      <text x="${PL - 4}" y="${(midY + barH + 10).toFixed(1)}" text-anchor="end" font-size="9" fill="#ef4444">▼ Put</text>
      <text x="${PL - 4}" y="${(midY + 4).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text3)">0</text>
    `;

    // EM 음영
    const emShade = (emUpperX && emLowerX) ? `
      <rect x="${emLowerX.toFixed(1)}" y="${PT}"
        width="${(emUpperX - emLowerX).toFixed(1)}" height="${cH}"
        fill="#3b82f6" opacity="0.07"/>
    ` : '';

    el.innerHTML = `
      <!-- 요약 카드 -->
      <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
        <div style="background:#22c55e22;border:1px solid #22c55e44;border-radius:8px;padding:10px 14px;flex:1;min-width:120px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Call Wall</div>
          <div style="font-size:16px;font-weight:800;font-family:var(--mono);color:#22c55e">
            $${callWall.strike.toFixed(0)}
          </div>
          <div style="font-size:10px;color:var(--text3);margin-top:2px">OI ${fmtK(callWall.call_oi)}</div>
        </div>
        <div style="background:#ef444422;border:1px solid #ef444444;border-radius:8px;padding:10px 14px;flex:1;min-width:120px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Put Wall</div>
          <div style="font-size:16px;font-weight:800;font-family:var(--mono);color:#ef4444">
            $${putWall.strike.toFixed(0)}
          </div>
          <div style="font-size:10px;color:var(--text3);margin-top:2px">OI ${fmtK(putWall.put_oi)}</div>
        </div>
        ${flipStrike ? `
        <div style="background:#f59e0b22;border:1px solid #f59e0b44;border-radius:8px;padding:10px 14px;flex:1;min-width:120px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Flip Zone</div>
          <div style="font-size:16px;font-weight:800;font-family:var(--mono);color:#f59e0b">
            $${flipStrike.toFixed(0)}
          </div>
          <div style="font-size:10px;color:var(--text3);margin-top:2px">${spot && spot > flipStrike ? '현재가 위 ▲ Long Gamma' : '현재가 아래 ▼ Short Gamma'}</div>
        </div>` : ''}
        ${nearEM ? `
        <div style="background:#3b82f622;border:1px solid #3b82f644;border-radius:8px;padding:10px 14px;flex:1;min-width:120px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px">D-${nearEM.dte} EM 범위</div>
          <div style="font-size:13px;font-weight:700;font-family:var(--mono);color:#3b82f6">
            $${nearEM.lower.toFixed(0)} ~ $${nearEM.upper.toFixed(0)}
          </div>
          <div style="font-size:10px;color:var(--text3);margin-top:2px">±${nearEM.em_pct}%</div>
        </div>` : ''}
      </div>

      <!-- SVG 차트 -->
      <div style="overflow-x:auto">
        <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block">
          <!-- EM 음영 -->
          ${emShade}
          <!-- 중앙선 -->
          <line x1="${PL}" y1="${midY}" x2="${W - PR}" y2="${midY}"
            stroke="var(--text3)" stroke-width="0.8"/>
          <!-- Call 막대 -->
          ${callBars}
          <!-- Put 막대 -->
          ${putBars}
          <!-- IV 확률 분포 곡선 -->
          ${probPts ? `<polyline points="${probPts}" fill="none" stroke="#3b82f6" stroke-width="2" opacity="0.8"/>` : ''}
          <!-- 현재가 -->
          ${spotX ? `
            <line x1="${spotX.toFixed(1)}" y1="${PT}" x2="${spotX.toFixed(1)}" y2="${PT + cH}"
              stroke="#d29922" stroke-width="1.5" stroke-dasharray="0"/>
            <text x="${spotX.toFixed(1)}" y="${PT - 4}" text-anchor="middle" font-size="9" fill="#d29922">현재가</text>
          ` : ''}
          <!-- Call Wall -->
          ${callWallX ? `
            <line x1="${callWallX.toFixed(1)}" y1="${PT}" x2="${callWallX.toFixed(1)}" y2="${PT + cH}"
              stroke="#22c55e" stroke-width="1.2" stroke-dasharray="5,3" opacity="0.9"/>
            <text x="${callWallX.toFixed(1)}" y="${PT - 4}" text-anchor="middle" font-size="9" fill="#22c55e">Call Wall</text>
          ` : ''}
          <!-- Flip Zone -->
          ${flipX ? `
            <line x1="${flipX.toFixed(1)}" y1="${PT}" x2="${flipX.toFixed(1)}" y2="${PT + cH}"
              stroke="#f59e0b" stroke-width="1.2" stroke-dasharray="4,3" opacity="0.9"/>
            <text x="${flipX.toFixed(1)}" y="${(PT + cH + 12).toFixed(1)}" text-anchor="middle" font-size="9" fill="#f59e0b">Flip</text>
          ` : ''}
          ${xLabels}
          ${yLabels}
          <!-- 축 -->
          <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${PT + cH}" stroke="var(--border)" stroke-width="1"/>
          <!-- 범례 -->
          <rect x="${W-PR-160}" y="${PT+2}" width="10" height="8" fill="#22c55e" opacity="0.6"/>
          <text x="${W-PR-146}" y="${PT+10}" font-size="9" fill="var(--text3)">Call OI</text>
          <rect x="${W-PR-110}" y="${PT+2}" width="10" height="8" fill="#ef4444" opacity="0.6"/>
          <text x="${W-PR-96}" y="${PT+10}" font-size="9" fill="var(--text3)">Put OI</text>
          <line x1="${W-PR-62}" y1="${PT+6}" x2="${W-PR-48}" y2="${PT+6}" stroke="#3b82f6" stroke-width="2"/>
          <text x="${W-PR-44}" y="${PT+10}" font-size="9" fill="var(--text3)">IV 분포</text>
          <rect x="${W-PR-16}" y="${PT+2}" width="10" height="8" fill="#3b82f6" opacity="0.2"/>
          <text x="${W-PR-20}" y="${PT+10}" font-size="9" fill="var(--text3)">EM</text>
        </svg>
      </div>
      <div style="margin-top:6px;font-size:10px;color:var(--text3)">
        Monthly 만기 ${monthlyExpiries.map(e => e.expiry_date).join(' + ')} 합산 · 파란 곡선: ATM IV 기반 정규분포
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<div style="padding:16px;color:#ef4444;font-size:12px">로드 실패: ${err.message}</div>`;
  }
}

// ============================================
// 작업 3: 종합 판단 섹션 개선 (스윙/옵션 시나리오)
// renderVerdict를 override하여 새 포맷 적용
// ============================================
// 기존 renderVerdict는 그대로 유지하고,
// loadAndRenderCharts에서 새 버전을 호출하도록 이미 변경됨.
// 아래가 새 버전 renderVerdict (같은 이름으로 재정의 → 마지막 정의가 우선)

// eslint-disable-next-line no-redeclare
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
function renderSkewChartImproved(skewData, allRows) {
  const el = document.getElementById('struct-skew');
  if (!el) return;

  if (!skewData.length) {
    el.innerHTML = '<div style="padding:16px;color:var(--text3)">데이터 없음</div>';
    return;
  }

  // netSkew = put_iv - call_iv
  // 양수 → Put 편향(하방 공포), 음수 → Call 편향(상승 과열)
  const enriched = skewData.map(r => ({
    ...r,
    netSkew: r.put_iv - r.call_iv,  // 수정된 계산
  }));

  const avgNetSkew = enriched.reduce((s, r) => s + r.netSkew, 0) / enriched.length;

  // 7일 역사적 평균이 없으므로 현재 만기들의 평균을 기준으로 편차 계산
  const deviations = enriched.map(r => r.netSkew - avgNetSkew);

  // 상태 판정: 편차 기반
  const maxDev = Math.max(...deviations.map(Math.abs), 0.001);
  const overallStatus = (() => {
    if (avgNetSkew > 0.05)       return { label: 'Put 과열 ⚠️',      color: '#ef4444', desc: '하방 공포 집중 — 반등 탐색 가능' };
    if (avgNetSkew > 0.02)       return { label: 'Put 편향',          color: '#f59e0b', desc: '완만한 하방 우려' };
    if (avgNetSkew < -0.02)      return { label: 'Call 편향 (과열)',   color: '#f97316', desc: '상승 기대 과열 — 조정 주의' };
    return                              { label: 'Skew 균형 ✓',       color: '#22c55e', desc: '공포/탐욕 균형 — 옵션 구조 중립' };
  })();

  const W = 520, H = 160, PL = 48, PR = 16, PT = 16, PB = 36;
  const cW = W - PL - PR, cH = H - PT - PB;
  const skews = enriched.map(r => r.netSkew);
  const dtes  = enriched.map(r => r.dte);
  const maxAbs = Math.max(...skews.map(Math.abs)) * 1.3 || 0.1;
  const minDTE = Math.min(...dtes), maxDTE = Math.max(...dtes);

  const xScale = dte  => PL + ((dte - minDTE) / (maxDTE - minDTE || 1)) * cW;
  const yScale = skew => PT + (1 - (skew + maxAbs) / (2 * maxAbs)) * cH;
  const zeroY  = yScale(0);
  const avgY   = yScale(avgNetSkew);

  const barW = Math.max(4, cW / enriched.length * 0.6);
  const bars = enriched.map(r => {
    const x    = xScale(r.dte);
    const y0   = zeroY;
    const y1   = yScale(r.netSkew);
    const bH   = Math.abs(y1 - y0);
    const bY   = Math.min(y0, y1);
    const col  = r.netSkew > 0 ? '#ef4444' : '#22c55e';
    // 편차 강도로 투명도 조절
    const dev  = Math.abs(r.netSkew - avgNetSkew) / (maxDev || 1);
    const opacity = 0.5 + dev * 0.4;
    return `
      <rect x="${(x - barW/2).toFixed(1)}" y="${bY.toFixed(1)}"
        width="${barW.toFixed(1)}" height="${bH.toFixed(1)}"
        fill="${col}" opacity="${opacity.toFixed(2)}" rx="1">
        <title>${r.expiry_date} netSkew: ${(r.netSkew*100).toFixed(2)}%
Put IV: ${(r.put_iv*100).toFixed(1)}% / Call IV: ${(r.call_iv*100).toFixed(1)}%
편차: ${(deviations[enriched.indexOf(r)]*100).toFixed(2)}%</title>
      </rect>
      <text x="${x.toFixed(1)}" y="${H - 4}" text-anchor="middle" font-size="9" fill="var(--text3)">
        ${r.dte}d
      </text>
    `;
  }).join('');

  const avgColor = avgNetSkew > 0.03 ? '#ef4444' : avgNetSkew < -0.02 ? '#f97316' : '#22c55e';
  const maxSkewRow = enriched.reduce((m, r) => Math.abs(r.netSkew) > Math.abs(m.netSkew) ? r : m, enriched[0]);

  el.innerHTML = `
    <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <div style="background:${overallStatus.color}22;border:1px solid ${overallStatus.color}44;border-radius:8px;padding:10px 16px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Skew 상태</div>
        <div style="font-size:15px;font-weight:800;color:${overallStatus.color}">${overallStatus.label}</div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">${overallStatus.desc}</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 16px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">평균 Net Skew (Put−Call)</div>
        <div style="font-size:15px;font-weight:700;color:${avgColor}">${avgNetSkew > 0 ? '+' : ''}${(avgNetSkew*100).toFixed(2)}%</div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">양수=Put편향 · 음수=Call편향</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 16px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">최대 편향 만기</div>
        <div style="font-size:14px;font-weight:700;color:${maxSkewRow.netSkew > 0 ? '#ef4444' : '#22c55e'}">${maxSkewRow.expiry_date}</div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">${(maxSkewRow.netSkew*100).toFixed(2)}% (D-${maxSkewRow.dte})</div>
      </div>
    </div>
    <div style="overflow-x:auto">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block">
        <line x1="${PL}" y1="${zeroY.toFixed(1)}" x2="${W-PR}" y2="${zeroY.toFixed(1)}"
          stroke="var(--text3)" stroke-width="0.8" stroke-dasharray="4,2"/>
        <text x="${PL-4}" y="${(zeroY+4).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text3)">0%</text>
        <line x1="${PL}" y1="${avgY.toFixed(1)}" x2="${W-PR}" y2="${avgY.toFixed(1)}"
          stroke="${avgColor}" stroke-width="1.2" stroke-dasharray="6,3" opacity="0.8"/>
        <text x="${W-PR}" y="${(avgY-3).toFixed(1)}" text-anchor="end" font-size="8" fill="${avgColor}">평균</text>
        ${bars}
        <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${PT+cH}" stroke="var(--border)" stroke-width="1"/>
        <text x="${PL-4}" y="${(PT+4).toFixed(1)}" text-anchor="end" font-size="9" fill="#ef4444">Put↑</text>
        <text x="${PL-4}" y="${(PT+cH+4).toFixed(1)}" text-anchor="end" font-size="9" fill="#22c55e">Call↑</text>
        <rect x="${W-PR-90}" y="${PT}" width="10" height="8" fill="#ef4444" opacity="0.7" rx="1"/>
        <text x="${W-PR-76}" y="${PT+8}" font-size="9" fill="var(--text3)">Put 편향</text>
        <rect x="${W-PR-30}" y="${PT}" width="10" height="8" fill="#22c55e" opacity="0.7" rx="1"/>
        <text x="${W-PR-16}" y="${PT+8}" font-size="9" fill="var(--text3)">Call</text>
      </svg>
    </div>
  `;
}
