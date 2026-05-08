// ============================================
// screener-engine.js — Railway 전용 스크리너 엔진
// Whale 필터 기반 강도(-3~+3) + 타이밍 등급(A/B/C) 계산
//
// 필터 조건:
//   1. 현재가 > 플립존 (딜러 롱감마) — 콜 방향
//      현재가 < 플립존 (딜러 숏감마) — 풋 방향
//   2. 델타 0.2~0.4 구간 OI x 델타 x 100 합계 > avg_volume x 5%
//
// 강도 점수 (-3 ~ +3):
//   헤징 수량이 임계값의 몇 배인지 기반
//
// 타이밍 등급:
//   A: Monthly 2개 IV 스큐 방향 일치 + Weekly 방향 일치
//   B: Monthly 2개 IV 스큐 방향 일치 (Weekly 불일치)
//   C: 필터 통과, 타이밍 신호 없음
// ============================================

const TWELVE_BASE = 'https://api.twelvedata.com/quote';
const YAHOO_BASE  = 'https://query1.finance.yahoo.com/v8/finance/chart';

// ============================================
// 유틸리티
// ============================================
function getToday() {
  return new Date().toISOString().split('T')[0];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Standard Monthly 판별 (매달 3번째 금요일)
function isStandardMonthly(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (d.getDay() !== 5) return false;
  const day = d.getDate();
  return day >= 15 && day <= 21;
}

function avg(arr) {
  if (!arr?.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ============================================
// Twelve Data average_volume fetch
// ============================================
export async function fetchAvgVolume(symbol, twelveKey) {
  if (!twelveKey) return null;
  try {
    const url = `${TWELVE_BASE}?symbol=${encodeURIComponent(symbol)}&apikey=${twelveKey}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}`);
    const data = await res.json();
    const avgVol = parseFloat(data.average_volume);
    if (isNaN(avgVol) || avgVol <= 0) throw new Error('average_volume 유효하지 않음');
    return avgVol;
  } catch (err) {
    console.warn(`[${symbol}] avg_volume 수집 실패:`, err.message);
    return null;
  }
}

// ============================================
// Yahoo Finance 일봉 + 볼린저밴드 계산
// ============================================
export async function collectPriceIndicators(symbol, cfWorkerUrl, cronSecret, twelveKey) {
  try {
    const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);

    const json   = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error('Yahoo: no result');

    const timestamps = result.timestamp ?? [];
    const closes     = result.indicators?.quote?.[0]?.close ?? [];
    const highs      = result.indicators?.quote?.[0]?.high  ?? [];
    const lows       = result.indicators?.quote?.[0]?.low   ?? [];

    const candles = timestamps
      .map((ts, i) => ({
        date:  new Date(ts * 1000).toISOString().slice(0, 10),
        close: closes[i] ?? null,
        high:  highs[i]  ?? null,
        low:   lows[i]   ?? null,
      }))
      .filter(c => c.close != null);

    if (candles.length < 20) throw new Error('insufficient_data');

    const cls = candles.map(c => c.close);

    // Twelve Data avg_volume 병렬 조회
    const avgVolume = await fetchAvgVolume(symbol, twelveKey);

    // 전체 캔들 BB/ATR 계산
    const rows = [];
    for (let i = 19; i < candles.length; i++) {
      const { date, close, high, low } = candles[i];
      const slice = cls.slice(i - 19, i + 1);
      const sma   = slice.reduce((a, b) => a + b, 0) / 20;
      const std   = Math.sqrt(slice.reduce((a, b) => a + (b - sma) ** 2, 0) / 20);
      const upper2    = sma + std * 2;
      const lower2    = sma - std * 2;
      const bbRange    = upper2 - lower2;
      const bbPosition = bbRange > 0 ? (close - lower2) / bbRange : 0.5;

      const atr = (n) => {
        if (i < n - 1) return null;
        const s = candles.slice(i - n + 1, i + 1);
        return s.reduce((a, c) => a + (c.high - c.low), 0) / n;
      };
      const atr5  = atr(5);
      const atr20 = atr(20);

      rows.push({
        date,
        symbol,
        close,
        bb_mid:      +sma.toFixed(4),
        bb_upper1:   +(sma + std).toFixed(4),
        bb_lower1:   +(sma - std).toFixed(4),
        bb_upper2:   +upper2.toFixed(4),
        bb_lower2:   +lower2.toFixed(4),
        bb_position: +bbPosition.toFixed(4),
        atr5:        atr5  ? +atr5.toFixed(4)  : null,
        atr20:       atr20 ? +atr20.toFixed(4) : null,
        vol_ratio:   (atr5 && atr20) ? +(atr5 / atr20).toFixed(4) : null,
        avg_volume:  avgVolume ?? null,
      });
    }

    // CF Worker D1 저장 (INSERT OR IGNORE)
    const writeRes = await fetch(`${cfWorkerUrl}/d1/price-indicators`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-cron-secret': cronSecret,
      },
      body: JSON.stringify({ rows, mode: 'ignore' }),
      signal: AbortSignal.timeout(15000),
    });
    if (!writeRes.ok) throw new Error(`D1 write failed: ${writeRes.status}`);

    const latest = rows[rows.length - 1];
    return {
      symbol,
      close:      latest.close,
      bbPosition: latest.bb_position,
      volRatio:   latest.vol_ratio,
      avgVolume,
    };

  } catch (err) {
    console.error(`[${symbol}] 가격 수집 실패:`, err.message);
    return null;
  }
}

