/**
 * oi-chart.js — OI 바 차트 + Strike 테이블 독립 모듈
 *
 * 공개 API:
 *   renderOIChart(containerId, strikes, spotPrice, opts?) → Chart 인스턴스
 *   updateOIChart(inst, strikes, spotPrice, opts?)        → void
 *   renderStrikeTable(tbodyId, strikes, opts?)            → void
 *
 * 테이블 구조 (Strike별 Call/Put OI 분리):
 *   Strike | Call OI | Put OI | DEX(합산) | GEX | Vanna | Charm
 *   Call OI → 녹색, Put OI → 빨간색
 */

import Chart from 'chart.js/auto';
import { fmt } from './fmt.js';

/* ── 색상 상수 ─────────────────────────────────────────── */
const C = {
  callBar  : 'rgba(34,197,94,0.35)',
  callBord : 'rgba(34,197,94,0.7)',
  putBar   : 'rgba(239,68,68,0.35)',
  putBord  : 'rgba(239,68,68,0.7)',
  gexLine  : '#f59e0b',
  spotLine : '#60a5fa',
  gridLine : 'rgba(255,255,255,0.05)',
  zeroLine : 'rgba(255,255,255,0.18)',
  tickColor: '#4b5563',
  tooltipBg: '#111318',
};

/* ────────────────────────────────────────────────────────
   renderOIChart
──────────────────────────────────────────────────────── */
export function renderOIChart(containerId, strikes, spotPrice, opts = {}) {
  const container = document.getElementById(containerId);
  if (!container) { console.warn('[oi-chart] container 없음:', containerId); return null; }

  /* canvas 생성 또는 재사용 */
  let canvas = container.querySelector('canvas.oi-chart-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'oi-chart-canvas';
    canvas.style.cssText = 'display:block;width:100%;height:240px;';
    container.appendChild(canvas);
  }

  const chartData = _buildChartData(strikes, spotPrice);
  const inst = new Chart(canvas, _buildConfig(chartData, spotPrice, opts));
  _attachScrollHandler(container, inst);
  return inst;
}

/* ────────────────────────────────────────────────────────
   updateOIChart — destroy 없이 데이터만 교체
──────────────────────────────────────────────────────── */
export function updateOIChart(inst, strikes, spotPrice, opts = {}) {
  if (!inst) return;
  const chartData = _buildChartData(strikes, spotPrice);

  inst.data.labels            = chartData.labels;
  inst.data.datasets[0].data  = chartData.callOI;
  inst.data.datasets[1].data  = chartData.putOI;
  inst.data.datasets[2].data  = chartData.gex;
  inst._spotPrice             = spotPrice;
  inst._strikes               = chartData.raw;

  inst.update('none');
}

/* ────────────────────────────────────────────────────────
   renderStrikeTable
   Strike별 Call OI / Put OI 분리, DEX 합산
──────────────────────────────────────────────────────── */
export function renderStrikeTable(tbodyId, strikes, opts = {}) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  const {
    mode       = '0dte',
    showDelta  = false,
    showDTE    = false,
  } = opts;

  /* thead 갱신 */
  const theadId = tbodyId.replace('tbody', 'thead');
  const thead   = document.getElementById(theadId);
  if (thead) {
    const dteCols = showDTE ? '<th>DTE</th>' : '';
    const deltaCols = showDelta
      ? '<th>Call Δ</th><th>Put Δ</th>'
      : '';
    thead.innerHTML = `<tr>
      <th>Strike</th>
      ${dteCols}
      <th>Call OI</th>
      <th>Put OI</th>
      <th>DEX</th>
      <th>GEX</th>
      <th>Vanna</th>
      <th>Charm</th>
      ${deltaCols}
    </tr>`;
  }

  if (!strikes || strikes.length === 0) {
    const colCount = 6 + (showDTE ? 1 : 0) + (showDelta ? 2 : 0);
    tbody.innerHTML = `<tr><td colspan="${colCount}"><div class="empty">데이터 없음</div></td></tr>`;
    return;
  }

  /* Strike별로 Call/Put 합산 */
  const strikeMap = _aggregateByStrike(strikes);
  const sorted    = Object.values(strikeMap).sort((a, b) => a.strike - b.strike);

  tbody.innerHTML = sorted.map(row => {
    const dexCls = row.dex >= 0 ? 'up' : 'down';
    const dteTd  = showDTE ? `<td>${row.dte ?? '—'}</td>` : '';
    const deltaTd = showDelta ? `
      <td class="${row.callDelta >= 0 ? 'up' : 'down'}">${fmt.delta(row.callDelta)}</td>
      <td class="${row.putDelta  >= 0 ? 'up' : 'down'}">${fmt.delta(row.putDelta)}</td>
    ` : '';

    return `<tr>
      <td>$${row.strike}</td>
      ${dteTd}
      <td style="color:var(--green)">${fmt.oi(row.callOI)}</td>
      <td style="color:var(--red)">${fmt.oi(row.putOI)}</td>
      <td class="${dexCls}">${fmt.greek(row.dex)}</td>
      <td>${fmt.greek(row.gex)}</td>
      <td style="color:var(--purple)">${fmt.greek(row.vanna)}</td>
      <td style="color:var(--teal)">${fmt.greek(row.charm)}</td>
      ${deltaTd}
    </tr>`;
  }).join('');
}

