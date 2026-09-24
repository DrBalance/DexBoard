// ============================================
// radar.js — Radar 탭 (v0.5)
// VIX 압축 국면에서 로그 BB 하단 터치 + 200일선 위 + 풋 스큐/Vanna 연료가 있는
// 소수 정예 종목만 골라 나열한다. 상세는 페이지 이동 없이 행 아래 아코디언으로 펼친다.
// ============================================
import { CF_API, CRON_SECRET } from '../config.js';
import {
  tickerMetrics, classify, sortCandidates, sortByOpinion, opinion,
  opexCalendar, reasonString, strikeSupport, aggregateStrikes, strikesPerExpiry,
  PILLAR_THRESHOLDS, ENGINE_VER,
} from '../radar-engine.js';
import { renderVannaHeatmap } from '../heatmap.js';
import { renderVannaDistChart } from '../options-charts.js';

// ── 내부 상태 ────────────────────────────────────────────────────
let _data      = null;
let _metrics   = null;
let _calendar  = null;
let _loading   = false;
let _sort      = 'opinion'; // 'opinion' | 'skew'
let _openOrder = [];        // 아코디언 열린 종목 (최대 3, FIFO 축출)
let _openSubtab = {};        // symbol → 'structure'|'em'|'heatmap'|'expiries'
const MAX_OPEN = 3;

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
    _maybeSaveDailyPicks();
  } catch (err) {
    _setStatus('error', `로드 실패: ${err.message}`);
  } finally {
    _loading = false;
  }
}

// ── v0.5: 하루 첫 로드 때만 후보 스냅샷 저장 (검증용, RADAR_DESIGN §2-8) ──
function _maybeSaveDailyPicks() {
  const date = _data?.date;
  if (!date) return;
  const key = 'radar_picks_saved_date';
  try {
    if (localStorage.getItem(key) === date) return;
  } catch (_) { /* localStorage 불가 환경 — 저장 스킵하지 않고 매번 시도 */ }

  const seen = new Set();
  const picks = [];
  for (const list of [Object.values(_metrics)]) {
    for (const m of list) {
      if (seen.has(m.symbol)) continue;
      const op = m._op ?? opinion(m, m._cls ?? classify(m, null));
      if (!op || op.grade === 'X') continue;
      seen.add(m.symbol);
      picks.push({
        ticker: m.symbol, grade: op.grade,
        skew_rel: m.keyExpiry?.skewRel ?? null,
        bb_log_pos: m.bbLogPos ?? null,
        bb_touch_5d: !!m.bbTouch5d,
        vanna_total: m.vannaTotal ?? null,
        key_expiry: m.keyExpiry?.expiry_date ?? null,
        days_to_key: m.daysToKey ?? null,
        call_wall: m.callWall ?? null,
        spot: m.spot_price ?? null,
      });
    }
  }
  if (!picks.length) return;

  fetch(`${CF_API}/api/v2/radar-picks`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
    body:    JSON.stringify({ date, engine_ver: ENGINE_VER, picks }),
  }).then(r => {
    if (r.ok) { try { localStorage.setItem(key, date); } catch (_) {} }
  }).catch(() => { /* 실패해도 화면엔 영향 없음, 다음 새로고침에서 재시도 */ });
}

// ── 제외 사유 라벨 (v0.5: 위치·추세 게이트, v0.6: 풋 벽 게이트 추가) ──
const EXCLUDE_LABEL = {
  low_conf: '신뢰도 낮음', no_bb: 'BB 없음', position: '위치 부적합', trend: '추세 부적합',
  put_wall: '풋벽 아래', call_skew: '콜 스큐', no_fuel: '연료 없음', exhausted: '소진',
};
const EXCLUDE_GROUP_ORDER = ['position', 'trend', 'put_wall', 'call_skew', 'no_fuel', 'exhausted', 'no_bb', 'low_conf'];

