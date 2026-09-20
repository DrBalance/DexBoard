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
  if (!iv || !dte) return { vannaSupport: 0, charmSupport: 0, callDex: 0, dexNet: 0, gexNet: 0 };

  const g = bsGreeks(spot, s.strike, dte, iv);
  // vannaSupport = vannaHolder × netOI × 계약크기 × 현재가 / $1M
  const vannaSupport = g.vannaHolder * netOI * 100 * spot / 1e6;
  // charmSupport = -charmHolder × netOI × 계약크기 / $1M
  const charmSupport = -g.charmHolder * netOI * 100 / 1e6;
  // callDex: 콜 포지션 델타 합 ($M)
  const callDex = g.delta * (s.call_oi ?? 0) * 100 / 1e6;

  // v0.5: 차트 모듈(EM·히트맵) 입력용 순 DEX / GEX ($M). 콜은 call_iv, 풋은 put_iv로 각각 계산
  //   dexNet = (콜델타×콜OI + 풋델타×풋OI) × 100 × spot / 1e6   — 콜 양수, 풋 음수
  //   gexNet = (콜감마×콜OI − 풋감마×풋OI) × 100 × spot² × 0.01 / 1e6 — 딜러 롱콜(+)·숏풋(−)
  const gc = bsGreeks(spot, s.strike, dte, s.call_iv ?? iv);
  const gp = bsGreeks(spot, s.strike, dte, s.put_iv  ?? iv);
  const callOI = s.call_oi ?? 0, putOI = s.put_oi ?? 0;
  const dexNet = (gc.delta * callOI + (gp.delta - 1) * putOI) * 100 * spot / 1e6;
  const gexNet = (gc.gamma * callOI - gp.gamma * putOI) * 100 * spot * spot * 0.01 / 1e6;

  return { vannaSupport, charmSupport, callDex, dexNet, gexNet };
}

// ─── v0.5: 로그 볼린저밴드 (사용자 TradingView 지표 "Log BB + Inner Band"와 동일) ───
// closes/lows: 오름차순 종가·저가 배열. 마지막 봉 기준 값 반환. Railway collectPriceIndicators와 같은 수식.
//   basis = SMA(ln close, length), dev = stdev(ln close, length) (모집단), upper/lower = exp(basis ± mult·dev)
//   pos = 종가 %B (로그 공간), lowPos = 저가 %B — ≤ 0 이면 하단 밴드 터치
export function logBB(closes, lows = null, length = 20, mult = 2) {
  if (!closes || closes.length < length) return null;
  const n = closes.length;
  const slice = closes.slice(n - length).map(c => Math.log(c));
  const basis = slice.reduce((a, b) => a + b, 0) / length;
  const dev   = Math.sqrt(slice.reduce((a, b) => a + (b - basis) ** 2, 0) / length);
  const range = 2 * mult * dev;
  const lowerLog = basis - mult * dev;
  const close = closes[n - 1];
  const low   = lows?.[n - 1] ?? null;
  const pos    = range > 0 ? (Math.log(close) - lowerLog) / range : 0.5;
  const lowPos = (range > 0 && low > 0) ? (Math.log(low) - lowerLog) / range : null;
  return {
    basis: Math.exp(basis),
    upper: Math.exp(basis + mult * dev),
    lower: Math.exp(lowerLog),
    pos, lowPos,
  };
}

