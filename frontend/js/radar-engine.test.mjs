// radar-engine 단위 테스트
// 실행: node --input-type=module < frontend/js/radar-engine.test.mjs
import {
  bsGreeks, strikeSupport, opexCalendar, expiryMetrics, tickerMetrics,
  pillars, opinion, sortByOpinion, classify,
  logBB, positionGate, trendGate, aggregateStrikes, strikesPerExpiry, PILLAR_THRESHOLDS,
} from './radar-engine.js';

// v0.5 게이트 통과용 BB 모의값 (로그 %B 0.15, 당일 저가가 하단 터치, 200일선 위)
const BB_OK = { date: '2026-09-18', close: 100, bb_log_pos: 0.15, bb_log_low_pos: -0.02, sma200: 90, atr20: 4, bb_position: 0.2 };

let passed = 0, failed = 0;

function assert(label, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ── 테스트 1: 콜 OI 1000 (spot=100, K=110) → vannaSupport > 0, charmSupport > 0
{
  console.log('\n[테스트 1] 콜 OI 1000 (spot=100, K=110)');
  const s = { strike: 110, call_iv: 0.3, put_iv: null, avg_iv: 0.3, call_oi: 1000, put_oi: 0 };
  const r = strikeSupport(100, s, 30);
  assert('vannaSupport > 0', r.vannaSupport > 0, `vannaSupport=${r.vannaSupport.toFixed(4)}`);
  assert('charmSupport > 0', r.charmSupport > 0, `charmSupport=${r.charmSupport.toFixed(4)}`);
}

// ── 테스트 2: 풋 OI 1000 (spot=100, K=90) → vannaSupport > 0, charmSupport > 0
{
  console.log('\n[테스트 2] 풋 OI 1000 (spot=100, K=90)');
  const s = { strike: 90, call_iv: null, put_iv: 0.35, avg_iv: 0.35, call_oi: 0, put_oi: 1000 };
  const r = strikeSupport(100, s, 30);
  // netOI = 0 - 1000 = -1000 → vannaHolder(음수) × 음수 netOI = 양수
  assert('vannaSupport > 0', r.vannaSupport > 0, `vannaSupport=${r.vannaSupport.toFixed(4)}`);
  assert('charmSupport > 0', r.charmSupport > 0, `charmSupport=${r.charmSupport.toFixed(4)}`);
}

// ── 테스트 3: 풋 OI 1000 (spot=100, K=110 — OTM 풋 롱) → vannaSupport < 0
{
  console.log('\n[테스트 3] OTM풋 롱 OI 1000 (spot=100, K=110)');
  // strike > spot → iv = call_iv; netOI = 0 - 1000 = -1000
  // vannaHolder(OTM콜 기준) > 0 → vannaHolder × (-1000) < 0
  const s = { strike: 110, call_iv: 0.3, put_iv: 0.3, avg_iv: 0.3, call_oi: 0, put_oi: 1000 };
  const r = strikeSupport(100, s, 30);
  assert('vannaSupport < 0', r.vannaSupport < 0, `vannaSupport=${r.vannaSupport.toFixed(4)}`);
}

// ── 테스트 4: opexCalendar('2026-09-04') → opex 2026-09-18, window 'B'
{
  console.log('\n[테스트 4] opexCalendar(2026-09-04)');
  const cal = opexCalendar('2026-09-04');
  assert('opex = 2026-09-18', cal.opex === '2026-09-18', `opex=${cal.opex}`);
  assert("window = 'B'", cal.window === 'B', `window=${cal.window} (09-04는 OPEX-14일 이내)`);
  // OPEX 당일 만기는 창 B, 다음날은 A (로컬 TZ와 무관해야 함)
  assert("windowOf('2026-09-18') = 'B'", cal.windowOf('2026-09-18') === 'B', `=${cal.windowOf('2026-09-18')}`);
  assert("windowOf('2026-09-19') = 'A'", cal.windowOf('2026-09-19') === 'A', `=${cal.windowOf('2026-09-19')}`);
  assert("windowOf('2026-09-04') = 'B'", cal.windowOf('2026-09-04') === 'B', `=${cal.windowOf('2026-09-04')}`);
  const onOpex = opexCalendar('2026-09-18');
  assert('OPEX 당일: opex 09-18, B, D-0', onOpex.opex === '2026-09-18' && onOpex.window === 'B' && onOpex.daysToSupport === 0,
    `opex=${onOpex.opex} win=${onOpex.window} d=${onOpex.daysToSupport}`);
  const after = opexCalendar('2026-09-19');
  assert('OPEX 다음날: opex 10-16, A', after.opex === '2026-10-16' && after.window === 'A', `opex=${after.opex} win=${after.window}`);
}

// ── 테스트 5: tickerMetrics 구조 검증 — callWall은 callDex(delta×OI) 최대 스트라이크
// spot=100 기준. K=115에 call_oi를 집중하면 callWall=115가 나와야 함.
{
  console.log('\n[테스트 5] tickerMetrics 구조 검증 (모의 데이터)');

  const makeExpiry = (expiry_date, dte, atm_iv, strikes) => ({
    expiry_date, dte, expiry_type: 'monthly', atm_iv, call_oi: 10000, put_oi: 8000,
    flip_strike: 95, strikes,
  });
  const makeStrike = (strike, call_iv, put_iv, call_oi, put_oi) => ({
    strike, call_iv, put_iv, avg_iv: (call_iv + put_iv) / 2,
    call_delta: null, call_oi, put_oi,
  });

  // K=115에 call_oi=30000 집중 → callDex 최대, callWall=115 기대
  // (K=115, spot=100, dte=30, iv=0.35 → delta≈0.11 → callDex≈0.033 $M per expiry)
  // K=110 대비: call_oi=2000, delta≈0.19 → callDex≈0.0038 (훨씬 작음)
  const strikes = [
    makeStrike(90,  0.40, 0.50, 3000, 8000),
    makeStrike(95,  0.37, 0.45, 4000, 6000),
    makeStrike(100, 0.33, 0.38, 5000, 5000), // ATM
    makeStrike(105, 0.30, 0.33, 2000, 1500),
    makeStrike(110, 0.28, 0.30, 2000,  500),
    makeStrike(115, 0.25, 0.28, 30000, 300), // callWall 후보
    makeStrike(120, 0.22, 0.25, 1000,  100),
  ];

  const expiries = [
    makeExpiry('2026-09-19', 15, 0.35, strikes),
    makeExpiry('2026-10-17', 43, 0.33, strikes),
  ];

  const cal = opexCalendar('2026-09-04');
  const m = tickerMetrics({ symbol: 'TEST', spot_price: 100, expiries, bb: null }, cal);

  assert('tickerMetrics 반환 있음', m != null);
  assert('callWall = 115', m?.callWall === 115, `callWall=${m?.callWall}`);
  assert('alignCount >= 1', (m?.alignCount ?? 0) >= 1, `alignCount=${m?.alignCount}`);
  assert('oiUpperEdge 존재', m?.oiUpperEdge != null, `oiUpperEdge=${m?.oiUpperEdge}`);
  assert('vannaTotal 숫자', typeof m?.vannaTotal === 'number', `vannaTotal=${m?.vannaTotal?.toFixed(2)}`);
}

// ── 테스트 6: 기둥 병목 등급 (v0.5: 스큐·연료·타이밍·폭, 위치는 게이트)
{
  console.log('\n[테스트 6] pillars / opinion 병목 등급');
  const base = {
    keyExpiry: { skewRel: 0.12, vannaSupport: 1.2, charmSupport: 0.3, window: 'B' },
    daysToKey: 6, wallDistAtr: 2.0, reliableCount: 4, alignCount: 5,
  };
  const ok = { exclude: null, badges: [] };

  const a = opinion(base, ok);
  assert('전부 강 → A', a.grade === 'A', `grade=${a.grade} ${JSON.stringify(a.pillars)}`);
  assert('위치 기둥 없음', !('position' in a.pillars));

  const c = opinion({ ...base, wallDistAtr: 0.3 }, ok);
  assert('폭 부족(0.3 ATR) → 폭 약 → C', c.grade === 'C' && c.pillars.width === 1, `grade=${c.grade}`);

  const c2 = opinion({ ...base, keyExpiry: { ...base.keyExpiry, charmSupport: -0.1, vannaSupport: -0.1 } }, ok);
  assert('Vanna·Charm 둘 다 음수 → 연료 약 → C', c2.grade === 'C' && c2.pillars.fuel === 1, `grade=${c2.grade}`);

  const unk = opinion({ ...base, wallDistAtr: null }, ok);
  assert('폭 불가(null) → 중 취급 → B', unk.grade === 'B' && unk.pillars.width === null, `grade=${unk.grade}`);

  const d1 = opinion({ ...base, reliableCount: 2 }, ok);
  assert('A 조건: 신뢰 만기 2 < 3 → B 강등', d1.grade === 'B' && d1.demoted, `grade=${d1.grade} demoted=${d1.demoted}`);
  const d2 = opinion({ ...base, alignCount: 2 }, ok);
  assert('A 조건: 정렬 2 < 3 → B 강등', d2.grade === 'B' && d2.demoted, `grade=${d2.grade}`);

  const x = opinion(base, { exclude: 'position', badges: [] });
  assert('제외 → X', x.grade === 'X' && x.exclude === 'position', `grade=${x.grade}`);

  const t = pillars({ ...base, daysToKey: 20, keyExpiry: { ...base.keyExpiry, window: 'A' } });
  assert('D-20 창A → 타이밍 중', t.timing === 2, `timing=${t.timing}`);
}

// ── 테스트 6d: 로그 BB / 위치 게이트 / 추세 게이트 (v0.5)
{
  console.log('\n[테스트 6d] logBB · positionGate · trendGate');
  // 종가 20개: 100 고정 + 마지막만 90 → 로그 %B가 0 근처, 저가 88은 하단 아래
  const closes = [...Array(19).fill(100), 90];
  const lows   = [...Array(19).fill(99),  88];
  const bb = logBB(closes, lows);
  // 19일 횡보 후 급락: 밴드가 좁아 종가 90이 하단(≈95)을 뚫음 → %B < 0
  assert('logBB 반환 (급락 봉이 하단 밴드 아래)', bb != null && bb.lower > 90 && bb.basis < 100, `lower=${bb?.lower?.toFixed(2)} basis=${bb?.basis?.toFixed(2)}`);
  assert('종가 %B < 0, 저가 %B < 종가 %B', bb.pos < 0 && bb.lowPos < bb.pos, `pos=${bb.pos.toFixed(3)} lowPos=${bb.lowPos.toFixed(3)}`);
  // 수식 검증: 로그 공간 %B와 선형 밴드 값의 일관성
  const manual = (Math.log(90) - Math.log(bb.lower)) / (Math.log(bb.upper) - Math.log(bb.lower));
  assert('pos = (ln close − ln lower)/(ln upper − ln lower)', Math.abs(bb.pos - manual) < 1e-9);
  // 로그 BB는 상단이 하단보다 중심에서 더 멀다 (비대칭)
  assert('로그 BB 비대칭: upper−basis > basis−lower', (bb.upper - bb.basis) > (bb.basis - bb.lower));
  assert('데이터 부족 → null', logBB([1,2,3]) === null);

  // positionGate
  const g1 = positionGate({ bb: BB_OK, bb_hist: [] });
  assert('당일 터치 + %B 0.15 → ok', g1.ok && g1.touch5d && g1.touchDate === '2026-09-18', JSON.stringify(g1));
  const g2 = positionGate({ bb: { ...BB_OK, bb_log_low_pos: 0.05 }, bb_hist: [
    { date: '2026-09-12', bb_log_pos: 0.1, bb_log_low_pos: -0.1 }, { date: '2026-09-15', bb_log_pos: 0.2, bb_log_low_pos: 0.1 }] });
  assert('3일 전 터치 + 당일 %B 0.15 → ok, touchDate 09-12', g2.ok && g2.touchDate === '2026-09-12', JSON.stringify(g2));
  const g3 = positionGate({ bb: { ...BB_OK, bb_log_low_pos: 0.05 }, bb_hist: [] });
  assert('터치 없음 → position 제외', !g3.ok && g3.reason === 'position' && g3.touch5d === false);
  const g4 = positionGate({ bb: { ...BB_OK, bb_log_pos: 0.4 }, bb_hist: [] });
  assert('터치했지만 %B 0.4 (반등 진행) → position 제외', !g4.ok && g4.touch5d === true && g4.reason === 'position');
  const g5 = positionGate({ bb: null, bb_hist: [] });
  assert('BB 없음 → no_bb', !g5.ok && g5.reason === 'no_bb');
  // touchDays 창 밖의 터치는 무시 (hist 6개 중 첫 번째만 터치)
  const hist6 = [{ date: 'd0', bb_log_low_pos: -0.1 }, ...[1,2,3,4,5].map(i => ({ date: 'd' + i, bb_log_low_pos: 0.2 }))];
  const g6 = positionGate({ bb: { ...BB_OK, bb_log_low_pos: 0.1, date: 'd5' }, bb_hist: hist6 });
  assert(`${PILLAR_THRESHOLDS.touchDays}일 창 밖 터치는 무시`, !g6.ok && g6.touch5d === false, JSON.stringify(g6));

  // trendGate
  assert('close 100 > sma200 90 → ok', trendGate({ bb: BB_OK }).ok === true);
  assert('close 100 ≤ sma200 110 → trend', trendGate({ bb: { ...BB_OK, sma200: 110 } }).reason === 'trend');
  const tm = trendGate({ bb: { ...BB_OK, sma200: null } });
  assert('sma200 없음 → 통과 + missing', tm.ok && tm.missing);
}

// ── 테스트 6b: atm_iv 이상치 → skewRel null + lowConf
{
  console.log('\n[테스트 6b] atm_iv < 0.05 → 스큐 무효');
  const strikes = [
    { strike: 90,  call_iv: 0.40, put_iv: 0.50, avg_iv: 0.45, call_oi: 3000, put_oi: 8000 },
    { strike: 95,  call_iv: 0.37, put_iv: 0.45, avg_iv: 0.41, call_oi: 4000, put_oi: 6000 },
    { strike: 100, call_iv: 0.33, put_iv: 0.38, avg_iv: 0.355, call_oi: 5000, put_oi: 5000 },
    { strike: 105, call_iv: 0.30, put_iv: 0.33, avg_iv: 0.315, call_oi: 2000, put_oi: 1500 },
    { strike: 110, call_iv: 0.28, put_iv: 0.30, avg_iv: 0.29, call_oi: 2000, put_oi: 500 },
  ];
  const bad = expiryMetrics(100, { expiry_date: '2026-09-18', dte: 11, atm_iv: 0.03, strikes });
  assert('skewRel null', bad.skewRel === null, `skewRel=${bad.skewRel}`);
  assert('lowConf true', bad.lowConf === true);
  assert('vannaSupport는 계속 계산', typeof bad.vannaSupport === 'number' && bad.vannaSupport !== 0);
  // dte 46 → 1.5σ ≈ 18.6 → 밴드 안에 양쪽 2개씩 확보 (lowConf false)
  const good = expiryMetrics(100, { expiry_date: '2026-10-23', dte: 46, atm_iv: 0.35, strikes });
  assert('정상 atm_iv는 skewRel 계산', good.skewRel != null && good.lowConf === false, `skewRel=${good.skewRel} lowConf=${good.lowConf}`);
  // 밴드 부족으로 대체 규칙 사용 시 lowConf true (설계 2-2)
  const narrow = expiryMetrics(100, { expiry_date: '2026-09-18', dte: 11, atm_iv: 0.35, strikes });
  assert('밴드 부족 → lowConf true', narrow.lowConf === true && narrow.skewRel != null);
  // put_iv null인 스트라이크는 평균에서 제외 (0으로 계산 금지)
  const nullIV = strikes.map(s => s.strike === 95 ? { ...s, put_iv: null, avg_iv: null } : s);
  const n = expiryMetrics(100, { expiry_date: '2026-10-23', dte: 46, atm_iv: 0.35, strikes: nullIV });
  assert('null IV 제외 → skewRel ≈ (0.50−0.29)/0.35', Math.abs(n.skewRel - (0.50 - 0.29) / 0.35) < 1e-9, `skewRel=${n.skewRel}`);
}

// ── 테스트 6c: lowConf 만기는 keyExpiry에서 제외, 신뢰 만기 없으면 classify → 'low_conf'
{
  console.log('\n[테스트 6c] lowConf 만기 제외');
  const mk = (strike, civ, piv, coi, poi) => ({ strike, call_iv: civ, put_iv: piv, avg_iv: (civ + piv) / 2, call_oi: coi, put_oi: poi });
  // 스트라이크 간격 $10 → dte 11(1.5σ≈9)에서는 밴드 부족(lowConf), dte 56(1.5σ≈21)에서는 충분
  const strikes = [mk(80, .42, .55, 3000, 9000), mk(90, .38, .48, 4000, 7000), mk(100, .33, .38, 5000, 5000),
    mk(110, .30, .32, 6000, 1500), mk(120, .28, .30, 2000, 500)];
  const cal = opexCalendar('2026-09-07');
  const nearOnly = tickerMetrics({ symbol: 'N', spot_price: 100, bb: null,
    expiries: [{ expiry_date: '2026-09-18', dte: 11, atm_iv: 0.35, strikes }] }, cal);
  assert('근월만(lowConf) → reliableCount 0, keyExpiry null', nearOnly.reliableCount === 0 && nearOnly.keyExpiry === null);
  assert("classify → 'low_conf'", classify(nearOnly, null).exclude === 'low_conf');
  const mkT = (bb, bb_hist = []) => tickerMetrics({ symbol: 'B', spot_price: 100, bb, bb_hist,
    expiries: [{ expiry_date: '2026-09-18', dte: 11, atm_iv: 0.35, strikes },
               { expiry_date: '2026-11-02', dte: 56, atm_iv: 0.35, strikes }] }, cal);
  const both = mkT(BB_OK);
  assert('근월+차월 → keyExpiry는 차월(11-02)', both.keyExpiry?.expiry_date === '2026-11-02', `key=${both.keyExpiry?.expiry_date}`);
  assert('classify 통과 (BB 게이트 OK)', classify(both, null).exclude === null, `exclude=${classify(both, null).exclude}`);
  // v0.5 제외 트리 순서: low_conf → no_bb → position → trend → call_skew → no_fuel
  assert("BB 없음 → 'no_bb'", classify(mkT(null), null).exclude === 'no_bb');
  assert("하단 터치 없음 → 'position'", classify(mkT({ ...BB_OK, bb_log_low_pos: 0.1 }), null).exclude === 'position');
  assert("200일선 아래 → 'trend'", classify(mkT({ ...BB_OK, sma200: 120 }), null).exclude === 'trend');
  const noSma = classify(mkT({ ...BB_OK, sma200: null }), null);
  assert("sma200 없음 → 통과 + 배지", noSma.exclude === null && noSma.badges.includes('200일선 없음'));
  assert("tickerMetrics에 bbLogPos·bbTouch5d·trendOk", both.bbLogPos === 0.15 && both.bbTouch5d === true && both.trendOk === true);
}

// ── 테스트 6e: aggregateStrikes / strikesPerExpiry 부호 (차트 모듈 입력)
{
  console.log('\n[테스트 6e] aggregateStrikes 부호');
  const strikes = [
    { strike: 90,  call_iv: 0.40, put_iv: 0.50, avg_iv: 0.45, call_oi: 0,    put_oi: 8000 },
    { strike: 110, call_iv: 0.28, put_iv: 0.30, avg_iv: 0.29, call_oi: 6000, put_oi: 0 },
  ];
  const cal = opexCalendar('2026-09-07');
  const m = tickerMetrics({ symbol: 'S', spot_price: 100, bb: BB_OK, bb_hist: [],
    expiries: [{ expiry_date: '2026-10-16', dte: 39, atm_iv: 0.35, strikes }] }, cal);
  const agg = aggregateStrikes(m);
  const k90 = agg.find(a => a.strike === 90), k110 = agg.find(a => a.strike === 110);
  assert('풋(90): dex < 0, gex < 0, vanna > 0(딜러 숏풋 지지)', k90.dex < 0 && k90.gex < 0 && k90.vanna > 0,
    `dex=${k90.dex.toFixed(3)} gex=${k90.gex.toFixed(3)} vanna=${k90.vanna.toFixed(3)}`);
  assert('콜(110): dex > 0, gex > 0, vanna > 0(딜러 롱콜 지지)', k110.dex > 0 && k110.gex > 0 && k110.vanna > 0,
    `dex=${k110.dex.toFixed(3)} gex=${k110.gex.toFixed(3)} vanna=${k110.vanna.toFixed(3)}`);
  assert('avg_iv 채움', k90.avg_iv === 0.45);
  const spe = strikesPerExpiry(m);
  assert('strikesPerExpiry 1만기·2스트라이크·vanna 존재', spe.length === 1 && spe[0].strikes.length === 2 && spe[0].expiry === '2026-10-16'
    && typeof spe[0].strikes[0].vanna === 'number');
}

// ── 테스트 7: sortByOpinion — 등급 우선, 동률은 skewRel 내림차순
{
  console.log('\n[테스트 7] sortByOpinion');
  const mk = (symbol, grade, skew) => ({ symbol, keyExpiry: { skewRel: skew }, _g: grade });
  const list = [mk('C1', 'C', 0.30), mk('B1', 'B', 0.05), mk('A1', 'A', 0.11), mk('B2', 'B', 0.09), mk('X1', 'X', 0.50)];
  const sorted = sortByOpinion(list, m => m._g).map(m => m.symbol);
  assert('A1 B2 B1 C1 X1', sorted.join(' ') === 'A1 B2 B1 C1 X1', sorted.join(' '));
}

// ── 테스트 8: tickerMetrics.wallDistAtr
{
  console.log('\n[테스트 8] wallDistAtr');
  const strikes = [
    { strike: 95,  call_iv: 0.37, put_iv: 0.45, avg_iv: 0.41, call_delta: null, call_oi: 4000, put_oi: 6000 },
    { strike: 100, call_iv: 0.33, put_iv: 0.38, avg_iv: 0.355, call_delta: null, call_oi: 5000, put_oi: 5000 },
    { strike: 110, call_iv: 0.28, put_iv: 0.30, avg_iv: 0.29, call_delta: null, call_oi: 30000, put_oi: 500 },
  ];
  const expiries = [{ expiry_date: '2026-09-19', dte: 15, expiry_type: 'monthly', atm_iv: 0.35,
    call_oi: 39000, put_oi: 11500, flip_strike: 95, strikes }];
  const cal = opexCalendar('2026-09-04');
  const m = tickerMetrics({ symbol: 'T', spot_price: 100, expiries, bb: { bb_position: 0.2, atr20: 4 } }, cal);
  assert('callWall=110, wallDistAtr=2.5', m?.callWall === 110 && Math.abs(m.wallDistAtr - 2.5) < 1e-9,
    `callWall=${m?.callWall} wallDistAtr=${m?.wallDistAtr}`);
  const m2 = tickerMetrics({ symbol: 'T', spot_price: 100, expiries, bb: null }, cal);
  assert('atr20 없음 → wallDistAtr null', m2?.wallDistAtr === null);
}

console.log(`\n결과: ${passed}개 통과 / ${passed + failed}개 중`);
if (failed > 0) process.exit(1);