// ── 메인 렌더 ────────────────────────────────────────────────────
function _render() {
  const panel = document.getElementById('tab-radar');
  if (!panel) return;

  const vixRaw = _data?.vix;
  const vix  = (vixRaw != null && typeof vixRaw === 'object') ? vixRaw.price : vixRaw;
  const opex = _calendar?.opex ?? '—';
  const win  = _calendar?.window ?? '—';
  const dts  = _calendar?.daysToSupport;

  const indexList  = [];
  const myList     = [];
  const candidates = [];
  const excGroups  = { low_conf: [], no_bb: [], position: [], trend: [], put_wall: [], call_skew: [], no_fuel: [], exhausted: [] };

  for (const m of Object.values(_metrics)) {
    const t      = (_data?.tickers ?? []).find(x => x.symbol === m.symbol);
    const groups = (t?.groups ?? '').split(',').filter(Boolean);
    const isIndex = groups.includes('INDEX');
    const isMY    = groups.includes('MY');
    const cls     = classify(m, null);

    m._groups = groups;
    m._isMY   = isMY;
    m._isIndex = isIndex;
    m._cls    = cls;
    m._op     = opinion(m, cls);

    if (isIndex) {
      indexList.push(m);
    } else if (isMY) {
      myList.push(m);
    } else if (!cls.exclude) {
      candidates.push(m);
    } else if (excGroups[cls.exclude]) {
      excGroups[cls.exclude].push(m);
    }
  }

  const sortFn = _sort === 'opinion'
    ? list => sortByOpinion(list, m => m._op.grade)
    : sortCandidates;
  const indexSorted = sortFn(indexList);
  const mySorted     = sortFn(myList);
  const candSorted   = sortFn(candidates);

  const vh = _data?.vix_hist ?? [];
  let vixDirHtml = '';
  if (vh.length >= 2) {
    const first = vh[0].vix, last = vh[vh.length - 1].vix;
    const chg = (last - first) / first * 100;
    const cls = chg > 0 ? 'down' : 'up';
    vixDirHtml = ` <span class="${cls}">${chg > 0 ? '▲' : '▼'}${Math.abs(chg).toFixed(1)}% (${vh.length - 1}일)</span>`;
  }

  const gradeCount = g => candSorted.filter(m => m._op.grade === g).length;
  const excTotal = Object.values(excGroups).reduce((s, arr) => s + arr.length, 0);

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

      ${indexSorted.length ? `
        <div class="radar-section-title">지수 (${indexSorted.length})</div>
        ${_renderTable(indexSorted)}
      ` : ''}

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
        : '<div class="radar-empty">조건을 충족하는 종목 없음 — 위치 게이트(로그 BB 하단 5일 터치 + %B ≤ 25) 소수 정예 기준</div>'
      }

      <details class="radar-excluded">
        <summary>제외 종목 (${excTotal})</summary>
        ${EXCLUDE_GROUP_ORDER.map(key => excGroups[key].length
          ? `<div class="radar-exc-group"><b>${EXCLUDE_LABEL[key]}</b> (${excGroups[key].length})<br>${_renderExcludedList(excGroups[key])}</div>`
          : '').join('')}
      </details>
    </div>
  `;

  document.getElementById('radar-refresh')?.addEventListener('click', () => {
    if (!_loading) _load();
  });

  panel.querySelectorAll('.radar-sort-btn[data-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (_sort === btn.dataset.sort) return;
      _sort = btn.dataset.sort;
      _render();
    });
  });

  panel.querySelectorAll('.radar-row[data-sym]').forEach(row => {
    row.addEventListener('click', () => _toggleAccordion(row.dataset.sym));
  });

  // 정렬 토글·새로고침 후에도 열려있던 아코디언 복원
  for (const sym of [..._openOrder]) {
    if (_metrics[sym]) _insertAccordionRow(sym, { skipOrderPush: true });
    else _openOrder = _openOrder.filter(s => s !== sym);
  }
}

// ── 미니 시각화 (인라인 SVG) ────────────────────────────────────
function _skewBarSvg(skew) {
  if (skew == null) return '<span class="radar-mini-empty">—</span>';
  const W = 60, HALF = 30, H = 12;
  const clamped = Math.max(-0.20, Math.min(0.20, skew));
  const barW = Math.abs(clamped) / 0.20 * HALF;
  const color = skew > 0 ? '#3fb950' : skew < 0 ? '#f85149' : 'var(--text3)';
  const x = skew >= 0 ? HALF : HALF - barW;
  return `<svg width="${W}" height="${H}" class="radar-mini-svg" viewBox="0 0 ${W} ${H}">
    <line x1="${HALF}" y1="0" x2="${HALF}" y2="${H}" stroke="var(--border)" stroke-width="1"/>
    <rect x="${x.toFixed(1)}" y="2" width="${barW.toFixed(1)}" height="${H - 4}" fill="${color}" opacity="0.8" rx="1"/>
  </svg>`;
}

function _bbBarSvg(m) {
  const pos = m.bbLogPos;
  if (pos == null) return '<span class="radar-mini-empty">BB 없음</span>';
  const W = 66, H = 10, PAD = 4;
  const clamped = Math.max(0, Math.min(1, pos));
  const x = PAD + clamped * W;
  const threshX = PAD + PILLAR_THRESHOLDS.bbLogMax * W;
  const dotColor = m.positionOk ? '#3fb950' : (m.bbTouch5d ? '#d29922' : '#f85149');
  const touchDot = m.bbTouch5d ? `<circle cx="${PAD}" cy="${H / 2}" r="2" fill="#3fb950" title="하단 터치"/>` : '';
  return `<svg width="${W + PAD * 2}" height="${H}" class="radar-mini-svg" viewBox="0 0 ${W + PAD * 2} ${H}">
    <rect x="${PAD}" y="0" width="${W}" height="${H}" fill="var(--bg3)" stroke="var(--border)" stroke-width="0.5"/>
    <line x1="${threshX.toFixed(1)}" y1="0" x2="${threshX.toFixed(1)}" y2="${H}" stroke="#d29922" stroke-width="1" stroke-dasharray="1,1"/>
    ${touchDot}
    <circle cx="${x.toFixed(1)}" cy="${H / 2}" r="2.6" fill="${dotColor}"/>
  </svg>`;
}

function _hbarSvg(value, max, color = '#58a6ff') {
  if (value == null) return '<span class="radar-mini-empty">—</span>';
  const W = 44, H = 10;
  const ratio = max > 0 ? Math.min(Math.abs(value) / max, 1) : 0;
  return `<svg width="${W}" height="${H}" class="radar-mini-svg" viewBox="0 0 ${W} ${H}">
    <rect x="0" y="1" width="${(ratio * W).toFixed(1)}" height="${H - 2}" fill="${color}" opacity="0.65" rx="1"/>
  </svg>`;
}

// ── 목록 테이블 ──────────────────────────────────────────────────
function _renderTable(list) {
  const maxVanna = Math.max(1e-6, ...list.map(m => Math.abs(m.vannaTotal ?? 0)));
  const maxConc  = Math.max(1e-6, ...list.map(m => m.concRatio ?? 0));

  const rows = list.map(m => {
    const skew     = m.keyExpiry?.skewRel;
    const dKey     = m.daysToKey != null ? `D-${m.daysToKey}` : '—';
    const winKey   = m.keyExpiry ? _calendar.windowOf(m.keyExpiry.expiry_date) : '—';
    const align    = m.alignCount ?? 0;
    const alignBadge = align >= 5 ? ' <span class="radar-badge radar-badge--struct">구조</span>' : '';
    const vanna    = m.vannaTotal != null ? `${m.vannaTotal.toFixed(1)}M` : '—';
    const conc     = m.concRatio  != null ? `${m.concRatio.toFixed(1)}x` : '—';
    const cwall    = m.callWall   != null ? `$${m.callWall}` : '—';
    const spot     = m.spot_price != null ? `$${m.spot_price.toFixed(2)}` : '—';
    const myBadge    = m._isMY    ? '<span class="radar-badge radar-badge--my">MY</span> ' : '';
    const indexBadge = m._isIndex ? '<span class="radar-badge radar-badge--index">지수</span> ' : '';
    const warnBadges = (m._cls?.badges ?? []).map(b =>
      `<span class="radar-badge radar-badge--warn">${b}</span>`).join(' ');
    const isOpen = _openOrder.includes(m.symbol);

    return `
      <tr class="radar-row${isOpen ? ' open' : ''}" data-sym="${m.symbol}">
        <td>${indexBadge}${myBadge}${m.symbol}${warnBadges}${alignBadge}</td>
        <td>${_renderOpinion(m)}</td>
        <td>${spot}</td>
        <td>${dKey} <span class="radar-win">${winKey}</span></td>
        <td><div class="radar-mini-cell">${_skewBarSvg(skew)}<span>${skew != null ? (skew * 100).toFixed(1) + '%' : '—'}</span></div></td>
        <td><div class="radar-mini-cell">${_bbBarSvg(m)}<span>${m.bbLogPos != null ? (m.bbLogPos * 100).toFixed(0) : '—'}</span></div></td>
        <td>${align}</td>
        <td><div class="radar-mini-cell">${_hbarSvg(m.vannaTotal, maxVanna, '#a371f7')}<span>${vanna}</span></div></td>
        <td><div class="radar-mini-cell">${_hbarSvg(m.concRatio, maxConc, '#f0883e')}<span>${conc}</span></div></td>
        <td>${cwall}</td>
        <td class="radar-reason">${reasonString(m)}</td>
      </tr>
      <tr class="radar-acc-placeholder" data-acc-for="${m.symbol}" hidden></tr>`;
  }).join('');

  return `
    <div class="radar-table-wrap">
      <table class="data-table radar-table">
        <thead><tr>
          <th>종목</th><th>의견</th><th>현재가</th><th>핵심만기</th>
          <th>스큐</th><th>BB(로그%B)</th><th>정렬수</th>
          <th>Vanna</th><th>집중도</th><th>콜월</th><th>이유</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── 의견 셀: 등급 배지 + 기둥 점 (스큐·연료·폭·타이밍, v0.5: 위치는 게이트) ──
