// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// live.js — Tab1: DEX Live
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { CF_API, TWELVE_KEY, RAILWAY_URL }                    from '../config.js';
import {
  fmtPrice, fmtChange, fmtChangePct,
  fmtM, fmtVold,
  colorBySign, colorVix, COLOR,
} from '../fmt.js';
import { renderHeatmap }                              from '../heatmap.js';
import { buildNarrative, buildAnalysisPayload }       from '../narrative.js';
import { renderOIChart, updateOIChart, renderStrikeTable, renderTop5Panel } from '../oi-chart.js';
import { initVCChart, pushVixPoint, pushVoldPoint, setVixPrevClose } from '../vc-chart.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 내부 상태
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const _state = {
  spy:     { price: null, change: null, changePct: null },
  vix:     { price: null, change: null, changePct: null },
  gex:     null,
  vanna:   null,
  charm:   null,
  strikes: [],
  spot:    null,   // 0dte KV의 spot (폴백)

  // SPY 폴링 상태
  spyLive:         null,   // 최신 SPY 현재가
  lastFinnhubTs:   0,      // 마지막 Finnhub 성공 timestamp(ms)

  // VOLD (OBV 기반)
  vold:            0,

  putWall:  null,
  callWall: null,
  flipZone: null,
  pcr:      null,
  oiOpen:   null,  // 장 시작 OI 맵 { oiMap: { [strike]: { c, p } }, saved_at }
};

// OI 차트 인스턴스 (탭 재방문 시 재생성 방지)
let _chartInst = null;

