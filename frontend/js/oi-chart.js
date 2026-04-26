/**
 * oi-chart.js — OI 바 차트 + Strike 테이블 독립 모듈
 *
 * 공개 API:
 *   renderOIChart(containerId, strikes, spotPrice, opts?) → Chart 인스턴스
 *   updateOIChart(inst, strikes, spotPrice, opts?)        → void  (재방문·토글 시)
 *   renderStrikeTable(tbodyId, strikes, opts?)            → void
 *
 * opts 구조:
 *   mode       : '0dte' | 'term'   (기본 '0dte')
 *   showDelta  : boolean            (기본 false, 0dte + KV 준비 후 true)
 *   prevStrikes: Strike[] | null    (Δ15m 계산용)
 *   openStrikes: Strike[] | null    (Δopen 계산용)
 *   showDTE    : boolean            (term 모드에서 만기일 컬럼 표시)
 *
 * Strike 객체 구조 (Railway → CF KV 에서 읽어온 값):
 *   { strike, expiry, type, oi, dex, gex, vanna, charm, gamma, iv, dte }
 */

import { fmt } from './fmt.js';

/* ── Chart.js CDN 버전 확인 ──────────────────────
   Vite 환경: npm install chart.js 후 import 가능
   CDN 환경: window.Chart 사용
──────────────────────────────────────────────── */
const _Chart = () => window.Chart ?? (typeof Chart !== 'undefined' ? Chart : null);

/* ── 색상 상수 (base.css 변수와 동기화) ─────────── */
const C = {
  callBar  : 'rgba(34,197,94,0.35)',    /* --green */
  callBord : 'rgba(34,197,94,0.7)',
  putBar   : 'rgba(239,68,68,0.35)',    /* --red */
  putBord  : 'rgba(239,68,68,0.7)',
  gexLine  : '#f59e0b',                 /* --amber */
  spotLine : '#60a5fa',                 /* --blue */
  gridLine : 'rgba(255,255,255,0.05)',
  zeroLine : 'rgba(255,255,255,0.18)',
  tickColor: '#4b5563',                 /* --text3 */
  tooltipBg: '#111318',                 /* --bg1 */
};

/* ────────────────────────────────────────────────
   renderOIChart
   ─ containerId : chart-scroll-wrap 의 부모 div id
   ─ strikes     : Strike[]
   ─ spotPrice   : number
   ─ opts        : OIChartOpts
   ─ returns     : Chart 인스턴스 (state에 저장용)
──────────────────────────────────────────────── */
export function renderOIChart(containerId, strikes, spotPrice, opts = {}) {
  const container = document.getElementById(containerId);
  if (!container) { console.warn('[oi-chart] container 없음:', containerId); return null; }

  /* canvas 생성 또는 재사용 */
  let canvas = container.querySelector('canvas.oi-chart-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'oi-chart-canvas';
    canvas.style.cssText = 'display:block;width:100%;height:220px;';
    container.appendChild(canvas);
  }

  const ChartJS = _Chart();
  if (!ChartJS) { console.error('[oi-chart] Chart.js 없음'); return null; }

  const chartData = _buildChartData(strikes, spotPrice);
  const inst = new ChartJS(canvas, _buildConfig(chartData, spotPrice, opts));

  /* 스크롤 y축 고정: containerId 자체가 scroll-wrap인 경우를 지원 */
  _attachScrollHandler(container, inst);

  return inst;
}

/* ────────────────────────────────────────────────
   updateOIChart
   ─ 탭 재방문 / 만기 토글 시 destroy 없이 데이터 교체
──────────────────────────────────────────────── */
export function updateOIChart(inst, strikes, spotPrice, opts = {}) {
  if (!inst) return;
  const chartData = _buildChartData(strikes, spotPrice);

  inst.data.labels       = chartData.labels;
  inst.data.datasets[0].data = chartData.callOI;   /* Call OI */
  inst.data.datasets[1].data = chartData.putOI;    /* Put OI (음수) */
  inst.data.datasets[2].data = chartData.gex;      /* GEX 라인 */

  /* 현재가 플러그인에 새 spot 전달 */
  inst._spotPrice = spotPrice;
  inst._strikes   = chartData.raw;

  inst.update('none');  /* 애니메이션 없이 즉시 반영 */
}

