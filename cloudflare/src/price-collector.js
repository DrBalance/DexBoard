// ============================================
// price-collector.js — Yahoo Finance 일봉 수집
// 볼린저밴드(20일) + ATR(5/20일) 계산 후 D1 저장
// ============================================

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

// ── 볼린저밴드 계산
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

// ── ATR 계산
function calcATR(candles, period) {
  const slice = candles.slice(-period);
  if (slice.length < period) return null;
  const ranges = slice.map(c => c.high - c.low);
  return ranges.reduce((a, b) => a + b, 0) / period;
}

// ── Yahoo Finance 일봉 fetch (2개월치, API 키 불필요)
export async function fetchPriceData(symbol) {
  const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=2mo`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);

  const json   = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('Yahoo: no result');

  const timestamps = result.timestamp ?? [];
  const quote      = result.indicators?.quote?.[0] ?? {};
  const { open, high, low, close } = quote;
  if (!timestamps.length || !close?.length) throw new Error('Yahoo: empty data');

  const candles = timestamps
    .map((ts, i) => ({
      date:  new Date(ts * 1000).toISOString().slice(0, 10),
      open:  open?.[i]  ?? null,
      high:  high?.[i]  ?? null,
      low:   low?.[i]   ?? null,
      close: close?.[i] ?? null,
    }))
    .filter(c => c.close != null);

  if (candles.length < 20) throw new Error('insufficient_data');
  return candles;
}

// ── 지표 계산 + D1 저장
// ※ apiKey 파라미터 제거 — Yahoo는 키 불필요
//   screener-v2.js의 collectPriceIndicators(db, symbol, apiKey) 호출을
//   collectPriceIndicators(db, symbol) 로 변경 필요
export async function collectPriceIndicators(db, symbol) {
  try {
    const candles = await fetchPriceData(symbol);
    const closes  = candles.map(c => c.close);
    const today   = candles[candles.length - 1].date;
    const close   = closes[closes.length - 1];

    const bb = calcBollinger(closes);
    if (!bb) throw new Error('볼린저 계산 불가 (데이터 부족)');

    const atr5  = calcATR(candles, 5);
    const atr20 = calcATR(candles, 20);

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
