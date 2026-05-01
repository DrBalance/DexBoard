// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// narrative.js — 자체 시장 판단 로직
//
// buildNarrative(state) → [{ level, msg }]
//   level: 'danger' | 'warn' | 'good' | 'info'
//
// 판단 규칙:
//   1. VIX 방향 × Vanna 부호 → 헤징 방향
//   2. Flip Zone 근접도
//   3. GEX 상태 (pin vs trend)
//   4. Charm 타이밍 (오후 1시 / 마감 1시간)
//   5. VOLD 방향 확인
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── Flip Zone 계산 (DEX 부호 전환 구간) ──────────────────
function findFlipZone(strikes) {
  if (!strikes || strikes.length < 2) return null;

  // strike 기준 합산 (Call+Put)
  const map = {};
  for (const row of strikes) {
    const k = row.strike;
    if (!map[k]) map[k] = 0;
    map[k] += row.dex || 0;
  }

  const sorted = Object.entries(map)
    .map(([k, dex]) => ({ strike: parseFloat(k), dex }))
    .sort((a, b) => a.strike - b.strike);

  // 인접 strike 간 부호 전환 지점 탐색
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].dex * sorted[i + 1].dex < 0) {
      // 절대값 가중 중간값
      const a = sorted[i], b = sorted[i + 1];
      return (a.strike * Math.abs(b.dex) + b.strike * Math.abs(a.dex)) /
             (Math.abs(a.dex) + Math.abs(b.dex));
    }
  }
  return null;
}

