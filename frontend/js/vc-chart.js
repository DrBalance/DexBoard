// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// vc-chart.js — VIX + VOLD 듀얼 페인 SVG 차트
//
// 구조:
//   상단 페인: VIX 1분봉 (Yahoo Finance)
//   하단 페인: VOLD 누적 (RSP WebSocket 틱)
//
// 특징:
//   - SVG 방식 (Canvas 크기 버그 없음)
//   - y축 별도 고정 SVG (스크롤 무관)
//   - 가로 스크롤 + 줌 버튼 (1h / 2h / 4h / All)
//   - 현재값 라벨 (마지막 포인트)
//   - 전일 종가 기준선 (VIX) / 0 기준선 (VOLD)
//   - VIX 조회 실패 시 VIX 페인 유지, VOLD만 독립 업데이트
//
// 외부 호출:
//   initVCChart(containerId)   → 차트 초기화
//   pushVixPoint(ts, value)    → VIX 1분봉 포인트 추가 (ts: UTC ISO)
//   setVoldSeries(series)      → VOLD 시리즈 전체 교체 (ts: "YYYY-MM-DD HH:mm:ss" ET)
//   setVixPrevClose(value)     → 전일 종가 기준선 설정
//
// 시간 기준:
//   모든 ts는 내부적으로 ms(정수)로 변환하여 사용
//   VIX: UTC ISO → _tsToMs()
//   VOLD: ET 문자열 → clock.js의 window._kstStr / window._etHour 역산으로 KST ms 변환
//   x축 레이블: KST HH:MM 표시
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── 레이아웃 상수 ─────────────────────────────────────────
const Y_W       = 38;    // y축 SVG 너비 (px) — 모바일 최소화
const PANE_H    = 180;   // 각 페인 높이 (px)
const PAD_T     = 8;     // 상단 여백
const PAD_B     = 8;     // 하단 여백
const PX_PER_MIN_BASE = 4; // 기본 분당 픽셀 (1h 줌 기준)

// 줌 레벨 정의 (표시할 시간 범위 분)
const ZOOM_LEVELS = [
  { label: '1h',  mins: 60  },
  { label: '2h',  mins: 120 },
  { label: '4h',  mins: 240 },
  { label: 'All', mins: 480 },  // 정규장 전체 (4:00~20:00 ET = 최대 960분)
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 시간 변환 유틸 — 페이지 시계(window._kstStr) 기준
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// KST 오프셋 ms: 현재 UTC와 window._kstStr 비교로 역산
// window._kstStr = "HH:MM:SS" (clock.js tick()에서 매초 갱신)
function _getKstOffsetMs() {
  const now = new Date();
  const kstStr = window._kstStr;   // "HH:MM:SS"
  if (!kstStr) return 9 * 3600_000; // fallback: KST = UTC+9

  const [hh, mm, ss] = kstStr.split(':').map(Number);
  // 오늘 날짜 기준 KST ms 재구성
  const utcMidnight = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
  )).getTime();
  const kstMs = utcMidnight + (hh * 3600 + mm * 60 + ss) * 1000;
  // KST가 UTC보다 얼마나 앞서는지 (보통 +9h = 32400000ms)
  const offset = kstMs - now.getTime();
  // 자정 경계 처리 (±12h 이내로 클램프)
  if (offset > 43200_000)  return offset - 86400_000;
  if (offset < -43200_000) return offset + 86400_000;
  return offset;
}

// ET 오프셋 ms: window._etHour(소수시간)와 현재 UTC 비교로 역산
// window._etHour = clock.js가 매초 갱신하는 ET 소수 시각
function _getEtOffsetMs() {
  const now = new Date();
  const etHour = window._etHour;
  if (etHour == null) return -4 * 3600_000; // fallback: EDT

  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  let diff = etHour - utcH;
  if (diff > 12)  diff -= 24;
  if (diff < -12) diff += 24;
  return Math.round(diff * 3600_000);
}

// UTC ISO → KST ms
function _utcToKstMs(utcIso) {
  return new Date(utcIso).getTime() + _getKstOffsetMs();
}

