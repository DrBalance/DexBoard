/**
 * chart-zoom.js — Canvas 줌/스크롤 공통 유틸
 *
 * 사용법:
 *   import { createZoomState, attachZoomScroll } from './chart-zoom.js';
 *
 *   const zoom = createZoomState({ minX: 500, maxX: 600 });
 *   attachZoomScroll(canvas, zoom, () => redraw(zoom));
 *
 * zoom 객체:
 *   { viewMin, viewMax, setRange, reset, toDataX, toPixelX }
 */

// ── ZoomState 생성 ───────────────────────────────────────
export function createZoomState({ minX, maxX, initMin, initMax }) {
  const state = {
    dataMin:  minX,
    dataMax:  maxX,
    viewMin:  initMin ?? minX,
    viewMax:  initMax ?? maxX,

    // 뷰 범위 직접 설정 (clamp 포함)
    setRange(vMin, vMax) {
      const span   = Math.max(vMax - vMin, (maxX - minX) * 0.05); // 최소 5% 범위
      const cMin   = Math.max(minX, Math.min(vMin, maxX - span));
      const cMax   = Math.min(maxX, Math.max(vMax, minX + span));
      state.viewMin = cMin;
      state.viewMax = cMax;
    },

    reset() {
      state.viewMin = minX;
      state.viewMax = maxX;
    },

    // 픽셀 → 데이터 X 변환
    toDataX(px, canvasW, padL = 0, padR = 0) {
      const cW = canvasW - padL - padR;
      return state.viewMin + ((px - padL) / cW) * (state.viewMax - state.viewMin);
    },

    // 데이터 X → 픽셀 변환
    toPixelX(dataX, canvasW, padL = 0, padR = 0) {
      const cW = canvasW - padL - padR;
      return padL + ((dataX - state.viewMin) / (state.viewMax - state.viewMin)) * cW;
    },

    get zoom() {
      return (maxX - minX) / Math.max(state.viewMax - state.viewMin, 1e-10);
    },
  };
  return state;
}

// ── 이벤트 연결 ──────────────────────────────────────────
export function attachZoomScroll(canvas, zoomState, onDraw, opts = {}) {
  const {
    padL      = 56,
    padR      = 16,
    zoomSpeed = 0.0012,
    minZoom   = 1,
    maxZoom   = 50,
  } = opts;

  let dragStart = null; // { x, viewMin, viewMax }
  let lastTouches = null;

  // ── 휠 줌 ──────────────────────────────────────────────
  function onWheel(e) {
    e.preventDefault();
    const rect      = canvas.getBoundingClientRect();
    const mouseX    = e.clientX - rect.left;
    const anchorData = zoomState.toDataX(mouseX, canvas.clientWidth, padL, padR);

    const delta   = e.deltaY * zoomSpeed;
    const newZoom = Math.max(minZoom, Math.min(maxZoom, zoomState.zoom * (1 + delta)));
    const span    = (zoomState.dataMax - zoomState.dataMin) / newZoom;
    const ratio   = (anchorData - zoomState.viewMin) / (zoomState.viewMax - zoomState.viewMin);

    zoomState.setRange(anchorData - span * ratio, anchorData + span * (1 - ratio));
    onDraw();
  }

  // ── 마우스 드래그 팬 ───────────────────────────────────
  function onMouseDown(e) {
    if (e.button !== 0) return;
    dragStart = { x: e.clientX, viewMin: zoomState.viewMin, viewMax: zoomState.viewMax };
    canvas.style.cursor = 'grabbing';
  }

  function onMouseMove(e) {
    if (!dragStart) return;
    const dx       = e.clientX - dragStart.x;
    const cW       = canvas.clientWidth - padL - padR;
    const span     = dragStart.viewMax - dragStart.viewMin;
    const shift    = -(dx / cW) * span;
    zoomState.setRange(dragStart.viewMin + shift, dragStart.viewMax + shift);
    onDraw();
  }

  function onMouseUp() {
    dragStart = null;
    canvas.style.cursor = 'crosshair';
  }

  // ── 터치 핀치 줌 + 팬 ─────────────────────────────────
  function onTouchStart(e) {
    if (e.touches.length === 2) {
      lastTouches = [
        { x: e.touches[0].clientX },
        { x: e.touches[1].clientX },
      ];
    } else if (e.touches.length === 1) {
      dragStart = {
        x: e.touches[0].clientX,
        viewMin: zoomState.viewMin,
        viewMax: zoomState.viewMax,
      };
    }
  }

  function onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 2 && lastTouches) {
      const prevDist = Math.abs(lastTouches[1].x - lastTouches[0].x);
      const currDist = Math.abs(e.touches[1].clientX - e.touches[0].clientX);
      const scale    = prevDist / Math.max(currDist, 1);
      const midData  = zoomState.toDataX(
        (e.touches[0].clientX + e.touches[1].clientX) / 2,
        canvas.clientWidth, padL, padR
      );
      const span     = (zoomState.viewMax - zoomState.viewMin) * scale;
      const ratio    = (midData - zoomState.viewMin) / (zoomState.viewMax - zoomState.viewMin);
      const newZoom  = (zoomState.dataMax - zoomState.dataMin) / span;
      if (newZoom >= minZoom && newZoom <= maxZoom) {
        zoomState.setRange(midData - span * ratio, midData + span * (1 - ratio));
      }
      lastTouches = [{ x: e.touches[0].clientX }, { x: e.touches[1].clientX }];
      onDraw();
    } else if (e.touches.length === 1 && dragStart) {
      const dx    = e.touches[0].clientX - dragStart.x;
      const cW    = canvas.clientWidth - padL - padR;
      const span  = dragStart.viewMax - dragStart.viewMin;
      const shift = -(dx / cW) * span;
      zoomState.setRange(dragStart.viewMin + shift, dragStart.viewMax + shift);
      onDraw();
    }
  }

  function onTouchEnd() {
    lastTouches = null;
    dragStart   = null;
  }

  // ── 더블클릭 리셋 ──────────────────────────────────────
  function onDblClick() {
    zoomState.reset();
    onDraw();
  }

  // ── 이벤트 등록 ───────────────────────────────────────
  canvas.addEventListener('wheel',       onWheel,      { passive: false });
  canvas.addEventListener('mousedown',   onMouseDown);
  canvas.addEventListener('mousemove',   onMouseMove);
  canvas.addEventListener('mouseup',     onMouseUp);
  canvas.addEventListener('mouseleave',  onMouseUp);
  canvas.addEventListener('touchstart',  onTouchStart, { passive: true });
  canvas.addEventListener('touchmove',   onTouchMove,  { passive: false });
  canvas.addEventListener('touchend',    onTouchEnd);
  canvas.addEventListener('dblclick',    onDblClick);

  canvas.style.cursor = 'crosshair';

  // 클린업 함수 반환
  return function detach() {
    canvas.removeEventListener('wheel',       onWheel);
    canvas.removeEventListener('mousedown',   onMouseDown);
    canvas.removeEventListener('mousemove',   onMouseMove);
    canvas.removeEventListener('mouseup',     onMouseUp);
    canvas.removeEventListener('mouseleave',  onMouseUp);
    canvas.removeEventListener('touchstart',  onTouchStart);
    canvas.removeEventListener('touchmove',   onTouchMove);
    canvas.removeEventListener('touchend',    onTouchEnd);
    canvas.removeEventListener('dblclick',    onDblClick);
  };
}
