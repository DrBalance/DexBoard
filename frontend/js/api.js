// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// api.js — 외부 API fetch 함수 모음
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { CF_API, TWELVE_KEY } from './config.js';

// ── "HH:MM:SS" → 초 변환 ──────────────────────────────────
export function parseHMS(hms) {
  if (!hms) return null;
  const parts = hms.split(':').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// ── 내부: 단순 1회 fetch ──────────────────────────────────
async function _fetchMarketOnce() {
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
export async function fetchMarketStatus() {
  const MAX_RETRY      = 5;
  const RETRY_DELAY_MS = 3000;

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const result = await _fetchMarketOnce();
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CF Worker KV fetch 헬퍼
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function _cfFetch(path) {
  try {
    const r = await fetch(`${CF_API}${path}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn(`[API] ${path} 실패:`, e.message);
    return null;
  }
}

// ── 스냅샷만 갱신 (1분 폴링용) ───────────────────────────
// returns: { spy, vix, updatedAt } | null
export async function loadSnapshot() {
  return await _cfFetch('/api/snapshot');
}

// ── 전체 데이터 로드 (15분 폴링 + 최초 1회) ──────────────
// returns: { snap, snapPrev, dex0, dexOpen, weekly, monthly, quarterly }
export async function loadAll() {
  const [snap, snapPrev, dex0, dexOpen, weekly, monthly, quarterly] =
    await Promise.all([
      _cfFetch('/api/snapshot'),
      _cfFetch('/api/snapshot/prev'),
      _cfFetch('/api/dex/0dte'),
      _cfFetch('/api/dex/open'),
      _cfFetch('/api/dex/weekly'),
      _cfFetch('/api/dex/monthly'),
      _cfFetch('/api/dex/quarterly'),
    ]);

  return { snap, snapPrev, dex0, dexOpen, weekly, monthly, quarterly };
}
