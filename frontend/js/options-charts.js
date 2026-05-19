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

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// classifyExpiry: 만기 타입 분류
// 백엔드에서 저장한 expiry_type 필드를 우선 사용
// 없으면 폴백으로 날짜 기반 추정
// ─────────────────────────────────────────────────────────────────────────────
function _getThirdFriday(year, month) {
  let count = 0;
  for (let d = 1; d <= 31; d++) {
    const date = new Date(year, month, d);
    if (date.getMonth() !== month) break;
    if (date.getDay() === 5) {
      count++;
      if (count === 3) {
        const m  = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        return `${date.getFullYear()}-${m}-${dd}`;
      }
    }
  }
  return null;
}

export function classifyExpiry(expiry_date, allExpiries = []) {
  const d   = new Date(expiry_date);
  const day = d.getDay();

  // 월/화/수 → 0DTE
  if (day <= 3) return '0dte';

  // 목요일 → 다음날 금요일이 데이터에 있으면 0DTE
  if (day === 4) {
    const friday = new Date(d);
    friday.setDate(d.getDate() + 1);
    const m  = String(friday.getMonth() + 1).padStart(2, '0');
    const dd = String(friday.getDate()).padStart(2, '0');
    const fridayStr = `${friday.getFullYear()}-${m}-${dd}`;
    if (allExpiries.includes(fridayStr)) return '0dte';
  }

  // 금요일 or 당겨진 목요일 → 3째주 금요일과 비교
  const thirdFriday = _getThirdFriday(d.getFullYear(), d.getMonth());
  if (expiry_date === thirdFriday) return 'monthly';

  // 3째주 금요일이 휴장 → 목요일로 당겨진 경우
  if (thirdFriday) {
    const tf = new Date(thirdFriday);
    tf.setDate(tf.getDate() - 1);
    const m  = String(tf.getMonth() + 1).padStart(2, '0');
    const dd = String(tf.getDate()).padStart(2, '0');
    const thirdThursdayStr = `${tf.getFullYear()}-${m}-${dd}`;
    if (expiry_date === thirdThursdayStr && !allExpiries.includes(thirdFriday)) {
      return 'monthly';
    }
  }

  return 'weekly';
}

