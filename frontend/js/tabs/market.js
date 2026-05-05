/**
 * market.js — Market 탭 (지수 방향성 판단)
 *
 * 데이터 소스: GET /api/dex/spy  (dex:spy KV — 전 만기 expirations)
 *              GET /api/snapshot  (SPY 현재가 / VIX)
 *
 * 핵심 로직:
 *  1. expirations 객체를 만기별로 분류 (0dte / weekly / monthly / quarterly)
 *  2. 스트라이크별 가중합산 DEX 계산
 *  3. Call Wall / Put Wall / Flip Zone 추출 (0DTE vs 전만기 비교)
 *  4. 만기별 DEX 분포 바 렌더링
 *  5. 전만기 합산 차트 렌더링 (Chart.js)
 *
 * 가중치 (만기까지 남은 거래일 기준):
 *  0DTE    → 1.0  (오늘 100% 작동)
 *  weekly  → 0.7  (이번주~7일)
 *  monthly → 0.5  (8~35일)
 *  quarterly→ 0.3  (36일+)
 */

import { bindToggle } from '../tabs.js';
import { CF_API } from '../config.js';

// ── 설정 ──────────────────────────────────────────────────
const WORKER_URL = CF_API;

const WEIGHTS = {
  '0dte':      1.0,
  'weekly':    0.7,
  'monthly':   0.5,
  'quarterly': 0.3,
};

const EXPIRY_LABELS = {
  '0dte':      '0DTE',
  'weekly':    'Weekly (1~7d)',
  'monthly':   'Monthly (8~35d)',
  'quarterly': 'Quarterly (36d+)',
};

const EXPIRY_COLORS = {
  '0dte':      'rgba(88,166,255,0.85)',
  'weekly':    'rgba(63,185,80,0.75)',
  'monthly':   'rgba(210,153,34,0.65)',
  'quarterly': 'rgba(188,100,220,0.55)',
};

// ── 상태 ──────────────────────────────────────────────────
let _chart       = null;
let _rawData     = null;   // 원본 expirations
let _symbol      = 'SPY';
let _weightMode  = 'weighted';
let _expiryFilter = 'all';
let _pollTimer   = null;

// ── 공개 API ──────────────────────────────────────────────
export function initMarket() {
  bindToggle('market-symbol-toggle', (sym) => {
    _symbol = sym;
    document.getElementById('mk-chart-title').textContent = sym;
    _load();
  });

  bindToggle('market-weight-toggle', (mode) => {
    _weightMode = mode;
    if (_rawData) _render(_rawData);
  });

  bindToggle('mk-expiry-filter', (f) => {
    _expiryFilter = f;
    if (_rawData) _renderStrikeTable(_rawData, _buildWeighted(_rawData));
  });

  // 줌 슬라이더
  const slider = document.getElementById('mk-zoom-slider');
  const zoomVal = document.getElementById('mk-zoom-val');
  slider?.addEventListener('input', () => {
    const z = parseFloat(slider.value);
    zoomVal.textContent = `${z}×`;
    _resizeChart(z);
  });

  _load();

  // 5분마다 자동 갱신 (Market 탭은 실시간 불필요)
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

    const dexData  = dexRes.ok  ? await dexRes.json()  : null;
    const snapData = snapRes.ok ? await snapRes.json()  : null;

    console.log('[Market] snapData:', snapData)

    // 스냅샷 메트릭 업데이트
   
    if (!dexData?.expirations) {
      _showError('데이터 없음 — /api/dex/' + sym);
      return;
    }

    _rawData = dexData;

    // 타임스탬프
    if (dexData.updated_at) {
      const t = new Date(dexData.updated_at);
      _el('market-ts').textContent = t.toLocaleTimeString('ko-KR', { timeZone: 'America/New_York' }) + ' ET';
    }

    const spyPrice = parseFloat(snapData?.spy ?? snapData?.price ?? 0);
    const vixPrice = parseFloat(snapData?.vix ?? 0);
    _el('mk-spy').textContent = spyPrice ? `$${spyPrice.toFixed(2)}` : '—';
    _el('mk-vix').textContent = vixPrice ? vixPrice.toFixed(2) : '—';

    _render(dexData, spyPrice);

  } catch (err) {
    console.error('[Market] 로딩 실패:', err);
    _showError(err.message);
  }
}

