import { CF_API } from './config.js';
import { createZoomState, attachZoomScroll } from './chart-zoom.js';

export function linearRegressionSlope(rows) {
  const n  = rows.length;
  if (n < 2) return 0;
  const xMean = rows.reduce((s, r) => s + r.dte, 0) / n;
  const yMean = rows.reduce((s, r) => s + r.atm_iv, 0) / n;
  const num   = rows.reduce((s, r) => s + (r.dte - xMean) * (r.atm_iv - yMean), 0);
  const den   = rows.reduce((s, r) => s + (r.dte - xMean) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

export function detectEventExpiries(rows) {
  if (rows.length < 3) return new Set();
  const eventSet = new Set();
  for (let i = 1; i < rows.length - 1; i++) {
    const prev = rows[i - 1].atm_iv;
    const curr = rows[i].atm_iv;
    const next = rows[i + 1].atm_iv;
    const localAvg = (prev + next) / 2;
    // 주변 평균 대비 15% 이상 튀면 이벤트 만기
    if (curr > localAvg * 1.15) {
      eventSet.add(rows[i].expiry_date);
    }
  }
  return eventSet;
}

export function calculateTermStructure(expiryRows, prevRows = null) {
  const sorted = [...expiryRows]
    .filter(r => r.atm_iv != null && r.dte != null)
    .sort((a, b) => a.dte - b.dte);
  if (sorted.length < 2) return { status: 'unknown', slope: null, rows: sorted };

  // 이벤트 만기 감지
  const eventExpiries = detectEventExpiries(sorted);

  // 이벤트 만기 제외 후 선형 회귀 기울기 계산
  const cleanRows = sorted.filter(r => !eventExpiries.has(r.expiry_date));
  const regSlope  = linearRegressionSlope(cleanRows.length >= 2 ? cleanRows : sorted);

  // 기울기 해석: 양수=우상향=콘탱고, 음수=우하향=백워데이션
  // regSlope 단위: IV/DTE (매우 작은 값)
  let status, label, color;
  if (regSlope > 0.0003) {
    status = 'contango';      label = '콘탱고 ✓';      color = '#22c55e';
  } else if (regSlope < -0.0003) {
    status = 'backwardation'; label = '백워데이션 ⚠️'; color = '#ef4444';
  } else {
    status = 'flat';          label = '플랫 — 변곡점'; color = '#f59e0b';
  }

  // 전일 slope 비교 → 변화 방향
  let slopeChange = null;
  let slopeTrend  = null;
  let priceComment = null;

  if (prevRows && prevRows.length >= 2) {
    const prevSorted = [...prevRows]
      .filter(r => r.atm_iv != null && r.dte != null)
      .sort((a, b) => a.dte - b.dte);
    const prevEventExpiries = detectEventExpiries(prevSorted);
    const prevClean = prevSorted.filter(r => !prevEventExpiries.has(r.expiry_date));
    const prevSlope = linearRegressionSlope(prevClean.length >= 2 ? prevClean : prevSorted);

    slopeChange = regSlope - prevSlope;

    // 변화 방향 판단
    if (status === 'backwardation') {
      if (slopeChange < -0.0001) {
        slopeTrend   = '심화 중 ↓';
        priceComment = { text: '하락 추세 지속', color: '#ef4444', icon: '🔴' };
      } else if (slopeChange > 0.0001) {
        slopeTrend   = '완화 중 ↑';
        priceComment = { text: '반등 가능성 탐색', color: '#f59e0b', icon: '🟡' };
      } else {
        slopeTrend   = '유지';
        priceComment = { text: '하락 추세 지속', color: '#ef4444', icon: '🔴' };
      }
    } else if (status === 'contango') {
      if (slopeChange > 0.0001) {
        slopeTrend   = '강화 중 ↑';
        priceComment = { text: '상승 추세 지속', color: '#22c55e', icon: '🟢' };
      } else if (slopeChange < -0.0001) {
        slopeTrend   = '약화 중 ↓';
        priceComment = { text: '추세 약화 주의', color: '#f97316', icon: '🟠' };
      } else {
        slopeTrend   = '유지';
        priceComment = { text: '상승 추세 지속', color: '#22c55e', icon: '🟢' };
      }
    } else {
      // flat
      if (slopeChange > 0.0001) {
        slopeTrend   = '콘탱고 전환 중 ↑';
        priceComment = { text: '반등 시작 신호', color: '#22c55e', icon: '🟢' };
      } else if (slopeChange < -0.0001) {
        slopeTrend   = '백워데이션 전환 중 ↓';
        priceComment = { text: '반전 하락 주의', color: '#ef4444', icon: '🔴' };
      } else {
        slopeTrend   = '방향 탐색 중';
        priceComment = { text: '방향 불확실', color: '#f59e0b', icon: '🟡' };
      }
    }
  }

  return {
    status, label, color,
    slope: regSlope,
    slopeChange, slopeTrend, priceComment,
    eventExpiries,
    rows: sorted,
  };
}

export function calculateSkew(expiryRows) {
  return expiryRows
    .filter(r => r.atm_iv != null && r.otm_call_iv != null && r.otm_put_iv != null)
    .sort((a, b) => a.dte - b.dte)
    .map(r => ({
      expiry_date: r.expiry_date,
      dte:         r.dte,
      atm_iv:      r.atm_iv,
      call_iv:     r.otm_call_iv,
      put_iv:      r.otm_put_iv,
      skew:        r.otm_put_iv - r.otm_call_iv,  // 양수 = Put 프리미엄 (하방 공포)
      iv_skew:     r.iv_skew,
    }));
}

export function calculateExpectedMove(expiryRows, spot) {
  if (!spot) return [];
  return expiryRows
    .filter(r => r.atm_iv != null && r.dte != null && r.dte > 0)
    .sort((a, b) => a.dte - b.dte)
    .map(r => {
      const em     = spot * r.atm_iv * Math.sqrt(r.dte / 365);
      const upper  = spot + em;
      const lower  = spot - em;
      // Skew 보정: Put IV가 높으면 하방 편향
      const skewBias = (r.otm_put_iv != null && r.otm_call_iv != null)
        ? (r.otm_put_iv - r.otm_call_iv) * spot * Math.sqrt(r.dte / 365) * 0.5
        : 0;
      return {
        expiry_date:   r.expiry_date,
        dte:           r.dte,
        em:            +em.toFixed(2),
        upper:         +(upper - skewBias * 0.3).toFixed(2),
        lower:         +(lower - skewBias).toFixed(2),
        em_pct:        +((em / spot) * 100).toFixed(2),
        atm_iv:        r.atm_iv,
      };
    });
}

export function evaluateStatus({ termStructure, skewRows, spot, flipStrike, vannaSum }) {
  let score = 0;
  const reasons = [];

  // 1. Flip Zone 위
  if (flipStrike && spot > flipStrike) {
    score += 2; reasons.push('플립존 위');
  }

  // 2. Term Structure 콘탱고
  if (termStructure?.status === 'contango') {
    score += 2; reasons.push('콘탱고');
  } else if (termStructure?.status === 'backwardation') {
    score -= 1; reasons.push('백워데이션');
  }

  // 3. Skew 완화 (Put 프리미엄 낮음)
  const avgSkew = skewRows.length
    ? skewRows.reduce((s, r) => s + r.skew, 0) / skewRows.length
    : null;
  if (avgSkew != null && avgSkew < 0.02) {
    score += 1; reasons.push('Skew 완화');
  } else if (avgSkew != null && avgSkew > 0.05) {
    score -= 1; reasons.push('Skew 과열');
  }

  // 4. Vanna 양수
  if (vannaSum > 0) {
    score += 1; reasons.push('Vanna 양수');
  }

  let status, label, color;
  if (score >= 4)      { status = 'entry';   label = '🟢 진입 후보';    color = '#22c55e'; }
  else if (score >= 2) { status = 'hold';    label = '🟡 상승세 지속';  color = '#f59e0b'; }
  else if (score >= 0) { status = 'caution'; label = '🟠 청산 근접';    color = '#f97316'; }
  else                 { status = 'avoid';   label = '🔴 관망';          color = '#ef4444'; }

  return { status, label, color, score, reasons };
}

export function renderTermStructure(termData, targetEl) {
  const el = targetEl ?? document.getElementById('struct-term');
  if (!el) return;

  const { status, label, color, slope, slopeChange, slopeTrend, priceComment, eventExpiries, rows } = termData;

  if (!rows.length) {
    el.innerHTML = '<div style="padding:16px;color:var(--text3)">데이터 없음</div>';
    return;
  }

  const W = Math.max(el.clientWidth || 900, 600);
  const H = 220, PL = 52, PR = 20, PT = 16, PB = 36;
  const cW = W - PL - PR, cH = H - PT - PB;

  const ivs  = rows.map(r => r.atm_iv);
  const dtes = rows.map(r => r.dte);
  const minIV  = Math.min(...ivs) * 0.88;
  const maxIV  = Math.max(...ivs) * 1.08;
  const minDTE = Math.min(...dtes);
  const maxDTE = Math.max(...dtes);

  const xScale = dte => PL + ((dte - minDTE) / (maxDTE - minDTE || 1)) * cW;
  const yScale = iv  => PT + (1 - (iv - minIV) / (maxIV - minIV || 1)) * cH;

  const pts = rows.map(r => `${xScale(r.dte).toFixed(1)},${yScale(r.atm_iv).toFixed(1)}`).join(' ');

  const step = Math.ceil(rows.length / 6);
  const xLabels = rows.filter((_, i) => i % step === 0).map(r => `
    <text x="${xScale(r.dte).toFixed(1)}" y="${H - 4}"
      text-anchor="middle" font-size="9" fill="var(--text3)">${r.dte}d</text>
  `).join('');

  const yTicks = [minIV, (minIV + maxIV) / 2, maxIV].map(iv => `
    <text x="${PL - 4}" y="${(yScale(iv) + 4).toFixed(1)}"
      text-anchor="end" font-size="9" fill="var(--text3)">${(iv * 100).toFixed(0)}%</text>
    <line x1="${PL}" y1="${yScale(iv).toFixed(1)}" x2="${W - PR}" y2="${yScale(iv).toFixed(1)}"
      stroke="var(--border)" stroke-width="0.5" stroke-dasharray="3,3"/>
  `).join('');

  // 이벤트 만기 강조 + 일반 포인트
  const circles = rows.map(r => {
    const isEvent = eventExpiries?.has(r.expiry_date);
    return isEvent
      ? `<circle cx="${xScale(r.dte).toFixed(1)}" cy="${yScale(r.atm_iv).toFixed(1)}"
           r="5" fill="#f59e0b" stroke="#fff" stroke-width="1" opacity="0.9">
           <title>⚡ 이벤트 리스크: ${r.expiry_date} (D-${r.dte}) IV ${(r.atm_iv*100).toFixed(1)}%</title>
         </circle>
         <text x="${xScale(r.dte).toFixed(1)}" y="${(yScale(r.atm_iv) - 8).toFixed(1)}"
           text-anchor="middle" font-size="8" fill="#f59e0b">⚡</text>`
      : `<circle cx="${xScale(r.dte).toFixed(1)}" cy="${yScale(r.atm_iv).toFixed(1)}"
           r="3" fill="${color}" opacity="0.8">
           <title>${r.expiry_date} (D-${r.dte}): IV ${(r.atm_iv*100).toFixed(1)}%</title>
         </circle>`;
  }).join('');

  // slope 변화 표시
  const trendHtml = slopeTrend ? `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 16px;flex:1;min-width:140px">
      <div style="font-size:10px;color:var(--text3);margin-bottom:4px">전일 대비 변화</div>
      <div style="font-size:13px;font-weight:700;color:var(--text)">${slopeTrend}</div>
      <div style="font-size:10px;color:var(--text3);margin-top:2px">
        기울기 변화: ${slopeChange > 0 ? '+' : ''}${(slopeChange * 10000).toFixed(1)}
      </div>
    </div>
  ` : '';

  // 가격 방향성 코멘트
  const commentHtml = priceComment ? `
    <div style="
      background:${priceComment.color}22;border:1px solid ${priceComment.color}44;
      border-radius:8px;padding:10px 16px;flex:1;min-width:140px
    ">
      <div style="font-size:10px;color:var(--text3);margin-bottom:4px">가격 방향성 전망</div>
      <div style="font-size:15px;font-weight:800;color:${priceComment.color}">
        ${priceComment.icon} ${priceComment.text}
      </div>
      <div style="font-size:10px;color:var(--text3);margin-top:2px">Term Structure 기반</div>
    </div>
  ` : '';

  // 이벤트 만기 목록
  const eventList = eventExpiries?.size > 0
    ? `<div style="margin-top:8px;padding:8px 12px;background:#f59e0b11;border:1px solid #f59e0b33;border-radius:6px;font-size:11px;color:#f59e0b">
        ⚡ 이벤트 리스크 감지: ${[...eventExpiries].join(', ')} — 어닝/FOMC 등 단기 이벤트 가능성
       </div>`
    : '';

  el.innerHTML = `
    <!-- 상태 요약 카드 -->
    <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <div style="background:${color}22;border:1px solid ${color}44;border-radius:8px;padding:10px 16px;flex:1;min-width:140px">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Term Structure</div>
        <div style="font-size:16px;font-weight:800;color:${color}">${label}</div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">
          ${status === 'contango' ? '단기 IV < 장기 IV · 정상 구조' : status === 'backwardation' ? '단기 IV > 장기 IV · 공포 집중' : '단기 ≈ 장기 IV · 방향 탐색'}
        </div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 16px;flex:1;min-width:140px">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">IV 범위</div>
        <div style="font-size:14px;font-weight:700;color:var(--text)">
          ${(Math.min(...ivs)*100).toFixed(1)}% ~ ${(Math.max(...ivs)*100).toFixed(1)}%
        </div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">D-${minDTE} ~ D-${maxDTE} · ${rows.length}개 만기</div>
      </div>
      ${trendHtml}
      ${commentHtml}
    </div>

    ${eventList}

    <!-- SVG 차트 -->
    <div style="margin-top:10px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">
        ${yTicks}
        <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" opacity="0.9"/>
        <polyline points="${PL},${PT+cH} ${pts} ${xScale(maxDTE).toFixed(1)},${PT+cH}"
          fill="${color}" opacity="0.07"/>
        ${circles}
        ${xLabels}
        <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${PT+cH}" stroke="var(--border)" stroke-width="1"/>
        <line x1="${PL}" y1="${PT+cH}" x2="${W-PR}" y2="${PT+cH}" stroke="var(--border)" stroke-width="1"/>
        <!-- 범례 -->
        <circle cx="${W-PR-70}" cy="${PT+6}" r="3" fill="${color}"/>
        <text x="${W-PR-63}" y="${PT+10}" font-size="9" fill="var(--text3)">ATM IV</text>
        <circle cx="${W-PR-30}" cy="${PT+6}" r="5" fill="#f59e0b" stroke="#fff" stroke-width="1"/>
        <text x="${W-PR-22}" y="${PT+10}" font-size="9" fill="#f59e0b">이벤트</text>
      </svg>
    </div>

    <!-- 만기별 상세 테이블 -->
    <div style="margin-top:12px;overflow-x:auto">
      <table style="width:100%;font-size:11px;border-collapse:collapse">
        <thead>
          <tr style="background:var(--bg3)">
            <th style="text-align:left;padding:5px 8px;color:var(--text3);font-weight:600">만기</th>
            <th style="text-align:right;padding:5px 8px;color:var(--text3);font-weight:600">DTE</th>
            <th style="text-align:right;padding:5px 8px;color:var(--text3);font-weight:600">ATM IV</th>
            <th style="text-align:right;padding:5px 8px;color:#22c55e;font-weight:600">Call IV</th>
            <th style="text-align:right;padding:5px 8px;color:#ef4444;font-weight:600">Put IV</th>
            <th style="text-align:right;padding:5px 8px;color:var(--text3);font-weight:600">Skew</th>
            <th style="text-align:center;padding:5px 8px;color:var(--text3);font-weight:600">비고</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => {
            const skew      = (r.otm_put_iv ?? 0) - (r.otm_call_iv ?? 0);
            const skewColor = skew > 0.03 ? '#ef4444' : skew < -0.01 ? '#22c55e' : 'var(--text3)';
            const rowBg     = i % 2 === 0 ? 'var(--bg2)' : 'var(--bg3)';
            const isEvent   = eventExpiries?.has(r.expiry_date);
            return `
              <tr style="background:${isEvent ? '#f59e0b11' : rowBg}">
                <td style="padding:5px 8px;font-family:var(--mono);color:${isEvent ? '#f59e0b' : 'var(--text)'}">
                  ${r.expiry_date}
                </td>
                <td style="padding:5px 8px;text-align:right;color:var(--text3)">D-${r.dte}</td>
                <td style="padding:5px 8px;text-align:right;font-weight:700;color:${isEvent ? '#f59e0b' : 'var(--text)'}">
                  ${(r.atm_iv * 100).toFixed(1)}%
                </td>
                <td style="padding:5px 8px;text-align:right;color:#22c55e">
                  ${r.otm_call_iv != null ? (r.otm_call_iv*100).toFixed(1)+'%' : '—'}
                </td>
                <td style="padding:5px 8px;text-align:right;color:#ef4444">
                  ${r.otm_put_iv != null ? (r.otm_put_iv*100).toFixed(1)+'%' : '—'}
                </td>
                <td style="padding:5px 8px;text-align:right;color:${skewColor}">
                  ${(skew*100).toFixed(1)}%
                </td>
                <td style="padding:5px 8px;text-align:center;font-size:10px">
                  ${isEvent ? '<span style="color:#f59e0b">⚡ 이벤트</span>' : ''}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

export function renderSkewChart(skewData) {
  const el = document.getElementById('struct-skew');
  if (!el) return;

  if (!skewData.length) {
    el.innerHTML = '<div style="padding:16px;color:var(--text3)">데이터 없음</div>';
    return;
  }

  const W = 520, H = 160, PL = 48, PR = 16, PT = 16, PB = 36;
  const cW = W - PL - PR, cH = H - PT - PB;

  const skews = skewData.map(r => r.skew);
  const dtes  = skewData.map(r => r.dte);
  const maxAbs = Math.max(...skews.map(Math.abs)) * 1.2 || 0.1;
  const minDTE = Math.min(...dtes), maxDTE = Math.max(...dtes);

  const xScale = dte  => PL + ((dte - minDTE) / (maxDTE - minDTE || 1)) * cW;
  const yScale = skew => PT + (1 - (skew + maxAbs) / (2 * maxAbs)) * cH;
  const zeroY  = yScale(0);

  // 바 차트 (만기별 Skew)
  const barW = Math.max(4, cW / skewData.length * 0.6);
  const bars = skewData.map(r => {
    const x    = xScale(r.dte);
    const y0   = zeroY;
    const y1   = yScale(r.skew);
    const barH = Math.abs(y1 - y0);
    const barY = Math.min(y0, y1);
    const col  = r.skew > 0 ? '#ef4444' : '#22c55e';
    return `
      <rect x="${(x - barW / 2).toFixed(1)}" y="${barY.toFixed(1)}"
        width="${barW.toFixed(1)}" height="${barH.toFixed(1)}"
        fill="${col}" opacity="0.7" rx="1">
        <title>${r.expiry_date} Skew: ${(r.skew * 100).toFixed(1)}%
Put IV: ${(r.put_iv * 100).toFixed(1)}% / Call IV: ${(r.call_iv * 100).toFixed(1)}%</title>
      </rect>
      <text x="${x.toFixed(1)}" y="${H - 4}" text-anchor="middle" font-size="9" fill="var(--text3)">
        ${r.dte}d
      </text>
    `;
  }).join('');

  // 평균 Skew 라인
  const avgSkew = skews.reduce((a, b) => a + b, 0) / skews.length;
  const avgY = yScale(avgSkew);
  const avgColor = avgSkew > 0.03 ? '#ef4444' : avgSkew < 0 ? '#22c55e' : '#f59e0b';

  // 요약
  const maxSkewRow = skewData.reduce((m, r) => r.skew > m.skew ? r : m, skewData[0]);
  const skewStatus = avgSkew > 0.05
    ? { label: '공포 과열 ⚠️', color: '#ef4444', desc: '하방 보험료 급등 — 반등 가능성 탐색' }
    : avgSkew > 0.02
    ? { label: '보통 Put 편향', color: '#f59e0b', desc: '완만한 하방 우려' }
    : { label: 'Skew 완화 ✓', color: '#22c55e', desc: '공포 진정 — 상승 구조 우호적' };

  el.innerHTML = `
    <!-- 요약 -->
    <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <div style="background:${skewStatus.color}22;border:1px solid ${skewStatus.color}44;border-radius:8px;padding:10px 16px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Skew 상태</div>
        <div style="font-size:15px;font-weight:800;color:${skewStatus.color}">${skewStatus.label}</div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">${skewStatus.desc}</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 16px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">평균 Skew</div>
        <div style="font-size:15px;font-weight:700;color:${avgColor}">${avgSkew > 0 ? '+' : ''}${(avgSkew * 100).toFixed(2)}%</div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">Put IV − Call IV</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 16px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">최대 Skew 만기</div>
        <div style="font-size:14px;font-weight:700;color:#ef4444">${maxSkewRow.expiry_date}</div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">${(maxSkewRow.skew * 100).toFixed(1)}% (D-${maxSkewRow.dte})</div>
      </div>
    </div>

    <!-- SVG 바 차트 -->
    <div style="overflow-x:auto">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block">
        <!-- 제로 라인 -->
        <line x1="${PL}" y1="${zeroY.toFixed(1)}" x2="${W - PR}" y2="${zeroY.toFixed(1)}"
          stroke="var(--text3)" stroke-width="0.8" stroke-dasharray="4,2"/>
        <text x="${PL - 4}" y="${(zeroY + 4).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text3)">0%</text>
        <!-- 평균 라인 -->
        <line x1="${PL}" y1="${avgY.toFixed(1)}" x2="${W - PR}" y2="${avgY.toFixed(1)}"
          stroke="${avgColor}" stroke-width="1" stroke-dasharray="6,3" opacity="0.7"/>
        ${bars}
        <!-- 축 -->
        <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${PT + cH}" stroke="var(--border)" stroke-width="1"/>
        <!-- Y 레이블 -->
        <text x="${PL - 4}" y="${(PT + 4).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text3)">+${(maxAbs * 100 / 1.2).toFixed(0)}%</text>
        <text x="${PL - 4}" y="${(PT + cH + 4).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text3)">-${(maxAbs * 100 / 1.2).toFixed(0)}%</text>
        <!-- 범례 -->
        <rect x="${W - PR - 80}" y="${PT}" width="10" height="10" fill="#ef4444" rx="1"/>
        <text x="${W - PR - 66}" y="${PT + 9}" font-size="9" fill="var(--text3)">Put 프리미엄</text>
        <rect x="${W - PR - 80}" y="${PT + 14}" width="10" height="10" fill="#22c55e" rx="1"/>
        <text x="${W - PR - 66}" y="${PT + 23}" font-size="9" fill="var(--text3)">Call 프리미엄</text>
      </svg>
    </div>
  `;
}

export function renderSmileSelector(symbol, expiryRows, scoreRow) {
  const el = document.getElementById('struct-smile');
  if (!el) return;

  if (!expiryRows.length) {
    el.innerHTML = '<div style="padding:16px;color:var(--text3)">데이터 없음</div>';
    return;
  }

  const spot = scoreRow?.close ?? null;

  // 만기 선택 탭 렌더링
  el.innerHTML = `
    <div style="margin-bottom:12px">
      <div style="display:flex;gap:6px;flex-wrap:wrap" id="smile-tab-wrap">
        ${expiryRows.map((r, i) => `
          <button class="smile-tab-btn ${i === 0 ? 'active' : ''}"
            data-expiry="${r.expiry_date}"
            style="
              padding:4px 10px;font-size:11px;border-radius:6px;cursor:pointer;
              background:${i === 0 ? 'var(--accent)' : 'var(--bg3)'};
              color:${i === 0 ? '#fff' : 'var(--text3)'};
              border:1px solid ${i === 0 ? 'var(--accent)' : 'var(--border)'};
            ">
            ${r.expiry_date.slice(5)} D-${r.dte}
          </button>
        `).join('')}
      </div>
    </div>
    <div id="smile-chart-area">
      <div style="padding:16px;color:var(--text3);font-size:12px">만기를 선택하면 Smile 곡선을 표시합니다</div>
    </div>
  `;

  // 탭 클릭 이벤트
  el.querySelectorAll('.smile-tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      // 탭 활성화 스타일
      el.querySelectorAll('.smile-tab-btn').forEach(b => {
        b.style.background = 'var(--bg3)';
        b.style.color      = 'var(--text3)';
        b.style.border     = '1px solid var(--border)';
      });
      btn.style.background = 'var(--accent)';
      btn.style.color      = '#fff';
      btn.style.border     = '1px solid var(--accent)';

      const expiry = btn.dataset.expiry;
      await loadSmileChart(symbol, expiry, spot);
    });
  });

  // 첫번째 만기 자동 로드
  loadSmileChart(symbol, expiryRows[0].expiry_date, spot);
}

