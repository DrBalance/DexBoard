// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// chart-api.js — 차트 데이터 (Twelve Data + 캐시 + 볼린저밴드)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const TWELVEDATA_KEY = process.env.TWELVE_KEY;

// 간단 TTL 캐시
const _cacheStore = new Map();
const chartCache = {
  get(key) {
    const entry = _cacheStore.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) { _cacheStore.delete(key); return undefined; }
    return entry.value;
  },
  set(key, value, { ttl } = {}) {
    _cacheStore.set(key, { value, expires: Date.now() + (ttl ?? 60_000) });
  },
};

// ET offset 계산 (서머타임 자동 감지)
function getETOffsetMs(date) {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const etStr  = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
  return new Date(utcStr).getTime() - new Date(etStr).getTime();
}

const TD_INTERVAL = {
  '5':   '5min',
  '30':  '30min',
  '120': '2h',
  '240': '4h',
  'D':   '1day',
  'W':   '1week',
};

const CHART_TTL = {
  '5':   60_000,
  '30':  120_000,
  '120': 300_000,
  '240': 300_000,
  'D':   3_600_000,
  'W':   3_600_000,
};

const CHART_OUTPUTSIZE = {
  '5':   390,
  '30':  300,
  '120': 180,
  '240': 180,
  'D':   365,
  'W':   156,
};

export const VALID_RESOLUTIONS = ['5', '30', '120', '240', 'D', 'W'];

// 볼린저밴드 계산 (SMA20, 1σ + 2σ)
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

// 차트 데이터 fetch + 캐시
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

  const KST_OFFSET = 9 * 60 * 60 * 1000;
  const isIntraday = resolution !== 'D' && resolution !== 'W';

  const candles = j.values.map(v => {
    let time;
    if (isIntraday) {
      const localDate = new Date(v.datetime.replace(' ', 'T'));
      const etOffset  = getETOffsetMs(localDate);
      time = Math.floor((localDate.getTime() - etOffset + KST_OFFSET) / 1000);
    } else {
      time = v.datetime.slice(0, 10);
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
