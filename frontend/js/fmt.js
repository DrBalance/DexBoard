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
export function fmtPrice(v) {
  if (v == null || isNaN(v)) return '—';
  return Number(v).toFixed(2);
}

// ── 변화량 표시 (+/- 기호 포함) ──────────────────────────
export function fmtChange(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

// ── 변화율 표시 (+/- 기호 + %) ───────────────────────────
export function fmtChangePct(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  return `(${n >= 0 ? '+' : ''}${n.toFixed(2)}%)`;
}

// ── M단위 표시 (카드 메트릭 — 이미 M단위로 저장된 값) ────
export function fmtM(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}M`;
}

// ── VOLD 표시 (M단위, 소수점 1자리) ─────────────────────
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
export function colorVix(v) {
  if (v == null || isNaN(v)) return COLOR.muted;
  const n = Number(v);
  if (n < 17)  return COLOR.green;
  if (n <= 25) return COLOR.amber;
  return COLOR.red;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// fmt 객체 — oi-chart.js 등에서 import { fmt } 로 사용
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export const fmt = {

  // OI / 계약 수량  1234567 → "1.23M"
  oi(v) {
    if (v == null || isNaN(v)) return '—';
    const abs  = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (abs >= 1_000_000) return sign + (abs / 1_000_000).toFixed(2) + 'M';
    if (abs >= 1_000)     return sign + (abs / 1_000).toFixed(1) + 'K';
    return sign + abs.toLocaleString();
  },

  // Greeks (DEX / GEX / Vanna / Charm) — 테이블/데이터 표시용
  // 백만 이상일 때만 M단위, 나머지는 원래 숫자 그대로
  greek(v) {
    if (v == null || isNaN(v)) return '—';
    const abs  = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (abs >= 1_000_000) return sign + (abs / 1_000_000).toFixed(2) + 'M';
    return sign + abs.toFixed(2);
  },

  // 가격  595.23
  price(v, decimals = 2) {
    if (v == null || isNaN(v)) return '—';
    return Number(v).toFixed(decimals);
  },

  // 퍼센트  0.0342 → "+3.42%"
  pct(v, decimals = 2) {
    if (v == null || isNaN(v)) return '—';
    const sign = v > 0 ? '+' : '';
    return sign + (v * 100).toFixed(decimals) + '%';
  },

  // VIX
  vix(v) {
    if (v == null || isNaN(v)) return '—';
    return Number(v).toFixed(2);
  },

  // 타임스탬프 → "HH:MM ET"
  tsET(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d)) return '—';
    return d.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit',
      timeZone: 'America/New_York', hour12: false,
    }) + ' ET';
  },

  // 증감 (부호 포함 OI 포맷)
  delta(v) {
    if (v == null || isNaN(v)) return '—';
    const sign = v > 0 ? '+' : '';
    return sign + fmt.oi(Math.abs(v));
  },
};
