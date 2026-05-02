// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// heatmap.js — DEX Strike 히트맵 렌더러
//
// 사용법:
//   renderHeatmap(containerId, strikes, spotPrice)   ← 옵션체인 갱신 시 (15분)
//   updateHeatmapSpot(containerId, spotPrice)        ← 가격만 갱신 시 (20초)
//
// strikes: KV dex:spy:0dte.strikes 배열 (Call/Put 미합산 raw)
//   [{ strike, type, dex, gex, vanna, charm }, ...]
//
// 내부 처리:
//   1. strike 기준 Call+Put 합산
//   2. 낮은 → 높은 순 정렬
//   3. DEX 색상 히트맵 렌더링
//   4. 최초 1회만 현재가 위치로 스크롤 (옵션체인 갱신 시 scrollLeft 복원)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── 레이아웃 상수 (updateHeatmapSpot에서도 참조) ──────────
const COL_W    = 72;
const LBL_W    = 15;
const ROW_H_SM = 28;
const ROW_H_LG = 52;

// ── 최초 스크롤 초기화 플래그 (containerId별 관리) ────────
const _scrollInitialized = {};

// ── GEX / Vanna / Charm 글씨 투명도 ──────────────────────
const SECONDARY_OPACITY = 0.5;

// ── 합산된 strikes 캐시 (containerId별) ──────────────────
// updateHeatmapSpot이 DOM 교체 없이 참조
const _cachedAggregated = {};

// ── DEX 값 → 배경색 ──────────────────────────────────────
function _dexColor(value, maxAbs) {
  if (!value || maxAbs === 0) return 'transparent';
  const opacity = Math.min(Math.abs(value) / maxAbs, 1);
  return value > 0
    ? `rgba(34,197,94,${opacity.toFixed(2)})`
    : `rgba(239,68,68,${opacity.toFixed(2)})`;
}

// ── M단위 수치 포매터 ─────────────────────────────────────
function _fmtM(v) {
  if (v == null || isNaN(v)) return '—';
  const real = Number(v) * 1_000_000;
  const abs  = Math.abs(real);
  const sign = real >= 0 ? '+' : '-';
  if (abs >= 10_000_000) return sign + Math.round(abs / 1_000_000).toLocaleString() + 'M';
  if (abs >= 100_000)     return sign + Math.round(abs / 1_000).toLocaleString() + 'K';
  return sign + Math.round(abs).toLocaleString();
}

// ── strike 기준 Call+Put 합산 ─────────────────────────────
function _aggregateStrikes(strikes) {
  const map = {};
  for (const row of strikes) {
    const k = row.strike;
    if (!map[k]) map[k] = { strike: k, dex: 0, gex: 0, vanna: 0, charm: 0 };
    map[k].dex   += row.dex   || 0;
    map[k].gex   += row.gex   || 0;
    map[k].vanna += row.vanna || 0;
    map[k].charm += row.charm || 0;
  }
  return Object.values(map).sort((a, b) => a.strike - b.strike);
}

// ── 현재가에 가장 가까운 열 인덱스 ──────────────────────
function _findSpotIdx(aggregated, spotPrice) {
  return aggregated.reduce((best, s, i) =>
    Math.abs(s.strike - spotPrice) < Math.abs(aggregated[best].strike - spotPrice) ? i : best
  , 0);
}

