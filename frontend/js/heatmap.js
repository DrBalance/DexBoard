// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// heatmap.js — DEX Strike 히트맵 렌더러
//
// 사용법:
//   renderHeatmap(containerId, strikes, spotPrice)   ← 옵션체인 갱신 시 (15분)
//   updateHeatmapSpot(containerId, spotPrice)        ← 가격만 갱신 시 (20초)
//   setHeatmapVix(series)                            ← VIX 시계열 주입 (1분)
//
// strikes: KV dex:spy:0dte.strikes 배열 (Call/Put 미합산 raw)
//   [{ strike, type, dex, gex, vanna, charm }, ...]
//
// 행 구조 (위→아래):
//   Strike  — 스트라이크 가격
//   Marker  — D-Vanna/D-Charm 도미넌스 컬러바 + 마커 텍스트
//   D-Van   — VIX 방향 × Vanna → 딜러 헤징 압력 음영
//   D-Chr   — VIX 방향 × Charm → 시간감쇠 헤징 압력 음영
//   DEX     — 딜러 델타 익스포저 히트맵
//   GEX     — 감마 익스포저
//   Vanna   — 변동성 민감도 (원시값)
//   Charm   — 시간감쇠 민감도 (원시값)
//
// 도미넌스 판별:
//   |DEX 총합| > |Vanna 총합| × 1.5  → DEX 도미넌스 (극단적 상황)
//   그 외                             → Vanna 도미넌스 (일상)
//
// D-Vanna / D-Charm (Vanna 도미넌스):
//   vixSign  = VIX 5분 기울기 부호 (+1 또는 -1)
//   D_Vanna  = vanna × (-vixSign)
//   D_Charm  = charm × (-vixSign)
//
// 마커 종류:
//   F — D-Vanna 최솟값 스트라이크 (바닥)
//   C — D-Vanna 최댓값 스트라이크 (천장)
//   G — D-Vanna 절대값 상위 20% 스트라이크 (변곡)
//   ↑ — D-Vanna 부호 전환 스트라이크 (전환)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── 레이아웃 상수 ─────────────────────────────────────────
const COL_W          = 72;
const LBL_W          = 38;   // 라벨 컬럼 너비 (D-Van 등 대응)
const ROW_H_SM       = 28;
const ROW_H_MD       = 32;   // Marker / D-Van / D-Chr 행
const ROW_H_LG       = 52;

// ── 투명도 ────────────────────────────────────────────────
const SECONDARY_OPACITY  = 0.5;
const DVANNA_MAX_OPACITY = 0.75;

// ── 모듈 상태 ─────────────────────────────────────────────
const _scrollInitialized = {};
const _cachedAggregated  = {};   // containerId → rows(D-Greeks 포함)

