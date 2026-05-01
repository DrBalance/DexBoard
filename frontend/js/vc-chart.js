// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// vc-chart.js — VIX + VOLD 듀얼 페인 SVG 차트 v2
//
// 구조:
//   상단 페인: VIX 1분봉 (Yahoo Finance via /api/vix-tick)
//   하단 페인: VOLD 누적 (RSP WebSocket 틱)
//
// 레이아웃:
//   [y축 고정 컬럼] | [공통 스크롤 컨테이너]
//                       ├─ vc-chart-vix SVG
//                       └─ vc-chart-vold SVG
//   → 스크롤 컨테이너가 1개이므로 VIX/VOLD 완전 동기화
//
// 시간축:
//   ET 04:00 ~ 17:00 고정 (780분), 미리 그려놓음
//   줌 버튼 = SVG width 배율만 변경 (재렌더 없음)
//   x축 레이블: KST HH:MM 표시
//
// 복원:
//   페이지 로드 시 /api/vix-tick → 당일 전체 1분봉 일괄 push
//
// 외부 호출:
//   initVCChart(containerId, cfApiBase)  → 초기화 + 복원
//   pushVixPoint(ts, value)              → VIX 포인트 추가 (ts: UTC ISO)
//   setVoldSeries(series)                → VOLD 전체 교체
//   pushVoldPoint(ts, value)             → VOLD 단일 추가
//   setVixPrevClose(value)               → 전일 종가 기준선
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── 레이아웃 상수 ─────────────────────────────────────────
const Y_W     = 38;   // y축 SVG 고정 너비 (px)
const PANE_H  = 180;  // VIX / VOLD 페인 높이 (px)
const XAXIS_H = 20;   // x축 전용 페인 높이 (px)
const PAD_T   = 8;    // 상단 여백
const PAD_B   = 4;    // 하단 여백

// ── 고정 시간축 ───────────────────────────────────────────
// ET 04:00 ~ 17:00 = 780분
const AXIS_START_ET_H = 4;   // 04:00 ET (프리마켓 시작)
const AXIS_END_ET_H   = 17;  // 17:00 ET (정규장 16:00 + 여백 1시간)
const AXIS_MINS       = (AXIS_END_ET_H - AXIS_START_ET_H) * 60; // 780분

// VOLD는 정규장(09:30 ET)부터만 그림
const VOLD_START_ET_H = 9;
const VOLD_START_ET_M = 30;

// 줌 레벨: 컨테이너 너비 대비 배율
const ZOOM_LEVELS = [
  { label: '1h',  mins: 60  },
  { label: '2h',  mins: 120 },
  { label: '4h',  mins: 240 },
  { label: 'All', mins: AXIS_MINS },
];

// ── 기본 px/분 (All 기준 = 컨테이너 너비에 맞춤) ─────────
const PX_PER_MIN_BASE = 3; // 최소값

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ET 오프셋 계산 (window._etHour 기반, clock.js와 연동)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ET UTC 오프셋(ms): EDT=-4h, EST=-5h
function _etOffsetMs() {
  const etHour = window._etHour;
  if (etHour != null) {
    const now  = new Date();
    const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    let diff   = etHour - utcH;
    if (diff > 12)  diff -= 24;
    if (diff < -12) diff += 24;
    return Math.round(diff * 3600_000);
  }
  // fallback: toLocaleString으로 EDT/EST 판별
  const s = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' });
  return s.includes('EDT') ? -4 * 3600_000 : -5 * 3600_000;
}

// KST UTC 오프셋(ms): 항상 +9h
function _kstOffsetMs() {
  return 9 * 3600_000;
}

// 오늘 ET 날짜 문자열 "YYYY-MM-DD"
function _todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ET HH:MM → UTC ms (오늘 기준)
function _etHMtoUtcMs(h, m) {
  const etOff = _etOffsetMs(); // 음수: ET는 UTC보다 뒤
  const todayET = _todayET();
  // 오늘 날짜의 UTC 자정
  const utcMidnightMs = new Date(`${todayET}T00:00:00Z`).getTime();
  // ET 오프셋 역산: ET시각 - etOff = UTC시각
  // etOff = ET - UTC → UTC = ET - etOff (etOff가 음수이므로 실제로는 더함)
  return utcMidnightMs + (h * 60 + m) * 60_000 - etOff;
}

