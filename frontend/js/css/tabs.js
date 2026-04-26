/**
 * tabs.js — 탭 전환 오케스트레이터
 *
 * 핵심 원칙:
 *  - 패널을 display:none 으로 숨기지 않는다
 *    → position:absolute + translateX(-9999px) 로 오프스크린 이동
 *    → canvas가 DOM에 살아있어 Chart.js 치수가 유지됨
 *  - 탭별 init 함수는 최초 1회만 실행 (캐시 플래그)
 *  - 이후 재방문 시에는 refresh 함수만 호출 (데이터 갱신)
 */

import { initLive, refreshLive }           from './tabs/live.js';
import { initStructure, refreshStructure } from './tabs/structure.js';
import { initScreener, refreshScreener }   from './tabs/screener.js';
import { initChart,    refreshChart }      from './tabs/chart.js';

/* ── 탭 → 함수 맵 ──────────────────────────── */
const TAB_HANDLERS = {
  live:      { init: initLive,      refresh: refreshLive      },
  structure: { init: initStructure, refresh: refreshStructure },
  screener:  { init: initScreener,  refresh: refreshScreener  },
  chart:     { init: initChart,     refresh: refreshChart     },
};

/* 최초 초기화 완료 여부 */
const _initialized = {
  live: false,
  structure: false,
  screener: false,
  chart: false,
};

/* 현재 활성 탭 */
let _activeTab = 'live';

/* ── 공개 API ───────────────────────────────── */

/**
 * 탭 시스템 초기화 — main.js에서 DOMContentLoaded 후 1회 호출
 */
export function initTabs() {
  const buttons = document.querySelectorAll('.tab-btn');

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      if (tabId === _activeTab) return;
      _switchTab(tabId);
    });
  });

  /* 초기 탭 활성화 */
  _switchTab('live');
}

/**
 * 외부에서 탭을 강제 전환할 때 사용
 * 예: screener.js 에서 "Chart 탭으로 이동" 버튼
 */
export function goToTab(tabId) {
  if (!(tabId in TAB_HANDLERS)) return;
  _switchTab(tabId);
}

/**
 * 현재 활성 탭 ID 반환
 */
export function getActiveTab() {
  return _activeTab;
}

/* ── 내부 로직 ─────────────────────────────── */

function _switchTab(tabId) {
  /* 1. 버튼 active 클래스 교체 */
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  /* 2. 패널 active 클래스 교체
        active → position:relative + visible
        나머지 → position:absolute + translateX(-9999px) */
  document.querySelectorAll('.tab-panel').forEach(panel => {
    const isTarget = panel.id === `tab-${tabId}`;
    panel.classList.toggle('active', isTarget);
  });

  /* 3. 탭 핸들러 실행 */
  const handler = TAB_HANDLERS[tabId];
  if (!handler) {
    console.warn(`[tabs] 핸들러 없음: ${tabId}`);
    _activeTab = tabId;
    return;
  }

  if (!_initialized[tabId]) {
    /* 최초 방문: init 실행 */
    try {
      handler.init();
      _initialized[tabId] = true;
    } catch (e) {
      console.error(`[tabs] init 실패 (${tabId}):`, e);
    }
  } else {
    /* 재방문: refresh 실행 (데이터만 갱신) */
    try {
      handler.refresh?.();
    } catch (e) {
      console.error(`[tabs] refresh 실패 (${tabId}):`, e);
    }
  }

  _activeTab = tabId;
}
