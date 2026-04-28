// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// heatmap.js — DEX Strike 히트맵 렌더러
//
// 사용법:
//   renderHeatmap(containerId, strikes, spotPrice)
//
// strikes: KV dex:spy:0dte.strikes 배열 (Call/Put 미합산 raw)
//   [{ strike, type, dex, gex, vanna, charm }, ...]
//
// 내부 처리:
//   1. strike 기준 Call+Put 합산
//   2. spot ±8% 필터링
//   3. 낮은 → 높은 순 정렬
//   4. DEX 색상 히트맵 렌더링
//   5. 최초 1회만 현재가 위치로 스크롤
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── 스크롤 초기화 플래그 (containerId별 관리) ─────────────
const _scrollInitialized = {};

// ── DEX 값 → 배경색 ──────────────────────────────────────
// 양수: 녹색 (딜러 매수 헤지), 음수: 빨간색 (딜러 매도 헤지)
function _dexColor(value, maxAbs) {
  if (!value || maxAbs === 0) return 'transparent';
  const opacity = Math.min(Math.abs(value) / maxAbs, 1) * 0.85;
  return value > 0
    ? `rgba(34,197,94,${opacity.toFixed(2)})`   // --green
    : `rgba(239,68,68,${opacity.toFixed(2)})`;  // --red
}

// ── M단위 수치 포매터 ─────────────────────────────────────
function _fmtM(v) {
  if (v == null || isNaN(v)) return '—';
  const real = Number(v) * 1_000_000;
  const abs  = Math.abs(real);
  const sign = real >= 0 ? '+' : '-';
  if (abs >= 10_000_000) return sign + Math.round(abs / 1_000_000).toLocaleString() + 'M';
  if (abs >= 10_000)     return sign + Math.round(abs / 1_000).toLocaleString() + 'K';
  return sign + Math.round(abs).toLocaleString();
}