// UTC ISO → 차트 x좌표 ms (고정 시간축 기준)
// 고정 시간축 시작점 = ET 04:00의 UTC ms
let _axisStartMs = null;
let _axisEndMs   = null;

function _initAxisMs() {
  _axisStartMs = _etHMtoUtcMs(AXIS_START_ET_H, 0);
  _axisEndMs   = _axisStartMs + AXIS_MINS * 60_000;
}

// UTC ms → 차트 픽셀 x (SVG 내부 좌표)
function _toX(utcMs, svgW) {
  const ratio = (utcMs - _axisStartMs) / (AXIS_MINS * 60_000);
  return ratio * svgW;
}

// UTC ms → KST "HH:MM" 문자열
function _toKstHHMM(utcMs) {
  const kstMs = utcMs + _kstOffsetMs();
  const d     = new Date(kstMs);
  const h     = d.getUTCHours();
  const m     = d.getUTCMinutes();
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// UTC ISO 문자열 → UTC ms
function _isoToMs(iso) {
  return new Date(iso).getTime();
}

// ET "YYYY-MM-DD HH:mm:ss" → UTC ms
function _etStrToMs(etStr) {
  const etOff = _etOffsetMs();
  const asUtc = new Date(etStr.replace(' ', 'T') + 'Z').getTime();
  return asUtc - etOff; // ET → UTC
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 내부 상태
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let _containerId  = null;
let _cfApiBase    = '';
let _zoomIdx      = 0;       // 기본: '1h'

let _vixData      = [];      // [{ ms: UTC ms, v: number }] 정렬됨
let _voldData     = [];      // [{ ms: UTC ms, v: number }] 정렬됨
let _vixPrevClose = null;

// SVG 너비 (현재 줌 기준)
let _svgW = 0;

// VIX y축 — baseline 기준 ±10%, 한 방향만 확장
let _vixYMaxRatio = 1.1;
let _vixYMinRatio = 0.9;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 공개 API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function initVCChart(containerId, cfApiBase) {
  _containerId = containerId;
  _cfApiBase   = cfApiBase || '';
  _initAxisMs();
  _buildShell();
  _bindZoomButtons();
  _updateSvgWidth();
  _render();
  // 당일 VIX 히스토리 복원
  await _restoreVixHistory();
}

export function setVixPrevClose(value) {
  _vixPrevClose = value;
  _renderPane('vix');
}

export function pushVixPoint(ts, value) {
  if (value == null || isNaN(value)) return;
  const ms = _isoToMs(ts);
  // 고정 시간축 범위 밖은 무시
  if (ms < _axisStartMs || ms > _axisEndMs) return;
  const idx = _vixData.findIndex(d => d.ms === ms);
  if (idx !== -1) {
    _vixData[idx].v = value;
  } else {
    _vixData.push({ ms, v: value });
    _vixData.sort((a, b) => a.ms - b.ms);
  }
  _renderPane('vix');
}

export function setVoldSeries(series) {
  if (!Array.isArray(series) || !series.length) return;
  _voldData = series
    .filter(d => d.v != null && !isNaN(d.v))
    .map(d => ({ ms: _etStrToMs(d.ts), v: d.v }))
    .filter(d => d.ms >= _axisStartMs && d.ms <= _axisEndMs)
    .sort((a, b) => a.ms - b.ms);
  _renderPane('vold');
}

export function pushVoldPoint(ts, value) {
  if (value == null || isNaN(value)) return;
  const ms = _etStrToMs(ts);
  if (ms < _axisStartMs || ms > _axisEndMs) return;
  const idx = _voldData.findIndex(d => d.ms === ms);
  if (idx !== -1) {
    _voldData[idx].v = value;
  } else {
    _voldData.push({ ms, v: value });
    _voldData.sort((a, b) => a.ms - b.ms);
  }
  _renderPane('vold');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 당일 VIX 히스토리 복원 (/api/vix-tick)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function _restoreVixHistory() {
  if (!_cfApiBase) return;
  try {
    const res  = await fetch(`${_cfApiBase}/api/vix-tick`);
    if (!res.ok) return;
    const data = await res.json();

    if (data.prevClose != null) {
      _vixPrevClose = data.prevClose;
    }

    if (Array.isArray(data.points) && data.points.length) {
      // 일괄 삽입 (정렬 1회만)
      _vixData = [];
      for (const p of data.points) {
        if (p.v == null || isNaN(p.v)) continue;
        const ms = _isoToMs(p.ts);
        if (ms < _axisStartMs || ms > _axisEndMs) continue;
        _vixData.push({ ms, v: p.v });
      }
      _vixData.sort((a, b) => a.ms - b.ms);
    }

    _renderPane('vix');
  } catch (e) {
    console.warn('[vc-chart] VIX 히스토리 복원 실패:', e.message);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HTML 뼈대 생성
//
// [flex row]
//   ├─ [y축 고정 컬럼 Y_W px]
//   │    ├─ svg#vc-yaxis-vix   (PANE_H)
//   │    └─ svg#vc-yaxis-vold  (PANE_H)
//   └─ [div#vc-scroll  flex:1  overflow-x:auto] ← 스크롤 1개
//        ├─ svg#vc-chart-vix   (동적 너비)
//        └─ svg#vc-chart-vold  (동적 너비)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _buildShell() {
  const el = document.getElementById(_containerId);
  if (!el) return;

  el.innerHTML = `
    <!-- 줌 버튼 -->
    <div style="display:flex;align-items:center;gap:6px;padding:6px 0 4px;flex-wrap:wrap">
      ${ZOOM_LEVELS.map((z, i) => `
        <button class="vc-zoom-btn${i === _zoomIdx ? ' active' : ''}"
                data-idx="${i}"
                style="
                  padding:3px 10px;font-size:11px;border-radius:4px;
                  border:1px solid var(--border,#30363d);
                  background:${i === _zoomIdx ? 'var(--accent,#238636)' : 'transparent'};
                  color:${i === _zoomIdx ? '#fff' : 'var(--text2,#8b949e)'};
                  cursor:pointer;transition:all .15s;
                ">${z.label}</button>
      `).join('')}
    </div>

    <!-- 듀얼 페인 레이아웃 -->
    <div style="display:flex;align-items:stretch">

      <!-- y축 고정 컬럼 -->
      <div style="flex-shrink:0;width:${Y_W}px;display:flex;flex-direction:column">
        <!-- VIX 페인 레이블 -->
        <div style="position:relative;height:${PANE_H}px">
          <svg id="vc-yaxis-vix" width="${Y_W}" height="${PANE_H}"
               style="display:block;overflow:visible"></svg>
          <span style="
            position:absolute;left:2px;top:4px;
            font-size:9px;font-weight:700;color:#8b949e;
            pointer-events:none;letter-spacing:.5px;
          ">VIX</span>
        </div>
        <!-- VOLD 페인 레이블 -->
        <div style="position:relative;height:${PANE_H}px">
          <svg id="vc-yaxis-vold" width="${Y_W}" height="${PANE_H}"
               style="display:block;overflow:visible"></svg>
          <span style="
            position:absolute;left:2px;top:4px;
            font-size:9px;font-weight:700;color:#8b949e;
            pointer-events:none;letter-spacing:.5px;
          ">VOLD</span>
        </div>
        <!-- x축 페인 빈 공간 -->
        <div style="height:${XAXIS_H}px"></div>
      </div>

      <!-- 공통 스크롤 컨테이너 (VIX + VOLD + x축 동시 스크롤) -->
      <div id="vc-scroll"
           style="flex:1;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin">
        <div id="vc-inner" style="display:flex;flex-direction:column">
          <svg id="vc-chart-vix"   height="${PANE_H}"  style="display:block"></svg>
          <svg id="vc-chart-vold"  height="${PANE_H}"  style="display:block"></svg>
          <svg id="vc-chart-xaxis" height="${XAXIS_H}" style="display:block"></svg>
        </div>
      </div>

    </div>`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SVG 너비 계산 및 적용
//
// 설계:
//   컨테이너 너비를 zoomMins 분 치로 채우도록 pxPerMin 결정
//   → SVG 너비 = AXIS_MINS × pxPerMin
//   줌이 좁을수록 SVG가 커지고 스크롤 범위가 넓어짐
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _updateSvgWidth() {
  const scrollEl = document.getElementById('vc-scroll');
  const inner    = document.getElementById('vc-inner');
  if (!scrollEl || !inner) return;

  const viewW    = scrollEl.clientWidth || (window.innerWidth - Y_W - 28);
  const zoomMins = ZOOM_LEVELS[_zoomIdx].mins;

  // 컨테이너 너비를 zoomMins 분으로 채우는 pxPerMin
  const pxPerMin = Math.max(viewW / zoomMins, PX_PER_MIN_BASE);

  // SVG 전체 너비 = 전체 시간축(780분) × pxPerMin
  _svgW = Math.round(AXIS_MINS * pxPerMin);

  ['vc-chart-vix', 'vc-chart-vold', 'vc-chart-xaxis'].forEach(id => {
    const svg = document.getElementById(id);
    if (svg) svg.setAttribute('width', _svgW);
  });
  inner.style.width = _svgW + 'px';
}

// 현재 시각 위치로 스크롤
function _scrollToNow() {
  const scrollEl = document.getElementById('vc-scroll');
  if (!scrollEl) return;
  const nowMs   = Date.now();
  const ratio   = Math.max(0, Math.min(1, (nowMs - _axisStartMs) / (AXIS_MINS * 60_000)));
  const nowPx   = _svgW * ratio;
  const viewW   = scrollEl.clientWidth;
  const target  = Math.max(0, nowPx - viewW * 0.75);
  scrollEl.scrollLeft = target;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 줌 버튼 바인딩
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _bindZoomButtons() {
  const el = document.getElementById(_containerId);
  if (!el) return;
  el.addEventListener('click', e => {
    const btn = e.target.closest('.vc-zoom-btn');
    if (!btn) return;
    _zoomIdx = parseInt(btn.dataset.idx, 10);

    el.querySelectorAll('.vc-zoom-btn').forEach((b, i) => {
      const on = i === _zoomIdx;
      b.style.background = on ? 'var(--accent,#238636)' : 'transparent';
      b.style.color      = on ? '#fff' : 'var(--text2,#8b949e)';
    });

    // SVG 너비 재계산 → 재렌더 → 현재 시각으로 스크롤
    _updateSvgWidth();
    _render();
    requestAnimationFrame(() => _scrollToNow());
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 전체 렌더 (초기화 시 1회, 데이터 업데이트마다 페인별)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _render() {
  _renderPane('vix');
  _renderPane('vold');
  _renderXAxis();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 페인 렌더
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _renderPane(pane) {
  const chartSvg = document.getElementById(`vc-chart-${pane}`);
  const yaxisSvg = document.getElementById(`vc-yaxis-${pane}`);
  if (!chartSvg || !yaxisSvg || !_svgW) return;

  const W = _svgW;
  const data = pane === 'vix' ? _vixData : _voldData;

  // ── y 범위 계산 ────────────────────────────────────────
  const baseline = pane === 'vix' ? (_vixPrevClose ?? null) : 0;

  let yMin, yMax;
  if (!data.length || (pane === 'vix' && baseline == null)) {
    // 데이터 없음: 빈 배경 + x축만 그림
    chartSvg.innerHTML = _emptyPane(W, pane);
    _renderYAxis(yaxisSvg, 0, 1, 0, pane);
   // if (pane === 'vix') _renderXAxis(chartSvg, W);
    return;
  }

  const vals   = data.map(d => d.v);
  const rawMin = Math.min(...vals);
  const rawMax = Math.max(...vals);

  if (pane === 'vix') {
    const base = baseline;
    const maxR = rawMax / base;
    const minR = rawMin / base;
    if (maxR > _vixYMaxRatio) _vixYMaxRatio = Math.ceil(maxR * 10) / 10;
    if (minR < _vixYMinRatio) _vixYMinRatio = Math.floor(minR * 10) / 10;
    yMax = base * _vixYMaxRatio;
    yMin = base * _vixYMinRatio;
  } else {
    // VOLD: 0 기준 ±여유
    yMin = Math.min(rawMin, 0) * 1.05;
    yMax = Math.max(rawMax, 0) * 1.05;
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
  }
  const yRange = yMax - yMin || 1;
  const toY = v => PAD_T + ((yMax - v) / yRange) * (PANE_H - PAD_T - PAD_B);

  // ── VOLD: 정규장 시작(09:30 ET) ms ─────────────────────
  const voldStartMs = pane === 'vold'
    ? _etHMtoUtcMs(VOLD_START_ET_H, VOLD_START_ET_M)
    : null;

  // ── 라인 path (VIX: baseline 기준 구간별 색상 / VOLD: 단색) ──
  const COLOR_GREEN = '#22c55e';
  const COLOR_RED   = '#ef4444';

  const lastVal = data[data.length - 1].v;
  let linePathsSvg = '';

  if (pane === 'vix') {
    // baseline 위/아래 바뀔 때마다 <path> 를 끊어서 색상 분리
    let seg = '';
    let segFirst = true;
    let prevAbove = null;

    const flushSeg = (above) => {
      if (seg) {
        linePathsSvg += `<path d="${seg.trim()}" fill="none"
          stroke="${above ? COLOR_GREEN : COLOR_RED}" stroke-width="1.5"
          stroke-linejoin="round" stroke-linecap="round"/>`;
      }
    };

    for (const d of data) {
      const x     = _toX(d.ms, W).toFixed(1);
      const y     = toY(d.v).toFixed(1);
      const above = d.v >= baseline;

      if (prevAbove !== null && above !== prevAbove) {
        // baseline 교차 → 교차점 x 보간 후 현재 seg 닫기
        flushSeg(prevAbove);
        seg      = `M${x},${toY(baseline).toFixed(1)} L${x},${y} `;
        segFirst = false;
      } else {
        seg += `${segFirst ? 'M' : 'L'}${x},${y} `;
        segFirst = false;
      }
      prevAbove = above;
    }
    flushSeg(prevAbove);

    // linePath 는 면적용으로도 필요 — 전체 경로를 단일 string으로 재구성
    let linePath = '';
    let first = true;
    for (const d of data) {
      const x = _toX(d.ms, W).toFixed(1);
      const y = toY(d.v).toFixed(1);
      linePath += `${first ? 'M' : 'L'}${x},${y} `;
      first = false;
    }

    const linePoints = data;
    const firstX   = _toX(linePoints[0].ms, W).toFixed(1);
    const lastX    = _toX(linePoints[linePoints.length - 1].ms, W).toFixed(1);
    const lastY    = toY(lastVal).toFixed(1);
    const baseY    = toY(baseline).toFixed(1);
    const areaPath = `${linePath.trim()} L${lastX},${baseY} L${firstX},${baseY} Z`;
    // 마지막 구간 색상 = lastVal 기준 (라인색과 일치)
    const lineColor     = lastVal >= baseline ? COLOR_GREEN : COLOR_RED;
    const gradId        = `vc-grad-${pane}`;
    // 그라데이션: 라인(lastY)에서 baseline(baseY) 방향으로 페이드
    // userSpaceOnUse로 픽셀 좌표 직접 지정
    const nowMs  = Date.now();
    const nowX   = _toX(nowMs, W).toFixed(1);
    const nowLine = (nowMs >= _axisStartMs && nowMs <= _axisEndMs)
      ? `<line x1="${nowX}" y1="${PAD_T}" x2="${nowX}" y2="${PANE_H - PAD_B}"
               stroke="#4b5563" stroke-width="1" stroke-dasharray="2,3" opacity="0.5"/>`
      : '';

    // ── 개장(09:30 ET) 세로 점선 ─────────────────────────
    const openMs  = _etHMtoUtcMs(9, 30);
    const openX   = _toX(openMs, W).toFixed(1);
    const openLine = `
      <line x1="${openX}" y1="${PAD_T}" x2="${openX}" y2="${PANE_H - PAD_B}"
            stroke="#6b7280" stroke-width="1" stroke-dasharray="3,4" opacity="0.7"/>`;

    chartSvg.setAttribute('width', W);
    chartSvg.innerHTML = `
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="${lastY}" x2="0" y2="${baseY}"
                        gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stop-color="${lineColor}" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="${lineColor}" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <rect width="${W}" height="${PANE_H}" fill="transparent"/>
      <line x1="0" y1="${baseY}" x2="${W}" y2="${baseY}"
            stroke="#f59e0b" stroke-width="1" stroke-dasharray="4,3" opacity="0.55"/>
      ${nowLine}
      ${openLine}
      <path d="${areaPath}" fill="url(#${gradId})" stroke="none"/>
      ${linePathsSvg}
      <circle cx="${lastX}" cy="${lastY}" r="3"
              fill="${lineColor}" stroke="#0d1117" stroke-width="1.5"/>
      ${_lastLabel(lastX, lastY, lastVal.toFixed(2), lineColor, W)}
    `;
    _renderYAxis(yaxisSvg, yMin, yMax, baseline, pane);
    _maybeScrollToNow();
    return;
  }

  // ── VOLD: 단일 색상 (기존 로직 유지) ──────────────────
  let linePath = '';
  let first    = true;
  for (const d of data) {
    if (d.ms < voldStartMs) continue;
    const x = _toX(d.ms, W).toFixed(1);
    const y = toY(d.v).toFixed(1);
    linePath += `${first ? 'M' : 'L'}${x},${y} `;
    first = false;
  }
  if (!linePath) {
    // 데이터는 있지만 정규장 전 (VOLD 케이스)
    chartSvg.innerHTML = _emptyPane(W, pane);
    _renderYAxis(yaxisSvg, yMin, yMax, baseline, pane);
    return;
  }

  // ── VOLD 색상 ──────────────────────────────────────────
  const lineColor = lastVal >= 0 ? COLOR_GREEN : COLOR_RED;

  // ── 기준선 y ───────────────────────────────────────────
  const baseY = toY(baseline ?? 0).toFixed(1);

  // ── 면적 path (라인→baseline 닫기) ────────────────────
  // 시작점과 끝점의 x를 라인에서 추출
  const linePoints = data.filter(d => pane !== 'vold' || d.ms >= voldStartMs);
  const firstX     = _toX(linePoints[0].ms,                    W).toFixed(1);
  const lastX      = _toX(linePoints[linePoints.length-1].ms,  W).toFixed(1);
  const lastY      = toY(lastVal).toFixed(1);
  const areaPath   = `${linePath.trim()} L${lastX},${baseY} L${firstX},${baseY} Z`;

  const gradId        = `vc-grad-${pane}`;
  const lineAboveBase = lastVal >= (baseline ?? 0);

  // ── 현재 시각 수직선 ───────────────────────────────────
  const nowMs  = Date.now();
  const nowX   = _toX(nowMs, W).toFixed(1);
  const nowLine = (nowMs >= _axisStartMs && nowMs <= _axisEndMs)
    ? `<line x1="${nowX}" y1="${PAD_T}" x2="${nowX}" y2="${PANE_H - PAD_B}"
             stroke="#4b5563" stroke-width="1" stroke-dasharray="2,3" opacity="0.5"/>`
    : '';

  // ── 개장(09:30 ET) 세로 점선 ───────────────────────────
  const openMs  = _etHMtoUtcMs(9, 30);
  const openX   = _toX(openMs, W).toFixed(1);
  const openLine = `
    <line x1="${openX}" y1="${PAD_T}" x2="${openX}" y2="${PANE_H - PAD_B}"
          stroke="#6b7280" stroke-width="1" stroke-dasharray="3,4" opacity="0.7"/>`;

  // ── SVG 조립 ───────────────────────────────────────────
  chartSvg.setAttribute('width', W);
  chartSvg.innerHTML = `
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="${lastY}" x2="0" y2="${baseY}"
                      gradientUnits="userSpaceOnUse">
        <stop offset="0%"   stop-color="${lineColor}" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="${lineColor}" stop-opacity="0.02"/>
      </linearGradient>
    </defs>

    <rect width="${W}" height="${PANE_H}" fill="transparent"/>

    <!-- 기준선 -->
    <line x1="0" y1="${baseY}" x2="${W}" y2="${baseY}"
          stroke="#374151" stroke-width="1" stroke-dasharray="4,3" opacity="0.55"/>

    <!-- 현재 시각 수직선 -->
    ${nowLine}

    <!-- 개장 세로 점선 -->
    ${openLine}

    <!-- 면적 음영 -->
    <path d="${areaPath}" fill="url(#${gradId})" stroke="none"/>

    <!-- 라인 -->
    <path d="${linePath.trim()}"
          fill="none" stroke="${lineColor}" stroke-width="1.5"
          stroke-linejoin="round" stroke-linecap="round"/>

    <!-- 현재값 점 -->
    <circle cx="${lastX}" cy="${lastY}" r="3"
            fill="${lineColor}" stroke="#0d1117" stroke-width="1.5"/>

    <!-- 현재값 라벨 -->
    ${_lastLabel(lastX, lastY, _fmtVold(lastVal), lineColor, W)}
  `;

  // ── y축 ────────────────────────────────────────────────
  _renderYAxis(yaxisSvg, yMin, yMax, baseline, pane);

  // ── 초기 스크롤 (데이터 첫 렌더 시) ───────────────────
  _maybeScrollToNow();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 초기 스크롤 (1회만)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let _didInitScroll = false;
function _maybeScrollToNow() {
  if (_didInitScroll) return;
  if (!_vixData.length && !_voldData.length) return;
  _didInitScroll = true;
  requestAnimationFrame(() => _scrollToNow());
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// y축 SVG
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _renderYAxis(svg, yMin, yMax, baseline, pane) {
  const ticks  = _niceTicks(yMin, yMax, 4);
  const yRange = yMax - yMin || 1;
  const toY    = v => PAD_T + ((yMax - v) / yRange) * (PANE_H - PAD_T - PAD_B);
  const fmtFn  = pane === 'vix'
    ? v => v.toFixed(1)
    : v => _fmtVoldShort(v);

  const lines = ticks.map(t => {
    const y = toY(t).toFixed(1);
    return `
      <text x="${Y_W - 3}" y="${y}"
            font-size="9" font-family="monospace"
            fill="#8b949e" text-anchor="end"
            dominant-baseline="middle">${fmtFn(t)}</text>
      <line x1="${Y_W - 2}" y1="${y}" x2="${Y_W}" y2="${y}"
            stroke="#8b949e" stroke-width="0.5" opacity="0.3"/>
    `;
  }).join('');

  const baseY      = toY(baseline ?? 0).toFixed(1);
  const baseLabel  = pane === 'vix'
    ? `PC:${(baseline ?? 0).toFixed(1)}`
    : '0';
  const baseColor  = pane === 'vix' ? '#f59e0b' : '#4b5563';

  svg.innerHTML = `
    <line x1="${Y_W - 1}" y1="${PAD_T}" x2="${Y_W - 1}" y2="${PANE_H - PAD_B}"
          stroke="#30363d" stroke-width="1"/>
    ${lines}
    <text x="${Y_W - 3}" y="${baseY}"
          font-size="8" font-family="monospace"
          fill="${baseColor}" text-anchor="end"
          dominant-baseline="middle" font-weight="600">${baseLabel}</text>
  `;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// x축 전용 페인 렌더 (항상 표시)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _renderXAxis() {
  const svg = document.getElementById('vc-chart-xaxis');
  if (!svg || !_svgW) return;
  const W = _svgW;

  // 1시간 단위 눈금
  let ticks = '';
  for (let h = AXIS_START_ET_H; h <= AXIS_END_ET_H; h++) {
    const ms    = _etHMtoUtcMs(h, 0);
    const x     = _toX(ms, W).toFixed(1);
    const label = _toKstHHMM(ms);
    ticks += `
      <line x1="${x}" y1="0" x2="${x}" y2="4"
            stroke="#374151" stroke-width="0.8"/>
      <text x="${x}" y="14"
            font-size="9" font-family="monospace" fill="#6b7280"
            text-anchor="middle">${label}</text>`;
  }

  // 개장(09:30 ET) 표시
  const openMs = _etHMtoUtcMs(9, 30);
  const openX  = _toX(openMs, W).toFixed(1);
  const openLabel = `
    <line x1="${openX}" y1="0" x2="${openX}" y2="6"
          stroke="#6b7280" stroke-width="1" stroke-dasharray="3,4" opacity="0.7"/>
    <text x="${openX}" y="16"
          font-size="8" font-family="monospace" fill="#6b7280"
          text-anchor="start" dx="2">09:30</text>`;

  svg.setAttribute('width', W);
  svg.innerHTML = `
    <rect width="${W}" height="${XAXIS_H}" fill="transparent"/>
    <line x1="0" y1="0" x2="${W}" y2="0" stroke="#30363d" stroke-width="1"/>
    ${ticks}
    ${openLabel}
  `;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 헬퍼
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _emptyPane(W, pane) {
  const msg  = pane === 'vix' ? 'VIX 데이터 없음' : '정규장 시작 후 표시';
  const midY = ((PANE_H - PAD_T - PAD_B) / 2 + PAD_T).toFixed(0);
  return `
    <rect width="${W}" height="${PANE_H}" fill="transparent"/>
    <line x1="0" y1="${midY}" x2="${W}" y2="${midY}"
          stroke="#30363d" stroke-width="1" stroke-dasharray="4,3" opacity="0.4"/>
    <text x="${W / 2}" y="${PANE_H / 2}"
          font-size="11" fill="#4b5563"
          text-anchor="middle" dominant-baseline="middle">${msg}</text>
  `;
}

function _lastLabel(x, y, label, color, W) {
  const px     = parseFloat(x);
  const py     = parseFloat(y);
  const anchor = px > W - 52 ? 'end' : 'start';
  const dx     = anchor === 'end' ? -6 : 6;
  const rectX  = anchor === 'end' ? px + dx - 38 : px + dx;
  return `
    <rect x="${rectX}" y="${py - 9}" width="38" height="16" rx="3"
          fill="#0d1117" opacity="0.85"/>
    <text x="${rectX + 19}" y="${py}"
          font-size="10" font-family="monospace" font-weight="600"
          fill="${color}" text-anchor="middle"
          dominant-baseline="middle">${label}</text>
  `;
}

function _niceTicks(min, max, n) {
  const range = max - min || 1;
  const step  = _niceStep(range / n);
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.01; v += step) {
    ticks.push(parseFloat(v.toFixed(10)));
    if (ticks.length >= n + 1) break;
  }
  return ticks;
}

function _niceStep(rough) {
  const exp  = Math.floor(Math.log10(Math.abs(rough) || 1));
  const pow  = Math.pow(10, exp);
  const frac = rough / pow;
  const nice = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  return nice * pow;
}

function _fmtVold(v) {
  if (v == null || isNaN(v)) return '—';
  const n    = v / 1_000_000;
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}M`;
}

function _fmtVoldShort(v) {
  const n = v / 1_000_000;
  if (Math.abs(n) >= 1) return (n >= 0 ? '+' : '') + n.toFixed(0) + 'M';
  const k = v / 1_000;
  return (k >= 0 ? '+' : '') + k.toFixed(0) + 'k';
}