/* ────────────────────────────────────────────────────────
   Top5 급등 패널
──────────────────────────────────────────────────────── */
export function renderTop5Panel(panelId, strikes, deltaKey = 'delta15m') {
  const panel = document.getElementById(panelId);
  if (!panel) return;

  const sorted = [...strikes]
    .filter(s => s[deltaKey] != null)
    .sort((a, b) => Math.abs(b[deltaKey]) - Math.abs(a[deltaKey]))
    .slice(0, 5);

  if (sorted.length === 0) {
    panel.innerHTML = '<div class="empty">증감 데이터 준비 중</div>';
    return;
  }

  panel.innerHTML = sorted.map(s => {
    const val  = s[deltaKey];
    const cls  = val > 0 ? 'up' : 'down';
    const sign = val > 0 ? '+' : '';
    const label = deltaKey === 'delta15m' ? 'Δ15m' : 'Δopen';
    return `
      <div class="spike-card">
        <div class="spike-strike">$${s.strike} <span style="font-size:10px;color:var(--text3)">${s.type}</span></div>
        <div class="spike-delta ${cls}">${sign}${fmt.oi(val)}</div>
        <div class="spike-label">${label} OI</div>
      </div>`;
  }).join('');
}

/* ════════════════════════════════════════════════════════
   내부 헬퍼
════════════════════════════════════════════════════════ */

/* Strike별 Call/Put 집계 */
function _aggregateByStrike(strikes) {
  const map = {};
  for (const s of strikes) {
    const k = s.strike;
    if (!map[k]) {
      map[k] = {
        strike: k,
        dte:    s.dte ?? null,
        callOI: 0, putOI: 0,
        dex: 0, gex: 0, vanna: 0, charm: 0,
        callDelta: 0, putDelta: 0,
      };
    }
    map[k].callOI    += s.callOI   ?? 0;
    map[k].putOI     += s.putOI    ?? 0;
    map[k].dex   += s.dex   ?? 0;
    map[k].gex   += s.gex   ?? 0;
    map[k].vanna += s.vanna ?? 0;
    map[k].charm += s.charm ?? 0;
  }
    return map;
}

/* 차트용 데이터 빌드 */
function _buildChartData(strikes, spotPrice) {
  if (!strikes || strikes.length === 0) {
    return { labels: [], callOI: [], putOI: [], gex: [], raw: [] };
  }

  /* Strike별 집계 */
  const map     = _aggregateByStrike(strikes);
  const sorted  = Object.values(map).sort((a, b) => a.strike - b.strike);

  /* 현재가 ±8% 필터 */
  const filtered = spotPrice > 0
    ? sorted.filter(s => Math.abs(s.strike - spotPrice) / spotPrice < 0.08)
    : sorted;

  return {
    labels : filtered.map(s => s.strike % 5 === 0 ? `$${s.strike}` : ''),
    callOI : filtered.map(s =>  s.callOI),
    putOI  : filtered.map(s => -s.putOI),
    gex    : filtered.map(s => +((s.gex ?? 0)).toFixed(3)),
    raw    : filtered,
  };
}

