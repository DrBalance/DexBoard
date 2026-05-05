/**
 * oi-chart.js — OI 바 차트 + Strike 테이블 독립 모듈
 *
 * 공개 API:
 *   renderOIChart(containerId, strikes, spotPrice, opts?) → Chart 인스턴스
 *   updateOIChart(inst, strikes, spotPrice, opts?)        → void
 *   renderStrikeTable(tbodyId, strikes, opts?)            → void
 *   renderTop5Panel(panelId, strikes, opts?)              → void
 *
 * renderTop5Panel opts:
 *   mode: 'oi15m' (기본, Live 탭) | 'oiOpen' (누적, Live 탭) | 'none' (날짜조회 탭)
 *   type: 'call' | 'put' | 'both' (기본)
 *
 * Live 탭 strikes 구조 (dex:spy:0dte):
 *   { strike, expiry, callOI, putOI,
 *     callOi15m, putOi15m,     ← 15분 OI 증감 (계약수)
 *     callOiOpen, putOiOpen,   ← 장 시작 대비 누적 OI 증감 (계약수)
 *     dex, gex, vanna, charm }
 *
 * 날짜조회 탭 strikes 구조 (dex:spy expirations):
 *   { strike, expiry, callOI, putOI, dex, gex, vanna, charm }
 *   → OI 증감 필드 없음, renderTop5Panel({ mode: 'none' }) 으로 호출
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

  let canvas = container.querySelector('canvas.oi-chart-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'oi-chart-canvas';
    canvas.style.cssText = 'display:block;width:100%;height:340px;';
    container.appendChild(canvas);
  }

  const chartData = _buildChartData(strikes, spotPrice);
  const inst = new Chart(canvas, _buildConfig(chartData, spotPrice, opts, container));
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
   Strike별 Call/Put OI 분리, DEX 합산
   Live 탭: openOI 없음 (callOiOpen/putOiOpen 직접 strikes에 내장)
   날짜조회 탭: isRegular=false, OI증감 컬럼 없음
──────────────────────────────────────────────────────── */
export function renderStrikeTable(tbodyId, strikes, opts = {}) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  const {
    mode       = '0dte',
    showDelta  = false,
    showDTE    = false,
    spotPrice  = null,
    flipZone   = null,
    putWall    = null,
    callWall   = null,
    isRegular  = false,
  } = opts;

  // Live 탭(정규장): strikes에 callOiOpen/putOiOpen 내장 → 직접 사용
  const showDeltaOpen = isRegular;

  /* thead 갱신 */
  const theadId = tbodyId.replace('tbody', 'thead');
  const thead   = document.getElementById(theadId);
  if (thead) {
    const dteCols      = showDTE   ? '<th>DTE</th>' : '';
    const deltaCols    = showDelta ? '<th>Call Δ</th><th>Put Δ</th>' : '';
    const deltaOpenCols = showDeltaOpen
      ? '<th title="장 시작 대비 Call OI 누적 증감">ΔCall</th><th title="장 시작 대비 Put OI 누적 증감">ΔPut</th>'
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
      ${deltaOpenCols}
      ${deltaCols}
    </tr>`;
  }

  if (!strikes || strikes.length === 0) {
    const colCount = 6 + (showDTE ? 1 : 0) + (showDelta ? 2 : 0) + (showDeltaOpen ? 2 : 0);
    tbody.innerHTML = `<tr><td colspan="${colCount}"><div class="empty">데이터 없음</div></td></tr>`;
    return;
  }

  /* Strike별로 Call/Put 합산 */
  const strikeMap = _aggregateByStrike(strikes);
  const sorted    = Object.values(strikeMap).sort((a, b) => a.strike - b.strike);

  tbody.innerHTML = sorted.map(row => {
    const dexCls = row.dex >= 0 ? 'up' : 'down';
    const dteTd  = showDTE ? `<td>${row.dte ?? '—'}</td>` : '';
    const strike = Number(row.strike);
    const isCur  = spotPrice != null && Math.abs(strike - spotPrice) < 0.5;
    const isFlip = flipZone  != null && strike === Number(flipZone);
    const isPW   = putWall   != null && strike === Number(putWall);
    const isCW   = callWall  != null && strike === Number(callWall);
    const tags   = [
      isCur  ? `<span style="font-size:10px;padding:1px 5px;border-radius:3px;margin-left:4px;background:rgba(88,166,255,.2);color:#58a6ff">현재가</span>` : '',
      isFlip ? `<span style="font-size:10px;padding:1px 5px;border-radius:3px;margin-left:4px;background:rgba(245,158,11,.2);color:#f59e0b">Flip</span>` : '',
      isPW   ? `<span style="font-size:10px;padding:1px 5px;border-radius:3px;margin-left:4px;background:rgba(239,68,68,.2);color:#ef4444">Put Wall</span>` : '',
      isCW   ? `<span style="font-size:10px;padding:1px 5px;border-radius:3px;margin-left:4px;background:rgba(34,197,94,.2);color:#22c55e">Call Wall</span>` : '',
    ].join('');
    const rowBg  = isCur ? 'background:rgba(88,166,255,.07)' : isFlip ? 'background:rgba(245,158,11,.05)' : '';
    const deltaTd = showDelta ? `
      <td class="${row.callDelta >= 0 ? 'up' : 'down'}">${fmt.delta(row.callDelta)}</td>
      <td class="${row.putDelta  >= 0 ? 'up' : 'down'}">${fmt.delta(row.putDelta)}</td>
      ` : '';

    /* ΔOpen: strikes에 직접 내장된 callOiOpen/putOiOpen 사용 */
    let deltaOpenTd = '';
    if (showDeltaOpen) {
      const dc = row.callOiOpen ?? null;
      const dp = row.putOiOpen  ?? null;
      if (dc != null || dp != null) {
        const fmtDelta = v => {
          if (v == null) return '—';
          const sign = v > 0 ? '+' : '';
          return `${sign}${fmt.oi(v)}`;
        };
        deltaOpenTd = `
          <td class="${(dc ?? 0) >= 0 ? 'up' : 'down'}" style="font-size:11px">${fmtDelta(dc)}</td>
          <td class="${(dp ?? 0) >= 0 ? 'up' : 'down'}" style="font-size:11px">${fmtDelta(dp)}</td>`;
      } else {
        deltaOpenTd = `<td style="color:var(--text3)">—</td><td style="color:var(--text3)">—</td>`;
      }
    }

    return `<tr style="${rowBg}">
      <td>$${row.strike}${tags}</td>
      ${dteTd}
      <td style="color:var(--green)">${fmt.oi(row.callOI)}</td>
      <td style="color:var(--red)">${fmt.oi(row.putOI)}</td>
      <td class="${dexCls}">${fmt.dex(row.dex)}</td>
      <td>${fmt.greek(row.gex)}</td>
      <td style="color:var(--purple)">${fmt.greek(row.vanna)}</td>
      <td style="color:var(--teal)">${fmt.greek(row.charm)}</td>
      ${deltaOpenTd}
      ${deltaTd}
    </tr>`;
  }).join('');
}

/* ────────────────────────────────────────────────────────
   renderTop5Panel — 급등 OI 패널

   opts:
     mode: 'oi15m'  → 15분 증감 기준 (기본, Live 탭)
           'oiOpen' → 누적 증감 기준 (Live 탭)
           'none'   → OI 증감 없음 (날짜조회 탭) → 패널 숨김
     type: 'call' | 'put' | 'both' (기본)
──────────────────────────────────────────────────────── */
export function renderTop5Panel(panelId, strikes, opts = {}) {
  const panel = document.getElementById(panelId);
  if (!panel) return;

  const { mode = 'oi15m', type = 'both' } = opts;

  // 날짜조회 탭: OI 증감 없음 → 패널 숨김
  if (mode === 'none') {
    panel.innerHTML = '';
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';

  // strike별로 call/put 증감을 하나의 카드로 펼치기
  // type=both 이면 call과 put을 각각 별도 항목으로 취급
  const items = [];

  for (const s of strikes) {
    if (type === 'call' || type === 'both') {
      const callVal = mode === 'oi15m' ? (s.callOi15m ?? null) : (s.callOiOpen ?? null);
      if (callVal != null && callVal !== 0) {
        items.push({ strike: s.strike, expiry: s.expiry, side: 'Call', val: callVal });
      }
    }
    if (type === 'put' || type === 'both') {
      const putVal = mode === 'oi15m' ? (s.putOi15m ?? null) : (s.putOiOpen ?? null);
      if (putVal != null && putVal !== 0) {
        items.push({ strike: s.strike, expiry: s.expiry, side: 'Put', val: putVal });
      }
    }
  }

  // 절댓값 내림차순 정렬 → 상위 5개
  const sorted = items
    .sort((a, b) => Math.abs(b.val) - Math.abs(a.val))
    .slice(0, 5);

  if (sorted.length === 0) {
    panel.innerHTML = '<div class="empty">OI 증감 데이터 준비 중</div>';
    return;
  }

  const modeLabel = mode === 'oi15m' ? 'Δ15m' : 'Δ누적';

  panel.innerHTML = sorted.map(item => {
    const cls     = item.val > 0 ? 'up' : 'down';
    const sign    = item.val > 0 ? '+' : '';
    const sideCls = item.side === 'Call' ? 'var(--green)' : 'var(--red)';
    return `
      <div class="spike-card">
        <div class="spike-strike">
          $${item.strike}
          <span style="font-size:10px;color:${sideCls};margin-left:4px">${item.side}</span>
        </div>
        <div class="spike-delta ${cls}">${sign}${fmt.oi(item.val)}</div>
        <div class="spike-label">${modeLabel} OI</div>
      </div>`;
  }).join('');
}

/* ════════════════════════════════════════════════════════
   내부 헬퍼
════════════════════════════════════════════════════════ */

/* Strike별 Call/Put 집계 — oiOpen 필드도 합산 */
function _aggregateByStrike(strikes) {
  const map = {};
  for (const s of strikes) {
    const k = s.strike;
    if (!map[k]) {
      map[k] = {
        strike:    k,
        dte:       s.dte ?? null,
        callOI:    0, putOI:    0,
        callOi15m: 0, putOi15m: 0,
        callOiOpen: 0, putOiOpen: 0,
        dex: 0, gex: 0, vanna: 0, charm: 0,
        callDelta: 0, putDelta: 0,
      };
    }

    map[k].callOI     += s.callOI     ?? 0;
    map[k].putOI      += s.putOI      ?? 0;
    map[k].callOi15m  += s.callOi15m  ?? 0;
    map[k].putOi15m   += s.putOi15m   ?? 0;
    map[k].callOiOpen += s.callOiOpen ?? 0;
    map[k].putOiOpen  += s.putOiOpen  ?? 0;
    map[k].dex        += s.dex        ?? 0;
    map[k].gex        += s.gex        ?? 0;
    map[k].vanna      += s.vanna      ?? 0;
    map[k].charm      += s.charm      ?? 0;
    map[k].callDelta  += s.callDelta  ?? 0;
    map[k].putDelta   += s.putDelta   ?? 0;
  }
  return map;
}

function _buildChartData(strikes, spotPrice) {
  /* Strike별로 집계 후 정렬 */
  const strikeMap = _aggregateByStrike(strikes);
  const sorted    = Object.values(strikeMap).sort((a, b) => a.strike - b.strike);

  return {
    labels: sorted.map(s => `$${s.strike}`),
    callOI: sorted.map(s =>  s.callOI),
    putOI:  sorted.map(s => -s.putOI),   // 음수: 아래로 뻗는 막대
    gex:    sorted.map(s =>  s.gex),
    raw:    sorted,
  };
}

function _buildConfig(chartData, spotPrice, opts, container) {
  return {
    data: {
      labels:   chartData.labels,
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
            label: item => {
              const abs = Math.abs(item.raw);
              if (item.dataset.label === 'Call OI') return ` Call OI: ${abs.toLocaleString()}`;
              if (item.dataset.label === 'Put OI')  return ` Put OI: ${abs.toLocaleString()}`;
              return ` ${item.dataset.label}: ${item.formattedValue}`;
            },
            afterBody: items => {
              const s = chartData.raw[items[0].dataIndex];
              if (!s) return [];
              const lines = [];
              if (s.dte != null) lines.push(`DTE: ${s.dte}`);
              // OI 증감 정보 (Live 탭에서만 존재)
              if (s.callOi15m != null) lines.push(`Call Δ15m: ${s.callOi15m > 0 ? '+' : ''}${s.callOi15m.toLocaleString()}`);
              if (s.putOi15m  != null) lines.push(`Put Δ15m: ${s.putOi15m  > 0 ? '+' : ''}${s.putOi15m.toLocaleString()}`);
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
      _stickyYPlugin(container),
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

function _stickyYPlugin(container) {
  return {
    id: 'stickyY',
    afterDraw(chart) {
      const wrap = container?.parentElement;
      if (!wrap) return;
      const scrollX = wrap.scrollLeft;
      const wrapW   = wrap.clientWidth;
      const yScale  = chart.scales['y'];
      const y2Scale = chart.scales['y2'];
      const { ctx, chartArea, height, width } = chart;

      ctx.save();

      if (scrollX > 0 && yScale) {
        const axisW = yScale.right;
        ctx.fillStyle = '#181c24';
        ctx.fillRect(scrollX, 0, axisW, height);
        ctx.textAlign    = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle    = '#9ca3af';
        ctx.font         = '10px monospace';
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

      if (y2Scale) {
        const rAxisW  = width - y2Scale.left;
        const fixedRX = scrollX + wrapW - rAxisW;
        ctx.fillStyle = '#181c24';
        ctx.fillRect(fixedRX, 0, rAxisW, height);
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle    = '#f0883e';
        ctx.font         = '10px monospace';
        y2Scale.ticks.forEach((tick, i) => {
          const y = y2Scale.getPixelForTick(i);
          ctx.fillText(_fmtAxisM(tick.value), fixedRX + 4, y);
        });
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(fixedRX, chartArea.top);
        ctx.lineTo(fixedRX, chartArea.bottom);
        ctx.stroke();
      }

      ctx.restore();
    },
  };
}

function _attachScrollHandler(container, inst) {
  if (!container) return;
  const scrollEl = container.parentElement ?? container;
  scrollEl._scrollHandler && scrollEl.removeEventListener('scroll', scrollEl._scrollHandler);
  scrollEl._scrollHandler = () => inst?.draw?.();
  scrollEl.addEventListener('scroll', scrollEl._scrollHandler, { passive: true });
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