// atm_iv가 이 값 미만이면 비유동 종목의 깨진 ATM 호가로 간주 → 스큐 무효 (DBRG 0.03 등)
export const MIN_ATM_IV = 0.05;

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
  const atmValid = atm_iv >= MIN_ATM_IV;

  // 1.5σ 밴드 계산
  const sigma = spot * atm_iv * Math.sqrt(dte / 365);
  const putLow  = spot - 1.5 * sigma;
  const callHigh = spot + 1.5 * sigma;

  // 밴드 내 스트라이크 분류
  let putStrikes  = strikes.filter(s => s.strike >= putLow  && s.strike < spot);
  let callStrikes = strikes.filter(s => s.strike > spot     && s.strike <= callHigh);
  let lowConf = false;

  // 밴드 내 스트라이크 2개 미만이면 가장 가까운 2개로 대체 (설계 2-2: 대체 시 lowConf)
  if (putStrikes.length < 2) {
    putStrikes = strikes.filter(s => s.strike < spot).sort((a, b) => b.strike - a.strike).slice(0, 2);
    lowConf = true;
  }
  if (callStrikes.length < 2) {
    callStrikes = strikes.filter(s => s.strike > spot).sort((a, b) => a.strike - b.strike).slice(0, 2);
    lowConf = true;
  }

  // 정규화 스큐: (평균 풋IV − 평균 콜IV) / atm_iv. IV 없는 스트라이크는 평균에서 제외
  const mean = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const putIVs  = putStrikes.map(x => x.put_iv  ?? x.avg_iv).filter(v => v > 0);
  const callIVs = callStrikes.map(x => x.call_iv ?? x.avg_iv).filter(v => v > 0);
  const avgPutIV  = mean(putIVs);
  const avgCallIV = mean(callIVs);
  const skewRel = (atmValid && avgPutIV != null && avgCallIV != null)
    ? (avgPutIV - avgCallIV) / atm_iv : null;
  if (!atmValid) lowConf = true;

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
// 모든 날짜는 UTC 정오로 통일 (today·만기 문자열도 T12:00:00Z로 파싱) — 로컬 TZ 무관
function thirdFriday(year, month) {
  // month: 0-based
  let count = 0;
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(Date.UTC(year, month, d, 12));
    if (dt.getUTCMonth() !== month) break;
    if (dt.getUTCDay() === 5) { count++; if (count === 3) return dt; }
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
      opexNext.getUTCMonth() === 11 ? opexNext.getUTCFullYear() + 1 : opexNext.getUTCFullYear(),
      (opexNext.getUTCMonth() + 1) % 12
    );
  }

  const opexMs      = opex.getTime();
  const windowStart = opexMs - 14 * 24 * 3600 * 1000; // OPEX − 14일
  const window      = todayMs >= windowStart ? 'B' : 'A';
  const daysToSupport = window === 'B'
    ? Math.ceil((opexMs - todayMs) / (24 * 3600 * 1000))
    : Math.ceil((windowStart - todayMs) / (24 * 3600 * 1000));

  const fmt = dt => dt.toISOString().slice(0, 10);

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

  // lowConf(밴드 부족·atm_iv 이상) 만기는 keyExpiry·창별 스큐에서 제외 (결정: 2026-09-12)
  const reliable = w8.filter(e => !e.lowConf && e.skewRel != null);

  // keyExpiry: concRatio 최대 만기 중 skewRel > 0인 것
  //            없으면 skewRel × vannaSupport 최대 만기
  const sorted_by_oi = [...reliable].sort((a, b) => b.totalOI - a.totalOI);
  const topConc = sorted_by_oi[0];
  let keyExpiry = (topConc?.skewRel ?? 0) > 0 ? topConc : null;
  if (!keyExpiry) {
    keyExpiry = reliable.reduce((best, e) => {
      const score = (e.skewRel ?? 0) * (e.vannaSupport ?? 0);
      const bestScore = (best?.skewRel ?? 0) * (best?.vannaSupport ?? 0);
      return score > bestScore ? e : best;
    }, null);
    if ((keyExpiry?.skewRel ?? 0) <= 0) keyExpiry = null;
  }

  const daysToKey = keyExpiry?.dte ?? null;

  // skewA / skewB: 창별 OI 가중 skewRel
  function weightedSkew(exps) {
    const valid = exps.filter(e => !e.lowConf && e.skewRel != null && e.totalOI > 0);
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

  // wallDistAtr: 콜월까지 거리를 ATR20 단위로 (회귀 기대 폭)
  const atr20 = t.bb?.atr20;
  const wallDistAtr = (callWall != null && atr20 > 0) ? (callWall - spot) / atr20 : null;

  // v0.5: 위치·추세 게이트 원값
  const pg = positionGate(t);
  const tg = trendGate(t);

  return {
    symbol:       t.symbol,
    spot_price:   spot,
    bb:           t.bb ?? null,
    bb_hist:      t.bb_hist ?? [],
    bbLogPos:     pg.logPos,
    bbTouch5d:    pg.touch5d,
    bbTouchDate:  pg.touchDate,
    positionOk:   pg.ok,
    trendOk:      tg.ok,
    trendMissing: tg.missing,
    expiries,
    callWall,
    alignCount,
    oiUpperEdge,
    oiLowerEdge,
    concRatio,
    reliableCount: reliable.length,
    keyExpiry,
    daysToKey,
    skewA,
    skewB,
    vannaTotal,
    vannaReach,
    wallDistAtr,
  };
}

