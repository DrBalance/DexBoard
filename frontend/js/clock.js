import { MARKET_STYLE, INTERVAL_MARKET_STATE } from './config.js';
import { fetchMarketState } from './api.js';

// ── Internal state ────────────────────────────────
let _marketState = undefined;   // PRE | REGULAR | AFTER | CLOSED

// ── Market state badge update ─────────────────────
function updateBadge(stateKey) {
  const s     = MARKET_STYLE[stateKey] || MARKET_STYLE.CLOSED;
  const badge = document.getElementById('market-badge');
  const dot   = document.getElementById('market-dot');
  const label = document.getElementById('market-label');

  if (badge) { badge.style.background = s.bg; badge.style.color = s.color; }
  if (dot)   {
    dot.style.background = s.dot;
    dot.className = 'market-dot' + (stateKey !== 'CLOSED' ? ' live' : '');
  }
  if (label) label.textContent = s.label;
}

// ── Clock tick (1초) ──────────────────────────────
function tick() {
  const now = new Date();

  // KST
  const kst = now.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Asia/Seoul',
  });

  // ET
  const et = now.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'America/New_York',
  });

  const kstEl = document.getElementById('clock-kst');
  const etEl  = document.getElementById('clock-et');
  if (kstEl) kstEl.textContent = kst + ' KST';
  if (etEl)  etEl.textContent  = et  + ' ET';
}

// ── Market state check (Twelve Data) ─────────────
async function checkMarketState() {
  const data = await fetchMarketState();
  if (!data) return;

  // Twelve Data: is_market_open + time_to_close 로 상태 판단
  // PRE/AFTER 구분은 ET 시각 기반
  const now = new Date();
  const etParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(now);
  const h = +etParts.find(p => p.type === 'hour').value
          + +etParts.find(p => p.type === 'minute').value / 60;

  let newState = 'CLOSED';
  if (data.is_market_open) {
    newState = 'REGULAR';
  } else if (h >= 4 && h < 9.5) {
    newState = 'PRE';
  } else if (h >= 16 && h < 20) {
    newState = 'AFTER';
  }

  if (newState !== _marketState) {
    const prevState  = _marketState;
    _marketState     = newState;

    updateBadge(newState);

    // 장 상태 변경 이벤트 발행
    window.dispatchEvent(new CustomEvent('marketStateChanged', {
      detail: { marketState: newState, prevState },
    }));

    console.log('[Clock] 장 상태:', prevState, '→', newState);
  }
}

// ── Init ──────────────────────────────────────────
export function startClock() {
  tick();
  setInterval(tick, 1000);

  checkMarketState();
  setInterval(checkMarketState, INTERVAL_MARKET_STATE);
}

export function getMarketState() { return _marketState; }
