/**
 * tabs.js — 탭 전환 오케스트레이터
 *
 * 핵심 원칙:
 *  - 패널을 display:none 으로 숨기지 않음
 *    → position:absolute + translateX(-9999px) 오프스크린
 *    → canvas가 DOM에 살아있어 Chart.js 치수 유지
 *  - 탭별 init 함수는 최초 1회만 실행
 *  - 재방문 시 refresh 함수만 호출
 */

import { initLive,      refreshLive }      from './tabs/live.js';
import { initMarket,    refreshMarket }    from './tabs/market.js';
import { initStructure, refreshStructure } from './tabs/structure.js';
import { initScreener,  refreshScreener }  from './tabs/screener.js';
import { initChart,     refreshChart }     from './tabs/chart.js';

const TAB_HANDLERS = {
  live:      { init: initLive,      refresh: refreshLive      },
  market:    { init: initMarket,    refresh: refreshMarket    },
  structure: { init: initStructure, refresh: refreshStructure },
  screener:  { init: initScreener,  refresh: refreshScreener  },
  chart:     { init: initChart,     refresh: refreshChart     },
};

const _initialized = {
  live: false, market: false, structure: false, screener: false, chart: false,
};

let _activeTab = 'live';

// ── 공개 API ─────────────────────────────────────────────

export function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      if (tabId === _activeTab) return;
      _switchTab(tabId);
    });
  });
  _switchTab('live');
}

/**
 * bindToggle — toggle-group 안의 버튼들에 active 클래스 토글 + 콜백 호출
 */
export function bindToggle(groupId, onChange) {
  const group = document.getElementById(groupId);
  if (!group) return;

  group.addEventListener('click', (e) => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;

    group.querySelectorAll('.toggle-btn').forEach(b =>
      b.classList.remove('active')
    );
    btn.classList.add('active');

    onChange(btn.dataset.group);
  });
}

export function goToTab(tabId) {
  if (!(tabId in TAB_HANDLERS)) return;
  _switchTab(tabId);
}

export function getActiveTab() {
  return _activeTab;
}

// ── 내부 로직 ─────────────────────────────────────────────

function _switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tabId}`);
  });

  const handler = TAB_HANDLERS[tabId];
  if (!handler) { _activeTab = tabId; return; }

  if (!_initialized[tabId]) {
    try {
      handler.init();
      _initialized[tabId] = true;
    } catch (e) {
      console.error(`[tabs] init 실패 (${tabId}):`, e);
    }
  } else {
    try {
      handler.refresh?.();
    } catch (e) {
      console.error(`[tabs] refresh 실패 (${tabId}):`, e);
    }
  }

  _activeTab = tabId;
}
