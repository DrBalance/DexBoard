// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// live.js — Tab1: DEX Live
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { CF_API, TWELVE_KEY, RAILWAY_URL }                    from '../config.js';
import { registerTickCallback }                               from '../clock.js';
import {
  fmtPrice, fmtChange, fmtChangePct,
  fmtM, fmtVold,
  colorBySign, colorVix, COLOR,
} from '../fmt.js';
import { renderHeatmap, updateHeatmapSpot }           from '../heatmap.js';
import { buildNarrative, buildAnalysisPayload }       from '../narrative.js';
import { renderOIChart, updateOIChart, renderStrikeTable, renderTop5Panel } from '../oi-chart.js';
import { initVCChart, setVixSeries, setVoldSeries } from '../vc-chart.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 내부 상태
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const _state = {
  spy:     { price: null, change: null, changePct: null },
  vix:     { price: null, change: null, changePct: null },
  dex:     null,
  gex:     null,
  vanna:   null,
  charm:   null,
  strikes: [],
  spot:    null,   // 0dte KV의 spot (폴백)

  // SPY 폴링 상태
  spyLive:         null,   // 최신 SPY 현재가

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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


let _tradingDate = null;  // 오늘 거래일 날짜 캐시

async function _getTradingDate() {
  if (_tradingDate) return _tradingDate;
  try {
    const res = await fetch(`${CF_API}/api/trading-date`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.date) {
      _tradingDate = data.date;
      return _tradingDate;
    }
  } catch (e) {
    console.warn('[Live] trading-date 조회 실패:', e.message);
  }
  // 폴백: ET 오늘 날짜 직접 계산
  _tradingDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return _tradingDate;
}

async function _triggerCalculate() {
  try {
    console.log('[Live] 옵션 데이터 없음 → Railway calculate 트리거');
    const res = await fetch(`${CF_API}/api/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json();
    if (data.ok) {
      console.log('[Live] calculate 완료 → KV 재조회', data.date);
      await fetchKV({ fullUpdate: true });
    } else {
      console.warn('[Live] calculate 실패:', data.error);
    }
  } catch (e) {
    console.warn('[Live] Railway calculate 트리거 실패:', e.message);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// KV 통합 fetch
//   - SPY/VIX 메트릭 카드 + VIX 차트 (매 폴링 주기)
//   - DEX/그릭스/OI (15분 주기, 정규장)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let _lastKvTs = 0;

async function fetchKV({ fullUpdate = true } = {}) {
  try {
    const requests = [fetch(`${CF_API}/api/snapshot`)];
    if (fullUpdate) {
      requests.push(
        fetch(`${CF_API}/api/dex/spy`),
        fetch(`${CF_API}/api/oi/open`),
      );
    }
    const [snapRes, dexRes, oiOpenRes] = await Promise.all(requests);

    // ── snapshot: SPY/VIX ────────────────────────────────
    if (snapRes.ok) {
      const snap = await snapRes.json();
      if (!snap.error) {
        const snapTs = snap.ts ? new Date(snap.ts).getTime() : 0;
        if (snapTs > _lastKvTs) {
          _lastKvTs = snapTs;

          // VIX: 메트릭 카드 + 차트
          if (snap.vix?.price) {
            _state.vix = snap.vix;
            renderVIX();
            if (snap.vix.series?.length) {
              setVixSeries(snap.vix.series, snap.vix.prevClose ?? null);
            }
          }

          // SPY: 메트릭 카드 업데이트
          if (snap.spy?.price) {
            _updateSpy({ ...snap.spy, source: 'kv', ts: snap.ts });
          }
        }
      }
    }

    if (!fullUpdate) return;

    // ── DEX/그릭스 ───────────────────────────────────────
    if (dexRes?.ok) {
      const dex = await dexRes.json();
      if (dex.error) {
        // 데이터 없음 → Railway 트리거 (비동기, 응답 안 기다림)
        _triggerCalculate();
      } else {
        // expirations에서 오늘 날짜(0DTE) strikes 추출
        const expirations = dex.expirations ?? {};

        // 가장 가까운 만기일(0DTE) strikes 우선, 없으면 전체 합산
        const sortedExpiries = Object.keys(expirations).sort();
        const nearestExpiry  = sortedExpiries[0] ?? null;
        const todayStrikes   = nearestExpiry ? expirations[nearestExpiry] : [];
        const allStrikes     = Object.values(expirations).flat();

        _state.strikes = todayStrikes.length > 0 ? todayStrikes : allStrikes;

        // 합산 그릭스
        const sum = (arr, field) => arr.reduce((a, b) => a + (b[field] || 0), 0);
        _state.dex   = sum(_state.strikes, 'dex');
        _state.gex   = sum(_state.strikes, 'gex');
        _state.vanna = sum(_state.strikes, 'vanna');
        _state.charm = sum(_state.strikes, 'charm');

        _state.putWall  = _calcPutWall(_state.strikes, _state.spot);
        _state.callWall = _calcCallWall(_state.strikes, _state.spot);
        _state.flipZone = _calcFlipZone(_state.strikes);
        _state.pcr      = _calcPCR(_state.strikes);
      }
    }

    // ── OI open ──────────────────────────────────────────
    if (oiOpenRes?.ok) {
      const oiOpen = await oiOpenRes.json();
      if (!oiOpen.error && oiOpen.oiMap) {
        _state.oiOpen = oiOpen;
      }
    }
  } catch (e) {
    console.warn('[Live] KV fetch 실패:', e.message);
  }

  renderCards();

  if (!fullUpdate) return;

  // 옵션체인 갱신: 히트맵 전체 재렌더
  const spotForHeatmap = _state.spyLive ?? _state.spy.price ?? _state.spot;
  if (_state.strikes.length > 0 && spotForHeatmap) {
    renderHeatmap('heatmap-canvas', _state.strikes, spotForHeatmap);
  }

  _onSpotUpdated();

  if (_state.strikes.length > 0) {
    renderTop5Panel('top5-panel', _state.strikes, 'delta15m');
  }

  renderNarrative();
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

  // 히트맵 — 가격 갱신 시에는 spot 강조만 업데이트 (DOM 교체 없음)
  // 옵션체인 갱신(15분) 시에는 fetchKV()에서 renderHeatmap() 호출
  updateHeatmapSpot('heatmap-canvas', spotPrice);

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
function _updateSpy(data) {
  _state.spyLive           = data.price;
  _state.spy.price         = data.price;
  _state.spy.change        = data.change    ?? _state.spy.change;
  _state.spy.changePct     = data.changePct ?? _state.spy.changePct;
  _onSpotUpdated();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VOLD — Twelve Data OBV (RSP, 1min, 정규장 1분 폴링)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function _fetchVold() {
  try {
    if (!TWELVE_KEY) return;
    const url =
      `https://api.twelvedata.com/time_series?symbol=RSP&interval=1min` +
      `&outputsize=390&apikey=${TWELVE_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return;
    const data = await res.json();
    if (data.status === 'error' || !Array.isArray(data.values)) return;

    const values = data.values; // 최신이 앞
    if (!values.length) return;

    // ── 1분봉 캔들로 OBV 직접 계산 (0에서 시작) ─────────
    // 오래된 것부터 순서대로 처리 (values는 최신이 앞)
    // prev를 values[i+1]로 참조하면 더 오래된 봉을 가리키는 오류가 있어
    // 직전 처리봉의 close를 별도 변수로 추적하는 방식으로 변경
    let obv = 0;
    let prevClose = null;
    const series = [];

    for (let i = values.length - 1; i >= 0; i--) {
      const vol   = parseFloat(values[i].volume) || 0;
      const close = parseFloat(values[i].close);

      if (prevClose === null)      obv += vol;  // 첫 봉
      else if (close > prevClose)  obv += vol;  // 상승봉
      else if (close < prevClose)  obv -= vol;  // 하락봉
      // 보합이면 변화 없음

      prevClose = close;
      series.push({ ts: values[i].datetime, v: obv });
    }

    // ── 차트: 시리즈 전체 교체 (렌더 1회) ───────────────
    setVoldSeries(series);

    // ── 최종 누적값 → 메트릭 카드 ───────────────────────
    _state.vold = obv;
    renderVOLD();

  } catch (e) {
    console.warn('[Live] VOLD 폴링 실패:', e.message);
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 장 상태 변경 시 차트 표시/숨김 처리
// (폴링은 clock.js tick()이 담당 — setInterval 없음)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _onMarketStateChanged(marketState) {
  // CLOSED 포함 항상 표시 — 초기화 타이밍 문제로 숨김 처리 제거
  const vcWrap = document.getElementById('vc-chart-wrap');
  if (vcWrap) vcWrap.style.display = '';
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

function renderDEX() {
  const v     = _state.dex;
  const color = colorBySign(v);
  setEl('m-dex0',     fmtM(v),        color);
  setEl('m-dex0-sub', 'dealer delta', COLOR.muted);
}

function renderVOLD() {
  const color = colorBySign(_state.vold);
  setEl('m-vold',     fmtVold(_state.vold), color);
  setEl('m-vold-sub', 'RSP breadth',        COLOR.muted);
}

function renderCards() {
  renderSPY();
  renderVIX();
  renderVOLD();
  renderDEX();
  renderGEX();
  renderVanna();
  renderCharm();
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

// AI 분석 결과 렌더 + 안내문구
function _renderAIWithNotice(analysis, noticeMsg = null, noticeColor = '#8b949e') {
  const result   = document.getElementById('ai-analysis-result');
  const scrollEl = document.getElementById('ai-result-scroll');
  if (!result) return;

  const noticeHTML = noticeMsg ? `
    <div style="
      font-size:11px;padding:6px 10px;margin-bottom:8px;border-radius:4px;
      background:rgba(139,148,158,.1);border-left:3px solid ${noticeColor};
      color:${noticeColor};
    ">${noticeMsg}</div>` : '';

  renderAIResult(analysis);

  // 안내문구를 결과 위에 삽입
  if (noticeMsg) {
    result.insertAdjacentHTML('afterbegin', noticeHTML);
  }
  if (scrollEl) scrollEl.scrollTop = 0;
}

// N분 전 포맷
function _minutesAgo(ts) {
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60_000);
  if (mins < 1)  return '방금 전';
  if (mins < 60) return `${mins}분 전`;
  return `${Math.floor(mins / 60)}시간 ${mins % 60}분 전`;
}

async function requestAIAnalysis(auto = false) {
  if (_aiLoading) return;
  _aiLoading = true;

  const btn      = document.getElementById('ai-analyze-btn');
  const result   = document.getElementById('ai-analysis-result');
  const wrap     = document.getElementById('ai-result-wrap');
  const scrollEl = document.getElementById('ai-result-scroll');
  if (!result) { _aiLoading = false; return; }

  if (wrap) wrap.style.display = 'block';

  // ── 1. KV 캐시 확인 ──────────────────────────────────────────
  let cached = null;
  try {
    const cacheRes = await fetch(`${CF_API}/api/ai-analysis`, {
      signal: AbortSignal.timeout(5000),
    });
    if (cacheRes.ok) {
      const cacheData = await cacheRes.json();
      if (!cacheData.error && cacheData.analysis && cacheData.ts) {
        cached = cacheData;
      }
    }
  } catch (_) {}

  const cacheAgeMs  = cached ? Date.now() - new Date(cached.ts).getTime() : Infinity;
  const cacheValid  = cacheAgeMs < 15 * 60_000;  // 15분 이내

  // 수동 버튼 클릭 시 캐시가 15분 이내면 캐시 결과 표시 후 종료
  if (!auto && cacheValid) {
    _renderAIWithNotice(
      cached.analysis,
      `📋 ${_minutesAgo(cached.ts)} 분석 결과입니다 (자동갱신 15분)`,
      '#8b949e'
    );
    _aiLoading = false;
    return;
  }

  // 자동 분석이고 캐시가 유효하면 조용히 캐시 렌더 후 종료
  if (auto && cacheValid) {
    _renderAIWithNotice(cached.analysis);
    _aiLoading = false;
    return;
  }

  // ── 2. Railway 호출 (캐시 없거나 만료) ──────────────────────
  if (!auto && btn) {
    btn.disabled    = true;
    btn.textContent = '분석 중…';
  }
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
      signal:  AbortSignal.timeout(35_000),
    });
    const data = await res.json();

    if (data.ok && typeof data.analysis === 'object') {
      // 성공 — 안내문구 없이 렌더
      _renderAIWithNotice(data.analysis);
    } else {
      // Railway 응답은 왔지만 분석 실패
      throw new Error(data.error ?? '알 수 없는 오류');
    }
  } catch (e) {
    // ── 3. 에러 시 캐시 폴백 ──────────────────────────────────
    const is429 = e.message?.includes('429') || e.message?.includes('한도');
    const isTimeout = e.name === 'TimeoutError' || e.message?.includes('timeout');

    if (cached?.analysis) {
      const noticeColor = is429 ? '#f59e0b' : '#ef4444';
      let noticeMsg = '';
      if (is429) {
        noticeMsg = `⚠️ API 한도 초과 — ${_minutesAgo(cached.ts)} 결과를 표시합니다`;
      } else if (isTimeout) {
        noticeMsg = `⚠️ 응답 시간 초과 — ${_minutesAgo(cached.ts)} 결과를 표시합니다`;
      } else {
        noticeMsg = `⚠️ 분석 오류 — ${_minutesAgo(cached.ts)} 결과를 표시합니다`;
      }
      _renderAIWithNotice(cached.analysis, noticeMsg, noticeColor);
    } else {
      // 캐시도 없음
      result.innerHTML = `
        <div style="color:#ef4444;font-size:12px;padding:8px">
          ⚠️ 분석 결과를 불러올 수 없습니다<br>
          <span style="color:#8b949e;font-size:11px">${e.message}</span>
        </div>`;
    }
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
// initLive / refreshLive
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function initLive() {

  initNarrativePanel();

  // VC 차트 초기화
  initVCChart('vc-chart-wrap');

  // 장 상태에 따라 차트 표시/숨김
  _onMarketStateChanged(window._marketState ?? 'CLOSED');

  // 초기 데이터 즉시 로드 (fullUpdate=true → DEX 포함)
  await fetchKV();
  if (window._marketState === 'REGULAR') {
    _state.vold = 0;
    _fetchVold();
  }

  window.addEventListener('marketStateChanged', ({ detail }) => {
    _onMarketStateChanged(detail.marketState);
    // 장 상태 전환 시 즉시 1회 갱신
    fetchKV();
    if (detail.marketState === 'REGULAR') {
      _state.vold = 0;
      _fetchVold();
    }
  });

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

  // tick 콜백 등록 — initLive() 완료 후에 등록하므로 초기화 순서 보장
  registerTickCallback(onLiveTick);
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


function _calcPCR(strikes) {
  if (!strikes?.length) return null;
  let totalCall = 0, totalPut = 0;
  for (const s of strikes) {
    totalCall += s.callOI ?? 0;
    totalPut  += s.putOI  ?? 0;
  }
  return totalCall > 0 ? totalPut / totalCall : null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// onLiveTick — clock.js tick()에서 매초 호출 (registerTickCallback으로 등록)
// 헤더 시계 기준으로 갱신 타이밍 결정 (setInterval 없음)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function onLiveTick({ h, m, s }) {
  const state = window._marketState;

  if (state === 'REGULAR') {
    if (s === 5) {
      if (m % 15 === 2) {
        // ── 15분: 옵션 데이터 풀업데이트 (CBOE :00 → Railway :01 → 프론트 :02:05)
        fetchKV({ fullUpdate: true });
      } else {
        // ── 1분: SPY+VIX 메트릭 카드 갱신 (snapshot만)
        fetchKV({ fullUpdate: false });
      }

      // ── 1분: VOLD + VIX 차트 (매 :05초, 풀업데이트와 무관하게 실행)
      _fetchVold();

      // ── 30분: AI 분석
      if (m % 30 === 2) {
        requestAIAnalysis(true);
      }
    }

    if (s === 35) {
      // ── 30초: SPY+VIX 메트릭 카드 갱신 (snapshot만)
      fetchKV({ fullUpdate: false });
    }
  }

  if (state === 'PRE' || state === 'AFTER') {
    // ── 3분: SPY+VIX 메트릭 카드 + VIX 차트 갱신
    if (s === 5 && m % 3 === 0) {
      fetchKV({ fullUpdate: false });
    }
  }

  // CLOSED: 갱신 없음
}
