// ============================================
// screener-engine.js — Railway 전용 스크리너 엔진 v5
//
// 설계 원칙:
//   - vanna_analyzer.js의 검증된 파이프라인 재사용
//     (filterOptionsScreener → aggregateByExpiry → calcGreeks BS 재계산)
//   - 2개월 내 전체 만기(weekly + monthly) 약 8개 대상
//   - Call Wall 감지: 만기별 최대 콜 DEX 스트라이크가 동일 스트라이크에
//     4개 이상 집중 → target_strike / concentration_count / distance_pct 저장
//   - 저장 방식: DELETE + INSERT (종목당 최신 만기 8~9행만 유지)
//   - PRIMARY KEY: (symbol, expiry_date)
//   - watchlist 주 1회 스캔: is_watchlist=FALSE 후보 → Call Wall 통과 시 승격
//     CBOE 요청 간격을 랜덤하게 분산하여 IP 제한 방지
// ============================================

import {
  parseOption,
  filterOptionsScreener,
  aggregateByExpiry,
  classifyExpiry,
  calcGreeks,
} from './vanna_analyzer.js';

const CBOE_BASE  = 'https://cdn.cboe.com/api/global/delayed_quotes/options';
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

// ============================================
// 유틸리티
// ============================================
function getTodayET() {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const y = nowET.getFullYear();
  const m = String(nowET.getMonth() + 1).padStart(2, '0');
  const d = String(nowET.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 기본 딜레이 + 랜덤 지터 (CBOE IP 제한 방지)
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function jitteredDelay(baseMs, jitterMs = 500) {
  return sleep(baseMs + Math.random() * jitterMs);
}

// ============================================
// CBOE 옵션 체인 fetch
// ============================================
async function fetchCBOEChain(symbol) {
  const url = `${CBOE_BASE}/${encodeURIComponent(symbol)}.json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal:  AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`CBOE HTTP ${res.status} for ${symbol}`);
  return res.json();
}

// ============================================
// Call Wall 계산
//
// aggregateByExpiry 결과(rows[])에서:
//   1. 만기별로 콜 DEX가 가장 큰 스트라이크 1개 추출
//   2. 동일 스트라이크가 몇 개 만기에서 등장하는지 카운팅
//   3. 최다 등장 스트라이크 + 카운트 반환
//   4. concentration_count >= 4 이면 Call Wall로 판정
// ============================================
function calcCallWall(rows, spot) {
  if (!rows?.length || !spot) return { target_strike: null, concentration_count: 0, distance_pct: null };

  // 만기별 최대 콜 DEX 스트라이크 추출
  // rows[].dex 는 해당 만기 전체 합산값이고,
  // 스트라이크별 콜 DEX는 _strikeRows에 있음
  const peakStrikes = [];
  const peakByExpiry = {};  // 만기별 최대 콜DEX 스트라이크 맵

  for (const row of rows) {
    const strikeRows = row._strikeRows;
    if (!strikeRows?.length) continue;

    let maxDex  = -Infinity;
    let maxStrike = null;

    for (const s of strikeRows) {
      // dex 양수 = 콜 DEX — 히트맵 _stExtractKeyLevels()와 동일한 기준
      // spot 조건 없음: 전체 스트라이크에서 최대 콜 DEX 탐지
      if (s.dex == null || s.dex <= 0 || s.strike <= spot) continue;
      if (s.dex > maxDex) {
        maxDex    = s.dex;
        maxStrike = s.strike;
      }
    }

    if (maxStrike !== null) {
      peakStrikes.push(maxStrike);
      peakByExpiry[row.expiry_date] = { strike: maxStrike, dex: maxDex };
    }
  }

  if (!peakStrikes.length) return { target_strike: null, concentration_count: 0, distance_pct: null };

  // 스트라이크별 등장 횟수 카운팅
  const counts = {};
  for (const s of peakStrikes) {
    counts[s] = (counts[s] ?? 0) + 1;
  }

  // 최다 등장 스트라이크
  let targetStrike = null;
  let maxCount     = 0;
  for (const [strike, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount     = count;
      targetStrike = Number(strike);
    }
  }

  const distancePct = targetStrike
    ? Math.round(((spot - targetStrike) / targetStrike) * 10000) / 100
    : null;

  return {
    target_strike:       targetStrike,
    concentration_count: maxCount,
    distance_pct:        distancePct,
    peakByExpiry:        peakByExpiry,  // 만기별 최대 콜DEX 스트라이크 맵
  };
}

// ============================================
// 다음 먼슬리 만기 탐지
// expiry_type === 'monthly' 기준, DTE > 0인 것 중 가장 가까운 것
// ============================================
function findNextMonthly(rows) {
  return rows
    .filter(r => r.expiry_type === 'monthly' && r.dte > 0)
    .sort((a, b) => a.dte - b.dte)[0] ?? null;
}

// ============================================
// 스퀴즈 계산
//
// 조건 1: 가장 짧은 3개 만기 중 최단 만기 포함 + 2개 이상이
//         target_strike와 일치하는 콜 DEX 고점 보유
// 조건 2: 5DTE 이하 콜 DEX 합산 / 다음 먼슬리 콜 DEX >= 40%
// 조건 3: 12DTE 이하 콜 DEX 합산 / 다음 먼슬리 콜 DEX >= 70%
//
// 각 조건 독립적으로 별표 1개씩 부여 (최대 ★★★)
// ============================================
function calcSqueeze(rows, targetStrike) {
  const flags = [];

  if (!rows?.length || !targetStrike) {
    return { squeeze_stars: 0, squeeze_flags: null };
  }

  // 만기별 최대 콜 DEX 스트라이크 + DEX 값 추출 (DTE 오름차순)
  const sorted = [...rows].sort((a, b) => a.dte - b.dte);
  const expiryPeaks = [];

  for (const row of sorted) {
    const strikeRows = row._strikeRows;
    if (!strikeRows?.length) continue;

    let maxDex = -Infinity;
    let maxStrike = null;
    let maxDexValue = 0;

    for (const s of strikeRows) {
      if (s.dex == null || s.dex <= 0 || s.strike <= spot) continue;
      if (s.dex > maxDex) {
        maxDex      = s.dex;
        maxStrike   = s.strike;
        maxDexValue = s.dex;
      }
    }

    if (maxStrike !== null) {
      expiryPeaks.push({
        expiry_date: row.expiry_date,
        dte:         row.dte,
        peak_strike: maxStrike,
        peak_dex:    maxDexValue,
      });
    }
  }

  if (!expiryPeaks.length) return { squeeze_stars: 0, squeeze_flags: null };

  // 가장 짧은 3개 만기
  const shortest3 = expiryPeaks.slice(0, 3);
  // target_strike와 일치하는 것
  const matchInShortest3 = shortest3.filter(e => e.peak_strike === targetStrike);
  // 최단 만기 포함 여부
  const shortestIncluded = shortest3[0]?.peak_strike === targetStrike;

  // 조건 1
  if (shortestIncluded && matchInShortest3.length >= 2) {
    flags.push(1);
  }

  // 다음 먼슬리 DEX (rows에서 직접 계산)
  const nextMonthlyRow = findNextMonthly(rows);
  if (nextMonthlyRow) {
    const monthlyStrikeRows = nextMonthlyRow._strikeRows ?? [];
    let monthlyPeakDex = 0;
    for (const s of monthlyStrikeRows) {
      if (s.dex != null && s.dex > monthlyPeakDex) monthlyPeakDex = s.dex;
    }

    if (monthlyPeakDex > 0) {
      // 5DTE 이하 DEX 합산
      const dex5 = expiryPeaks
        .filter(e => e.dte <= 5)
        .reduce((sum, e) => sum + e.peak_dex, 0);

      // 12DTE 이하 DEX 합산
      const dex12 = expiryPeaks
        .filter(e => e.dte <= 12)
        .reduce((sum, e) => sum + e.peak_dex, 0);

      // 조건 2
      if (dex5 / monthlyPeakDex >= 0.4) flags.push(2);
      // 조건 3
      if (dex12 / monthlyPeakDex >= 0.7) flags.push(3);
    }
  }

  return {
    squeeze_stars: flags.length,
    squeeze_flags: flags.length ? flags.join(',') : null,
  };
}

// ============================================
// 단일 종목 분석
// vanna_analyzer.js의 collectSymbol 로직을 직접 인라인
// (Railway 환경에서 D1 저장은 별도로 처리)
// ============================================
export async function analyzeSymbol(symbol) {
  const raw = await fetchCBOEChain(symbol);
  const all = raw?.data?.options ?? [];
  if (!all.length) throw new Error(`CBOE: ${symbol} 옵션 데이터 없음`);

  const spot = raw?.data?.current_price ?? raw?.data?.close ?? null;
  if (!spot) throw new Error(`CBOE: ${symbol} 현재가 없음`);

  // filterOptionsScreener: DTE 3~60, OI > 0
  // aggregateByExpiry: 만기별 집계, ivCount 방식, calcGreeks BS 재계산
  const rows = aggregateByExpiry(all, spot);
  if (!rows.length) throw new Error(`${symbol}: 유효한 만기 데이터 없음`);

  // Call Wall 계산 (_strikeRows 사용 전에 먼저 계산)
  const callWall = calcCallWall(rows, spot);

  // 스퀴즈 계산 (_strikeRows 사용 전에 계산)
  const squeeze = calcSqueeze(rows, callWall.target_strike);

  const dbRows = rows.map(r => {
    const strikeData = r._strikeRows?.length
      ? JSON.stringify(r._strikeRows.map(s => ({
          strike:     s.strike,
          call_iv:    s.call_iv    ?? null,
          put_iv:     s.put_iv     ?? null,
          avg_iv:     s.avg_iv     ?? null,
          call_delta: s.call_delta ?? null,
          call_oi:    s.call_oi    ?? null,
          put_oi:     s.put_oi     ?? null,
          dex:        s.dex        ?? null,
          gex:        s.gex        ?? null,
          vanna:      s.vanna      ?? null,
          charm:      s.charm      ?? null,
        })))
      : null;

    const row = { ...r };
    delete row._strikeRows;
    return {
      expiry_date:         row.expiry_date,
      dte:                 row.dte,
      expiry_type:         row.expiry_type,
      net_gex:             row.gex        != null ? +row.gex.toFixed(6)        : null,
      flip_strike:         row.flip_strike ?? null,
      atm_iv:              row.atm_iv     != null ? +row.atm_iv.toFixed(4)     : null,
      call_oi:             row.call_oi    ?? null,
      put_oi:              row.put_oi     ?? null,
      pcr_oi:              row.pcr_oi     ?? null,
      dex:                 row.dex        != null ? +row.dex.toFixed(6)        : null,
      vanna:               row.vanna      != null ? +row.vanna.toFixed(6)      : null,
      charm:               row.charm      != null ? +row.charm.toFixed(6)      : null,
      call_vol:            row.call_vol   ?? null,
      put_vol:             row.put_vol    ?? null,
      iv_skew:             row.iv_skew    != null ? +row.iv_skew.toFixed(4)   : null,
      otm_call_iv:         row.otm_call_iv != null ? +row.otm_call_iv.toFixed(4) : null,
      otm_put_iv:          row.otm_put_iv  != null ? +row.otm_put_iv.toFixed(4)  : null,
      strike_data:         strikeData,
      peak_call_dex_strike: callWall.peakByExpiry?.[r.expiry_date]?.strike ?? null,
      peak_call_dex_value:  callWall.peakByExpiry?.[r.expiry_date]?.dex    ?? null,
    };
  });

  // upside: distance_pct 부호 반전 (목표가 > 현재가이면 양수)
  const upside = callWall.distance_pct != null ? -callWall.distance_pct : null;

  return { symbol, spot, rows: dbRows, callWall, upside, squeeze };
}

// ============================================
// D1 저장 (DELETE + INSERT 방식)
// 종목당 최신 만기 데이터만 유지
// ============================================
export async function saveSymbolRows(cfWorkerUrl, cronSecret, symbol, rows, updatedAt) {
  if (!rows?.length) return { ok: false, error: 'no rows' };

  try {
    const res = await fetch(`${cfWorkerUrl}/d1/daily-screener`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-cron-secret': cronSecret,
      },
      body:   JSON.stringify({ ticker: symbol, rows, updated_at: updatedAt }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`D1 write failed: ${res.status}`);
    return { ok: true, count: rows.length };
  } catch (err) {
    console.error(`[${symbol}] D1 저장 실패:`, err.message);
    return { ok: false, error: err.message };
  }
}

// ============================================
// screened_tickers 집계값 업데이트
// ============================================
export async function updateScreenedTicker(cfWorkerUrl, cronSecret, symbol, spot, callWall, upside, rows, squeeze) {
  const totalGex = rows.reduce((s, r) => s + (r.net_gex ?? 0), 0);
  const firstRow = rows[0] ?? {};
  const atmIv    = rows.filter(r => r.atm_iv).reduce((s, r, _, a) => s + r.atm_iv / a.length, 0) || null;
  const nearestFlip = rows.find(r => r.flip_strike)?.flip_strike ?? null;

  try {
    const res = await fetch(`${cfWorkerUrl}/d1/screened-tickers/update`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-cron-secret': cronSecret,
      },
      body: JSON.stringify({
        ticker:              symbol,
        spot_price:          spot != null ? Math.round(spot * 100) / 100 : null,
        upside:              upside,
        concentration_count: callWall.concentration_count,
        target_strike:       callWall.target_strike,
        total_gex:           totalGex,
        atm_iv:              atmIv,
        flip_strike:         nearestFlip,
        squeeze_stars:       squeeze?.squeeze_stars ?? 0,
        squeeze_flags:       squeeze?.squeeze_flags ?? null,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`update failed: ${res.status}`);
    return { ok: true };
  } catch (err) {
    console.error(`[${symbol}] screened_tickers 업데이트 실패:`, err.message);
    return { ok: false, error: err.message };
  }
}


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
// watchlist.is_watchlist = TRUE 종목 대상
// 종목당 1200ms + 0~500ms 지터
// ============================================
export async function runScreenerCollection(cfWorkerUrl, cronSecret, symbols, onProgress) {
  const updatedAt = new Date().toISOString();
  const results   = [];
  const errors    = [];

  console.log(`[screener] 수집 시작 — ${symbols.length}개 종목 (${updatedAt})`);

  for (let i = 0; i < symbols.length; i++) {
    const sym = typeof symbols[i] === 'string' ? symbols[i] : symbols[i].symbol ?? symbols[i];

    try {
      const { rows, callWall, upside, squeeze, spot } = await analyzeSymbol(sym);
      const saveResult = await saveSymbolRows(cfWorkerUrl, cronSecret, sym, rows, updatedAt);

      if (saveResult.ok) {
        // screened_tickers 집계값 업데이트
        await updateScreenedTicker(cfWorkerUrl, cronSecret, sym, spot, callWall, upside, rows, squeeze);

        results.push({ symbol: sym, rows: rows.length, callWall });
        console.log(
          `[${sym}] ✓ ${rows.length}개 만기 저장` +
          (callWall.concentration_count >= 4
            ? ` | Call Wall $${callWall.target_strike} (${callWall.concentration_count}개 만기)`
            : '')
        );
      } else {
        throw new Error(saveResult.error);
      }

    } catch (err) {
      console.error(`[${sym}] 오류:`, err.message);
      errors.push({ symbol: sym, error: err.message });
    }

    if (onProgress) {
      onProgress({ done: i + 1, total: symbols.length, errors: errors.length });
    }

    // 마지막 종목 이후에는 딜레이 불필요
    if (i < symbols.length - 1) {
      await jitteredDelay(1200, 500);
    }
  }

  console.log(`[screener] 수집 완료 — 성공 ${results.length}개, 실패 ${errors.length}개`);

  return {
    ok:        errors.length < results.length || results.length > 0,
    updated_at: updatedAt,
    count:     results.length,
    errors:    errors.length,
    results,
    errorList: errors,
  };
}

// ============================================
// watchlist 후보 스캔 (주 1회)
//
// 전략:
//   - is_watchlist = FALSE 종목만 순회
//   - Call Wall 조건: concentration_count >= 4
//   - 통과 시 → is_watchlist = TRUE로 승격 요청
//   - CBOE 요청 분산:
//       * 기본 간격: 2000ms (일반 스크리너보다 여유있게)
//       * 지터: 0~1000ms 랜덤
//       * 10종목마다 5초 추가 휴식 (버스트 방지)
// ============================================
export async function runWatchlistScan(cfWorkerUrl, cronSecret, onProgress) {
  const errors    = [];
  const promoted  = [];
  const scanned   = [];
  const updatedAt = new Date().toISOString();

  // 스캔 시작 전 is_watchlist 동기화
  try {
    await fetch(`${cfWorkerUrl}/api/watchlist/sync-is-watchlist`, {
      method:  'POST',
      headers: { 'x-cron-secret': cronSecret },
      signal:  AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.warn('[watchlist] is_watchlist 동기화 실패:', e.message);
  }

  // is_watchlist = FALSE 후보 목록 조회 (screened_tickers WATCHLIST 제외 기준)
  let candidates = [];
  try {
    const res = await fetch(`${cfWorkerUrl}/api/watchlist/candidates`, {
      headers: { 'x-cron-secret': cronSecret },
      signal:  AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`candidates fetch failed: ${res.status}`);
    const data = await res.json();
    candidates = data.candidates ?? [];
  } catch (err) {
    console.error('[watchlist] 후보 목록 조회 실패:', err.message);
    return { ok: false, error: err.message };
  }

  if (!candidates.length) {
    console.log('[watchlist] 스캔할 후보 없음');
    return { ok: true, scanned: 0, promoted: 0 };
  }

  console.log(`[watchlist] 스캔 시작 — ${candidates.length}개 후보`);

  for (let i = 0; i < candidates.length; i++) {
    const sym = typeof candidates[i] === 'string' ? candidates[i] : candidates[i].ticker;

    try {
      const { rows, callWall, upside, squeeze, spot } = await analyzeSymbol(sym);
      const isCallWall = callWall.concentration_count >= 4;

      scanned.push({ symbol: sym, concentration_count: callWall.concentration_count });

      // last_scan_date 업데이트 (통과 여부 무관)
      await fetch(`${cfWorkerUrl}/api/watchlist/scan-result`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'x-cron-secret': cronSecret,
        },
        body: JSON.stringify({
          ticker:         sym,
          last_scan_date: getTodayET(),
          promote:        isCallWall,
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (isCallWall) {
        promoted.push({
          symbol:              sym,
          target_strike:       callWall.target_strike,
          concentration_count: callWall.concentration_count,
          upside:              upside,
        });
        console.log(
          `[watchlist] ★ 승격: ${sym} | Call Wall $${callWall.target_strike} ` +
          `(${callWall.concentration_count}개 만기 집중)`
        );

        // 승격 즉시 daily_screener에 저장
        await saveSymbolRows(cfWorkerUrl, cronSecret, sym, rows, updatedAt);

        // screened_tickers WATCHLIST 그룹으로 자동 편입 (enroll-group)
        await fetch(`${cfWorkerUrl}/api/watchlist/enroll-group`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'x-cron-secret': cronSecret,
          },
          body:    JSON.stringify({ ticker: sym }),
          signal:  AbortSignal.timeout(8000),
        }).catch(e => console.warn(`[watchlist] ${sym} 그룹 편입 실패:`, e.message));

        // screened_tickers 집계값 업데이트
        await updateScreenedTicker(cfWorkerUrl, cronSecret, sym, spot, callWall, upside, rows, squeeze)
          .catch(e => console.warn(`[watchlist] ${sym} screened_tickers 업데이트 실패:`, e.message));

      } else {
        console.log(
          `[watchlist] — 미달: ${sym} | 집중 만기 ${callWall.concentration_count}개 (기준 4개 미만)`
        );
      }

    } catch (err) {
      console.error(`[watchlist] ${sym} 오류:`, err.message);
      errors.push({ symbol: sym, error: err.message });
    }

    if (onProgress) {
      onProgress({ done: i + 1, total: candidates.length, promoted: promoted.length, errors: errors.length });
    }

    // 요청 분산: 기본 3000ms + 랜덤 지터 (IP 차단 방지)
    if (i < candidates.length - 1) {
      await jitteredDelay(3000, 1500);

      // 10종목마다 10초 추가 휴식 (버스트 방지)
      if ((i + 1) % 10 === 0) {
        console.log(`[watchlist] 버스트 방지 대기 (${i + 1}/${candidates.length})...`);
        await sleep(10000);
      }
    }
  }

  console.log(
    `[watchlist] 스캔 완료 — 스캔 ${scanned.length}개, 승격 ${promoted.length}개, 오류 ${errors.length}개`
  );

  return {
    ok:       true,
    scanned:  scanned.length,
    promoted: promoted.length,
    errors:   errors.length,
    promotedList: promoted,
    errorList:    errors,
  };
}

// ══════════════════════════════════════════════════════════
// 기준 미달 종목 정리
// 조건: concentration_count <= 3 OR 상승여력 < 3%
// 대상: screened_tickers의 WATCHLIST 그룹 종목
// ══════════════════════════════════════════════════════════
export async function pruneWatchlistGroup(cfWorkerUrl, cronSecret) {
  const headers = {
    'Content-Type':  'application/json',
    'x-cron-secret': cronSecret,
  };

  // 7번 로직: screened_tickers에서 WATCHLIST 기준 미달 종목 조회
  const res = await fetch(`${cfWorkerUrl}/api/screener/prune-candidates`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`prune-candidates HTTP ${res.status}`);
  const { candidates } = await res.json();

  const removed = [];
  const kept    = [];

  for (const row of (candidates ?? [])) {
    const count  = row.concentration_count ?? 0;
    const upside = row.upside ?? null;
    const isBelowCount  = count <= 3;
    const isBelowUpside = upside != null && upside < 3;

    if (isBelowCount) {
      // 집중도 미달 → 완전 제거
      try {
        await fetch(`${cfWorkerUrl}/api/watchlist/prune`, {
          method:  'POST',
          headers,
          body:    JSON.stringify({ ticker: row.ticker }),
          signal:  AbortSignal.timeout(10000),
        });
        removed.push({ symbol: row.ticker, count, upside: upside?.toFixed(1), reason: 'count' });
        console.log(`[prune] 제거: ${row.ticker} (집중도:${count})`);
      } catch (e) {
        console.warn(`[prune] ${row.ticker} 제거 실패:`, e.message);
      }
    } else if (isBelowUpside) {
      // upside < 3% → MONITOR 그룹으로 이동
      try {
        await fetch(`${cfWorkerUrl}/api/watchlist/move-to-monitor`, {
          method:  'POST',
          headers,
          body:    JSON.stringify({ ticker: row.ticker }),
          signal:  AbortSignal.timeout(10000),
        });
        removed.push({ symbol: row.ticker, count, upside: upside?.toFixed(1), reason: 'monitor' });
        console.log(`[prune] MONITOR 이동: ${row.ticker} (상승여력:${upside?.toFixed(1)}%)`);
      } catch (e) {
        console.warn(`[prune] ${row.ticker} MONITOR 이동 실패:`, e.message);
      }
    } else {
      kept.push(row.ticker);
    }
  }

  console.log(`[prune] 완료 — 제거 ${removed.length}개, 유지 ${kept.length}개`);
  return { ok: true, removed, kept: kept.length };
}
