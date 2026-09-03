# Radar 탭 설계 문서 (테스트베드)

> 상태: v0.3 (2026-09-04) — 최종 합의본. 코딩은 이 문서 기준으로 진행 (인계용 명세 §6 포함)
> 원칙: 기존 Screener / Structure 탭과 그 계산 코드는 손대지 않는다.
> 저장된 옵션 데이터(daily_screener.strike_data)를 프론트에서 새 기준으로 재계산하는
> 독립 탭을 만들어 테스트베드로 쓰고, 검증 후 한쪽을 폐기한다.

---

## 0. 목적

VIX(지수 변동성)가 압축되는 국면에서, 옵션 스큐가 크고 딜러 헷지 되사기(Vanna/Charm) 연료가
큰 종목을 **논리적 순서(점수 합산 아님)**로 골라 상승 타이밍이 가까운 순으로 나열한다.
종목을 클릭하면 핵심 구조 정보만 보여준다.

가설(사용자 관찰, 미검증):
- 월말옵션(셋째 금요일) 전 2주 = Vanna/Charm 지지 창
- OPEX 다음 주 ~ 다음 달 첫째 주 = window of weakness (청산·재구축)
- 월말에 볼 매도가 늘며 압축이 시작되면, 하락하던 모멘텀 종목 중 스큐가 큰 종목이 튄다
- 커버드콜 흔적(콜 DEX 정점 정렬 + 풋 스큐)은 구조적 포지셔닝이라 개인 베팅보다 신뢰도 높음

---

## 1. 데이터 소스 (모두 이미 저장 중)

| 테이블 | 사용 컬럼 | 용도 |
|---|---|---|
| daily_screener | ticker, expiry_date, dte, expiry_type, atm_iv, call_oi, put_oi, **strike_data**(JSON), updated_at | 재계산 원천 |
| strike_data 항목 | strike, call_iv, put_iv, avg_iv, call_delta, call_oi, put_oi | IV·OI만 사용, 저장된 greeks는 무시 |
| screened_tickers | spot_price, group_code | 현재가, 그룹 |
| watchlist | company, market_cap, sector | 표시용 |
| price_indicators (최신일) | close, bb_upper2, bb_position, avg_volume, atr20 | BB 상단·거래대금 정규화 |
| KV snapshot:1min | vix | 체제 판단 |
| KV dex:spy | expirations[*].otm_put_iv 등 | SPY 스큐·GEX (체제) — 2차 |

### 1-1. 신규 Worker 라우트 (읽기 전용, 1개)

`GET /api/v2/chains[?symbol=XXX]`
- daily_screener(strike_data 포함) + screened_tickers + watchlist + price_indicators(최신일) JOIN
- 전체 활성 종목 반환. 예상 크기: 100종목 × 9만기 × ~2KB ≈ 1.8MB (gzip ≈ 400KB)
- 인증 없음 (기존 /api/screener/latest와 동일 정책)

---

## 2. 계산 모듈 `frontend/js/radar-engine.js` (순수 함수, node로 단독 테스트 가능)

### 2-1. Greeks 재계산과 부호 규약 (결정)

- BS 재계산: 콜은 call_iv, 풋은 put_iv 사용 (없으면 avg_iv), r = 0.05
- 딜러 가정: 딜러 롱콜 / 숏풋 (netOI = callOI − putOI), 기존과 동일
- **부호 규약: 양수 = 딜러 매수**
  - `vannaSupport` = IV가 1 vol-pt **하락**할 때 딜러가 사는 주식 ($M)
    = −φ(d1)·d2/σ × netOI × 100 × spot / 1e6  (교과서 홀더 Vanna × netOI)
  - `charmSupport` = 하루 지날 때 딜러가 사는 주식 ($M)
    = −(홀더 Charm × netOI × 100 / 1e6)
  - 검증: 현재가 위 콜 재고, 현재가 아래 풋 재고 모두 양수가 나와야 함
- 기존 코드의 vanna는 이 값의 부호 반전(= IV 상승 시 딜러 매수)이므로 기존 값과 비교 금지

### 2-2. OTM 범위 = 1.5σ (결정)

- σ_move = spot × atm_iv × √(dte/365)
- 풋 밴드 [spot − 1.5σ, spot), 콜 밴드 (spot, spot + 1.5σ]
- 밴드 내 스트라이크가 2개 미만이면 가장 가까운 2개로 대체하고 `lowConf=true`
- 만기별 정규화 스큐: `skewRel = (mean(put_iv in 풋밴드) − mean(call_iv in 콜밴드)) / atm_iv`
  - 양수 = 풋 스큐 (압축 시 상방), 음수 = 콜 스큐 (압축 시 하방/중립)