const GRADE_LABEL = { A: '매수 우선', B: '관심', C: '보류', X: '제외' };
const LEVEL_DOT = { 3: '●', 2: '◐', 1: '○' };
const PILLAR_NAME = { skew: '스큐', fuel: '연료', width: '폭', timing: '타이밍' };

function _renderOpinion(m) {
  const op = m._op;
  if (!op) return '—';
  const p = op.pillars;
  const k = m.keyExpiry;

  const dot = (name, lv) =>
    `<span class="radar-pillar radar-pillar--${lv ?? 0}" title="${name}">${LEVEL_DOT[lv] ?? '?'}</span>`;

  const tip = [
    `등급 ${op.grade} ${GRADE_LABEL[op.grade]}${op.exclude ? ` (${EXCLUDE_LABEL[op.exclude] ?? op.exclude})` : ''}`,
    op.demoted ? `A 강등 사유: ${op.demoted}` : null,
    `스큐: ${k?.skewRel != null ? (k.skewRel * 100).toFixed(1) + '%' : '—'}`,
    `연료: Vanna${(k?.vannaSupport ?? 0) > 0 ? '+' : '−'} Charm${(k?.charmSupport ?? 0) > 0 ? '+' : '−'}`,
    `위치 게이트: 로그%B ${m.bbLogPos != null ? (m.bbLogPos * 100).toFixed(0) : '—'} · 5일 하단터치 ${m.bbTouch5d ? 'Y' : 'N'}`,
    `추세: ${m.trendMissing ? '200일선 데이터 없음' : (m.trendOk ? '200일선 위' : '200일선 아래')}`,
    `폭: ${m.wallDistAtr != null ? m.wallDistAtr.toFixed(1) + 'ATR' : '—'}`,
    `타이밍: ${m.daysToKey != null ? `D-${m.daysToKey} 창${k?.window ?? '—'}` : '—'}`,
  ].filter(Boolean).join('\n');

  return `<span class="radar-opinion" title="${tip}">
    <span class="radar-badge radar-badge--${op.grade.toLowerCase()}">${op.grade}</span>
    ${dot(PILLAR_NAME.skew, p.skew)}${dot(PILLAR_NAME.fuel, p.fuel)}${dot(PILLAR_NAME.width, p.width)}${dot(PILLAR_NAME.timing, p.timing)}
  </span>`;
}