// ─── v0.5: 위치 게이트 (로그 BB 하단 터치 + 아직 하단부) ─────────────
// t: { bb: {bb_log_pos, bb_log_low_pos, ...}|null, bb_hist: [{date, bb_log_pos, bb_log_low_pos}] }
// 반환: { ok, logPos, touch5d, touchDate, reason: null|'no_bb'|'position' }
//   touch5d: 최근 5거래일(bb_hist 마지막 5개 + 당일) 중 저가 %B ≤ 0 인 날이 있음
//   ok: touch5d && logPos ≤ PILLAR_THRESHOLDS.bbLogMax
export function positionGate(t) {
  const T = PILLAR_THRESHOLDS;
  const bb = t?.bb;
  const logPos = bb?.bb_log_pos ?? null;
  if (logPos == null) return { ok: false, logPos: null, touch5d: null, touchDate: null, reason: 'no_bb' };

  const hist = Array.isArray(t.bb_hist) ? t.bb_hist.slice(-T.touchDays) : [];
  const days = [...hist];
  // 당일 행이 bb_hist에 없으면 bb 자체를 추가 (chains는 보통 포함하지만 방어)
  if (bb.date && !days.some(d => d.date === bb.date)) {
    days.push({ date: bb.date, bb_log_pos: bb.bb_log_pos, bb_log_low_pos: bb.bb_log_low_pos });
  }
  let touchDate = null;
  for (const d of days) {
    if (d.bb_log_low_pos != null && d.bb_log_low_pos <= 0) touchDate = d.date ?? touchDate ?? '?';
  }
  const touch5d = touchDate != null;
  const ok = touch5d && logPos <= T.bbLogMax;
  return { ok, logPos, touch5d, touchDate, reason: ok ? null : 'position' };
}

// ─── v0.5: 추세 게이트 (종가 > 200일선). sma200 없으면 통과 + missing 표시 ───
export function trendGate(t) {
  const close  = t?.bb?.close ?? t?.spot_price ?? null;
  const sma200 = t?.bb?.sma200 ?? null;
  if (sma200 == null || close == null) return { ok: true, missing: true, reason: null };
  const ok = close > sma200;
  return { ok, missing: false, reason: ok ? null : 'trend' };
}