### 2-3. 만기별 지표

| 필드 | 정의 |
|---|---|
| skewRel | 2-2 |
| vannaSupport | 만기 내 전 스트라이크 합 |
| charmSupport | 만기 내 전 스트라이크 합 |
| putOIBelow | spot 아래 풋 OI 합 |
| callOIAbove | spot 위 콜 OI 합 |
| peakCallStrike | spot 위 콜 DEX 최대 스트라이크 (콜월 후보) |
| window | 만기일이 속한 달력 창 (2-5) |

### 2-4. 종목별 지표

- `callWall`: 8주 합산 콜 DEX(spot 위) 정점 스트라이크. **단기 목표**
- `alignCount`: 만기별 peakCallStrike가 callWall과 일치하는 만기 수. **5 이상 = "구조" 배지**
- `oiUpperEdge`: 8주 합산 콜 OI를 spot 위로 누적해 95% 도달 스트라이크. **장기 상단** (판단 미사용, 표시만)
- `oiLowerEdge`: 8주 합산 풋 OI를 spot 아래로 누적해 95% 도달 스트라이크. 범위 하단
- `concRatio`: 만기별 총 OI(콜+풋)의 max / 최저 2개 평균. OI 500 미만 만기는 분모 후보 제외. 비정상 베팅 감지
- `keyExpiry`: concRatio 최대 만기 중 skewRel > 0인 것. 없으면 skewRel × vannaSupport 최대 만기
- `daysToKey`: keyExpiry.dte
- `skewA`, `skewB`: 창 A / 창 B에 만기가 있는 옵션들의 OI 가중 skewRel
- `vannaTotal`: 전 만기 vannaSupport 합 ($M). 정규화 없음 (거래대금 데이터 없음)
- `vannaReach`: spot부터 위로 vannaSupport > 0 스트라이크가 연속되는 상단 (기존 vanna_limit 대응)
- `bbPos`: price_indicators.bb_position
- `ivHv`: 보류 (HV는 Railway에만 있음, 2차)

### 2-5. 달력 창 (결정)

셋째 금요일 = OPEX. 창은 두 개가 번갈아 온다. 고정 날짜 없음.
- 창 B (지지): OPEX − 14일 ~ OPEX
- 창 A (약세/재구축): OPEX + 1일 ~ 다음 지지창 시작 전날
- 헤더에 "현재 창 · 다음 지지창까지 D-n" 표시. 종목 만기일도 같은 규칙으로 창 A/B 분류.

### 2-6. 선별과 정렬 (결정: 점수 없음, 그룹 분리 없음)

제외 트리 (순서대로, 걸리면 하단 별도 표시):
```
1. keyExpiry 없음 (풋 스큐 양수 만기 없음) → [압축 시 매도 구조 / 해당 없음]
2. vannaReach 없음 (spot 바로 위 vannaSupport <= 0) → [연료 없음]
3. 소진 (2-7) → [소진]
```

후보 목록 정렬 키 (위에서부터):
1. `skewRel(keyExpiry)` 내림차순  — 스큐 크기가 1순위
2. `alignCount` 내림차순          — 커버드콜 정렬이 2순위 (5 이상 "구조" 배지)
3. `daysToKey` 오름차순           — 타이밍
4. `vannaTotal` 내림차순          — 연료 크기

각 행에 이유 문자열 노출 (예: "풋스큐 +12% · 정렬 7/9 · D-9 · Vanna 2.3M · 집중도 4.1x").
`concRatio`는 정렬 키가 아니라 컬럼이며 keyExpiry 선택에만 쓴다.

경고 배지 (순위 불변): VIX 5일 상승 중, 실적일 창 내(2차), lowConf.

### 2-6b. MY 그룹 (결정)

- 사용자가 admin 페이지에서 그룹 코드 `MY`를 만들고 종목을 수동 추가한다 (기존 admin API 그대로:
  `POST /api/admin/groups` → `POST /api/admin/groups/MY/symbols`). 백엔드 변경 없음.
- 일일 수집은 `screened_tickers` 전체를 대상으로 하므로 MY 종목은 자동으로 매일 수집된다.
  prune은 WATCHLIST·MONITOR만 건드리므로 MY는 삭제되지 않는다.
- Radar 탭: `group_code`에 MY가 포함된 종목은 **제외 트리와 무관하게 항상 분석하고 목록 최상단 "MY" 섹션에 고정**한다.
  제외 사유(콜 스큐, 연료 없음, 소진)에 해당하면 배지로만 표시한다. MY 섹션 내부 정렬은 일반 목록과 같은 키.