// 폴링 타이머 핸들
let _spyPollTimer  = null;
let _kvPollTimer   = null;  // 프리/애프터용 KV 폴링

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// KV 데이터 fetch (15분 주기: GEX/Vanna/Charm/내러티브)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fetchKV() {
  try {
    const [snapRes, dexRes, oiOpenRes] = await Promise.all([
      fetch(`${CF_API}/api/snapshot`),
      fetch(`${CF_API}/api/dex/0dte`),
      fetch(`${CF_API}/api/oi/open`),
    ]);

    if (snapRes.ok) {
      const snap = await snapRes.json();
      if (!snap.error) {
        // VIX는 KV에서, SPY는 /api/spy-price 폴링이 담당
        _state.vix = snap.vix ?? _state.vix;
      }
    }

    if (dexRes.ok) {
      const dex = await dexRes.json();
      if (!dex.error) {
        _state.gex     = dex.gex_total   ?? null;
        _state.vanna   = dex.vanna_total ?? null;
        _state.charm   = dex.charm_total ?? null;
        _state.strikes = dex.strikes     ?? [];
        _state.spot    = dex.spot        ?? null;

        _state.putWall  = _calcPutWall(_state.strikes, _state.spot);
        _state.callWall = _calcCallWall(_state.strikes, _state.spot);
        _state.flipZone = _calcFlipZone(_state.strikes);
        _state.pcr      = _calcPCR(_state.strikes);
      }
    }

    if (oiOpenRes.ok) {
      const oiOpen = await oiOpenRes.json();
      if (!oiOpen.error && oiOpen.oiMap) {
        _state.oiOpen = oiOpen;
      }
    }
  } catch (e) {
    console.warn('[Live] KV fetch 실패:', e.message);
  }

  renderCards();
  _onSpotUpdated();   // GEX/히트맵/OI 차트 재계산

  // 급등 OI 패널
  if (_state.strikes.length > 0) {
    renderTop5Panel('top5-panel', _state.strikes, 'delta15m');
  }

  // 판단 패널 (옵션체인 갱신 시 무조건 재렌더)
  renderNarrative();

  // 정규장일 때만 AI 자동 분석
  if (window._marketState === 'REGULAR') {
    requestAIAnalysis(true);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// onSpotUpdated — SPY 현재가 변경 시 화면 일괄 업데이트
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _onSpotUpdated() {
  const spotPrice = _state.spyLive ?? _state.spy.price ?? _state.spot;
  if (!spotPrice) return;

  // SPY 메트릭 카드
  renderSPY();

  // Put Wall / Call Wall 재계산
  if (_state.strikes.length > 0) {
    _state.putWall  = _calcPutWall(_state.strikes, spotPrice);
    _state.callWall = _calcCallWall(_state.strikes, spotPrice);
    renderPutWall();
    renderCallWall();
  }

  // 히트맵
  if (_state.strikes.length > 0) {
    renderHeatmap('heatmap-canvas', _state.strikes, spotPrice);
  }

  // OI 차트
  if (_state.strikes.length > 0) {
    if (!_chartInst) {
      _chartInst = renderOIChart('live-chart-wrap', _state.strikes, spotPrice, { mode: '0dte' });
    } else {
      updateOIChart(_chartInst, _state.strikes, spotPrice);
    }
  }

  // Strike 테이블
  if (_state.strikes.length > 0) {
    const countEl = document.getElementById('strike-count');
    if (countEl) countEl.textContent = `${_state.strikes.length}건`;
    renderStrikeTable('strike-tbody', _state.strikes, {
      mode:      '0dte',
      spotPrice,
      flipZone:  _state.flipZone  ?? null,
      putWall:   _state.putWall   ?? null,
      callWall:  _state.callWall  ?? null,
      openOI:    _state.oiOpen?.oiMap ?? null,
      isRegular: window._marketState === 'REGULAR',
    });
  }

  // 내러티브 패널 (SPY 기반 조건 변화 시만)
  _renderNarrativeIfChanged();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SPY 폴링 — Finnhub REST (정규장: 20초)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function _fetchSpyFinnhub() {
  try {
    const res = await fetch(`${CF_API}/api/spy-price`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.error || !data.price) return;

    const nowMs = Date.now();

    if (data.source === 'finnhub') {
      // Finnhub 성공
      _state.lastFinnhubTs = nowMs;
      _updateSpy(data);
    } else {
      // KV 폴백: ts 비교 후 최신일 때만 반영
      const kvTs = data.ts ? new Date(data.ts).getTime() : 0;
      if (kvTs > _state.lastFinnhubTs) {
        _updateSpy(data);
      }
      // kvTs ≤ lastFinnhubTs → 현재값 유지
    }
  } catch (e) {
    console.warn('[Live] SPY 폴링 실패:', e.message);
  }
}

function _updateSpy(data) {
  _state.spyLive           = data.price;
  _state.spy.price         = data.price;
  _state.spy.change        = data.change    ?? _state.spy.change;
  _state.spy.changePct     = data.changePct ?? _state.spy.changePct;
  _onSpotUpdated();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VIX + SPY KV 폴링 (프리/애프터: 3분)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let _lastKvVixTs  = 0;
let _lastKvSpyTs  = 0;

async function _fetchKvPoll() {
  try {
    const res = await fetch(`${CF_API}/api/snapshot`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return;
    const snap = await res.json();
    if (snap.error) return;

    const snapTs = snap.ts ? new Date(snap.ts).getTime() : 0;

    // VIX: ts 변경 시만 렌더링
    if (snapTs > _lastKvVixTs && snap.vix?.price) {
      _lastKvVixTs = snapTs;
      _state.vix   = snap.vix;
      renderVIX();
    }

    // SPY: ts 변경 시만 반영 (프리/애프터 — Finnhub 미사용)
    if (snapTs > _lastKvSpyTs && snap.spy?.price) {
      _lastKvSpyTs = snapTs;
      _updateSpy({ ...snap.spy, source: 'kv', ts: snap.ts });
    }
  } catch (e) {
    console.warn('[Live] KV 폴링 실패:', e.message);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VOLD — Twelve Data OBV (RSP, 1min, 정규장 1분 폴링)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function _fetchVold() {
  try {
    if (!TWELVE_KEY) return;
    const url =
      `https://api.twelvedata.com/obv?symbol=RSP&interval=1min` +
      `&outputsize=390&apikey=${TWELVE_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return;
    const data = await res.json();
    if (data.status === 'error' || !Array.isArray(data.values)) return;

    // values: [{ datetime, obv }, ...] (최신이 앞)
    const values = data.values;
    if (!values.length) return;

    // OBV 변화량 누적합 → VOLD
    let cumDelta = 0;
    for (let i = values.length - 1; i >= 0; i--) {
      const cur  = parseFloat(values[i].obv);
      const prev = i + 1 < values.length ? parseFloat(values[i + 1].obv) : cur;
      cumDelta += (cur - prev);
    }
    _state.vold = cumDelta;
    renderVOLD();

    // VOLD 차트: 최신 1포인트 push
    const latest = values[0];
    if (latest) {
      const ts = new Date(latest.datetime + ' ET').toISOString();
      pushVoldPoint(ts, _state.vold);
    }
  } catch (e) {
    console.warn('[Live] VOLD OBV 폴링 실패:', e.message);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 폴링 시작 / 중지
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _startRegularPolling() {
  _stopAllPolling();
  _fetchSpyFinnhub();                                       // 즉시 1회
  _fetchVixAndVold();                                       // 즉시 1회
  _spyPollTimer = setInterval(_fetchSpyFinnhub, 20_000);   // 20초
  _vixPollTimer = setInterval(_fetchVixAndVold, 60_000);   // 1분
}

function _startExtendedPolling() {
  // 프리/애프터: SPY+VIX 모두 KV 3분 폴링
  _stopAllPolling();
  _fetchKvPoll();                                                  // 즉시 1회
  _kvPollTimer = setInterval(_fetchKvPoll, 3 * 60_000);           // 3분
}

function _stopAllPolling() {
  if (_spyPollTimer) { clearInterval(_spyPollTimer); _spyPollTimer = null; }
  if (_kvPollTimer)  { clearInterval(_kvPollTimer);  _kvPollTimer  = null; }
  if (_vixPollTimer) { clearInterval(_vixPollTimer); _vixPollTimer = null; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 렌더링 헬퍼
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function setEl(id, text, color = null) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (color) el.style.color = color;
}

function renderSPY() {
  const price  = _state.spyLive ?? _state.spy.price;
  const change = _state.spy.change;
  const pct    = _state.spy.changePct;
  const color  = colorBySign(change);
  setEl('m-spy', fmtPrice(price), color);
  setEl('m-spy-sub', `${fmtChange(change)} ${fmtChangePct(pct)}`, color);
}

function renderVIX() {
  const { price, change, changePct } = _state.vix;
  const color = colorVix(price);
  setEl('m-vix', fmtPrice(price), color);
  setEl('m-vix-sub', `${fmtChange(change)} ${fmtChangePct(changePct)}`, colorBySign(change));
}

function renderGEX() {
  const v     = _state.gex;
  const color = colorBySign(v);
  setEl('m-gex0', fmtM(v), color);
  setEl('m-gex0-sub', 'gamma exp.', COLOR.muted);
}

function renderVanna() {
  setEl('m-vanna0', fmtM(_state.vanna), COLOR.purple);
}

function renderCharm() {
  setEl('m-charm0', fmtM(_state.charm), COLOR.teal);
}

function renderPutWall() {
  const v = _state.putWall;
  setEl('m-put-wall', v != null ? `$${v.toFixed(0)}` : '—', COLOR.red ?? 'var(--red)');
}

function renderCallWall() {
  const v = _state.callWall;
  setEl('m-call-wall', v != null ? `$${v.toFixed(0)}` : '—', COLOR.green ?? 'var(--green)');
}

function renderFlipZone() {
  const v = _state.flipZone;
  setEl('m-flip-zone', v != null ? `$${v.toFixed(0)}` : '—', COLOR.amber ?? 'var(--amber)');
}

function renderPCR() {
  const v = _state.pcr;
  let color = COLOR.muted;
  if (v != null) {
    color = v > 1.2 ? (COLOR.red   ?? 'var(--red)')
          : v < 0.8 ? (COLOR.green ?? 'var(--green)')
          :            (COLOR.amber ?? 'var(--amber)');
  }
  setEl('m-pcr', v != null ? v.toFixed(2) : '—', color);
}

function renderVOLD() {
  const color = colorBySign(_state.vold);
  setEl('m-dex0',     fmtVold(_state.vold), color);
  setEl('m-dex0-sub', 'RSP breadth',        COLOR.muted);
  const labelEl = document.querySelector('[data-metric="dex0"] .metric-label');
  if (labelEl) labelEl.textContent = 'VOLD';
}

function renderCards() {
  renderSPY();
  renderVIX();
  renderGEX();
  renderVanna();
  renderCharm();
  renderVOLD();
  renderPutWall();
  renderCallWall();
  renderFlipZone();
  renderPCR();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 판단 패널
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const LEVEL_STYLE = {
  danger: { bg: 'rgba(239,68,68,.12)',   border: '#ef4444', icon: '🔴' },
  warn:   { bg: 'rgba(245,158,11,.10)',  border: '#f59e0b', icon: '⚠️' },
  good:   { bg: 'rgba(34,197,94,.10)',   border: '#22c55e', icon: '🟢' },
  info:   { bg: 'rgba(107,114,128,.10)', border: '#6b7280', icon: '💬' },
};

// 내러티브 패널 — 내용이 바뀔 때만 DOM 업데이트
let _lastNarrativeHtml = '';

function _renderNarrativeIfChanged() {
  const el = document.getElementById('live-narrative');
  if (!el) return;
  const events = buildNarrative({ ..._state, marketState: window._marketState });
  const html = events.map(({ level, msg }) => {
    const s = LEVEL_STYLE[level] ?? LEVEL_STYLE.info;
    return `
      <div style="
        display:flex;align-items:flex-start;gap:8px;
        padding:8px 10px;border-radius:6px;
        background:${s.bg};border-left:3px solid ${s.border};
        font-size:12px;line-height:1.5;color:var(--text1,#e6edf3);
      ">
        <span style="flex-shrink:0;margin-top:1px">${s.icon}</span>
        <span>${msg}</span>
      </div>`;
  }).join('');
  if (html === _lastNarrativeHtml) return;  // 변경 없으면 스킵
  _lastNarrativeHtml = html;
  el.innerHTML = html;
}

function renderNarrative() {
  const el = document.getElementById('live-narrative');
  if (!el) return;
  const events = buildNarrative({ ..._state, marketState: window._marketState });
  el.innerHTML = events.map(({ level, msg }) => {
    const s = LEVEL_STYLE[level] ?? LEVEL_STYLE.info;
    return `
      <div style="
        display:flex;align-items:flex-start;gap:8px;
        padding:8px 10px;border-radius:6px;
        background:${s.bg};border-left:3px solid ${s.border};
        font-size:12px;line-height:1.5;color:var(--text1,#e6edf3);
      ">
        <span style="flex-shrink:0;margin-top:1px">${s.icon}</span>
        <span>${msg}</span>
      </div>`;
  }).join('');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AI 분석
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function renderAIResult(data) {
  const el = document.getElementById('ai-analysis-result');
  if (!el) return;
  const { market_regime: mr, deep_dive: dd, scenarios, expert_insight } = data;

  const scenarioHTML = (scenarios ?? []).map(sc => {
    const prob  = sc.probability ?? 50;
    const color = prob >= 60 ? '#22c55e' : prob <= 40 ? '#ef4444' : '#f59e0b';
    return `
      <div style="margin-bottom:6px;padding:7px 8px;border-radius:4px;
                  background:rgba(255,255,255,.04);border:1px solid #30363d">
        <div style="display:flex;justify-content:space-between;margin-bottom:3px">
          <span style="font-size:11px;font-weight:600;color:${color}">${sc.case}</span>
          <span style="font-size:12px;font-weight:700;color:${color}">${prob}%</span>
        </div>
        <div style="font-size:11px;color:#8b949e;margin-bottom:1px">▶ ${sc.trigger}</div>
        <div style="font-size:11px;color:#8b949e">목표: ${sc.target}</div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div style="margin-bottom:8px;padding:7px 9px;border-radius:5px;
                background:rgba(167,139,250,.1);border-left:3px solid #a78bfa">
      <div style="font-size:10px;color:#a78bfa;font-weight:600;margin-bottom:2px">시장 국면</div>
      <div style="font-size:12px;font-weight:700;color:#e6edf3;margin-bottom:3px">${mr?.phase ?? '—'}</div>
      <div style="font-size:11px;color:#8b949e;margin-bottom:3px">${mr?.volatility_context ?? ''}</div>
      <span style="font-size:10px;padding:2px 7px;border-radius:10px;
                   background:rgba(167,139,250,.2);color:#a78bfa">${mr?.dominance ?? ''}</span>
    </div>
    <div style="margin-bottom:8px">
      <div style="font-size:10px;color:#8b949e;font-weight:600;margin-bottom:4px">딜러 포지션</div>
      <div style="font-size:11px;color:#e6edf3;line-height:1.5;margin-bottom:3px">${dd?.dealer_inventory?.gamma_exposure ?? '—'}</div>
      <div style="font-size:11px;color:#e6edf3;line-height:1.5">${dd?.dealer_inventory?.vanna_flow ?? '—'}</div>
    </div>
    <div style="margin-bottom:8px;padding:7px 9px;border-radius:5px;
                background:rgba(34,197,94,.06);border-left:3px solid #22c55e">
      <div style="font-size:10px;color:#22c55e;font-weight:600;margin-bottom:3px">수급 (VOLD)</div>
      <div style="font-size:11px;color:#e6edf3;margin-bottom:2px">${dd?.breadth_analysis?.vold_signal ?? '—'}</div>
      <div style="font-size:11px;color:#8b949e">${dd?.breadth_analysis?.interpretation ?? ''}</div>
    </div>
    <div style="margin-bottom:8px">
      <div style="font-size:10px;color:#8b949e;font-weight:600;margin-bottom:4px">시나리오</div>
      ${scenarioHTML}
    </div>
    <div style="padding:7px 9px;border-radius:5px;
                background:rgba(245,158,11,.08);border-left:3px solid #f59e0b">
      <div style="font-size:10px;color:#f59e0b;font-weight:600;margin-bottom:3px">전문가 의견</div>
      <div style="font-size:11px;color:#e6edf3;line-height:1.6">${expert_insight ?? '—'}</div>
    </div>`;
}

let _aiLoading = false;

async function requestAIAnalysis(auto = false) {
  if (_aiLoading) return;
  _aiLoading = true;

  const btn      = document.getElementById('ai-analyze-btn');
  const result   = document.getElementById('ai-analysis-result');
  const wrap     = document.getElementById('ai-result-wrap');
  const scrollEl = document.getElementById('ai-result-scroll');
  if (!result) { _aiLoading = false; return; }

  if (!auto && btn) {
    btn.disabled    = true;
    btn.textContent = '분석 중…';
  }
  if (wrap) wrap.style.display = 'block';
  result.innerHTML = `
    <div style="text-align:center;padding:20px;color:#8b949e;font-size:12px">
      Gemini가 분석 중입니다…
    </div>`;

  try {
    const payload = buildAnalysisPayload({ ..._state, marketState: window._marketState });
    const res     = await fetch(`${RAILWAY_URL}/analyze`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.ok && typeof data.analysis === 'object') {
      renderAIResult(data.analysis);
      if (scrollEl) scrollEl.scrollTop = 0;
    } else {
      result.innerHTML = `<div style="color:#ef4444;font-size:12px;padding:8px">
        분석 실패: ${data.error ?? '알 수 없는 오류'}</div>`;
    }
  } catch (e) {
    result.innerHTML = `<div style="color:#ef4444;font-size:12px;padding:8px">
      오류: ${e.message}</div>`;
  } finally {
    _aiLoading = false;
    if (!auto && btn) {
      btn.disabled    = false;
      btn.textContent = '🤖 AI 분석';
    }
  }
}

function initNarrativePanel() {
  const container = document.getElementById('live-narrative-panel');
  if (!container) return;

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <span style="font-size:13px;font-weight:600;color:var(--text2,#8b949e)">실시간 판단</span>
      <button id="ai-analyze-btn" style="
        padding:4px 12px;font-size:11px;border-radius:4px;
        border:1px solid #a78bfa;background:rgba(167,139,250,.12);
        color:#a78bfa;cursor:pointer;white-space:nowrap;
      ">🤖 AI 분석</button>
    </div>
    <div id="live-narrative" style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px;font-size:14px;line-height:1.7"></div>
    <div id="ai-result-wrap" style="display:none">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:13px;font-weight:600;color:#a78bfa">🤖 AI 분석 결과</span>
        <div style="display:flex;gap:4px">
          <button id="ai-scroll-up" style="
            width:26px;height:20px;border-radius:3px;
            border:1px solid #30363d;background:transparent;
            color:#8b949e;cursor:pointer;font-size:11px;
            display:flex;align-items:center;justify-content:center;
          ">▲</button>
          <button id="ai-scroll-down" style="
            width:26px;height:20px;border-radius:3px;
            border:1px solid #30363d;background:transparent;
            color:#8b949e;cursor:pointer;font-size:11px;
            display:flex;align-items:center;justify-content:center;
          ">▼</button>
        </div>
      </div>
      <div id="ai-result-scroll" style="
        max-height:280px;overflow-y:scroll;
        overscroll-behavior:contain;
        border:1px solid #30363d;border-radius:6px;
        padding:12px;background:rgba(13,17,23,.6);
        font-size:13px;line-height:1.8;
      ">
        <div id="ai-analysis-result"></div>
      </div>
    </div>`;

  document.getElementById('ai-analyze-btn')?.addEventListener('click', () => {
    const wrap = document.getElementById('ai-result-wrap');
    if (wrap) wrap.style.display = 'block';
    requestAIAnalysis(false);
  });

  const scrollEl = document.getElementById('ai-result-scroll');
  document.getElementById('ai-scroll-up')?.addEventListener('click',   () => { if (scrollEl) scrollEl.scrollTop -= 80; });
  document.getElementById('ai-scroll-down')?.addEventListener('click', () => { if (scrollEl) scrollEl.scrollTop += 80; });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 장 상태 변화 처리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function handleMarketState({ marketState }) {
  if (marketState === 'REGULAR') {
    _state.vold = 0;
    _startRegularPolling();
  } else if (marketState === 'PRE' || marketState === 'AFTER') {
    _startExtendedPolling();
  } else {
    // CLOSED
    _stopAllPolling();
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// initLive / refreshLive
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function initLive() {

  initNarrativePanel();

  // VC 차트 초기화
  initVCChart('vc-chart-wrap');

  // KV 초기 로드 (GEX/Vanna/Charm/내러티브)
  fetchKV();

  // 장 상태에 따라 폴링 시작
  const ms = window._marketState;
  if (ms === 'REGULAR') {
    _startRegularPolling();
  } else if (ms === 'PRE' || ms === 'AFTER') {
    _startExtendedPolling();
  }
  // CLOSED → 폴링 없음

  window.addEventListener('clockPoll30m', () => {
    fetchKV();
    renderNarrative();
  });

  window.addEventListener('marketStateChanged', ({ detail }) =>
    handleMarketState(detail)
  );

  document.getElementById('oi-zoom-slider')?.addEventListener('input', (e) => {
    const zoom = parseFloat(e.target.value);
    document.getElementById('oi-zoom-val').textContent = zoom + '×';
    const scrollWrap = document.getElementById('live-chart-scroll');
    const chartWrap  = document.getElementById('live-chart-wrap');
    if (scrollWrap && chartWrap) {
      chartWrap.style.width = (scrollWrap.clientWidth * zoom) + 'px';
      if (_chartInst) _chartInst.resize();
    }
  });
}

export function refreshLive() {
  console.log('[Live] refresh');
  fetchKV();
}

function _calcPutWall(strikes, spot) {
  if (!strikes?.length || !spot) return null;
  const near = strikes.filter(s => Math.abs(s.strike - spot) / spot < 0.10);
  const map = {};
  for (const s of near) {
    if (!map[s.strike]) map[s.strike] = { strike: s.strike, putOI: 0 };
    map[s.strike].putOI += s.putOI ?? 0;
  }
  const s = Object.values(map).sort((a, b) => b.putOI - a.putOI)[0]?.strike;
  return s != null ? Number(s) : null;
}

function _calcCallWall(strikes, spot) {
  if (!strikes?.length || !spot) return null;
  const near = strikes.filter(s => Math.abs(s.strike - spot) / spot < 0.10);
  const map = {};
  for (const s of near) {
    if (!map[s.strike]) map[s.strike] = { strike: s.strike, callOI: 0 };
    map[s.strike].callOI += s.callOI ?? 0;
  }
  const s = Object.values(map).sort((a, b) => b.callOI - a.callOI)[0]?.strike;
  return s != null ? Number(s) : null;
}

function _calcFlipZone(strikes) {
  if (!strikes?.length) return null;
  const map = {};
  for (const s of strikes) {
    if (!map[s.strike]) map[s.strike] = { strike: s.strike, gex: 0 };
    map[s.strike].gex += s.gex ?? 0;
  }
  const sorted = Object.values(map).sort((a, b) => a.strike - b.strike);
  let cum = 0;
  for (const s of sorted) {
    const prev = cum;
    cum += s.gex;
    if ((prev < 0 && cum >= 0) || (prev > 0 && cum <= 0)) return Number(s.strike);
  }
  return null;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VIX 1분봉 폴링 (Yahoo Finance ^VIX)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let _vixPollTimer = null;
let _vixPrevCloseSet = false;

async function _fetchVixPoint() {
  try {
    const url = `${CF_API}/api/vix-tick`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const json = await res.json();

    // { prevClose: number, points: [{ ts: ISOstring, v: number }] }
    if (!_vixPrevCloseSet && json.prevClose != null) {
      setVixPrevClose(json.prevClose);
      _vixPrevCloseSet = true;
    }

    const points = json.points ?? [];
    if (!points.length) return;

    for (const pt of points) {
      pushVixPoint(pt.ts, pt.v);
    }

    // VIX 메트릭 카드: 최신 포인트로 업데이트
    const latest = points[points.length - 1];
    if (latest?.v != null) {
      _state.vix.price = latest.v;
      renderVIX();
    }

    // 내러티브 패널 (VIX 기반 조건 변화 시만)
    _renderNarrativeIfChanged();
  } catch (e) {
    console.warn('[Live] VIX 폴링 실패:', e.message);
  }
}

// VIX + VOLD 1분 통합 폴링
async function _fetchVixAndVold() {
  await Promise.all([
    _fetchVixPoint(),
    _fetchVold(),
  ]);
}

function _calcPCR(strikes) {
  if (!strikes?.length) return null;
  let totalCall = 0, totalPut = 0;
  for (const s of strikes) {
    totalCall += s.callOI ?? 0;
    totalPut  += s.putOI  ?? 0;
  }
  return totalCall > 0 ? totalPut / totalCall : null;
}