// VIX 1분봉 시계열 (live.js → setHeatmapVix로 주입)
let _vixSeries = [];   // [{ ts: ISO, v: number }, ...]

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 공개 API: VIX 시계열 주입
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function setHeatmapVix(series) {
  if (!Array.isArray(series)) return;
  _vixSeries = [...series].sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VIX 기울기 계산 (최신값 - N분 전 값)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _calcVixSlope(minutes) {
  if (_vixSeries.length < 2) return 0;
  const last     = _vixSeries[_vixSeries.length - 1];
  const nowMs    = new Date(last.ts).getTime();
  const targetMs = nowMs - minutes * 60_000;

  // targetMs 이전 포인트 중 가장 최신 것
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
  const vixSign  = slope5m >= 0 ? 1 : -1;   // VIX 상승=+1, 하락=-1

  const totalDex   = aggregated.reduce((s, r) => s + r.dex,   0);
  const totalVanna = aggregated.reduce((s, r) => s + r.vanna, 0);
  const isDexDom   = Math.abs(totalDex) > Math.abs(totalVanna) * 1.5;

  return aggregated.map(r => {
    let dVanna, dCharm;
    if (isDexDom) {
      // DEX 도미넌스: DEX 부호가 방향을 결정
      const sign = r.dex >= 0 ? 1 : -1;
      dVanna = sign * Math.abs(r.vanna);
      dCharm = sign * Math.abs(r.charm);
    } else {
      // Vanna 도미넌스: VIX 방향 반전 적용
      dVanna = r.vanna * (-vixSign);
      dCharm = r.charm * (-vixSign);
    }
    return { ...r, dVanna, dCharm, isDexDom };
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 마커 분류 (F / C / G / ↑)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _classifyMarkers(rows) {
  const absVals  = rows.map(r => Math.abs(r.dVanna)).sort((a, b) => b - a);
  const top20Thr = absVals[Math.floor(absVals.length * 0.2)] ?? 0;
  const minVal   = Math.min(...rows.map(r => r.dVanna));
  const maxVal   = Math.max(...rows.map(r => r.dVanna));

  return rows.map((r, i) => {
    const markers = [];
    if (r.dVanna === minVal) markers.push('F');
    if (r.dVanna === maxVal) markers.push('C');
    if (!markers.length && Math.abs(r.dVanna) >= top20Thr && top20Thr > 0)
      markers.push('G');
    if (i > 0) {
      const prev = rows[i - 1];
      if ((prev.dVanna > 0 && r.dVanna <= 0) ||
          (prev.dVanna < 0 && r.dVanna >= 0)) {
        markers.push('↑');
      }
    }
    return { ...r, markers };
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 색상 헬퍼
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _markerBg(dVanna, dCharm) {
  const vPos = dVanna > 0, cPos = dCharm > 0;
  if (vPos && cPos)   return 'rgba(34,197,94,0.18)';
  if (!vPos && !cPos) return 'rgba(239,68,68,0.18)';
  return 'rgba(245,158,11,0.13)';
}
function _markerColor(dVanna, dCharm) {
  const vPos = dVanna > 0, cPos = dCharm > 0;
  if (vPos && cPos)   return '#22c55e';
  if (!vPos && !cPos) return '#ef4444';
  return '#f59e0b';
}
function _dGradBg(value, maxAbs) {
  if (!value || maxAbs === 0) return 'transparent';
  const op = (Math.min(Math.abs(value) / maxAbs, 1) * DVANNA_MAX_OPACITY).toFixed(2);
  return value > 0
    ? `rgba(34,197,94,${op})`
    : `rgba(239,68,68,${op})`;
}
function _dexColor(value, maxAbs) {
  if (!value || maxAbs === 0) return 'transparent';
  const op = Math.min(Math.abs(value) / maxAbs, 1).toFixed(2);
  return value > 0
    ? `rgba(34,197,94,${op})`
    : `rgba(239,68,68,${op})`;
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
      } else if (row === 'gex' || row === 'vanna' || row === 'charm') {
        // D-Greeks / DEX / Marker 행은 자체 배경이 있어 건드리지 않음
        td.style.background = isSpot ? 'rgba(255,255,255,.08)' : 'transparent';
      }
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

  // 1. 합산 → D-Greeks → 마커
  const aggregated = _aggregateStrikes(strikes);
  const withD      = _calcDGreeks(aggregated);
  const rows       = _classifyMarkers(withD);
  _cachedAggregated[containerId] = rows;

  // 2. 정규화 기준
  const maxAbsDex    = Math.max(...rows.map(s => Math.abs(s.dex)));
  const maxAbsDVanna = Math.max(...rows.map(s => Math.abs(s.dVanna)));
  const maxAbsDCharm = Math.max(...rows.map(s => Math.abs(s.dCharm)));

  // 3. spot 열
  const spotIdx  = _findSpotIdx(rows, spotPrice);
  const spotBdr  = 'border-left:1px solid rgba(255,255,255,.3);border-right:1px solid rgba(255,255,255,.3);';

  // 4. VIX 기울기 (범례용)
  const slope5m  = _calcVixSlope(5);
  const slope15m = _calcVixSlope(15);
  const hasVix   = _vixSeries.length >= 2;
  const isDexDom = rows[0]?.isDexDom ?? false;

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

  // ── 행 생성 헬퍼 ──────────────────────────────────────
  const mkCell = (i, row, h, style, content) =>
    `<td data-col="${i}" data-row="${row}" style="
      min-width:${COL_W}px;max-width:${COL_W}px;height:${h}px;
      text-align:center;font-family:var(--mono);
      ${style}
      ${i === spotIdx ? spotBdr : ''}
    ">${content}</td>`;

  // Strike 행
  const strikeRow = rows.map((s, i) => mkCell(i, 'strike', ROW_H_SM,
    `font-size:13px;
     color:${i === spotIdx ? '#fff' : 'var(--text2)'};
     font-weight:${i === spotIdx ? '700' : '400'};
     background:${i === spotIdx ? 'rgba(255,255,255,.08)' : 'transparent'};
     border-right:1px solid var(--border);`,
    s.strike.toFixed(0)
  )).join('');

  // Marker 행
  const markerRow = rows.map((s, i) => mkCell(i, 'marker', ROW_H_MD,
    `font-size:11px;font-weight:700;
     color:${_markerColor(s.dVanna, s.dCharm)};
     background:${_markerBg(s.dVanna, s.dCharm)};
     border-right:1px solid var(--border);`,
    s.markers.join('') || ''
  )).join('');

  // D-Vanna 행
  const dVannaRow = rows.map((s, i) => mkCell(i, 'dvanna', ROW_H_MD,
    `font-size:11px;color:rgba(255,255,255,.75);
     background:${_dGradBg(s.dVanna, maxAbsDVanna)};
     border-right:1px solid rgba(255,255,255,.04);`,
    _fmtM(s.dVanna)
  )).join('');

  // D-Charm 행
  const dCharmRow = rows.map((s, i) => mkCell(i, 'dcharm', ROW_H_MD,
    `font-size:11px;color:rgba(255,255,255,.75);
     background:${_dGradBg(s.dCharm, maxAbsDCharm)};
     border-right:1px solid rgba(255,255,255,.04);`,
    _fmtM(s.dCharm)
  )).join('');

  // DEX 행
  const dexRow = rows.map((s, i) => mkCell(i, 'dex', ROW_H_LG,
    `font-size:13px;font-weight:800;color:#fff;
     background:${_dexColor(s.dex, maxAbsDex)};
     border-right:1px solid rgba(255,255,255,.06);`,
    _fmtM(s.dex)
  )).join('');

  // GEX 행
  const gexRow = rows.map((s, i) => {
    const c = s.gex > 0
      ? `rgba(34,197,94,${SECONDARY_OPACITY})`
      : s.gex < 0 ? `rgba(239,68,68,${SECONDARY_OPACITY})` : 'var(--text3)';
    return mkCell(i, 'gex', ROW_H_SM,
      `font-size:13px;color:${c};
       background:${i === spotIdx ? 'rgba(255,255,255,.08)' : 'transparent'};
       border-right:1px solid var(--border);`,
      _fmtM(s.gex)
    );
  }).join('');

  // Vanna 행
  const vannaRow = rows.map((s, i) => mkCell(i, 'vanna', ROW_H_SM,
    `font-size:13px;color:rgba(167,139,250,${SECONDARY_OPACITY});
     background:${i === spotIdx ? 'rgba(255,255,255,.08)' : 'transparent'};
     border-right:1px solid var(--border);`,
    _fmtM(s.vanna)
  )).join('');

  // Charm 행
  const charmRow = rows.map((s, i) => mkCell(i, 'charm', ROW_H_SM,
    `font-size:13px;color:rgba(45,212,191,${SECONDARY_OPACITY});
     background:${i === spotIdx ? 'rgba(255,255,255,.08)' : 'transparent'};
     border-right:1px solid var(--border);`,
    _fmtM(s.charm)
  )).join('');

  // ── 스크롤 위치 기억 ──────────────────────────────────
  const scrollId     = `hm-scroll-${containerId}`;
  const totalW       = rows.length * COL_W + LBL_W;
  const prevScrollLeft = _scrollInitialized[containerId]
    ? (document.getElementById(scrollId)?.scrollLeft ?? null)
    : null;

  // ── VIX 배지 ──────────────────────────────────────────
  const slopeColor = (v) => v > 0 ? '#ef4444' : v < 0 ? '#22c55e' : '#9ca3af';
  const vixBadge = hasVix
    ? `<span style="display:inline-flex;align-items:center;gap:4px;
         padding:2px 7px;border-radius:3px;font-size:10px;
         background:rgba(255,255,255,.05);color:var(--text2);">
        ${isDexDom
          ? '<span style="color:#f59e0b;font-weight:700">DEX Dom</span>'
          : '<span style="color:#a78bfa">Vanna Dom</span>'}
        &nbsp;VIX 5m<span style="color:${slopeColor(slope5m)}">${slope5m >= 0 ? '+' : ''}${slope5m.toFixed(2)}</span>
        15m<span style="color:${slopeColor(slope15m)}">${slope15m >= 0 ? '+' : ''}${slope15m.toFixed(2)}</span>
      </span>`
    : `<span style="font-size:10px;color:var(--text3)">VIX 시계열 수신 대기 중</span>`;

  // ── 조립 ──────────────────────────────────────────────
  el.innerHTML = `
    <div id="${scrollId}" style="
      overflow-x:auto;overflow-y:hidden;
      border-top:1px solid var(--border);
      border-bottom:1px solid var(--border);
    ">
      <table style="border-collapse:collapse;table-layout:fixed;width:${totalW}px">
        <tbody>
          <tr>${stickyCell('Strike',  ROW_H_SM)}${strikeRow}</tr>
          <tr>${stickyCell('Marker',  ROW_H_MD, 'font-size:9px')}${markerRow}</tr>
          <tr>${stickyCell('D·Van',   ROW_H_MD, 'color:rgba(34,197,94,.8)')}${dVannaRow}</tr>
          <tr>${stickyCell('D·Chr',   ROW_H_MD, 'color:rgba(45,212,191,.8)')}${dCharmRow}</tr>
          <tr>${stickyCell('DEX',     ROW_H_LG)}${dexRow}</tr>
          <tr>${stickyCell('GEX',     ROW_H_SM)}${gexRow}</tr>
          <tr>${stickyCell('Vanna',   ROW_H_SM)}${vannaRow}</tr>
          <tr>${stickyCell('Charm',   ROW_H_SM)}${charmRow}</tr>
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
        <span style="opacity:.6">F=바닥 C=천장 G=변곡 ↑=전환</span>
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
// updateHeatmapSpot — spot 강조만 업데이트 (DOM 교체 없음)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function updateHeatmapSpot(containerId, spotPrice) {
  const rows = _cachedAggregated[containerId];
  if (!rows || !rows.length) return;

  const scrollEl = document.getElementById(`hm-scroll-${containerId}`);
  if (!scrollEl) return;

  const spotIdx = _findSpotIdx(rows, spotPrice);
  _applySpotStyles(scrollEl, rows, spotIdx);
}