// ─── 제외/분류 판정 ───────────────────────────────────────────────
// prev: 전일 tickerMetrics (소진 판정용, null이면 이력 없음)
// exclude: null | 'low_conf' | 'no_bb' | 'position' | 'trend' | 'call_skew' | 'no_fuel' | 'exhausted'
export function classify(m, prev = null) {
  if (!m) return { exclude: 'call_skew', badges: [] };

  const badges = [];

  // 0. 신뢰 가능한 만기(밴드 내 스트라이크 충분, atm_iv 정상) 없음
  if (!m.reliableCount) return { exclude: 'low_conf', badges };

  // 1. 로그 BB 없음 (v0.5)
  if (m.bbLogPos == null) return { exclude: 'no_bb', badges };

  // 2. 위치 부적합: 5일 내 하단 터치 + 로그 %B ≤ 0.25 아니면 제외 (v0.5)
  if (!m.positionOk) return { exclude: 'position', badges };

  // 3. 추세 부적합: 종가 ≤ 200일선 (v0.5). sma200 없으면 통과하되 배지
  if (m.trendMissing) badges.push('200일선 없음');
  else if (!m.trendOk) return { exclude: 'trend', badges };

  // 4. keyExpiry 없음 (풋 스큐 양수 만기 없음)
  if (!m.keyExpiry) return { exclude: 'call_skew', badges };

  // 5. vannaReach 없음
  if (!m.vannaReach) return { exclude: 'no_fuel', badges };

  // 6. 소진 판정 (이력이 있는 경우)
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
function cmpCandidates(a, b) {
  const skewDiff = (b.keyExpiry?.skewRel ?? -Infinity) - (a.keyExpiry?.skewRel ?? -Infinity);
  if (Math.abs(skewDiff) > 1e-6) return skewDiff;
  const alignDiff = (b.alignCount ?? 0) - (a.alignCount ?? 0);
  if (alignDiff !== 0) return alignDiff;
  const daysDiff = (a.daysToKey ?? 999) - (b.daysToKey ?? 999);
  if (daysDiff !== 0) return daysDiff;
  return (b.vannaTotal ?? 0) - (a.vannaTotal ?? 0);
}

export function sortCandidates(list) {
  return [...list].sort(cmpCandidates);
}

// ─── 기둥 채점과 의견 (병목 방식: 가장 약한 기둥이 등급을 정함) ───
// 레벨: 3=강, 2=중, 1=약, null=판단 불가. 임계값은 잠정치.
// v0.5: 위치는 기둥이 아니라 게이트(positionGate·trendGate → classify). 등급은 스큐·연료·타이밍·폭.
export const ENGINE_VER = '0.5.0';

export const PILLAR_THRESHOLDS = {
  skewStrong: 0.10, skewMid: 0.03,
  bbLogMax:   0.25,                   // 위치 게이트: 로그 %B ≤ 0.25 (20일선 −1σ 이하) — 사용자 결정 2026-09-20
  touchDays:  5,                      // 위치 게이트: 최근 5거래일 내 저가가 로그 하단 2σ 밴드 이하
  wallMinAtr: 0.6,                    // 콜월까지 < 0.6 ATR = 폭 부족 → C
  daysStrong: 14,  daysMid: 30,
  aReliableMin: 3,                    // A 등급 추가 조건: 신뢰 만기 3개 이상 (잠정)
  aAlignMin:    3,                    // A 등급 추가 조건: 콜 정점 정렬 3개 이상 (잠정)
};

export function pillars(m) {
  const T = PILLAR_THRESHOLDS;
  const k = m?.keyExpiry;

  // 스큐 (방향)
  const s = k?.skewRel;
  const skew = (s == null || s <= 0) ? null
    : s >= T.skewStrong ? 3 : s >= T.skewMid ? 2 : 1;

  // 연료 (힘): keyExpiry의 Vanna·Charm 부호 일치
  let fuel = null;
  if (k) {
    const n = ((k.vannaSupport ?? 0) > 0 ? 1 : 0) + ((k.charmSupport ?? 0) > 0 ? 1 : 0);
    fuel = n === 2 ? 3 : n === 1 ? 2 : 1;
  }

  // 폭 (회귀 기대 폭): 콜월까지 ATR. 부족하면 약, 아니면 강. 없으면 판단 불가
  const width = m?.wallDistAtr == null ? null
    : m.wallDistAtr < T.wallMinAtr ? 1 : 3;

  // 타이밍
  let timing = null;
  if (k && m.daysToKey != null) {
    timing = (k.window === 'B' && m.daysToKey <= T.daysStrong) ? 3
      : m.daysToKey <= T.daysMid ? 2 : 1;
  }

  return { skew, fuel, timing, width };
}

// cls: classify() 반환값. grade: 'A' 매수 우선 | 'B' 관심 | 'C' 보류 | 'X' 제외
export function opinion(m, cls) {
  const T = PILLAR_THRESHOLDS;
  const p = pillars(m);
  if (cls?.exclude) return { grade: 'X', pillars: p, exclude: cls.exclude, demoted: null };
  // 판단 불가 기둥(null)은 중으로 간주 → A 불가, C 강제도 안 함
  const levels = Object.values(p).map(v => v ?? 2);
  const min = Math.min(...levels);
  let grade = min === 3 ? 'A' : min === 2 ? 'B' : 'C';
  // v0.5: A 추가 조건 (신뢰 만기·정렬 수). 미달이면 B
  let demoted = null;
  if (grade === 'A') {
    if ((m.reliableCount ?? 0) < T.aReliableMin) demoted = `신뢰 만기 ${m.reliableCount ?? 0} < ${T.aReliableMin}`;
    else if ((m.alignCount ?? 0) < T.aAlignMin)  demoted = `정렬 ${m.alignCount ?? 0} < ${T.aAlignMin}`;
    if (demoted) grade = 'B';
  }
  return { grade, pillars: p, exclude: null, demoted };
}

// ─── v0.5: 8주 합산 스트라이크 (기존 차트 모듈 입력용) ─────────────
// 반환: [{strike, dex, gex, vanna, charm, callOI, putOI, avg_iv}] 오름차순, 단위 $M
// 부호는 Radar 규약 그대로 (vanna 양수 = IV 하락 시 딜러 매수). EM 차트의 "vanna>0 = VIX↓ 상승 압력" 해석과 일치.
export function aggregateStrikes(m) {
  const spot = m?.spot_price;
  if (!spot || !m.expiries?.length) return [];
  const w8 = m.expiries.filter(e => e.dte > 0 && e.dte <= 56);
  const acc = new Map();
  for (const e of w8) {
    for (const s of (e.strikes ?? [])) {
      const sup = strikeSupport(spot, s, e.dte);
      const a = acc.get(s.strike) ?? { strike: s.strike, dex: 0, gex: 0, vanna: 0, charm: 0, callOI: 0, putOI: 0, _ivSum: 0, _ivN: 0 };
      a.dex    += sup.dexNet;
      a.gex    += sup.gexNet;
      a.vanna  += sup.vannaSupport;
      a.charm  += sup.charmSupport;
      a.callOI += s.call_oi ?? 0;
      a.putOI  += s.put_oi  ?? 0;
      const iv = s.avg_iv ?? s.call_iv ?? s.put_iv;
      if (iv > 0) { a._ivSum += iv; a._ivN++; }
      acc.set(s.strike, a);
    }
  }
  return [...acc.values()]
    .map(a => ({ strike: a.strike, dex: a.dex, gex: a.gex, vanna: a.vanna, charm: a.charm,
                 callOI: a.callOI, putOI: a.putOI, avg_iv: a._ivN ? a._ivSum / a._ivN : null }))
    .sort((a, b) => a.strike - b.strike);
}

// 만기별 스트라이크 (Vanna 히트맵 입력용): [{expiry, dte, strikes:[{strike, vanna, dex, gex, callOI, putOI}]}]
export function strikesPerExpiry(m) {
  const spot = m?.spot_price;
  if (!spot) return [];
  return (m.expiries ?? [])
    .filter(e => e.dte > 0 && e.dte <= 56)
    .map(e => ({
      expiry: e.expiry_date, dte: e.dte,
      strikes: (e.strikes ?? []).map(s => {
        const sup = strikeSupport(spot, s, e.dte);
        return { strike: s.strike, vanna: sup.vannaSupport, dex: sup.dexNet, gex: sup.gexNet,
                 callOI: s.call_oi ?? 0, putOI: s.put_oi ?? 0 };
      }),
    }));
}

const GRADE_RANK = { A: 0, B: 1, C: 2, X: 3 };

// gradeOf: m → 'A'|'B'|'C'|'X'. 등급 → 기존 정렬 키 순
export function sortByOpinion(list, gradeOf) {
  return [...list].sort((a, b) => {
    const g = (GRADE_RANK[gradeOf(a)] ?? 9) - (GRADE_RANK[gradeOf(b)] ?? 9);
    return g !== 0 ? g : cmpCandidates(a, b);
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
  if (m.bbLogPos != null)
    parts.push(`로그%B ${(m.bbLogPos * 100).toFixed(0)}${m.bbTouch5d ? ` · 하단터치 ${m.bbTouchDate ?? ''}`.trimEnd() : ''}`);
  if (m.trendOk != null && !m.trendMissing)
    parts.push(m.trendOk ? '200일선↑' : '200일선↓');
  if (m.wallDistAtr != null)
    parts.push(`폭 ${m.wallDistAtr.toFixed(1)}ATR`);
  return parts.join(' · ');
}
