/**
 * market.js -- Market 탭 v2 (지수 방향성 판단)
 *
 * 핵심 변경:
 *  - 만기를 날짜 단위로 선택 (체크박스 + 가중치 입력)
 *  - Apply 버튼 → 메모리(_rawData)에서 필터/합산 → 재렌더링 (API 재호출 없음)
 *  - 멀티행 히트맵 (만기별 행 + 합산 행) -- Canvas 직접 렌더링
 *  - Call/Put DEX 바 차트 (Chart.js)
 *  - 전체 Strike 원본 테이블 (2개월 이내)
 *  - [BUG FIX] expirations 구조 변경 대응 (.strikes / .flip_strike)
 *  - [NEW] 만기별 Strike 히트맵 (heatmap.js renderHeatmap 재사용)
 */

import { bindToggle } from '../tabs.js';
import { CF_API } from '../config.js';
import { renderHeatmap } from '../heatmap.js';

const WORKER_URL = CF_API;

// ── 색상 상수 ──────────────────────────────────────────────
const C_CALL   = { r: 63,  g: 185, b: 80  };
const C_PUT    = { r: 248, g: 81,  b: 73  };
const C_SPOT   = 'rgba(210,153,34,0.9)';
const C_BORDER = 'rgba(255,255,255,0.06)';

const ROW_COLORS = [
  '#58a6ff','#3fb950','#d29922','#bc64dc',
  '#f0883e','#2dd4bf','#a78bfa','#fb8f44',
  '#39d353','#ff6b6b',
];

// ── 상태 ──────────────────────────────────────────────────
let _rawData          = null;
let _spot             = 0;
let _symbol           = 'SPY';
let _expiryConfig     = {};
let _chart            = null;
let _pollTimer        = null;
let _selectedExpiry   = null;   // 만기별 히트맵에서 선택된 만기

// ── 공개 API ──────────────────────────────────────────────
export function initMarket() {
  bindToggle('market-symbol-toggle', (sym) => {
    _symbol = sym;
    _el('mk-chart-title').textContent = sym;
    _load();
  });

  _el('mk-apply-btn')?.addEventListener('click', _apply);
  _el('mk-select-all-btn')?.addEventListener('click', () => _setAllEnabled(true));
  _el('mk-deselect-btn')?.addEventListener('click', () => _setAllEnabled(false));
  _el('mk-reset-btn')?.addEventListener('click', _resetWeights);

  _el('mk-zoom-slider')?.addEventListener('input', (e) => {
    const z = parseFloat(e.target.value);
    _el('mk-zoom-val').textContent = `${z}×`;
    _resizeChart(z);
  });

  _load();
  _pollTimer = setInterval(_load, 5 * 60_000);
}

export function refreshMarket() {
  _load();
}

// ── 데이터 로딩 ───────────────────────────────────────────
async function _load() {
  try {
    const sym = _symbol.toLowerCase();
    const [dexRes, snapRes] = await Promise.all([
      fetch(`${WORKER_URL}/api/dex/${sym}`),
      fetch(`${WORKER_URL}/api/snapshot`),
    ]);

    const dexData  = dexRes.ok  ? await dexRes.json() : null;
    const snapData = snapRes.ok ? await snapRes.json() : null;

    if (!dexData?.expirations) {
      _showError('데이터 없음 -- /api/dex/' + sym);
      return;
    }

    _rawData = dexData;
    _spot    = parseFloat(snapData?.spy?.price ?? 0);

    _el('mk-spy').textContent = _spot ? `$${_spot.toFixed(2)}` : '--';
    _el('mk-vix').textContent = snapData?.vix?.price
      ? snapData.vix.price.toFixed(2) : '--';

    if (dexData.updated_at) {
      const t = new Date(dexData.updated_at);
      _el('market-ts').textContent =
        t.toLocaleTimeString('ko-KR', { timeZone: 'America/New_York' }) + ' ET';
    }

    _initExpiryConfig(dexData.expirations);
    _renderExpiryPanel();
    _renderRawTable(dexData.expirations);
    _renderExpiryHeatmapPanel(dexData.expirations);
    _apply();

  } catch (err) {
    console.error('[Market] 로딩 실패:', err);
    _showError(err.message);
  }
}

// ── 만기 Config 초기화 ────────────────────────────────────
function _initExpiryConfig(expirations) {
  const existing = Object.keys(_expiryConfig);

  Object.keys(expirations).forEach((expiry, i) => {
    if (_expiryConfig[expiry]) return;
    const dte = _calcDTE(expiry, new Date());
    _expiryConfig[expiry] = {
      enabled: dte <= 60,
      weight:  1.0,
      dte,
      color: ROW_COLORS[i % ROW_COLORS.length],
    };
  });

  existing.forEach(e => {
    if (!expirations[e]) delete _expiryConfig[e];
  });
}