- 한 종목이 MY와 다른 그룹에 동시에 속할 수 있다 (screened_tickers는 (ticker, group_code) 다중 행).

### 2-7. 소진 판정과 이력 테이블 (결정: 1차 필수)

소진 = 콜월 도달이 아니라 **스큐의 전환·소멸과 Vanna의 변화**.
- keyExpiry의 skewRel이 전일 양수 → 당일 0 이하
- 또는 vannaTotal이 전일 대비 큰 폭 감소 (임계는 데이터 보고 결정)
- 이력이 쌓이기 전 임시 대용: 근월 skewRel < 0 이면서 keyExpiry skewRel > 0

이력 테이블 `daily_screener_hist` (신규, 별도 테이블)
- 키: (ticker, date, expiry_date). `daily_screener`와 같은 컬럼 + date
- `POST /d1/daily-screener` 핸들러에서 오늘 행을 daily_screener에 넣을 때 **같은 행을 date 붙여 한 번 더 INSERT**
- daily_screener는 지금처럼 DELETE+INSERT (종목당 오늘 행만). hist는 삭제하지 않고 누적
- 규모: 종목당 하루 ~9행, 90일 ≈ 800행/종목, 100종목 ≈ 8만 행, strike_data 포함 ≈ 160MB
- 보관: 90일 초과 행은 주기 삭제 (Railway 일일 크론 끝에서 호출)
- **가장 먼저 배포** — 데이터가 그날부터 쌓임
- 나중에 검증할 것: 창별 5일·10일 선행 수익률, 콜월·oiUpperEdge 60~90일 도달률

---

## 3. 화면 `frontend/js/tabs/radar.js`

### 3-1. 목록
- 헤더: 오늘 날짜, 다음 OPEX, 현재 창(A/B/전환), VIX와 5일 방향
- 섹션 순서: [MY 고정] → [후보 목록] → [제외: 소진 / 연료 없음 / 압축 시 매도 구조]
- 컬럼: 종목, 현재가, keyExpiry(D-n), skewRel, skewA/skewB, vannaPerADV, 콜월, vannaReach, BB, 이유

### 3-2. 상세 (행 클릭, 같은 탭 안 패널)
1. 가격 사다리: oiLowerEdge, 풋 OI 최대 스트라이크, GEX 플립, spot, vannaReach, 콜월, BB 2σ 상단, oiUpperEdge, keyExpiry EM
2. 만기 표: 만기, DTE, 창, skewRel, vannaSupport, charmSupport, putOI↓, callOI↑, peakCallStrike, 총OI
3. 맵: 만기 × 스트라이크 DEX 맵 + 만기별 콜 정점 마커 + 8주 합산 행. 합산 행에 콜월·oiUpperEdge·oiLowerEdge 세로선.
   Vanna 지원 레이어 토글 (양수 = 초록 딜러 매수, 음수 = 빨강). M/m/G 삼중 마커 없음.
4. (이력 쌓인 뒤) keyExpiry skewRel · vannaTotal 90일 추이선
기존 Structure 탭의 다른 섹션은 넣지 않는다.

---

## 4. 파일 변경 목록

| 파일 | 변경 |
|---|---|
| cloudflare/src/worker.js | (1) `/d1/daily-screener`에 hist INSERT 추가 (2) `GET /api/v2/chains` 라우트 추가 (3) hist 보관 삭제 라우트 |
| railway/index.js | 일일 크론 끝에 hist 보관 삭제 호출 1줄 |
| frontend/js/radar-engine.js | 신규. 계산 전용, DOM 없음 |
| frontend/js/tabs/radar.js | 신규. 목록 + 상세 렌더 |
| frontend/js/tabs.js | TAB_HANDLERS에 radar 등록 |
| frontend/index.html | 탭 버튼 + `#tab-radar` 패널 |
| frontend/css/screener-structure.css | 필요 시 radar 클래스 추가 (기존 클래스 변경 없음) |

기존 파일의 기존 함수는 수정하지 않는다.

---

## 5. 체크리스트

### 결정됨
- [x] 기존 탭 불변, 새 탭 테스트베드
- [x] 부호 규약: 양수 = 딜러 매수 (Vanna: IV 하락 시, Charm: 시간 경과 시)
- [x] OTM 범위 1.5σ, 스큐는 ATM IV로 정규화
- [x] 점수 합산 없음, 판단 트리 + 그룹 내 정렬
- [x] 실적일은 제외가 아니라 경고
- [x] 계산은 프론트, Worker는 읽기 라우트 1개만

