// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// heatmap.js — DEX Strike 히트맵 렌더러
//
// 공개 API:
//   renderHeatmap(containerId, strikes, spotPrice)
//   updateHeatmapSpot(containerId, spotPrice)
//   setHeatmapVix(series)
//
// 행 구조 (위→아래):
//   Strike / Marker / D·Van / D·Chr / DEX / GEX / Vanna / Charm
//
// 스타일 규칙:
//   - 모든 행 글자 크기·투명도 동일 (font-size:13px)
//   - DEX: 배경 없음, +초록 / -빨강 (GEX와 동일)
//   - D·Van: 배경 없음, 색상은 Vanna(보라)와 동일
//   - D·Chr: 배경 없음, 색상은 Charm(틸)과 동일
//   - Marker: 배경 음영만 (D-Vanna 절대값 비례, 최소 30% 보장)
//             글자 없음(천정·바닥·변곡·참↑ 텍스트만)
//
// 마커 종류 (한글):
//   천정 — 현재가 속한 마커색 블록의 오른쪽 끝 경계
//   바닥 — 현재가 속한 마커색 블록의 왼쪽 끝 경계
//   변곡 — D-Vanna 절대값 상위 5%
//   참↑  — D-Vanna 부호 전환 지점
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── 레이아웃 상수 ─────────────────────────────────────────
const COL_W      = 72;
const LBL_W      = 38;
const ROW_H_SM   = 28;   // Strike / DEX / GEX / Vanna / Charm
const ROW_H_MK   = 14;   // Marker (납작하게)
const ROW_H_DG   = 28;   // D·Van / D·Chr

// ── 글자 투명도 (모든 행 동일) ───────────────────────────
const TEXT_OPACITY = 0.5;

