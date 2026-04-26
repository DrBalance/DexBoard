// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// fmt.js — 숫자 / 색상 포매터
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── 색상 상수 ─────────────────────────────────────────────
export const COLOR = {
  green:  '#22c55e',
  red:    '#ef4444',
  amber:  '#f59e0b',
  purple: '#a78bfa',
  teal:   '#2dd4bf',
  muted:  '#6b7280',
};

// ── 가격 표시 (소수점 2자리) ──────────────────────────────
// 예: 567.89
export function fmtPrice(v) {
  if (v == null || isNaN(v)) return '—';
  return Number(v).toFixed(2);
}

// ── 변화량 표시 (+/- 기호 포함) ──────────────────────────
// 예: +6.63  /  -2.10
export function fmtChange(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

// ── 변화율 표시 (+/- 기호 + %) ───────────────────────────
// 예: (+1.24%)  /  (-0.87%)
export function fmtChangePct(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  return `(${n >= 0 ? '+' : ''}${n.toFixed(2)}%)`;
}

// ── M단위 표시 (Greeks, GEX 등) ──────────────────────────
// 예: +1,234M  /  -567M
export function fmtM(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v) / 1_000_000;
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}M`;
}

// ── VOLD 표시 (M단위, 소수점 1자리) ─────────────────────
// 예: +12.3M  /  -5.7M
export function fmtVold(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v) / 1_000_000;
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}M`;
}

// ── 양/음 기준 색상 ───────────────────────────────────────
export function colorBySign(v) {
  if (v == null || isNaN(v)) return COLOR.muted;
  return Number(v) >= 0 ? COLOR.green : COLOR.red;
}

// ── VIX 기준 색상 ────────────────────────────────────────
// < 17: 녹색 / 17~25: amber / > 25: 빨간색
export function colorVix(v) {
  if (v == null || isNaN(v)) return COLOR.muted;
  const n = Number(v);
  if (n < 17)  return COLOR.green;
  if (n <= 25) return COLOR.amber;
  return COLOR.red;
}
