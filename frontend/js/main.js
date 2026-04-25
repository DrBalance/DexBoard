import { state } from './state.js';
import { loadAll, loadSnapshot } from './api.js';
import { startClock } from './clock.js';
import { initTabs, bindToggle } from './tabs.js';
import { renderLive } from './tabs/live.js';
import { renderStructure } from './tabs/structure.js';
import { renderScreener } from './tabs/screener.js';
import { renderChart } from './tabs/chart.js';
import { INTERVAL_SNAP, INTERVAL_FULL } from './config.js';

// ── 전체 데이터 로드 → state 업데이트 → 렌더 ──────
async function fetchAndRender() {
  const data = await loadAll();
  state.snapshot        = data.snap;
  state.snapPrev        = data.snapPrev;
  state.dex0            = data.dex0;
  state.dexOpen         = data.dexOpen;
  state.struct.weekly   = data.weekly;
  state.struct.monthly  = data.monthly;
  state.struct.quarterly = data.quarterly;

  renderAll();
}

// ── 스냅샷만 갱신 (1분) ──────────────────────────
async function refreshSnap() {
  const snap = await loadSnapshot();
  if (!snap) return;
  state.snapPrev = state.snapshot;
  state.snapshot = snap;
  renderLive();
}

// ── 전체 렌더 ─────────────────────────────────────
function renderAll() {
  renderLive();
  renderStructure();
  renderScreener();
  renderChart();
}

// ── 장 상태 이벤트 처리 ───────────────────────────
window.addEventListener('marketStateChanged', ({ detail }) => {
  const { marketState, prevState } = detail;
  state.marketState = marketState;

  const isOpen = ['PRE', 'REGULAR', 'AFTER'].includes(marketState);
  const wasOpen = ['PRE', 'REGULAR', 'AFTER'].includes(prevState);

  // 장 열림: 폴링 시작
  if (isOpen && !wasOpen) {
    fetchAndRender();
    state.snapTimer = setInterval(refreshSnap,     INTERVAL_SNAP);
    state.fullTimer = setInterval(fetchAndRender,  INTERVAL_FULL);
  }

  // 장 닫힘: 폴링 중단
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

// ── Init ──────────────────────────────────────────
initTabs();
bindToggle('expiry-toggle', g => { state.activeGroup = g; renderStructure(); });
bindToggle('chart-expiry-toggle', g => { state.chartGroup = g; renderChart(); });

startClock();

// 최초 1회 무조건 로드 (장 상태 무관하게 KV 데이터 표시)
fetchAndRender();

// resize → heatmap 재렌더
window.addEventListener('resize', renderAll);
