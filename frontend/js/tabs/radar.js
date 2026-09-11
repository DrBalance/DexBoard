// ============================================
// radar.js — Radar 탭
// VIX 압축 국면에서 풋 스큐 크고 Vanna 연료 많은 종목을 타이밍 순으로 나열
// ============================================
import { CF_API } from '../config.js';
import {
  tickerMetrics, classify, sortCandidates, sortByOpinion, opinion,
  opexCalendar, reasonString, strikeSupport,
} from '../radar-engine.js';

// ── 내부 상태 ────────────────────────────────────────────────────
let _data     = null;
let _metrics  = null;
let _calendar = null;
let _detail   = null;
let _loading  = false;
let _sort     = 'opinion'; // 'opinion' | 'skew'

// ── 초기화 ───────────────────────────────────────────────────────
export function initRadar() {
  _renderSkeleton();
  _load();
}

export function refreshRadar() {
  if (_loading) return;
  _load();
}

// ── 데이터 로드 ──────────────────────────────────────────────────
async function _load() {
  _loading = true;
  _setStatus('loading', '데이터 로딩 중…');
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    _calendar = opexCalendar(today);

    const res = await fetch(`${CF_API}/api/v2/chains?days=2`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _data = await res.json();

    _metrics = {};
    for (const t of (_data.tickers ?? [])) {
      const m = tickerMetrics(t, _calendar);
      if (m) _metrics[t.symbol] = m;
    }

    _render();
  } catch (err) {
    _setStatus('error', `로드 실패: ${err.message}`);
  } finally {
    _loading = false;
  }
}