function _buildConfig(chartData, spotPrice, opts) {
  return {
    data: {
      labels: chartData.labels,
      datasets: [
        {
          type: 'bar', label: 'Call OI',
          data: chartData.callOI,
          backgroundColor: C.callBar, borderColor: C.callBord, borderWidth: 1,
          yAxisID: 'y',
        },
        {
          type: 'bar', label: 'Put OI',
          data: chartData.putOI,
          backgroundColor: C.putBar, borderColor: C.putBord, borderWidth: 1,
          yAxisID: 'y',
        },
        {
          type: 'line', label: 'GEX (M)',
          data: chartData.gex,
          borderColor: C.gexLine, backgroundColor: 'transparent',
          borderWidth: 2, tension: 0.3,
          pointRadius: 2, pointBackgroundColor: C.gexLine,
          pointHoverRadius: 6, pointHoverBackgroundColor: '#ef4444',
          pointHoverBorderColor: '#fff', pointHoverBorderWidth: 1.5,
          yAxisID: 'y2',
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onHover: (e, els, chart) => { chart._hoveredIdx = els.length ? els[0].index : null; },
      plugins: {
        legend: {
          display: true, position: 'top', align: 'start',
          labels: { color: C.tickColor, font: { size: 11 }, boxWidth: 10, padding: 14 },
        },
        tooltip: {
          backgroundColor: C.tooltipBg,
          borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1,
          titleColor: '#e8eaf0', bodyColor: '#9ca3af', padding: 10,
          callbacks: {
            title: items => {
              const s = chartData.raw[items[0].dataIndex];
              return s ? `$${s.strike}` : '';
            },
            afterBody: items => {
              const s = chartData.raw[items[0].dataIndex];
              if (!s) return [];
              const lines = [];
              if (s.dte != null) lines.push(`DTE: ${s.dte}`);
              return lines;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: C.tickColor, font: { size: 10 }, autoSkip: false, maxRotation: 45 },
          grid:  { color: C.gridLine },
        },
        y: {
          position: 'left',
          ticks: { color: C.tickColor, font: { size: 10 }, callback: v => _fmtAxis(v) },
          grid:  { color: C.gridLine },
          afterDataLimits: scale => _padScale(scale, 0.12),
        },
        y2: {
          position: 'right',
          ticks: { color: C.gexLine, font: { size: 10 }, callback: v => _fmtAxisM(v) },
          grid: {
            drawOnChartArea: true,
            color: ctx => ctx.tick.value === 0 ? C.zeroLine : 'transparent',
            lineWidth: ctx => ctx.tick.value === 0 ? 1 : 0,
          },
          afterDataLimits: scale => _padScale(scale, 0.12),
        },
      },
    },
    plugins: [
      _spotLinePlugin(chartData.raw, spotPrice),
      _hoverDotPlugin(),
    ],
  };
}

function _spotLinePlugin(rawStrikes, initSpot) {
  return {
    id: 'spotLine',
    afterDraw(chart) {
      const spot    = chart._spotPrice ?? initSpot;
      const strikes = chart._strikes   ?? rawStrikes;
      const idx     = strikes.findIndex(s => Math.abs(s.strike - spot) < 1.0);
      if (idx < 0) return;

      const { ctx, chartArea } = chart;
      const x = chart.scales.x.getPixelForValue(idx);

      ctx.save();
      ctx.strokeStyle = C.spotLine;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.fillStyle    = C.spotLine;
      ctx.font         = 'bold 10px monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`$${spot.toFixed(0)}`, x, chartArea.top - 2);
      ctx.restore();
    },
  };
}

function _hoverDotPlugin() {
  return {
    id: 'hoverDot',
    afterDraw(chart) {
      const idx = chart._hoveredIdx;
      if (idx == null) return;
      const meta = chart.getDatasetMeta(2);
      if (!meta?.data[idx]) return;
      const pt  = meta.data[idx];
      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
      ctx.fillStyle   = '#ef4444';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth   = 1.5;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    },
  };
}

function _attachScrollHandler(container, inst) {
  if (!container) return;
  container._scrollHandler && container.removeEventListener('scroll', container._scrollHandler);
  container._scrollHandler = () => inst?.draw?.();
  container.addEventListener('scroll', container._scrollHandler, { passive: true });
}

function _fmtAxis(v) {
  const abs  = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000) return sign + Math.round(abs / 1_000_000) + 'M';
  if (abs >= 1_000)     return sign + Math.round(abs / 1_000) + 'K';
  return String(v);
}

function _fmtAxisM(v) {
  const abs  = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000) return sign + Math.round(abs / 1_000) + 'K';
  return v + 'M';
}

function _padScale(scale, ratio) {
  const range = scale.max - scale.min;
  const pad   = range === 0 ? Math.abs(scale.max) * 0.2 || 100 : range * ratio;
  scale.min  -= pad;
  scale.max  += pad;
}