// ── 렌더링 마스터 ─────────────────────────────────────────
function _render(data, spot = 0) {
  const weighted = _buildWeighted(data);
  const byExpiry = _buildByExpiry(data);
  if (!spot) spot = parseFloat(_el('mk-spy').textContent.replace('$', '')) || 0;
  // const spot     = parseFloat(_el('mk-spy').textContent.replace('$', '')) || 0;

  _renderMetrics(weighted, spot);
  _renderExpiryBars(byExpiry);
  _renderChart(weighted, byExpiry, spot);
  _renderKeyLevelTable(weighted, data, spot);
  _renderStrikeTable(data, weighted);
}

// ── 핵심 계산: 가중합산 ───────────────────────────────────
function _buildWeighted(data) {
  const today     = new Date();
  const strikeMap = {};  // strike → { callDex, putDex, netDex, gex, vanna, charm, expiries[] }

  for (const [expiry, strikes] of Object.entries(data.expirations)) {
    const dte      = _calcDTE(expiry, today);
    const category = _categorize(dte);
    const weight   = _weightMode === 'weighted' ? WEIGHTS[category] : 1.0;

    for (const s of strikes) {
      if (!strikeMap[s.strike]) {
        strikeMap[s.strike] = {
          strike:   s.strike,
          callDex:  0,
          putDex:   0,
          netDex:   0,
          gex:      0,
          vanna:    0,
          charm:    0,
          expiries: [],
        };
      }
      const entry = strikeMap[s.strike];

      // dex가 양수면 Call DEX, 음수면 Put DEX로 분리
      const callDex = s.dex > 0 ? s.dex * weight : 0;
      const putDex  = s.dex < 0 ? s.dex * weight : 0;

      entry.callDex += callDex;
      entry.putDex  += putDex;
      entry.netDex  += s.dex   * weight;
      entry.gex     += s.gex   * weight;
      entry.vanna   += s.vanna * weight;
      entry.charm   += s.charm * weight;
      entry.expiries.push({ expiry, category, dte, weight });
    }
  }

  return Object.values(strikeMap).sort((a, b) => a.strike - b.strike);
}

// ── 만기별 합산 ───────────────────────────────────────────
function _buildByExpiry(data) {
  const today  = new Date();
  const result = { '0dte': 0, 'weekly': 0, 'monthly': 0, 'quarterly': 0 };

  for (const [expiry, strikes] of Object.entries(data.expirations)) {
    const dte      = _calcDTE(expiry, today);
    const category = _categorize(dte);
    const sum      = strikes.reduce((acc, s) => acc + s.dex, 0);
    result[category] += sum;
  }

  return result;
}

// ── 메트릭 카드 ───────────────────────────────────────────
function _renderMetrics(weighted, spot) {
  const totalDex = weighted.reduce((a, s) => a + s.netDex, 0);
  _el('mk-dex').textContent = _fmtM(totalDex);
  _el('mk-dex').className   = 'metric-value ' + (totalDex >= 0 ? 'up' : 'down');

  // Call Wall: 현재가 위에서 callDex가 가장 큰 스트라이크
  const above = weighted.filter(s => s.strike > spot);
  const below = weighted.filter(s => s.strike <= spot);

  const callWall = above.length
    ? above.reduce((a, b) => a.callDex > b.callDex ? a : b)
    : null;
  const putWall  = below.length
    ? below.reduce((a, b) => Math.abs(a.putDex) > Math.abs(b.putDex) ? a : b)
    : null;

  // Flip Zone: netDex 부호 전환점 (현재가 근처)
  const near = weighted.filter(s => Math.abs(s.strike - spot) <= 20);
  let flipZone = null;
  for (let i = 0; i < near.length - 1; i++) {
    if (near[i].netDex >= 0 && near[i + 1].netDex < 0) {
      flipZone = near[i].strike;
      break;
    }
    if (near[i].netDex < 0 && near[i + 1].netDex >= 0) {
      flipZone = near[i + 1].strike;
      break;
    }
  }

  _el('mk-call-wall').textContent = callWall ? `$${callWall.strike}` : '—';
  _el('mk-put-wall').textContent  = putWall  ? `$${putWall.strike}`  : '—';
  _el('mk-flip').textContent      = flipZone  ? `$${flipZone}`        : '—';
}