// ── 메인 렌더 ────────────────────────────────────────────────────
function _render() {
  const panel = document.getElementById('tab-radar');
  if (!panel) return;

  // KV snapshot의 vix는 {price, changePct, ...} 객체
  const vixRaw = _data?.vix;
  const vix  = (vixRaw != null && typeof vixRaw === 'object') ? vixRaw.price : vixRaw;
  const opex = _calendar?.opex ?? '—';
  const win  = _calendar?.window ?? '—';
  const dts  = _calendar?.daysToSupport;

  const myList       = [];
  const candidates   = [];
  const excCallSkew  = [];
  const excNoFuel    = [];
  const excExhausted = [];

  for (const m of Object.values(_metrics)) {
    const t      = (_data?.tickers ?? []).find(x => x.symbol === m.symbol);
    const groups = (t?.groups ?? '').split(',').filter(Boolean);
    const isMY   = groups.includes('MY');
    const cls    = classify(m, null);

    m._groups = groups;
    m._isMY   = isMY;
    m._cls    = cls;
    m._op     = opinion(m, cls);

    if (isMY) {
      myList.push(m);
    } else if (!cls.exclude) {
      candidates.push(m);
    } else if (cls.exclude === 'call_skew') {
      excCallSkew.push(m);
    } else if (cls.exclude === 'no_fuel') {
      excNoFuel.push(m);
    } else {
      excExhausted.push(m);
    }
  }

  const sortFn = _sort === 'opinion'
    ? list => sortByOpinion(list, m => m._op.grade)
    : sortCandidates;
  const mySorted   = sortFn(myList);
  const candSorted = sortFn(candidates);

  // VIX 5일 방향: vix_hist 첫 값 대비 마지막 값
  const vh = _data?.vix_hist ?? [];
  let vixDirHtml = '';
  if (vh.length >= 2) {
    const first = vh[0].vix, last = vh[vh.length - 1].vix;
    const chg = (last - first) / first * 100;
    const cls = chg > 0 ? 'down' : 'up'; // VIX 상승은 모델에 불리 → 빨강
    vixDirHtml = ` <span class="${cls}">${chg > 0 ? '▲' : '▼'}${Math.abs(chg).toFixed(1)}% (${vh.length - 1}일)</span>`;
  }

  const gradeCount = g => candSorted.filter(m => m._op.grade === g).length;

  panel.innerHTML = `
    <div class="radar-wrap">
      <div class="radar-header">
        <span class="radar-title">Radar</span>
        <span class="radar-meta">
          다음 OPEX: <b>${opex}</b>
          &nbsp;|&nbsp; 현재 창: <b>${win === 'B' ? '지지창 B' : '약세·재구축 A'}</b>
          ${dts != null ? `&nbsp;|&nbsp; 지지창 <b>D-${dts}</b>` : ''}
          ${vix != null ? `&nbsp;|&nbsp; VIX: <b>${(+vix).toFixed(2)}</b>${vixDirHtml}` : ''}
        </span>
        <span class="radar-sort">
          정렬:
          <button class="radar-sort-btn${_sort === 'opinion' ? ' active' : ''}" data-sort="opinion">의견순</button>
          <button class="radar-sort-btn${_sort === 'skew' ? ' active' : ''}" data-sort="skew">스큐순</button>
        </span>
        <button class="radar-refresh-btn" id="radar-refresh">↻ 새로고침</button>
      </div>

      ${mySorted.length ? `
        <div class="radar-section-title">MY 종목 (${mySorted.length})</div>
        ${_renderTable(mySorted)}
      ` : ''}

      <div class="radar-section-title">
        후보 (${candSorted.length})
        <span class="radar-grade-count">A ${gradeCount('A')} · B ${gradeCount('B')} · C ${gradeCount('C')}</span>
      </div>
      ${candSorted.length
        ? _renderTable(candSorted)
        : '<div class="radar-empty">조건을 충족하는 종목 없음</div>'
      }

      <details class="radar-excluded">
        <summary>제외 종목 (${excExhausted.length + excNoFuel.length + excCallSkew.length})</summary>
        ${excExhausted.length  ? `<div class="radar-exc-group"><b>소진</b><br>${_renderExcludedList(excExhausted)}</div>` : ''}
        ${excNoFuel.length     ? `<div class="radar-exc-group"><b>연료 없음</b><br>${_renderExcludedList(excNoFuel)}</div>` : ''}
        ${excCallSkew.length   ? `<div class="radar-exc-group"><b>압축 시 매도 구조</b><br>${_renderExcludedList(excCallSkew)}</div>` : ''}
      </details>

      <div class="radar-detail" id="radar-detail" hidden></div>
    </div>
  `;

  document.getElementById('radar-refresh')?.addEventListener('click', () => {
    if (!_loading) _load();
  });

  panel.querySelectorAll('.radar-sort-btn[data-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (_sort === btn.dataset.sort) return;
      _sort = btn.dataset.sort;
      _detail = null;
      _render();
    });
  });

  panel.querySelectorAll('.radar-row[data-sym]').forEach(row => {
    row.addEventListener('click', () => _openDetail(row.dataset.sym));
  });
}

