/**
 * market.js — Market 탭 v2 (지수 방향성 판단)
 *
 * 핵심 변경:
 *  - 만기를 날짜 단위로 선택 (체크박스 + 가중치 입력)
 *  - Apply 버튼 → 메모리(_rawData)에서 필터/합산 → 재렌더링 (API 재호출 없음)
 *  - 멀티행 히트맵 (만기별 행 + 합산 행) — Canvas 직접 렌더링
 *  - Call/Put DEX 바 차트 (Chart.js)
 *  - 전체 Strike 원본 테이블 (2개월 이내)
 */

import { bindToggle } from '../tabs.js';
import { CF_API } from '../config.js';

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
let _rawData      = null;
let _spot         = 0;
let _symbol       = 'SPY';
let _expiryConfig = {};
let _chart        = null;
let _pollTimer    = null;

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
      _showError('데이터 없음 — /api/dex/' + sym);
      return;
    }

    _rawData = dexData;
    _spot    = parseFloat(snapData?.spy?.price ?? 0);

    _el('mk-spy').textContent = _spot ? `$${_spot.toFixed(2)}` : '—';
    _el('mk-vix').textContent = snapData?.vix?.price
      ? snapData.vix.price.toFixed(2) : '—';

    if (dexData.updated_at) {
      const t = new Date(dexData.updated_at);
      _el('market-ts').textContent =
        t.toLocaleTimeString('ko-KR', { timeZone: 'America/New_York' }) + ' ET';
    }

    _initExpiryConfig(dexData.expirations);
    _renderExpiryPanel();
    _renderRawTable(dexData.expirations);
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
      enabled: true,
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
    inp.addEventListener('change', (e) => {
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
function _buildWeighted(expirations) {
  const strikeMap = {};

  for (const [expiry, strikes] of Object.entries(expirations)) {
    const cfg = _expiryConfig[expiry];
    if (!cfg?.enabled) continue;
    const w = cfg.weight;

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

  _el('mk-call-wall').textContent = callWall ? `$${callWall.strike}` : '—';
  _el('mk-put-wall').textContent  = putWall  ? `$${putWall.strike}`  : '—';
  _el('mk-flip').textContent      = flipZone  ? `$${flipZone}`        : '—';
}

// ── 만기별 키레벨 추출 헬퍼 ──────────────────────────────
function _extractKeyLevels(strikes, spot) {
  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);

  // M: Call DEX 최대 스트라이크 (현재가 위)
  const above = strikes.filter(s => s.dex > 0 && s.strike > (spot || 0));
  const M     = above.length ? above.reduce((a, b) => a.dex > b.dex ? a : b) : null;

  // m: Put DEX 최대 스트라이크 (현재가 아래, 절대값 기준)
  const below = strikes.filter(s => s.dex < 0 && s.strike <= (spot || Infinity));
  const m     = below.length ? below.reduce((a, b) => Math.abs(a.dex) > Math.abs(b.dex) ? a : b) : null;

  // F: DEX 개별 부호 전환점 (기존 방식)
  let F = null;
  for (let i = 0; i < sorted.length - 1; i++) {
    if ((sorted[i].dex >= 0 && sorted[i+1].dex < 0) ||
        (sorted[i].dex < 0  && sorted[i+1].dex >= 0)) {
      F = sorted[i].dex >= 0 ? sorted[i].strike : sorted[i+1].strike;
      if (spot && Math.abs(sorted[i].strike - spot) > 25) continue;
      break;
    }
  }

  // G: GEX 누적합 부호 전환점 (표준 Flip Zone)
  // 낮은 스트라이크부터 누적 — 음수→양수 전환점이 Flip
  let G = null;
  let cumGex = 0;
  let prevSign = null;
  for (const s of sorted) {
    cumGex += (s.gex ?? 0);
    const sign = cumGex >= 0 ? 1 : -1;
    if (prevSign !== null && sign !== prevSign) {
      G = s.strike;
      break;
    }
    prevSign = sign;
  }

  return {
    M: M?.strike ?? null,
    m: m?.strike ?? null,
    F,   // DEX 개별 부호 전환 (기존)
    G,   // GEX 누적합 부호 전환 (표준)
  };
}

// ── 멀티행 히트맵 (Canvas) — M/m/F 마커 포함 ─────────────
function _renderHeatmap(expirations, weighted) {
  const canvas = _el('mk-heatmap-canvas');
  if (!canvas) return;

  const spot = _spot;

  // 표시 스트라이크: 현재가 ±30 범위
  const allStrikes = [...new Set(
    Object.values(expirations).flat().map(s => s.strike)
  )].sort((a, b) => a - b)
    .filter(s => !spot || (s >= spot - 30 && s <= spot + 30));

  if (!allStrikes.length) return;

  const enabledExpiries = Object.entries(_expiryConfig)
    .filter(([, cfg]) => cfg.enabled)
    .sort(([a], [b]) => a.localeCompare(b));

  if (!enabledExpiries.length) return;

  // 레이아웃 상수
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

  // 최대값 계산
  const maxVal = Math.max(
    ...Object.values(expirations).flat().map(s => Math.abs(s.dex)), 1
  );
  const maxSum = Math.max(...weighted.map(s => Math.abs(s.netDex)), 1);

  // spotCol: 현재가 이상의 첫 번째 스트라이크 인덱스
  const spotCol = spot ? allStrikes.findIndex(s => s >= spot) : -1;

  // ── 마커 그리기 헬퍼
  function _drawMarker(ctx, label, x, y, cellW, cellH, borderColor, textColor) {
    // 테두리
    ctx.strokeStyle = borderColor;
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([]);
    ctx.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2);

    // 라벨 (우상단)
    ctx.fillStyle  = textColor;
    ctx.font       = 'bold 8px monospace';
    ctx.textAlign  = 'center';
    ctx.fillText(label, x + cellW - 6, y + 9);
  }

  // ── 스트라이크 헤더
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

  // ── 만기별 행
  enabledExpiries.forEach(([expiry, cfg], rowIdx) => {
    const rawStrikes = expirations[expiry] ?? [];
    const strikeMap  = {};
    rawStrikes.forEach(s => { strikeMap[s.strike] = s; });

    // 이 만기의 키레벨 추출
    const kl = _extractKeyLevels(rawStrikes, spot);

    const y = HEADER_H + rowIdx * ROW_H;

    // 행 레이블
    ctx.fillStyle = cfg.color;
    ctx.font      = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(expiry.slice(5), LABEL_W - 4, y + ROW_H / 2 + 3);

    ctx.fillStyle = '#555';
    ctx.font      = '8px monospace';
    ctx.fillText(cfg.dte === 0 ? '0DTE' : `${cfg.dte}d`, LABEL_W - 4, y + ROW_H / 2 + 12);

    // 셀
    allStrikes.forEach((strike, i) => {
      const x = LABEL_W + i * CELL_W;
      const s = strikeMap[strike];

      // 배경
      ctx.fillStyle = C_BORDER;
      ctx.fillRect(x + 1, y + 2, CELL_W - 2, ROW_H - 4);

      // DEX 색상
      if (s) {
        const dex       = s.dex * cfg.weight;
        const intensity = Math.min(Math.abs(dex) / maxVal, 1);
        const c         = dex >= 0 ? C_CALL : C_PUT;
        ctx.fillStyle   = `rgba(${c.r},${c.g},${c.b},${(intensity * 0.8 + 0.1).toFixed(2)})`;
        ctx.fillRect(x + 1, y + 2, CELL_W - 2, ROW_H - 4);
      }

      // 현재가 컬럼 세로선
      if (i === spotCol) {
        ctx.strokeStyle = 'rgba(210,153,34,0.4)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + ROW_H);
        ctx.stroke();
      }

      // ── M/m/F 마커 오버레이
      if (strike === kl.M) {
        _drawMarker(ctx, 'M', x, y + 2, CELL_W, ROW_H - 4,
          `rgba(${C_CALL.r},${C_CALL.g},${C_CALL.b},1)`,
          '#fff');
      }
      if (strike === kl.m) {
        _drawMarker(ctx, 'm', x, y + 2, CELL_W, ROW_H - 4,
          `rgba(${C_PUT.r},${C_PUT.g},${C_PUT.b},1)`,
          '#fff');
      }
      if (strike === kl.F) {
        _drawMarker(ctx, 'F', x, y + 2, CELL_W, ROW_H - 4,
          'rgba(210,153,34,1)',
          'rgba(210,153,34,1)');
      }
      if (strike === kl.G) {
        _drawMarker(ctx, 'G', x, y + 2, CELL_W, ROW_H - 4,
          'rgba(139,92,246,1)',
          'rgba(139,92,246,1)');
      }
    });
  });

  // ── 구분선
  const sumY = HEADER_H + enabledExpiries.length * ROW_H + 4;
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth   = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(0, sumY - 4);
  ctx.lineTo(W, sumY - 4);
  ctx.stroke();

  // ── 합산 행
  // 합산 행의 키레벨은 weighted 기반
  const weightedAsRaw = weighted.map(s => ({ strike: s.strike, dex: s.netDex }));
  const sumKl = _extractKeyLevels(weightedAsRaw, spot);

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

    // 현재가 점선
    if (i === spotCol) {
      ctx.strokeStyle = C_SPOT;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(x, sumY);
      ctx.lineTo(x, sumY + SUM_H);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 합산 행 마커
    if (strike === sumKl.M) {
      _drawMarker(ctx, 'M', x, sumY + 2, CELL_W, SUM_H - 4,
        `rgba(${C_CALL.r},${C_CALL.g},${C_CALL.b},1)`, '#fff');
    }
    if (strike === sumKl.m) {
      _drawMarker(ctx, 'm', x, sumY + 2, CELL_W, SUM_H - 4,
        `rgba(${C_PUT.r},${C_PUT.g},${C_PUT.b},1)`, '#fff');
    }
    if (strike === sumKl.F) {
      _drawMarker(ctx, 'F', x, sumY + 2, CELL_W, SUM_H - 4,
        'rgba(210,153,34,1)', 'rgba(210,153,34,1)');
    }
    if (strike === sumKl.G) {
      _drawMarker(ctx, 'G', x, sumY + 2, CELL_W, SUM_H - 4,
        'rgba(139,92,246,1)', 'rgba(139,92,246,1)');
    }
  });

  // ── 범례
  const legY = sumY + SUM_H + 6;
  const items = [
    { label: 'M = Call DEX 최대',  color: `rgb(${C_CALL.r},${C_CALL.g},${C_CALL.b})` },
    { label: 'm = Put DEX 최대',   color: `rgb(${C_PUT.r},${C_PUT.g},${C_PUT.b})` },
    { label: 'F = DEX Flip',       color: 'rgb(210,153,34)' },
    { label: 'G = GEX Flip (표준)', color: 'rgb(139,92,246)' },
  ];
  let legX = LABEL_W;
  ctx.font      = '9px monospace';
  ctx.textAlign = 'left';
  items.forEach(({ label, color }) => {
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([]);
    ctx.strokeRect(legX, legY + 2, 10, 10);
    ctx.fillStyle = color;
    ctx.fillText(label, legX + 14, legY + 11);
    legX += label.length * 6 + 28;
  });

  // ── 현재가 마커 삼각형
  if (spot) {
    const spotIdx = spotCol;
    if (spotIdx >= 0) {
      const mx = LABEL_W + spotIdx * CELL_W + CELL_W / 2;
      ctx.fillStyle = C_SPOT;
      ctx.beginPath();
      ctx.moveTo(mx,     sumY - 2);
      ctx.lineTo(mx - 5, sumY - 9);
      ctx.lineTo(mx + 5, sumY - 9);
      ctx.closePath();
      ctx.fill();
      ctx.font      = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`$${spot.toFixed(0)}`, mx, sumY - 11);
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
function _renderExpiryBars(expirations) {
  const container = _el('mk-expiry-bars');
  if (!container) return;

  const items = Object.entries(_expiryConfig)
    .filter(([, cfg]) => cfg.enabled)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([expiry, cfg]) => {
      const strikes = expirations[expiry] ?? [];
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
function _renderKeyLevelTable(weighted, expirations) {
  const tbody = _el('mk-keylevel-tbody');
  if (!tbody) return;

  const spot     = _spot;
  const todayStr = _fmtDate(new Date());
  const dte0Raw  = expirations[todayStr] ?? [];
  const dte0     = dte0Raw.map(s => ({
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
        if (!v0 || !vAll) return '—';
        const d = vAll - v0;
        if (d > 2)  return `선택만기 ${d.toFixed(0)}pt 위 → 숨겨진 상승 압력`;
        if (d < -2) return `선택만기 ${Math.abs(d).toFixed(0)}pt 아래 → 저항 더 가까움`;
        return '0DTE·선택만기 일치 → 신뢰도 높은 저항';
      }},
    { name: 'Put Wall', v0: lv0.putWall, vAll: lvAll.putWall,
      interp: (v0, vAll) => {
        if (!v0 || !vAll) return '—';
        const d = vAll - v0;
        if (d < -2) return `선택만기 ${Math.abs(d).toFixed(0)}pt 아래 → 더 강한 지지`;
        if (d > 2)  return `선택만기 ${d.toFixed(0)}pt 위 → 지지 약화 가능`;
        return '0DTE·선택만기 일치 → 신뢰도 높은 지지';
      }},
    { name: 'Flip Zone', v0: lv0.flip, vAll: lvAll.flip,
      interp: (v0, vAll) => {
        if (!v0 || !vAll) return '—';
        const d = vAll - v0;
        if (Math.abs(d) <= 1) return '0DTE·선택만기 Flip 일치 → 핵심 레벨';
        if (d > 0) return `선택만기 Flip ${d.toFixed(0)}pt 위 → 딜러 중립선 상방`;
        return `선택만기 Flip ${Math.abs(d).toFixed(0)}pt 아래 → 딜러 중립선 하방`;
      }},
  ];

  tbody.innerHTML = rows.map(r => {
    const v0Str   = r.v0   ? `$${r.v0}`   : '—';
    const vAllStr = r.vAll ? `$${r.vAll}` : '—';
    const diff    = (r.v0 && r.vAll) ? r.vAll - r.v0 : null;
    const diffStr = diff !== null
      ? `<span style="color:${diff > 0 ? 'var(--green)' : diff < 0 ? 'var(--red)' : 'var(--text3)'}">
           ${diff > 0 ? '+' : ''}${diff.toFixed(0)}pt</span>`
      : '—';
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
function _renderRawTable(expirations) {
  const tbody = _el('mk-raw-tbody');
  if (!tbody) return;

  const today = new Date();
  const rows  = [];

  Object.entries(expirations)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([expiry, strikes]) => {
      const dte = _calcDTE(expiry, today);
      if (dte > 60) return;
      const cfg = _expiryConfig[expiry];
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
  if (v == null || isNaN(v)) return '—';
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
    const el = _el(id); if (el) el.textContent = '—';
  });
  const bars = _el('mk-expiry-bars');
  if (bars) bars.innerHTML = `<div class="empty" style="color:var(--red)">오류: ${msg}</div>`;
}
