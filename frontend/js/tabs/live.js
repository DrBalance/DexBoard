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
import { renderHeatmap, updateHeatmapSpot, setHeatmapVix } from '../heatmap.js';

import { renderOIChart, updateOIChart, renderStrikeTable, renderTop5Panel } from '../oi-chart.js';
import { initVCChart, setVixSeries, setVoldSeries } from '../vc-chart.js';
import { renderVannaDistChart } from '../options-charts.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 내부 상태
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const _state = {
  spy:     { price: null, change: null, changePct: null },
  qqq:     { price: null, change: null, changePct: null },
  iwm:     { price: null, change: null, changePct: null },
  vix:     { price: null, change: null, changePct: null },
  dex:     null,
  gex:     null,
  vanna:   null,
  charm:   null,
  strikes: [],   // dex:spy:0dte 의 strikes 배열 (oi15m/oiOpen 포함)
  spot:    null,

  spyLive: null,
  vold:    null,

  putWall:  null,
  callWall: null,
  flipZone: null,
  pcr:      null,
  maxPain:     null,
  totalCallOI: null,
  totalPutOI:  null,
};

// OI 차트 인스턴스 (탭 재방문 시 재생성 방지)
let _chartInst      = null;
let _vannaDistInst  = null;
let _vixDir         = 'neutral'; // 'up' | 'down' | 'neutral'

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _tradingDate = null;

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
//   fullUpdate=true  → snapshot + dex:spy:0dte (15분 주기)
//   fullUpdate=false → snapshot만 (1분/30초 주기)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fetchKV({ fullUpdate = true } = {}) {
  try {
    const requests = [
      fetch(`${CF_API}/api/snapshot`),
      fetch(`${CF_API}/api/timeseries`),
    ];
    if (fullUpdate) {
      requests.push(fetch(`${CF_API}/api/dex/0dte`));
    }
    const [snapRes, tsRes, dex0dteRes] = await Promise.all(requests);

    // ── snapshot: SPY / QQQ / IWM / VIX / VOLD ──────────────
    if (snapRes.ok) {
      const snap = await snapRes.json();
      if (!snap.error) {
        if (snap.vix?.price) {
          _state.vix = snap.vix;
          renderVIX();
        }

        if (snap.spy?.price) {
          _updateSpy({ ...snap.spy, source: 'kv', ts: snap.ts });
        }

        // QQQ / IWM — 값만 저장 (표시는 추후)
        if (snap.qqq?.price) _state.qqq = snap.qqq;
        if (snap.iwm?.price) _state.iwm = snap.iwm;

        // VOLD — 웹훅으로 수신한 실제값 반영
        if (snap.vold != null && !isNaN(snap.vold)) {
          _state.vold = snap.vold;
          renderVOLD();
        }
      }
    }

    // ── 시계열 링버퍼 → VIX / VOLD 차트 ────────────────────
    if (tsRes?.ok) {
      const tsData = await tsRes.json();
      const series = tsData.series ?? [];
      if (series.length > 0) {
        // 마지막 포인트 → 메트릭 카드도 동기화 (snapshot보다 최신일 수 있음)
        const last = series[series.length - 1];
        if (last.spy) _updateSpy({ price: last.spy, change: _state.spy.change, changePct: _state.spy.changePct, source: 'ts', ts: last.ts });
        if (last.vix) { _state.vix = { ..._state.vix, price: last.vix }; renderVIX(); }
        if (last.vold != null) { _state.vold = last.vold; renderVOLD(); }

        // VIX 시리즈
        const vixSeries = series
          .filter(d => d.vix != null)
          .map(d => ({ ts: d.ts, v: d.vix }));
        if (vixSeries.length > 0) {
          const prevClose = _state.vix?.prevClose ?? null;
          setVixSeries(vixSeries, prevClose);
          setHeatmapVix(vixSeries);
        }
        // VOLD 시리즈
        const voldSeries = series
          .filter(d => d.vold != null)
          .map(d => ({ ts: d.ts, v: d.vold }));
        if (voldSeries.length > 0) {
          setVoldSeries(voldSeries, false);
        }
      }
    }

    if (!fullUpdate) return;

    // ── dex:spy:0dte ─────────────────────────────────────
    // strikes 배열에 callOI, putOI, oi15m, oiOpen, greeks 모두 포함
    if (dex0dteRes?.ok) {
      const dex0dte = await dex0dteRes.json();

      if (dex0dte.error) {
        // 데이터 없음 → Railway 트리거 (비동기)
        _triggerCalculate();
      } else {
        const strikes = dex0dte.strikes ?? [];
        _state.strikes = strikes;

        // 합산 그릭스
        const sum = (field) => strikes.reduce((a, s) => a + (s[field] || 0), 0);
        _state.dex   = sum('dex');
        _state.gex   = sum('gex');
        _state.vanna = sum('vanna');
        _state.charm = sum('charm');

        const spot = _state.spyLive ?? _state.spy.price ?? _state.spot;
        _state.putWall  = _calcPutWall(strikes, spot);
        _state.callWall = _calcCallWall(strikes, spot);
        _state.flipZone = _calcFlipZone(strikes);
        _state.pcr      = _calcPCR(strikes);
        _state.maxPain  = _calcMaxPain(strikes);

        // PCR 계산 시 계약수도 함께 저장
        let totalCall = 0, totalPut = 0;
        for (const s of strikes) {
          totalCall += s.callOI ?? 0;
          totalPut  += s.putOI  ?? 0;
        }
        _state.totalCallOI = totalCall;
        _state.totalPutOI  = totalPut;
      }
    }

  } catch (e) {
    console.warn('[Live] KV fetch 실패:', e.message);
  }

  renderCards();

  if (!fullUpdate) return;

  // 옵션체인 갱신
  const spotForHeatmap = _state.spyLive ?? _state.spy.price ?? _state.spot;
  if (_state.strikes.length > 0 && spotForHeatmap) {
    renderHeatmap('heatmap-canvas', _state.strikes, spotForHeatmap);
  }

  _onSpotUpdated();

  // Top5 급등 OI 패널
  // strikes에 oi15m/oiOpen 필드가 직접 내장되어 있으므로 추가 계산 불필요
  if (_state.strikes.length > 0) {
    renderTop5Panel('top5-panel', _state.strikes);
  }

}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// onSpotUpdated — SPY 현재가 변경 시 화면 일괄 업데이트
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _onSpotUpdated() {
  const spotPrice = _state.spyLive ?? _state.spy.price ?? _state.spot;
  if (!spotPrice) return;

  renderSPY();

  if (_state.strikes.length > 0) {
    _state.putWall  = _calcPutWall(_state.strikes, spotPrice);
    _state.callWall = _calcCallWall(_state.strikes, spotPrice);
    renderPutWall();
    renderCallWall();
  }

  updateHeatmapSpot('heatmap-canvas', spotPrice);

  if (_state.strikes.length > 0) {
    if (!_chartInst) {
      _chartInst = renderOIChart('live-chart-wrap', _state.strikes, spotPrice, { mode: '0dte' });
    } else {
      updateOIChart(_chartInst, _state.strikes, spotPrice);
    }
    _renderVannaDist();
  }

  if (_state.strikes.length > 0) {
    const countEl = document.getElementById('strike-count');
    if (countEl) countEl.textContent = `${_state.strikes.length}건`;
    renderStrikeTable('strike-tbody', _state.strikes, {
      mode:      '0dte',
      spotPrice,
      flipZone:  _state.flipZone  ?? null,
      putWall:   _state.putWall   ?? null,
      callWall:  _state.callWall  ?? null,
      // openOI: 불필요 — strikes에 callOiOpen/putOiOpen 직접 내장
      isRegular: window._marketState === 'REGULAR',
    });
  }

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
// VOLD — TradingView 웹훅으로 수신 (snapshot KV 경유)
// fetchKV() → snap.vold → _state.vold → renderVOLD()
// Twelve Data OBV 폴링 제거됨
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 장 상태 변경 시 차트 표시/숨김 처리
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

  // 계약수 sub: C 12.3k / P 15.1k
  const c = _state.totalCallOI;
  const p = _state.totalPutOI;
  if (c != null && p != null) {
    const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    setEl('m-pcr-sub', `C ${fmt(c)} / P ${fmt(p)}`, COLOR.muted);
  } else {
    setEl('m-pcr-sub', 'put/call ratio', COLOR.muted);
  }
}