function _renderExcludedList(list) {
  return list.map(m =>
    `<span class="radar-exc-sym" data-sym="${m.symbol}" title="${reasonString(m)}">${m.symbol}</span>`
  ).join(' ');
}

// ── 아코디언 (행 클릭 → 바로 아래 펼침, 최대 3개, 페이지 이동 없음) ──
function _toggleAccordion(symbol) {
  const idx = _openOrder.indexOf(symbol);
  if (idx !== -1) {
    _openOrder.splice(idx, 1);
    _removeAccordionRow(symbol);
    document.querySelector(`.radar-row[data-sym="${symbol}"]`)?.classList.remove('open');
    return;
  }
  if (_openOrder.length >= MAX_OPEN) {
    const oldest = _openOrder.shift();
    _removeAccordionRow(oldest);
    document.querySelector(`.radar-row[data-sym="${oldest}"]`)?.classList.remove('open');
  }
  _openOrder.push(symbol);
  document.querySelector(`.radar-row[data-sym="${symbol}"]`)?.classList.add('open');
  _insertAccordionRow(symbol);
}

function _removeAccordionRow(symbol) {
  document.querySelectorAll(`tr.radar-acc-row[data-sym="${symbol}"]`).forEach(tr => tr.remove());
}

function _insertAccordionRow(symbol, { skipOrderPush = false } = {}) {
  if (!skipOrderPush && !_openOrder.includes(symbol)) _openOrder.push(symbol);
  const m = _metrics[symbol];
  if (!m) return;

  // 이미 테이블에 없는(다른 섹션) 자리일 수 있으니 모든 일치 placeholder에 삽입
  document.querySelectorAll(`tr.radar-acc-placeholder[data-acc-for="${symbol}"]`).forEach(placeholder => {
    if (placeholder.nextElementSibling?.classList?.contains('radar-acc-row')) return; // 이미 삽입됨
    const colCount = placeholder.closest('table')?.querySelectorAll('thead th').length ?? 11;
    const tr = document.createElement('tr');
    tr.className = 'radar-acc-row';
    tr.dataset.sym = symbol;
    const td = document.createElement('td');
    td.colSpan = colCount;
    td.innerHTML = _accordionBodyHtml(symbol);
    tr.appendChild(td);
    placeholder.after(tr);
    _bindAccordionSubtabs(tr, symbol);
    _renderAccordionCharts(symbol, _openSubtab[symbol] ?? 'structure');
  });
}