// ── 만기 선택 패널 렌더링 ─────────────────────────────────
function _renderExpiryPanel() {
  const container = _el('mk-expiry-panel');
  if (!container) return;

  const sorted = Object.entries(_expiryConfig)
    .sort(([a], [b]) => a.localeCompare(b));

  container.innerHTML = sorted.map(([expiry, cfg]) => {
    const dteStr = cfg.dte === 0 ? '0DTE' : `${cfg.dte}d`;
    return `
      <div class="mk-expiry-row" style="display:flex;align-items:center;gap:8px;padding:4px 0">
        <input type="checkbox" class="mk-chk" data-expiry="${expiry}"
          ${cfg.enabled ? 'checked' : ''} style="cursor:pointer">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${cfg.color};flex-shrink:0"></span>
        <span style="font-family:var(--mono);font-size:12px;color:var(--text1);width:52px">${expiry.slice(5)}</span>
        <span style="font-size:11px;color:var(--text3);width:44px">(${dteStr})</span>
        <span style="font-size:11px;color:var(--text3)">×</span>
        <input type="number" class="mk-weight-input" data-expiry="${expiry}"
          value="${cfg.weight}" min="0" max="5" step="0.1"
          ${cfg.enabled ? '' : 'disabled'}
          style="width:52px;font-family:var(--mono);font-size:12px;
                 background:var(--bg3);border:1px solid var(--border);
                 border-radius:4px;color:var(--text1);padding:2px 4px;
                 opacity:${cfg.enabled ? 1 : 0.4}">
      </div>
    `;
  }).join('');

  container.querySelectorAll('.mk-chk').forEach(chk => {
    chk.addEventListener('change', (e) => {
      const exp = e.target.dataset.expiry;
      _expiryConfig[exp].enabled = e.target.checked;
      const inp = container.querySelector(`.mk-weight-input[data-expiry="${exp}"]`);
      if (inp) {
        inp.disabled = !e.target.checked;
        inp.style.opacity = e.target.checked ? 1 : 0.4;
      }
    });
  });

  container.querySelectorAll('.mk-weight-input').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const exp = e.target.dataset.expiry;
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val >= 0) _expiryConfig[exp].weight = val;
    });
  });
}

// ── Apply ─────────────────────────────────────────────────
function _apply() {
  if (!_rawData) return;
  const weighted = _buildWeighted(_rawData.expirations);
  _renderMetrics(weighted);
  _renderHeatmap(_rawData.expirations, weighted);
  _renderChart(weighted);
  _renderExpiryBars(_rawData.expirations);
  _renderKeyLevelTable(weighted, _rawData.expirations);
}

// ── 가중합산 계산 ─────────────────────────────────────────
// [BUG FIX] expirations[expiry]가 { strikes, flip_strike } 객체로 변경됨
function _buildWeighted(expirations) {
  const strikeMap = {};

  for (const [expiry, expiryData] of Object.entries(expirations)) {
    const cfg = _expiryConfig[expiry];
    if (!cfg?.enabled) continue;
    const w = cfg.weight;

    // .strikes 배열 추출 (구조 변경 대응)
    const strikes = Array.isArray(expiryData) ? expiryData : (expiryData.strikes ?? []);

    for (const s of strikes) {
      if (!strikeMap[s.strike]) {
        strikeMap[s.strike] = {
          strike: s.strike,
          callDex: 0, putDex: 0, netDex: 0,
          gex: 0, vanna: 0, charm: 0,
        };
      }
      const e = strikeMap[s.strike];
      e.callDex += s.dex > 0 ? s.dex * w : 0;
      e.putDex  += s.dex < 0 ? s.dex * w : 0;
      e.netDex  += s.dex * w;
      e.gex     += s.gex   * w;
      e.vanna   += s.vanna * w;
      e.charm   += s.charm * w;
    }
  }

  return Object.values(strikeMap).sort((a, b) => a.strike - b.strike);
}

// ── 메트릭 카드 ───────────────────────────────────────────
function _renderMetrics(weighted) {
  const spot     = _spot;
  const totalDex = weighted.reduce((a, s) => a + s.netDex, 0);
  _el('mk-dex').textContent = _fmtM(totalDex);
  _el('mk-dex').className   = 'metric-value ' + (totalDex >= 0 ? 'up' : 'down');

  const above = weighted.filter(s => s.strike > spot);
  const below = weighted.filter(s => s.strike <= spot);
  const near  = weighted.filter(s => Math.abs(s.strike - spot) <= 20);

  const callWall = above.length ? above.reduce((a, b) => a.callDex > b.callDex ? a : b) : null;
  const putWall  = below.length ? below.reduce((a, b) => Math.abs(a.putDex) > Math.abs(b.putDex) ? a : b) : null;

  let flipZone = null;
  for (let i = 0; i < near.length - 1; i++) {
    if ((near[i].netDex >= 0 && near[i+1].netDex < 0) ||
        (near[i].netDex < 0  && near[i+1].netDex >= 0)) {
      flipZone = near[i].netDex >= 0 ? near[i].strike : near[i+1].strike;
      break;
    }
  }

  _el('mk-call-wall').textContent = callWall ? `$${callWall.strike}` : '--';
  _el('mk-put-wall').textContent  = putWall  ? `$${putWall.strike}`  : '--';
  _el('mk-flip').textContent      = flipZone  ? `$${flipZone}`        : '--';
}

// ── 만기별 키레벨 추출 헬퍼 ──────────────────────────────
function _extractKeyLevels({ strikes, flip_strike }, spot) {
  const above = strikes.filter(s => s.dex > 0 && s.strike > (spot || 0));
  const M     = above.length ? above.reduce((a, b) => a.dex > b.dex ? a : b) : null;

  const below = strikes.filter(s => s.dex < 0 && s.strike <= (spot || Infinity));
  const m     = below.length ? below.reduce((a, b) => Math.abs(a.dex) > Math.abs(b.dex) ? a : b) : null;

  const G = flip_strike ?? null;

  return {
    M: M?.strike ?? null,
    m: m?.strike ?? null,
    G,
  };
}