function renderMaxPain() {
  const v    = _state.maxPain;
  const spot = _state.spyLive ?? _state.spy.price ?? null;
  let color  = COLOR.amber ?? 'var(--amber)';

  // spot 대비 방향으로 색상 구분
  if (v != null && spot != null) {
    const diff = v - spot;
    if (diff > 0.5)       color = COLOR.green ?? 'var(--green)';  // 위쪽 → 가격 끌어올림 압력
    else if (diff < -0.5) color = COLOR.red   ?? 'var(--red)';    // 아래쪽 → 가격 눌림 압력
  }

  setEl('m-max-pain', v != null ? `$${v.toFixed(0)}` : '—', color);

  // sub: spot 대비 거리 표시
  if (v != null && spot != null) {
    const diff = (v - spot).toFixed(1);
    const sign = diff > 0 ? '+' : '';
    setEl('m-max-pain-sub', `spot 대비 ${sign}${diff}`, COLOR.muted);
  } else {
    setEl('m-max-pain-sub', 'max pain', COLOR.muted);
  }
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
  setEl('m-vold-sub', 'NYSE VOLD',      COLOR.muted);
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
  renderMaxPain();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 판단 패널
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Vanna Distribution Chart
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _renderVannaDist() {
  const el = document.getElementById('lv-vanna-dist');
  if (!el) return;

  const strikes  = _state.strikes;
  const spot     = _state.spyLive ?? _state.spy?.price;
  if (!strikes?.length || !spot) return;

  // 타임스탬프 표시
  const tsEl = document.getElementById('vd-ts');
  if (tsEl) tsEl.textContent = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

  if (_vannaDistInst) {
    // zoom 유지한 채 데이터만 갱신
    _vannaDistInst.update(strikes, spot, { vixDir: _vixDir });
  } else {
    // 최초 생성
    _vannaDistInst = renderVannaDistChart(el, strikes, spot, {
      mode:   'single',
      vixDir: _vixDir,
      dte:    1,
      label:  '0DTE 확률 분포 · Vanna Flip',
    });
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// initLive / refreshLive
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export async function initLive() {

  initVCChart('vc-chart-wrap');

  _onMarketStateChanged(window._marketState ?? 'CLOSED');

  // prevClose KV 확인 → 없으면 Railway에 즉시 조회 트리거
  try {
    const pcRes = await fetch(`${CF_API}/api/prevclose`);
    if (pcRes.ok) {
      const pc = await pcRes.json();
      if (pc.error) {
        // KV에 없음 → Railway에 prevClose 조회 요청
        console.log('[Live] prevClose 없음 → Railway 트리거');
        fetch(`${RAILWAY_URL}/trigger-prevclose`, { method: 'POST' }).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('[Live] prevClose 확인 실패:', e.message);
  }

  await fetchKV();

  window.addEventListener('marketStateChanged', ({ detail }) => {
    _onMarketStateChanged(detail.marketState);
    fetchKV();
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

  registerTickCallback(onLiveTick);

}

export function refreshLive() {
  console.log('[Live] refresh');
  fetchKV();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 계산 헬퍼
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
// Max Pain 계산
//   각 스트라이크를 만기 가격으로 가정했을 때,
//   전체 옵션 보유자(매수자)가 받는 총 페이오프가 최소인 스트라이크
//   = 딜러(매도자) 입장 손실 최소 → 시장 중력점
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function _calcMaxPain(strikes) {
  if (!strikes?.length) return null;

  // 스트라이크별 집계 (동일 스트라이크 행이 여러 개일 경우 합산)
  const map = {};
  for (const s of strikes) {
    const k = Number(s.strike);
    if (!map[k]) map[k] = { callOI: 0, putOI: 0 };
    map[k].callOI += s.callOI ?? 0;
    map[k].putOI  += s.putOI  ?? 0;
  }

  const ks = Object.keys(map).map(Number).sort((a, b) => a - b);
  if (!ks.length) return null;

  let minPain = Infinity;
  let maxPainStrike = null;

  for (const expiry of ks) {
    let totalPain = 0;
    for (const k of ks) {
      // call 보유자 페이오프: max(expiry - k, 0) × callOI
      if (expiry > k) totalPain += (expiry - k) * map[k].callOI;
      // put 보유자 페이오프: max(k - expiry, 0) × putOI
      if (expiry < k) totalPain += (k - expiry) * map[k].putOI;
    }
    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = expiry;
    }
  }

  return maxPainStrike;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// onLiveTick — clock.js tick()에서 매초 호출
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function onLiveTick({ h, m, s }) {
  const state = window._marketState;

  if (state === 'REGULAR') {
    if (s === 5 || s === 20 || s === 35 || s === 50) {
      if (m % 15 === 2 && s === 5) {
        // 15분: 옵션 데이터 풀업데이트 (CBOE :00 → Railway :01 → 프론트 :02:05)
        fetchKV({ fullUpdate: true });
      } else {
        // 15초: SPY+VIX+VOLD 메트릭 카드 갱신
        fetchKV({ fullUpdate: false });
      }

    }
  }

  if (state === 'PRE' || state === 'AFTER') {
    if (s === 5 || s === 20 || s === 35 || s === 50) {
      // 15초: SPY+VIX 메트릭 카드 + vc차트 갱신
      fetchKV({ fullUpdate: false });
    }
  }

  // CLOSED: 갱신 없음
}