// ============================================
// 플립존 계산 (DEX 부호 전환점)
// ============================================
function findFlipStrike(dexMap, spotPrice) {
  if (!dexMap || !spotPrice) return null;

  const strikes = Object.keys(dexMap)
    .map(Number)
    .sort((a, b) => a - b);

  if (strikes.length < 2) return null;

  const range = spotPrice * 0.15;
  const near  = strikes.filter(s => Math.abs(s - spotPrice) <= range);
  if (near.length < 2) return null;

  for (let i = 0; i < near.length - 1; i++) {
    const curr = dexMap[near[i]];
    const next = dexMap[near[i + 1]];
    if (curr < 0 && next >= 0) return near[i + 1];
    if (curr >= 0 && next < 0) return near[i];
  }
  return null;
}

// ============================================
// Monthly/Weekly 행 분류
// ============================================
function getMonthlyRows(rows) {
  return rows
    .filter(r => r.is_monthly === 1)
    .sort((a, b) => a.dte - b.dte)
    .slice(0, 2);
}

function getWeeklyRows(rows) {
  return rows.filter(r => r.is_monthly === 0 && r.dte <= 14 && r.dte >= 0);
}

// ============================================
// 강도 점수 계산 (-3 ~ +3)
// ============================================
function calcStrengthScore(monthlyRows, spotPrice, avgVolume) {
  if (!monthlyRows.length || !spotPrice) return 0;

  const primary = monthlyRows[0];
  if (!primary.flip_strike) return 0;

  const isAboveFlip = spotPrice > primary.flip_strike;
  const direction   = isAboveFlip ? 1 : -1;

  const hedgeThreshold = avgVolume ? avgVolume * 0.05 : null;
  const hedgeQty = (direction > 0
    ? primary.otm_call_oi_d
    : primary.otm_put_oi_d) * 100;

  if (hedgeThreshold && hedgeQty < hedgeThreshold) return 0;

  let strength = 0;
  if (hedgeThreshold && hedgeThreshold > 0) {
    const ratio = hedgeQty / hedgeThreshold;
    if      (ratio >= 3) strength = 3;
    else if (ratio >= 2) strength = 2;
    else if (ratio >= 1) strength = 1;
  } else {
    strength = 1;
  }

  // Monthly 2개 모두 같은 방향이면 강도 +1 (최대 3)
  if (monthlyRows.length >= 2 && monthlyRows[1].flip_strike) {
    const secondAbove = spotPrice > monthlyRows[1].flip_strike;
    if (secondAbove === isAboveFlip) {
      strength = Math.min(strength + 1, 3);
    }
  }

  return direction * strength;
}