// ── 모듈 상태 ─────────────────────────────────────────────
const _scrollInitialized = {};
const _cachedAggregated  = {};
let   _vixSeries         = [];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 공개 API: VIX 시계열 주입
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function setHeatmapVix(series) {
  if (!Array.isArray(series)) return;
  _vixSeries = [...series].sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VIX 기울기 (최신값 - N분 전 값)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _calcVixSlope(minutes) {
  if (_vixSeries.length < 2) return 0;
  const last     = _vixSeries[_vixSeries.length - 1];
  const targetMs = new Date(last.ts).getTime() - minutes * 60_000;
  let ref = _vixSeries[0];
  for (const p of _vixSeries) {
    if (new Date(p.ts).getTime() <= targetMs) ref = p;
    else break;
  }
  return last.v - ref.v;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// D-Vanna / D-Charm 계산 + 도미넌스 판별
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _calcDGreeks(aggregated) {
  const slope5m  = _calcVixSlope(5);
  const vixSign  = slope5m >= 0 ? 1 : -1;

  const totalDex   = aggregated.reduce((s, r) => s + r.dex,   0);
  const totalVanna = aggregated.reduce((s, r) => s + r.vanna, 0);
  const isDexDom   = Math.abs(totalDex) > Math.abs(totalVanna) * 1.5;

  return aggregated.map(r => {
    let dVanna, dCharm;
    if (isDexDom) {
      const sign = r.dex >= 0 ? 1 : -1;
      dVanna = sign * Math.abs(r.vanna);
      dCharm = sign * Math.abs(r.charm);
    } else {
      dVanna = r.vanna * (-vixSign);
      dCharm = r.charm * (-vixSign);
    }
    return { ...r, dVanna, dCharm, isDexDom };
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 마커 색상 분류 (D-Vanna + D-Charm 부호 조합)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _markerColorType(dVanna, dCharm) {
  const vPos = dVanna > 0, cPos = dCharm > 0;
  if (vPos && cPos)   return 'green';
  if (!vPos && !cPos) return 'red';
  return 'yellow';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 마커행 배경색
// D-Vanna 절대값 비례 투명도, 최솟값 30% 보장
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _markerBg(dVanna, dCharm, maxAbsDVanna) {
  const type = _markerColorType(dVanna, dCharm);
  const MIN_OP  = 0.30;
  const MAX_OP  = 0.85;
  const ratio   = maxAbsDVanna > 0
    ? Math.min(Math.abs(dVanna) / maxAbsDVanna, 1)
    : 0;
  const op = (MIN_OP + ratio * (MAX_OP - MIN_OP)).toFixed(2);

  if (type === 'green')  return `rgba(34,197,94,${op})`;
  if (type === 'red')    return `rgba(239,68,68,${op})`;
  return `rgba(245,158,11,${op})`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 마커 텍스트 분류
//   천정/바닥: 현재가가 속한 색상 블록의 오른쪽/왼쪽 끝
//   변곡: D-Vanna 절대값 상위 5%
//   참↑: D-Vanna 부호 전환 지점
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _classifyMarkers(rows, spotIdx) {
  const n = rows.length;

  // 상위 5% 절대값 임계치
  const absVals  = rows.map(r => Math.abs(r.dVanna)).sort((a, b) => b - a);
  const top5Thr  = absVals[Math.max(0, Math.floor(absVals.length * 0.05) - 1)] ?? 0;

  // 참↑: D-Vanna와 D-Charm 부호가 서로 다른 지점 (= 마커색 노랑)
  const flipSet = new Set();
  for (let i = 0; i < n; i++) {
    if (_markerColorType(rows[i].dVanna, rows[i].dCharm) === 'yellow') {
      flipSet.add(i);
    }
  }

  // 현재가 블록 경계 탐색
  // 현재가 스트라이크의 색상 타입(green/red/yellow)과 연속된 구간 찾기
  const spotType = _markerColorType(rows[spotIdx].dVanna, rows[spotIdx].dCharm);

  // 왼쪽 끝(바닥): spotIdx에서 왼쪽으로 같은 타입이 계속되는 마지막 인덱스
  let floorIdx = spotIdx;
  for (let i = spotIdx - 1; i >= 0; i--) {
    if (_markerColorType(rows[i].dVanna, rows[i].dCharm) === spotType) floorIdx = i;
    else break;
  }

  // 오른쪽 끝(천정): spotIdx에서 오른쪽으로 같은 타입이 계속되는 마지막 인덱스
  let ceilIdx = spotIdx;
  for (let i = spotIdx + 1; i < n; i++) {
    if (_markerColorType(rows[i].dVanna, rows[i].dCharm) === spotType) ceilIdx = i;
    else break;
  }

  return rows.map((r, i) => {
    const labels = [];

    if (i === ceilIdx && ceilIdx !== floorIdx) labels.push('천정');
    if (i === floorIdx && ceilIdx !== floorIdx) labels.push('바닥');
    if (flipSet.has(i)) labels.push('참↑');
    // 변곡: 천정/바닥/참↑이 없는 곳만, 상위 5%
    if (!labels.length && Math.abs(r.dVanna) >= top5Thr && top5Thr > 0)
      labels.push('변곡');

    return { ...r, markerLabels: labels, _top5Thr: top5Thr, _flipSet: flipSet };
  });
}

// ── M단위 수치 포매터 ─────────────────────────────────────
function _fmtM(v) {
  if (v == null || isNaN(v)) return '—';
  const real = Number(v) * 1_000_000;
  const abs  = Math.abs(real);
  const sign = real >= 0 ? '+' : '-';
  if (abs >= 10_000_000) return sign + Math.round(abs / 1_000_000).toLocaleString() + 'M';
  if (abs >= 100_000)    return sign + Math.round(abs / 1_000).toLocaleString() + 'K';
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
function _findSpotIdx(rows, spotPrice) {
  return rows.reduce((best, s, i) =>
    Math.abs(s.strike - spotPrice) < Math.abs(rows[best].strike - spotPrice) ? i : best
  , 0);
}

// ── 드래그 스크롤 ─────────────────────────────────────────
function _attachDragScroll(el) {
  let isDown = false, startX = 0, scrollLeft = 0;
  el.addEventListener('mousedown', (e) => {
    isDown = true; el.style.cursor = 'grabbing';
    startX = e.pageX - el.offsetLeft; scrollLeft = el.scrollLeft;
  });
  el.addEventListener('mouseleave', () => { isDown = false; el.style.cursor = 'grab'; });
  el.addEventListener('mouseup',    () => { isDown = false; el.style.cursor = 'grab'; });
  el.addEventListener('mousemove',  (e) => {
    if (!isDown) return;
    e.preventDefault();
    el.scrollLeft = scrollLeft - (e.pageX - el.offsetLeft - startX) * 1.2;
  });
  let touchStartX = 0, touchScrollLeft = 0;
  el.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].pageX; touchScrollLeft = el.scrollLeft;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    el.scrollLeft = touchScrollLeft + (touchStartX - e.touches[0].pageX);
  }, { passive: true });
  el.style.cursor = 'grab';
}

// ── spot 강조 DOM 직접 업데이트 ───────────────────────────
function _applySpotStyles(scrollEl, rows, spotIdx) {
  rows.forEach((_, i) => {
    const isSpot = i === spotIdx;
    scrollEl.querySelectorAll(`[data-col="${i}"]`).forEach(td => {
      const row = td.dataset.row;
      td.style.borderLeft  = isSpot ? '1px solid rgba(255,255,255,.3)' : '';
      td.style.borderRight = isSpot ? '1px solid rgba(255,255,255,.3)' : '';
      if (row === 'strike') {
        td.style.color      = isSpot ? '#fff' : 'var(--text2)';
        td.style.fontWeight = isSpot ? '700'  : '400';
        td.style.background = isSpot ? 'rgba(255,255,255,.08)' : 'transparent';
      } else if (['gex','vanna','charm','dex','dvanna','dcharm'].includes(row)) {
        td.style.background = isSpot ? 'rgba(255,255,255,.06)' : 'transparent';
      }
      // marker 행은 배경이 자체 계산값이므로 건드리지 않음
    });
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// renderHeatmap
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function renderHeatmap(containerId, strikes, spotPrice) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!strikes || strikes.length === 0) {
    el.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:8px">히트맵 데이터 없음</div>';
    return;
  }

  // 1. 합산 → D-Greeks
  const aggregated = _aggregateStrikes(strikes);
  const withD      = _calcDGreeks(aggregated);

  // 2. spot 인덱스 (마커 분류에 필요)
  const spotIdx = _findSpotIdx(withD, spotPrice);

  // 3. 마커 분류 (spotIdx 전달)
  const rows = _classifyMarkers(withD, spotIdx);
  _cachedAggregated[containerId] = rows;

  // 4. 정규화 기준
  const maxAbsDVanna = Math.max(...rows.map(s => Math.abs(s.dVanna)));
  const maxAbsDCharm = Math.max(...rows.map(s => Math.abs(s.dCharm)));

  // 5. VIX 기울기 (범례용)
  const slope5m  = _calcVixSlope(5);
  const slope15m = _calcVixSlope(15);
  const hasVix   = _vixSeries.length >= 2;
  const isDexDom = rows[0]?.isDexDom ?? false;

  const spotBdr = 'border-left:1px solid rgba(255,255,255,.3);border-right:1px solid rgba(255,255,255,.3);';

  // ── sticky 라벨 셀 ────────────────────────────────────
  const stickyCell = (html, h, extraStyle = '') =>
    `<td style="
      position:sticky;left:0;z-index:2;
      min-width:${LBL_W}px;max-width:${LBL_W}px;height:${h}px;
      padding:0 4px 0 2px;font-size:10px;font-weight:800;
      color:var(--text3);background:var(--bg2,#181c24);
      border-right:2px solid var(--border2,rgba(255,255,255,.12));
      white-space:nowrap;vertical-align:middle;text-align:right;
      ${extraStyle}
    ">${html}</td>`;

  // ── 데이터 셀 헬퍼 ────────────────────────────────────
  const mkCell = (i, row, h, style, content) =>
    `<td data-col="${i}" data-row="${row}" style="
      min-width:${COL_W}px;max-width:${COL_W}px;height:${h}px;
      text-align:center;font-family:var(--mono);
      ${style}
      ${i === spotIdx ? spotBdr : ''}
    ">${content}</td>`;

  // ── Strike 행 ─────────────────────────────────────────
  const strikeRow = rows.map((s, i) => mkCell(i, 'strike', ROW_H_SM,
    `font-size:13px;
     color:${i === spotIdx ? '#fff' : 'var(--text2)'};
     font-weight:${i === spotIdx ? '700' : '400'};
     background:${i === spotIdx ? 'rgba(255,255,255,.08)' : 'transparent'};
     border-right:1px solid var(--border);`,
    s.strike.toFixed(0)
  )).join('');

  // ── Marker 행 (배경 음영만, 납작하게) ─────────────────
  const markerRow = rows.map((s, i) => {
    const bg    = _markerBg(s.dVanna, s.dCharm, maxAbsDVanna);
    const label = s.markerLabels.join('/');
    // 마커 텍스트 색: 배경과 대비되도록 흰색 고정
    return mkCell(i, 'marker', ROW_H_MK,
      `font-size:10px;font-weight:700;letter-spacing:-.3px;
       color:rgba(255,255,255,.9);background:${bg};
       border-right:1px solid rgba(255,255,255,.04);
       line-height:1;`,
      label
    );
  }).join('');

  // ── D·Van 행 (Vanna 색, 투명도 없음, 배경 없음) ───────
  const dVannaRow = rows.map((s, i) => mkCell(i, 'dvanna', ROW_H_DG,
    `font-size:13px;
     color:rgba(167,139,250,1);
     background:${i === spotIdx ? 'rgba(255,255,255,.06)' : 'transparent'};
     border-right:1px solid var(--border);`,
    _fmtM(s.dVanna)
  )).join('');

  // ── D·Chr 행 (Charm 색, 투명도 없음, 배경 없음) ────────
  const dCharmRow = rows.map((s, i) => mkCell(i, 'dcharm', ROW_H_DG,
    `font-size:13px;
     color:${s.dCharm >= 0 ? 'rgba(45,212,191,1)' : 'rgba(239,68,68,0.85)'};
     background:${i === spotIdx ? 'rgba(255,255,255,.06)' : 'transparent'};
     border-right:1px solid var(--border);`,
    _fmtM(s.dCharm)
  )).join('');

  // ── DEX 행 (GEX와 동일 스타일, 배경 없음) ─────────────
  const dexRow = rows.map((s, i) => {
    const c = s.dex > 0
      ? `rgba(34,197,94,${TEXT_OPACITY})`
      : s.dex < 0 ? `rgba(239,68,68,${TEXT_OPACITY})` : 'var(--text3)';
    return mkCell(i, 'dex', ROW_H_SM,
      `font-size:13px;color:${c};
       background:${i === spotIdx ? 'rgba(255,255,255,.06)' : 'transparent'};
       border-right:1px solid var(--border);`,
      _fmtM(s.dex)
    );
  }).join('');

  // ── GEX 행 ────────────────────────────────────────────
  const gexRow = rows.map((s, i) => {
    const c = s.gex > 0
      ? `rgba(34,197,94,${TEXT_OPACITY})`
      : s.gex < 0 ? `rgba(239,68,68,${TEXT_OPACITY})` : 'var(--text3)';
    return mkCell(i, 'gex', ROW_H_SM,
      `font-size:13px;color:${c};
       background:${i === spotIdx ? 'rgba(255,255,255,.06)' : 'transparent'};
       border-right:1px solid var(--border);`,
      _fmtM(s.gex)
    );
  }).join('');

  // ── Vanna 행 ──────────────────────────────────────────
  const vannaRow = rows.map((s, i) => mkCell(i, 'vanna', ROW_H_SM,
    `font-size:13px;color:rgba(167,139,250,${TEXT_OPACITY});
     background:${i === spotIdx ? 'rgba(255,255,255,.06)' : 'transparent'};
     border-right:1px solid var(--border);`,
    _fmtM(s.vanna)
  )).join('');

  // ── Charm 행 ──────────────────────────────────────────
  const charmRow = rows.map((s, i) => mkCell(i, 'charm', ROW_H_SM,
    `font-size:13px;color:rgba(45,212,191,${TEXT_OPACITY});
     background:${i === spotIdx ? 'rgba(255,255,255,.06)' : 'transparent'};
     border-right:1px solid var(--border);`,
    _fmtM(s.charm)
  )).join('');

  // ── 스크롤 위치 기억 ──────────────────────────────────
  const scrollId       = `hm-scroll-${containerId}`;
  const totalW         = rows.length * COL_W + LBL_W;
  const prevScrollLeft = _scrollInitialized[containerId]
    ? (document.getElementById(scrollId)?.scrollLeft ?? null)
    : null;

  // ── VIX 배지 ──────────────────────────────────────────
  const sc = (v) => v > 0 ? '#ef4444' : v < 0 ? '#22c55e' : '#9ca3af';
  const vixBadge = hasVix
    ? `<span style="display:inline-flex;align-items:center;gap:5px;
         padding:2px 7px;border-radius:3px;font-size:10px;
         background:rgba(255,255,255,.05);color:var(--text2);">
        ${isDexDom
          ? '<span style="color:#f59e0b;font-weight:700">DEX Dom</span>'
          : '<span style="color:#a78bfa">Vanna Dom</span>'}
        VIX 5m<span style="color:${sc(slope5m)}">${slope5m >= 0 ? '+' : ''}${slope5m.toFixed(2)}</span>
        15m<span style="color:${sc(slope15m)}">${slope15m >= 0 ? '+' : ''}${slope15m.toFixed(2)}</span>
      </span>`
    : `<span style="font-size:10px;color:var(--text3)">VIX 시계열 대기 중</span>`;

  // ── 조립 ──────────────────────────────────────────────
  el.innerHTML = `
    <div id="${scrollId}" style="
      overflow-x:auto;overflow-y:hidden;
      border-top:1px solid var(--border);
      border-bottom:1px solid var(--border);
    ">
      <table style="border-collapse:collapse;table-layout:fixed;width:${totalW}px">
        <tbody>
          <tr>${stickyCell('Strike', ROW_H_SM)}${strikeRow}</tr>
          <tr>${stickyCell('',       ROW_H_MK, 'border-right:2px solid var(--border2,rgba(255,255,255,.12))')}${markerRow}</tr>
          <tr>${stickyCell('D·Van',  ROW_H_DG, 'color:rgba(167,139,250,.8)')}${dVannaRow}</tr>
          <tr>${stickyCell('D·Chr',  ROW_H_DG, 'color:rgba(45,212,191,.8)')}${dCharmRow}</tr>
          <tr>${stickyCell('DEX',    ROW_H_SM)}${dexRow}</tr>
          <tr>${stickyCell('GEX',    ROW_H_SM)}${gexRow}</tr>
          <tr>${stickyCell('Vanna',  ROW_H_SM)}${vannaRow}</tr>
          <tr>${stickyCell('Charm',  ROW_H_SM)}${charmRow}</tr>
        </tbody>
      </table>
    </div>
    <div style="
      padding:5px 8px 3px;
      display:flex;align-items:center;justify-content:space-between;
      flex-wrap:wrap;gap:4px;
    ">
      <div style="display:flex;gap:8px;font-size:10px;color:var(--text3)">
        <span><span style="color:#22c55e">■</span> 딜러 매수헤지</span>
        <span><span style="color:#ef4444">■</span> 딜러 매도헤지</span>
        <span><span style="color:#f59e0b">■</span> 혼조</span>
        <span style="opacity:.6">천정·바닥=현재가 블록경계 변곡=상위5% 참↑=전환</span>
      </div>
      ${vixBadge}
    </div>`;

  // ── 스크롤 & 드래그 ───────────────────────────────────
  requestAnimationFrame(() => {
    const scrollEl = document.getElementById(scrollId);
    if (!scrollEl) return;

    if (prevScrollLeft !== null && prevScrollLeft > 0) {
      scrollEl.scrollLeft = prevScrollLeft;
    } else {
      const colOffset  = LBL_W + spotIdx * COL_W;
      const containerW = scrollEl.clientWidth;
      scrollEl.scrollLeft = colOffset - containerW / 2 + COL_W / 2;
      _scrollInitialized[containerId] = true;
    }

    if (!scrollEl._dragScrollBound) {
      _attachDragScroll(scrollEl);
      scrollEl._dragScrollBound = true;
    }
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// updateHeatmapSpot — spot 강조 + 마커 텍스트 재계산 (DOM 교체 없음)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function updateHeatmapSpot(containerId, spotPrice) {
  const rows = _cachedAggregated[containerId];
  if (!rows || !rows.length) return;

  const scrollEl = document.getElementById(`hm-scroll-${containerId}`);
  if (!scrollEl) return;

  const spotIdx = _findSpotIdx(rows, spotPrice);

  // ── spot 강조 스타일 ──────────────────────────────────
  _applySpotStyles(scrollEl, rows, spotIdx);

  // ── 마커 텍스트/배경 재계산 (천정/바닥은 현재가 기준) ─
  const maxAbsDVanna = Math.max(...rows.map(s => Math.abs(s.dVanna)));

  // top5Thr, flipSet은 rows[0]에 저장된 값 재사용
  const top5Thr = rows[0]?._top5Thr ?? 0;
  const flipSet = rows[0]?._flipSet ?? new Set();

  // 현재가 블록 경계 재탐색
  const spotType = _markerColorType(rows[spotIdx].dVanna, rows[spotIdx].dCharm);
  let floorIdx = spotIdx;
  for (let i = spotIdx - 1; i >= 0; i--) {
    if (_markerColorType(rows[i].dVanna, rows[i].dCharm) === spotType) floorIdx = i;
    else break;
  }
  let ceilIdx = spotIdx;
  for (let i = spotIdx + 1; i < rows.length; i++) {
    if (_markerColorType(rows[i].dVanna, rows[i].dCharm) === spotType) ceilIdx = i;
    else break;
  }

  // 마커 셀 DOM 직접 업데이트
  rows.forEach((r, i) => {
    const cell = scrollEl.querySelector(`[data-col="${i}"][data-row="marker"]`);
    if (!cell) return;

    const labels = [];
    if (i === ceilIdx  && ceilIdx !== floorIdx) labels.push('천정');
    if (i === floorIdx && ceilIdx !== floorIdx) labels.push('바닥');
    if (flipSet.has(i)) labels.push('참↑');
    if (!labels.length && Math.abs(r.dVanna) >= top5Thr && top5Thr > 0)
      labels.push('변곡');

    cell.textContent  = labels.join('/');
    cell.style.background = _markerBg(r.dVanna, r.dCharm, maxAbsDVanna);
  });
}