const SUBTABS = [
  { id: 'structure', label: '구조' },
  { id: 'em',        label: 'EM' },
  { id: 'heatmap',   label: '히트맵' },
  { id: 'expiries',  label: '만기표' },
];

function _accordionBodyHtml(symbol) {
  const active = _openSubtab[symbol] ?? 'structure';
  const tabsHtml = SUBTABS.map(t =>
    `<button class="radar-acc-tab${t.id === active ? ' active' : ''}" data-subtab="${t.id}">${t.label}</button>`
  ).join('');
  return `
    <div class="radar-acc">
      <div class="radar-acc-head">
        <span class="radar-acc-title">${symbol} 상세</span>
        <div class="radar-acc-tabs">${tabsHtml}</div>
        <button class="radar-close-btn" data-close-sym="${symbol}">✕ 닫기</button>
      </div>
      <div class="radar-acc-body">
        ${SUBTABS.map(t => `<div class="radar-acc-pane" data-pane="${t.id}" ${t.id === active ? '' : 'hidden'}></div>`).join('')}
      </div>
    </div>`;
}

function _bindAccordionSubtabs(tr, symbol) {
  tr.querySelectorAll('.radar-acc-tab').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const sub = btn.dataset.subtab;
      _openSubtab[symbol] = sub;
      tr.querySelectorAll('.radar-acc-tab').forEach(b => b.classList.toggle('active', b === btn));
      tr.querySelectorAll('.radar-acc-pane').forEach(p => { p.hidden = p.dataset.pane !== sub; });
      _renderAccordionCharts(symbol, sub);
    });
  });
  tr.querySelector('.radar-close-btn')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    _toggleAccordion(symbol);
  });
  tr.addEventListener('click', ev => ev.stopPropagation()); // 아코디언 내부 클릭이 다시 토글되지 않도록
}

// 렌더 여부 캐시 (같은 subtab을 다시 클릭해도 차트 재생성 안 함)
const _accRendered = {}; // `${symbol}:${subtab}` → true

