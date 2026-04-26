// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ws.js — WebSocket 연결 관리 + 이벤트 발행
//
// 발행 이벤트:
//   'wsStatus'   → { status: 'connecting'|'connected'|'disconnected'|'error' }
//   'wsTick'     → { s, p, v, t }  SPY/RSP 틱
//
// 사용처:
//   connectWS()    → live.js에서 REGULAR 진입 시 호출
//   disconnectWS() → live.js에서 AFTER 진입 시 호출
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { RAILWAY_WS_URL } from './config.js';

// ── 내부 상태 ─────────────────────────────────────────────
let _ws               = null;
let _wsReconnectTimer = null;
let _intentionalClose = false;

// ── 이벤트 발행 헬퍼 ──────────────────────────────────────
function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function emitStatus(status) {
  console.log(`[WS] 상태: ${status}`);
  emit('wsStatus', { status });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// connectWS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function connectWS() {
  if (_ws && (
    _ws.readyState === WebSocket.OPEN ||
    _ws.readyState === WebSocket.CONNECTING
  )) return;

  _intentionalClose = false;
  emitStatus('connecting');

  _ws = new WebSocket(RAILWAY_WS_URL);

  _ws.onopen = () => {
    emitStatus('connected');
    if (_wsReconnectTimer) {
      clearTimeout(_wsReconnectTimer);
      _wsReconnectTimer = null;
    }
  };

  _ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);

      switch (msg.type) {
        // Finnhub 틱 중계
        case 'tick':
          if (Array.isArray(msg.data)) {
            msg.data.forEach((tick) => {
              // tick: { s: 'SPY'|'RSP', p: 가격, v: 거래량, t: ms타임스탬프 }
              emit('wsTick', tick);
            });
          }
          break;

        // Railway → Finnhub 연결 상태
        case 'status':
          console.log('[WS] Finnhub 상태:', msg.finnhub);
          break;

        default:
          console.warn('[WS] 알 수 없는 메시지 타입:', msg.type);
      }
    } catch (err) {
      console.warn('[WS] 메시지 파싱 오류:', err.message);
    }
  };

  _ws.onclose = () => {
    emitStatus('disconnected');
    if (_intentionalClose) return;

    console.warn('[WS] 연결 종료 — 10초 후 재연결 시도');
    if (!_wsReconnectTimer) {
      _wsReconnectTimer = setTimeout(() => {
        _wsReconnectTimer = null;
        connectWS();
      }, 10_000);
    }
  };

  _ws.onerror = () => {
    emitStatus('error');
    _ws.close();
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// disconnectWS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function disconnectWS() {
  _intentionalClose = true;

  if (_wsReconnectTimer) {
    clearTimeout(_wsReconnectTimer);
    _wsReconnectTimer = null;
  }

  if (_ws) {
    _ws.close();
    _ws = null;
  }

  emitStatus('disconnected');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// getWSState
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function getWSState() {
  if (!_ws) return 'disconnected';
  switch (_ws.readyState) {
    case WebSocket.CONNECTING: return 'connecting';
    case WebSocket.OPEN:       return 'connected';
    default:                   return 'disconnected';
  }
}
