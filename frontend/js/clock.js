// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// clock.js — ET/KST 시계 + 장 상태 스케줄러
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { fetchMarketStatus } from './api.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 전역변수 (타 모듈 읽기 전용)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// window._marketState  : 'PRE' | 'REGULAR' | 'AFTER' | 'CLOSED'
// window._etHour       : ET 소수 시간 (예: 9.5 = 09:30)
// window._todayISO     : ET 기준 날짜 'YYYY-MM-DD'
// window._kstStr       : 현재 KST 시각 문자열 (표시용)

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 장 상태 스타일
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const MARKET_STYLE = {
  PRE:     { label: '프리마켓',   dot: '#d29922', bg: 'rgba(210,153,34,.12)',  color: '#d29922' },
  REGULAR: { label: '정규장',     dot: '#3fb950', bg: 'rgba(63,185,80,.12)',   color: '#3fb950' },
  AFTER:   { label: '애프터마켓', dot: '#f0883e', bg: 'rgba(240,136,62,.12)',  color: '#f0883e' },
  CLOSED:  { label: '마감',       dot: '#6e7681', bg: 'rgba(110,118,129,.12)', color: '#6e7681' },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 내부 상태
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let _pollTimer   = null;
let _schedTimers = [];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 에러 모달
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function showErrorModal() {
  // 중복 방지
  if (document.getElementById('clock-error-modal')) return;

  const overlay = document.createElement('div');
  overlay.id = 'clock-error-modal';
  overlay.style.cssText = `
    position: fixed; inset: 0;
    background: rgba(0,0,0,.65);
    display: flex; align-items: center; justify-content: center;
    z-index: 9999;
  `;

  const box = document.createElement('div');
  box.style.cssText = `
    background: #1c1f26;
    border: 1px solid #ef4444;
    border-radius: 12px;
    padding: 32px 40px;
    max-width: 420px;
    width: 90%;
    text-align: center;
    box-shadow: 0 8px 32px rgba(0,0,0,.6);
  `;

  box.innerHTML = `
    <div style="font-size:2rem; margin-bottom:12px;">⚠️</div>
    <div style="
      font-size: 1.05rem;
      font-weight: 600;
      color: #ef4444;
      margin-bottom: 12px;
    ">시장 상태 조회 실패</div>
    <div style="
      font-size: 0.9rem;
      color: #9ca3af;
      line-height: 1.6;
      margin-bottom: 24px;
    ">
      Twelve Data 서버에 연결할 수 없습니다.<br>
      약 <strong style="color:#f59e0b">1시간 후</strong> 페이지를 새로고침하거나,<br>
      네트워크 상태를 확인한 후 다시 접속해 주세요.
    </div>
    <button id="clock-error-close" style="
      background: #ef4444;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 10px 28px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
    ">확인</button>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  document.getElementById('clock-error-close')
    .addEventListener('click', () => overlay.remove());
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ET 시각 분해 (ET 기준 한 번만)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function getETParts() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now);
  const get    = t => fmt.find(p => p.type === t)?.value ?? '0';
  const h      = +get('hour') === 24 ? 0 : +get('hour');
  const m      = +get('minute');
  const iso    = `${get('year')}-${get('month')}-${get('day')}`;
  return { h, m, etHour: h + m / 60, todayISO: iso, now };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 뱃지 업데이트
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function updateBadge(state) {
  const s     = MARKET_STYLE[state] ?? MARKET_STYLE.CLOSED;
  const badge = document.getElementById('market-state-badge');
  const dot   = document.getElementById('market-state-dot');
  const label = document.getElementById('market-state-label');
  if (badge) { badge.style.background = s.bg; badge.style.color = s.color; }
  if (dot)   { dot.style.background = s.dot; }
  if (label) { label.textContent = s.label; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 장 상태 적용 + 이벤트 발행
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function applyState(newState) {
  if (newState === window._marketState) return;
  const prevState     = window._marketState;
  window._marketState = newState;
  updateBadge(newState);
  console.log('[Clock] 장 상태:', prevState ?? '(init)', '→', newState);
  window.dispatchEvent(new CustomEvent('marketStateChanged', {
    detail: { marketState: newState, prevState },
  }));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 시계 tick (1초)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function tick() {
  const { etHour, todayISO, now } = getETParts();

  window._etHour   = etHour;
  window._todayISO = todayISO;

  const kst = now.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Asia/Seoul',
  });
  const et = now.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'America/New_York',
  });
  window._kstStr = kst;

  const kstEl = document.getElementById('clock-kst');
  const etEl  = document.getElementById('clock-et');
  if (kstEl) kstEl.textContent = kst + ' KST';
  if (etEl)  etEl.textContent  = et  + ' ET';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 장 전환 타이머 예약 (ET 시각 기준)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function scheduleTransitions(etHour) {
  _schedTimers.forEach(clearTimeout);
  _schedTimers = [];

  const transitions = [
    { targetHour:  4.0, state: 'PRE'     },  // 04:00 ET
    { targetHour:  9.5, state: 'REGULAR' },  // 09:30 ET
    { targetHour: 16.0, state: 'AFTER'   },  // 16:00 ET
    { targetHour: 20.0, state: 'CLOSED'  },  // 20:00 ET
  ];

  transitions.forEach(({ targetHour, state }) => {
    const diffSec = (targetHour - etHour) * 3600;
    if (diffSec <= 0) return;

    const t = setTimeout(() => {
      console.log(`[Clock] 예약 전환 → ${state} (ET ${targetHour}시)`);
      applyState(state);
      if (state === 'CLOSED') {
        setTimeout(() => initSchedule(), 1000); // 다음날 재초기화
      }
    }, diffSec * 1000);

    _schedTimers.push(t);
    console.log(`[Clock] 예약: ${state} @ ET ${targetHour}시 (${Math.round(diffSec / 60)}분 후)`);
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CLOSED 구간 안전망 폴링 (1시간)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function startClosedPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(() => {
    const { etHour } = getETParts();
    if (etHour >= 4.0) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  }, 60 * 60 * 1000);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 초기화: Twelve Data 조회 → 검증 → 스케줄 예약
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function initSchedule() {
  const { etHour } = getETParts();
  const status = await fetchMarketStatus();

  if (status) {
    const { isOpen, timeToOpenSec, timeAfterOpenSec } = status;

    // 검증: time_to_open → 역산한 ET 예상값과 시계 대조
    if (!isOpen && timeToOpenSec > 0) {
      const expectedEtHour     = 9.5 - timeToOpenSec / 3600;
      const normalizedExpected = ((expectedEtHour % 24) + 24) % 24;
      const diffMin            = Math.min(
        Math.abs(normalizedExpected - etHour),
        24 - Math.abs(normalizedExpected - etHour)
      ) * 60;

      if (diffMin > 2) {
        console.warn(`[Clock] 시각 오차 ${diffMin.toFixed(1)}분 — 시계 기준으로 진행`);
      } else {
        console.log(`[Clock] 시각 검증 통과 (오차 ${diffMin.toFixed(1)}분)`);
      }
    }

    // 현재 장 상태 즉시 반영
    if (isOpen) {
      applyState('REGULAR');
    } else if (timeAfterOpenSec > 0) {
      applyState('AFTER');
    } else if (etHour >= 4.0 && etHour < 9.5) {
      applyState('PRE');
    } else {
      applyState('CLOSED');
    }

  } else {
    // ── 5회 모두 실패 ──
    // ET 시각 기준 fallback으로 상태 추정 (페이지는 최대한 동작)
    if      (etHour >= 4.0  && etHour < 9.5)  applyState('PRE');
    else if (etHour >= 9.5  && etHour < 16.0) applyState('REGULAR');
    else if (etHour >= 16.0 && etHour < 20.0) applyState('AFTER');
    else                                        applyState('CLOSED');

    // 사용자에게 모달로 알림
    showErrorModal();
  }

  // 이후 전환은 시계 기준으로 예약
  scheduleTransitions(etHour);

  // CLOSED 구간이면 안전망 폴링 시작
  if (window._marketState === 'CLOSED') {
    startClosedPolling();
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 장중 30분 폴링 이벤트 (PRE 진입 시 시작)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
window.addEventListener('marketStateChanged', ({ detail }) => {
  const { marketState, prevState } = detail;
  if (marketState === 'PRE' && prevState === 'CLOSED') {
    console.log('[Clock] 장중 30분 폴링 시작');
    setInterval(() => {
      window.dispatchEvent(new CustomEvent('clockPoll30m'));
    }, 30 * 60 * 1000);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// startClock — 진입점
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function startClock() {
  tick();
  setInterval(tick, 1000);
  initSchedule();
}

export function getMarketState() { return window._marketState; }
