// ============================================
// radar-engine.js — Radar 탭 계산 엔진 (DOM 없음, node 단독 테스트 가능)
// 부호 규약: 양수 = 딜러 매수
//   vannaSupport: IV 1vol-pt 하락 시 딜러가 사는 주식 ($M)
//   charmSupport: 하루 지날 때 딜러가 사는 주식 ($M)
// 기존 vanna/charm 저장값(부호 반대)은 이 파일에서 읽지 않는다.
// ============================================

const SQRT_2PI = Math.sqrt(2 * Math.PI);

function norm_pdf(x) {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

function norm_cdf(x) {
  // Abramowitz & Stegun 26.2.17 근사
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - norm_pdf(x) * poly;
  return x >= 0 ? p : 1 - p;
}

// ─── Black-Scholes Greeks ────────────────────────────────────────
// 반환: { delta, gamma, vannaHolder, charmHolder }
// vannaHolder = -φ(d1)·d2/σ  (교과서 홀더 Vanna, IV 하락 시 양수)
// charmHolder = -φ(d1)·[d2·σ/(2T) - (2rT)/(2σ√T)] / (2T)  (간소화)
export function bsGreeks(spot, strike, dte, iv, r = 0.05) {
  const T = dte / 365;
  if (T <= 0 || iv <= 0 || spot <= 0 || strike <= 0) {
    return { delta: 0, gamma: 0, vannaHolder: 0, charmHolder: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (r + 0.5 * iv * iv) * T) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  const phi_d1 = norm_pdf(d1);

  const delta = norm_cdf(d1);
  const gamma = phi_d1 / (spot * iv * sqrtT);
  // vannaHolder = -φ(d1)·d2/σ  (양수 = IV 하락 시 콜 델타 증가 = 딜러 매수)
  const vannaHolder = -(phi_d1 * d2) / iv;
  // charmHolder = -φ(d1)·[d2/(2T·σ) - r/(σ·√T)]  (양수 = 시간 경과 시 딜러 매수)
  // 교과서: dΔ/dt = -φ(d1)·[r/(σ√T) - d2/(2T)]
  const charmHolder = -phi_d1 * (r / (iv * sqrtT) - d2 / (2 * T));

  return { delta, gamma, vannaHolder, charmHolder };
}

// ─── 스트라이크 1개의 지지량 ─────────────────────────────────────
// netOI = call_oi - put_oi (딜러 롱콜/숏풋 가정)
// iv: 콜이면 call_iv, 풋이면 put_iv (없으면 avg_iv)
export function strikeSupport(spot, s, dte) {
  const netOI = (s.call_oi ?? 0) - (s.put_oi ?? 0);
  const iv = s.strike > spot
    ? (s.call_iv ?? s.avg_iv ?? 0)
    : (s.put_iv  ?? s.avg_iv ?? 0);
  if (!iv || !dte) return { vannaSupport: 0, charmSupport: 0, callDex: 0 };

  const g = bsGreeks(spot, s.strike, dte, iv);
  // vannaSupport = vannaHolder × netOI × 계약크기 × 현재가 / $1M
  const vannaSupport = g.vannaHolder * netOI * 100 * spot / 1e6;
  // charmSupport = -charmHolder × netOI × 계약크기 / $1M
  const charmSupport = -g.charmHolder * netOI * 100 / 1e6;
  // callDex: 콜 포지션 델타 합 ($M)
  const callDex = g.delta * (s.call_oi ?? 0) * 100 / 1e6;

  return { vannaSupport, charmSupport, callDex };
}

// ─── 만기별 지표 계산 ─────────────────────────────────────────────
// expiry: { expiry_date, dte, expiry_type, atm_iv, call_oi, put_oi, flip_strike, strikes[] }
// 반환: 2-3절 필드 전부
export function expiryMetrics(spot, expiry) {
  const { dte, atm_iv, strikes = [] } = expiry;
  if (!strikes.length || !dte || !atm_iv || !spot) {
    return { ...expiry, skewRel: null, vannaSupport: 0, charmSupport: 0,
      putOIBelow: 0, callOIAbove: 0, peakCallStrike: null,
      totalOI: 0, lowConf: false };
  }

  // 1.5σ 밴드 계산
  const sigma = spot * atm_iv * Math.sqrt(dte / 365);
  const putLow  = spot - 1.5 * sigma;
  const callHigh = spot + 1.5 * sigma;

  // 밴드 내 스트라이크 분류
  let putStrikes  = strikes.filter(s => s.strike >= putLow  && s.strike < spot);
  let callStrikes = strikes.filter(s => s.strike > spot     && s.strike <= callHigh);
  let lowConf = false;

  // 밴드 내 스트라이크 2개 미만이면 가장 가까운 2개로 대체
  if (putStrikes.length < 2) {
    const sorted = strikes.filter(s => s.strike < spot).sort((a, b) => b.strike - a.strike);
    putStrikes = sorted.slice(0, 2);
    if (sorted.length < 2) lowConf = true;
  }
  if (callStrikes.length < 2) {
    const sorted = strikes.filter(s => s.strike > spot).sort((a, b) => a.strike - b.strike);
    callStrikes = sorted.slice(0, 2);
    if (sorted.length < 2) lowConf = true;
  }

  // 정규화 스큐: (평균 풋IV − 평균 콜IV) / atm_iv
  const avgPutIV  = putStrikes.length
    ? putStrikes.reduce((s, x) => s + (x.put_iv ?? x.avg_iv ?? 0), 0) / putStrikes.length : 0;
  const avgCallIV = callStrikes.length
    ? callStrikes.reduce((s, x) => s + (x.call_iv ?? x.avg_iv ?? 0), 0) / callStrikes.length : 0;
  const skewRel = atm_iv > 0 ? (avgPutIV - avgCallIV) / atm_iv : null;

  // 만기 내 전 스트라이크 Vanna/Charm 합
  let vannaSum = 0, charmSum = 0;
  for (const s of strikes) {
    const sup = strikeSupport(spot, s, dte);
    vannaSum += sup.vannaSupport;
    charmSum += sup.charmSupport;
  }

  // OI 집계
  const putOIBelow  = strikes.filter(s => s.strike < spot).reduce((s, x) => s + (x.put_oi  ?? 0), 0);
  const callOIAbove = strikes.filter(s => s.strike > spot).reduce((s, x) => s + (x.call_oi ?? 0), 0);
  const totalOI = strikes.reduce((s, x) => s + (x.call_oi ?? 0) + (x.put_oi ?? 0), 0);

  // 콜 DEX 정점 스트라이크 (spot 위)
  let peakCallStrike = null;
  let peakDex = -Infinity;
  for (const s of strikes.filter(x => x.strike > spot)) {
    const sup = strikeSupport(spot, s, dte);
    if (sup.callDex > peakDex) { peakDex = sup.callDex; peakCallStrike = s.strike; }
  }

  return {
    ...expiry,
    skewRel,
    vannaSupport: vannaSum,
    charmSupport: charmSum,
    putOIBelow,
    callOIAbove,
    peakCallStrike,
    totalOI,
    lowConf,
  };
}

// ─── 달력 창 계산 ─────────────────────────────────────────────────
// 셋째 금요일 = OPEX. 창 B: OPEX−14일~OPEX, 창 A: 나머지
function thirdFriday(year, month) {
  // month: 0-based
  let count = 0;
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(year, month, d);
    if (dt.getMonth() !== month) break;
    if (dt.getDay() === 5) { count++; if (count === 3) return dt; }
  }
  return null;
}

export function opexCalendar(today) {
  const d = typeof today === 'string' ? new Date(today + 'T12:00:00Z') : new Date(today);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-based

  // 이번달 + 다음달 OPEX 후보
  const opexCur  = thirdFriday(year, month);
  const opexNext = thirdFriday(month === 11 ? year + 1 : year, (month + 1) % 12);

  // today 기준으로 "현재 OPEX" 판정
  const todayMs = d.getTime();
  let opex, nextOpex;
  if (opexCur && todayMs <= opexCur.getTime()) {
    opex     = opexCur;
    nextOpex = opexNext;
  } else {
    opex     = opexNext;
    nextOpex = thirdFriday(
      opexNext.getMonth() === 11 ? opexNext.getFullYear() + 1 : opexNext.getFullYear(),
      (opexNext.getMonth() + 1) % 12
    );
  }

  const opexMs      = opex.getTime();
  const windowStart = opexMs - 14 * 24 * 3600 * 1000; // OPEX − 14일
  const window      = todayMs >= windowStart ? 'B' : 'A';
  const daysToSupport = window === 'B'
    ? Math.ceil((opexMs - todayMs) / (24 * 3600 * 1000))
    : Math.ceil((windowStart - todayMs) / (24 * 3600 * 1000));

  // toISOString()은 UTC 변환으로 날짜가 밀릴 수 있어 로컬 날짜 필드 직접 사용
  const fmt = dt => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;

  function windowOf(expiryDateStr) {
    const expMs = new Date(expiryDateStr + 'T12:00:00Z').getTime();
    // 해당 만기가 속하는 달의 OPEX 계산
    const ey = new Date(expiryDateStr + 'T12:00:00Z').getUTCFullYear();
    const em = new Date(expiryDateStr + 'T12:00:00Z').getUTCMonth();
    const eOpex = thirdFriday(ey, em);
    if (!eOpex) return 'A';
    const eOpexMs  = eOpex.getTime();
    const eWinStart = eOpexMs - 14 * 24 * 3600 * 1000;
    return expMs >= eWinStart && expMs <= eOpexMs ? 'B' : 'A';
  }

  return {
    opex:           fmt(opex),
    nextOpex:       nextOpex ? fmt(nextOpex) : null,
    window,
    daysToSupport,
    windowOf,
  };
}

// ─── 종목별 지표 계산 ─────────────────────────────────────────────
// t: { symbol, spot_price, expiries[], bb }
// calendar: opexCalendar() 반환값
export function tickerMetrics(t, calendar) {
  const spot = t.spot_price;
  if (!spot || !t.expiries?.length) return null;

  // 만기별 지표 계산 + 창 분류
  const expiries = t.expiries
    .filter(e => e.dte > 0 && e.dte <= 60)
    .map(e => ({
      ...expiryMetrics(spot, e),
      window: calendar.windowOf(e.expiry_date),
    }))
    .sort((a, b) => (a.dte ?? 999) - (b.dte ?? 999));

  if (!expiries.length) return null;

  // 8주(56일) 이내 만기만 사용
  const w8 = expiries.filter(e => e.dte <= 56);

  // 콜월 (callWall): 8주 합산 콜 DEX 정점 스트라이크
  const allStrikes = new Map();
  for (const e of w8) {
    for (const s of (e.strikes ?? [])) {
      if (s.strike <= spot) continue;
      const sup = strikeSupport(spot, s, e.dte);
      allStrikes.set(s.strike, (allStrikes.get(s.strike) ?? 0) + sup.callDex);
    }
  }
  let callWall = null, maxDex = -Infinity;
  for (const [strike, dex] of allStrikes) {
    if (dex > maxDex) { maxDex = dex; callWall = strike; }
  }

  // alignCount: peakCallStrike가 callWall과 일치하는 만기 수
  const alignCount = w8.filter(e => e.peakCallStrike === callWall).length;

  // oiUpperEdge: 8주 합산 콜 OI를 spot 위로 누적해 95% 도달 스트라이크
  const upperStrikes = [...allStrikes.keys()].sort((a, b) => a - b);
  const totalCallOI = upperStrikes.reduce((s, k) => s + (allStrikes.get(k) ?? 0), 0);
  let oiUpperEdge = null, cumUpper = 0;
  for (const k of upperStrikes) {
    cumUpper += allStrikes.get(k) ?? 0;
    if (cumUpper >= totalCallOI * 0.95) { oiUpperEdge = k; break; }
  }

  // oiLowerEdge: 8주 합산 풋 OI를 spot 아래로 누적해 95% 도달 스트라이크
  const lowerOIMap = new Map();
  for (const e of w8) {
    for (const s of (e.strikes ?? [])) {
      if (s.strike >= spot) continue;
      lowerOIMap.set(s.strike, (lowerOIMap.get(s.strike) ?? 0) + (s.put_oi ?? 0));
    }
  }
  const lowerStrikes = [...lowerOIMap.keys()].sort((a, b) => b - a); // spot에서 아래로
  const totalPutOI = lowerStrikes.reduce((s, k) => s + (lowerOIMap.get(k) ?? 0), 0);
  let oiLowerEdge = null, cumLower = 0;
  for (const k of lowerStrikes) {
    cumLower += lowerOIMap.get(k) ?? 0;
    if (cumLower >= totalPutOI * 0.95) { oiLowerEdge = k; break; }
  }

  // concRatio: 만기별 총 OI max / 최저 2개 평균 (OI 500 미만 만기는 분모 제외)
  const oisValid = w8.map(e => e.totalOI).filter(v => v >= 500).sort((a, b) => a - b);
  const concRatio = oisValid.length >= 2
    ? Math.max(...w8.map(e => e.totalOI)) / ((oisValid[0] + oisValid[1]) / 2)
    : null;

  // keyExpiry: concRatio 최대 만기 중 skewRel > 0인 것
  //            없으면 skewRel × vannaSupport 최대 만기
  const sorted_by_oi = [...w8].sort((a, b) => b.totalOI - a.totalOI);
  const topConc = sorted_by_oi[0];
  let keyExpiry = (topConc?.skewRel ?? 0) > 0 ? topConc : null;
  if (!keyExpiry) {
    keyExpiry = w8.reduce((best, e) => {
      const score = (e.skewRel ?? 0) * (e.vannaSupport ?? 0);
      const bestScore = (best?.skewRel ?? 0) * (best?.vannaSupport ?? 0);
      return score > bestScore ? e : best;
    }, null);
    if ((keyExpiry?.skewRel ?? 0) <= 0) keyExpiry = null;
  }

  const daysToKey = keyExpiry?.dte ?? null;

  // skewA / skewB: 창별 OI 가중 skewRel
  function weightedSkew(exps) {
    const valid = exps.filter(e => e.skewRel != null && e.totalOI > 0);
    if (!valid.length) return null;
    const totalW = valid.reduce((s, e) => s + e.totalOI, 0);
    return valid.reduce((s, e) => s + e.skewRel * e.totalOI, 0) / totalW;
  }
  const skewA = weightedSkew(w8.filter(e => e.window === 'A'));
  const skewB = weightedSkew(w8.filter(e => e.window === 'B'));

  // vannaTotal: 전 만기 vannaSupport 합 ($M)
  const vannaTotal = expiries.reduce((s, e) => s + (e.vannaSupport ?? 0), 0);

  // vannaReach: spot부터 위로 vannaSupport > 0 스트라이크가 연속되는 상단
  const strikesSortedUp = upperStrikes.slice().sort((a, b) => a - b);
  let vannaReach = null;
  for (const k of strikesSortedUp) {
    let totalVanna = 0;
    for (const e of w8) {
      const s = (e.strikes ?? []).find(x => x.strike === k);
      if (s) { const sup = strikeSupport(spot, s, e.dte); totalVanna += sup.vannaSupport; }
    }
    if (totalVanna > 0) vannaReach = k;
    else break;
  }

  return {
    symbol:       t.symbol,
    spot_price:   spot,
    bb:           t.bb ?? null,
    expiries,
    callWall,
    alignCount,
    oiUpperEdge,
    oiLowerEdge,
    concRatio,
    keyExpiry,
    daysToKey,
    skewA,
    skewB,
    vannaTotal,
    vannaReach,
  };
}

// ─── 제외/분류 판정 ───────────────────────────────────────────────
// prev: 전일 tickerMetrics (소진 판정용, null이면 이력 없음)
// exclude: null | 'call_skew' | 'no_fuel' | 'exhausted'
export function classify(m, prev = null) {
  if (!m) return { exclude: 'call_skew', badges: [] };

  const badges = [];
  if (m.keyExpiry?.lowConf) badges.push('lowConf');

  // 1. keyExpiry 없음 (풋 스큐 양수 만기 없음)
  if (!m.keyExpiry) return { exclude: 'call_skew', badges };

  // 2. vannaReach 없음
  if (!m.vannaReach) return { exclude: 'no_fuel', badges };

  // 3. 소진 판정 (이력이 있는 경우)
  if (prev?.keyExpiry) {
    const prevSkew = prev.keyExpiry.skewRel ?? 0;
    const curSkew  = m.keyExpiry.skewRel ?? 0;
    if (prevSkew > 0 && curSkew <= 0) return { exclude: 'exhausted', badges };
    // vannaTotal 50% 이상 감소도 소진으로 판정 (임계 미결이므로 보수적으로 적용)
    if (prev.vannaTotal > 0 && m.vannaTotal < prev.vannaTotal * 0.5) {
      return { exclude: 'exhausted', badges };
    }
  }

  return { exclude: null, badges };
}

// ─── 후보 목록 정렬 (2-6절) ──────────────────────────────────────
export function sortCandidates(list) {
  return [...list].sort((a, b) => {
    const skewDiff = (b.keyExpiry?.skewRel ?? -Infinity) - (a.keyExpiry?.skewRel ?? -Infinity);
    if (Math.abs(skewDiff) > 1e-6) return skewDiff;
    const alignDiff = (b.alignCount ?? 0) - (a.alignCount ?? 0);
    if (alignDiff !== 0) return alignDiff;
    const daysDiff = (a.daysToKey ?? 999) - (b.daysToKey ?? 999);
    if (daysDiff !== 0) return daysDiff;
    return (b.vannaTotal ?? 0) - (a.vannaTotal ?? 0);
  });
}

// ─── 이유 문자열 생성 ─────────────────────────────────────────────
export function reasonString(m) {
  const parts = [];
  if (m.keyExpiry?.skewRel != null)
    parts.push(`풋스큐 ${(m.keyExpiry.skewRel * 100).toFixed(1)}%`);
  if (m.alignCount != null)
    parts.push(`정렬 ${m.alignCount}/${m.expiries?.filter(e => e.dte <= 56).length ?? 0}`);
  if (m.daysToKey != null)
    parts.push(`D-${m.daysToKey}`);
  if (m.vannaTotal != null)
    parts.push(`Vanna ${m.vannaTotal.toFixed(1)}M`);
  if (m.concRatio != null)
    parts.push(`집중도 ${m.concRatio.toFixed(1)}x`);
  return parts.join(' · ');
}