/* ────────────────────────────────────────────────
   renderStrikeTable
   ─ tbodyId   : <tbody> 요소 id
   ─ strikes   : Strike[]
   ─ opts      : { mode, showDelta, prevStrikes, openStrikes, showDTE }
──────────────────────────────────────────────── */
export function renderStrikeTable(tbodyId, strikes, opts = {}) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  const {
    mode        = '0dte',
    showDelta   = false,
    prevStrikes = null,
    openStrikes = null,
    showDTE     = false,
  } = opts;

  /* 컬럼 정의 — mode에 따라 분기 */
  const cols = _buildColDefs(mode, showDelta, showDTE);

  /* thead 갱신 (thead id 규칙: tbodyId에서 'tbody' → 'thead') */
  const theadId = tbodyId.replace('tbody', 'thead');
  const thead   = document.getElementById(theadId);
  if (thead) {
    thead.innerHTML = `<tr>${cols.map(c => `<th>${c.label}</th>`).join('')}</tr>`;
  }

  /* 델타 맵 계산 */
  const deltaMap = showDelta
    ? _calcDeltaMap(strikes, prevStrikes, openStrikes)
    : null;

  /* 행 렌더링 */
  if (!strikes || strikes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${cols.length}"><div class="empty">데이터 없음</div></td></tr>`;
    return;
  }

  tbody.innerHTML = strikes.map(s => {
    const d = deltaMap?.[`${s.strike}-${s.type}`];
    return `<tr>
      ${cols.map(c => _renderCell(c, s, d)).join('')}
    </tr>`;
  }).join('');
}

/* ────────────────────────────────────────────────
   Top5 급등 패널 렌더링
   ─ panelId   : .spike-panel div id
   ─ strikes   : Strike[] (이미 계산된 delta 포함)
   ─ deltaKey  : 'delta15m' | 'deltaOpen'
──────────────────────────────────────────────── */
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
    const val   = s[deltaKey];
    const cls   = val > 0 ? 'up' : 'down';
    const sign  = val > 0 ? '+' : '';
    const label = deltaKey === 'delta15m' ? 'Δ15m' : 'Δopen';
    return `
      <div class="spike-card">
        <div class="spike-strike">$${s.strike} <span style="font-size:10px;color:var(--text3)">${s.type}</span></div>
        <div class="spike-delta ${cls}">${sign}${fmt.oi(val)}</div>
        <div class="spike-label">${label} OI</div>
      </div>`;
  }).join('');
}

/* ════════════════════════════════════════════════
   내부 헬퍼
════════════════════════════════════════════════ */

function _buildChartData(strikes, spotPrice) {
  if (!strikes || strikes.length === 0) {
    return { labels: [], callOI: [], putOI: [], gex: [], raw: [] };
  }

  /* strike 오름차순 정렬 */
  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);

  /* 현재가 ±8% 범위로 필터 (너무 멀면 차트가 스케일 잡기 어려움) */
  const filtered = spotPrice > 0
    ? sorted.filter(s => Math.abs(s.strike - spotPrice) / spotPrice < 0.08)
    : sorted;

  return {
    labels : filtered.map(s => s.strike % 5 === 0 ? `$${s.strike}` : ''),
    callOI : filtered.map(s => s.type === 'call' ?  (s.oi ?? 0) : 0),
    putOI  : filtered.map(s => s.type === 'put'  ? -(s.oi ?? 0) : 0),
    gex    : filtered.map(s => +((s.gex ?? 0) / 1e6).toFixed(3)),
    raw    : filtered,
  };
}

