// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ws.js — WebSocket 연결 관리 + 이벤트 발행
//
// 발행 이벤트 (각 탭에서 필요한 것만 구독):
//   'wsStatus'  → { status: 'connecting'|'connected'|'disconnected'|'error' }
//   'wsInit'    → { data }   초기 데이터
//   'wsPrices'  → { data }   실시간 가격
//   'wsMarket'  → { data }   시장 데이터
//   'wsGreeks'  → { data }   Greeks 데이터
//
// 사용처:
//   connectWS()    → live.js에서 REGULAR 진입 시 호출
//   disconnectWS() → live.js에서 AFTER 진입 시 호출
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { CF_API } from './config.js';

// Railway WebSocket 주소
const WS_URL = 'wss://drbalance-stock-dashboard-production.up.railway.app';

// ── 내부 상태 ─────────────────────────────────────────────
let _ws               = null;
let _wsReconnectTimer = null;
let _intentionalClose = false;  // disconnectWS() 호출 시 재연결 방지

// ── 이벤트 발행 헬퍼 ──────────────────────────────────────
function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

// ── WS 상태 발행 + 콘솔 ───────────────────────────────────
function emitStatus(status) {
  console.log(`[WS] 상태: ${status}`);
  emit('wsStatus', { status });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// connectWS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function connectWS() {
  // 이미 연결 중이거나 연결됐으면 skip
  if (_ws && (
    _ws.readyState === WebSocket.OPEN ||
    _ws.readyState === WebSocket.CONNECTING
  )) return;

  _intentionalClose = false;
  emitStatus('connecting');

  _ws = new WebSocket(WS_URL);

  // ── 연결 성공 ──────────────────────────────────────────
  _ws.onopen = () => {
    emitStatus('connected');
    if (_wsReconnectTimer) {
      clearTimeout(_wsReconnectTimer);
      _wsReconnectTimer = null;
    }
  };

  // ── 메시지 수신 → 이벤트 발행 ─────────────────────────
  _ws.onmessage = (e) => {
    try {
      const { type, data } = JSON.parse(e.data);
      switch (type) {
        case 'init':   emit('wsInit',   { data }); break;
        case 'prices': emit('wsPrices', { data }); break;
        case 'market': emit('wsMarket', { data }); break;
        case 'greeks': emit('wsGreeks', { data }); break;
        default:
          console.warn('[WS] 알 수 없는 메시지 타입:', type);
      }
    } catch (err) {
      console.warn('[WS] 메시지 파싱 오류:', err.message);
    }
  };

  // ── 연결 종료 → 재연결 예약 ───────────────────────────
  _ws.onclose = () => {
    emitStatus('disconnected');
    if (_intentionalClose) return; // disconnectWS() 호출 시 재연결 안 함

    console.warn('[WS] 연결 종료 — 10초 후 재연결 시도');
    if (!_wsReconnectTimer) {
      _wsReconnectTimer = setTimeout(() => {
        _wsReconnectTimer = null;
        connectWS();
      }, 10000);
    }
  };

  // ── 오류 → close 이벤트로 위임 ────────────────────────
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
// getWSState — 외부에서 현재 연결 상태 확인용
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function getWSState() {
  if (!_ws) return 'disconnected';
  switch (_ws.readyState) {
    case WebSocket.CONNECTING: return 'connecting';
    case WebSocket.OPEN:       return 'connected';
    case WebSocket.CLOSING:
    case WebSocket.CLOSED:
    default:                   return 'disconnected';
  }
}