// ============================================
// 타이밍 등급 계산 (A / B / C)
// ============================================
function calcTimingGrade(monthlyRows, weeklyRows, spotPrice) {
  if (!monthlyRows.length) return 'C';

  const monthlySkews = monthlyRows
    .map(r => r.iv_skew)
    .filter(v => v != null);

  let monthlyMatch = false;
  if (monthlySkews.length >= 2) {
    monthlyMatch = (monthlySkews[0] > 0) === (monthlySkews[1] > 0);
  }

  const direction  = spotPrice > (monthlyRows[0].flip_strike ?? 0) ? 1 : -1;
  const weeklyMatch = weeklyRows.some(r => {
    if (r.iv_skew == null) return false;
    return direction > 0 ? r.iv_skew > 0 : r.iv_skew < 0;
  });

  if (monthlyMatch && weeklyMatch) return 'A';
  if (monthlyMatch)                return 'B';
  return 'C';
}

// ============================================
// 옵션 데이터에서 플립존 + OI 집계
// (vanna_analyzer.js의 collectSymbol 결과 rows 기반)
// ============================================
function enrichRows(rows, spotPrice) {
  // rows: options_dex 형태 (expiry_date, dte, call_oi, put_oi, iv_skew 등)
  // vanna_analyzer에서 넘어온 raw에는 strike별 데이터가 없으므로
  // flip_strike는 dex 부호 기반으로 근사 계산

  return rows.map(r => {
    const monthly = isStandardMonthly(r.expiry_date) ? 1 : 0;

    // dex_map 근사: 단일 만기의 net dex 부호로 flip 추정
    // (strike별 데이터 없으므로 전체 DEX 부호로 대체)
    const flipStrike = r.flip_strike ?? null;

    // 델타 가중 OI — otm_call_delta, otm_call_theo 활용
    const otmCallOiD = r.otm_call_theo ?? 0;
    const otmPutOiD  = 0; // 풋 방향은 별도 필드 없으면 0

    return {
      ...r,
      is_monthly:    monthly,
      flip_strike:   flipStrike,
      otm_call_oi_d: otmCallOiD,
      otm_put_oi_d:  otmPutOiD,
    };
  });
}

// ============================================
// 종합 점수 계산 + D1 저장
// ============================================
export async function calcAndSaveScore(cfWorkerUrl, cronSecret, symbol, date, rawRows, priceInfo) {
  if (!rawRows?.length) return null;

  const spotPrice = priceInfo?.close     ?? null;
  const avgVolume = priceInfo?.avgVolume ?? null;

  // rows 보강
  const rows = enrichRows(rawRows, spotPrice);

  const monthlyRows = getMonthlyRows(rows);
  const weeklyRows  = getWeeklyRows(rows);

  // 필터 1: 플립존 존재 여부
  const primary = monthlyRows[0];
  if (!primary?.flip_strike) {
    console.log(`[${symbol}] 플립존 없음 -- 스킵`);
    return null;
  }

  // 강도 점수
  const strengthScore = calcStrengthScore(monthlyRows, spotPrice, avgVolume);
  if (strengthScore === 0) {
    console.log(`[${symbol}] 필터 미통과 (strength=0) -- 스킵`);
    return null;
  }

  // 타이밍 등급
  const timingGrade = calcTimingGrade(monthlyRows, weeklyRows, spotPrice);

  const timingWeight = timingGrade === 'A' ? 1.5 : timingGrade === 'B' ? 1.2 : 1.0;
  const totalScore   = Math.round(Math.abs(strengthScore) * timingWeight * 10) / 10;

  const row = {
    date,
    symbol,
    close:          spotPrice,
    bb_position:    priceInfo?.bbPosition ?? null,
    bb_flag:        null,
    iv_skew:        primary.iv_skew ?? null,
    score_skew:     0,
    score_bb:       0,
    score_vol_squeeze: 0,
    skew_strength:  null,
    total_score:    totalScore,
    strength_score: strengthScore,
    timing_grade:   timingGrade,
    flip_strike:    primary.flip_strike,
    monthly_count:  monthlyRows.length,
  };

  const res = await fetch(`${cfWorkerUrl}/d1/screener-scores`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'x-cron-secret': cronSecret,
    },
    body: JSON.stringify({ rows: [row] }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`screener-scores write failed: ${res.status}`);

  return {
    symbol,
    strengthScore,
    timingGrade,
    totalScore,
    flipStrike: primary.flip_strike,
  };
}