// ── 멀티행 히트맵 (Canvas) -- M/m/G 마커 포함 ─────────────
// [BUG FIX] expirations[expiry]에서 .strikes / .flip_strike 추출
// [UPD] 마커 겹침 → 사선 표현 / Spot 실선 z-order 최상위
function _renderHeatmap(expirations, weighted) {
  const canvas = _el('mk-heatmap-canvas');
  if (!canvas) return;

  const spot = _spot;

  const allStrikes = [...new Set(
    Object.values(expirations)
      .flatMap(e => Array.isArray(e) ? e : (e.strikes ?? []))
      .map(s => s.strike)
  )].sort((a, b) => a - b)
    ;

  if (!allStrikes.length) return;

  const enabledExpiries = Object.entries(_expiryConfig)
    .filter(([, cfg]) => cfg.enabled)
    .sort(([a], [b]) => a.localeCompare(b));

  if (!enabledExpiries.length) return;

  const ROW_H    = 28;
  const LABEL_W  = 68;
  const CELL_W   = 22;
  const HEADER_H = 22;
  const SUM_H    = 32;
  const LEGEND_H = 18;

  const W = LABEL_W + allStrikes.length * CELL_W;
  const H = HEADER_H + enabledExpiries.length * ROW_H + SUM_H + LEGEND_H + 10;

  canvas.width  = W;
  canvas.height = H;
  canvas.style.width  = '100%';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  const maxVal = Math.max(
    ...Object.values(expirations)
      .flatMap(e => Array.isArray(e) ? e : (e.strikes ?? []))
      .map(s => Math.abs(s.dex)),
    1
  );
  const maxSum = Math.max(...weighted.map(s => Math.abs(s.netDex)), 1);

  const spotCol = spot ? allStrikes.findIndex(s => s >= spot) : -1;

  // ── 마커 그리기 헬퍼 ─────────────────────────────────────
  // hasM, hasm, hasG 조합에 따라 테두리·사선·라벨을 자동 결정
  // 그리기 순서: ① 사선(클립) → ② 테두리 → ③ 라벨
  // Spot 실선은 모든 셀/마커 이후 별도 패스로 최상위 렌더링
  const C_M = `rgb(${C_CALL.r},${C_CALL.g},${C_CALL.b})`;  // 초록
  const C_m = `rgb(${C_PUT.r},${C_PUT.g},${C_PUT.b})`;     // 빨강
  const C_G = 'rgb(139,92,246)';                             // 보라

  function _drawMarker(x, y, cellW, cellH, hasM, hasm, hasG) {
    if (!hasM && !hasm && !hasG) return;

    const x1 = x + 1, y1 = y + 1;
    const w  = cellW - 2, h = cellH - 2;

    // ① 사선 (클리핑 범위 = 셀 내부)
    ctx.save();
    ctx.beginPath();
    ctx.rect(x1, y1, w, h);
    ctx.clip();

    // M+G : 좌상→우하 보라 사선
    if (hasM && hasG) {
      ctx.strokeStyle = C_G;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x1,      y1 + h);
      ctx.lineTo(x1 + w,  y1);
      ctx.stroke();
    }
    // m+G : 좌상→우하 보라 사선
    if (hasm && hasG && !hasM) {
      ctx.strokeStyle = C_G;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x1,      y1 + h);
      ctx.lineTo(x1 + w,  y1);
      ctx.stroke();
    }
    // M+m : 좌상→우하 빨강 사선
    if (hasM && hasm && !hasG) {
      ctx.strokeStyle = C_m;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x1,      y1 + h);
      ctx.lineTo(x1 + w,  y1);
      ctx.stroke();
    }
    // M+m+G : 빨강 사선(↘) + 보라 사선(↙) 교차
    if (hasM && hasm && hasG) {
      ctx.strokeStyle = C_m;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(x1,     y1 + h);
      ctx.lineTo(x1 + w, y1);
      ctx.stroke();
      ctx.strokeStyle = C_G;
      ctx.beginPath();
      ctx.moveTo(x1 + w, y1 + h);
      ctx.lineTo(x1,     y1);
      ctx.stroke();
    }

    ctx.restore();

    // ② 테두리
    // 단독: 단색 / 겹침: 상+좌 = 주색, 하+우 = 부색
    ctx.lineWidth   = 1.8;
    ctx.setLineDash([]);

    const activeCount = [hasM, hasm, hasG].filter(Boolean).length;

    if (activeCount === 1) {
      ctx.strokeStyle = hasM ? C_M : hasm ? C_m : C_G;
      ctx.strokeRect(x1, y1, w, h);
    } else {
      let colorA, colorB;
      if (hasM && hasG && !hasm)      { colorA = C_M; colorB = C_G; }
      else if (hasm && hasG && !hasM) { colorA = C_m; colorB = C_G; }
      else if (hasM && hasm && !hasG) { colorA = C_M; colorB = C_m; }
      else                             { colorA = C_M; colorB = C_m; } // M+m+G

      // 상+좌 (colorA)
      ctx.strokeStyle = colorA;
      ctx.beginPath();
      ctx.moveTo(x1 + w, y1);
      ctx.lineTo(x1,     y1);
      ctx.lineTo(x1,     y1 + h);
      ctx.stroke();

      // 하+우 (colorB)
      ctx.strokeStyle = colorB;
      ctx.beginPath();
      ctx.moveTo(x1,     y1 + h);
      ctx.lineTo(x1 + w, y1 + h);
      ctx.lineTo(x1 + w, y1);
      ctx.stroke();
    }

    // ③ 라벨 (우상단)
    const label = [hasM ? 'M' : '', hasm ? 'm' : '', hasG ? 'G' : ''].filter(Boolean).join('');
    ctx.fillStyle = '#fff';
    ctx.font      = `bold ${label.length >= 3 ? 7 : 8}px monospace`;
    ctx.textAlign = 'right';
    ctx.fillText(label, x1 + w - 1, y1 + 9);
  }

  // ── 스트라이크 헤더 ───────────────────────────────────────
  ctx.font      = '9px monospace';
  ctx.textAlign = 'center';
  allStrikes.forEach((strike, i) => {
    const x      = LABEL_W + i * CELL_W + CELL_W / 2;
    const isSpot = i === spotCol;
    ctx.fillStyle = isSpot ? C_SPOT : (strike % 5 === 0 ? '#8b949e' : 'transparent');
    if (isSpot || strike % 5 === 0) {
      ctx.fillText(`$${strike}`, x, HEADER_H - 5);
    }
  });

  // ── 만기별 행 (셀 배경 + 마커) ──────────────────────────
  enabledExpiries.forEach(([expiry, cfg], rowIdx) => {
    const expiryData = expirations[expiry] ?? {};
    const rawStrikes = Array.isArray(expiryData) ? expiryData : (expiryData.strikes ?? []);
    const flipStrike = Array.isArray(expiryData) ? null : (expiryData.flip_strike ?? null);
    const strikeMap  = {};
    rawStrikes.forEach(s => { strikeMap[s.strike] = s; });

    const kl = _extractKeyLevels({ strikes: rawStrikes, flip_strike: flipStrike }, spot);

    const y = HEADER_H + rowIdx * ROW_H;

    ctx.fillStyle = cfg.color;
    ctx.font      = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(expiry.slice(5), LABEL_W - 4, y + ROW_H / 2 + 3);

    ctx.fillStyle = '#555';
    ctx.font      = '8px monospace';
    ctx.fillText(cfg.dte === 0 ? '0DTE' : `${cfg.dte}d`, LABEL_W - 4, y + ROW_H / 2 + 12);

    allStrikes.forEach((strike, i) => {
      const x = LABEL_W + i * CELL_W;
      const s = strikeMap[strike];

      // 셀 배경
      ctx.fillStyle = C_BORDER;
      ctx.fillRect(x + 1, y + 2, CELL_W - 2, ROW_H - 4);

      if (s) {
        const dex       = s.dex * cfg.weight;
        const intensity = Math.min(Math.abs(dex) / maxVal, 1);
        const c         = dex >= 0 ? C_CALL : C_PUT;
        ctx.fillStyle   = `rgba(${c.r},${c.g},${c.b},${(intensity * 0.8 + 0.1).toFixed(2)})`;
        ctx.fillRect(x + 1, y + 2, CELL_W - 2, ROW_H - 4);
      }

      // 마커 (겹침 포함)
      _drawMarker(x, y + 2, CELL_W, ROW_H - 4,
        strike === kl.M,
        strike === kl.m,
        strike === kl.G,
      );
    });
  });

  // ── 구분선 ───────────────────────────────────────────────
  const sumY = HEADER_H + enabledExpiries.length * ROW_H + 4;
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth   = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(0, sumY - 4);
  ctx.lineTo(W, sumY - 4);
  ctx.stroke();

  // ── 합산 행 ──────────────────────────────────────────────
  const weightedAsRaw = weighted.map(s => ({ strike: s.strike, dex: s.netDex }));
  const sumKl = _extractKeyLevels({ strikes: weightedAsRaw, flip_strike: null }, spot);

  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(0, sumY, W, SUM_H);

  ctx.fillStyle = '#c9d1d9';
  ctx.font      = '10px monospace';
  ctx.textAlign = 'right';
  ctx.fillText('합산', LABEL_W - 4, sumY + SUM_H / 2 + 4);

  allStrikes.forEach((strike, i) => {
    const x = LABEL_W + i * CELL_W;
    const s = weighted.find(w => w.strike === strike);

    ctx.fillStyle = C_BORDER;
    ctx.fillRect(x + 1, sumY + 2, CELL_W - 2, SUM_H - 4);

    if (s && s.netDex !== 0) {
      const intensity = Math.min(Math.abs(s.netDex) / maxSum, 1);
      const c         = s.netDex >= 0 ? C_CALL : C_PUT;
      ctx.fillStyle   = `rgba(${c.r},${c.g},${c.b},${(intensity * 0.9 + 0.1).toFixed(2)})`;
      ctx.fillRect(x + 1, sumY + 2, CELL_W - 2, SUM_H - 4);
    }

    // 마커 (겹침 포함)
    _drawMarker(x, sumY + 2, CELL_W, SUM_H - 4,
      strike === sumKl.M,
      strike === sumKl.m,
      strike === sumKl.G,
    );
  });

  // ── 범례 ─────────────────────────────────────────────────
  const legY = sumY + SUM_H + 6;
  const legItems = [
    { label: 'M = Call Wall',      color: C_M },
    { label: 'm = Put Wall',       color: C_m },
    { label: 'G = GEX Flip Zone',  color: C_G },
    { label: '사선 = 레벨 겹침',   color: '#8b949e' },
  ];
  let legX = LABEL_W;
  ctx.font      = '9px monospace';
  ctx.textAlign = 'left';
  legItems.forEach(({ label, color }) => {
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([]);
    ctx.strokeRect(legX, legY + 2, 10, 10);
    ctx.fillStyle = color;
    ctx.fillText(label, legX + 14, legY + 11);
    legX += label.length * 6 + 24;
  });

  // ── Spot 실선 + 삼각형 마커 (z-order 최상위 — 모든 셀/마커 위에 덮어 그림)
  if (spot && spotCol >= 0) {
    const sx = LABEL_W + spotCol * CELL_W;
    const mx = sx + CELL_W / 2;

    // 전체 높이 관통 실선 (헤더 아래 ~ 합산 행 끝)
    ctx.save();
    ctx.strokeStyle = C_SPOT;
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(sx, HEADER_H);
    ctx.lineTo(sx, sumY + SUM_H);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();

    // 삼각형 마커 (구분선 위)
    ctx.fillStyle = C_SPOT;
    ctx.beginPath();
    ctx.moveTo(mx,     sumY - 2);
    ctx.lineTo(mx - 5, sumY - 9);
    ctx.lineTo(mx + 5, sumY - 9);
    ctx.closePath();
    ctx.fill();

    // 현재가 텍스트
    ctx.fillStyle = C_SPOT;
    ctx.font      = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`$${spot.toFixed(0)}`, mx, sumY - 11);
  }

  // ── 드래그 스크롤 + 최초 spot 중앙 스크롤 ───────────────
  // Canvas의 부모 overflow 컨테이너에 적용
  const wrap = canvas.parentElement;
  if (wrap) {
    // 최초 1회: spot 열이 중앙에 오도록 스크롤
    if (spotCol >= 0) {
      const scrollTarget = LABEL_W + spotCol * CELL_W - wrap.clientWidth / 2 + CELL_W / 2;
      wrap.scrollLeft = Math.max(0, scrollTarget);
    }
    // 드래그 스크롤 (중복 등록 방지)
    if (!wrap._dragScrollBound) {
      _attachDragScroll(wrap);
      wrap._dragScrollBound = true;
    }
  }
}