function _renderAccordionCharts(symbol, subtab) {
  const key = `${symbol}:${subtab}`;
  if (_accRendered[key]) return;
  const tr = document.querySelector(`tr.radar-acc-row[data-sym="${symbol}"]`);
  const pane = tr?.querySelector(`.radar-acc-pane[data-pane="${subtab}"]`);
  if (!pane) return;
  const m = _metrics[symbol];
  if (!m) return;

  if (subtab === 'structure') {
    pane.innerHTML = _renderStructurePane(m);
  } else if (subtab === 'em') {
    pane.innerHTML = '';
    const legacy = aggregateStrikes(m).map(s => ({ ...s, vanna: -s.vanna, charm: -s.charm })); // §3-2 부호 반전
    if (legacy.length) {
      renderVannaDistChart(pane, legacy, m.spot_price, {
        mode: 'combined', vixDir: 'neutral', dte: 30,
        label: `${symbol} · 8주 합산 EM · Vanna 기반`,
      });
    } else {
      pane.innerHTML = '<div class="radar-acc-empty">스트라이크 데이터 없음</div>';
    }
  } else if (subtab === 'heatmap') {
    const spe = strikesPerExpiry(m).map(e => ({
      ...e, strikes: e.strikes.map(s => ({ ...s, vanna: -s.vanna })), // §3-2 부호 반전
    }));
    const heatmapEl = document.createElement('div');
    const mapWrap = document.createElement('div');
    mapWrap.style.cssText = 'overflow-x:auto;margin-top:10px';
    const canvas = document.createElement('canvas');
    canvas.height = 200;
    mapWrap.appendChild(canvas);
    pane.innerHTML = '<div class="radar-section-label">Vanna 히트맵 (만기 × 스트라이크)</div>';
    pane.appendChild(heatmapEl);
    pane.insertAdjacentHTML('beforeend', '<div class="radar-section-label" style="margin-top:12px">DEX 맵 (콜 정점 ▲ 표시)</div>');
    pane.appendChild(mapWrap);
    renderVannaHeatmap(heatmapEl, spe, m.spot_price);
    _drawDexMapCanvas(canvas, m);
  } else if (subtab === 'expiries') {
    pane.innerHTML = _renderExpiryTable(m);
  }
  _accRendered[key] = true;
}