function _buildConfig(chartData, spotPrice, opts) {
  return {
    data: {
      labels: chartData.labels,
      datasets: [
        {
          type: 'bar',
          label: 'Call OI',
          data: chartData.callOI,
          backgroundColor: C.callBar,
          borderColor: C.callBord,
          borderWidth: 1,
          yAxisID: 'y',
        },
        {
          type: 'bar',
          label: 'Put OI',
          data: chartData.putOI,
          backgroundColor: C.putBar,
          borderColor: C.putBord,
          borderWidth: 1,
          yAxisID: 'y',
        },
        {
          type: 'line',
          label: 'GEX (M)',
          data: chartData.gex,
          borderColor: C.gexLine,
          backgroundColor: 'transparent',
          borderWidth: 2,
          tension: 0.3,
          pointRadius: 2,
          pointBackgroundColor: C.gexLine,
          pointHoverRadius: 6,
          pointHoverBackgroundColor: '#ef4444',
          pointHoverBorderColor: '#fff',
          pointHoverBorderWidth: 1.5,
          yAxisID: 'y2',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onHover: (e, els, chart) => {
        chart._hoveredIdx = els.length ? els[0].index : null;
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'start',
          labels: { color: C.tickColor, font: { size: 11 }, boxWidth: 10, padding: 14 },
        },
        tooltip: {
          backgroundColor: C.tooltipBg,
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          titleColor: '#e8eaf0',
          bodyColor: '#9ca3af',
          padding: 10,
          callbacks: {
            title: items => {
              const s = chartData.raw[items[0].dataIndex];
              return s ? `$${s.strike}` : '';
            },
            afterBody: items => {
              const s = chartData.raw[items[0].dataIndex];
              if (!s) return [];
              const lines = [];
              if (s.iv  > 0) lines.push(`IV: ${(s.iv * 100).toFixed(1)}%`);
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
          ticks: {
            color: C.tickColor,
            font: { size: 10 },
            callback: v => _fmtAxis(v),
          },
          grid: { color: C.gridLine },
          afterDataLimits: scale => _padScale(scale, 0.12),
        },
        y2: {
          position: 'right',
          ticks: {
            color: C.gexLine,
            font: { size: 10 },
            callback: v => _fmtAxisM(v),
          },
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
      _stickyYPlugin(),
    ],
  };
}

/* 현재가 세로 점선 플러그인 */
function _spotLinePlugin(rawStrikes, initSpot) {
  return {
    id: 'spotLine',
    afterDraw(chart) {
      const spot = chart._spotPrice ?? initSpot;
      const strikes = chart._strikes ?? rawStrikes;
      const idx = strikes.findIndex(s => Math.abs(s.strike - spot) < 1.0);
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

/* 호버 시 GEX 라인 강조 점 */
function _hoverDotPlugin() {
  return {
    id: 'hoverDot',
    afterDraw(chart) {
      const idx = chart._hoveredIdx;
      if (idx == null) return;
      const meta = chart.getDatasetMeta(2);  /* GEX 라인 */
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

/* 스크롤 시 y축 고정 플러그인 */
function _stickyYPlugin() {
  return {
    id: 'stickyY',
    afterDraw(chart) {
      const wrap = chart.canvas?.parentElement;
      if (!wrap) return;
      const scrollX = wrap.scrollLeft;
      if (scrollX === 0) return;

      const { ctx, chartArea, height, width } = chart;
      const yScale  = chart.scales['y'];
      const y2Scale = chart.scales['y2'];

      ctx.save();

      /* 왼쪽 y축 */
      if (yScale) {
        const axisW = yScale.right;
        ctx.fillStyle = '#111318';
        ctx.fillRect(scrollX, 0, axisW, height);
        ctx.fillStyle = C.tickColor;
        ctx.font      = '10px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        yScale.ticks.forEach((tick, i) => {
          const y = yScale.getPixelForTick(i);
          ctx.fillText(_fmtAxis(tick.value), scrollX + axisW - 4, y);
        });
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(scrollX + axisW, chartArea.top);
        ctx.lineTo(scrollX + axisW, chartArea.bottom);
        ctx.stroke();
      }

      /* 오른쪽 y2축 */
      if (y2Scale) {
        const rStart = y2Scale.left;
        const rW     = width - rStart;
        const fixedX = scrollX + wrap.clientWidth - rW;
        ctx.fillStyle = '#111318';
        ctx.fillRect(fixedX, 0, rW, height);
        ctx.fillStyle = C.gexLine;
        ctx.textAlign = 'left';
        y2Scale.ticks.forEach((tick, i) => {
          const y = y2Scale.getPixelForTick(i);
          ctx.fillText(_fmtAxisM(tick.value), fixedX + 4, y);
        });
      }

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

/* ── 컬럼 정의 ───────────────────────────────── */
function _buildColDefs(mode, showDelta, showDTE) {
  if (mode === '0dte') {
    const cols = [
      { key: 'strike', label: 'Strike',  align: 'left',  render: s => `$${s.strike}` },
      { key: 'type',   label: 'Type',    align: 'left',  render: s => _typeBadge(s.type) },
      { key: 'oi',     label: 'OI',      align: 'right', render: s => fmt.oi(s.oi) },
      { key: 'dex',    label: 'DEX',     align: 'right', render: s => fmt.greek(s.dex), colorFn: s => s.dex > 0 ? 'up' : 'down' },
      { key: 'gex',    label: 'GEX',     align: 'right', render: s => fmt.greek(s.gex) },
      { key: 'vanna',  label: 'Vanna',   align: 'right', render: s => fmt.greek(s.vanna), style: 'color:var(--purple)' },
      { key: 'charm',  label: 'Charm',   align: 'right', render: s => fmt.greek(s.charm), style: 'color:var(--teal)' },
    ];
    if (showDelta) {
      cols.push(
        { key: 'delta15m',  label: 'Δ15m',  align: 'right', render: (s, d) => d ? _fmtDelta(d.d15m)  : '—', colorFn: (s, d) => d?.d15m  > 0 ? 'up' : 'down' },
        { key: 'deltaOpen', label: 'Δopen', align: 'right', render: (s, d) => d ? _fmtDelta(d.dOpen) : '—', colorFn: (s, d) => d?.dOpen > 0 ? 'up' : 'down' },
      );
    }
    return cols;
  }

  /* term 모드 */
  const cols = [
    { key: 'strike', label: 'Strike', align: 'left',  render: s => `$${s.strike}` },
    { key: 'type',   label: 'Type',   align: 'left',  render: s => _typeBadge(s.type) },
    { key: 'oi',     label: 'OI',     align: 'right', render: s => fmt.oi(s.oi) },
    { key: 'dex',    label: 'DEX',    align: 'right', render: s => fmt.greek(s.dex), colorFn: s => s.dex > 0 ? 'up' : 'down' },
    { key: 'gex',    label: 'GEX',    align: 'right', render: s => fmt.greek(s.gex) },
    { key: 'vanna',  label: 'Vanna',  align: 'right', render: s => fmt.greek(s.vanna), style: 'color:var(--purple)' },
  ];
  if (showDTE) {
    cols.splice(2, 0, { key: 'dte', label: 'DTE', align: 'right', render: s => s.dte ?? '—' });
  }
  return cols;
}

function _renderCell(colDef, strike, delta) {
  const val   = colDef.render(strike, delta);
  const cls   = colDef.colorFn ? colDef.colorFn(strike, delta) : '';
  const style = colDef.style   ? ` style="${colDef.style}"` : '';
  const align = colDef.align === 'left' ? '' : ' style="text-align:right"';
  return `<td class="${cls}"${style}>${val}</td>`;
}

/* ── 델타 계산 ───────────────────────────────── */
function _calcDeltaMap(strikes, prevStrikes, openStrikes) {
  const map = {};

  const prevMap = {};
  prevStrikes?.forEach(s => { prevMap[`${s.strike}-${s.type}`] = s.oi ?? 0; });

  const openMap = {};
  openStrikes?.forEach(s => { openMap[`${s.strike}-${s.type}`] = s.oi ?? 0; });

  strikes.forEach(s => {
    const key = `${s.strike}-${s.type}`;
    map[key] = {
      d15m  : prevMap[key] != null ? (s.oi ?? 0) - prevMap[key] : null,
      dOpen : openMap[key] != null ? (s.oi ?? 0) - openMap[key] : null,
    };
  });

  return map;
}

/* ── 포맷 헬퍼 ───────────────────────────────── */
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

function _fmtDelta(v) {
  if (v == null) return '—';
  const sign = v > 0 ? '+' : '';
  return sign + _fmtAxis(v);
}

function _padScale(scale, ratio) {
  const range = scale.max - scale.min;
  const pad   = range === 0 ? Math.abs(scale.max) * 0.2 || 100 : range * ratio;
  scale.min  -= pad;
  scale.max  += pad;
}

function _typeBadge(type) {
  if (!type) return '—';
  const cls   = type === 'call' ? 'up' : 'down';
  const label = type.toUpperCase();
  return `<span class="${cls}">${label}</span>`;
}
