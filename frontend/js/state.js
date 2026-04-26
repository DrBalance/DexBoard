// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// state.js — 전역 상태 단일 저장소
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const state = {
  // ── 장 상태 ─────────────────────────────────────────
  marketState: null,   // 'PRE' | 'REGULAR' | 'AFTER' | 'CLOSED'

  // ── KV 스냅샷 ────────────────────────────────────────
  snapshot: null,      // { spy, vix, updatedAt }
  snapPrev: null,      // 직전 스냅샷

  // ── 0DTE DEX 데이터 ──────────────────────────────────
  dex0: null,          // { gex_total, vanna_total, charm_total, strikes[], updatedAt }
  dexOpen: null,       // 장 시작 스냅샷 (options:spy:open)

  // ── Structure 탭 만기별 데이터 ───────────────────────
  struct: {
    weekly:    null,
    monthly:   null,
    quarterly: null,
  },

  // ── 탭 UI 상태 ───────────────────────────────────────
  activeGroup: 'weekly',   // Structure 탭 선택 만기
  chartGroup:  'weekly',   // Chart 탭 선택 만기

  // ── Chart.js 인스턴스 캐시 (탭 전환 시 재생성 방지) ──
  chartInstances: {
    live:      null,
    structure: null,
    chart:     null,
  },

  // ── 폴링 타이머 ──────────────────────────────────────
  snapTimer: null,
  fullTimer: null,
};
