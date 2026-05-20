// ============================================
// screener-engine.js — Railway 전용 스크리너 엔진 v3
//
// 설계 원칙:
//   - 먼슬리 옵션 체인만 대상 (기관 헤지 포지션 집중 구간)
//   - Net GEX 계산 (딜러 헤징 압력 절대값)
//   - 플립존 계산 (DEX 부호 전환점 = 딜러 행동 역전 수준)
//   - ATM IV 계산 (옵션 비용 상태)
//   - 일별 스냅샷 D1 저장 (90일 보관)
//
// 데이터 소스: CBOE (15분 지연)
// 저장 테이블: screener_gex_daily
// ============================================

const CBOE_BASE  = 'https://cdn.cboe.com/api/global/delayed_quotes/options';
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

// ============================================
// 유틸리티
// ============================================
function getToday() {
  return new Date().toISOString().split('T')[0];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 표준 먼슬리 판별 (매달 3번째 금요일)
// CBOE가 일부 만기를 목요일로 표기하는 경우도 처리
function isStandardMonthly(dateStr) {
  const d   = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();
  const day = d.getDate();

  if (dow === 5) return day >= 15 && day <= 21;           // 금요일 직접 판별
  if (dow === 4) return (day + 1) >= 15 && (day + 1) <= 21; // 목요일 → 다음날 확인
  return false;
}

// DTE 계산
function calcDte(expiryStr) {
  const now    = new Date();
  const expiry = new Date(expiryStr + 'T16:00:00');
  return Math.max(0, Math.round((expiry - now) / 86400000));
}

// ============================================
// 현재가 조회 (Yahoo Finance)
// ============================================
export async function fetchSpotPrice(symbol) {
  try {
    const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal:  AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    const json  = await res.json();
    const meta  = json?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice ?? meta?.previousClose ?? null;
    if (!price) throw new Error('price not found');
    return price;
  } catch (err) {
    console.warn(`[${symbol}] spot price 조회 실패:`, err.message);
    return null;
  }
}

// ============================================
// CBOE 옵션 체인 수집 (먼슬리만)
// ============================================
export async function collectMonthlyChain(symbol) {
  try {
    const url = `${CBOE_BASE}/${encodeURIComponent(symbol)}.json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal:  AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`CBOE HTTP ${res.status}`);

    const json = await res.json();
    const data = json?.data;
    if (!data) throw new Error('CBOE: data 없음');

    const spot    = data.current_price ?? data.close ?? null;
    const options = data.options ?? [];

    if (!spot || !options.length) throw new Error('CBOE: spot or options 없음');

    // 먼슬리 만기만 필터
    const monthlyOptions = options.filter(exp => isStandardMonthly(exp.expiration_date));

    if (!monthlyOptions.length) {
      console.warn(`[${symbol}] 먼슬리 만기 없음`);
      return { spot, chain: [] };
    }

    // 모든 먼슬리 만기의 스트라이크 데이터 평탄화
    const chain = [];
    for (const exp of monthlyOptions) {
      const expiry = exp.expiration_date;
      const dte    = calcDte(expiry);

      // DTE 범위 제한: 7일~90일 (너무 짧거나 긴 건 제외)
      if (dte < 7 || dte > 90) continue;

      const calls = exp.calls ?? [];
      const puts  = exp.puts  ?? [];

      // 스트라이크 기준으로 call/put 매핑
      const callMap = {};
      for (const c of calls) {
        const strike = parseFloat(c.strike ?? c.strike_price ?? 0);
        if (!strike) continue;
        callMap[strike] = {
          iv:    parseFloat(c.iv ?? c.implied_volatility ?? 0),
          gamma: parseFloat(c.gamma ?? 0),
          oi:    parseInt(c.open_interest ?? 0),
        };
      }

      for (const p of puts) {
        const strike = parseFloat(p.strike ?? p.strike_price ?? 0);
        if (!strike) continue;
        const call = callMap[strike] ?? {};
        chain.push({
          expiry,
          dte,
          strike,
          call_oi:    call.oi    ?? 0,
          call_iv:    call.iv    ?? 0,
          call_gamma: call.gamma ?? 0,
          put_oi:     parseInt(p.open_interest ?? 0),
          put_iv:     parseFloat(p.iv ?? p.implied_volatility ?? 0),
          put_gamma:  parseFloat(p.gamma ?? 0),
        });
      }
    }

    return { spot, chain };

  } catch (err) {
    console.error(`[${symbol}] 체인 수집 실패:`, err.message);
    return null;
  }
}

// ============================================
// Net GEX 계산
// GEX = gamma × OI × spot² × 0.01 (1계약 = 100주)
// Call GEX: 딜러 숏 콜 → 상승 시 매수 (양수)
// Put GEX:  딜러 숏 풋 → 하락 시 매도 (음수)
// ============================================
export function calcNetGex(chain, spot) {
  if (!chain?.length || !spot) return null;

  let totalGex = 0;

  for (const row of chain) {
    const callGex = row.call_gamma * row.call_oi * spot * spot * 0.01;
    const putGex  = row.put_gamma  * row.put_oi  * spot * spot * 0.01 * -1;
    totalGex += callGex + putGex;
  }

  // 달러 단위로 반환 ($B 표기용)
  return Math.round(totalGex * 100) / 100;
}

// ============================================
// 플립존 계산 (DEX 부호 전환점)
// 스트라이크별 누적 GEX가 0을 교차하는 지점
// ============================================
export function calcFlipStrike(chain, spot) {
  if (!chain?.length || !spot) return null;

  // 스트라이크별 GEX 합산
  const gexByStrike = {};
  for (const row of chain) {
    const s = row.strike;
    if (!gexByStrike[s]) gexByStrike[s] = 0;
    gexByStrike[s] += row.call_gamma * row.call_oi * spot * spot * 0.01;
    gexByStrike[s] -= row.put_gamma  * row.put_oi  * spot * spot * 0.01;
  }

  const strikes = Object.keys(gexByStrike)
    .map(Number)
    .sort((a, b) => a - b);

  if (strikes.length < 2) return null;

  // spot 기준 ±15% 범위 내에서 부호 전환점 탐색
  const range = spot * 0.15;
  const near  = strikes.filter(s => Math.abs(s - spot) <= range);
  if (near.length < 2) return null;

  // 누적 GEX (하단 → 상단)
  let cumGex = 0;
  let flipStrike = null;

  for (let i = 0; i < near.length; i++) {
    const prevCum = cumGex;
    cumGex += gexByStrike[near[i]];

    if (i > 0 && prevCum < 0 && cumGex >= 0) {
      flipStrike = near[i];
      break;
    }
    if (i > 0 && prevCum >= 0 && cumGex < 0) {
      flipStrike = near[i - 1];
      break;
    }
  }

  return flipStrike;
}

// ============================================
// ATM IV 계산
// spot에 가장 가까운 스트라이크의 call/put IV 평균
// ============================================
export function calcAtmIv(chain, spot) {
  if (!chain?.length || !spot) return null;

  // spot과 가장 가까운 스트라이크 찾기
  const strikes = [...new Set(chain.map(r => r.strike))];
  const atm = strikes.reduce((prev, curr) =>
    Math.abs(curr - spot) < Math.abs(prev - spot) ? curr : prev
  );

  const atmRows = chain.filter(r => r.strike === atm);
  if (!atmRows.length) return null;

  const ivs = [];
  for (const r of atmRows) {
    if (r.call_iv > 0) ivs.push(r.call_iv);
    if (r.put_iv  > 0) ivs.push(r.put_iv);
  }

  if (!ivs.length) return null;
  return Math.round((ivs.reduce((a, b) => a + b, 0) / ivs.length) * 10000) / 10000;
}

// ============================================
// 종목 전체 분석 (수집 + 계산 통합)
// ============================================
export async function analyzeSymbol(symbol) {
  const result = await collectMonthlyChain(symbol);
  if (!result) return null;

  const { spot, chain } = result;
  if (!chain.length) return null;

  const netGex     = calcNetGex(chain, spot);
  const flipStrike = calcFlipStrike(chain, spot);
  const atmIv      = calcAtmIv(chain, spot);
  const distPct    = flipStrike
    ? Math.round(((spot - flipStrike) / flipStrike) * 10000) / 100
    : null;

  return {
    symbol,
    spot_price:   Math.round(spot * 100) / 100,
    net_gex:      netGex,
    flip_strike:  flipStrike,
    distance_pct: distPct,
    atm_iv:       atmIv,
  };
}

// ============================================
// D1 저장 (screener_gex_daily)
// ============================================
export async function saveGexDaily(cfWorkerUrl, cronSecret, rows, date) {
  if (!rows?.length) return { ok: false, error: 'no rows' };

  const payload = rows.map(r => ({ ...r, date: date ?? getToday() }));

  try {
    const res = await fetch(`${cfWorkerUrl}/d1/screener-gex-daily`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-cron-secret': cronSecret,
      },
      body:   JSON.stringify({ rows: payload }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) throw new Error(`D1 write failed: ${res.status}`);
    return { ok: true, count: payload.length };

  } catch (err) {
    console.error('[screener] D1 저장 실패:', err.message);
    return { ok: false, error: err.message };
  }
}

// ============================================
// 90일 이전 데이터 정리
// ============================================
export async function purgeOldGexData(cfWorkerUrl, cronSecret) {
  try {
    const res = await fetch(`${cfWorkerUrl}/d1/screener-gex-daily/purge`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-cron-secret': cronSecret,
      },
      body:   JSON.stringify({ days: 90 }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`purge failed: ${res.status}`);
    const data = await res.json();
    console.log(`[screener] 90일 초과 데이터 삭제: ${data.deleted ?? 0}건`);
    return data;
  } catch (err) {
    console.warn('[screener] purge 실패:', err.message);
    return null;
  }
}

// ============================================
// 스크리너 심볼 목록 조회 (D1 → screener_symbols)
// ============================================
export async function fetchScreenerSymbols(cfWorkerUrl, cronSecret) {
  try {
    const res = await fetch(`${cfWorkerUrl}/api/screener/symbols`, {
      headers: { 'x-cron-secret': cronSecret },
      signal:  AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`symbols fetch failed: ${res.status}`);
    const data = await res.json();
    return data.symbols ?? [];
  } catch (err) {
    console.error('[screener] 심볼 목록 조회 실패:', err.message);
    return [];
  }
}

// ============================================
// 메인 수집 루틴
// Railway에서 호출 (수동 버튼 or cron)
// ============================================
export async function runScreenerCollection(cfWorkerUrl, cronSecret, symbols, onProgress) {
  const date    = getToday();
  const results = [];
  const errors  = [];

  console.log(`[screener] 수집 시작 — ${symbols.length}개 종목 (${date})`);

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];

    try {
      const analyzed = await analyzeSymbol(sym);

      if (analyzed) {
        results.push(analyzed);
        console.log(`[${sym}] ✓ GEX=${analyzed.net_gex?.toFixed(2)} flip=${analyzed.flip_strike}`);
      } else {
        console.warn(`[${sym}] 분석 결과 없음`);
        errors.push({ symbol: sym, error: 'no result' });
      }

    } catch (err) {
      console.error(`[${sym}] 오류:`, err.message);
      errors.push({ symbol: sym, error: err.message });
    }

    // 진행상황 콜백
    if (onProgress) {
      onProgress({ done: i + 1, total: symbols.length, errors: errors.length });
    }

    // CBOE 부하 방지 (종목 간 딜레이)
    if (i < symbols.length - 1) await sleep(1200);
  }

  // D1 저장
  let saveResult = { ok: false };
  if (results.length) {
    saveResult = await saveGexDaily(cfWorkerUrl, cronSecret, results, date);
  }

  // 90일 초과 데이터 정리
  await purgeOldGexData(cfWorkerUrl, cronSecret);

  console.log(`[screener] 수집 완료 — 성공 ${results.length}개, 실패 ${errors.length}개`);

  return {
    ok:      saveResult.ok,
    date,
    count:   results.length,
    errors:  errors.length,
    results,
    errorList: errors,
  };
}