// ── 주요 레벨 계산 (Call Wall / Put Wall) ────────────────
function findWalls(strikes) {
  if (!strikes || strikes.length === 0) return { callWall: null, putWall: null };

  const map = {};
  for (const row of strikes) {
    const k = row.strike;
    if (!map[k]) map[k] = { strike: parseFloat(k), callDex: 0, putDex: 0 };
    if (row.type === 'C') map[k].callDex += row.dex || 0;
    if (row.type === 'P') map[k].putDex  += row.dex || 0;
  }

  const rows = Object.values(map);
  const callWall = rows.reduce((best, r) =>
    r.callDex > (best?.callDex ?? -Infinity) ? r : best, null);
  const putWall  = rows.reduce((best, r) =>
    r.putDex  < (best?.putDex  ??  Infinity) ? r : best, null);

  return {
    callWall: callWall?.strike ?? null,
    putWall:  putWall?.strike  ?? null,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// buildNarrative — 진입점
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function buildNarrative(state) {
  const {
    spy, vix, gex, vanna, charm, vold,
    strikes = [],
    spyLive,
    marketState,
  } = state;

  const events  = [];
  const spot    = spyLive ?? spy?.price;
  const etHour  = window._etHour ?? 0;

  if (!spot) {
    events.push({ level: 'info', msg: '데이터 로딩 중…' });
    return events;
  }

  // ── 1. VIX 방향 × Vanna ──────────────────────────────
  const vixNow      = vix?.price;
  const vixPrevClose = vix?.change != null && vixNow != null
    ? vixNow - vix.change : null;
  const vixChangePct = vix?.changePct ?? 0;

  if (vixNow != null && vanna != null) {
    if (vixChangePct > 1.0 && vanna < 0) {
      events.push({
        level: 'danger',
        msg: `VIX +${vixChangePct.toFixed(1)}% 상승 × Vanna 음수(${(vanna/1e6).toFixed(0)}M) — 딜러 매도 헤지 압력 강화 중`,
      });
    } else if (vixChangePct < -1.0 && vanna > 0) {
      events.push({
        level: 'good',
        msg: `VIX ${vixChangePct.toFixed(1)}% 하락 × Vanna 양수(${(vanna/1e6).toFixed(0)}M) — 딜러 매수 지지 강화 중`,
      });
    } else if (vixChangePct < -1.0 && vanna < 0) {
      events.push({
        level: 'info',
        msg: `VIX ${vixChangePct.toFixed(1)}% 하락 — Vanna 음수이나 VIX 하락으로 매도 압력 완화 중`,
      });
    } else if (vixChangePct > 1.0 && vanna > 0) {
      events.push({
        level: 'warn',
        msg: `VIX +${vixChangePct.toFixed(1)}% 상승 — Vanna 양수로 지지 약화. 방향 주목 필요`,
      });
    }
  }

  // ── 2. Flip Zone 근접 ─────────────────────────────────
  const flipZone = findFlipZone(strikes);
  if (flipZone && spot) {
    const dist = Math.abs(spot - flipZone) / spot * 100;
    if (dist < 0.3) {
      events.push({
        level: 'danger',
        msg: `⚡ Flip Zone $${flipZone.toFixed(0)} 극근접 (${dist.toFixed(2)}%) — 이탈 시 딜러 방향 전환, 변동성 확대 가능`,
      });
    } else if (dist < 0.8) {
      events.push({
        level: 'warn',
        msg: `Flip Zone $${flipZone.toFixed(0)} 근접 (${dist.toFixed(2)}%) — 이탈 여부 주목`,
      });
    }
  }

  // ── 3. Call Wall / Put Wall ───────────────────────────
  const { callWall, putWall } = findWalls(strikes);
  if (callWall && spot) {
    const dist = (callWall - spot) / spot * 100;
    if (dist > 0 && dist < 0.5) {
      events.push({
        level: 'warn',
        msg: `Call Wall $${callWall} 근접 (${dist.toFixed(2)}%) — 딜러 매도 헤지 저항 구간`,
      });
    }
  }
  if (putWall && spot) {
    const dist = (spot - putWall) / spot * 100;
    if (dist > 0 && dist < 0.5) {
      events.push({
        level: 'warn',
        msg: `Put Wall $${putWall} 근접 (${dist.toFixed(2)}%) — 딜러 매수 헤지 지지 구간`,
      });
    }
  }

  // ── 4. GEX 상태 ──────────────────────────────────────
  if (gex != null) {
    const gexM = gex / 1e6;
    if (gexM > 500) {
      events.push({
        level: 'info',
        msg: `Positive GEX +${gexM.toFixed(0)}M — 변동성 억제 구간. 급등락 가능성 낮음`,
      });
    } else if (gexM < -200) {
      events.push({
        level: 'warn',
        msg: `Negative GEX ${gexM.toFixed(0)}M — 변동성 증폭 구간. 추세 가속 가능`,
      });
    }
  }

  // ── 5. Charm 타이밍 ───────────────────────────────────
  if (charm != null) {
    const charmM = charm / 1e6;
    if (etHour >= 13 && etHour < 13.1) {
      const dir = charmM < 0 ? '매수 드리프트' : '하락 드리프트';
      events.push({
        level: charmM < 0 ? 'good' : 'warn',
        msg: `오후 1시 ET — Charm(${charmM.toFixed(0)}M) ${dir} 시작. 시간 압력이 가격에 반영되기 시작합니다`,
      });
    }
    if (etHour >= 15 && etHour < 15.1) {
      events.push({
        level: 'warn',
        msg: `마감 1시간 전 — Charm 효과 최대화. 딜러 헤지 청산 물량 주의. 방향성 확대 가능`,
      });
    }
  }

  // ── 6. VOLD 방향 확인 ────────────────────────────────
  if (vold != null && Math.abs(vold) > 1_000_000) {
    const voldM = vold / 1e6;
    const spyDir = (spy?.changePct ?? 0) >= 0 ? '상승' : '하락';
    if (vold > 0 && (spy?.changePct ?? 0) < 0) {
      events.push({
        level: 'good',
        msg: `VOLD +${voldM.toFixed(1)}M — SPY 하락 중이나 수급은 매수 우위. 반전 가능성 주목`,
      });
    } else if (vold < 0 && (spy?.changePct ?? 0) > 0) {
      events.push({
        level: 'warn',
        msg: `VOLD ${voldM.toFixed(1)}M — SPY 상승 중이나 수급은 매도 우위. 상승 신뢰도 낮음`,
      });
    }
  }

  // ── 기본 메시지 ───────────────────────────────────────
  if (events.length === 0) {
    const dexDir = (gex ?? 0) >= 0 ? '매수' : '매도';
    events.push({
      level: 'info',
      msg: `현재가 $${spot?.toFixed(2)} — 주요 트리거 없음. 딜러 ${dexDir} 헤지 구조 유지 중`,
    });
  }

  return events;
}

// ── 내보내기 (Gemini 호출용 데이터 조립) ─────────────────
export function buildAnalysisPayload(state) {
  const { spy, vix, gex, vanna, charm, vold, strikes, spyLive, marketState } = state;
  const etHour = window._etHour ?? 0;
  const h      = Math.floor(etHour);
  const m      = Math.floor((etHour - h) * 60);
  const etTime = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} ET`;

  return {
    marketState:   marketState ?? window._marketState ?? 'UNKNOWN',
    etTime,
    spot:          spyLive ?? spy?.price,
    spyChangePct:  spy?.changePct?.toFixed(2) ?? '—',
    vix:           vix?.price,
    vixChangePct:  vix?.changePct?.toFixed(2) ?? '—',
    dex:           (gex   ?? 0) * 1e6,  // KV는 M단위, Gemini프롬프트에서 /1e6 처리
    gex:           (gex   ?? 0) * 1e6,
    vanna:         (vanna ?? 0) * 1e6,
    charm:         (charm ?? 0) * 1e6,
    vold:          (vold  ?? 0) * 1e6,
    strikes:       strikes ?? [],
  };
}