// ── Chart.js 바 차트 ──────────────────────────────────────
function _renderChart(weighted) {
  const wrap = _el('mk-chart-wrap');
  if (!wrap) return;

  const spot = _spot;
  let visible = weighted.filter(s =>
    !spot || (s.strike >= spot - 30 && s.strike <= spot + 30)
  );
  if (!visible.length) {
    const mid = Math.floor(weighted.length / 2);
    visible = weighted.slice(Math.max(0, mid - 50), mid + 50);
  }
  if (!visible.length) return;

  const zoom   = parseFloat(_el('mk-zoom-slider')?.value ?? 1);
  const barW   = Math.max(14, 22 * zoom);
  const chartW = Math.max(visible.length * barW * 2 + 80, 600);

  wrap.style.width = `${chartW}px`;
  wrap.innerHTML   = '';

  const canvas = document.createElement('canvas');
  canvas.style.width  = '100%';
  canvas.style.height = '280px';
  wrap.appendChild(canvas);

  if (_chart) { _chart.destroy(); _chart = null; }

  const labels   = visible.map(s => `$${s.strike}`);
  const callData = visible.map(s => +s.callDex.toFixed(2));
  const putData  = visible.map(s => +s.putDex.toFixed(2));

  _chart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Call DEX', data: callData,
          backgroundColor: `rgba(${C_CALL.r},${C_CALL.g},${C_CALL.b},0.75)`,
          borderColor: `rgba(${C_CALL.r},${C_CALL.g},${C_CALL.b},0.9)`, borderWidth: 1 },
        { label: 'Put DEX', data: putData,
          backgroundColor: `rgba(${C_PUT.r},${C_PUT.g},${C_PUT.b},0.75)`,
          borderColor: `rgba(${C_PUT.r},${C_PUT.g},${C_PUT.b},0.9)`, borderWidth: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 200 },
      scales: {
        x: { stacked: true, ticks: { color: '#8b949e', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { stacked: true, ticks: { color: '#8b949e', font: { size: 10 }, callback: v => _fmtM(v) }, grid: { color: 'rgba(255,255,255,0.04)' } },
      },
      plugins: {
        legend: { labels: { color: '#c9d1d9', font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${_fmtM(ctx.raw)}` } },
      },
    },
    plugins: [_spotLinePlugin(spot, labels)],
  });
}

function _spotLinePlugin(spot, labels) {
  return {
    id: 'mk-spot-line',
    afterDraw(chart) {
      if (!spot) return;
      const idx = labels.findIndex(l => parseFloat(l.replace('$','')) >= spot);
      if (idx < 0) return;
      const { ctx, chartArea: { top, bottom }, scales: { x } } = chart;
      const xPos = x.getPixelForValue(idx - 0.5);
      ctx.save();
      ctx.beginPath(); ctx.moveTo(xPos, top); ctx.lineTo(xPos, bottom);
      ctx.strokeStyle = C_SPOT; ctx.lineWidth = 1.5; ctx.setLineDash([4,3]); ctx.stroke();
      ctx.fillStyle = C_SPOT; ctx.font = '10px monospace'; ctx.textAlign = 'center';
      ctx.fillText(`SPY $${spot.toFixed(0)}`, xPos, top - 4);
      ctx.restore();
    },
  };
}

function _resizeChart(zoom) {
  if (!_rawData || !_spot) return;
  const weighted = _buildWeighted(_rawData.expirations);
  const visible  = weighted.filter(s => s.strike >= _spot - 30 && s.strike <= _spot + 30);
  const barW   = Math.max(14, 22 * zoom);
  const chartW = Math.max(visible.length * barW * 2 + 80, 600);
  const wrap   = _el('mk-chart-wrap');
  if (wrap) wrap.style.width = `${chartW}px`;
}

// ── 만기별 DEX 분포 바 ────────────────────────────────────
// [BUG FIX] .strikes 추출 일관화
function _renderExpiryBars(expirations) {
  const container = _el('mk-expiry-bars');
  if (!container) return;

  const items = Object.entries(_expiryConfig)
    .filter(([, cfg]) => cfg.enabled)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([expiry, cfg]) => {
      const expiryData = expirations[expiry];
      const strikes = Array.isArray(expiryData)
        ? expiryData
        : (expiryData?.strikes ?? []);
      const dex = strikes.reduce((acc, s) => acc + s.dex * cfg.weight, 0);
      return { expiry, dex, cfg };
    });

  const total = items.reduce((a, b) => a + Math.abs(b.dex), 0) || 1;

  container.innerHTML = items.map(({ expiry, dex, cfg }) => {
    const pct   = Math.abs(dex) / total * 100;
    const color = dex >= 0 ? 'var(--green)' : 'var(--red)';
    const sign  = dex >= 0 ? '+' : '';
    const label = `${expiry.slice(5)} (${cfg.dte === 0 ? '0DTE' : cfg.dte + 'd'}) ×${cfg.weight}`;
    return `
      <div style="display:flex;align-items:center;gap:10px">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${cfg.color};flex-shrink:0"></span>
        <span style="font-size:11px;color:var(--text3);width:160px;flex-shrink:0;font-family:var(--mono)">${label}</span>
        <div style="flex:1;background:var(--bg3);border-radius:4px;height:16px;overflow:hidden">
          <div style="width:${pct.toFixed(1)}%;height:100%;background:${color};border-radius:4px;transition:width 0.3s"></div>
        </div>
        <span style="font-family:var(--mono);font-size:12px;color:${color};width:72px;text-align:right;flex-shrink:0">${sign}${_fmtM(dex)}</span>
        <span style="font-size:10px;color:var(--text3);width:32px;text-align:right;flex-shrink:0">${pct.toFixed(0)}%</span>
      </div>
    `;
  }).join('');
}

// ── Key Level Tracker ─────────────────────────────────────
// [BUG FIX] .strikes 추출 일관화
function _renderKeyLevelTable(weighted, expirations) {
  const tbody = _el('mk-keylevel-tbody');
  if (!tbody) return;

  const spot     = _spot;
  const todayStr = _fmtDate(new Date());

  // [BUG FIX] .strikes 추출
  const dte0Raw  = expirations[todayStr];
  const dte0Arr  = Array.isArray(dte0Raw)
    ? dte0Raw
    : (dte0Raw?.strikes ?? []);
  const dte0 = dte0Arr.map(s => ({
    strike: s.strike,
    callDex: s.dex > 0 ? s.dex : 0,
    putDex:  s.dex < 0 ? s.dex : 0,
    netDex:  s.dex,
  }));

  const _extract = (strikes) => {
    const above = strikes.filter(s => s.strike > spot);
    const below = strikes.filter(s => s.strike <= spot);
    const near  = strikes.filter(s => Math.abs(s.strike - spot) <= 20);
    const callWall = above.length ? above.reduce((a, b) => a.callDex > b.callDex ? a : b) : null;
    const putWall  = below.length ? below.reduce((a, b) => Math.abs(a.putDex) > Math.abs(b.putDex) ? a : b) : null;
    let flip = null;
    for (let i = 0; i < near.length - 1; i++) {
      if ((near[i].netDex >= 0 && near[i+1].netDex < 0) ||
          (near[i].netDex < 0  && near[i+1].netDex >= 0)) {
        flip = near[i].netDex >= 0 ? near[i].strike : near[i+1].strike;
        break;
      }
    }
    return { callWall: callWall?.strike, putWall: putWall?.strike, flip };
  };

  const lv0   = _extract(dte0);
  const lvAll = _extract(weighted);

  const rows = [
    { name: 'Call Wall', v0: lv0.callWall, vAll: lvAll.callWall,
      interp: (v0, vAll) => {
        if (!v0 || !vAll) return '--';
        const d = vAll - v0;
        if (d > 2)  return `선택만기 ${d.toFixed(0)}pt 위 → 숨겨진 상승 압력`;
        if (d < -2) return `선택만기 ${Math.abs(d).toFixed(0)}pt 아래 → 저항 더 가까움`;
        return '0DTE·선택만기 일치 → 신뢰도 높은 저항';
      }},
    { name: 'Put Wall', v0: lv0.putWall, vAll: lvAll.putWall,
      interp: (v0, vAll) => {
        if (!v0 || !vAll) return '--';
        const d = vAll - v0;
        if (d < -2) return `선택만기 ${Math.abs(d).toFixed(0)}pt 아래 → 더 강한 지지`;
        if (d > 2)  return `선택만기 ${d.toFixed(0)}pt 위 → 지지 약화 가능`;
        return '0DTE·선택만기 일치 → 신뢰도 높은 지지';
      }},
    { name: 'Flip Zone', v0: lv0.flip, vAll: lvAll.flip,
      interp: (v0, vAll) => {
        if (!v0 || !vAll) return '--';
        const d = vAll - v0;
        if (Math.abs(d) <= 1) return '0DTE·선택만기 Flip 일치 → 핵심 레벨';
        if (d > 0) return `선택만기 Flip ${d.toFixed(0)}pt 위 → 딜러 중립선 상방`;
        return `선택만기 Flip ${Math.abs(d).toFixed(0)}pt 아래 → 딜러 중립선 하방`;
      }},
  ];

  tbody.innerHTML = rows.map(r => {
    const v0Str   = r.v0   ? `$${r.v0}`   : '--';
    const vAllStr = r.vAll ? `$${r.vAll}` : '--';
    const diff    = (r.v0 && r.vAll) ? r.vAll - r.v0 : null;
    const diffStr = diff !== null
      ? `<span style="color:${diff > 0 ? 'var(--green)' : diff < 0 ? 'var(--red)' : 'var(--text3)'}">
           ${diff > 0 ? '+' : ''}${diff.toFixed(0)}pt</span>`
      : '--';
    return `<tr>
      <td style="font-weight:500">${r.name}</td>
      <td style="color:var(--green);font-family:var(--mono)">${v0Str}</td>
      <td style="color:var(--blue);font-family:var(--mono)">${vAllStr}</td>
      <td>${diffStr}</td>
      <td style="font-size:11px;color:var(--text3)">${r.interp(r.v0, r.vAll)}</td>
    </tr>`;
  }).join('');
}

// ── 전체 Strike 원본 테이블 (2개월 이내) ─────────────────
// [BUG FIX] .strikes 추출 일관화
function _renderRawTable(expirations) {
  const tbody = _el('mk-raw-tbody');
  if (!tbody) return;

  const today = new Date();
  const rows  = [];

  Object.entries(expirations)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([expiry, expiryData]) => {
      const dte = _calcDTE(expiry, today);
      if (dte > 60) return;
      const cfg = _expiryConfig[expiry];
      // [BUG FIX] .strikes 추출
      const strikes = Array.isArray(expiryData) ? expiryData : (expiryData.strikes ?? []);
      strikes.forEach(s => rows.push({
        expiry, dte, strike: s.strike,
        dex: s.dex, gex: s.gex, vanna: s.vanna, charm: s.charm,
        color: cfg?.color ?? '#666',
      }));
    });

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty">데이터 없음</div></td></tr>';
    return;
  }

  const maxAbsDex = Math.max(...rows.map(r => Math.abs(r.dex)), 1);

  tbody.innerHTML = rows.map(r => {
    const pct = Math.abs(r.dex) / maxAbsDex;
    const bg  = r.dex >= 0
      ? `rgba(${C_CALL.r},${C_CALL.g},${C_CALL.b},${(pct * 0.22).toFixed(2)})`
      : `rgba(${C_PUT.r},${C_PUT.g},${C_PUT.b},${(pct * 0.22).toFixed(2)})`;
    return `<tr style="background:${bg}">
      <td style="font-family:var(--mono)">
        <span style="display:inline-block;width:6px;height:6px;border-radius:50%;
          background:${r.color};margin-right:5px;vertical-align:middle"></span>${r.expiry.slice(5)}
      </td>
      <td style="font-family:var(--mono);color:var(--text3)">${r.dte === 0 ? '0DTE' : r.dte + 'd'}</td>
      <td style="font-family:var(--mono);font-weight:500">$${r.strike}</td>
      <td style="font-family:var(--mono);color:${r.dex >= 0 ? 'var(--green)' : 'var(--red)'}">
        ${r.dex >= 0 ? '+' : ''}${_fmtM(r.dex)}</td>
      <td style="font-family:var(--mono)">${_fmtM(r.gex)}</td>
      <td style="font-family:var(--mono);color:var(--purple)">${_fmtM(r.vanna)}</td>
      <td style="font-family:var(--mono);color:var(--teal)">${_fmtM(r.charm)}</td>
    </tr>`;
  }).join('');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// [NEW] 만기별 Strike 히트맵 패널
// heatmap.js의 renderHeatmap()을 재사용 (containerId: mk-expiry-heatmap)
// live.js의 heatmap-canvas와 완전 분리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _renderExpiryHeatmapPanel(expirations) {
  const btnGroup = _el('mk-ehm-btn-group');
  const container = _el('mk-expiry-heatmap');
  if (!btnGroup || !container) return;

  // 60DTE 이내 만기만 버튼으로 표시
  const sorted = Object.keys(expirations)
    .filter(exp => _calcDTE(exp, new Date()) <= 60)
    .sort();

  if (!sorted.length) {
    btnGroup.innerHTML = '<span style="font-size:12px;color:var(--text3)">만기 데이터 없음</span>';
    container.innerHTML = '';
    return;
  }

  // 선택된 만기가 없거나 목록에 없으면 첫 번째로 초기화
  if (!_selectedExpiry || !sorted.includes(_selectedExpiry)) {
    _selectedExpiry = sorted[0];
  }

  // 버튼 렌더링
  btnGroup.innerHTML = sorted.map(exp => {
    const dte = _calcDTE(exp, new Date());
    const dteStr = dte === 0 ? '0DTE' : `${dte}d`;
    const cfg = _expiryConfig[exp];
    const isActive = exp === _selectedExpiry;
    return `
      <button class="toggle-btn mk-ehm-btn ${isActive ? 'active' : ''}"
        data-expiry="${exp}"
        style="font-family:var(--mono);font-size:11px;padding:3px 8px;
               border-left:2px solid ${cfg?.color ?? '#666'}">
        ${exp.slice(5)}<span style="color:var(--text3);font-size:10px;margin-left:3px">(${dteStr})</span>
      </button>`;
  }).join('');

  // 버튼 이벤트
  btnGroup.querySelectorAll('.mk-ehm-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      _selectedExpiry = e.currentTarget.dataset.expiry;
      // 버튼 active 상태 갱신
      btnGroup.querySelectorAll('.mk-ehm-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.expiry === _selectedExpiry);
      });
      _renderSelectedExpiryHeatmap(expirations);
    });
  });

  // 선택된 만기 히트맵 렌더링
  _renderSelectedExpiryHeatmap(expirations);
}

function _renderSelectedExpiryHeatmap(expirations) {
  const container = _el('mk-expiry-heatmap');
  if (!container || !_selectedExpiry) return;

  const expiryData = expirations[_selectedExpiry];
  if (!expiryData) {
    container.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px">데이터 없음</div>';
    return;
  }

  // .strikes 추출
  const strikes = Array.isArray(expiryData) ? expiryData : (expiryData.strikes ?? []);
  const flipStrike = Array.isArray(expiryData) ? null : (expiryData.flip_strike ?? null);

  if (!strikes.length) {
    container.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px">Strike 데이터 없음</div>';
    return;
  }

  // flip_strike 정보 표시
  const flipInfo = _el('mk-ehm-flip');
  if (flipInfo) {
    flipInfo.textContent = flipStrike ? `Flip Zone: $${flipStrike}` : '';
  }

  // heatmap.js renderHeatmap 호출
  // containerId: 'mk-expiry-heatmap' — live.js의 'heatmap-canvas'와 분리
  const spot = _spot;
  renderHeatmap('mk-expiry-heatmap', strikes, spot || 0);
}

// ── 드래그 스크롤 헬퍼 ───────────────────────────────────
// 마우스/터치 드래그로 좌우 스크롤 (overflow-x:auto 컨테이너에 부착)
function _attachDragScroll(el) {
  let isDown = false, startX = 0, scrollLeft = 0;

  el.addEventListener('mousedown', (e) => {
    isDown = true;
    el.style.cursor = 'grabbing';
    startX = e.pageX - el.offsetLeft;
    scrollLeft = el.scrollLeft;
  });
  el.addEventListener('mouseleave', () => { isDown = false; el.style.cursor = ''; });
  el.addEventListener('mouseup',    () => { isDown = false; el.style.cursor = ''; });
  el.addEventListener('mousemove',  (e) => {
    if (!isDown) return;
    e.preventDefault();
    const x    = e.pageX - el.offsetLeft;
    const walk = (x - startX) * 1.2;
    el.scrollLeft = scrollLeft - walk;
  });

  // 터치
  let touchStartX = 0, touchScrollLeft = 0;
  el.addEventListener('touchstart', (e) => {
    touchStartX    = e.touches[0].pageX;
    touchScrollLeft = el.scrollLeft;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const dx = touchStartX - e.touches[0].pageX;
    el.scrollLeft = touchScrollLeft + dx;
  }, { passive: true });
}

// ── 헬퍼 ──────────────────────────────────────────────────
function _setAllEnabled(flag) {
  Object.keys(_expiryConfig).forEach(e => { _expiryConfig[e].enabled = flag; });
  _renderExpiryPanel();
}

function _resetWeights() {
  Object.keys(_expiryConfig).forEach(e => {
    _expiryConfig[e].weight  = 1.0;
    _expiryConfig[e].enabled = true;
  });
  _renderExpiryPanel();
}

function _el(id) { return document.getElementById(id); }

function _fmtM(v) {
  if (v == null || isNaN(v)) return '--';
  const abs = Math.abs(v), sign = v < 0 ? '-' : '';
  if (abs >= 1000) return `${sign}${(abs/1000).toFixed(1)}B`;
  if (abs >= 1)    return `${sign}${abs.toFixed(1)}M`;
  return `${sign}${(abs*1000).toFixed(0)}K`;
}

function _calcDTE(expiry, today) {
  const exp = new Date(`${expiry}T16:00:00-05:00`);
  return Math.max(0, Math.round((exp - today) / 86_400_000));
}

function _fmtDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function _showError(msg) {
  ['mk-dex','mk-call-wall','mk-put-wall','mk-flip'].forEach(id => {
    const el = _el(id); if (el) el.textContent = '--';
  });
  const bars = _el('mk-expiry-bars');
  if (bars) bars.innerHTML = `<div class="empty" style="color:var(--red)">오류: ${msg}</div>`;
}