// ET 문자열 "YYYY-MM-DD HH:mm:ss" → KST ms
function _etStrToKstMs(etStr) {
  // ET 문자열을 UTC ms로 먼저 변환 후 KST로
  const etOffsetMs = _getEtOffsetMs();
  const kstOffsetMs = _getKstOffsetMs();
  // "YYYY-MM-DD HH:mm:ss" → 가상 UTC로 파싱
  const asUtc = new Date(etStr.replace(' ', 'T') + 'Z').getTime();
  // ET → UTC: asUtc - etOffsetMs (etOffset은 음수이므로 빼면 UTC가 됨)
  const utcMs = asUtc - etOffsetMs;
  return utcMs + kstOffsetMs;
}

// KST ms → "HH:MM" 문자열
function _kstMsToHHMM(ms) {
  const d = new Date(ms - _getKstOffsetMs()); // KST ms → UTC Date
  const kstH = (d.getUTCHours() + Math.round(_getKstOffsetMs() / 3600_000)) % 24;
  const kstM = d.getUTCMinutes();
  return `${String(kstH).padStart(2,'0')}:${String(kstM).padStart(2,'0')}`;
}

// ── 내부 상태 ─────────────────────────────────────────────
let _containerId  = null;
let _zoomIdx      = 0;         // 현재 줌 레벨 인덱스
let _vixData      = [];        // [{ ms: number, v: number }]  — UTC ms
let _voldData     = [];        // [{ ms: number, v: number }]  — KST ms (표시용)
let _vixPrevClose = null;      // VIX 전일 종가

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 공개 API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function initVCChart(containerId) {
  _containerId = containerId;
  _buildShell();
  _bindZoomButtons();
  _render();
}

export function setVixPrevClose(value) {
  _vixPrevClose = value;
  _renderPane('vix');
}

export function pushVixPoint(ts, value) {
  // ts: UTC ISO 문자열 → KST ms로 변환하여 저장
  if (value == null || isNaN(value)) return;
  const ms = _utcToKstMs(ts);
  const existing = _vixData.findIndex(d => d.ms === ms);
  if (existing !== -1) {
    _vixData[existing].v = value;
  } else {
    _vixData.push({ ms, v: value });
    _vixData.sort((a, b) => a.ms - b.ms);
  }
  _renderPane('vix');
}

// VOLD 시리즈 전체 교체 (1분 폴링 시)
// series: [{ ts: "YYYY-MM-DD HH:mm:ss" ET, v: number }, ...] 오래된 순
export function setVoldSeries(series) {
  if (!Array.isArray(series) || !series.length) return;
  _voldData = series
    .filter(d => d.v != null && !isNaN(d.v))
    .map(d => ({ ms: _etStrToKstMs(d.ts), v: d.v }))
    .sort((a, b) => a.ms - b.ms);
  _renderPane('vold');
}

