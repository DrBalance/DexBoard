// ============================================
// price-collector.js — Twelve Data 일봉 수집
// 볼린저밴드(20일) + ATR(5/20일) 계산 후 D1 저장
// ============================================

const TWELVEDATA_BASE = 'https://api.twelvedata.com';

// ── 볼린저밴드 계산 (chart-api.js와 동일 로직)
function calcBollinger(closes, period = 20) {
  const last = closes.length - 1;
  if (last < period - 1) return null;

  const slice = closes.slice(last - period + 1, last + 1);
  const sma   = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + (b - sma) ** 2, 0) / period);

  return {
    mid:    +sma.toFixed(4),
    upper1: +(sma + std).toFixed(4),
    lower1: +(sma - std).toFixed(4),
    upper2: +(sma + std * 2).toFixed(4),
    lower2: +(sma - std * 2).toFixed(4),
  };
}

// ── ATR 계산 (단순 고저 범위 평균)
function calcATR(candles, period) {
  const slice = candles.slice(-period);
  if (slice.length < period) return null;
  const ranges = slice.map(c => c.high - c.low);
  return ranges.reduce((a, b) => a + b, 0) / period;
}

// ── Twelve Data 일봉 fetch (25캔들 = 볼린저 20일 + 여유 5일)
export async function fetchPriceData(symbol, apiKey) {
  const url = `${TWELVEDATA_BASE}/time_series`
    + `?symbol=${encodeURIComponent(symbol)}`
    + `&interval=1day`
    + `&outputsize=25`
    + `&order=ASC`
    + `&apikey=${apiKey}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`TwelveData HTTP ${res.status}`);

  const json = await res.json();
  if (json.status === 'error' || json.code) {
    throw new Error(`TwelveData: ${json.message || json.code}`);
  }
  if (!Array.isArray(json.values) || json.values.length < 20) {
    throw new Error('insufficient_data');
  }

  return json.values.map(v => ({
    date:  v.datetime.slice(0, 10),
    open:  parseFloat(v.open),
    high:  parseFloat(v.high),
    low:   parseFloat(v.low),
    close: parseFloat(v.close),
  }));
}

// ── 지표 계산 + D1 저장
export async function collectPriceIndicators(db, symbol, apiKey) {
  try {
    const candles = await fetchPriceData(symbol, apiKey);
    const closes  = candles.map(c => c.close);
    const today   = candles[candles.length - 1].date;
    const close   = closes[closes.length - 1];

    const bb = calcBollinger(closes);
    if (!bb) throw new Error('볼린저 계산 불가 (데이터 부족)');

    const atr5  = calcATR(candles, 5);
    const atr20 = calcATR(candles, 20);

    // 볼린저 위치: 0 = 하단(-2σ), 1 = 상단(+2σ)
    const bbRange    = bb.upper2 - bb.lower2;
    const bbPosition = bbRange > 0 ? (close - bb.lower2) / bbRange : 0.5;

    await db.prepare(`
      INSERT OR REPLACE INTO price_indicators
        (date, symbol, close,
         bb_mid, bb_upper1, bb_lower1, bb_upper2, bb_lower2,
         bb_position, atr5, atr20, vol_ratio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      today, symbol, close,
      bb.mid, bb.upper1, bb.lower1, bb.upper2, bb.lower2,
      +bbPosition.toFixed(4),
      atr5  ? +atr5.toFixed(4)  : null,
      atr20 ? +atr20.toFixed(4) : null,
      (atr5 && atr20) ? +(atr5 / atr20).toFixed(4) : null
    ).run();

    return { symbol, close, bbPosition, atr5, atr20 };

  } catch (err) {
    console.error(`[${symbol}] 가격 수집 실패:`, err.message);
    return null;
  }
}