// ─────────────────────────────────────────────────────────────────────────────
// renderDexTermStructure — DEX 버블 차트 (지수/개별종목 공용)
//
// expiryRows: [{
//   expiry_date, dte, dex,          ← 필수
//   atm_iv, call_oi, put_oi,        ← 옵션 (있으면 하단 카드에 표시)
//   type: '0dte'|'weekly'|'monthly' ← 없으면 자동 분류
// }]
//
// options: {
//   mode:   'index' | 'stock',      ← 지수: 0dte 포함 / 개별종목: 없음
//   maxDTE: 90,                     ← 표시 한계 (기본 90)
//   el:     HTMLElement,            ← 렌더링 대상
//   onFilterChange: (selectedDates) => void  ← 만기 선택 변경 콜백
// }
// ─────────────────────────────────────────────────────────────────────────────
export function renderDexTermStructure(expiryRows, options = {}) {
  const {
    mode           = 'stock',
    maxDTE         = 90,
    el,
    onFilterChange = null,
  } = options;

  if (!el) return;

  // 1. 정규화 + 타입 분류 + DTE 필터
  const allExpiries = expiryRows.map(r => r.expiry_date);
  const rows = expiryRows
    .filter(r => r.dex != null && r.dte != null && r.dte <= maxDTE)
    .map(r => ({
      ...r,
      type: r.expiry_type ?? r.type ?? classifyExpiry(r.expiry_date, allExpiries),
    }))
    .sort((a, b) => a.dte - b.dte);

  if (!rows.length) {
    el.innerHTML = '<div style="padding:16px;color:var(--text3);font-size:12px">데이터 없음</div>';
    return;
  }

  // 2. 만기 선택 상태 (기본: 전체 선택)
  const selectionState = {};
  rows.forEach(r => { selectionState[r.expiry_date] = true; });

  // 3. 통계 계산
  function calcStats(selectedRows) {
    const monthly = selectedRows.filter(r => r.type === 'monthly');
    const weekly  = selectedRows.filter(r => r.type === 'weekly');

    const dexCenter = selectedRows.length
      ? selectedRows.reduce((s, r) => s + Math.abs(r.dex) * r.dte, 0)
        / selectedRows.reduce((s, r) => s + Math.abs(r.dex), 0)
      : null;

    const mSlope = monthly.length >= 2
      ? monthly[monthly.length - 1].dex - monthly[0].dex : null;
    const wSlope = weekly.length >= 2
      ? weekly[weekly.length - 1].dex - weekly[0].dex : null;

    const maxRow = [...selectedRows].sort((a, b) => Math.abs(b.dex) - Math.abs(a.dex))[0];

    return { dexCenter, mSlope, wSlope, maxRow, monthly, weekly };
  }

  // 4. Chart.js 버블 차트 데이터 생성
  function buildChartData(selectedRows) {
    const maxAbsDex = Math.max(...selectedRows.map(r => Math.abs(r.dex)), 0.001);
    function bR(dex) { return Math.max(7, Math.sqrt(Math.abs(dex) / maxAbsDex) * 34); }

    const CALL_FILL    = 'rgba(34,197,94,0.55)';   // 녹색계열 (콜우세)
    const CALL_STROKE  = '#22c55e';
    const PUT_FILL     = 'rgba(239,68,68,0.55)';   // 붉은색계열 (풋우세)
    const PUT_STROKE   = '#ef4444';
    const ZERO_BORDER  = 'rgba(255,255,255,0.8)';  // 0DTE 테두리: 흰색
    const WEEK_BORDER  = '#eab308';                 // 위클리 테두리: 노란색
    const MONTH_BORDER = '#a855f7';                 // 먼슬리 테두리: 보라색

    const byType = { '0dte': [], weekly: [], monthly: [] };
    selectedRows.forEach(r => { (byType[r.type] ?? byType.weekly).push(r); });

    const datasets = [];

    // 연결선 (위클리)
    if (byType.weekly.length >= 2) {
      datasets.push({
        label: '_wline',
        data: byType.weekly.map(r => ({ x: r.dte, y: r.dex })),
        type: 'line',
        borderColor: 'rgba(55,138,221,0.22)',
        borderWidth: 1,
        borderDash: [4, 4],
        pointRadius: 0,
        fill: false,
        tension: 0.3,
        order: 10,
      });
    }

    // 연결선 (먼슬리)
    if (byType.monthly.length >= 2) {
      datasets.push({
        label: '_mline',
        data: byType.monthly.map(r => ({ x: r.dte, y: r.dex })),
        type: 'line',
        borderColor: 'rgba(212,83,126,0.28)',
        borderWidth: 1.5,
        borderDash: [5, 3],
        pointRadius: 0,
        fill: false,
        tension: 0.3,
        order: 10,
      });
    }

    // 0DTE 버블
    if (byType['0dte'].length) {
      datasets.push({
        label: '0DTE',
        data: byType['0dte'].map(r => ({
          x: r.dte, y: r.dex, r: bR(r.dex), label: r.expiry_date,
        })),
        backgroundColor: byType['0dte'].map(r => r.dex >= 0 ? CALL_FILL : PUT_FILL),
        borderColor:     ZERO_BORDER,
        borderWidth: 2,
        pointStyle: 'triangle',
        order: 3,
      });
    }

    // 위클리 버블
    if (byType.weekly.length) {
      datasets.push({
        label: '위클리',
        data: byType.weekly.map(r => ({
          x: r.dte, y: r.dex, r: bR(r.dex), label: r.expiry_date,
        })),
        backgroundColor: byType.weekly.map(r => r.dex >= 0 ? CALL_FILL : PUT_FILL),
        borderColor:     WEEK_BORDER,
        borderWidth: 2,
        pointStyle: 'circle',
        order: 2,
      });
    }

    // 먼슬리 버블
    if (byType.monthly.length) {
      datasets.push({
        label: '먼슬리',
        data: byType.monthly.map(r => ({
          x: r.dte, y: r.dex, r: bR(r.dex), label: r.expiry_date,
        })),
        backgroundColor: byType.monthly.map(r => r.dex >= 0 ? CALL_FILL : PUT_FILL),
        borderColor:     MONTH_BORDER,
        borderWidth: 2,
        pointStyle: 'rect',
        order: 1,
      });
    }

    return datasets;
  }

  // 5. 카드 HTML
  function renderCards(stats) {
    const { dexCenter, mSlope, wSlope, maxRow, monthly, weekly } = stats;

    const centerLabel = dexCenter == null ? '—'
      : dexCenter < 21  ? `D-${dexCenter.toFixed(0)} · 단기집중`
      : dexCenter < 45  ? `D-${dexCenter.toFixed(0)} · 중기베팅`
      :                   `D-${dexCenter.toFixed(0)} · 장기베팅`;

    const mLastDex = monthly.length ? monthly[monthly.length - 1].dex : null;
    const wLastDex = weekly.length  ? weekly[weekly.length - 1].dex   : null;

    function slopeLabel(slope, lastDex) {
      if (slope == null) return ['데이터 부족', 'var(--text3)'];
      if (slope === 0)   return ['중립 →', 'var(--text3)'];
      const isPositiveDex = lastDex >= 0;
      if (isPositiveDex && slope > 0)  return ['콜 확대 ↑', '#22c55e'];
      if (isPositiveDex && slope < 0)  return ['콜 축소 ↓', '#ef4444'];
      if (!isPositiveDex && slope < 0) return ['풋 확대 ↓', '#ef4444'];
      if (!isPositiveDex && slope > 0) return ['풋 축소 ↑', '#22c55e'];
      return ['중립 →', 'var(--text3)'];
    }

    const [mSlopeLabel, mSlopeColor] = slopeLabel(mSlope, mLastDex);
    const [wSlopeLabel, wSlopeColor] = slopeLabel(wSlope, wLastDex);

    return `
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <div style="flex:1;min-width:100px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px 12px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:2px">DEX 무게중심</div>
          <div style="font-size:15px;font-weight:700;color:var(--text)">${centerLabel}</div>
        </div>
        <div style="flex:1;min-width:100px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px 12px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:2px">먼슬리 방향</div>
          <div style="font-size:15px;font-weight:700;color:${mSlopeColor}">${mSlopeLabel}</div>
        </div>
        <div style="flex:1;min-width:100px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px 12px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:2px">위클리 방향</div>
          <div style="font-size:15px;font-weight:700;color:${wSlopeColor}">${wSlopeLabel}</div>
        </div>
        <div style="flex:1;min-width:100px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px 12px">
          <div style="font-size:10px;color:var(--text3);margin-bottom:2px">최대 DEX 만기</div>
          <div style="font-size:15px;font-weight:700;color:var(--text)">${maxRow ? maxRow.expiry_date.slice(5) : '—'}</div>
          <div style="font-size:10px;color:var(--text3)">${maxRow ? (maxRow.type === 'monthly' ? '먼슬리' : maxRow.type === 'weekly' ? '위클리' : '0DTE') : ''}</div>
        </div>
      </div>
    `;
  }

  // 6. 만기 선택 컨트롤 HTML
  function renderControls() {
    const typeOrder = mode === 'index'
      ? ['0dte', 'weekly', 'monthly']
      : ['weekly', 'monthly'];

    const typeLabel = { '0dte': '0DTE', weekly: '위클리', monthly: '먼슬리' };
    const typeColor = { '0dte': 'rgba(255,255,255,0.8)', weekly: '#eab308', monthly: '#a855f7' };

    const grouped = {};
    typeOrder.forEach(t => { grouped[t] = []; });
    rows.forEach(r => {
      const t = r.type;
      if (grouped[t]) grouped[t].push(r);
      else if (grouped.weekly) grouped.weekly.push(r);
    });

    const sections = typeOrder.map(type => {
      const items = grouped[type] ?? [];
      if (!items.length) return '';
      return `
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-bottom:4px">
          <span style="font-size:10px;color:${typeColor[type]};font-weight:700;width:44px">${typeLabel[type]}</span>
          ${items.map(r => `
            <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;
              background:${selectionState[r.expiry_date] ? typeColor[type] + '22' : 'var(--bg3)'};
              border:1px solid ${selectionState[r.expiry_date] ? typeColor[type] + '66' : 'var(--border)'};
              border-radius:4px;padding:2px 6px;font-size:10px;color:var(--text);
              transition:background 0.15s">
              <input type="checkbox" data-expiry="${r.expiry_date}"
                ${selectionState[r.expiry_date] ? 'checked' : ''}
                style="width:10px;height:10px;cursor:pointer;accent-color:${typeColor[type]}">
              ${r.expiry_date.slice(5)}
              <span style="color:var(--text3);font-size:9px">&nbsp;D-${r.dte}</span>
            </label>
          `).join('')}
        </div>
      `;
    }).join('');

    return `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span style="font-size:11px;color:var(--text3)">만기 선택</span>
          <div style="display:flex;gap:6px">
            <button id="dts-all" style="font-size:10px;padding:2px 8px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text);cursor:pointer">전체선택</button>
            <button id="dts-none" style="font-size:10px;padding:2px 8px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text);cursor:pointer">전체해제</button>
            <button id="dts-monthly" style="font-size:10px;padding:2px 8px;background:#a855f722;border:1px solid #a855f744;border-radius:4px;color:#a855f7;cursor:pointer">먼슬리만</button>
          </div>
        </div>
        ${sections}
      </div>
    `;
  }

  // 7. 전체 HTML 렌더링
  const canvasId = 'dex-term-canvas-' + Math.random().toString(36).slice(2, 7);
  const statsId  = 'dex-term-stats-' + Math.random().toString(36).slice(2, 7);

  el.innerHTML = `
    <div style="font-size:11px;color:var(--text3);margin-bottom:6px;display:flex;gap:14px;flex-wrap:wrap;align-items:center">
      <span style="display:inline-flex;align-items:center;gap:4px">
        <svg width="14" height="12"><polygon points="7,1 13,11 1,11" fill="rgba(255,255,255,0.15)" stroke="rgba(255,255,255,0.8)" stroke-width="1.5"/></svg>0DTE
      </span>
      <span style="display:inline-flex;align-items:center;gap:4px">
        <svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="rgba(255,255,255,0.1)" stroke="#eab308" stroke-width="1.5"/></svg>위클리
      </span>
      <span style="display:inline-flex;align-items:center;gap:4px">
        <svg width="12" height="12"><rect x="1" y="1" width="10" height="10" fill="rgba(255,255,255,0.1)" stroke="#a855f7" stroke-width="1.5"/></svg>먼슬리
      </span>
      <span style="display:inline-flex;align-items:center;gap:4px;margin-left:8px">
        <svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="rgba(34,197,94,0.6)"/></svg>콜우세
      </span>
      <span style="display:inline-flex;align-items:center;gap:4px">
        <svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="rgba(239,68,68,0.6)"/></svg>풋우세
      </span>
      <span style="margin-left:auto;color:var(--text3);font-size:10px">버블 크기 = DEX 절대값</span>
    </div>

    ${renderControls()}

    <div style="position:relative;width:100%;height:300px">
      <canvas id="${canvasId}" role="img" aria-label="만기별 DEX 버블 차트"></canvas>
    </div>

    <div id="${statsId}">${renderCards(calcStats(rows))}</div>
  `;

  // 8. Chart.js 렌더링
  const isDark    = matchMedia('(prefers-color-scheme: dark)').matches;
  const gridColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
  const zeroColor = isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)';
  const textColor = isDark ? '#9ca3af' : '#6b7280';

  let chartInst = null;
  let isFirstDraw = true;

  function getSelectedRows() {
    return rows.filter(r => selectionState[r.expiry_date]);
  }

  function drawChart(selectedRows) {
    const canvas = el.querySelector(`#${canvasId}`);
    if (!canvas) return;

    const dexVals   = selectedRows.map(r => r.dex);
    const maxAbsDex = Math.max(...dexVals.map(Math.abs), 0.001);
    const yPad      = maxAbsDex * 0.18;
    const yMin      = Math.min(...dexVals) - yPad;
    const yMax      = Math.max(...dexVals) + yPad;
    const xMax      = Math.max(...selectedRows.map(r => r.dte), 10) + 5;
    const animDuration = isFirstDraw ? 600 : 0;
    isFirstDraw = false;

    if (chartInst) chartInst.destroy();

    chartInst = new Chart(canvas, {
      type: 'bubble',
      data: { datasets: buildChartData(selectedRows) },
      options: {
        animation: { duration: animDuration },
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 12, right: 20, bottom: 4, left: 4 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label(ctx) {
                const d = ctx.raw;
                if (!d?.label) return '';
                const dir = d.y >= 0 ? '콜우세' : '풋우세';
                return `${d.label}  DEX: ${d.y >= 0 ? '+' : ''}${d.y.toFixed(2)}B  ${dir}  (D-${d.x})`;
              },
            },
            filter(item) { return !!item.raw?.label; },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: -3,
            max: xMax,
            title: { display: true, text: 'DTE', color: textColor, font: { size: 11 } },
            ticks: { color: textColor, font: { size: 10 }, callback: v => `D-${v}`, stepSize: 7 },
            grid: { color: gridColor },
          },
          y: {
            min: yMin,
            max: yMax,
            title: { display: true, text: 'DEX  ↑콜우세 / ↓풋우세', color: textColor, font: { size: 11 } },
            ticks: {
              color: textColor,
              font: { size: 10 },
              callback: v => (v > 0 ? '+' : '') + v.toFixed(1) + 'B',
            },
            grid: {
              color: ctx => ctx.tick.value === 0 ? zeroColor : gridColor,
              lineWidth: ctx => ctx.tick.value === 0 ? 1.5 : 1,
            },
          },
        },
      },
    });
  }

  // 9. 컨트롤 이벤트 바인딩
  function updateAll() {
    const sel = getSelectedRows();
    drawChart(sel);
    const statsEl = el.querySelector(`#${statsId}`);
    if (statsEl) statsEl.innerHTML = renderCards(calcStats(sel));
    if (onFilterChange) onFilterChange(sel.map(r => r.expiry_date));

    // 체크박스 라벨 스타일 갱신
    el.querySelectorAll('input[data-expiry]').forEach(chk => {
      const expiry    = chk.dataset.expiry;
      const row       = rows.find(r => r.expiry_date === expiry);
      const typeColor = row?.type === 'monthly' ? '#a855f7'
                      : row?.type === '0dte'    ? 'rgba(255,255,255,0.8)'
                      :                           '#eab308';
      const label = chk.closest('label');
      if (!label) return;
      const on = selectionState[expiry];
      label.style.background = on ? typeColor + '22' : 'var(--bg3)';
      label.style.borderColor = on ? typeColor + '66' : 'var(--border)';
    });
  }

  el.querySelectorAll('input[data-expiry]').forEach(chk => {
    chk.addEventListener('change', e => {
      selectionState[e.target.dataset.expiry] = e.target.checked;
      updateAll();
    });
  });

  el.querySelector('#dts-all')?.addEventListener('click', () => {
    rows.forEach(r => { selectionState[r.expiry_date] = true; });
    el.querySelectorAll('input[data-expiry]').forEach(c => { c.checked = true; });
    updateAll();
  });

  el.querySelector('#dts-none')?.addEventListener('click', () => {
    rows.forEach(r => { selectionState[r.expiry_date] = false; });
    el.querySelectorAll('input[data-expiry]').forEach(c => { c.checked = false; });
    updateAll();
  });

  el.querySelector('#dts-monthly')?.addEventListener('click', () => {
    rows.forEach(r => { selectionState[r.expiry_date] = r.type === 'monthly'; });
    el.querySelectorAll('input[data-expiry]').forEach(c => {
      const row = rows.find(r => r.expiry_date === c.dataset.expiry);
      c.checked = row?.type === 'monthly';
    });
    updateAll();
  });

  // 10. 초기 렌더링 (Chart.js 로드 확인)
  function tryDraw() {
    if (typeof Chart !== 'undefined') {
      drawChart(getSelectedRows());
    } else {
      setTimeout(tryDraw, 100);
    }
  }
  tryDraw();
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
    mode      = 'single',
    vixDir    = 'neutral',
    dte       = 1,
    label     = '확률 분포 · Vanna Flip',
    markers   = [],   // [{ price, type: 'flip'|'inflection'|'ceiling'|'floor', label }]
    zoomState = null, // 외부에서 zoom 상태 주입 (업데이트 시 유지용)
  } = opts;

  // ── 1. 데이터 정렬 ──────────────────────────────────────
  const sorted = [...strikes]
    .filter(s => s.strike != null)
    .sort((a, b) => a.strike - b.strike);

  if (!sorted.length) {
    el.innerHTML = '<div style="padding:12px;color:var(--text3);font-size:12px">데이터 없음</div>';
    return null;
  }

  // Vanna 합산값이 유효한지 확인
  const totalVanna = sorted.reduce((s, r) => s + Math.abs(r.vanna ?? 0), 0);
  if (totalVanna < 1e-6) {
    el.innerHTML = '<div style="padding:12px;color:var(--text3);font-size:12px">Vanna 데이터 없음 (차트 생략)</div>';
    return null;
  }

  const minS = sorted[0].strike;
  const maxS = sorted[sorted.length - 1].strike;

  // ── 2. vixDir에 따른 vanna 기여값 결정 ─────────────────
  //
  // VIX 합성: 상단=VIX↓ 기반, 하단=VIX↑ 기반
  // 하나의 차트에 상하 방향 모두 표시

  function vannaContribDown(v) { return v < 0 ? Math.abs(v) : 0; }  // VIX↑ → 하락 압력
  function vannaContribUp(v)   { return v > 0 ? v : 0; }             // VIX↓ → 상승 압력
  function vannaContribAll(v)  { return Math.abs(v); }               // 중립

  // ── 3. Vanna 누적 곡선 (합성: 상단/하단 각각) ──────────
  // 하단 EM (VIX↑ 시나리오)
  const vannaValsDown = sorted.map(s => vannaContribDown(s.vanna ?? 0));
  let _cumD = 0;
  const vannaCumDown = vannaValsDown.map(v => { _cumD += v; return _cumD; });

  // 상단 EM (VIX↓ 시나리오)
  const vannaValsUp = sorted.map(s => vannaContribUp(s.vanna ?? 0));
  let _cumU = 0;
  const vannaCumUp = vannaValsUp.map(v => { _cumU += v; return _cumU; });

  // 표시용 Vanna 누적 (vixDir에 따라 or 합성)
  const vannaValsDisp = sorted.map(s => vannaContribAll(s.vanna ?? 0));
  let _cumA = 0;
  const vannaCumDisp = vannaValsDisp.map(v => { _cumA += v; return _cumA; });
  const maxAbsV   = Math.max(...vannaCumDisp, 1e-10);
  const normVanna = vannaCumDisp.map(v => v / maxAbsV);

  // ── 4. EM 경계: 합성 상단(VIX↓)/하단(VIX↑) ─────────────
  const SLOPE_THRESHOLD = 0.15;

  // 하방 EM (VIX↑): 왼쪽 끝부터 안쪽으로
  const maxSlopeDown = Math.max(...vannaValsDown, 1e-10);
  const threshDown   = maxSlopeDown * SLOPE_THRESHOLD;
  let vannaFlipDown = sorted[0].strike;
  for (let i = 0; i < sorted.length; i++) {
    if (vannaValsDown[i] >= threshDown) { vannaFlipDown = sorted[i].strike; break; }
  }

  // 상방 EM (VIX↓): 오른쪽 끝부터 안쪽으로
  const maxSlopeUp = Math.max(...vannaValsUp, 1e-10);
  const threshUp   = maxSlopeUp * SLOPE_THRESHOLD;
  let vannaFlipUp = sorted[sorted.length - 1].strike;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (vannaValsUp[i] >= threshUp) { vannaFlipUp = sorted[i].strike; break; }
  }

  // ── 5. GEX Flip Zone ────────────────────────────────────
  let cumGex = 0, gexFlip = null, prevGexSign = null;
  for (const s of sorted) {
    cumGex += s.gex ?? 0;
    const sign = cumGex >= 0 ? 1 : -1;
    if (prevGexSign !== null && sign !== prevGexSign) { gexFlip = s.strike; break; }
    prevGexSign = sign;
  }

  // ── 6. ATM IV 기반 EM (폴백용) ─────────────────────────
  const atmStrike = sorted.reduce((best, s) =>
    Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best
  );
  const atmIV = atmStrike.avg_iv ?? 0.20;
  const symEM = spot * atmIV * Math.sqrt(dte / 365);

  const emUpper = vannaFlipUp   ?? (spot + symEM);
  const emLower = vannaFlipDown ?? (spot - symEM);

  // ── 7. DEX 누적 + Vanna 누적 계산 ──────────────────────
  // DEX 누적 (부호 그대로)
  let _cumDexArr = 0;
  const cumDexArr = sorted.map(s => { _cumDexArr += (s.dex ?? 0); return _cumDexArr; });
  const maxAbsCumDex = Math.max(...cumDexArr.map(Math.abs), 1e-10);
  // -1 ~ +1 정규화 (부호 유지)
  const normCumDex = cumDexArr.map(v => v / maxAbsCumDex);

  // Vanna 누적 (왼→오른, S자)
  let _cumV = 0;
  const vannaCumArr = sorted.map(s => { _cumV += Math.abs(s.vanna ?? 0); return _cumV; });
  const maxCumV      = Math.max(...vannaCumArr, 1e-10);
  const normVannaCum = vannaCumArr.map(v => v / maxCumV);

  // ── 8. DEX Flip Zone (누적 DEX 부호 전환 지점) ──────────
  let cumDex = 0, dexFlip = null, prevDexSign = null;
  for (const s of sorted) {
    cumDex += s.dex ?? 0;
    const sign = cumDex >= 0 ? 1 : -1;
    if (prevDexSign !== null && sign !== prevDexSign) { dexFlip = s.strike; break; }
    prevDexSign = sign;
  }

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
      <span style="color:#fbbf24">DEX Flip: ${dexFlip != null ? dexFlip : '--'}</span>
      <span style="color:var(--text3);font-size:10px">더블클릭: 리셋 | 휠: 줌 | 드래그: 팬</span>
    </span>
  `;
  el.appendChild(infoBar);

  // Canvas
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:280px;';
  el.appendChild(canvas);

  // ── 9. 줌 상태 초기화 ──────────────────────────────────
  const viewRange = (emUpper - emLower) * 3.2;
  const initMin   = spot - viewRange / 2;
  const initMax   = spot + viewRange / 2;
  const zoom = zoomState ?? createZoomState({
    minX: minS, maxX: maxS,
    initMin, initMax,
  });

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

    // ── 변곡 내부 계산 (vanna 절대값 기반, EM 경계 안) ───
    const strikeWithV = sorted.map(s => ({
      strike: s.strike,
      absV:   Math.abs(s.vanna ?? 0),
    }));

    // 하락: emLower ~ spot 구간, vanna 절대값 큰 순 최대 2개
    const downInfl = strikeWithV
      .filter(s => s.strike > emLower && s.strike < spot)
      .sort((a, b) => b.absV - a.absV)
      .slice(0, 2)
      .map(s => s.strike)
      .sort((a,b) => b-a);

    // 상승: spot ~ emUpper 구간, vanna 절대값 큰 순 최대 2개
    const upInfl = strikeWithV
      .filter(s => s.strike > spot && s.strike < emUpper)
      .sort((a, b) => b.absV - a.absV)
      .slice(0, 2)
      .map(s => s.strike)
      .sort((a,b) => a-b);

    // 기준점: 현재가
    const upperBase = spot;
    const lowerBase = spot;

    // ── 변곡 기반 음영 구간 ───────────────────────────────
    function fillZone(x1, x2, color) {
      const px1 = Math.max(xOf(Math.max(x1, zoom.viewMin)), PL);
      const px2 = Math.min(xOf(Math.min(x2, zoom.viewMax)), W - PR);
      if (px2 <= px1) return;
      ctx.save();
      ctx.fillStyle = color;
      ctx.fillRect(px1, PT, px2 - px1, cH);
      ctx.restore();
    }

    const downAlphas = [0.40, 0.25, 0.12];
    const upAlphas   = [0.40, 0.25, 0.12];

    // 하락 구간: spot → 변곡들 → emLower
    const downZones = [spot, ...downInfl, emLower]
      .filter((v,i,a) => a.indexOf(v) === i).sort((a,b) => b-a);
    for (let i = 0; i < downZones.length - 1; i++) {
      fillZone(downZones[i+1], downZones[i], `rgba(239,68,68,${downAlphas[Math.min(i, downAlphas.length-1)]})`);
    }

    // 상승 구간: spot → 변곡들 → emUpper
    const upZones = [spot, ...upInfl, emUpper]
      .filter((v,i,a) => a.indexOf(v) === i).sort((a,b) => a-b);
    for (let i = 0; i < upZones.length - 1; i++) {
      fillZone(upZones[i], upZones[i+1], `rgba(34,197,94,${upAlphas[Math.min(i, upAlphas.length-1)]})`);
    }

    // ── Vanna 누적합 곡선 ──────────────────────────────────
    // ── Zero line ─────────────────────────────────────────
    const zeroY = PT + cH * 0.5;
    ctx.beginPath();
    ctx.moveTo(PL, zeroY); ctx.lineTo(W - PR, zeroY);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([2, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Vanna 누적 곡선 (보라, S자) ───────────────────────
    const vannaVis = sorted
      .map((s, i) => ({ strike: s.strike, nv: normVannaCum[i] }))
      .filter(d => d.strike >= zoom.viewMin && d.strike <= zoom.viewMax);

    if (vannaVis.length > 1) {
      ctx.beginPath();
      vannaVis.forEach((d, i) => {
        const x = xOf(d.strike);
        const y = PT + cH - d.nv * cH * 0.85;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = 'rgba(167,139,250,0.7)';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }

    // ── DEX 누적 곡선 (노랑, 부호 그대로) ────────────────
    const cumDexVis = sorted
      .map((s, i) => ({ strike: s.strike, v: normCumDex[i] }))
      .filter(d => d.strike >= zoom.viewMin && d.strike <= zoom.viewMax);

    if (cumDexVis.length > 1) {
      ctx.beginPath();
      cumDexVis.forEach((d, i) => {
        const x = xOf(d.strike);
        // +1 → 위(PT), -1 → 아래(PT+cH), 0 → 중간(zeroY)
        const y = zeroY + d.v * (cH * 0.45);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = 'rgba(234,179,8,0.9)';
      ctx.lineWidth   = 2;
      ctx.stroke();
    }

    // ── 수직선 그리기 헬퍼 (레이블 선 옆 배치) ───────────
    function vline(x, color, dash, label, side = 'right') {
      if (x < PL || x > W - PR) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(x, PT); ctx.lineTo(x, PT + cH); ctx.stroke();
      ctx.setLineDash([]);
      if (label) {
        ctx.fillStyle = color;
        ctx.font      = 'bold 10px Arial, sans-serif';
        ctx.textAlign = side === 'right' ? 'left' : 'right';
        const lx = side === 'right' ? x + 3 : x - 3;
        ctx.fillText(label, lx, PT + 20);
      }
      ctx.restore();
    }

    // Spot
    if (spot >= zoom.viewMin && spot <= zoom.viewMax)
      vline(xOf(spot), '#ffffff', [], `${spot}`, 'right');

    // DEX Flip (현재가가 콜/풋 어느 영역인지 경계)
    if (dexFlip != null && dexFlip >= zoom.viewMin && dexFlip <= zoom.viewMax) {
      vline(xOf(dexFlip), '#fbbf24', [4, 3], `DEX Flip ${dexFlip}`, spot > dexFlip ? 'left' : 'right');
      const inCallZone = spot > dexFlip;
      ctx.save();
      ctx.fillStyle = inCallZone ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)';
      ctx.font = 'bold 10px Arial, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(inCallZone ? '콜영역' : '풋영역', W - PR - 4, PT + 14);
      ctx.restore();
    }

    // 변곡선 표시
    downInfl.forEach((p, i) => {
      if (p < zoom.viewMin || p > zoom.viewMax) return;
      const alpha = i === 0 ? 0.85 : 0.65;
      vline(xOf(p), `rgba(239,68,68,${alpha})`, [4,3], `${p}`, 'left');
    });
    upInfl.forEach((p, i) => {
      if (p < zoom.viewMin || p > zoom.viewMax) return;
      const alpha = i === 0 ? 0.85 : 0.65;
      vline(xOf(p), `rgba(34,197,94,${alpha})`, [4,3], `${p}`, 'right');
    });

    // EM 경계선
    if (emLower >= zoom.viewMin && emLower <= zoom.viewMax)
      vline(xOf(emLower), 'rgba(251,191,36,0.8)', [6, 3], `${emLower.toFixed(0)}`, 'right');
    if (emUpper >= zoom.viewMin && emUpper <= zoom.viewMax)
      vline(xOf(emUpper), 'rgba(251,191,36,0.8)', [6, 3], `${emUpper.toFixed(0)}`, 'left');

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
      { color: 'rgba(239,68,68,0.40)',   label: '하락' },
      { color: 'rgba(34,197,94,0.40)',   label: '상승' },
      { color: 'rgba(234,179,8,0.45)',   label: '중첩' },
      { color: 'rgba(167,139,250,0.7)',  label: 'Vanna 누적', line: true, lw: 1.5 },
      { color: 'rgba(234,179,8,0.9)',    label: 'DEX 누적',   line: true, lw: 2 },
    ];
    let lx = PL;
    ctx.font = '10px Arial, sans-serif';
    legends.forEach(lg => {
      if (lg.line) {
        ctx.save();
        ctx.strokeStyle = lg.color;
        ctx.lineWidth   = lg.lw;
        ctx.beginPath();
        ctx.moveTo(lx, PT - 12); ctx.lineTo(lx + 14, PT - 12);
        ctx.stroke();
        ctx.restore();
        lx += 18;
      } else {
        ctx.fillStyle = lg.color;
        ctx.fillRect(lx, PT - 18, 10, 8);
        lx += 14;
      }
      ctx.fillStyle = 'rgba(156,163,175,0.9)';
      ctx.textAlign = 'left';
      ctx.fillText(lg.label, lx, PT - 10);
      lx += ctx.measureText(lg.label).width + 16;
    });
  }

  // 초기 그리기
  requestAnimationFrame(draw);
  const ro = new ResizeObserver(() => requestAnimationFrame(draw));
  ro.observe(el);

  // ── 10. 줌/스크롤 이벤트 연결 ──────────────────────────
  const detachZoom = attachZoomScroll(canvas, zoom, draw, { padL: PL, padR: PR });

  return {
    _zoomRef: zoom,
    detach() {
      detachZoom();
      ro.disconnect();
    },
    update(newStrikes, newSpot, newOpts = {}) {
      renderVannaDistChart(el, newStrikes, newSpot, { ...opts, ...newOpts, zoomState: zoom });
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