// ── 만기별 DEX 분포 바 ────────────────────────────────────
function _renderExpiryBars(byExpiry) {
  const container = _el('mk-expiry-bars');
  if (!container) return;

  const total = Object.values(byExpiry).reduce((a, b) => a + Math.abs(b), 0) || 1;

  container.innerHTML = Object.entries(byExpiry).map(([cat, dex]) => {
    const pct   = Math.abs(dex) / total * 100;
    const color = dex >= 0 ? 'var(--green)' : 'var(--red)';
    const sign  = dex >= 0 ? '+' : '';
    return `
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:11px;color:var(--text3);width:130px;flex-shrink:0">
          ${EXPIRY_LABELS[cat]}
        </span>
        <div style="flex:1;background:var(--bg3);border-radius:4px;height:18px;overflow:hidden">
          <div style="
            width:${pct.toFixed(1)}%;
            height:100%;
            background:${color};
            border-radius:4px;
            transition:width 0.4s ease;
          "></div>
        </div>
        <span style="
          font-family:var(--mono);
          font-size:12px;
          color:${color};
          width:72px;
          text-align:right;
          flex-shrink:0;
        ">${sign}${_fmtM(dex)}</span>
        <span style="
          font-size:10px;
          color:var(--text3);
          width:36px;
          text-align:right;
          flex-shrink:0;
        ">${pct.toFixed(0)}%</span>
      </div>
    `;
  }).join('');
}

