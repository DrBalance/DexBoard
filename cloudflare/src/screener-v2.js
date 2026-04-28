// ============================================
// screener-v2.js — 종합 스크리너
// Barchart 옵션 + Twelve Data 가격 → 점수화 → D1
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
// 1. 옵션체인 수집 (Barchart) — 스트라이크별 포함
// ============================================
export async function fetchOptionsData(symbol, spotPrice) {
  try {
    // 스트라이크별 데이터가 필요하므로 fields에 strikePrice 추가
    const url = `${BARCHART_BASE}/proxies/core-api/v1/options/chain`
      + `?symbol=${symbol}`
      + `&startDate=${getToday()}`
      + `&endDate=${getDateAfterDays(56)}`
      + `&fields=symbol,expiration,strikePrice,callOpenInterest,putOpenInterest,`
      + `callVolume,putVolume,impliedVolatility,delta`
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
// 2. 옵션체인 파싱 — 만기별 + ATM 풋 집중도
// ============================================
function parseOptionsChain(symbol, data, spotPrice) {
  if (!data?.data) return null;

  const today   = getToday();
  const results = [];
  const byExpiry = {};

  for (const row of data.data) {
    const expiry = row.expiration;
    const strike = row.strikePrice || 0;

    if (!byExpiry[expiry]) {
      byExpiry[expiry] = {
        call_vol: 0, put_vol: 0,
        call_oi:  0, put_oi:  0,
        atm_put_oi: 0,          // ATM ±5% 풋 OI
        ivs: [],
      };
    }

    const d = byExpiry[expiry];
    d.call_vol += row.callVolume || 0;
    d.put_vol  += row.putVolume  || 0;
    d.call_oi  += row.callOpenInterest || 0;
    d.put_oi   += row.putOpenInterest  || 0;

    // ATM ±5% 풋 OI 집계
    if (spotPrice && strike > 0) {
      const pct = Math.abs(strike - spotPrice) / spotPrice;
      if (pct <= 0.05) {
        d.atm_put_oi += row.putOpenInterest || 0;
      }
    }

    if (row.impliedVolatility) {
      d.ivs.push({
        iv:    row.impliedVolatility,
        delta: Math.abs(row.delta || 0.5),
      });
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

    results.push({
      date:             today,
      symbol,
      expiry_date:      expiry,
      dte,
      call_vol:         d.call_vol,
      put_vol:          d.put_vol,
      call_oi:          d.call_oi,
      put_oi:           d.put_oi,
      pcr_vol:          d.put_vol / (d.call_vol || 1),
      pcr_oi:           d.put_oi  / (d.call_oi  || 1),
      atm_iv:           avg(atmIVs.map(x => x.iv)),
      otm_call_iv:      otmCallIV,
      otm_put_iv:       otmPutIV,
      atm_put_oi_ratio: d.put_oi > 0 ? d.atm_put_oi / d.put_oi : 0,
      iv_skew:          (otmCallIV && otmPutIV) ? otmCallIV - otmPutIV : null,
    });
  }

  return results;
}

// ============================================
// 3. options_flow 저장
// ============================================
export async function saveOptionsFlow(db, records) {
  if (!records?.length) return 0;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO options_flow
      (date, symbol, expiry_date, dte,
       call_vol, put_vol, call_oi, put_oi,
       pcr_vol, pcr_oi, atm_iv, otm_call_iv, otm_put_iv,
       atm_put_oi_ratio, iv_skew)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const batch = records.map(r => stmt.bind(
    r.date, r.symbol, r.expiry_date, r.dte,
    r.call_vol, r.put_vol, r.call_oi, r.put_oi,
    r.pcr_vol, r.pcr_oi, r.atm_iv, r.otm_call_iv, r.otm_put_iv,
    r.atm_put_oi_ratio, r.iv_skew
  ));

  await db.batch(batch);
  return records.length;
}

// ============================================
// 4. Baseline 업데이트 (변경 없음)
// ============================================
export async function updateBaseline(db, symbol) {
  const result = await db.prepare(`
    SELECT
      AVG(call_vol)    as avg_call_vol,
      AVG(put_vol)     as avg_put_vol,
      AVG(call_oi)     as avg_call_oi,
      AVG(put_oi)      as avg_put_oi,
      AVG(pcr_vol)     as avg_pcr_vol,
      AVG(pcr_oi)      as avg_pcr_oi,
      AVG(atm_iv)      as avg_atm_iv,
      AVG(otm_call_iv) as avg_otm_call_iv,
      AVG(otm_put_iv)  as avg_otm_put_iv,
      AVG(call_vol * call_vol) - AVG(call_vol) * AVG(call_vol) as var_call_vol,
      AVG(call_oi  * call_oi)  - AVG(call_oi)  * AVG(call_oi)  as var_call_oi,
      AVG(pcr_oi   * pcr_oi)   - AVG(pcr_oi)   * AVG(pcr_oi)   as var_pcr_oi,
      AVG(otm_call_iv * otm_call_iv) - AVG(otm_call_iv) * AVG(otm_call_iv) as var_otm_call_iv
    FROM options_flow
    WHERE symbol = ? AND date >= date('now', '-20 days')
  `).bind(symbol).first();

  if (!result) return;

  await db.prepare(`
    INSERT OR REPLACE INTO options_baseline
      (symbol, updated_date,
       avg_call_vol, avg_put_vol, avg_call_oi, avg_put_oi,
       avg_pcr_vol, avg_pcr_oi,
       avg_atm_iv, avg_otm_call_iv, avg_otm_put_iv,
       std_call_vol, std_call_oi, std_pcr_oi, std_otm_call_iv)
    VALUES (?, date('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    symbol,
    result.avg_call_vol,  result.avg_put_vol,
    result.avg_call_oi,   result.avg_put_oi,
    result.avg_pcr_vol,   result.avg_pcr_oi,
    result.avg_atm_iv,    result.avg_otm_call_iv, result.avg_otm_put_iv,
    Math.sqrt(Math.max(0, result.var_call_vol)),
    Math.sqrt(Math.max(0, result.var_call_oi)),
    Math.sqrt(Math.max(0, result.var_pcr_oi)),
    Math.sqrt(Math.max(0, result.var_otm_call_iv))
  ).run();
}

// ============================================
// 5. 점수 계산
// ============================================

// A. 콜 스큐 지속 주수 (D1에서 과거 4주 조회)
async function calcSkewWeeks(db, symbol) {
  const rows = await db.prepare(`
    SELECT date, AVG(iv_skew) as avg_skew
    FROM options_flow
    WHERE symbol = ?
      AND date >= date('now', '-28 days')
      AND iv_skew IS NOT NULL
    GROUP BY strftime('%W', date)  -- 주차별 그룹
    ORDER BY date DESC
    LIMIT 4
  `).bind(symbol).all();

  // 최근부터 연속 콜 스큐(양수) 주수 카운트
  let weeks = 0;
  for (const row of rows.results) {
    if (row.avg_skew > 0) weeks++;
    else break;
  }
  return Math.min(weeks, 3); // 최대 3점
}

// B. 볼린저 위치 점수
function calcBBScore(bbPosition) {
  // bbPosition: 0 = -2σ(하단), 1 = +2σ(상단)
  // 하단에 가까울수록 높은 점수
  if (bbPosition < 0)    return { score: 0, flag: 'BREAKDOWN' }; // -2σ 이탈
  if (bbPosition < 0.05) return { score: 3, flag: null };         // -2σ 밀착
  if (bbPosition < 0.16) return { score: 2, flag: null };         // -1.5σ 근접
  if (bbPosition < 0.32) return { score: 1, flag: null };         // -1σ 근접
  return { score: 0, flag: null };
}

// C. ATM 풋 집중도 점수
function calcATMPutScore(atm_put_oi_ratio) {
  if (!atm_put_oi_ratio) return 0;
  if (atm_put_oi_ratio > 0.7) return 2;
  if (atm_put_oi_ratio > 0.5) return 1;
  return 0;
}

// D. 변동폭 수축 점수
function calcVolSqueezeScore(vol_ratio) {
  if (!vol_ratio) return 0;
  if (vol_ratio < 0.7) return 2; // atr5 < atr20의 70%
  if (vol_ratio < 1.0) return 1; // atr5 < atr20
  return 0;
}

// ============================================
// 6. 종합 점수 계산 + 저장 (종목 단위)
// ============================================
export async function calcAndSaveScore(db, symbol, today) {
  // 오늘 옵션 데이터 (만기별 평균으로 집계)
  const optRow = await db.prepare(`
    SELECT
      AVG(atm_put_oi_ratio) as atm_put_ratio,
      AVG(iv_skew)          as iv_skew
    FROM options_flow
    WHERE symbol = ? AND date = ? AND dte BETWEEN 7 AND 56
  `).bind(symbol, today).first();

  // 오늘 가격 지표
  const priceRow = await db.prepare(`
    SELECT bb_position, vol_ratio, close
    FROM price_indicators
    WHERE symbol = ? AND date = ?
  `).bind(symbol, today).first();

  if (!optRow || !priceRow) return null;

  // 섹터 정보
  const symRow = await db.prepare(`
    SELECT sector, sector_etf FROM symbols WHERE symbol = ?
  `).bind(symbol).first();

  const skewWeeks = await calcSkewWeeks(db, symbol);
  const bbResult  = calcBBScore(priceRow.bb_position);

  const scoreSkew   = skewWeeks;
  const scoreBB     = bbResult.score;
  const scoreATMPut = calcATMPutScore(optRow.atm_put_ratio);
  const scoreVol    = calcVolSqueezeScore(priceRow.vol_ratio);
  const total       = scoreSkew + scoreBB + scoreATMPut + scoreVol;

  await db.prepare(`
    INSERT OR REPLACE INTO screener_scores
      (date, symbol, sector, sector_etf,
       score_skew_weeks, score_bb, score_atm_put, score_vol_squeeze,
       total_score, bb_position, bb_flag, iv_skew, skew_weeks, close)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    today, symbol,
    symRow?.sector    || null,
    symRow?.sector_etf || null,
    scoreSkew, scoreBB, scoreATMPut, scoreVol,
    total,
    priceRow.bb_position,
    bbResult.flag,
    optRow.iv_skew,
    skewWeeks,
    priceRow.close
  ).run();

  return { symbol, total, scoreSkew, scoreBB, scoreATMPut, scoreVol, flag: bbResult.flag };
}

// ============================================
// 7. 스크리너 결과 쿼리
// ============================================
export async function getScreenerResults(db, date = null) {
  const targetDate = date || getToday();

  const rows = await db.prepare(`
    SELECT
      sc.symbol,
      s.name,
      s.type,
      sc.sector,
      sc.sector_etf,
      sc.total_score,
      sc.score_skew_weeks,
      sc.score_bb,
      sc.score_atm_put,
      sc.score_vol_squeeze,
      sc.bb_position,
      sc.bb_flag,
      sc.iv_skew,
      sc.skew_weeks,
      sc.close
    FROM screener_scores sc
    JOIN symbols s USING (symbol)
    WHERE sc.date = ?
      AND s.is_active = 1
    ORDER BY sc.total_score DESC, sc.sector, sc.symbol
  `).bind(targetDate).all();

  return rows.results;
}

// ============================================
// 8. Cron 진입점 (worker.js에서 호출)
// ============================================
export async function runScreener(env) {
  const db      = env.DB;
  const apiKey  = env.TWELVEDATA_KEY;
  const today   = getToday();

  console.log(`[Screener] 시작: ${today}`);

  // 활성 종목 목록
  const symbols = await db.prepare(
    `SELECT symbol FROM symbols WHERE is_active = 1`
  ).all();

  const results = [];

  for (const { symbol } of symbols.results) {
    // 1. 가격 수집 + 볼린저 계산 (Twelve Data)
    const priceResult = await collectPriceIndicators(db, symbol, apiKey);

    // 2. 현재가 (ATM 풋 집중도 계산용)
    const spotPrice = priceResult?.close ?? null;

    // 3. 옵션체인 수집 (Barchart)
    const optRecords = await fetchOptionsData(symbol, spotPrice);
    if (optRecords?.length) {
      await saveOptionsFlow(db, optRecords);
    }

    // 4. Baseline 업데이트
    await updateBaseline(db, symbol);

    // 5. 점수 계산 + 저장
    const score = await calcAndSaveScore(db, symbol, today);
    if (score) results.push(score);

    // API 레이트 리밋 방지 (Twelve Data: 8req/min 무료)
    await sleep(500);
  }

  // 결과 요약 로그
  const top5 = results
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  console.log(`[Screener] 완료: ${results.length}종목`);
  console.log(`[Screener] Top5:`, top5.map(r => `${r.symbol}(${r.total})`).join(', '));

  return results;
}

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
