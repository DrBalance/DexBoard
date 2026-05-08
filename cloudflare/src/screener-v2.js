// ============================================
// screener-v2.js — 종합 스크리너 v3
// 새 기준: Whale 필터 기반 강도(-3~+3) + 타이밍 등급(A/B/C)
//
// 필터 조건:
//   1. 현재가 > 플립존 (딜러 롱감마) — 콜 방향
//      현재가 < 플립존 (딜러 숏감마) — 풋 방향
//   2. 델타 0.2~0.4 구간 OI × 델타 × 100 합계 > avg_volume × 5%
//
// 강도 점수 (-3 ~ +3):
//   DEX Share % 자체가 점수 기반 (플립존 구간 집중도)
//
// 타이밍 등급:
//   A: Monthly 2개 IV 스큐 방향 일치 + Weekly 방향 일치
//   B: Monthly 2개 IV 스큐 방향 일치 (Weekly 불일치)
//   C: 필터 통과, 타이밍 신호 없음
//
// Cron: 매일 20:30 UTC (장 마감 30분 후)
// ============================================

import { collectPriceIndicators } from './price-collector.js';

const BARCHART_BASE = 'https://www.barchart.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.barchart.com/options/unusual-activity',
  'X-Requested-With': 'XMLHttpRequest',
};

// ============================================
// 유틸리티
// ============================================
function getToday() {
  return new Date().toISOString().split('T')[0];
}

function getDateAfterDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function daysBetween(from, to) {
  return Math.round((new Date(to) - new Date(from)) / 86400000);
}

