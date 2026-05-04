// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// main.js — 진입점
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { state }              from './state.js';
import { loadAll, loadSnapshot } from './api.js';
import { startClock }         from './clock.js';
import { initTabs, bindToggle } from './tabs.js';
import { INTERVAL_SNAP, INTERVAL_FULL } from './config.js';
import { initLive }           from './live.js';

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

// ── 세션 날짜·상태 배너 업데이트 ────────────────────────
function updateSessionBanner(marketState) {
  const banner = document.getElementById('session-date-banner');
  const label  = document.getElementById('session-date-text');
  if (!banner || !label) return;

  const STYLE = {
    PRE:     { color: '#d29922', border: 'rgba(210,153,34,.25)',  bg: 'rgba(210,153,34,.06)',  icon: '🌅' },
    REGULAR: { color: '#3fb950', border: 'rgba(63,185,80,.25)',   bg: 'rgba(63,185,80,.06)',   icon: '📈' },
    AFTER:   { color: '#f0883e', border: 'rgba(240,136,62,.25)',  bg: 'rgba(240,136,62,.06)',  icon: '🌆' },
    CLOSED:  { color: '#f59e0b', border: 'rgba(245,158,11,.18)',  bg: 'rgba(245,158,11,.06)',  icon: '📅' },
  };

  const s = STYLE[marketState] ?? STYLE.CLOSED;

  // ET 기준 오늘 날짜
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));

  let dateStr, stateStr;

  if (marketState === 'CLOSED') {
    // 다음 거래일 계산 (주말 스킵)
    const next = new Date(etNow);
    next.setHours(0, 0, 0, 0);
    do { next.setDate(next.getDate() + 1); }
    while (next.getDay() === 0 || next.getDay() === 6);
    dateStr  = next.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
    stateStr = '장 마감이므로 다음 거래일(';
  } else {
    dateStr  = etNow.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
    const STATE_LABEL = { PRE: '프리마켓', REGULAR: '정규장', AFTER: '애프터마켓' };
    stateStr = STATE_LABEL[marketState] ?? '';
  }

  label.textContent = `${stateStr} ${dateStr} )의 옵션데이터를 표시합니다`;
  banner.style.color       = s.color;
  banner.style.borderColor = s.border;
  banner.style.background  = s.bg;
  banner.style.display     = 'block';
  document.getElementById('session-date-icon').textContent = s.icon;
}

// ── 장 상태 이벤트 처리 ───────────────────────────────────
window.addEventListener('marketStateChanged', ({ detail }) => {
  const { marketState, prevState } = detail;
  state.marketState = marketState;
  updateSessionBanner(marketState);

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

// live 탭 초기화 → tick 콜백 등록까지 완료 후 나머지 실행
(async () => {
  await initLive();  // registerTickCallback 등록까지 보장
  fetchAndRender();  // 최초 1회 무조건 로드 (장 상태 무관)
})();
