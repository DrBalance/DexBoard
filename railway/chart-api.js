// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// chart-api.js — 차트 데이터 (Twelve Data + LRU 캐시 + 볼린저밴드)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { LRUCache } from 'lru-cache';

const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY;

// ET offset 계산 (서머타임 자동 감지)
function getETOffsetMs(date) {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const etStr  = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
  return new Date(utcStr).getTime() - new Date(etStr).getTime();
}

// Twelve Data interval 매핑
const TD_INTERVAL = {
  '5':   '5min',
  '30':  '30min',
  '120': '2h',
  '240': '4h',
  'D':   '1day',
  'W':   '1week',
};

// resolution → 캐시 TTL (ms)
const CHART_TTL = {
  '5':   60_000,
  '30':  120_000,
  '120': 300_000,
  '240': 300_000,
  'D':   3_600_000,
  'W':   3_600_000,
};

// resolution → outputsize (캔들 수)
const CHART_OUTPUTSIZE = {
  '5':   390,   // ~5거래일 분봉
  '30':  300,   // ~30거래일
  '120': 180,   // ~90거래일 2시간봉
  '240': 180,   // ~180거래일 4시간봉
  'D':   365,   // 1년 일봉
  'W':   156,   // 3년 주봉
};

export const VALID_RESOLUTIONS = ['5', '30', '120', '240', 'D', 'W'];

const chartCache = new LRUCache({ max: 200, ttlResolution: 1000 });

// ── 볼린저밴드 계산 (SMA20 기준, 1σ + 2σ)
export function calcBollinger(closes, period = 20) {
  const upper2 = [], lower2 = [], upper1 = [], lower1 = [], mid = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      upper2.push(null); lower2.push(null);
      upper1.push(null); lower1.push(null);
      mid.push(null);
      continue;
    }
    const slice = closes.slice(i - period + 1, i + 1);
    const sma   = slice.reduce((a, b) => a + b, 0) / period;
    const std   = Math.sqrt(slice.reduce((a, b) => a + (b - sma) ** 2, 0) / period);
    mid.push(+sma.toFixed(4));
    upper2.push(+(sma + std * 2).toFixed(4));
    lower2.push(+(sma - std * 2).toFixed(4));
    upper1.push(+(sma + std * 1).toFixed(4));
    lower1.push(+(sma - std * 1).toFixed(4));
  }
  return { upper2, lower2, upper1, lower1, mid };
}

// ── 차트 데이터 fetch + 캐시
export async function fetchChartData(symbol, resolution) {
  const cacheKey = `${symbol}:${resolution}`;
  const cached   = chartCache.get(cacheKey);
  if (cached) return cached;

  const interval   = TD_INTERVAL[resolution] ?? '1day';
  const outputsize = CHART_OUTPUTSIZE[resolution] ?? 300;

  const url = `https://api.twelvedata.com/time_series`
    + `?symbol=${encodeURIComponent(symbol)}`
    + `&interval=${interval}`
    + `&outputsize=${outputsize}`
    + `&order=ASC`
    + `&apikey=${TWELVEDATA_KEY}`;

  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('TwelveData HTTP ' + r.status);
  const j = await r.json();

  if (j.status === 'error' || j.code) {
    throw new Error('TwelveData: ' + (j.message || j.code || 'unknown'));
  }
  if (!Array.isArray(j.values) || j.values.length === 0) {
    throw new Error('no_data');
  }

  const candles = j.values.map(v => {
    const isIntraday = resolution !== 'D' && resolution !== 'W';
    let time;
    if (isIntraday) {
      const dtStr     = v.datetime.replace(' ', 'T');
      const localDate = new Date(dtStr);
      const etOffset  = getETOffsetMs(localDate);
      time = Math.floor((localDate.getTime() - etOffset) / 1000);
    } else {
      time = v.datetime.slice(0, 10); // 'YYYY-MM-DD'
    }
    return {
      time,
      open:   +parseFloat(v.open).toFixed(4),
      high:   +parseFloat(v.high).toFixed(4),
      low:    +parseFloat(v.low).toFixed(4),
      close:  +parseFloat(v.close).toFixed(4),
      volume: v.volume != null ? parseInt(v.volume) : 0,
    };
  });

  const bb = calcBollinger(candles.map(cd => cd.close));
  candles.forEach((cd, i) => {
    cd.bbUpper2 = bb.upper2[i];
    cd.bbLower2 = bb.lower2[i];
    cd.bbUpper1 = bb.upper1[i];
    cd.bbLower1 = bb.lower1[i];
    cd.bbMid    = bb.mid[i];
  });

  const last = candles[candles.length - 1];
  const data = {
    symbol, resolution,
    currentPrice:  last?.close ?? null,
    previousClose: candles.length > 1 ? candles[candles.length - 2].close : null,
    candles,
    updatedAt: new Date().toISOString(),
  };

  chartCache.set(cacheKey, data, { ttl: CHART_TTL[resolution] ?? 60_000 });
  return data;
}
