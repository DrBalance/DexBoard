// ── API Endpoints ─────────────────────────────────
export const CF_API         = 'https://drbalance-dex.weoncheonlee.workers.dev';
export const RAILWAY_WS_URL = 'wss://dexboard-production.up.railway.app/ws';
export const RAILWAY_URL    = 'https://dexboard-production.up.railway.app';
export const TWELVE_KEY     = '4fe9a71838f245e2957c0f41fdf213f8';  // market_state + OBV
export const CRON_SECRET    = "cron-secret-2026";

// ── Polling intervals ─────────────────────────────
export const INTERVAL_SNAP         = 60_000;       // 1분 (snapshot 갱신)
export const INTERVAL_FULL         = 15 * 60_000;  // 15분 (전체 데이터)
export const INTERVAL_MARKET_STATE = 5 * 60_000;   // 5분 (장 상태 체크)

// ── Market state styles ───────────────────────────
export const MARKET_STYLE = {
  REGULAR: { label: '정규장',     dot: '#3fb950', bg: 'rgba(63,185,80,.12)',   color: '#3fb950' },
  PRE:     { label: '프리마켓',   dot: '#d29922', bg: 'rgba(210,153,34,.12)',  color: '#d29922' },
  AFTER:   { label: '애프터마켓', dot: '#f0883e', bg: 'rgba(240,136,62,.12)',  color: '#f0883e' },
  CLOSED:  { label: '마감',       dot: '#6e7681', bg: 'rgba(110,118,129,.12)', color: '#6e7681' },
};

// ── Greeks colors ─────────────────────────────────
// DEX/GEX: green/red, Vanna: purple, Charm: teal
export const GREEK_COLORS = {
  vanna: '#a78bfa',   // --purple
  charm: '#2dd4bf',   // --teal
};
