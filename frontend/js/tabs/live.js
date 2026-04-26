// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// live.js — Tab1: DEX Live
//
// 메트릭카드 (6개):
//   SPY   : price / change / changePct  (WebSocket 실시간 → KV 폴백)
//   VIX   : price / change / changePct  (KV 폴링)
//   GEX   : M단위, 양/음 색상           (KV 폴링)
//   Vanna : M단위, 보라색 고정          (KV 폴링)
//   Charm : M단위, 청록색 고정          (KV 폴링)
//   VOLD  : RSP 틱 누적 계산, M단위    (WebSocket 실시간)
//
// 데이터 소스:
//   /api/snapshot   → spy, vix (1분 KV)
//   /api/dex/0dte   → gex_total, vanna_total, charm_total
//   wsTick 이벤트  → SPY 현재가, RSP 틱(VOLD 계산)
//
// 폴링:
//   최초 로드 1회 즉시
//   clockPoll30m 이벤트 구독 (30분마다)
//   REGULAR 진입 시 WebSocket 연결
//   AFTER   진입 시 WebSocket 해제
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { CF_API }                              from '../config.js';
import { RAILWAY_WS_URL }                      from '../config.js';
import { connectWS, disconnectWS }             from '../ws.js';
import {
  fmtPrice, fmtChange, fmtChangePct,
  fmtM, fmtVold,
  colorBySign, colorVix, COLOR,
} from '../fmt.js';
import { renderHeatmap }                       from '../heatmap.js';
import { buildNarrative, buildAnalysisPayload } from '../narrative.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 내부 상태
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const _state = {
  // KV에서 가져온 값
  spy:     { price: null, change: null, changePct: null },
  vix:     { price: null, change: null, changePct: null },
  gex:     null,
  vanna:   null,
  charm:   null,
  strikes: [],         // strike별 raw 데이터 (히트맵용)

  // WebSocket 실시간
  spyLive:      null,  // SPY 현재가 (WS 수신 시 덮어씀)

  // VOLD 누적 (RSP 기반)
  vold:         0,
  rspPrevPrice: null,  // 직전 틱 가격 (방향 판단용)
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// KV 데이터 fetch
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fetchKV() {
  try {
    const [snapRes, dexRes] = await Promise.all([
      fetch(`${CF_API}/api/snapshot`),
      fetch(`${CF_API}/api/dex/0dte`),
    ]);

    if (snapRes.ok) {
      const snap       = await snapRes.json();
      _state.spy       = snap.spy ?? _state.spy;
      _state.vix       = snap.vix ?? _state.vix;
    }

    if (dexRes.ok) {
      const dex        = await dexRes.json();
      _state.gex       = dex.gex_total   ?? null;
      _state.vanna     = dex.vanna_total ?? null;
      _state.charm     = dex.charm_total ?? null;
      _state.strikes   = dex.strikes     ?? [];
      _state.spot      = dex.spot        ?? null
    }
  } catch (e) {
    console.warn('[Live] KV fetch 실패:', e.message);
  }

  renderCards();

  // 히트맵: SPY 현재가 기준 (WS 우선, 없으면 KV)
  const spotPrice = _state.spyLive ?? _state.spy.price ?? _state.spot;
  if (_state.strikes.length > 0 && spotPrice) {
    renderHeatmap('heatmap-canvas', _state.strikes, spotPrice);
  }

  // 판단 패널 갱신
  renderNarrative();

  // 정규장일 때만 AI 자동 분석 (15분 데이터 갱신과 연동)
  if (window._marketState === 'REGULAR') {
    requestAIAnalysis(true);  // auto=true: 버튼 상태 변경 안 함
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WebSocket 틱 처리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function handleTick({ s, p, v }) {
  if (s === 'SPY') {
    _state.spyLive = p;
    renderSPY();
  }

  if (s === 'RSP') {
    // VOLD 누적: 직전 틱 대비 방향으로 거래량 누적
    if (_state.rspPrevPrice !== null) {
      const tradeValue = p * (v || 0);
      if (p > _state.rspPrevPrice)      _state.vold += tradeValue;
      else if (p < _state.rspPrevPrice) _state.vold -= tradeValue;
      renderVOLD();
    }
    _state.rspPrevPrice = p;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 렌더링 헬퍼
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function setEl(id, text, color = null) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (color) el.style.color = color;
}

// ── SPY 카드 ─────────────────────────────────────────────
function renderSPY() {
  // 현재가: WS 우선, 없으면 KV
  const price  = _state.spyLive ?? _state.spy.price;
  const change = _state.spy.change;
  const pct    = _state.spy.changePct;
  const color  = colorBySign(change);

  setEl('m-spy', fmtPrice(price), color);
  setEl('m-spy-sub',
    `${fmtChange(change)} ${fmtChangePct(pct)}`,
    color
  );
}

// ── VIX 카드 ─────────────────────────────────────────────
function renderVIX() {
  const { price, change, changePct } = _state.vix;
  const color = colorVix(price);

  setEl('m-vix', fmtPrice(price), color);
  setEl('m-vix-sub',
    `${fmtChange(change)} ${fmtChangePct(changePct)}`,
    colorBySign(change)
  );
}

// ── GEX 카드 ─────────────────────────────────────────────
function renderGEX() {
  const v     = _state.gex;
  const color = colorBySign(v);
  setEl('m-gex0', fmtM(v), color);
  setEl('m-gex0-sub', 'gamma exp.', COLOR.muted);
}

// ── Vanna 카드 ───────────────────────────────────────────
function renderVanna() {
  setEl('m-vanna0', fmtM(_state.vanna), COLOR.purple);
}

// ── Charm 카드 ───────────────────────────────────────────
function renderCharm() {
  setEl('m-charm0', fmtM(_state.charm), COLOR.teal);
}

// ── VOLD 카드 ────────────────────────────────────────────
function renderVOLD() {
  const color = colorBySign(_state.vold);
  // VOLD는 index.html의 DEX 0DTE 카드 자리를 재활용
  setEl('m-dex0',     fmtVold(_state.vold), color);
  setEl('m-dex0-sub', 'RSP breadth',        COLOR.muted);

  // 라벨도 변경
  const labelEl = document.querySelector('[data-metric="dex0"] .metric-label');
  if (labelEl) labelEl.textContent = 'VOLD';
}

// ── 전체 카드 렌더 ───────────────────────────────────────
function renderCards() {
  renderSPY();
  renderVIX();
  renderGEX();
  renderVanna();
  renderCharm();
  renderVOLD();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 판단 패널 렌더링
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const LEVEL_STYLE = {
  danger: { bg: 'rgba(239,68,68,.12)',   border: '#ef4444', icon: '🔴' },
  warn:   { bg: 'rgba(245,158,11,.10)',  border: '#f59e0b', icon: '⚠️' },
  good:   { bg: 'rgba(34,197,94,.10)',   border: '#22c55e', icon: '🟢' },
  info:   { bg: 'rgba(107,114,128,.10)', border: '#6b7280', icon: '💬' },
};

function renderNarrative() {
  const el = document.getElementById('live-narrative');
  if (!el) return;
  const events = buildNarrative({ ..._state, marketState: window._marketState });
  el.innerHTML = events.map(({ level, msg }) => {
    const s = LEVEL_STYLE[level] ?? LEVEL_STYLE.info;
    return `
      <div style="
        display:flex;align-items:flex-start;gap:8px;
        padding:8px 10px;border-radius:6px;
        background:${s.bg};border-left:3px solid ${s.border};
        font-size:12px;line-height:1.5;color:var(--text1,#e6edf3);
      ">
        <span style="flex-shrink:0;margin-top:1px">${s.icon}</span>
        <span>${msg}</span>
      </div>`;
  }).join('');
}

// ── AI 결과 JSON 렌더링 ──────────────────────────────────
function renderAIResult(data) {
  const el = document.getElementById('ai-analysis-result');
  if (!el) return;
  const { market_regime: mr, deep_dive: dd, scenarios, expert_insight } = data;

  const scenarioHTML = (scenarios ?? []).map(sc => {
    const prob  = sc.probability ?? 50;
    const color = prob >= 60 ? '#22c55e' : prob <= 40 ? '#ef4444' : '#f59e0b';
    return `
      <div style="margin-bottom:6px;padding:7px 8px;border-radius:4px;
                  background:rgba(255,255,255,.04);border:1px solid #30363d">
        <div style="display:flex;justify-content:space-between;margin-bottom:3px">
          <span style="font-size:11px;font-weight:600;color:${color}">${sc.case}</span>
          <span style="font-size:12px;font-weight:700;color:${color}">${prob}%</span>
        </div>
        <div style="font-size:11px;color:#8b949e;margin-bottom:1px">▶ ${sc.trigger}</div>
        <div style="font-size:11px;color:#8b949e">목표: ${sc.target}</div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div style="margin-bottom:8px;padding:7px 9px;border-radius:5px;
                background:rgba(167,139,250,.1);border-left:3px solid #a78bfa">
      <div style="font-size:10px;color:#a78bfa;font-weight:600;margin-bottom:2px">시장 국면</div>
      <div style="font-size:12px;font-weight:700;color:#e6edf3;margin-bottom:3px">${mr?.phase ?? '—'}</div>
      <div style="font-size:11px;color:#8b949e;margin-bottom:3px">${mr?.volatility_context ?? ''}</div>
      <span style="font-size:10px;padding:2px 7px;border-radius:10px;
                   background:rgba(167,139,250,.2);color:#a78bfa">${mr?.dominance ?? ''}</span>
    </div>
    <div style="margin-bottom:8px">
      <div style="font-size:10px;color:#8b949e;font-weight:600;margin-bottom:4px">딜러 포지션</div>
      <div style="font-size:11px;color:#e6edf3;line-height:1.5;margin-bottom:3px">${dd?.dealer_inventory?.gamma_exposure ?? '—'}</div>
      <div style="font-size:11px;color:#e6edf3;line-height:1.5">${dd?.dealer_inventory?.vanna_flow ?? '—'}</div>
    </div>
    <div style="margin-bottom:8px;padding:7px 9px;border-radius:5px;
                background:rgba(34,197,94,.06);border-left:3px solid #22c55e">
      <div style="font-size:10px;color:#22c55e;font-weight:600;margin-bottom:3px">수급 (VOLD)</div>
      <div style="font-size:11px;color:#e6edf3;margin-bottom:2px">${dd?.breadth_analysis?.vold_signal ?? '—'}</div>
      <div style="font-size:11px;color:#8b949e">${dd?.breadth_analysis?.interpretation ?? ''}</div>
    </div>
    <div style="margin-bottom:8px">
      <div style="font-size:10px;color:#8b949e;font-weight:600;margin-bottom:4px">시나리오</div>
      ${scenarioHTML}
    </div>
    <div style="padding:7px 9px;border-radius:5px;
                background:rgba(245,158,11,.08);border-left:3px solid #f59e0b">
      <div style="font-size:10px;color:#f59e0b;font-weight:600;margin-bottom:3px">전문가 의견</div>
      <div style="font-size:11px;color:#e6edf3;line-height:1.6">${expert_insight ?? '—'}</div>
    </div>`;
}

// ── AI 분석 요청 ─────────────────────────────────────────
let _aiLoading = false;

async function requestAIAnalysis(auto = false) {
  if (_aiLoading) return;
  _aiLoading = true;

  const btn      = document.getElementById('ai-analyze-btn');
  const result   = document.getElementById('ai-analysis-result');
  const wrap     = document.getElementById('ai-result-wrap');
  const scrollEl = document.getElementById('ai-result-scroll');
  if (!result) { _aiLoading = false; return; }

  if (!auto && btn) {
    btn.disabled    = true;
    btn.textContent = '분석 중…';
  }
  if (wrap) wrap.style.display = 'block';
  result.innerHTML = `
    <div style="text-align:center;padding:20px;color:#8b949e;font-size:12px">
      Gemini가 분석 중입니다…
    </div>`;

  try {
    const payload     = buildAnalysisPayload({ ..._state, marketState: window._marketState });
    const railwayBase = RAILWAY_WS_URL.replace('wss://', 'https://').replace('/ws', '');
    const res         = await fetch(`${railwayBase}/analyze`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.ok && typeof data.analysis === 'object') {
      renderAIResult(data.analysis);
      if (scrollEl) scrollEl.scrollTop = 0;
    } else {
      result.innerHTML = `<div style="color:#ef4444;font-size:12px;padding:8px">
        분석 실패: ${data.error ?? '알 수 없는 오류'}</div>`;
    }
  } catch (e) {
    result.innerHTML = `<div style="color:#ef4444;font-size:12px;padding:8px">
      오류: ${e.message}</div>`;
  } finally {
    _aiLoading = false;
    if (!auto && btn) {
      btn.disabled    = false;
      btn.textContent = '🤖 AI 분석';
    }
  }
}

// ── 판단 패널 HTML 초기화 ────────────────────────────────
function initNarrativePanel() {
  const container = document.getElementById('live-narrative-panel');
  if (!container) return;

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <span style="font-size:12px;font-weight:600;color:var(--text2,#8b949e)">실시간 판단</span>
      <button id="ai-analyze-btn" style="
        padding:4px 12px;font-size:11px;border-radius:4px;
        border:1px solid #a78bfa;background:rgba(167,139,250,.12);
        color:#a78bfa;cursor:pointer;white-space:nowrap;
      ">🤖 AI 분석</button>
    </div>

    <!-- 자체 판단 메시지 -->
    <div id="live-narrative" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px"></div>

    <!-- AI 결과 영역 -->
    <div id="ai-result-wrap" style="display:none">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:11px;font-weight:600;color:#a78bfa">🤖 AI 분석 결과</span>
        <div style="display:flex;gap:4px">
          <button id="ai-scroll-up" style="
            width:26px;height:20px;border-radius:3px;
            border:1px solid #30363d;background:transparent;
            color:#8b949e;cursor:pointer;font-size:11px;
            display:flex;align-items:center;justify-content:center;
          ">▲</button>
          <button id="ai-scroll-down" style="
            width:26px;height:20px;border-radius:3px;
            border:1px solid #30363d;background:transparent;
            color:#8b949e;cursor:pointer;font-size:11px;
            display:flex;align-items:center;justify-content:center;
          ">▼</button>
        </div>
      </div>
      <!-- 스크롤 컨테이너: overscroll-behavior로 페이지 스크롤 전파 차단 -->
      <div id="ai-result-scroll" style="
        max-height:240px;
        overflow-y:scroll;
        overscroll-behavior:contain;
        border:1px solid #30363d;border-radius:6px;
        padding:10px;background:rgba(13,17,23,.6);
      ">
        <div id="ai-analysis-result"></div>
      </div>
    </div>`;

  document.getElementById('ai-analyze-btn')?.addEventListener('click', () => {
    const wrap = document.getElementById('ai-result-wrap');
    if (wrap) wrap.style.display = 'block';
    requestAIAnalysis(false);
  });

  const scrollEl = document.getElementById('ai-result-scroll');
  document.getElementById('ai-scroll-up')?.addEventListener('click', () => {
    if (scrollEl) scrollEl.scrollTop -= 80;
  });
  document.getElementById('ai-scroll-down')?.addEventListener('click', () => {
    if (scrollEl) scrollEl.scrollTop += 80;
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 장 상태 변화 처리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function handleMarketState({ marketState }) {
  if (marketState === 'REGULAR') {
    _state.vold         = 0;
    _state.rspPrevPrice = null;
    connectWS();
  } else if (marketState === 'AFTER') {
    disconnectWS();
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// initLive — 진입점 (main.js에서 호출)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function initLive() {
  // 판단 패널 초기화
  initNarrativePanel();

  // 최초 1회 즉시 fetch
  fetchKV();

  // 30분 폴링
  window.addEventListener('clockPoll30m', () => {
    fetchKV();
    renderNarrative();
  });

  // 장 상태 변화
  window.addEventListener('marketStateChanged', ({ detail }) =>
    handleMarketState(detail)
  );

  // WebSocket 틱 수신
  window.addEventListener('wsTick', ({ detail }) =>
    handleTick(detail)
  );

  // 현재 장 상태가 이미 REGULAR이면 즉시 WS 연결
  if (window._marketState === 'REGULAR') {
    connectWS();
  }
}

export function refreshLive() {
  console.log('[Live] refresh');
  fetchKV();
}

