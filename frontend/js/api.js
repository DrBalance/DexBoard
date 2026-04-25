// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// api.js — 외부 API fetch 함수 모음
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { TWELVE_KEY } from './config.js';

// ── "HH:MM:SS" → 초 변환 ──────────────────────────────────
export function parseHMS(hms) {
  if (!hms) return null;
  const parts = hms.split(':').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// ── 내부: 단순 1회 fetch ──────────────────────────────────
async function _fetchOnce() {
  const url = `https://api.twelvedata.com/market_state?exchange=NYSE&apikey=${TWELVE_KEY}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);

  const json = await r.json();
  const nyse = Array.isArray(json)
    ? (json.find(e => e.code === 'XNYS') ?? json[0])
    : json;
  if (!nyse) throw new Error('NYSE 데이터 없음');

  return {
    isOpen:           !!nyse.is_market_open,
    timeToOpenSec:    parseHMS(nyse.time_to_open)    ?? 0,
    timeToCloseSec:   parseHMS(nyse.time_to_close)   ?? 0,
    timeAfterOpenSec: parseHMS(nyse.time_after_open) ?? 0,
  };
}

// ── Twelve Data /market_state — 최대 5회 재시도 ───────────
// 성공 시: { isOpen, timeToOpenSec, timeToCloseSec, timeAfterOpenSec }
// 5회 모두 실패 시: null
export async function fetchMarketStatus() {
  const MAX_RETRY  = 5;
  const RETRY_DELAY_MS = 3000; // 3초 간격

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const result = await _fetchOnce();
      if (attempt > 1) console.log(`[API] fetchMarketStatus 성공 (${attempt}회차)`);
      return result;
    } catch (e) {
      console.warn(`[API] fetchMarketStatus 실패 (${attempt}/${MAX_RETRY}):`, e.message);
      if (attempt < MAX_RETRY) {
        await new Promise(res => setTimeout(res, RETRY_DELAY_MS));
      }
    }
  }

  console.error('[API] fetchMarketStatus 5회 모두 실패');
  return null;
}
