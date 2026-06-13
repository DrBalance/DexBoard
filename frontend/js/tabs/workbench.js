// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// workbench.js — Workbench 탭
// spy_daily_close D1 테이블 데이터 로드 및 렌더링
// 가설: max pain vs 종가 괴리 → ES 야간 방향 일치 검증
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { CF_API } from '../config.js';

const $ = id => document.getElementById(id);

function setEl(id, text, color) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  if (color) el.style.color = color;
}

const COLOR = {
  green: 'var(--green)',
  red:   'var(--red)',
  amber: 'var(--amber)',
  muted: 'var(--text-muted)',
};

let _wbChart = null;
let _loaded  = false;

// ── 데이터 로드 ───────────────────────────────────────────
async function loadWorkbench() {
  try {
    const res = await fetch(`${CF_API}/d1/spy-daily-close`);
    if (!res.ok) throw new Error(res.status);
    const { rows } = await res.json();
    renderWorkbench(rows ?? []);
    _loaded = true;
  } catch (e) {
    $('wb-tbody').innerHTML =
      `<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--text-muted)">데이터 없음 (${e.message})</td></tr>`;
  }
}

// ── 방향 일치 판정 ────────────────────────────────────────
// gap = max_pain - 종가  (0 기준 = 종가)
// gap > 0 → max pain이 위 → 딜러 상승 압력 → ES 고가가 0 위면 일치
// gap < 0 → max pain이 아래 → 딜러 하락 압력 → ES 저가가 0 아래면 일치
function isHit(r) {
  const gap = (r.max_pain ?? 0) - (r.close ?? 0);
  if (gap > 0) return r.es_session_high > r.close;
  if (gap < 0) return r.es_session_low  < r.close;
  return false;
}

// ── 렌더링 ────────────────────────────────────────────────
function renderWorkbench(rows) {
  const last    = rows[0] ?? null;
  const samples = rows.filter(r =>
    r.es_session_low != null && r.es_session_high != null
  );
  const hits = samples.filter(isHit);

  const hitRate = samples.length
    ? (hits.length / samples.length * 100).toFixed(1)
    : null;

  const gaps   = rows
    .filter(r => r.close != null && r.max_pain != null)
    .map(r => r.max_pain - r.close);
  const avgGap = gaps.length
    ? (gaps.reduce((a, b) => a + Math.abs(b), 0) / gaps.length).toFixed(2)
    : null;

  const lastGap = last?.close != null && last?.max_pain != null
    ? (last.max_pain - last.close).toFixed(2)
    : null;

  // 메트릭 카드
  const gapColor = lastGap == null ? COLOR.muted
    : lastGap > 0 ? COLOR.green : COLOR.red;

  setEl('wb-gap',     lastGap != null ? (lastGap > 0 ? '+' : '') + lastGap : '—', gapColor);
  setEl('wb-gap-sub', last ? `${last.date} 기준` : 'max pain − close', COLOR.muted);

  setEl('wb-hit-rate',
    hitRate != null ? hitRate + '%' : '—',
    hitRate >= 70 ? COLOR.green : hitRate >= 50 ? COLOR.amber : COLOR.red);
  setEl('wb-hit-rate-sub',
    samples.length ? `${hits.length}/${samples.length}일 일치` : '샘플 없음', COLOR.muted);

  setEl('wb-samples', String(samples.length), COLOR.amber);
  setEl('wb-avg-gap', avgGap != null ? avgGap : '—', COLOR.muted);
  setEl('wb-updated',
    last?.saved_at_kst ? 'KST ' + last.saved_at_kst.slice(0, 16) : '—');

  _renderChart(rows);
  _renderTable(rows);
}