function avg(arr) {
  if (!arr?.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Standard Monthly 판별 (매달 3번째 금요일)
function isStandardMonthly(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (d.getDay() !== 5) return false; // 금요일 아니면 false
  const day = d.getDate();
  return day >= 15 && day <= 21;      // 3번째 금요일: 15~21일
}

// ============================================
// 1. 옵션체인 수집 (Barchart) — Strike별 delta 포함
// ============================================
export async function fetchOptionsData(symbol, spotPrice) {
  try {
    const url = `${BARCHART_BASE}/proxies/core-api/v1/options/chain`
      + `?symbol=${symbol}`
      + `&startDate=${getToday()}`
      + `&endDate=${getDateAfterDays(56)}`
      + `&fields=symbol,expiration,strikePrice,callOpenInterest,putOpenInterest,`
      + `callVolume,putVolume,impliedVolatility,delta,gamma`
      + `&raw=1`;

    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    return parseOptionsChain(symbol, data, spotPrice);
  } catch (err) {
    console.error(`[${symbol}] 옵션 수집 실패:`, err.message);
    return null;
  }
}

// ============================================
// 2. 옵션체인 파싱
// ============================================
function parseOptionsChain(symbol, data, spotPrice) {
  if (!data?.data) return null;

  const today   = getToday();
  const results = [];
  const byExpiry = {};

  for (const row of data.data) {
    const expiry = row.expiration;
    const strike = row.strikePrice || 0;
    const delta  = Math.abs(row.delta || 0);

    if (!byExpiry[expiry]) {
      byExpiry[expiry] = {
        call_vol: 0, put_vol: 0,
        call_oi: 0,  put_oi: 0,
        atm_put_oi: 0,
        ivs: [],
        // 델타 0.2~0.4 구간 Strike별 데이터 (Whale 필터용)
        otm_call_strikes: [],  // { strike, delta, oi }
        otm_put_strikes:  [],
        // DEX 계산용 (GEX 플립존 찾기)
        dex_map: {},           // { strike: netDex }
      };
    }

    const d = byExpiry[expiry];
    d.call_vol += row.callVolume || 0;
    d.put_vol  += row.putVolume  || 0;
    d.call_oi  += row.callOpenInterest || 0;
    d.put_oi   += row.putOpenInterest  || 0;

    // ATM ±5% 풋 OI
    if (spotPrice && strike > 0) {
      const pct = Math.abs(strike - spotPrice) / spotPrice;
      if (pct <= 0.05) d.atm_put_oi += row.putOpenInterest || 0;
    }

    // IV 스큐용
    if (row.impliedVolatility) {
      d.ivs.push({ iv: row.impliedVolatility, delta });
    }

    // 델타 0.2~0.4 구간 (Whale 필터)
    if (delta >= 0.2 && delta <= 0.4 && strike > 0) {
      if (row.callOpenInterest > 0) {
        d.otm_call_strikes.push({ strike, delta, oi: row.callOpenInterest });
      }
      if (row.putOpenInterest > 0) {
        d.otm_put_strikes.push({ strike, delta, oi: row.putOpenInterest });
      }
    }

    // DEX 근사치 (delta × OI × 100) — 플립존 계산용
    if (strike > 0) {
      const callDex = delta * (row.callOpenInterest || 0) * 100;
      const putDex  = delta * (row.putOpenInterest  || 0) * 100;
      if (!d.dex_map[strike]) d.dex_map[strike] = 0;
      d.dex_map[strike] += callDex - putDex;
    }
  }

  for (const [expiry, d] of Object.entries(byExpiry)) {
    const dte = daysBetween(today, expiry);
    if (dte < 0 || dte > 56) continue;

    const atmIVs     = d.ivs.filter(x => x.delta >= 0.4 && x.delta <= 0.6);
    const otmCallIVs = d.ivs.filter(x => x.delta >= 0.2 && x.delta < 0.4);
    const otmPutIVs  = d.ivs.filter(x => x.delta >= 0.2 && x.delta < 0.4);
    const otmCallIV  = avg(otmCallIVs.map(x => x.iv));
    const otmPutIV   = avg(otmPutIVs.map(x => x.iv));

    // 플립존 계산: DEX가 양→음 또는 음→양으로 바뀌는 Strike
    const flipStrike = findFlipStrike(d.dex_map, spotPrice);

    // 델타 0.2~0.4 콜 OI 합계 × 델타 (헤징 수량)
    const otmCallOiD = d.otm_call_strikes.reduce((sum, s) => sum + s.oi * s.delta, 0);
    const otmPutOiD  = d.otm_put_strikes.reduce((sum, s)  => sum + s.oi * s.delta, 0);

    results.push({
      date:             today,
      symbol,
      expiry_date:      expiry,
      dte,
      is_monthly:       isStandardMonthly(expiry) ? 1 : 0,
      call_vol:         d.call_vol,
      put_vol:          d.put_vol,
      call_oi:          d.call_oi,
      put_oi:           d.put_oi,
      pcr_vol:          d.put_vol / (d.call_vol || 1),
      pcr_oi:           d.put_oi  / (d.call_oi  || 1),
      atm_iv:           avg(atmIVs.map(x => x.iv)),
      otm_call_iv:      otmCallIV,
      otm_put_iv:       otmPutIV,
      atm_put_oi:       d.atm_put_oi,
      atm_put_oi_ratio: d.put_oi > 0 ? d.atm_put_oi / d.put_oi : 0,
      iv_skew:          (otmCallIV && otmPutIV) ? otmCallIV - otmPutIV : null,
      flip_strike:      flipStrike,
      otm_call_oi_d:    +otmCallOiD.toFixed(0),  // 델타 가중 콜 OI (헤징 수량)
      otm_put_oi_d:     +otmPutOiD.toFixed(0),   // 델타 가중 풋 OI (헤징 수량)
    });
  }

  return results;
}

// ── 플립존 Strike 계산 (DEX 부호 전환점)
function findFlipStrike(dexMap, spotPrice) {
  if (!dexMap || !spotPrice) return null;

  const strikes = Object.keys(dexMap)
    .map(Number)
    .sort((a, b) => a - b);

  if (strikes.length < 2) return null;

  // 현재가 근처 ±15% 범위에서만 탐색
  const range = spotPrice * 0.15;
  const near  = strikes.filter(s => Math.abs(s - spotPrice) <= range);
  if (near.length < 2) return null;

  for (let i = 0; i < near.length - 1; i++) {
    const curr = dexMap[near[i]];
    const next = dexMap[near[i + 1]];
    // 음→양 전환: 네거티브→포지티브 감마 플립
    if (curr < 0 && next >= 0) return near[i + 1];
    // 양→음 전환도 기록 (참고용, 주요 플립은 음→양)
    if (curr >= 0 && next < 0) return near[i];
  }
  return null;
}

// ============================================
// 3. Whale 필터 + 강도 점수 계산
// ============================================

// Standard Monthly 2개 추출 (가장 가까운 순)
function getMonthlyRows(rows) {
  return rows
    .filter(r => r.is_monthly === 1)
    .sort((a, b) => a.dte - b.dte)
    .slice(0, 2);
}

// Weekly 행 추출 (0~14DTE, Monthly 제외)
function getWeeklyRows(rows) {
  return rows.filter(r => r.is_monthly === 0 && r.dte <= 14 && r.dte >= 0);
}

// 강도 점수 계산 (-3 ~ +3)
// 기준: 플립존 위치 + 델타 0.2~0.4 헤징 수량 > avg_volume × 5%
function calcStrengthScore(monthlyRows, spotPrice, avgVolume) {
  if (!monthlyRows.length || !spotPrice) return 0;

  // 필터 통과 여부 확인
  const primary = monthlyRows[0];

  // 조건 1: 현재가 vs 플립존
  if (!primary.flip_strike) return 0;
  const isAboveFlip = spotPrice > primary.flip_strike;
  const direction   = isAboveFlip ? 1 : -1; // +1: 콜 방향, -1: 풋 방향

  // 조건 2: 헤징 수량 > avg_volume × 5%
  const hedgeThreshold = avgVolume ? avgVolume * 0.05 : null;
  const hedgeQty = direction > 0
    ? primary.otm_call_oi_d * 100  // 헤징 수량 = OI×delta×100
    : primary.otm_put_oi_d  * 100;

  if (hedgeThreshold && hedgeQty < hedgeThreshold) return 0; // 필터 탈락

  // 강도: 헤징 수량이 임계값의 몇 배인가
  // 임계값 없으면 DEX Share로 대체
  let strength = 0;
  if (hedgeThreshold && hedgeThreshold > 0) {
    const ratio = hedgeQty / hedgeThreshold;
    if      (ratio >= 3) strength = 3;
    else if (ratio >= 2) strength = 2;
    else if (ratio >= 1) strength = 1;
  } else {
    // avg_volume 없을 때: Monthly 2개 모두 같은 방향이면 강도 올림
    strength = 1;
  }

  // Monthly 2개 모두 같은 방향 플립존이면 강도 +1 (최대 3)
  if (monthlyRows.length >= 2 && monthlyRows[1].flip_strike) {
    const secondAbove = spotPrice > monthlyRows[1].flip_strike;
    if (secondAbove === isAboveFlip) {
      strength = Math.min(strength + 1, 3);
    }
  }

  return direction * strength;
}

// 타이밍 등급 계산 (A / B / C)
function calcTimingGrade(monthlyRows, weeklyRows, spotPrice) {
  if (!monthlyRows.length) return 'C';

  // Monthly IV 스큐 방향 일치 여부
  const monthlySkews = monthlyRows
    .map(r => r.iv_skew)
    .filter(v => v != null);

  let monthlyMatch = false;
  if (monthlySkews.length >= 2) {
    // 두 Monthly의 iv_skew 부호가 같으면 방향 일치
    monthlyMatch = (monthlySkews[0] > 0) === (monthlySkews[1] > 0);
  } else if (monthlySkews.length === 1) {
    monthlyMatch = false; // Monthly 1개만이면 B 불가
  }

  // Weekly 방향 일치 여부
  // 현재가 > 플립존이면 콜 방향 → Weekly iv_skew > 0 이면 일치
  const direction = spotPrice > (monthlyRows[0].flip_strike ?? 0) ? 1 : -1;
  const weeklyMatch = weeklyRows.some(r => {
    if (r.iv_skew == null) return false;
    return direction > 0 ? r.iv_skew > 0 : r.iv_skew < 0;
  });

  if (monthlyMatch && weeklyMatch) return 'A';
  if (monthlyMatch)                return 'B';
  return 'C';
}

// ============================================
// 4. 종합 점수 계산 + 저장
// ============================================
export async function calcAndSaveScore(cfWorkerUrl, cfKvSecret, symbol, date, flowRows, priceInfo) {
  if (!flowRows?.length) return null;

  const spotPrice  = priceInfo?.close     ?? null;
  const avgVolume  = priceInfo?.avgVolume ?? null;

  const monthlyRows = getMonthlyRows(flowRows);
  const weeklyRows  = getWeeklyRows(flowRows);

  // 필터 1: 플립존 존재 여부
  const primary = monthlyRows[0];
  if (!primary?.flip_strike) {
    console.log(`[${symbol}] 플립존 없음 — 스킵`);
    return null;
  }

  // 강도 점수 (-3 ~ +3)
  const strengthScore = calcStrengthScore(monthlyRows, spotPrice, avgVolume);
  if (strengthScore === 0) {
    console.log(`[${symbol}] 필터 미통과 (strength=0) — 스킵`);
    return null;
  }

  // 타이밍 등급 (A / B / C)
  const timingGrade = calcTimingGrade(monthlyRows, weeklyRows, spotPrice);

  // iv_skew (가장 가까운 Monthly)
  const ivSkew = primary.iv_skew ?? null;

  // total_score: 기존 호환용 (strength 절대값 × 타이밍 가중치)
  const timingWeight = timingGrade === 'A' ? 1.5 : timingGrade === 'B' ? 1.2 : 1.0;
  const totalScore   = Math.round(Math.abs(strengthScore) * timingWeight * 10) / 10;

  const row = {
    date,
    symbol,
    close:          spotPrice,
    bb_position:    priceInfo?.bbPosition ?? null,
    bb_flag:        null,
    iv_skew:        ivSkew,
    score_skew:     0,   // 기존 호환 (미사용)
    score_bb:       0,
    score_vol_squeeze: 0,
    skew_strength:  null,
    total_score:    totalScore,
    // 새 필드
    strength_score: strengthScore,
    timing_grade:   timingGrade,
    flip_strike:    primary.flip_strike,
    monthly_count:  monthlyRows.length,
  };

  // D1 저장
  const res = await fetch(`${cfWorkerUrl}/d1/screener-scores`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'x-cron-secret': cfKvSecret,
    },
    body: JSON.stringify({ rows: [row] }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`screener-scores write failed: ${res.status}`);

  return { symbol, strengthScore, timingGrade, totalScore, flipStrike: primary.flip_strike };
}

// ============================================
// 5. options_dex 저장
// ============================================
export async function saveOptionsFlow(cfWorkerUrl, cfKvSecret, records) {
  if (!records?.length) return 0;

  const res = await fetch(`${cfWorkerUrl}/d1/options-dex`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'x-cron-secret': cfKvSecret,
    },
    body: JSON.stringify({ rows: records }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`options-dex write failed: ${res.status}`);
  return records.length;
}

// ============================================
// 6. Cron 진입점
// ============================================
export async function runScreener(env) {
  const CF_WORKER_URL = env.CF_KV_URL;       // CF Worker URL
  const CF_KV_SECRET  = env.CF_KV_SECRET;
  const TWELVE_KEY    = env.TWELVE_KEY;
  const today         = getToday();

  console.log(`[Screener] 시작: ${today}`);

  // 수집 대상 종목 조회
  const targetsRes = await fetch(`${CF_WORKER_URL}/api/collect-targets`, {
    headers: { 'x-cron-secret': CF_KV_SECRET },
    signal: AbortSignal.timeout(10000),
  });
  const targetsData = await targetsRes.json();
  const symbols = (targetsData.symbols ?? []).map(s => s.symbol);

  console.log(`[Screener] 대상 종목: ${symbols.length}개`);

  const results = [];

  for (const symbol of symbols) {
    try {
      // 1. 가격 수집 (Yahoo Finance + Twelve Data avg_volume)
      const priceResult = await collectPriceIndicators(
        symbol, CF_WORKER_URL, CF_KV_SECRET, TWELVE_KEY
      );

      const spotPrice = priceResult?.close     ?? null;
      const avgVolume = priceResult?.avgVolume ?? null;

      // 2. 옵션체인 수집 (Barchart)
      const flowRows = await fetchOptionsData(symbol, spotPrice);
      if (!flowRows?.length) {
        console.warn(`[${symbol}] 옵션 데이터 없음 — 스킵`);
        await sleep(300);
        continue;
      }

      // 3. options_dex 저장
      await saveOptionsFlow(CF_WORKER_URL, CF_KV_SECRET, flowRows);

      // 4. 강도 점수 + 타이밍 등급 계산 + screener_scores 저장
      const score = await calcAndSaveScore(
        CF_WORKER_URL, CF_KV_SECRET,
        symbol, today, flowRows,
        { close: spotPrice, avgVolume, bbPosition: priceResult?.bbPosition }
      );

      if (score) {
        results.push(score);
        console.log(`[${symbol}] strength=${score.strengthScore} grade=${score.timingGrade} flip=$${score.flipStrike}`);
      }

    } catch (err) {
      console.error(`[${symbol}] 처리 실패:`, err.message);
    }

    await sleep(300);
  }

  // 결과 요약
  const top5 = [...results]
    .sort((a, b) => Math.abs(b.strengthScore) - Math.abs(a.strengthScore))
    .slice(0, 5);

  console.log(`[Screener] 완료: ${results.length}/${symbols.length}종목 통과`);
  console.log(`[Screener] Top5:`, top5.map(r =>
    `${r.symbol}(${r.strengthScore > 0 ? '+' : ''}${r.strengthScore}/${r.timingGrade})`
  ).join(', '));

  return results;
}
