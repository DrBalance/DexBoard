// radar-engine 단위 테스트
// 실행: node --input-type=module < frontend/js/radar-engine.test.mjs
import { bsGreeks, strikeSupport, opexCalendar, expiryMetrics, tickerMetrics } from './radar-engine.js';

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

console.log(`\n결과: ${passed}개 통과 / ${passed + failed}개 중`);
if (failed > 0) process.exit(1);