// ── 차트 ─────────────────────────────────────────────────
function _renderChart(rows) {
  const ctx = $('wb-chart-gap');
  if (!ctx) return;
  if (_wbChart) { _wbChart.destroy(); _wbChart = null; }

  const rev     = [...rows].reverse();
  const labels  = rev.map(r => r.date?.slice(5) ?? '');

  // gap = max_pain - 종가 (0 기준 = 종가)
  const gapData = rev.map(r =>
    r.close != null && r.max_pain != null
      ? +(r.max_pain - r.close).toFixed(2)
      : null
  );
  // ES 고가/저가도 종가 기준 상대값
  const esHigh = rev.map(r =>
    r.es_session_high != null && r.close != null
      ? +(r.es_session_high - r.close).toFixed(2)
      : null
  );
  const esLow = rev.map(r =>
    r.es_session_low != null && r.close != null
      ? +(r.es_session_low - r.close).toFixed(2)
      : null
  );

  _wbChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        // ES 고가 — fill: '+1' 로 저가 라인까지 밴드 음영
        {
          label: 'ES 야간 고가',
          data: esHigh,
          type: 'line',
          borderColor: '#378ADD',
          backgroundColor: 'rgba(55,138,221,0.10)',
          borderWidth: 1.5,
          pointRadius: 2.5,
          pointBackgroundColor: '#378ADD',
          tension: 0.3,
          fill: '+1',   // 바로 다음 dataset(ES 저가)까지 채움
          order: 1,
        },
        // ES 저가
        {
          label: 'ES 야간 저가',
          data: esLow,
          type: 'line',
          borderColor: '#E24B4A',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderDash: [5, 3],
          pointRadius: 2.5,
          pointBackgroundColor: '#E24B4A',
          tension: 0.3,
          fill: false,
          order: 1,
        },
        // gap 막대 — +초록 / -빨강
        {
          label: 'Gap (max pain − 종가)',
          data: gapData,
          backgroundColor: gapData.map(v =>
            v == null ? 'rgba(128,128,128,0.3)'
            : v > 0   ? 'rgba(29,158,117,0.80)'
            :            'rgba(226,75,74,0.80)'
          ),
          borderColor: gapData.map(v =>
            v == null ? '#888' : v > 0 ? '#1D9E75' : '#E24B4A'
          ),
          borderWidth: 1,
          borderRadius: 3,
          order: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        filler: { propagate: true },
      },
      scales: {
        x: {
          ticks: { font: { size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
          grid:  { color: 'rgba(128,128,128,0.07)' },
        },
        y: {
          ticks: {
            font: { size: 11 },
            callback: v => (v > 0 ? '+' : '') + v.toFixed(1),
          },
          grid: { color: 'rgba(128,128,128,0.07)' },
        },
      },
    },
  });
}

// ── 테이블 ───────────────────────────────────────────────
function _renderTable(rows) {
  const tbody = $('wb-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9"
      style="text-align:center;padding:2rem;color:var(--text-muted)">
      아직 데이터가 없습니다. 오늘 ET 16:30부터 누적됩니다.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const gap   = r.close != null && r.max_pain != null
      ? r.max_pain - r.close : null;
    const hasES = r.es_session_low != null && r.es_session_high != null;

    let match = '—';
    if (gap != null && hasES) {
      match = isHit(r)
        ? '<span style="color:#1D9E75">✓ 일치</span>'
        : '<span style="color:#E24B4A">✗ 불일치</span>';
    }

    const gapStyle = gap == null ? '' : `color:${gap > 0 ? '#1D9E75' : '#E24B4A'}`;
    const dexM = r.total_dex != null
      ? (r.total_dex / 1e6).toFixed(1) + 'M' : '—';

    return `<tr>
      <td>${r.date ?? '—'}</td>
      <td>${r.close    != null ? '$' + r.close.toFixed(2)    : '—'}</td>
      <td>${r.max_pain != null ? '$' + r.max_pain.toFixed(0) : '—'}</td>
      <td style="${gapStyle}">${gap != null ? (gap > 0 ? '+' : '') + gap.toFixed(2) : '—'}</td>
      <td>${dexM}</td>
      <td>${r.es_session_low  != null ? r.es_session_low.toFixed(2)  : '—'}</td>
      <td>${r.es_session_high != null ? r.es_session_high.toFixed(2) : '—'}</td>
      <td>${match}</td>
      <td style="color:var(--text-muted);font-size:11px">${r.saved_at_kst?.slice(0, 16) ?? '—'}</td>
    </tr>`;
  }).join('');
}

// ── 공개 API ──────────────────────────────────────────────
export function initWorkbench() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'workbench' && !_loaded) loadWorkbench();
    });
  });
}

export { loadWorkbench };