// ── spot 강조 스타일 DOM 직접 업데이트 ───────────────────
// data-col / data-row 속성으로 셀을 찾아 스타일만 교체
function _applySpotStyles(scrollEl, aggregated, spotIdx) {
  aggregated.forEach((_, i) => {
    const isSpot = i === spotIdx;
    const cells  = scrollEl.querySelectorAll(`[data-col="${i}"]`);

    cells.forEach(td => {
      const row = td.dataset.row;

      // spot 세로 강조 테두리 (전 행 공통)
      td.style.borderLeft  = isSpot ? '1px solid rgba(255,255,255,.3)' : '';
      td.style.borderRight = isSpot ? '1px solid rgba(255,255,255,.3)' : '';

      if (row === 'strike') {
        td.style.color      = isSpot ? '#fff' : 'var(--text2)';
        td.style.fontWeight = isSpot ? '700'  : '400';
        td.style.background = isSpot ? 'rgba(255,255,255,.08)' : 'transparent';
      } else if (row !== 'dex') {
        // gex / vanna / charm (dex는 배경색이 DEX값 기반이라 건드리지 않음)
        td.style.background = isSpot ? 'rgba(255,255,255,.08)' : 'transparent';
      }
    });
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// renderHeatmap — 옵션체인 갱신 시 전체 재렌더링 (15분 주기)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function renderHeatmap(containerId, strikes, spotPrice) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!strikes || strikes.length === 0) {
    el.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:8px">히트맵 데이터 없음</div>';
    return;
  }

  // 1. 합산 & 캐시
  const aggregated = _aggregateStrikes(strikes);
  _cachedAggregated[containerId] = aggregated;

  // 2. DEX 최대 절대값 (색상 정규화)
  const maxAbsDex = Math.max(...aggregated.map(s => Math.abs(s.dex)));

  // 3. 현재가 가장 가까운 열
  const spotIdx = _findSpotIdx(aggregated, spotPrice);

  // ── sticky 라벨 셀 헬퍼 ──────────────────────────────
  const stickyCell = (html, height) =>
    `<td style="
      position:sticky;left:0;z-index:2;
      min-width:${LBL_W}px;max-width:${LBL_W}px;height:${height}px;
      padding:0 6px;font-size:11px;font-weight:800;
      color:var(--text3);background:var(--bg,#0d1117);
      border-right:2px solid var(--border);
      white-space:nowrap;vertical-align:middle;text-align:right;
    ">${html}</td>`;

  const spotBorder = 'border-left:1px solid rgba(255,255,255,.3);border-right:1px solid rgba(255,255,255,.3);';

  // Strike 행
  const strikeRow = aggregated.map((s, i) => {
    const isSpot = i === spotIdx;
    return `<td data-col="${i}" data-row="strike" style="
      min-width:${COL_W}px;max-width:${COL_W}px;height:${ROW_H_SM}px;
      text-align:center;font-size:13px;font-family:var(--mono);
      color:${isSpot ? '#fff' : 'var(--text2)'};
      font-weight:${isSpot ? '700' : '400'};
      background:${isSpot ? 'rgba(255,255,255,.08)' : 'transparent'};
      border-right:1px solid var(--border);
      ${isSpot ? spotBorder : ''}
    ">${s.strike.toFixed(0)}</td>`;
  }).join('');

  // DEX 히트맵 행
  const dexRow = aggregated.map((s, i) => {
    const isSpot = i === spotIdx;
    return `<td data-col="${i}" data-row="dex" style="
      min-width:${COL_W}px;max-width:${COL_W}px;height:${ROW_H_LG}px;
      text-align:center;font-size:13px;font-weight:800;font-family:var(--mono);
      color:#ffffff;background:${_dexColor(s.dex, maxAbsDex)};
      border-right:1px solid rgba(255,255,255,.06);
      ${isSpot ? spotBorder : ''}
    ">${_fmtM(s.dex)}</td>`;
  }).join('');

  // GEX 행
  const gexRow = aggregated.map((s, i) => {
    const isSpot = i === spotIdx;
    const color  = s.gex > 0
      ? `rgba(34,197,94,${SECONDARY_OPACITY})`
      : s.gex < 0 ? `rgba(239,68,68,${SECONDARY_OPACITY})` : 'var(--text3)';
    return `<td data-col="${i}" data-row="gex" style="
      min-width:${COL_W}px;max-width:${COL_W}px;height:${ROW_H_SM}px;
      text-align:center;font-size:13px;font-family:var(--mono);
      color:${color};
      background:${isSpot ? 'rgba(255,255,255,.08)' : 'transparent'};
      border-right:1px solid var(--border);
      ${isSpot ? spotBorder : ''}
    ">${_fmtM(s.gex)}</td>`;
  }).join('');

  // Vanna 행
  const vannaRow = aggregated.map((s, i) => {
    const isSpot = i === spotIdx;
    return `<td data-col="${i}" data-row="vanna" style="
      min-width:${COL_W}px;max-width:${COL_W}px;height:${ROW_H_SM}px;
      text-align:center;font-size:13px;font-family:var(--mono);
      color:rgba(167,139,250,${SECONDARY_OPACITY});
      background:${isSpot ? 'rgba(255,255,255,.08)' : 'transparent'};
      border-right:1px solid var(--border);
      ${isSpot ? spotBorder : ''}
    ">${_fmtM(s.vanna)}</td>`;
  }).join('');

  // Charm 행
  const charmRow = aggregated.map((s, i) => {
    const isSpot = i === spotIdx;
    return `<td data-col="${i}" data-row="charm" style="
      min-width:${COL_W}px;max-width:${COL_W}px;height:${ROW_H_SM}px;
      text-align:center;font-size:13px;font-family:var(--mono);
      color:rgba(45,212,191,${SECONDARY_OPACITY});
      background:${isSpot ? 'rgba(255,255,255,.08)' : 'transparent'};
      border-right:1px solid var(--border);
      ${isSpot ? spotBorder : ''}
    ">${_fmtM(s.charm)}</td>`;
  }).join('');

  // ── 전체 HTML 조립 ────────────────────────────────────
  const scrollId = `hm-scroll-${containerId}`;
  const totalW   = aggregated.length * COL_W + LBL_W;

  // 재렌더 전 scrollLeft 기억 (최초가 아닐 때 복원용)
  const prevScrollLeft = _scrollInitialized[containerId]
    ? (document.getElementById(scrollId)?.scrollLeft ?? null)
    : null;

  el.innerHTML = `
    <div style="overflow-x:auto;overflow-y:hidden;
                border-top:1px solid var(--border);
                border-bottom:1px solid var(--border)"
         id="${scrollId}">
      <table style="border-collapse:collapse;table-layout:fixed;width:${totalW}px">
        <tbody>
          <tr>${stickyCell('Strike', ROW_H_SM)}${strikeRow}</tr>
          <tr>${stickyCell('DEX',    ROW_H_LG)}${dexRow}</tr>
          <tr>${stickyCell('GEX',    ROW_H_SM)}${gexRow}</tr>
          <tr>${stickyCell('Vanna',  ROW_H_SM)}${vannaRow}</tr>
          <tr>${stickyCell('Charm',  ROW_H_SM)}${charmRow}</tr>
        </tbody>
      </table>
    </div>
    <div style="padding:4px 8px 0;display:flex;justify-content:space-between;font-size:10px;color:var(--text3)">
      <span>■ 녹색: 딜러 매수 헤지 &nbsp;■ 빨간색: 딜러 매도 헤지</span>
      <span>색상 농도 = 헤징 압력 강도</span>
    </div>`;

  requestAnimationFrame(() => {
    const scrollEl = document.getElementById(scrollId);
    if (!scrollEl) return;

    if (prevScrollLeft !== null) {
      // 옵션체인 갱신 (15분): 사용자가 보던 위치 복원
      scrollEl.scrollLeft = prevScrollLeft;
    } else {
      // 최초 1회: spot 열이 컨테이너 중앙에 오도록
      const colOffset  = LBL_W + spotIdx * COL_W;
      const containerW = scrollEl.clientWidth;
      scrollEl.scrollLeft = colOffset - containerW / 2 + COL_W / 2;
      _scrollInitialized[containerId] = true;
    }
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// updateHeatmapSpot — 가격만 갱신 시 spot 강조만 업데이트 (20초)
// DOM 교체 없음 → 스크롤 위치 완전 유지
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function updateHeatmapSpot(containerId, spotPrice) {
  const aggregated = _cachedAggregated[containerId];
  if (!aggregated || !aggregated.length) return;  // renderHeatmap 미호출 시 무시

  const scrollId = `hm-scroll-${containerId}`;
  const scrollEl = document.getElementById(scrollId);
  if (!scrollEl) return;

  const spotIdx = _findSpotIdx(aggregated, spotPrice);
  _applySpotStyles(scrollEl, aggregated, spotIdx);
}