export async function loadSmileChart(symbol, expiry, spot) {
  const area = document.getElementById('smile-chart-area');
  if (!area) return;
  area.innerHTML = `<div style="padding:16px;color:var(--text3);font-size:12px">로딩 중...</div>`;

  try {
    const res  = await fetch(`${CF_API}/api/options-strikes/${symbol}?expiry=${expiry}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rows = data.rows ?? [];

    if (!rows.length) {
      area.innerHTML = `<div style="padding:16px;color:var(--text3);font-size:12px">
        스트라이크 데이터 없음 — 다음 수집 후 이용 가능합니다
      </div>`;
      return;
    }

    renderSmileCurve(area, rows, spot, expiry);
  } catch (err) {
    area.innerHTML = `<div style="padding:16px;color:#ef4444;font-size:12px">로드 실패: ${err.message}</div>`;
  }
}

export function renderSmileCurve(container, rows, spot, expiry) {
  const W = 520, H = 200, PL = 52, PR = 16, PT = 16, PB = 36;
  const cW = W - PL - PR, cH = H - PT - PB;

  // avg_iv 기준으로 정렬
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  const strikes = sorted.map(r => r.strike);
  const ivs     = sorted.map(r => r.avg_iv ?? 0);

  const minS  = Math.min(...strikes);
  const maxS  = Math.max(...strikes);
  const minIV = Math.min(...ivs.filter(v => v > 0)) * 0.9;
  const maxIV = Math.max(...ivs) * 1.1;

  const xScale = s  => PL + ((s - minS) / (maxS - minS || 1)) * cW;
  const yScale = iv => PT + (1 - (iv - minIV) / (maxIV - minIV || 1)) * cH;

  // ATM 라인
  const atmX = spot ? xScale(spot) : null;

  // Call IV / Put IV / Avg IV 세 곡선
  const callPts = sorted
    .filter(r => r.call_iv)
    .map(r => `${xScale(r.strike).toFixed(1)},${yScale(r.call_iv).toFixed(1)}`).join(' ');
  const putPts = sorted
    .filter(r => r.put_iv)
    .map(r => `${xScale(r.strike).toFixed(1)},${yScale(r.put_iv).toFixed(1)}`).join(' ');
  const avgPts = sorted
    .filter(r => r.avg_iv)
    .map(r => `${xScale(r.strike).toFixed(1)},${yScale(r.avg_iv).toFixed(1)}`).join(' ');

  // X축 레이블 (최대 8개)
  const step = Math.ceil(sorted.length / 8);
  const xLabels = sorted.filter((_, i) => i % step === 0).map(r => `
    <text x="${xScale(r.strike).toFixed(1)}" y="${H - 4}"
      text-anchor="middle" font-size="9" fill="var(--text3)">
      $${r.strike}
    </text>
  `).join('');

  // Y축 레이블
  const yTicks = [minIV, (minIV + maxIV) / 2, maxIV].map(iv => `
    <text x="${PL - 4}" y="${(yScale(iv) + 4).toFixed(1)}"
      text-anchor="end" font-size="9" fill="var(--text3)">${(iv * 100).toFixed(0)}%</text>
    <line x1="${PL}" y1="${yScale(iv).toFixed(1)}" x2="${W - PR}" y2="${yScale(iv).toFixed(1)}"
      stroke="var(--border)" stroke-width="0.5" stroke-dasharray="3,3"/>
  `).join('');

  // Skew 방향 판단 (ATM 기준 좌우 비대칭)
  const atmStrike = spot
    ? sorted.reduce((a, b) => Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a, sorted[0])
    : null;
  const otmPutRows  = spot ? sorted.filter(r => r.strike < spot  && r.put_iv) : [];
  const otmCallRows = spot ? sorted.filter(r => r.strike > spot  && r.call_iv) : [];
  const avgPutIV    = otmPutRows.length  ? otmPutRows.reduce((s, r) => s + r.put_iv, 0)   / otmPutRows.length  : null;
  const avgCallIV   = otmCallRows.length ? otmCallRows.reduce((s, r) => s + r.call_iv, 0) / otmCallRows.length : null;
  const skewDir     = (avgPutIV && avgCallIV)
    ? (avgPutIV > avgCallIV ? 'put' : 'call')
    : null;
  const skewLabel   = skewDir === 'put'  ? '🔴 Put Skew — 하방 공포 우세'
                    : skewDir === 'call' ? '🟢 Call Skew — 상승 기대 우세'
                    : '균형';
  const skewColor   = skewDir === 'put'  ? '#ef4444'
                    : skewDir === 'call' ? '#22c55e'
                    : '#f59e0b';

  container.innerHTML = `
    <!-- Skew 방향 요약 -->
    <div style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap">
      <div style="background:${skewColor}22;border:1px solid ${skewColor}44;border-radius:8px;padding:8px 14px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:2px">${expiry} Smile 방향</div>
        <div style="font-size:14px;font-weight:800;color:${skewColor}">${skewLabel}</div>
      </div>
      ${atmStrike ? `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:8px 14px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:2px">ATM IV</div>
        <div style="font-size:14px;font-weight:700;color:var(--text)">
          ${atmStrike.avg_iv ? (atmStrike.avg_iv * 100).toFixed(1) + '%' : '—'}
          <span style="font-size:10px;color:var(--text3)"> @ $${atmStrike.strike}</span>
        </div>
      </div>
      ` : ''}
      ${avgPutIV && avgCallIV ? `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:8px 14px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:2px">OTM Put / Call IV</div>
        <div style="font-size:12px;font-weight:700">
          <span style="color:#ef4444">${(avgPutIV * 100).toFixed(1)}%</span>
          <span style="color:var(--text3)"> / </span>
          <span style="color:#22c55e">${(avgCallIV * 100).toFixed(1)}%</span>
        </div>
      </div>
      ` : ''}
    </div>

    <!-- SVG Smile 곡선 -->
    <div style="overflow-x:auto">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block">
        ${yTicks}
        <!-- ATM 수직선 -->
        ${atmX ? `
          <line x1="${atmX.toFixed(1)}" y1="${PT}" x2="${atmX.toFixed(1)}" y2="${PT + cH}"
            stroke="#d29922" stroke-width="1" stroke-dasharray="4,3" opacity="0.7"/>
          <text x="${atmX.toFixed(1)}" y="${PT - 3}" text-anchor="middle" font-size="8" fill="#d29922">ATM</text>
        ` : ''}
        <!-- Put IV 곡선 -->
        ${putPts ? `<polyline points="${putPts}" fill="none" stroke="#ef4444" stroke-width="1.5" opacity="0.7" stroke-dasharray="4,2"/>` : ''}
        <!-- Call IV 곡선 -->
        ${callPts ? `<polyline points="${callPts}" fill="none" stroke="#22c55e" stroke-width="1.5" opacity="0.7" stroke-dasharray="4,2"/>` : ''}
        <!-- Avg IV 곡선 (메인) -->
        ${avgPts ? `<polyline points="${avgPts}" fill="none" stroke="#58a6ff" stroke-width="2" opacity="0.9"/>` : ''}
        ${xLabels}
        <!-- 축 -->
        <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${PT + cH}" stroke="var(--border)" stroke-width="1"/>
        <line x1="${PL}" y1="${PT + cH}" x2="${W - PR}" y2="${PT + cH}" stroke="var(--border)" stroke-width="1"/>
        <!-- 범례 -->
        <line x1="${W-PR-110}" y1="${PT+7}" x2="${W-PR-96}" y2="${PT+7}" stroke="#58a6ff" stroke-width="2"/>
        <text x="${W-PR-92}" y="${PT+11}" font-size="9" fill="var(--text3)">Avg IV</text>
        <line x1="${W-PR-65}" y1="${PT+7}" x2="${W-PR-51}" y2="${PT+7}" stroke="#22c55e" stroke-width="1.5" stroke-dasharray="4,2"/>
        <text x="${W-PR-47}" y="${PT+11}" font-size="9" fill="var(--text3)">Call</text>
        <line x1="${W-PR-25}" y1="${PT+7}" x2="${W-PR-11}" y2="${PT+7}" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="4,2"/>
        <text x="${W-PR-7}" y="${PT+11}" font-size="9" fill="var(--text3)">Put</text>
      </svg>
    </div>
  `;
}

export function isMonthlyExpiry(expiry_date) {
  const d = new Date(expiry_date + 'T00:00:00Z');
  if (d.getUTCDay() !== 5) return false;
  const day = d.getUTCDate();
  return day >= 15 && day <= 21;
}

export async function renderOIDistribution(symbol, expiryRows, spot, flipStrike, emData) {
  const el = document.getElementById('struct-oi-dist');
  if (!el) return;

  // Monthly 만기 2개 추출
  const monthlyExpiries = expiryRows
    .filter(r => isMonthlyExpiry(r.expiry_date))
    .sort((a, b) => a.dte - b.dte)
    .slice(0, 2);

  if (!monthlyExpiries.length) {
    el.innerHTML = '<div style="padding:16px;color:var(--text3);font-size:12px">Monthly 만기 데이터 없음</div>';
    return;
  }

  el.innerHTML = '<div style="padding:16px;color:var(--text3);font-size:12px">스트라이크 데이터 로딩 중...</div>';

  try {
    // Monthly 2개 strikes 병렬 로드
    const results = await Promise.all(
      monthlyExpiries.map(exp =>
        fetch(`${CF_API}/api/options-strikes/${symbol}?expiry=${exp.expiry_date}`)
          .then(r => r.ok ? r.json() : { rows: [] })
          .then(d => d.rows ?? [])
      )
    );

    // 합산
    const strikeMap = {};
    for (const rows of results) {
      for (const r of rows) {
        const k = r.strike;
        if (!strikeMap[k]) strikeMap[k] = { strike: k, call_oi: 0, put_oi: 0, avg_iv: 0, count: 0 };
        strikeMap[k].call_oi += r.call_oi ?? 0;
        strikeMap[k].put_oi  += r.put_oi  ?? 0;
        if (r.avg_iv) { strikeMap[k].avg_iv += r.avg_iv; strikeMap[k].count++; }
      }
    }
    const strikes = Object.values(strikeMap)
      .map(r => ({ ...r, avg_iv: r.count ? r.avg_iv / r.count : 0 }))
      .sort((a, b) => a.strike - b.strike);

    if (!strikes.length) {
      el.innerHTML = '<div style="padding:16px;color:var(--text3);font-size:12px">스트라이크 데이터 없음 — 수집 후 이용 가능</div>';
      return;
    }

    // Call Wall (Call OI 최대 스트라이크)
    const callWall = strikes.reduce((m, r) => r.call_oi > m.call_oi ? r : m, strikes[0]);
    // Put Wall (Put OI 최대 스트라이크)
    const putWall  = strikes.reduce((m, r) => r.put_oi > m.put_oi ? r : m, strikes[0]);

    // D-7 EM 범위 (emData에서 dte <= 7 중 가장 가까운 것, 없으면 첫번째)
    const nearEM = emData.find(r => r.dte <= 7) ?? emData[0] ?? null;

    // IV Smile 기반 정규분포 확률 밀도 (스트라이크별)
    const probDist = spot ? strikes.map(r => {
      if (!r.avg_iv || !spot) return 0;
      const dte = monthlyExpiries[0]?.dte ?? 30;
      const sigma = spot * r.avg_iv * Math.sqrt(dte / 365);
      const diff = r.strike - spot;
      return Math.exp(-0.5 * (diff / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI));
    }) : [];
    const maxProb = Math.max(...probDist, 1e-10);
    const normProb = probDist.map(p => p / maxProb);

    // SVG 렌더링
    const W = 560, H = 300, PL = 56, PR = 16, PT = 20, PB = 40;
    const cW = W - PL - PR, cH = H - PT - PB;
    const midY = PT + cH / 2; // 중앙 (Call 위/Put 아래)

    const minS = strikes[0].strike, maxS = strikes[strikes.length - 1].strike;
    const maxCallOI = Math.max(...strikes.map(r => r.call_oi), 1);
    const maxPutOI  = Math.max(...strikes.map(r => r.put_oi), 1);
    const maxOI     = Math.max(maxCallOI, maxPutOI);

    const xScale = s => PL + ((s - minS) / (maxS - minS || 1)) * cW;
    const barH   = (cH / 2) * 0.85; // 최대 막대 높이

    // 막대 너비
    const barW = Math.max(2, cW / strikes.length * 0.75);

    // Call 막대 (위쪽)
    const callBars = strikes.map(r => {
      const x = xScale(r.strike);
      const h = (r.call_oi / maxOI) * barH;
      return `<rect x="${(x - barW/2).toFixed(1)}" y="${(midY - h).toFixed(1)}"
        width="${barW.toFixed(1)}" height="${h.toFixed(1)}"
        fill="#22c55e" opacity="0.6" rx="1">
        <title>Strike $${r.strike} Call OI: ${fmtK(r.call_oi)}</title>
      </rect>`;
    }).join('');

    // Put 막대 (아래쪽)
    const putBars = strikes.map(r => {
      const x = xScale(r.strike);
      const h = (r.put_oi / maxOI) * barH;
      return `<rect x="${(x - barW/2).toFixed(1)}" y="${midY.toFixed(1)}"
        width="${barW.toFixed(1)}" height="${h.toFixed(1)}"
        fill="#ef4444" opacity="0.6" rx="1">
        <title>Strike $${r.strike} Put OI: ${fmtK(r.put_oi)}</title>
      </rect>`;
    }).join('');

    // IV Smile 확률 분포 곡선 (파란 곡선, 위쪽)
    const probPts = strikes.map((r, i) =>
      `${xScale(r.strike).toFixed(1)},${(midY - normProb[i] * barH * 0.9).toFixed(1)}`
    ).join(' ');

    // 수직선들
    const spotX      = spot    ? xScale(spot)            : null;
    const callWallX  = callWall ? xScale(callWall.strike) : null;
    const flipX      = flipStrike ? xScale(Math.max(minS, Math.min(maxS, flipStrike))) : null;
    const emUpperX   = nearEM && spot ? xScale(Math.min(maxS, nearEM.upper)) : null;
    const emLowerX   = nearEM && spot ? xScale(Math.max(minS, nearEM.lower)) : null;

    // X축 레이블
    const step = Math.ceil(strikes.length / 8);
    const xLabels = strikes.filter((_, i) => i % step === 0).map(r => `
      <text x="${xScale(r.strike).toFixed(1)}" y="${H - 6}"
        text-anchor="middle" font-size="9" fill="var(--text3)">$${r.strike}</text>
    `).join('');

    // Y축 레이블
    const yLabels = `
      <text x="${PL - 4}" y="${(midY - barH).toFixed(1)}" text-anchor="end" font-size="9" fill="#22c55e">▲ Call</text>
      <text x="${PL - 4}" y="${(midY + barH + 10).toFixed(1)}" text-anchor="end" font-size="9" fill="#ef4444">▼ Put</text>
      <text x="${PL - 4}" y="${(midY + 4).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text3)">0</text>
    `;

    // EM 음영
    const emShade = (emUpperX && emLowerX) ? `
      <rect x="${emLowerX.toFixed(1)}" y="${PT}"
        width="${(emUpperX - emLowerX).toFixed(1)}" height="${cH}"
        fill="#3b82f6" opacity="0.07"/>
    ` : '';

    el.innerHTML = `
      <!-- 요약 카드 -->
      <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
        <div style="background:#22c55e22;border:1px solid #22c55e44;border-radius:8px;padding:10px 14px;flex:1;min-width:120px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Call Wall</div>
          <div style="font-size:16px;font-weight:800;font-family:var(--mono);color:#22c55e">
            $${callWall.strike.toFixed(0)}
          </div>
          <div style="font-size:10px;color:var(--text3);margin-top:2px">OI ${fmtK(callWall.call_oi)}</div>
        </div>
        <div style="background:#ef444422;border:1px solid #ef444444;border-radius:8px;padding:10px 14px;flex:1;min-width:120px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Put Wall</div>
          <div style="font-size:16px;font-weight:800;font-family:var(--mono);color:#ef4444">
            $${putWall.strike.toFixed(0)}
          </div>
          <div style="font-size:10px;color:var(--text3);margin-top:2px">OI ${fmtK(putWall.put_oi)}</div>
        </div>
        ${flipStrike ? `
        <div style="background:#f59e0b22;border:1px solid #f59e0b44;border-radius:8px;padding:10px 14px;flex:1;min-width:120px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Flip Zone</div>
          <div style="font-size:16px;font-weight:800;font-family:var(--mono);color:#f59e0b">
            $${flipStrike.toFixed(0)}
          </div>
          <div style="font-size:10px;color:var(--text3);margin-top:2px">${spot && spot > flipStrike ? '현재가 위 ▲ Long Gamma' : '현재가 아래 ▼ Short Gamma'}</div>
        </div>` : ''}
        ${nearEM ? `
        <div style="background:#3b82f622;border:1px solid #3b82f644;border-radius:8px;padding:10px 14px;flex:1;min-width:120px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px">D-${nearEM.dte} EM 범위</div>
          <div style="font-size:13px;font-weight:700;font-family:var(--mono);color:#3b82f6">
            $${nearEM.lower.toFixed(0)} ~ $${nearEM.upper.toFixed(0)}
          </div>
          <div style="font-size:10px;color:var(--text3);margin-top:2px">±${nearEM.em_pct}%</div>
        </div>` : ''}
      </div>

      <!-- SVG 차트 -->
      <div style="overflow-x:auto">
        <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block">
          <!-- EM 음영 -->
          ${emShade}
          <!-- 중앙선 -->
          <line x1="${PL}" y1="${midY}" x2="${W - PR}" y2="${midY}"
            stroke="var(--text3)" stroke-width="0.8"/>
          <!-- Call 막대 -->
          ${callBars}
          <!-- Put 막대 -->
          ${putBars}
          <!-- IV 확률 분포 곡선 -->
          ${probPts ? `<polyline points="${probPts}" fill="none" stroke="#3b82f6" stroke-width="2" opacity="0.8"/>` : ''}
          <!-- 현재가 -->
          ${spotX ? `
            <line x1="${spotX.toFixed(1)}" y1="${PT}" x2="${spotX.toFixed(1)}" y2="${PT + cH}"
              stroke="#d29922" stroke-width="1.5" stroke-dasharray="0"/>
            <text x="${spotX.toFixed(1)}" y="${PT - 4}" text-anchor="middle" font-size="9" fill="#d29922">현재가</text>
          ` : ''}
          <!-- Call Wall -->
          ${callWallX ? `
            <line x1="${callWallX.toFixed(1)}" y1="${PT}" x2="${callWallX.toFixed(1)}" y2="${PT + cH}"
              stroke="#22c55e" stroke-width="1.2" stroke-dasharray="5,3" opacity="0.9"/>
            <text x="${callWallX.toFixed(1)}" y="${PT - 4}" text-anchor="middle" font-size="9" fill="#22c55e">Call Wall</text>
          ` : ''}
          <!-- Flip Zone -->
          ${flipX ? `
            <line x1="${flipX.toFixed(1)}" y1="${PT}" x2="${flipX.toFixed(1)}" y2="${PT + cH}"
              stroke="#f59e0b" stroke-width="1.2" stroke-dasharray="4,3" opacity="0.9"/>
            <text x="${flipX.toFixed(1)}" y="${(PT + cH + 12).toFixed(1)}" text-anchor="middle" font-size="9" fill="#f59e0b">Flip</text>
          ` : ''}
          ${xLabels}
          ${yLabels}
          <!-- 축 -->
          <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${PT + cH}" stroke="var(--border)" stroke-width="1"/>
          <!-- 범례 -->
          <rect x="${W-PR-160}" y="${PT+2}" width="10" height="8" fill="#22c55e" opacity="0.6"/>
          <text x="${W-PR-146}" y="${PT+10}" font-size="9" fill="var(--text3)">Call OI</text>
          <rect x="${W-PR-110}" y="${PT+2}" width="10" height="8" fill="#ef4444" opacity="0.6"/>
          <text x="${W-PR-96}" y="${PT+10}" font-size="9" fill="var(--text3)">Put OI</text>
          <line x1="${W-PR-62}" y1="${PT+6}" x2="${W-PR-48}" y2="${PT+6}" stroke="#3b82f6" stroke-width="2"/>
          <text x="${W-PR-44}" y="${PT+10}" font-size="9" fill="var(--text3)">IV 분포</text>
          <rect x="${W-PR-16}" y="${PT+2}" width="10" height="8" fill="#3b82f6" opacity="0.2"/>
          <text x="${W-PR-20}" y="${PT+10}" font-size="9" fill="var(--text3)">EM</text>
        </svg>
      </div>
      <div style="margin-top:6px;font-size:10px;color:var(--text3)">
        Monthly 만기 ${monthlyExpiries.map(e => e.expiry_date).join(' + ')} 합산 · 파란 곡선: ATM IV 기반 정규분포
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<div style="padding:16px;color:#ef4444;font-size:12px">로드 실패: ${err.message}</div>`;
  }
}

export function renderSkewChartImproved(skewData, allRows) {
  const el = document.getElementById('struct-skew');
  if (!el) return;

  if (!skewData.length) {
    el.innerHTML = '<div style="padding:16px;color:var(--text3)">데이터 없음</div>';
    return;
  }

  // netSkew = put_iv - call_iv
  // 양수 → Put 편향(하방 공포), 음수 → Call 편향(상승 과열)
  const enriched = skewData.map(r => ({
    ...r,
    netSkew: r.put_iv - r.call_iv,  // 수정된 계산
  }));

  const avgNetSkew = enriched.reduce((s, r) => s + r.netSkew, 0) / enriched.length;

  // 7일 역사적 평균이 없으므로 현재 만기들의 평균을 기준으로 편차 계산
  const deviations = enriched.map(r => r.netSkew - avgNetSkew);

  // 상태 판정: 편차 기반
  const maxDev = Math.max(...deviations.map(Math.abs), 0.001);
  const overallStatus = (() => {
    if (avgNetSkew > 0.05)       return { label: 'Put 과열 ⚠️',      color: '#ef4444', desc: '하방 공포 집중 — 반등 탐색 가능' };
    if (avgNetSkew > 0.02)       return { label: 'Put 편향',          color: '#f59e0b', desc: '완만한 하방 우려' };
    if (avgNetSkew < -0.02)      return { label: 'Call 편향 (과열)',   color: '#f97316', desc: '상승 기대 과열 — 조정 주의' };
    return                              { label: 'Skew 균형 ✓',       color: '#22c55e', desc: '공포/탐욕 균형 — 옵션 구조 중립' };
  })();

  const W = 520, H = 160, PL = 48, PR = 16, PT = 16, PB = 36;
  const cW = W - PL - PR, cH = H - PT - PB;
  const skews = enriched.map(r => r.netSkew);
  const dtes  = enriched.map(r => r.dte);
  const maxAbs = Math.max(...skews.map(Math.abs)) * 1.3 || 0.1;
  const minDTE = Math.min(...dtes), maxDTE = Math.max(...dtes);

  const xScale = dte  => PL + ((dte - minDTE) / (maxDTE - minDTE || 1)) * cW;
  const yScale = skew => PT + (1 - (skew + maxAbs) / (2 * maxAbs)) * cH;
  const zeroY  = yScale(0);
  const avgY   = yScale(avgNetSkew);

  const barW = Math.max(4, cW / enriched.length * 0.6);
  const bars = enriched.map(r => {
    const x    = xScale(r.dte);
    const y0   = zeroY;
    const y1   = yScale(r.netSkew);
    const bH   = Math.abs(y1 - y0);
    const bY   = Math.min(y0, y1);
    const col  = r.netSkew > 0 ? '#ef4444' : '#22c55e';
    // 편차 강도로 투명도 조절
    const dev  = Math.abs(r.netSkew - avgNetSkew) / (maxDev || 1);
    const opacity = 0.5 + dev * 0.4;
    return `
      <rect x="${(x - barW/2).toFixed(1)}" y="${bY.toFixed(1)}"
        width="${barW.toFixed(1)}" height="${bH.toFixed(1)}"
        fill="${col}" opacity="${opacity.toFixed(2)}" rx="1">
        <title>${r.expiry_date} netSkew: ${(r.netSkew*100).toFixed(2)}%
Put IV: ${(r.put_iv*100).toFixed(1)}% / Call IV: ${(r.call_iv*100).toFixed(1)}%
편차: ${(deviations[enriched.indexOf(r)]*100).toFixed(2)}%</title>
      </rect>
      <text x="${x.toFixed(1)}" y="${H - 4}" text-anchor="middle" font-size="9" fill="var(--text3)">
        ${r.dte}d
      </text>
    `;
  }).join('');

  const avgColor = avgNetSkew > 0.03 ? '#ef4444' : avgNetSkew < -0.02 ? '#f97316' : '#22c55e';
  const maxSkewRow = enriched.reduce((m, r) => Math.abs(r.netSkew) > Math.abs(m.netSkew) ? r : m, enriched[0]);

  el.innerHTML = `
    <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <div style="background:${overallStatus.color}22;border:1px solid ${overallStatus.color}44;border-radius:8px;padding:10px 16px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">Skew 상태</div>
        <div style="font-size:15px;font-weight:800;color:${overallStatus.color}">${overallStatus.label}</div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">${overallStatus.desc}</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 16px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">평균 Net Skew (Put−Call)</div>
        <div style="font-size:15px;font-weight:700;color:${avgColor}">${avgNetSkew > 0 ? '+' : ''}${(avgNetSkew*100).toFixed(2)}%</div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">양수=Put편향 · 음수=Call편향</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 16px;flex:1">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">최대 편향 만기</div>
        <div style="font-size:14px;font-weight:700;color:${maxSkewRow.netSkew > 0 ? '#ef4444' : '#22c55e'}">${maxSkewRow.expiry_date}</div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">${(maxSkewRow.netSkew*100).toFixed(2)}% (D-${maxSkewRow.dte})</div>
      </div>
    </div>
    <div style="overflow-x:auto">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block">
        <line x1="${PL}" y1="${zeroY.toFixed(1)}" x2="${W-PR}" y2="${zeroY.toFixed(1)}"
          stroke="var(--text3)" stroke-width="0.8" stroke-dasharray="4,2"/>
        <text x="${PL-4}" y="${(zeroY+4).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text3)">0%</text>
        <line x1="${PL}" y1="${avgY.toFixed(1)}" x2="${W-PR}" y2="${avgY.toFixed(1)}"
          stroke="${avgColor}" stroke-width="1.2" stroke-dasharray="6,3" opacity="0.8"/>
        <text x="${W-PR}" y="${(avgY-3).toFixed(1)}" text-anchor="end" font-size="8" fill="${avgColor}">평균</text>
        ${bars}
        <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${PT+cH}" stroke="var(--border)" stroke-width="1"/>
        <text x="${PL-4}" y="${(PT+4).toFixed(1)}" text-anchor="end" font-size="9" fill="#ef4444">Put↑</text>
        <text x="${PL-4}" y="${(PT+cH+4).toFixed(1)}" text-anchor="end" font-size="9" fill="#22c55e">Call↑</text>
        <rect x="${W-PR-90}" y="${PT}" width="10" height="8" fill="#ef4444" opacity="0.7" rx="1"/>
        <text x="${W-PR-76}" y="${PT+8}" font-size="9" fill="var(--text3)">Put 편향</text>
        <rect x="${W-PR-30}" y="${PT}" width="10" height="8" fill="#22c55e" opacity="0.7" rx="1"/>
        <text x="${W-PR-16}" y="${PT+8}" font-size="9" fill="var(--text3)">Call</text>
      </svg>
    </div>
  `;
}


// ─────────────────────────────────────────────────────────────────────────────
// renderVannaDistChart
//
// 확률 분포 + Vanna Flip Zone + 비대칭 EM 차트
//
// @param {HTMLElement} el         — 렌더링할 컨테이너 엘리먼트
// @param {Array}       strikes    — 스트라이크 배열
//   각 항목: { strike, callOI, putOI, gex, vanna, avg_iv? }
// @param {number}      spot       — 현재 스팟 가격
// @param {object}      opts
//   opts.mode     'single' | 'combined'  (표시용, 기본 'single')
//   opts.vixDir   'up' | 'down' | 'neutral' (Vanna Flip 방향, 기본 'neutral')
//   opts.dte      기대움직임 계산용 DTE (기본 1)
//   opts.label    차트 상단 레이블 (기본 '확률 분포 · Vanna Flip')
// @returns {{ detach: Function }}  이벤트 해제 함수
// ─────────────────────────────────────────────────────────────────────────────
export function renderVannaDistChart(el, strikes, spot, opts = {}) {
  if (!el || !strikes?.length || !spot) return null;

  const {
    mode   = 'single',
    vixDir = 'neutral',
    dte    = 1,
    label  = '확률 분포 · Vanna Flip',
  } = opts;

  // ── 1. 데이터 정렬 ──────────────────────────────────────
  const sorted = [...strikes]
    .filter(s => s.strike != null)
    .sort((a, b) => a.strike - b.strike);

  if (!sorted.length) {
    el.innerHTML = '<div style="padding:12px;color:var(--text3);font-size:12px">데이터 없음</div>';
    return null;
  }

  const minS = sorted[0].strike;
  const maxS = sorted[sorted.length - 1].strike;

  // ── 2. Vanna EM 경계 계산 (기울기 소진점 방식) ──────────
  //
  // 원칙:
  //   VIX 하락 → 상방 EM: spot 위 양수 vanna 기울기가
  //              최대값의 SLOPE_THRESHOLD 이하로 떨어지는 지점
  //   VIX 상승 → 하방 EM: spot 아래 음수 vanna 기울기가
  //              최대값의 SLOPE_THRESHOLD 이하로 떨어지는 지점
  //   중립     → 양방향 모두 계산 → 비대칭 EM

  const SLOPE_THRESHOLD = 0.15; // 최대 기울기의 15% 이하 = 압력 소진

  const belowSpot = sorted.filter(s => s.strike < spot);
  const aboveSpot = sorted.filter(s => s.strike >= spot);

  function findSlopeExhaustPoint(strikes, vannaSign) {
    // strikes: spot에서 가까운 것부터 먼 순서로 정렬된 배열
    // 각 스트라이크의 방향성 vanna 기여(기울기)를 계산하고
    // 최대 기울기 대비 SLOPE_THRESHOLD 이하로 떨어지는 첫 지점 반환
    const slopes = strikes.map(s => {
      const v = (s.vanna ?? 0) * vannaSign;
      return v > 0 ? v : 0; // 방향과 반대인 기여는 0으로
    });

    const maxSlope = Math.max(...slopes, 1e-10);
    const threshold = maxSlope * SLOPE_THRESHOLD;

    for (let i = 0; i < slopes.length; i++) {
      if (slopes[i] < threshold) return strikes[i].strike;
    }
    return null;
  }

  // VIX 하락 → 상방 EM (spot 위, 낮→높 순, 양수 vanna)
  const vannaFlipUp   = findSlopeExhaustPoint(aboveSpot, 1);

  // VIX 상승 → 하방 EM (spot 아래, spot에서 가까운 것부터, 음수 vanna)
  const downStrikes   = [...belowSpot].reverse();
  const vannaFlipDown = findSlopeExhaustPoint(downStrikes, -1);

  // ── 3. GEX Flip Zone (기존 누적합 방식) ─────────────────
  let cumGex = 0, gexFlip = null, prevGexSign = null;
  for (const s of sorted) {
    cumGex += s.gex ?? 0;
    const sign = cumGex >= 0 ? 1 : -1;
    if (prevGexSign !== null && sign !== prevGexSign) { gexFlip = s.strike; break; }
    prevGexSign = sign;
  }

  // ── 4. 비대칭 EM 계산 ───────────────────────────────────
  const atmStrike = sorted.reduce((best, s) =>
    Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best
  );
  const atmIV = atmStrike.avg_iv ?? 0.20;
  const symEM = spot * atmIV * Math.sqrt(dte / 365);

  // vixDir에 따라 의미 있는 경계만 사용
  // up:   하방 경계 = vannaFlipDown, 상방은 대칭 EM
  // down: 상방 경계 = vannaFlipUp,   하방은 대칭 EM
  // neutral: 대칭 EM
  const emUpper = (vixDir === 'down' ? vannaFlipUp   : null) ?? spot + symEM;
  const emLower = (vixDir === 'up'   ? vannaFlipDown : null) ?? spot - symEM;

  // ── 5. IV Smile 기반 확률 밀도 계산 ────────────────────
  const sigma = spot * atmIV * Math.sqrt(dte / 365) || 1;
  const probRaw = sorted.map(s => {
    const iv  = s.avg_iv ?? atmIV;
    const sig = spot * iv * Math.sqrt(dte / 365) || sigma;
    const d   = s.strike - spot;
    return Math.exp(-0.5 * (d / sig) ** 2) / (sig * Math.sqrt(2 * Math.PI));
  });
  const maxProb  = Math.max(...probRaw, 1e-10);
  const normProb = probRaw.map(p => p / maxProb);

  // ── 6. Vanna 누적 곡선 (vixDir 반영, spot 기준 방향성) ──
  // VIX 상승: spot 아래 방향으로 음수 vanna 압력 시각화
  // VIX 하락: spot 위 방향으로 양수 vanna 압력 시각화
  // 중립: raw vanna 단순 누적
  const vannaCum = (() => {
    if (vixDir === 'up') {
      // spot 아래: spot에서 멀어질수록 누적, spot 위는 0
      let cum = 0;
      const result = new Array(sorted.length).fill(0);
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i].strike >= spot) { result[i] = 0; continue; }
        const contribution = -(sorted[i].vanna ?? 0); // 음수 vanna = 매도 압력
        if (contribution > 0) cum += contribution;
        result[i] = -cum; // 하방 압력이므로 음수로 표시
      }
      return result;
    } else if (vixDir === 'down') {
      // spot 위: spot에서 멀어질수록 누적, spot 아래는 0
      let cum = 0;
      const result = new Array(sorted.length).fill(0);
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].strike < spot) { result[i] = 0; continue; }
        const contribution = sorted[i].vanna ?? 0; // 양수 vanna = 매수 압력
        if (contribution > 0) cum += contribution;
        result[i] = cum;
      }
      return result;
    } else {
      // 중립: 전체 raw 누적
      let cum = 0;
      return sorted.map(s => { cum += s.vanna ?? 0; return cum; });
    }
  })();
  const maxAbsV   = Math.max(...vannaCum.map(Math.abs), 1e-10);
  const normVanna = vannaCum.map(v => v / maxAbsV);

  // ── 7. Canvas 생성 ──────────────────────────────────────
  el.innerHTML = '';

  // 상단 정보 바
  const infoBar = document.createElement('div');
  infoBar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 8px;font-size:11px;color:var(--text3);flex-wrap:wrap;gap:4px';
  const modeLabel = mode === 'combined' ? '합산 만기' : '0DTE';
  const vixLabel  = vixDir === 'up' ? '🔴 VIX↑' : vixDir === 'down' ? '🟢 VIX↓' : '⚪ VIX중립';
  infoBar.innerHTML = `
    <span style="color:var(--text);font-weight:600">${label}</span>
    <span style="display:flex;gap:12px;align-items:center">
      <span>${modeLabel}</span>
      <span>${vixLabel}</span>
      <span style="color:#a78bfa">▲Vanna Flip Up: ${vannaFlipUp != null ? '$' + vannaFlipUp : '--'}</span>
      <span style="color:#f472b6">▼Vanna Flip Dn: ${vannaFlipDown != null ? '$' + vannaFlipDown : '--'}</span>
      <span style="color:#fbbf24">GEX Flip: ${gexFlip != null ? '$' + gexFlip : '--'}</span>
      <span style="color:var(--text3);font-size:10px">더블클릭: 리셋 | 휠: 줌 | 드래그: 팬</span>
    </span>
  `;
  el.appendChild(infoBar);

  // Canvas
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:280px;';
  el.appendChild(canvas);

  // ── 8. 줌 상태 초기화 ───────────────────────────────────
  const zoom = createZoomState({ minX: minS, maxX: maxS });

  // ── 9. 그리기 함수 ──────────────────────────────────────
  const PL = 52, PR = 16, PT = 24, PB = 32;

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const W   = canvas.clientWidth  || 800;
    const H   = canvas.clientHeight || 280;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const cW = W - PL - PR;
    const cH = H - PT - PB;

    // 배경
    ctx.clearRect(0, 0, W, H);

    // 현재 뷰 범위 안의 스트라이크만 필터
    const visible = sorted.filter(s => s.strike >= zoom.viewMin && s.strike <= zoom.viewMax);
    if (!visible.length) return;

    const xOf = s => zoom.toPixelX(s, W, PL, PR);

    // ── 그리드 ────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth   = 1;
    for (let i = 0; i <= 4; i++) {
      const y = PT + (cH / 4) * i;
      ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(W - PR, y); ctx.stroke();
    }

    // ── EM 범위 배경 ──────────────────────────────────────
    const emLX = xOf(Math.max(emLower, zoom.viewMin));
    const emUX = xOf(Math.min(emUpper, zoom.viewMax));
    if (emUX > emLX) {
      ctx.fillStyle = 'rgba(251,191,36,0.06)';
      ctx.fillRect(emLX, PT, emUX - emLX, cH);
    }

    // ── Vanna 누적합 곡선 (배경 레이어) ───────────────────
    const vannaVis = sorted
      .map((s, i) => ({ strike: s.strike, nv: normVanna[i] }))
      .filter(d => d.strike >= zoom.viewMin && d.strike <= zoom.viewMax);

    if (vannaVis.length > 1) {
      const midY = PT + cH / 2;
      ctx.beginPath();
      vannaVis.forEach((d, i) => {
        const x = xOf(d.strike);
        const y = midY - d.nv * (cH / 2) * 0.7;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = 'rgba(167,139,250,0.35)';
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      // 0선
      ctx.beginPath();
      ctx.moveTo(PL, midY); ctx.lineTo(W - PR, midY);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth   = 1;
      ctx.stroke();
    }

    // ── 확률 밀도 곡선 (채우기) ───────────────────────────
    const probVis = sorted
      .map((s, i) => ({ strike: s.strike, p: normProb[i] }))
      .filter(d => d.strike >= zoom.viewMin && d.strike <= zoom.viewMax);

    if (probVis.length > 1) {
      const baseY = PT + cH;
      ctx.beginPath();
      probVis.forEach((d, i) => {
        const x = xOf(d.strike);
        const y = baseY - d.p * cH * 0.85;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth   = 2;
      ctx.stroke();

      // 채우기
      ctx.lineTo(xOf(probVis[probVis.length - 1].strike), baseY);
      ctx.lineTo(xOf(probVis[0].strike), baseY);
      ctx.closePath();
      ctx.fillStyle = 'rgba(59,130,246,0.12)';
      ctx.fill();
    }

    // ── 수직선 그리기 헬퍼 ───────────────────────────────
    function vline(x, color, dash, label, labelY) {
      if (x < PL || x > W - PR) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(x, PT); ctx.lineTo(x, PT + cH); ctx.stroke();
      ctx.setLineDash([]);
      if (label) {
        ctx.fillStyle = color;
        ctx.font      = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(label, x, labelY ?? PT + 12);
      }
      ctx.restore();
    }

    // Spot
    if (spot >= zoom.viewMin && spot <= zoom.viewMax)
      vline(xOf(spot), '#ffffff', [], `$${spot}`, PT + 14);

    // Vanna Flip Up
    if (vannaFlipUp != null && vannaFlipUp >= zoom.viewMin && vannaFlipUp <= zoom.viewMax)
      vline(xOf(vannaFlipUp), '#a78bfa', [4, 3], `VF↑$${vannaFlipUp}`, PT + 14);

    // Vanna Flip Down
    if (vannaFlipDown != null && vannaFlipDown >= zoom.viewMin && vannaFlipDown <= zoom.viewMax)
      vline(xOf(vannaFlipDown), '#f472b6', [4, 3], `VF↓$${vannaFlipDown}`, PT + 26);

    // GEX Flip (비교용)
    if (gexFlip != null && gexFlip >= zoom.viewMin && gexFlip <= zoom.viewMax)
      vline(xOf(gexFlip), '#fbbf24', [2, 4], `GF$${gexFlip}`, PT + 38);

    // EM 경계
    if (emLower >= zoom.viewMin && emLower <= zoom.viewMax)
      vline(xOf(emLower), 'rgba(251,191,36,0.6)', [6, 3]);
    if (emUpper >= zoom.viewMin && emUpper <= zoom.viewMax)
      vline(xOf(emUpper), 'rgba(251,191,36,0.6)', [6, 3]);

    // ── X축 눈금 ──────────────────────────────────────────
    const step = _niceStep(zoom.viewMax - zoom.viewMin, 8);
    const firstTick = Math.ceil(zoom.viewMin / step) * step;
    ctx.fillStyle   = 'rgba(156,163,175,0.8)';
    ctx.font        = '10px sans-serif';
    ctx.textAlign   = 'center';
    for (let v = firstTick; v <= zoom.viewMax; v += step) {
      const x = xOf(v);
      if (x < PL || x > W - PR) continue;
      ctx.fillText(`$${v}`, x, PT + cH + 16);
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 1;
      ctx.moveTo(x, PT + cH); ctx.lineTo(x, PT + cH + 4); ctx.stroke();
    }

    // ── 축 라인 ───────────────────────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(PL, PT); ctx.lineTo(PL, PT + cH + 4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PL, PT + cH); ctx.lineTo(W - PR, PT + cH); ctx.stroke();

    // ── 범례 ──────────────────────────────────────────────
    const legends = [
      { color: '#3b82f6', label: 'IV 확률 분포' },
      { color: '#a78bfa', label: 'Vanna 누적' },
      { color: '#fbbf24', label: 'EM 범위' },
    ];
    let lx = PL;
    ctx.font = '10px sans-serif';
    legends.forEach(lg => {
      ctx.fillStyle = lg.color;
      ctx.fillRect(lx, PT - 16, 10, 8);
      ctx.fillStyle = 'rgba(156,163,175,0.9)';
      ctx.textAlign = 'left';
      ctx.fillText(lg.label, lx + 13, PT - 8);
      lx += ctx.measureText(lg.label).width + 30;
    });
  }

  // 초기 그리기
  requestAnimationFrame(draw);
  const ro = new ResizeObserver(() => requestAnimationFrame(draw));
  ro.observe(el);

  // ── 10. 줌/스크롤 이벤트 연결 ──────────────────────────
  const detachZoom = attachZoomScroll(canvas, zoom, draw, { padL: PL, padR: PR });

  return {
    detach() {
      detachZoom();
      ro.disconnect();
    },
    update(newStrikes, newSpot, newOpts = {}) {
      renderVannaDistChart(el, newStrikes, newSpot, { ...opts, ...newOpts });
    },
  };
}

// X축 눈금 간격 계산 헬퍼
function _niceStep(range, targetCount) {
  const rough = range / targetCount;
  const mag   = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm  = rough / mag;
  const nice  = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return nice * mag;
}