### 결정됨 (v0.2 추가)
- [x] 탭 이름 Radar
- [x] 창: 지지창 OPEX−14일~OPEX, 나머지는 약세·재구축창 (고정 날짜 없음)
- [x] 콜월 = 8주 합산 콜 DEX 정점, 정렬 수 5 이상 "구조" 배지
- [x] OI 상·하단 경계 = 누적 95%, 표시만 (판단 미사용, 도달률 검증 후 역할 결정)
- [x] 스크리닝 순서: 스큐 크기 → 정렬 수 → D-n → Vanna $M. 그룹 분리 없음
- [x] 집중도 배수 = 만기별 총 OI max / 최저 2개 평균, OI 500 하한. keyExpiry 선택용
- [x] Vanna 정규화 없음 ($M 절대값)
- [x] 소진 = 스큐 전환·소멸 + Vanna 변화. 콜월 도달은 미사용
- [x] 이력 테이블 daily_screener_hist 1차 필수, 90일 보관

### 미결
- [ ] 소진 판정의 Vanna 감소 임계 (이력 쌓인 뒤)
- [ ] 1.5σ 밴드 스트라이크 부족 시 대체 규칙 (초안: 가장 가까운 2개 + lowConf)
- [ ] SPY 체제 판단 소스 (VIX만 vs VIX + SPY GEX 부호)
- [ ] 실적일 소스 (Finnhub)
- [ ] hist 보관 기간 90일이 적정한지

### 다음 작업
1. worker.js: hist 테이블 생성 SQL + `/d1/daily-screener` hist INSERT → 배포 (데이터 누적 시작)
2. worker.js: `GET /api/v2/chains` 라우트 → 배포 → 응답 크기 확인
3. radar-engine.js 작성 + node 단위 테스트 (부호 검증: 콜 재고/풋 재고 모두 양수, NVDA 콜월 230·경계 ~300 재현)
4. radar.js 목록 → 상세 순서로 구현
5. 실데이터로 임계값 조정


---

## 6. 구현 인계 명세 (다른 모델/세션이 이 문서만 보고 코딩할 수 있도록)

### 6-0. 규칙
- 기존 함수·기존 탭 코드는 수정하지 않는다. 추가만 한다. (CLAUDE.md 1-3)
- 기존 `vanna`/`charm` 저장값은 새 코드에서 **읽지 않는다** (부호 규약이 반대).
- 코드 스타일: 기존 파일과 동일 (ESM, 2칸 들여쓰기, 한국어 주석).

### 6-1. D1 테이블 (수동 실행, 사용자 확인 후)
```sql
CREATE TABLE IF NOT EXISTS daily_screener_hist (
  ticker TEXT NOT NULL, date TEXT NOT NULL, expiry_date TEXT NOT NULL,
  dte INTEGER, expiry_type TEXT,
  net_gex REAL, flip_strike REAL, atm_iv REAL, call_oi INTEGER, put_oi INTEGER, pcr_oi REAL,
  dex REAL, vanna REAL, charm REAL, call_vol INTEGER, put_vol INTEGER,
  iv_skew REAL, otm_call_iv REAL, otm_put_iv REAL,
  strike_data TEXT, peak_call_dex_strike REAL, peak_call_dex_value REAL,
  spot_price REAL, updated_at TEXT,
  PRIMARY KEY (ticker, date, expiry_date)
);
CREATE INDEX IF NOT EXISTS idx_dsh_date ON daily_screener_hist(date);
```
실행: `cd cloudflare && npx wrangler d1 execute options-screener --remote --command "..."`.
`date`는 Railway가 보내는 `updated_at`의 ET 날짜(YYYY-MM-DD). `spot_price`는 저장 시점 screened_tickers 값.

### 6-2. worker.js 변경 3곳
1. `POST /d1/daily-screener` (현재 [worker.js:864](cloudflare/src/worker.js:864) 부근): `env.DB.batch([deleteStmt, ...insertStmts])` 앞에
   hist용 `INSERT OR REPLACE INTO daily_screener_hist (...)` 문을 rows.map으로 만들어 같은 batch에 포함.
   date = `updated_at` → ET 날짜 변환 (기존 헬퍼 없으면 `new Date(updated_at).toLocaleDateString('en-CA',{timeZone:'America/New_York'})`).