// ── 메인 차트 (Chart.js 수평 바) ──────────────────────────
function _renderChart(weighted, byExpiry, spot) {
  const wrap   = _el('mk-chart-wrap');
  const scroll = _el('mk-chart-scroll');
  if (!wrap) return;

  // 현재가 ±30 범위 기본 표시
    let visible = weighted.filter(s =>
  s.strike >= spot - 30 && s.strike <= spot + 30
  );
  if (!visible.length) {
    const mid = Math.floor(weighted.length / 2);
    visible = weighted.slice(Math.max(0, mid - 50), mid + 50);
  }
  if (!visible.length) return;

  const labels   = visible.map(s => `$${s.strike}`);
  const callData = visible.map(s => s.callDex);
  const putData  = visible.map(s => s.putDex);

  const zoom      = parseFloat(_el('mk-zoom-slider')?.value ?? 1);
  const barWidth  = Math.max(12, 20 * zoom);
  const chartW    = Math.max(labels.length * barWidth * 2 + 80, 600);

  wrap.style.width = `${chartW}px`;

  // 기존 캔버스 제거
  wrap.innerHTML = '';
  const canvas   = document.createElement('canvas');
  canvas.style.width  = '100%';
  canvas.style.height = '340px';
  wrap.appendChild(canvas);

  if (_chart) { _chart.destroy(); _chart = null; }

  const ctx = canvas.getContext('2d');
  _chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label:           'Call DEX',
          data:            callData,
          backgroundColor: 'rgba(63,185,80,0.75)',
          borderColor:     'rgba(63,185,80,0.9)',
          borderWidth:     1,
        },
        {
          label:           'Put DEX',
          data:            putData,
          backgroundColor: 'rgba(248,81,73,0.75)',
          borderColor:     'rgba(248,81,73,0.9)',
          borderWidth:     1,
        },
      ],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           { duration: 300 },
      scales: {
        x: {
          stacked: true,
          ticks:   { color: '#8b949e', font: { size: 10 } },
          grid:    { color: 'rgba(255,255,255,0.05)' },
        },
        y: {
          stacked: true,
          ticks: {
            color: '#8b949e',
            font:  { size: 10 },
            callback: v => _fmtM(v),
          },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
      },
      plugins: {
        legend: {
          labels: { color: '#c9d1d9', font: { size: 11 } },
        },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${_fmtM(ctx.raw)}`,
          },
        },
        // 현재가 수직선
        annotation: undefined,
      },
    },
    plugins: [_spotLinePlugin(spot, labels)],
  });
}

// 현재가 수직선 플러그인
function _spotLinePlugin(spot, labels) {
  const spotLabel = `$${spot}`;
  return {
    id: 'mk-spot-line',
    afterDraw(chart) {
      const idx = labels.findIndex(l => {
        const s = parseFloat(l.replace('$', ''));
        return s >= spot;
      });
      if (idx < 0) return;

      const { ctx, chartArea: { top, bottom }, scales: { x } } = chart;
      const xPos = x.getPixelForValue(idx - 0.5);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(xPos, top);
      ctx.lineTo(xPos, bottom);
      ctx.strokeStyle = 'rgba(210,153,34,0.8)';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.stroke();

      ctx.fillStyle  = 'rgba(210,153,34,0.9)';
      ctx.font       = '10px monospace';
      ctx.textAlign  = 'center';
      ctx.fillText(`SPY ${spotLabel}`, xPos, top - 4);
      ctx.restore();
    },
  };
}

function _resizeChart(zoom) {
  const spot    = parseFloat(_el('mk-spy').textContent.replace('$', '')) || 0;
  if (!_rawData || !spot) return;

  const weighted = _buildWeighted(_rawData);
  const visible  = weighted.filter(s =>
    s.strike >= spot - 30 && s.strike <= spot + 30
  );

  const barWidth = Math.max(12, 20 * zoom);
  const chartW   = Math.max(visible.length * barWidth * 2 + 80, 600);
  const wrap     = _el('mk-chart-wrap');
  if (wrap) wrap.style.width = `${chartW}px`;
}

// ── 키레벨 비교 테이블 ────────────────────────────────────
function _renderKeyLevelTable(weighted, data, spot) {
  const tbody = _el('mk-keylevel-tbody');
  if (!tbody) return;

  // 0DTE 키레벨 추출
  const today       = new Date();
  const todayStr    = _fmtDate(today);
  const dte0Strikes = data.expirations[todayStr] ?? [];

  const _extractLevels = (strikes) => {
    const above = strikes.filter(s => s.strike > spot);
    const below = strikes.filter(s => s.strike <= spot);

    const getNetDex = s => 'netDex' in s ? s.netDex : s.dex;

    const callWall = above.length
      ? above.reduce((a, b) => (a.callDex ?? a.dex) > (b.callDex ?? b.dex) ? a : b)
      : null;
    const putWall = below.length
      ? below.reduce((a, b) =>
          Math.abs(a.putDex ?? a.dex) > Math.abs(b.putDex ?? b.dex) ? a : b)
      : null;

    // Flip Zone
    const near = strikes.filter(s => Math.abs(s.strike - spot) <= 20);
    let flip = null;
    for (let i = 0; i < near.length - 1; i++) {
      const a = getNetDex(near[i]);
      const b = getNetDex(near[i + 1]);
      if ((a >= 0 && b < 0) || (a < 0 && b >= 0)) {
        flip = a >= 0 ? near[i].strike : near[i + 1].strike;
        break;
      }
    }
    return { callWall: callWall?.strike, putWall: putWall?.strike, flip };
  };

  const lv0    = _extractLevels(dte0Strikes);
  const lvAll  = _extractLevels(weighted);

  const rows = [
    {
      name: 'Call Wall',
      v0:   lv0.callWall,
      vAll: lvAll.callWall,
      interp: (v0, vAll) => {
        if (!v0 || !vAll) return '—';
        const diff = vAll - v0;
        if (diff > 2)  return `전만기 ${diff.toFixed(0)}pt 위 → 숨겨진 상승 압력`;
        if (diff < -2) return `전만기 ${Math.abs(diff).toFixed(0)}pt 아래 → 저항 더 가까움`;
        return '0DTE·전만기 일치 → 신뢰도 높은 저항';
      },
    },
    {
      name: 'Put Wall',
      v0:   lv0.putWall,
      vAll: lvAll.putWall,
      interp: (v0, vAll) => {
        if (!v0 || !vAll) return '—';
        const diff = vAll - v0;
        if (diff < -2) return `전만기 ${Math.abs(diff).toFixed(0)}pt 아래 → 더 강한 지지`;
        if (diff > 2)  return `전만기 ${diff.toFixed(0)}pt 위 → 지지 약화 가능`;
        return '0DTE·전만기 일치 → 신뢰도 높은 지지';
      },
    },
    {
      name: 'Flip Zone',
      v0:   lv0.flip,
      vAll: lvAll.flip,
      interp: (v0, vAll) => {
        if (!v0 || !vAll) return '—';
        const diff = vAll - v0;
        if (Math.abs(diff) <= 1) return '0DTE·전만기 Flip 일치 → 핵심 레벨';
        if (vAll > v0) return `전만기 Flip ${diff.toFixed(0)}pt 위 → 딜러 중립선 상방`;
        return `전만기 Flip ${Math.abs(diff).toFixed(0)}pt 아래 → 딜러 중립선 하방`;
      },
    },
  ];

  tbody.innerHTML = rows.map(r => {
    const v0Str  = r.v0   ? `$${r.v0}`   : '—';
    const vAllStr = r.vAll ? `$${r.vAll}` : '—';
    const diff    = (r.v0 && r.vAll) ? r.vAll - r.v0 : null;
    const diffStr = diff !== null
      ? `<span style="color:${diff > 0 ? 'var(--green)' : diff < 0 ? 'var(--red)' : 'var(--text3)'}">
           ${diff > 0 ? '+' : ''}${diff.toFixed(0)}pt
         </span>`
      : '—';

    return `<tr>
      <td style="font-weight:500">${r.name}</td>
      <td style="color:var(--green);font-family:var(--mono)">${v0Str}</td>
      <td style="color:var(--blue);font-family:var(--mono)">${vAllStr}</td>
      <td style="font-family:var(--mono)">${diffStr}</td>
      <td style="font-size:11px;color:var(--text3)">${r.interp(r.v0, r.vAll)}</td>
    </tr>`;
  }).join('');
}

// ── Strike 상세 테이블 ────────────────────────────────────
function _renderStrikeTable(data, weighted) {
  const tbody = _el('mk-strike-tbody');
  if (!tbody) return;

  const today = new Date();
  let strikes;

  if (_expiryFilter === 'all') {
    strikes = weighted;
  } else {
    // 특정 만기 카테고리만 필터링 후 재합산
    const filtered = {};
    for (const [expiry, exStrikes] of Object.entries(data.expirations)) {
      const dte      = _calcDTE(expiry, today);
      const category = _categorize(dte);
      if (category !== _expiryFilter) continue;

      for (const s of exStrikes) {
        if (!filtered[s.strike]) {
          filtered[s.strike] = { strike: s.strike, callDex: 0, putDex: 0, netDex: 0, gex: 0, vanna: 0, charm: 0 };
        }
        const e = filtered[s.strike];
        e.callDex += s.dex > 0 ? s.dex : 0;
        e.putDex  += s.dex < 0 ? s.dex : 0;
        e.netDex  += s.dex;
        e.gex     += s.gex;
        e.vanna   += s.vanna;
        e.charm   += s.charm;
      }
    }
    strikes = Object.values(filtered).sort((a, b) => a.strike - b.strike);
  }

  if (!strikes.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty">데이터 없음</div></td></tr>';
    return;
  }

  const maxAbsDex = Math.max(...strikes.map(s => Math.abs(s.netDex)), 1);

  tbody.innerHTML = strikes.map(s => {
    const pct  = Math.abs(s.netDex) / maxAbsDex;
    const bg   = s.netDex >= 0
      ? `rgba(63,185,80,${(pct * 0.3).toFixed(2)})`
      : `rgba(248,81,73,${(pct * 0.3).toFixed(2)})`;

    return `<tr style="background:${bg}">
      <td style="font-family:var(--mono);font-weight:500">$${s.strike}</td>
      <td style="color:var(--green);font-family:var(--mono)">${_fmtM(s.callDex)}</td>
      <td style="color:var(--red);font-family:var(--mono)">${_fmtM(s.putDex)}</td>
      <td style="font-family:var(--mono);color:${s.netDex >= 0 ? 'var(--green)' : 'var(--red)'}">
        ${s.netDex >= 0 ? '+' : ''}${_fmtM(s.netDex)}
      </td>
      <td style="font-family:var(--mono)">${_fmtM(s.gex)}</td>
      <td style="font-family:var(--mono);color:var(--purple)">${_fmtM(s.vanna)}</td>
      <td style="font-family:var(--mono);color:var(--teal)">${_fmtM(s.charm)}</td>
    </tr>`;
  }).join('');
}

// ── 유틸 ──────────────────────────────────────────────────
function _el(id) {
  return document.getElementById(id);
}

function _fmtM(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}B`;
  if (abs >= 1)    return `${sign}${abs.toFixed(1)}M`;
  return `${sign}${(abs * 1000).toFixed(0)}K`;
}

function _calcDTE(expiry, today) {
  const exp = new Date(`${expiry}T16:00:00-05:00`);
  return Math.max(0, Math.round((exp - today) / 86_400_000));
}

function _categorize(dte) {
  if (dte <= 1)  return '0dte';
  if (dte <= 7)  return 'weekly';
  if (dte <= 35) return 'monthly';
  return 'quarterly';
}

function _fmtDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function _showError(msg) {
  ['mk-dex', 'mk-call-wall', 'mk-put-wall', 'mk-flip'].forEach(id => {
    const el = _el(id);
    if (el) el.textContent = '—';
  });
  const bars = _el('mk-expiry-bars');
  if (bars) bars.innerHTML = `<div class="empty" style="color:var(--red)">오류: ${msg}</div>`;
}