// ── 목록 테이블 ──────────────────────────────────────────────────
function _renderTable(list) {
  const rows = list.map(m => {
    const skew     = m.keyExpiry?.skewRel;
    const skewTxt  = skew != null ? `${(skew * 100).toFixed(1)}%` : '—';
    const skewCls  = skew > 0 ? 'up' : skew < 0 ? 'down' : '';
    const dKey     = m.daysToKey != null ? `D-${m.daysToKey}` : '—';
    const winKey   = m.keyExpiry ? _calendar.windowOf(m.keyExpiry.expiry_date) : '—';
    const skewA    = m.skewA != null ? `${(m.skewA * 100).toFixed(1)}%` : '—';
    const skewB    = m.skewB != null ? `${(m.skewB * 100).toFixed(1)}%` : '—';
    const align    = m.alignCount ?? 0;
    const alignBadge = align >= 5 ? ' <span class="radar-badge radar-badge--struct">구조</span>' : '';
    const vanna    = m.vannaTotal != null ? `${m.vannaTotal.toFixed(1)}M` : '—';
    const conc     = m.concRatio  != null ? `${m.concRatio.toFixed(1)}x` : '—';
    const cwall    = m.callWall   != null ? `$${m.callWall}` : '—';
    const bbPos    = m.bb?.bb_position != null ? `${(m.bb.bb_position * 100).toFixed(0)}%` : '—';
    const spot     = m.spot_price != null ? `$${m.spot_price.toFixed(2)}` : '—';
    const myBadge  = m._isMY ? '<span class="radar-badge radar-badge--my">MY</span> ' : '';
    const warnBadges = (m._cls?.badges ?? []).map(b =>
      `<span class="radar-badge radar-badge--warn">${b}</span>`).join(' ');

    return `
      <tr class="radar-row" data-sym="${m.symbol}">
        <td>${myBadge}${m.symbol}${warnBadges}${alignBadge}</td>
        <td>${_renderOpinion(m)}</td>
        <td>${spot}</td>
        <td>${dKey} <span class="radar-win">${winKey}</span></td>
        <td class="${skewCls}">${skewTxt}</td>
        <td>${skewA} / ${skewB}</td>
        <td>${align}</td>
        <td>${vanna}</td>
        <td>${conc}</td>
        <td>${cwall}</td>
        <td>${bbPos}</td>
        <td class="radar-reason">${reasonString(m)}</td>
      </tr>`;
  }).join('');

  return `
    <div class="radar-table-wrap">
      <table class="data-table radar-table">
        <thead><tr>
          <th>종목</th><th>의견</th><th>현재가</th><th>핵심만기</th>
          <th>skewRel</th><th>skewA/B</th><th>정렬수</th>
          <th>Vanna</th><th>집중도</th><th>콜월</th><th>BB</th><th>이유</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── 의견 셀: 등급 배지 + 4기둥 점 (스큐·연료·위치·타이밍) ──────────
const GRADE_LABEL = { A: '매수 우선', B: '관심', C: '보류', X: '제외' };
const EXCLUDE_LABEL = { call_skew: '콜 스큐', no_fuel: '연료 없음', exhausted: '소진' };
const LEVEL_DOT = { 3: '●', 2: '◐', 1: '○' };

function _renderOpinion(m) {
  const op = m._op;
  if (!op) return '—';
  const p = op.pillars;
  const k = m.keyExpiry;

  const dot = (name, lv) =>
    `<span class="radar-pillar radar-pillar--${lv ?? 0}" title="${name}">${LEVEL_DOT[lv] ?? '?'}</span>`;

  const tip = [
    `등급 ${op.grade} ${GRADE_LABEL[op.grade]}${op.exclude ? ` (${EXCLUDE_LABEL[op.exclude] ?? op.exclude})` : ''}`,
    `스큐: ${k?.skewRel != null ? (k.skewRel * 100).toFixed(1) + '%' : '—'}`,
    `연료: Vanna${(k?.vannaSupport ?? 0) > 0 ? '+' : '−'} Charm${(k?.charmSupport ?? 0) > 0 ? '+' : '−'}`,
    `위치: %B ${m.bb?.bb_position != null ? (m.bb.bb_position * 100).toFixed(0) : '—'}`
      + `${m.wallDistAtr != null ? ` · 콜월까지 ${m.wallDistAtr.toFixed(1)}ATR` : ''}`,
    `타이밍: ${m.daysToKey != null ? `D-${m.daysToKey} 창${k?.window ?? '—'}` : '—'}`,
  ].join('\n');

  return `<span class="radar-opinion" title="${tip}">
    <span class="radar-badge radar-badge--${op.grade.toLowerCase()}">${op.grade}</span>
    ${dot('스큐', p.skew)}${dot('연료', p.fuel)}${dot('위치', p.position)}${dot('타이밍', p.timing)}
  </span>`;
}

function _renderExcludedList(list) {
  return list.map(m =>
    `<span class="radar-exc-sym" data-sym="${m.symbol}">${m.symbol}</span>`
  ).join(' ');
}

// ── 상세 패널 ────────────────────────────────────────────────────
function _openDetail(symbol) {
  const m = _metrics[symbol];
  if (!m) return;

  if (_detail === symbol) { _closeDetail(); return; }
  _detail = symbol;

  document.querySelectorAll('.radar-row.selected').forEach(r => r.classList.remove('selected'));
  document.querySelector(`.radar-row[data-sym="${symbol}"]`)?.classList.add('selected');

  const detail = document.getElementById('radar-detail');
  if (!detail) return;
  detail.hidden = false;

  const spot = m.spot_price;

  // 1. 가격 사다리
  const ladderItems = [
    { label: 'OI 하단 경계', val: m.oiLowerEdge,  dir: 'down' },
    { label: 'BB 20일선',    val: m.bb?.bb_mid,    dir: ''     },
    { label: 'spot',         val: spot,            dir: 'spot' },
    { label: 'vannaReach',   val: m.vannaReach,   dir: 'up'   },
    { label: 'callWall',     val: m.callWall,     dir: 'up'   },
    { label: 'BB 2σ 상단',   val: m.bb?.bb_upper2, dir: ''   },
    { label: 'OI 상단 경계', val: m.oiUpperEdge,  dir: ''     },
  ]
    .filter(x => x.val != null)
    .sort((a, b) => a.val - b.val);

  const ladderHtml = ladderItems.map(x => `
    <div class="radar-ladder-row${x.dir === 'spot' ? ' radar-ladder--spot' : ''}">
      <span class="radar-ladder-label">${x.label}</span>
      <span class="radar-ladder-val ${x.dir}">$${x.val}</span>
    </div>`).join('');

  // 2. 만기 표
  const expiryRows = m.expiries.map(e => {
    const skewTxt = e.skewRel != null ? `${(e.skewRel * 100).toFixed(1)}%` : '—';
    return `<tr>
      <td>${e.expiry_date}</td>
      <td>${e.dte}</td>
      <td>${e.window ?? '—'}</td>
      <td class="${(e.skewRel ?? 0) > 0 ? 'up' : ''}">${skewTxt}</td>
      <td>${e.vannaSupport?.toFixed(2) ?? '—'}</td>
      <td>${e.charmSupport?.toFixed(2) ?? '—'}</td>
      <td>${(e.putOIBelow ?? 0).toLocaleString()}</td>
      <td>${(e.callOIAbove ?? 0).toLocaleString()}</td>
      <td>${e.peakCallStrike ?? '—'}</td>
      <td>${(e.totalOI ?? 0).toLocaleString()}</td>
    </tr>`;
  }).join('');

  // 3. 맵
  const canvasId = `radar-map-${symbol}`;

  detail.innerHTML = `
    <div class="radar-detail-header">
      <span class="radar-detail-title">${symbol} 상세</span>
      <button class="radar-close-btn" id="radar-close">✕ 닫기</button>
    </div>
    <div class="radar-detail-body">
      <div class="radar-detail-col">
        <div class="radar-section-label">가격 사다리</div>
        <div class="radar-ladder">${ladderHtml}</div>
      </div>
      <div class="radar-detail-col radar-detail-col--wide">
        <div class="radar-section-label">만기별 지표</div>
        <div class="radar-table-wrap">
          <table class="data-table radar-table" style="font-size:12px">
            <thead><tr>
              <th>만기</th><th>DTE</th><th>창</th><th>skewRel</th>
              <th>Vanna $M</th><th>Charm</th><th>풋OI↓</th><th>콜OI↑</th>
              <th>콜정점</th><th>총OI</th>
            </tr></thead>
            <tbody>${expiryRows}</tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="radar-detail-map">
      <div class="radar-section-label">DEX 맵 (만기 × 스트라이크, Vanna 레이어)</div>
      <div style="overflow-x:auto">
        <canvas id="${canvasId}" height="200"></canvas>
      </div>
    </div>
  `;

  document.getElementById('radar-close')?.addEventListener('click', _closeDetail);
  _drawMap(canvasId, m, spot);
}

function _closeDetail() {
  _detail = null;
  document.querySelectorAll('.radar-row.selected').forEach(r => r.classList.remove('selected'));
  const d = document.getElementById('radar-detail');
  if (d) { d.hidden = true; d.innerHTML = ''; }
}

// ── DEX 맵 ────────────────────────────────────────────────────────
function _drawMap(canvasId, m, spot) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const w8 = m.expiries.filter(e => e.dte <= 56);
  if (!w8.length) return;

  const strikeSet = new Set();
  for (const e of w8) for (const s of (e.strikes ?? [])) strikeSet.add(s.strike);
  const strikes = [...strikeSet].sort((a, b) => a - b);

  const cols  = strikes.length;
  const rows  = w8.length + 1; // 합산 행 포함
  const cellW = Math.max(32, Math.min(60, Math.floor(900 / cols)));
  const cellH = 26;
  const labelW = 90;

  canvas.width  = labelW + cols * cellW;
  canvas.height = cellH * (rows + 1);

  const ctx = canvas.getContext('2d');

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
    || (!document.documentElement.getAttribute('data-theme')
        && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const bg    = isDark ? '#161b22' : '#f6f8fa';
  const fg    = isDark ? '#c9d1d9' : '#24292f';
  const grid  = isDark ? '#30363d' : '#d0d7de';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '10px monospace';

  // 스트라이크 헤더 + spot 마커
  for (let ci = 0; ci < cols; ci++) {
    const x = labelW + ci * cellW;
    const isSpot = Math.abs(strikes[ci] - spot) < 0.5;
    if (isSpot) {
      ctx.fillStyle = 'rgba(88,166,255,0.15)';
      ctx.fillRect(x, 0, cellW, canvas.height);
    }
    ctx.fillStyle = isSpot ? '#58a6ff' : fg;
    ctx.fillText(String(strikes[ci]), x + 2, cellH * 0.75);
  }

  // 만기별 행
  const sumDex = new Array(cols).fill(0);

  for (let ri = 0; ri < w8.length; ri++) {
    const e = w8[ri];
    const y = cellH * (ri + 1);

    ctx.strokeStyle = grid;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    ctx.fillStyle = fg;
    ctx.fillText(`${e.expiry_date.slice(5)} D${e.dte}`, 2, y + cellH * 0.75);

    for (let ci = 0; ci < cols; ci++) {
      const s = (e.strikes ?? []).find(x => x.strike === strikes[ci]);
      if (!s) continue;
      const sup = strikeSupport(spot, s, e.dte);
      sumDex[ci] += sup.callDex;

      const alpha = Math.min(Math.abs(sup.vannaSupport) * 2, 0.85);
      ctx.fillStyle = sup.vannaSupport > 0
        ? `rgba(63,185,80,${alpha})`
        : `rgba(248,81,73,${alpha})`;
      ctx.fillRect(labelW + ci * cellW + 1, y + 1, cellW - 2, cellH - 2);
    }
  }

  // 합산 행
  const sumY   = cellH * (w8.length + 1);
  const maxSum = Math.max(...sumDex.map(Math.abs), 0.001);

  ctx.strokeStyle = grid;
  ctx.beginPath(); ctx.moveTo(0, sumY); ctx.lineTo(canvas.width, sumY); ctx.stroke();
  ctx.fillStyle = fg;
  ctx.fillText('합산', 2, sumY + cellH * 0.75);

  for (let ci = 0; ci < cols; ci++) {
    const v = sumDex[ci];
    const alpha = Math.min(Math.abs(v) / maxSum * 0.9, 0.9);
    ctx.fillStyle = v > 0 ? `rgba(63,185,80,${alpha})` : `rgba(248,81,73,${alpha})`;
    ctx.fillRect(labelW + ci * cellW + 1, sumY + 1, cellW - 2, cellH - 2);

    if (strikes[ci] === m.callWall) {
      ctx.fillStyle = '#f0883e';
      ctx.fillText('▲', labelW + ci * cellW + cellW / 2 - 4, sumY + cellH * 0.75);
    }
  }
}

// ── 유틸 ─────────────────────────────────────────────────────────
function _setStatus(type, msg) {
  const panel = document.getElementById('tab-radar');
  if (panel) panel.innerHTML = `<div class="radar-wrap"><div class="radar-status radar-status--${type}">${msg}</div></div>`;
}

function _renderSkeleton() {
  const panel = document.getElementById('tab-radar');
  if (panel) panel.innerHTML = `<div class="radar-wrap"><div class="radar-status">Radar 초기화 중…</div></div>`;
}
