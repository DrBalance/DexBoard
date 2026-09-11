// radar-engine 단위 테스트
// 실행: node --input-type=module < frontend/js/radar-engine.test.mjs
import {
  bsGreeks, strikeSupport, opexCalendar, expiryMetrics, tickerMetrics,
  pillars, opinion, sortByOpinion,
} from './radar-engine.js';

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

// ── 테스트 6: 4기둥 병목 등급
{
  console.log('\n[테스트 6] pillars / opinion 병목 등급');
  const base = {
    keyExpiry: { skewRel: 0.12, vannaSupport: 1.2, charmSupport: 0.3, window: 'B' },
    daysToKey: 6, bb: { bb_position: 0.15 }, wallDistAtr: 2.0,
  };
  const ok = { exclude: null, badges: [] };

  const a = opinion(base, ok);
  assert('전부 강 → A', a.grade === 'A', `grade=${a.grade} ${JSON.stringify(a.pillars)}`);

  const b = opinion({ ...base, bb: { bb_position: 0.4 } }, ok);
  assert('위치 중(%B 0.4) → B', b.grade === 'B' && b.pillars.position === 2, `grade=${b.grade}`);

  const c = opinion({ ...base, wallDistAtr: 0.3 }, ok);
  assert('폭 부족(0.3 ATR) → 위치 약 → C', c.grade === 'C' && c.pillars.position === 1, `grade=${c.grade}`);

  const c2 = opinion({ ...base, keyExpiry: { ...base.keyExpiry, charmSupport: -0.1, vannaSupport: -0.1 } }, ok);
  assert('Vanna·Charm 둘 다 음수 → 연료 약 → C', c2.grade === 'C' && c2.pillars.fuel === 1, `grade=${c2.grade}`);

  const unk = opinion({ ...base, bb: null, wallDistAtr: null }, ok);
  assert('BB 없음 → 위치 null → B (A 불가)', unk.grade === 'B' && unk.pillars.position === null, `grade=${unk.grade}`);

  const x = opinion(base, { exclude: 'no_fuel', badges: [] });
  assert('제외 → X', x.grade === 'X' && x.exclude === 'no_fuel', `grade=${x.grade}`);

  const t = pillars({ ...base, daysToKey: 20, keyExpiry: { ...base.keyExpiry, window: 'A' } });
  assert('D-20 창A → 타이밍 중', t.timing === 2, `timing=${t.timing}`);
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