function _renderStructurePane(m) {
  const spot = m.spot_price;
  const ladderItems = [
    { label: 'OI 하단 경계', val: m.oiLowerEdge,  dir: 'down' },
    { label: '풋벽',         val: m.putWall,      dir: m.putWall != null && spot != null ? (m.putWall < spot ? 'down' : 'up') : '' },
    { label: 'BB 20일선',    val: m.bb?.bb_mid,    dir: ''     },
    { label: '50일선',       val: m.bb?.sma50,     dir: ''     },
    { label: 'spot',         val: spot,            dir: 'spot' },
    { label: '200일선',      val: m.bb?.sma200,    dir: ''     },
    { label: 'vannaReach',   val: m.vannaReach,    dir: 'up'   },
    { label: 'callWall',     val: m.callWall,      dir: 'up'   },
    { label: 'BB 2σ 상단',   val: m.bb?.bb_upper2, dir: ''     },
    { label: 'OI 상단 경계', val: m.oiUpperEdge,   dir: ''     },
  ].filter(x => x.val != null).sort((a, b) => a.val - b.val);

  const ladderHtml = ladderItems.map(x => `
    <div class="radar-ladder-row${x.dir === 'spot' ? ' radar-ladder--spot' : ''}">
      <span class="radar-ladder-label">${x.label}</span>
      <span class="radar-ladder-val ${x.dir}">$${x.val}</span>
    </div>`).join('');

  const op = m._op ?? {};
  const p = op.pillars ?? {};
  const pillarRows = [
    ['스큐 (keyExpiry.skewRel)', m.keyExpiry?.skewRel != null ? (m.keyExpiry.skewRel * 100).toFixed(1) + '%' : '—', p.skew],
    ['연료 (Vanna/Charm 부호)', `Vanna ${m.keyExpiry?.vannaSupport?.toFixed(2) ?? '—'} · Charm ${m.keyExpiry?.charmSupport?.toFixed(2) ?? '—'}`, p.fuel],
    ['폭 (콜월/ATR20)', m.wallDistAtr != null ? m.wallDistAtr.toFixed(2) + ' ATR' : '—', p.width],
    ['타이밍 (D-n · 창)', m.daysToKey != null ? `D-${m.daysToKey} 창${m.keyExpiry?.window ?? '—'}` : '—', p.timing],
  ].map(([name, val, lv]) => `
    <div class="radar-pillar-row">
      <span class="radar-pillar radar-pillar--${lv ?? 0}">${LEVEL_DOT[lv] ?? '?'}</span>
      <span class="radar-pillar-name">${name}</span>
      <span class="radar-pillar-val">${val}</span>
    </div>`).join('');

  const gateHtml = `
    <div class="radar-gate-row">위치 게이트: 로그%B <b>${m.bbLogPos != null ? (m.bbLogPos * 100).toFixed(0) : '—'}</b>
      (기준 ≤ ${(PILLAR_THRESHOLDS.bbLogMax * 100).toFixed(0)}) · 5일 하단터치 <b>${m.bbTouch5d ? `Y (${m.bbTouchDate ?? ''})` : 'N'}</b></div>
    <div class="radar-gate-row">추세 게이트: ${m.trendMissing ? '200일선 데이터 없음' : (m.trendOk ? '<b class="up">200일선 위</b>' : '<b class="down">200일선 아래</b>')}</div>
    <div class="radar-gate-row">풋벽 게이트: 풋벽 <b>$${m.putWall ?? '—'}</b> · ${m.putWallMissing ? '풋 OI 데이터 없음' : (m.putWallOk ? '<b class="up">벽 위(재탈환)</b>' : '<b class="down">벽 아래</b>')}</div>`;

  return `
    <div class="radar-acc-cols">
      <div class="radar-acc-col">
        <div class="radar-section-label">가격 사다리</div>
        <div class="radar-ladder">${ladderHtml || '<div class="radar-acc-empty">데이터 없음</div>'}</div>
      </div>
      <div class="radar-acc-col">
        <div class="radar-section-label">게이트 · 기둥 원값</div>
        ${gateHtml}
        <div class="radar-pillars">${pillarRows}</div>
      </div>
    </div>`;
}

function _renderExpiryTable(m) {
  const rows = m.expiries.map(e => {
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
      <td>${e.lowConf ? '<span class="radar-badge radar-badge--warn">저신뢰</span>' : ''}</td>
    </tr>`;
  }).join('');

  return `
    <div class="radar-table-wrap">
      <table class="data-table radar-table" style="font-size:12px">
        <thead><tr>
          <th>만기</th><th>DTE</th><th>창</th><th>skewRel</th>
          <th>Vanna $M</th><th>Charm</th><th>풋OI↓</th><th>콜OI↑</th>
          <th>콜정점</th><th>총OI</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── DEX 맵 (canvas, 기존 로직 유지) ─────────────────────────────
function _drawDexMapCanvas(canvas, m) {
  const spot = m.spot_price;
  const w8 = m.expiries.filter(e => e.dte <= 56);
  if (!w8.length) return;

  const strikeSet = new Set();
  for (const e of w8) for (const s of (e.strikes ?? [])) strikeSet.add(s.strike);
  const strikes = [...strikeSet].sort((a, b) => a - b);

  const cols  = strikes.length;
  const rows  = w8.length + 1;
  const cellW = Math.max(32, Math.min(60, Math.floor(900 / cols)));
  const cellH = 26;
  const labelW = 90;

  canvas.width  = labelW + cols * cellW;
  canvas.height = cellH * (rows + 1);

  const ctx = canvas.getContext('2d');
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
    || (!document.documentElement.getAttribute('data-theme')
        && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const bg = isDark ? '#161b22' : '#f6f8fa';
  const fg = isDark ? '#c9d1d9' : '#24292f';
  const grid = isDark ? '#30363d' : '#d0d7de';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '10px monospace';

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
      ctx.fillStyle = sup.vannaSupport > 0 ? `rgba(63,185,80,${alpha})` : `rgba(248,81,73,${alpha})`;
      ctx.fillRect(labelW + ci * cellW + 1, y + 1, cellW - 2, cellH - 2);
    }
  }

  const sumY = cellH * (w8.length + 1);
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
