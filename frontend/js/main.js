// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// main.js — 진입점
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { state }              from './state.js';
import { loadAll, loadSnapshot } from './api.js';
import { startClock }         from './clock.js';
import { initTabs, bindToggle } from './tabs.js';
import { INTERVAL_SNAP, INTERVAL_FULL } from './config.js';

// ── clock.js 가 찾는 id와 index.html id 브리지 ────────────
// clock.js: market-state-badge / market-state-dot / market-state-label
// index.html: market-badge / market-dot / market-label
function _patchClockIds() {
  const badge = document.getElementById('market-badge');
  const dot   = document.getElementById('market-dot');
  const label = document.getElementById('market-label');
  if (badge && !document.getElementById('market-state-badge')) {
    badge.id = 'market-state-badge';
  }
  if (dot && !document.getElementById('market-state-dot')) {
    dot.id = 'market-state-dot';
  }
  if (label && !document.getElementById('market-state-label')) {
    label.id = 'market-state-label';
  }
}

// ── 전체 데이터 로드 → state 업데이트 ────────────────────
async function fetchAndRender() {
  const data = await loadAll();
  state.snapshot         = data.snap;
  state.snapPrev         = data.snapPrev;
  state.dex0             = data.dex0;
  state.dexOpen          = data.dexOpen;
  state.oiOpen           = data.oiOpen;       // 장 시작 OI 맵 { oiMap, saved_at }
  state.struct.weekly    = data.weekly;
  state.struct.monthly   = data.monthly;
  state.struct.quarterly = data.quarterly;

  // live 탭은 자체 상태(_state)를 가지므로 여기서 직접 렌더 안 함
  // tabs.js의 refresh 메커니즘으로 처리
  window.dispatchEvent(new CustomEvent('dataUpdated', { detail: data }));
}

// ── 스냅샷만 갱신 (1분) ──────────────────────────────────
async function refreshSnap() {
  const snap = await loadSnapshot();
  if (!snap) return;
  state.snapPrev = state.snapshot;
  state.snapshot = snap;
  window.dispatchEvent(new CustomEvent('snapUpdated', { detail: snap }));
}

// ── 장 상태 이벤트 처리 ───────────────────────────────────
window.addEventListener('marketStateChanged', ({ detail }) => {
  const { marketState, prevState } = detail;
  state.marketState = marketState;

  const isOpen  = ['PRE', 'REGULAR', 'AFTER'].includes(marketState);
  const wasOpen = ['PRE', 'REGULAR', 'AFTER'].includes(prevState);

  if (isOpen && !wasOpen) {
    fetchAndRender();
    state.snapTimer = setInterval(refreshSnap,    INTERVAL_SNAP);
    state.fullTimer = setInterval(fetchAndRender, INTERVAL_FULL);
  }

  if (!isOpen && wasOpen) {
    clearInterval(state.snapTimer);
    clearInterval(state.fullTimer);
    state.snapTimer = null;
    state.fullTimer = null;
  }

  // 페이지 로드 시 이미 장중이면 즉시 시작
  if (prevState === undefined && isOpen) {
    fetchAndRender();
    state.snapTimer = setInterval(refreshSnap,    INTERVAL_SNAP);
    state.fullTimer = setInterval(fetchAndRender, INTERVAL_FULL);
  }
});

// ── Init ──────────────────────────────────────────────────
_patchClockIds();
initTabs();
bindToggle('expiry-toggle',       g => { state.activeGroup = g; });
bindToggle('chart-expiry-toggle', g => { state.chartGroup  = g; });

startClock();

// 최초 1회 무조건 로드 (장 상태 무관 — 마감 중에도 KV 데이터 표시)
fetchAndRender();