2. `GET /api/v2/chains[?symbol=XXX]` 신규. 인증 없음. 응답:
   ```
   { date, vix: null, tickers: [ {
       symbol, company, market_cap, groups: "MY,WATCHLIST", spot_price,
       bb: { close, bb_upper2, bb_lower2, bb_position } | null,
       expiries: [ { expiry_date, dte, expiry_type, atm_iv, call_oi, put_oi, flip_strike,
                     strikes: [ {strike, call_iv, put_iv, avg_iv, call_delta, call_oi, put_oi} ] } ]
   } ] }
   ```
   SQL: daily_screener d LEFT JOIN screened_tickers st, watchlist w, price_indicators p(최신 date만).
   strike_data는 JSON.parse 후 greeks 필드(dex/gex/vanna/charm)는 버리고 위 7개만 남긴다 (크기 절감).
   `?days=2` 옵션: daily_screener_hist에서 최근 N개 date를 같은 형태로 `history: { [date]: tickers[] }`에 추가 (소진 판정용).
3. `POST /d1/hist-retention` (x-cron-secret): `DELETE FROM daily_screener_hist WHERE date < date('now','-90 days')`.
   Railway 일일 수집 종료부([index.js:1394](railway/index.js:1394) prune 호출 뒤)에서 1회 호출.

### 6-3. `frontend/js/radar-engine.js` 함수 시그니처 (DOM 없음, node 테스트 가능)
```js
export function bsGreeks(spot, strike, dte, iv, r = 0.05)
  // → { delta, gamma, vannaHolder, charmHolder }  vannaHolder = -phi(d1)*d2/iv (교과서), charmHolder = 기존 calcGreeks의 charm
export function strikeSupport(spot, s, dte)
  // s = {strike, call_iv, put_iv, avg_iv, call_oi, put_oi}
  // netOI = call_oi - put_oi; iv = strike>spot ? (call_iv??avg_iv) : (put_iv??avg_iv)
  // → { vannaSupport: vannaHolder*netOI*100*spot/1e6, charmSupport: -charmHolder*netOI*100/1e6,
  //     callDex: delta*call_oi*100/1e6 }
export function expiryMetrics(spot, expiry)        // → 2-3 필드 + skewRel(1.5σ) + lowConf + totalOI
export function tickerMetrics(t, calendar)         // → 2-4 필드 전부 + expiries[]
export function classify(m, prev /* 전일 tickerMetrics|null */) // → { exclude: null|'call_skew'|'no_fuel'|'exhausted', badges:[] }
export function sortCandidates(list)               // 2-6 정렬 키
export function opexCalendar(today)                // → { opex, nextOpex, window:'B'|'A', daysToSupport, windowOf(expiryDate) }
```
단위 테스트 (`node --input-type=module`로 실행, 파일 `frontend/js/radar-engine.test.mjs`):
- S=100, K=110 콜 OI 1000 → vannaSupport > 0, charmSupport > 0
- S=100, K=90 풋 OI 1000 → vannaSupport > 0, charmSupport > 0
- S=100, K=110 풋 OI 1000 (딜러 롱풋 가정 하 매도) → vannaSupport < 0
- opexCalendar('2026-09-04') → opex 2026-09-18, window 'B' (09-04는 OPEX-14일 이내)
- 실데이터 회귀: NVDA 응답으로 callWall = 230, alignCount ≥ 5, oiUpperEdge ≈ 300 (±10)

### 6-4. `frontend/js/tabs/radar.js`
- `initRadar()` / `refreshRadar()` export, tabs.js TAB_HANDLERS에 `radar` 추가, index.html 버튼(`data-tab="radar"`)과 `<div class="tab-panel" id="tab-radar">` 추가.
- 로드: `${CF_API}/api/v2/chains?days=2` 1회 + `state.snapshot?.vix`. 계산은 전부 엔진.
- 목록 컬럼: 종목 · 현재가 · 핵심만기(D-n·창) · skewRel · skewA/skewB · 정렬수(구조 배지) · Vanna $M · 집중도 · 콜월 · 상단경계 · BB · 이유
- 상세: 3-2. 맵은 canvas, 기존 `_stRenderHeatmapSection`을 복사하지 말고 단순화해 새로 작성 (열: 스트라이크, 행: 만기 + 합산).
- 스타일: 기존 `.struct-*`, `.data-table` 클래스 재사용. 새 클래스는 `.radar-*` 접두.

### 6-5. 완료 기준
1. hist INSERT 배포 후 다음 날 `SELECT COUNT(*) FROM daily_screener_hist` 가 종목 수 × 만기 수와 일치
2. `/api/v2/chains` 응답 < 3MB(gzip 전), 200ms 내
3. 단위 테스트 5개 통과
4. Radar 탭에서 NVDA 클릭 시 사다리에 콜월 230, 상단 경계 ~300 표시
5. MY 그룹 종목이 제외 사유가 있어도 상단에 표시
