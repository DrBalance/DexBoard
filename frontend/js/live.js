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
import { connectWS, disconnectWS }             from '../ws.js';
import {
  fmtPrice, fmtChange, fmtChangePct,
  fmtM, fmtVold,
  colorBySign, colorVix, COLOR,
} from '../fmt.js';
import { renderHeatmap }                       from '../heatmap.js';

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
    }
  } catch (e) {
    console.warn('[Live] KV fetch 실패:', e.message);
  }

  renderCards();

  // 히트맵: SPY 현재가 기준 (WS 우선, 없으면 KV)
  const spotPrice = _state.spyLive ?? _state.spy.price;
  if (_state.strikes.length > 0 && spotPrice) {
    renderHeatmap('heatmap-canvas', _state.strikes, spotPrice);
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
// 장 상태 변화 처리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function handleMarketState({ marketState }) {
  if (marketState === 'REGULAR') {
    // 정규장 진입: WebSocket 연결 + VOLD 초기화
    _state.vold         = 0;
    _state.rspPrevPrice = null;
    connectWS();
  } else if (marketState === 'AFTER') {
    // 애프터 진입: WebSocket 해제
    disconnectWS();
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// initLive — 진입점 (main.js에서 호출)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function initLive() {
  // 최초 1회 즉시 fetch
  fetchKV();

  // 30분 폴링
  window.addEventListener('clockPoll30m', () => fetchKV());

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