// 단일 포인트 추가 (하위 호환용)
export function pushVoldPoint(ts, value) {
  if (value == null || isNaN(value)) return;
  const ms = _etStrToKstMs(ts);
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
// HTML 뼈대 생성
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _buildShell() {
  const el = document.getElementById(_containerId);
  if (!el) return;

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;padding:6px 0 4px;flex-wrap:wrap">
      ${ZOOM_LEVELS.map((z, i) => `
        <button class="vc-zoom-btn${i === _zoomIdx ? ' active' : ''}"
                data-idx="${i}"
                style="
                  padding:3px 10px;font-size:11px;border-radius:4px;
                  border:1px solid var(--border,#30363d);
                  background:${i === _zoomIdx ? 'var(--accent,#238636)' : 'transparent'};
                  color:${i === _zoomIdx ? '#fff' : 'var(--text2,#8b949e)'};
                  cursor:pointer;
                ">${z.label}</button>
      `).join('')}
    </div>

    <!-- VIX 페인 -->
    <div id="vc-pane-vix" style="position:relative;display:flex;height:${PANE_H}px;margin-bottom:2px">
      <svg id="vc-yaxis-vix" width="${Y_W}" height="${PANE_H}"
           style="flex-shrink:0;overflow:visible"></svg>
      <div id="vc-scroll-vix"
           style="flex:1;overflow-x:auto;overflow-y:hidden;position:relative;scrollbar-width:thin">
        <svg id="vc-chart-vix" height="${PANE_H}"
             style="display:block;min-width:100%"></svg>
      </div>
      <span style="
        position:absolute;left:${Y_W + 4}px;top:4px;
        font-size:10px;font-weight:600;color:#8b949e;
        pointer-events:none;z-index:1;
      ">VIX</span>
    </div>

    <!-- VOLD 페인 -->
    <div id="vc-pane-vold" style="position:relative;display:flex;height:${PANE_H}px">
      <svg id="vc-yaxis-vold" width="${Y_W}" height="${PANE_H}"
           style="flex-shrink:0;overflow:visible"></svg>
      <div id="vc-scroll-vold"
           style="flex:1;overflow-x:auto;overflow-y:hidden;position:relative;scrollbar-width:thin">
        <svg id="vc-chart-vold" height="${PANE_H}"
             style="display:block;min-width:100%"></svg>
      </div>
      <span style="
        position:absolute;left:${Y_W + 4}px;top:4px;
        font-size:10px;font-weight:600;color:#8b949e;
        pointer-events:none;z-index:1;
      ">VOLD</span>
    </div>`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 줌 버튼 바인딩
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _bindZoomButtons() {
  const el = document.getElementById(_containerId);
  if (!el) return;
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('.vc-zoom-btn');
    if (!btn) return;
    _zoomIdx = parseInt(btn.dataset.idx, 10);

    // 버튼 스타일 갱신
    el.querySelectorAll('.vc-zoom-btn').forEach((b, i) => {
      const active = i === _zoomIdx;
      b.style.background = active ? 'var(--accent,#238636)' : 'transparent';
      b.style.color       = active ? '#fff' : 'var(--text2,#8b949e)';
    });

    // 줌 변경 시 스크롤 위치 초기화
    _resetScroll();
    _render();
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 전체 렌더 (줌 변경 시)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _render() {
  _renderPane('vix');
  _renderPane('vold');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 페인별 렌더
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _renderPane(pane) {
  const data     = pane === 'vix' ? _vixData : _voldData;
  const chartSvg = document.getElementById(`vc-chart-${pane}`);
  const yaxisSvg = document.getElementById(`vc-yaxis-${pane}`);
  const scrollEl = document.getElementById(`vc-scroll-${pane}`);
  if (!chartSvg || !yaxisSvg || !scrollEl) return;

  const zoomMins = ZOOM_LEVELS[_zoomIdx].mins;

  // 표시할 데이터 슬라이싱 (줌 범위 내, ms 기준)
  const visible = _sliceByZoom(data, zoomMins);

  // 차트 너비 계산
  const scrollW  = scrollEl.clientWidth || 200;
  const pxPerMin = Math.max(scrollW / zoomMins, PX_PER_MIN_BASE);
  const chartW   = Math.max(zoomMins * pxPerMin, scrollW);

  chartSvg.setAttribute('width', chartW);

  if (visible.length < 2) {
    chartSvg.innerHTML = _emptyMsg(chartW, pane === 'vix' ? 'VIX 데이터 없음' : 'VOLD 데이터 없음');
    yaxisSvg.innerHTML = '';
    return;
  }

  // y 범위
  const vals    = visible.map(d => d.v);
  const rawMin  = Math.min(...vals);
  const rawMax  = Math.max(...vals);

  const baseline = pane === 'vix' ? (_vixPrevClose ?? rawMin) : 0;
  const yMin     = Math.min(rawMin, baseline) * (rawMin < 0 ? 1.05 : 0.98);
  const yMax     = Math.max(rawMax, baseline) * (rawMax > 0 ? 1.05 : 0.98);
  const yRange   = yMax - yMin || 1;

  // 좌표 변환 (ms 기준)
  const firstMs = visible[0].ms;
  const lastMs  = visible[visible.length - 1].ms;
  const spanMs  = lastMs - firstMs || 1;

  const toX = (ms) => ((ms - firstMs) / spanMs) * (chartW - 8) + 4;
  const toY = (v)  => PAD_T + ((yMax - v) / yRange) * (PANE_H - PAD_T - PAD_B);

  // ── 라인 path ──────────────────────────────────────────
  const linePath = visible.map((d, i) =>
    `${i === 0 ? 'M' : 'L'}${toX(d.ms).toFixed(1)},${toY(d.v).toFixed(1)}`
  ).join(' ');

  // ── 색상 결정 ──────────────────────────────────────────
  const lastVal   = visible[visible.length - 1].v;
  const lineColor = pane === 'vix'
    ? (lastVal > (baseline ?? lastVal) ? '#ef4444' : '#22c55e')
    : (lastVal >= 0 ? '#22c55e' : '#ef4444');

  // ── 기준선 y좌표 ───────────────────────────────────────
  const baseY  = toY(baseline).toFixed(1);
  const lastX  = toX(lastMs).toFixed(1);
  const lastY  = toY(lastVal).toFixed(1);
  const firstX = toX(firstMs).toFixed(1);

  const lastLabel = pane === 'vix' ? lastVal.toFixed(2) : _fmtVold(lastVal);
  const areaPath  = `${linePath} L${lastX},${baseY} L${firstX},${baseY} Z`;
  const gradId    = `vc-grad-${pane}`;

  // ── x축 레이블 (KST HH:MM, 30분 단위) ─────────────────
  const xTickSvg = _buildXTicks(visible, toX, chartW);

  // ── SVG 조립 ───────────────────────────────────────────
  chartSvg.innerHTML = `
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="${lineColor}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${lineColor}" stop-opacity="0.02"/>
      </linearGradient>
    </defs>

    <rect width="${chartW}" height="${PANE_H}" fill="transparent"/>

    <!-- 기준선 -->
    <line x1="0" y1="${baseY}" x2="${chartW}" y2="${baseY}"
          stroke="${pane === 'vix' ? '#f59e0b' : '#4b5563'}"
          stroke-width="1" stroke-dasharray="4,3" opacity="0.6"/>

    <!-- x축 눈금 -->
    ${xTickSvg}

    <!-- 음영 영역 -->
    <path d="${areaPath}" fill="url(#${gradId})" stroke="none"/>

    <!-- 라인 -->
    <path d="${linePath}"
          fill="none" stroke="${lineColor}" stroke-width="1.5"
          stroke-linejoin="round" stroke-linecap="round"/>

    <!-- 현재값 점 -->
    <circle cx="${lastX}" cy="${lastY}" r="3"
            fill="${lineColor}" stroke="#0d1117" stroke-width="1.5"/>

    <!-- 현재값 라벨 -->
    ${_lastLabel(lastX, lastY, lastLabel, lineColor, chartW)}
  `;

  // ── y축 SVG ────────────────────────────────────────────
  _renderYAxis(yaxisSvg, yMin, yMax, baseline, pane);

  // ── 현재 시각 위치로 스크롤 ────────────────────────────
  _scrollToNow(scrollEl, chartW, visible);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// y축 SVG 렌더 (고정, 스크롤 무관)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _renderYAxis(svg, yMin, yMax, baseline, pane) {
  const ticks  = _niceTicks(yMin, yMax, 4);
  const yRange = yMax - yMin || 1;
  const toY    = (v) =>
    PAD_T + ((yMax - v) / yRange) * (PANE_H - PAD_T - PAD_B);

  const color  = pane === 'vix' ? '#8b949e' : '#8b949e';
  const fmtFn  = pane === 'vix'
    ? (v) => v.toFixed(1)
    : (v) => _fmtVoldShort(v);

  const lines = ticks.map(t => {
    const y = toY(t).toFixed(1);
    return `
      <text x="${Y_W - 3}" y="${y}"
            font-size="9" font-family="monospace"
            fill="${color}" text-anchor="end"
            dominant-baseline="middle">${fmtFn(t)}</text>
      <line x1="${Y_W - 2}" y1="${y}" x2="${Y_W}" y2="${y}"
            stroke="${color}" stroke-width="0.5" opacity="0.4"/>
    `;
  }).join('');

  // 기준선 표시 (VIX 전일종가 / VOLD 0)
  const baseY = toY(baseline).toFixed(1);
  const baseLabel = pane === 'vix'
    ? `PC:${baseline?.toFixed(1) ?? ''}`
    : '0';

  svg.innerHTML = `
    <!-- 세로 경계선 -->
    <line x1="${Y_W - 1}" y1="${PAD_T}" x2="${Y_W - 1}" y2="${PANE_H - PAD_B}"
          stroke="#30363d" stroke-width="1"/>
    ${lines}
    <!-- 기준선 레이블 -->
    <text x="${Y_W - 3}" y="${baseY}"
          font-size="8" font-family="monospace"
          fill="${pane === 'vix' ? '#f59e0b' : '#4b5563'}"
          text-anchor="end" dominant-baseline="middle"
          font-weight="600">${baseLabel}</text>
  `;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 현재 시각으로 스크롤 (최초 1회 — 이미 스크롤됐으면 유지)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const _scrolled = { vix: false, vold: false };

function _scrollToNow(scrollEl, chartW, visible) {
  if (_scrolled[scrollEl.id.replace('vc-scroll-', '')]) return;
  requestAnimationFrame(() => {
    const target = chartW - scrollEl.clientWidth * 0.75;
    scrollEl.scrollLeft = Math.max(0, target);
    _scrolled[scrollEl.id.replace('vc-scroll-', '')] = true;
  });
}

// 줌 변경 시 스크롤 초기화
function _resetScroll() {
  _scrolled.vix  = false;
  _scrolled.vold = false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 헬퍼
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 줌 범위에 맞게 데이터 슬라이싱 (ms 기준)
function _sliceByZoom(data, mins) {
  if (!data.length) return [];
  const lastMs  = data[data.length - 1].ms;
  const cutoff  = lastMs - mins * 60_000;
  return data.filter(d => d.ms >= cutoff);
}

// x축 눈금 SVG 생성 (KST HH:MM, 30분 단위)
function _buildXTicks(visible, toX, chartW) {
  if (!visible.length) return '';

  const firstMs = visible[0].ms;
  const lastMs  = visible[visible.length - 1].ms;

  // 30분 단위 경계 ms 목록 생성
  const TICK_INTERVAL = 30 * 60_000;
  const startTick = Math.ceil(firstMs / TICK_INTERVAL) * TICK_INTERVAL;
  const ticks = [];
  for (let ms = startTick; ms <= lastMs; ms += TICK_INTERVAL) {
    ticks.push(ms);
  }

  return ticks.map(ms => {
    const x     = toX(ms).toFixed(1);
    const label = _kstMsToHHMM(ms);
    return `
      <line x1="${x}" y1="${PANE_H - PAD_B - 12}" x2="${x}" y2="${PANE_H - PAD_B}"
            stroke="#4b5563" stroke-width="0.5"/>
      <text x="${x}" y="${PANE_H - 1}"
            font-size="9" font-family="monospace" fill="#6b7280"
            text-anchor="middle">${label}</text>
    `;
  }).join('');
}

// 현재값 라벨 (차트 오른쪽 끝에 치우치면 왼쪽으로)
function _lastLabel(x, y, label, color, chartW) {
  const px    = parseFloat(x);
  const py    = parseFloat(y);
  const anchor = px > chartW - 50 ? 'end' : 'start';
  const dx     = anchor === 'end' ? -6 : 6;
  return `
    <rect x="${px + dx - (anchor === 'end' ? 36 : 0)}" y="${py - 9}"
          width="36" height="16" rx="3"
          fill="#0d1117" opacity="0.8"/>
    <text x="${px + dx + (anchor === 'end' ? -18 : 18)}" y="${py}"
          font-size="10" font-family="monospace" font-weight="600"
          fill="${color}" text-anchor="middle"
          dominant-baseline="middle">${label}</text>
  `;
}

// 빈 차트 메시지
function _emptyMsg(w, msg) {
  return `
    <text x="${w / 2}" y="${PANE_H / 2}"
          font-size="11" fill="#4b5563"
          text-anchor="middle" dominant-baseline="middle">${msg}</text>
  `;
}

// nice tick 생성 (최대 n개)
function _niceTicks(min, max, n) {
  const range  = max - min || 1;
  const step   = _niceStep(range / n);
  const start  = Math.ceil(min / step) * step;
  const ticks  = [];
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

// VOLD 현재값 라벨 (M단위, 소수1자리)
function _fmtVold(v) {
  if (v == null || isNaN(v)) return '—';
  const n    = v / 1_000_000;
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}M`;
}

// VOLD y축 레이블 (짧게)
function _fmtVoldShort(v) {
  const n = v / 1_000_000;
  if (Math.abs(n) >= 1) return (n >= 0 ? '+' : '') + n.toFixed(0) + 'M';
  const k = v / 1_000;
  return (k >= 0 ? '+' : '') + k.toFixed(0) + 'k';
}