// ── strike 기준 Call+Put 합산 ─────────────────────────────
function _aggregateStrikes(strikes) {
  const map = {};
  for (const row of strikes) {
    const k = row.strike;
    if (!map[k]) {
      map[k] = { strike: k, dex: 0, gex: 0, vanna: 0, charm: 0 };
    }
    map[k].dex   += row.dex   || 0;
    map[k].gex   += row.gex   || 0;
    map[k].vanna += row.vanna || 0;
    map[k].charm += row.charm || 0;
  }
  return Object.values(map).sort((a, b) => a.strike - b.strike);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// renderHeatmap — 진입점
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function renderHeatmap(containerId, strikes, spotPrice) {
  const el = document.getElementById(containerId);
  if (!el) return;

  // 데이터 없음
  if (!strikes || strikes.length === 0) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px">히트맵 데이터 없음</div>';
    return;
  }

  // 1. 합산
  const aggregated = _aggregateStrikes(strikes);

  /* // 2. spot ±8% 필터링
  const filtered = aggregated.filter(
    (s) => Math.abs(s.strike - spotPrice) / spotPrice < 0.08
  );

  if (filtered.length === 0) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px">표시할 행사가 없음 (±8% 범위)</div>';
    return;
  } */

  // 수정 후 — filtered 대신 aggregated 그대로 사용
  const filtered = aggregated;  // 전범위
  
  // 3. DEX 최대 절대값 (색상 정규화용)
  const maxAbsDex = Math.max(...filtered.map((s) => Math.abs(s.dex)));

  // 4. 현재가에 가장 가까운 열 인덱스
  const spotIdx = filtered.reduce((best, s, i) =>
    Math.abs(s.strike - spotPrice) < Math.abs(filtered[best].strike - spotPrice) ? i : best
  , 0);

  // ── 레이아웃 상수 ─────────────────────────────────────
  const COL_W    = 72;   // 데이터 열 너비 px
  const LBL_W    = 52;   // sticky 라벨 열 너비 px
  const ROW_H_SM = 28;   // Strike / GEX / Vanna / Charm 행
  const ROW_H_LG = 52;   // DEX 히트맵 행

  // ── 공통 sticky 라벨 셀 ──────────────────────────────
  const stickyCell = (html, height) =>
    `<td style="
      position:sticky;left:0;z-index:2;
      min-width:${LBL_W}px;max-width:${LBL_W}px;height:${height}px;
      padding:0 6px;font-size:10px;font-weight:600;
      color:var(--text3);background:var(--bg,#0d1117);
      border-right:2px solid var(--border);
      white-space:nowrap;vertical-align:middle;text-align:right;
    ">${html}</td>`;

  // ── 행 생성 헬퍼 ─────────────────────────────────────
  const spotBorder = 'border-left:1px solid rgba(255,255,255,.3);border-right:1px solid rgba(255,255,255,.3);';

  // Strike 행
  const strikeRow = filtered.map((s, i) => {
    const isSpot = i === spotIdx;
    return `<td style="
      min-width:${COL_W}px;max-width:${COL_W}px;height:${ROW_H_SM}px;
      text-align:center;font-size:11px;font-family:var(--mono);
      color:${isSpot ? '#fff' : 'var(--text2)'};
      font-weight:${isSpot ? '700' : '400'};
      background:${isSpot ? 'rgba(255,255,255,.08)' : 'transparent'};
      border-right:1px solid var(--border);
      ${isSpot ? spotBorder : ''}
    ">${s.strike.toFixed(0)}</td>`;
  }).join('');

  // DEX 히트맵 행
  const dexRow = filtered.map((s, i) => {
    const isSpot = i === spotIdx;
    const bg     = _dexColor(s.dex, maxAbsDex);
    const color  = s.dex >= 0 ? '#22c55e' : '#ef4444';
    return `<td style="
      min-width:${COL_W}px;max-width:${COL_W}px;height:${ROW_H_LG}px;
      text-align:center;font-size:12px;font-weight:700;font-family:var(--mono);
      color:${color};background:${bg};
      border-right:1px solid rgba(255,255,255,.06);
      ${isSpot ? spotBorder : ''}
    ">${_fmtM(s.dex)}</td>`;
  }).join('');

  // GEX 행
  const gexRow = filtered.map((s, i) => {
    const isSpot = i === spotIdx;
    const color  = s.gex > 0 ? '#22c55e' : s.gex < 0 ? '#ef4444' : 'var(--text3)';
    return `<td style="
      min-width:${COL_W}px;max-width:${COL_W}px;height:${ROW_H_SM}px;
      text-align:center;font-size:11px;font-family:var(--mono);
      color:${color};
      background:${isSpot ? 'rgba(255,255,255,.08)' : 'transparent'};
      border-right:1px solid var(--border);
      ${isSpot ? spotBorder : ''}
    ">${_fmtM(s.gex)}</td>`;
  }).join('');

  // Vanna 행
  const vannaRow = filtered.map((s, i) => {
    const isSpot = i === spotIdx;
    return `<td style="
      min-width:${COL_W}px;max-width:${COL_W}px;height:${ROW_H_SM}px;
      text-align:center;font-size:11px;font-family:var(--mono);
      color:#a78bfa;
      background:${isSpot ? 'rgba(255,255,255,.08)' : 'transparent'};
      border-right:1px solid var(--border);
      ${isSpot ? spotBorder : ''}
    ">${_fmtM(s.vanna)}</td>`;
  }).join('');

  // Charm 행
  const charmRow = filtered.map((s, i) => {
    const isSpot = i === spotIdx;
    return `<td style="
      min-width:${COL_W}px;max-width:${COL_W}px;height:${ROW_H_SM}px;
      text-align:center;font-size:11px;font-family:var(--mono);
      color:#2dd4bf;
      background:${isSpot ? 'rgba(255,255,255,.08)' : 'transparent'};
      border-right:1px solid var(--border);
      ${isSpot ? spotBorder : ''}
    ">${_fmtM(s.charm)}</td>`;
  }).join('');

  // ── 전체 HTML 조립 ────────────────────────────────────
  const scrollId = `hm-scroll-${containerId}`;
  const totalW   = filtered.length * COL_W + LBL_W;

  el.innerHTML = `
    <div style="overflow-x:auto;overflow-y:hidden;
                border-top:1px solid var(--border);
                border-bottom:1px solid var(--border)"
         id="${scrollId}">
      <table style="border-collapse:collapse;table-layout:fixed;width:${totalW}px">
        <tbody>
          <tr>${stickyCell('Strike', ROW_H_SM)}${strikeRow}</tr>
          <tr>${stickyCell('DEX', ROW_H_LG)}${dexRow}</tr>
          <tr>${stickyCell('GEX', ROW_H_SM)}${gexRow}</tr>
          <tr>${stickyCell('Vanna', ROW_H_SM)}${vannaRow}</tr>
          <tr>${stickyCell('Charm', ROW_H_SM)}${charmRow}</tr>
        </tbody>
      </table>
    </div>
    <div style="padding:4px 8px 0;display:flex;justify-content:space-between;font-size:10px;color:var(--text3)">
      <span>■ 녹색: 딜러 매수 헤지 &nbsp;■ 빨간색: 딜러 매도 헤지</span>
      <span>색상 농도 = 헤징 압력 강도</span>
    </div>`;

  // ── 최초 1회만 현재가 위치로 스크롤 ─────────────────
  if (!_scrollInitialized[containerId]) {
    requestAnimationFrame(() => {
      const scrollEl = document.getElementById(scrollId);
      if (!scrollEl) return;
      // spot 열의 중앙이 컨테이너 중앙에 오도록
      const colOffset = LBL_W + spotIdx * COL_W;
      const containerW = scrollEl.clientWidth;
      scrollEl.scrollLeft = colOffset - containerW / 2 + COL_W / 2;
      _scrollInitialized[containerId] = true;
    });
  }
}
