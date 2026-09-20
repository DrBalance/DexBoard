# Radar 탭 설계 문서 (테스트베드)

> 상태: v0.5 (2026-09-20) — 소수 정예 선별(로그 BB 하단 터치 필수), 아코디언 상세·시각화, 지수 섹션, 후보 일일 저장, 스케줄러 버그 수정. 변경 이력은 §8
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
| price_indicators (최근 5일) | close, bb_mid, bb_upper2, bb_lower2, bb_position, atr20, **bb_log_pos, bb_log_low_pos, sma50, sma200** (v0.5 추가 컬럼) | 위치 게이트(로그 %B·하단 터치), 추세 필터(200일선), 콜월까지 ATR 폭, 사다리 |
| KV snapshot:1min | vix (객체: price, changePct, …) | 헤더 현재 VIX — `vix.price` 사용 |
| spy_daily_close | date, vix_close (최근 6일) | 헤더 VIX 5일 방향 (표시만, 등급 미반영) |
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
  - IV가 null인 스트라이크는 평균에서 **제외** (0으로 넣으면 스큐가 ±100%로 폭발 — v0.4 수정)
- **신뢰도 가드 (v0.4 결정)**
  - `atm_iv < MIN_ATM_IV(0.05)` → 깨진 ATM 호가로 간주, `skewRel=null` + `lowConf`. (DBRG 0.030, CZR 0.027 사례)
  - lowConf 만기는 keyExpiry 후보와 skewA/skewB 가중 평균에서 **제외**. Vanna/Charm/OI 집계는 계속 계산.
  - 신뢰 만기(`reliableCount`)가 0인 종목은 후보에서 제외 → 제외 목록 "신뢰도 낮음".
    이유: OPEX 근접 시 저가 종목은 1.5σ가 $0.2~0.4라 밴드가 비고, 대체 규칙 스큐는 잡음이다.
    종목 수를 늘리는 것보다 상위권의 신뢰성이 우선 (사용자 결정). 실데이터: 373종목 중 40개 제외.

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
- `bbPos`: price_indicators.bb_position (선형 BB). v0.5부터 **표시 전용**으로 강등 — 판정은 아래 로그 BB 값으로
- `bbLogPos`: 당일 종가의 **로그 BB(20, 2σ) %B**. 사용자 TradingView 지표(`Log BB + Inner Band`)와 동일 정의:
  `basis = SMA20(ln close)`, `dev = stdev20(ln close)`, `%B = (ln close − (basis − 2·dev)) / (4·dev)` (v0.5)
- `bbTouch5d`: 최근 5거래일 중 하루라도 `bb_log_low_pos ≤ 0` (저가가 로그 하단 2σ 밴드 이하). 차트의 초록 화살표 위치 (v0.5)
- `trendOk`: `close > sma200`. 장기 상승 추세 안의 눌림만 본다 (v0.5). `sma50`은 표시·사다리용
- `wallDistAtr`: `(callWall − spot) / atr20`. 회귀 기대 폭. 0.6 미만이면 거래비용에 먹히는 폭 → 등급 C (v0.4)
- `reliableCount`: lowConf 아닌 만기 수. 0이면 제외 (v0.4)
- `ivHv`: 보류 (HV는 Railway에만 있음, 2차)

### 2-5. 달력 창 (결정)

셋째 금요일 = OPEX. 창은 두 개가 번갈아 온다. 고정 날짜 없음.
- 창 B (지지): OPEX − 14일 ~ OPEX
- 창 A (약세/재구축): OPEX + 1일 ~ 다음 지지창 시작 전날
- 헤더에 "현재 창 · 다음 지지창까지 D-n" 표시. 종목 만기일도 같은 규칙으로 창 A/B 분류.
- **구현 주의 (v0.4 버그 수정)**: OPEX·오늘·만기 날짜를 전부 UTC 정오로 통일한다. 로컬 자정(`new Date(y,m,d)`)과
  UTC 정오(`'YYYY-MM-DDT12:00:00Z'`)를 섞으면 KST에서 OPEX 당일 만기가 창 A로 분류된다. 단위 테스트가 3개 TZ에서 검증.

### 2-6. 선별과 정렬 (결정: 점수 없음, 그룹 분리 없음)

제외 트리 (순서대로, 걸리면 하단 별도 표시). **v0.5: 위치·추세가 게이트로 격상** — 종목 수보다 상위권 신뢰성 우선(사용자 결정 2026-09-20):
```
0. reliableCount = 0 (신뢰 만기 없음, 2-2 가드)          → [신뢰도 낮음]  (v0.4)
1. 로그 BB 없음 (price_indicators 미수집)                 → [BB 없음]      (v0.5)
2. 위치 부적합: NOT (bbTouch5d AND bbLogPos ≤ 0.25)       → [위치 부적합]  (v0.5)
3. 추세 부적합: close ≤ sma200 (sma200 없으면 통과·배지)  → [추세 부적합]  (v0.5)
4. keyExpiry 없음 (풋 스큐 양수 만기 없음)                → [콜 스큐 / 해당 없음]
5. vannaReach 없음 (spot 바로 위 vannaSupport <= 0)       → [연료 없음]
6. 소진 (2-7)                                             → [소진]
```
하락 후보(콜 스큐 + BB 상단)는 검토 후 **도입하지 않기로 결정** (2026-09-20). 상승 메커니즘(딜러 숏풋·롱콜 되사기)과 구조가 비대칭이라 거울상이 성립하지 않는다.

기본 정렬은 **의견순**(2-6c). 토글로 아래 **스큐순**(v0.3 정렬)도 선택 가능.
스큐순 정렬 키 (위에서부터):
1. `skewRel(keyExpiry)` 내림차순  — 스큐 크기가 1순위
2. `alignCount` 내림차순          — 커버드콜 정렬이 2순위 (5 이상 "구조" 배지)
3. `daysToKey` 오름차순           — 타이밍
4. `vannaTotal` 내림차순          — 연료 크기

각 행에 이유 문자열 노출 (예: "풋스큐 +12% · 정렬 7/9 · D-9 · Vanna 2.3M · 집중도 4.1x · %B 15 · 폭 1.8ATR").
`concRatio`는 정렬 키가 아니라 컬럼이며 keyExpiry 선택에만 쓴다.

경고 배지 (순위 불변): 실적일 창 내(2차). VIX 5일 방향은 헤더에만 표시하고 등급·순위에 반영하지 않는다
(VIX 상승 국면은 모델 자체가 작동하지 않는 것이므로 사용자가 헤더를 보고 판단 — 2026-09-12 결정).
lowConf는 배지가 아니라 제외 사유로 격상 (2-2).

### 2-6c. 의견 등급 (v0.4 결정: 병목 방식, 점수 합산 없음)

4개 기둥을 각각 강(3)/중(2)/약(1)으로 채점하고 **가장 약한 기둥이 등급을 정한다**. 판단 불가(null)는 중으로 간주해
A는 막되 C로 떨어뜨리지도 않는다. 임계값은 `PILLAR_THRESHOLDS`에 상수로 두며 전부 **잠정치** — 실데이터 보고 조정.

**v0.5 변경**: 위치 기둥은 게이트(2-6 제외 트리 2·3번)로 빠지고, 등급은 스큐·연료·타이밍 3기둥 + 폭 조건으로 정한다.
후보 목록에 남은 종목은 이미 "로그 BB 하단 터치 + 200일선 위"를 통과한 종목이다.
- A 추가 조건 (잠정): `reliableCount ≥ 3`, `alignCount ≥ 3`. 미달이면 B로 강등.
- `wallDistAtr < 0.6` → C (폭 부족). null이면 등급에 영향 없음.

| 기둥 | 근거 | 강 | 중 | 약 |
|---|---|---|---|---|
| 스큐 (방향) | `keyExpiry.skewRel` | ≥ 10% | 3~10% | 0~3% |
| 연료 (힘) | keyExpiry의 `vannaSupport`·`charmSupport` 부호 | 둘 다 양수 | 하나만 양수 | 둘 다 ≤ 0 |
| ~~위치 (회귀 거리)~~ | v0.5: 게이트로 이동 (2-6). `bbTouch5d && bbLogPos ≤ 0.25` 아니면 제외 | | | |
| 폭 | `wallDistAtr` | | | < 0.6이면 C (폭 부족) |
| 타이밍 | `daysToKey` + keyExpiry 창 | 창 B · D-14 이내 | D-30 이내 | 그 외 |

- %B ↔ σ 환산: BB(20,2σ)에서 `가격 − 20일선 = (4·%B − 2)σ`. %B 0.25 = −1σ, 0.5 = 20일선.
  20일선을 경계로 둔 이유: 평균회귀의 1차 타깃이 20일선이라 그 위는 "회귀"가 아니라 "돌파" 베팅.
- 연료를 $M 절대값이 아니라 **부호 일치**로 보는 이유: 종목 규모 정규화 데이터가 없어 금액 컷은 대형주만 뽑는다.
  금액(`vannaTotal`)은 동률 정렬에만 쓴다.
- 등급: 모두 강 → **A 매수 우선** / 최약 중 → **B 관심** / 최약 약 → **C 보류** / 제외 → **X** (사유 표시).
  MY 종목은 X여도 상단 고정.
- 의견순 정렬: 등급(A→B→C→X) → 스큐순 4개 키.
- 화면: 등급 배지 + 기둥 4개 점(● 강 / ◐ 중 / ○ 약 / ? 불가), 툴팁에 각 기둥의 원값.

### 2-6b. MY 그룹 (결정)

- 사용자가 admin 페이지에서 그룹 코드 `MY`를 만들고 종목을 수동 추가한다 (기존 admin API 그대로:
  `POST /api/admin/groups` → `POST /api/admin/groups/MY/symbols`). 백엔드 변경 없음.
- 일일 수집은 `screened_tickers` 전체를 대상으로 하므로 MY 종목은 자동으로 매일 수집된다.
  prune은 WATCHLIST·MONITOR만 건드리므로 MY는 삭제되지 않는다.
- Radar 탭: `group_code`에 MY가 포함된 종목은 **제외 트리와 무관하게 항상 분석하고 목록 최상단 "MY" 섹션에 고정**한다.
  제외 사유(콜 스큐, 연료 없음, 소진)에 해당하면 배지로만 표시한다. MY 섹션 내부 정렬은 일반 목록과 같은 키.
- 한 종목이 MY와 다른 그룹에 동시에 속할 수 있다 (screened_tickers는 (ticker, group_code) 다중 행).

### 2-8. 후보 일일 저장 `radar_daily_picks` (v0.5 결정)

검증(창별 5일·10일 선행 수익률)을 하려면 **그날 화면에 뜬 후보 목록 자체**를 남겨야 한다. 임계값을 바꾸면 hist로 재계산한
과거 후보가 달라지므로, 재계산이 아니라 스냅샷을 저장한다.
- 테이블: `radar_daily_picks (date, ticker, grade, skew_rel, bb_log_pos, bb_touch_5d, vanna_total, key_expiry, days_to_key, call_wall, spot, engine_ver)` PK (date, ticker)
- 저장 주체: Radar 탭이 로드 후 후보(등급 A/B/C, 제외 제외)를 `POST /api/v2/radar-picks`로 보낸다. 같은 날 재저장은 REPLACE.
  프론트가 저장하는 이유: 엔진이 프론트에만 있고, Worker에 엔진을 복제하지 않는다(중복 금지). 하루 첫 로드 때만 저장.
- 검증 시: TradingView MCP `get_ohlcv` 또는 `price_indicators.close`로 D+5·D+10 수익률 계산 (세션에서 Claude가 수행).

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
- 헤더: 다음 OPEX, 현재 창(A/B), 지지창 D-n, VIX(현재 + 5일 방향 ▲/▼%), 정렬 토글(의견순/스큐순), 새로고침
- 섹션 순서 (v0.5): [지수 SPY·QQQ 고정] → [MY 고정] → [후보 목록 + 등급 카운트 A·B·C] → [제외: 위치 부적합 / 추세 부적합 / 소진 / 연료 없음 / 콜 스큐 / 신뢰도 낮음 / BB 없음]
  - 지수 섹션: `group_code`에 `INDEX`가 포함된 종목. 제외 사유와 무관하게 항상 표시(배지만). 사용자가 admin에서 INDEX 그룹에 SPY·QQQ 추가. 백엔드 변경 없음.
  - 제외 섹션은 기본 접힘, 그룹별 개수만 표시.
- 컬럼: 종목(지수·MY·구조 배지), **의견**(등급 + 기둥 점), 현재가, 핵심만기(D-n·창), 스큐, 정렬수, Vanna, 집중도, 콜월, BB, 이유
- **미니 그래픽 (v0.5)**: 숫자 옆에 인라인 SVG
  - 스큐: 중앙 0 기준 좌우 막대. 풋 스큐(+) 우측 초록, 콜 스큐(−) 좌측 빨강. 스케일 ±20% 고정
  - BB: 하단~상단 띠(로그 2σ) 위에 종가 마커, 20일선 눈금, 최근 5일 저가 최저점 마커. 터치 시 띠 하단 강조
  - Vanna·집중도: 길이 막대 (목록 내 최대값 기준 상대 스케일)

### 3-2. 상세 (v0.5: 행 아래 **아코디언**, 페이지 이동 없음)
- 행 클릭 → 바로 아래 펼침. 동시에 최대 3개까지 열림(4번째 열면 가장 오래된 것 닫힘). 차트는 펼칠 때 그린다(지연 렌더).
- 펼침 영역 안 소탭 4개:
  1. **구조**: 가격 사다리(oiLowerEdge, 로그 BB 하단, sma200, sma50, 20일선, spot, vannaReach, 콜월, 로그 BB 상단, oiUpperEdge) + 기둥 원값 표
  2. **EM**: 기존 `renderVannaDistChart`(options-charts.js) import. 입력은 Radar 엔진이 재계산한 8주 합산 스트라이크(dex·gex·vanna)
  3. **히트맵**: 기존 `renderVannaHeatmap`(heatmap.js) import + 기존 DEX 맵(canvas). 만기 × 스트라이크
  4. **만기표**: 만기, DTE, 창, skewRel, vannaSupport, charmSupport, putOI↓, callOI↑, peakCallStrike, 총OI
- **부호 주의**: 기존 차트 모듈은 Vanna를 "양수 = IV 상승 시 딜러 매수"로 해석한다(§7-1). Radar 엔진 값(양수 = IV 하락 시 딜러 매수)을
  넘길 때 **부호를 뒤집어** 전달해 색 의미를 기존 탭과 맞춘다. Charm도 동일. 엔진에 `gex` 계산 추가 필요(`gamma·OI·100·spot²·0.01/1e6`, 콜 양수·풋 음수).
- 데이터는 chains 응답 + 엔진 재계산값만 사용. Railway `/analyze-symbol` 재호출 없음 (순위와 차트가 같은 데이터에서 나오도록).
- (이력 쌓인 뒤) keyExpiry skewRel · vannaTotal 90일 추이선
기존 Structure 탭의 다른 섹션은 넣지 않는다.

---

## 4. 파일 변경 목록

| 파일 | 변경 |
|---|---|
| cloudflare/src/worker.js | (1) `/d1/daily-screener`에 hist INSERT 추가 (2) `GET /api/v2/chains` 라우트 추가 (3) hist 보관 삭제 라우트 (4) v0.4: chains 응답에 `bb_mid`·`atr20`·`vix_hist` |
| railway/index.js | 일일 크론 끝에 hist 보관 삭제 호출 1줄. v0.4: `collectBbMapIndicators(extraSymbols)` — 일일 수집 후 BB맵 종목 + 스크리너 전체(`symList`) 가격 지표 수집, 150ms 간격. **v0.5**: (1) ET 17:30 수집 트리거를 세션 변경 블록 밖으로 이동 + AFTER 블록 플래그 분리 (§7-6 버그) (2) `collectPriceIndicators`에 로그 BB(`bb_log_pos`, `bb_log_low_pos`)·`sma50`·`sma200` 추가, Yahoo range 3mo → 1y |
| cloudflare/src/worker.js (v0.5) | `/d1/price-indicators` 새 컬럼 4개 저장, `/api/v2/chains` 응답 `bb`에 새 컬럼 + `bb_hist[]`(최근 5일 `{date, bb_log_pos, bb_log_low_pos}`), `POST /api/v2/radar-picks` |
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

### 결정됨 (v0.4 추가, 2026-09-12)
- [x] 의견 등급 A/B/C/X: 4기둥(스큐·연료·위치·타이밍) 병목 방식, 점수 합산 없음. 기본 정렬 의견순, 스큐순 토글
- [x] 위치 기둥: %B ≤ 0.25 강 / ≤ 0.5 중 / > 0.5 약. 콜월까지 < 0.6 ATR이면 약
- [x] 연료 기둥: keyExpiry의 Vanna·Charm 부호 일치 (금액 아님)
- [x] VIX 방향은 헤더 표시만, 등급 미반영 (상승 국면은 모델 자체가 비활성이라 판단은 사용자)
- [x] 1.5σ 밴드 부족 시: 대체 규칙 + lowConf → **keyExpiry에서 제외**, 신뢰 만기 없으면 종목 제외. 종목 수보다 신뢰성 우선
- [x] atm_iv < 0.05 만기는 스큐 무효
- [x] IV null 스트라이크는 평균 제외
- [x] BB/ATR 수집을 스크리너 전체로 확대 (Railway 일일 수집 후)
- [x] 그록 리뷰 검토 결과 채택: 볼린저 극단을 별도 기둥으로 / 기대 폭 ATR 감점 / 레벨+변화 쌍(→ hist 필요) / SQZ 구분(제외 목록 세분화는 hist 이후).
      기각: IV rank·HV·콘탱고(데이터 없음), 상태 머신, 이중 유니버스, 5버킷, 1년 분위수화. 오류 지적: MR_UP 타깃 `min(SMA20, put_wall)`은 풋월이 현재가 아래라 틀림 → 콜월 사용.
      Positioning은 OI 개수 비율(그록)보다 Radar의 딜러 헷지 $M 계산이 더 정밀하므로 유지.

### 결정됨 (v0.5 추가, 2026-09-20)
- [x] 위치 조건은 기둥이 아니라 **게이트**: 최근 5거래일 저가가 로그 BB(20, 2σ) 하단 이하 + 당일 로그 %B ≤ 0.25. 아니면 제외
- [x] BB 정의를 사용자 TradingView 지표(로그 스케일)와 동일하게. 선형 `bb_position`은 표시 전용
- [x] 추세 필터: 종가 > 200일선 (Yahoo 1y 조회). 50일선은 표시용
- [x] 하락 후보 도입하지 않음 (비대칭 구조)
- [x] A 등급 추가 조건 reliableCount ≥ 3, alignCount ≥ 3 (잠정)
- [x] 상세는 아코디언(최대 3개), 소탭 4개, 기존 차트 모듈 import(부호 반전), Railway 재호출 없음
- [x] 지수 섹션 SPY·QQQ (`INDEX` 그룹, admin에서 사용자가 추가)
- [x] `radar_daily_picks` 일일 스냅샷 (프론트가 하루 첫 로드 때 POST)
- [x] TradingView MCP(2026-09-16 공식 베타, Essential+)는 앱 데이터원이 아니라 Claude 검증·보조 도구로만 사용 (옵션 데이터 없음, MCP 클라이언트 전용)

### 미결
- [ ] 소진 판정의 Vanna 감소 임계 (이력 쌓인 뒤)
- [ ] 기둥 임계값(`PILLAR_THRESHOLDS`) 조정 — BB 373종목 수집 후 A/B/C 분포 보고 결정
- [ ] "Vanna 여력" (VIX·IV가 더 빠질 공간) — IV 이력 필요. 그록 지적, hist 이후
- [ ] SPY 체제 판단 소스 (VIX만 vs VIX + SPY GEX 부호)
- [ ] 실적일 소스 (Finnhub)
- [ ] hist 보관 기간 90일이 적정한지
- [ ] 상세 사다리 미구현 항목 (풋 OI 최대, GEX 플립, keyExpiry EM), 90일 추이선

### 다음 작업
1. D1 ALTER(§6-1) → Worker 배포 → Railway 배포 → 스크리너 탭 "지금 수집"으로 전체 재수집 → chains `bb` 커버리지 ≈ 종목 수 확인
2. admin에서 `INDEX` 그룹 생성 + SPY·QQQ 추가 (사용자)
3. A/B/C 분포 보고 임계값 조정 (후보가 0이면 `bbLogPos ≤ 0.25` → 0.35 완화 검토, 5일 창은 유지)
4. hist가 5일 이상 쌓이면: 소진 판정 실동작 확인
5. `radar_daily_picks` 2주 이상 쌓이면 창별 5일·10일 선행 수익률 검증 (TradingView MCP 연결 시 세션에서 수행)


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

v0.5 추가 (Worker 배포 **전에** 실행 — 컬럼이 없으면 기존 BB 수집 INSERT가 실패한다):
```sql
ALTER TABLE price_indicators ADD COLUMN bb_log_pos REAL;
ALTER TABLE price_indicators ADD COLUMN bb_log_low_pos REAL;
ALTER TABLE price_indicators ADD COLUMN sma50 REAL;
ALTER TABLE price_indicators ADD COLUMN sma200 REAL;
CREATE TABLE IF NOT EXISTS radar_daily_picks (
  date TEXT NOT NULL, ticker TEXT NOT NULL, grade TEXT,
  skew_rel REAL, bb_log_pos REAL, bb_touch_5d INTEGER, vanna_total REAL,
  key_expiry TEXT, days_to_key INTEGER, call_wall REAL, spot REAL,
  engine_ver TEXT, created_at TEXT,
  PRIMARY KEY (date, ticker)
);
```

### 6-2. worker.js 변경 3곳
1. `POST /d1/daily-screener` (현재 [worker.js:864](cloudflare/src/worker.js:864) 부근): `env.DB.batch([deleteStmt, ...insertStmts])` 앞에
   hist용 `INSERT OR REPLACE INTO daily_screener_hist (...)` 문을 rows.map으로 만들어 같은 batch에 포함.
   date = `updated_at` → ET 날짜 변환 (기존 헬퍼 없으면 `new Date(updated_at).toLocaleDateString('en-CA',{timeZone:'America/New_York'})`).
2. `GET /api/v2/chains[?symbol=XXX]` 신규. 인증 없음. 응답:
   ```
   { date, vix: {price, changePct, ...} | null, vix_hist: [{date, vix}] (최근 6일, 오름차순),
     tickers: [ {
       symbol, company, market_cap, groups: "MY,WATCHLIST", spot_price,
       bb: { close, bb_mid, bb_upper2, bb_lower2, bb_position, atr20 } | null,
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
export function classify(m, prev /* 전일 tickerMetrics|null */) // → { exclude: null|'low_conf'|'call_skew'|'no_fuel'|'exhausted', badges:[] }
export function sortCandidates(list)               // 2-6 스큐순 정렬 키
export function opexCalendar(today)                // → { opex, nextOpex, window:'B'|'A', daysToSupport, windowOf(expiryDate) }
// v0.5
export function logBB(closes, lows, length = 20, mult = 2) // → { basis, upper, lower, pos, lowPos } 마지막 봉 기준. Railway와 동일 수식, 테스트 공유용
export function positionGate(t)                       // t.bb, t.bb_hist → { ok, touch5d, logPos, reason: null|'no_bb'|'position' }
export function trendGate(t)                          // → { ok, reason: null|'trend', missing: bool }
export function aggregateStrikes(m)                   // 8주 합산 {strike, dex, gex, vanna, charm, callOI, putOI}[] — 기존 차트 모듈 입력용 (부호는 Radar 규약, 호출부에서 반전)
// v0.4
export const MIN_ATM_IV = 0.05
export const PILLAR_THRESHOLDS                     // 2-6c 임계값
export function pillars(m)                         // → { skew, fuel, position, timing } 각 3|2|1|null
export function opinion(m, cls)                    // → { grade:'A'|'B'|'C'|'X', pillars, exclude }
export function sortByOpinion(list, gradeOf)       // 등급 → sortCandidates 키
```
단위 테스트 (`node frontend/js/radar-engine.test.mjs`, 37개. `TZ=UTC`·`TZ=America/New_York`로도 통과해야 함):
- S=100, K=110 콜 OI 1000 → vannaSupport > 0, charmSupport > 0
- S=100, K=90 풋 OI 1000 → vannaSupport > 0, charmSupport > 0
- S=100, K=110 풋 OI 1000 (딜러 롱풋 가정 하 매도) → vannaSupport < 0
- opexCalendar('2026-09-04') → opex 2026-09-18, window 'B'. windowOf('2026-09-18')='B', ('2026-09-19')='A'. OPEX 당일 D-0
- 병목 등급: 전부 강 → A, 위치 중 → B, 폭 0.3ATR → C, Vanna·Charm 음수 → C, BB 없음 → B, 제외 → X
- atm_iv 0.03 → skewRel null·lowConf. null IV 평균 제외. 밴드 부족 → lowConf. lowConf만 있으면 'low_conf', 차월 있으면 차월이 keyExpiry
- 실데이터 회귀: NVDA 응답으로 callWall = 230, alignCount ≥ 5, oiUpperEdge ≈ 300 (±10) — 미작성

### 6-4. `frontend/js/tabs/radar.js`
- `initRadar()` / `refreshRadar()` export, tabs.js TAB_HANDLERS에 `radar` 추가, index.html 버튼(`data-tab="radar"`)과 `<div class="tab-panel" id="tab-radar">` 추가.
- 로드: `${CF_API}/api/v2/chains?days=2` 1회 + `state.snapshot?.vix`. 계산은 전부 엔진.
- 목록 컬럼: 종목 · 현재가 · 핵심만기(D-n·창) · skewRel · skewA/skewB · 정렬수(구조 배지) · Vanna $M · 집중도 · 콜월 · 상단경계 · BB · 이유
- 상세: 3-2. 맵은 canvas, 기존 `_stRenderHeatmapSection`을 복사하지 말고 단순화해 새로 작성 (열: 스트라이크, 행: 만기 + 합산).
- 스타일: 기존 `.struct-*`, `.data-table` 클래스 재사용. 새 클래스는 `.radar-*` 접두.

### 6-5. 완료 기준
1. hist INSERT 배포 후 다음 날 `SELECT COUNT(*) FROM daily_screener_hist` 가 종목 수 × 만기 수와 일치
2. `/api/v2/chains` 응답 < 3MB(gzip 전), 200ms 내
3. 단위 테스트 전부 통과 (3개 TZ)
4. Radar 탭에서 NVDA 클릭 시 사다리에 콜월 230, 상단 경계 ~300 표시
5. MY 그룹 종목이 제외 사유가 있어도 상단에 표시
6. (v0.4) 후보 목록에 |skewRel| > 100% 종목 없음. 제외 목록에 "신뢰도 낮음" 그룹 표시
7. (v0.4) BB 수집 확대 배포 후 `withBB`가 스크리너 종목 수와 근접 (2026-09-12 시점 8/373)
8. (v0.5) 전체 재수집 후 chains `bb.bb_log_pos`·`sma200` 존재 종목 ≈ 종목 수. SPY 로그 %B가 TradingView 차트 값과 ±0.02 이내
9. (v0.5) 후보 목록의 모든 종목이 `bbTouch5d = true`, `bbLogPos ≤ 0.25`, `close > sma200`
10. (v0.5) Railway 재시작 없이 ET 17:30에 자동 수집이 실제로 실행됨 (`/screener-status` last_run 갱신)
11. (v0.5) 행 클릭 시 아코디언 4개 소탭 렌더, EM·히트맵 색이 Structure 탭과 같은 의미

### 6-6. 로컬 실행
- 프론트: `cd frontend && npm install && npm run dev` (Vite, :5173). `.claude/launch.json`에 등록됨 (`.gitignore` 대상)
- Cloudflare 배포: `cd cloudflare && npx wrangler deploy`. Node 25 + macOS 13에서는 `NODE_OPTIONS=--use-bundled-ca` 필요
  (Node 25 기본 `--use-system-ca`가 키체인에서 Google Trust Services 체인을 못 찾음). `~/.zshrc`에 추가해 둠.

---

## 7. 기존 코드 알려진 문제 (Radar 작업 범위 밖 · 보고용 · 수정 여부는 별도 결정)

2026-09-04 세션에서 발견. Radar 탭은 이 코드를 읽지 않으므로 Radar 작업에는 영향 없음.
기존 탭을 손볼 때 참고. **Radar 작업 중에 이 항목들을 수정하지 말 것.**

### 7-1. Vanna/Charm 부호 해석이 반대 (가장 큰 문제)
- [vanna_analyzer.js:118](railway/vanna_analyzer.js:118) `calcGreeks`의 vanna = `φ(d1)·d2/σ`. 교과서 홀더 Vanna는 `−φ(d1)·d2/σ`.
  netOI(callOI−putOI)와 곱하면 결과는 "IV 1단위 **상승** 시 딜러 매수량"이 됨. 즉 **음수 = IV 하락 시 딜러 매수(지지)**.
- 그런데 아래 코드는 전부 **양수를 지지로 해석**함:
  - [screener-engine.js:109](railway/screener-engine.js:109) `calcVannaMetrics` — 양수 연속 구간을 vanna_limit으로 잡음 (스크리너 등급·prune에 사용)
  - [structure.js:851](frontend/js/tabs/structure.js:851) `vannaOk = vannaSum > 0`
  - [options-charts.js:183](frontend/js/options-charts.js:183) `evaluateStatus` "Vanna 양수" 가점
  - [structure.js:1149](frontend/js/tabs/structure.js:1149), [structure.js:1178](frontend/js/tabs/structure.js:1178) 만기 카드 색상
  - [heatmap.js:69](frontend/js/heatmap.js:69) `_calcDGreeks` — Vanna 히트맵 색 전체
  - [narrative.js:99](frontend/js/narrative.js:99) SPY 탭 문구
- Charm도 같은 구조: 코드 charm 합계 음수 = 시간 경과 시 딜러 매수.
- 수정안 A(권장): `calcGreeks`에서 부호를 뒤집어 "양수 = 지지"로 통일. 단 D1/KV 저장값 의미가 바뀌므로 배포 후 재수집 필요.
  수정안 B: 위 해석 코드 6곳을 음수 기준으로 수정.

### 7-2. iv_skew 정의가 4곳에서 다름
| 위치 | 정의 | 부호 |
|---|---|---|
| [vanna_analyzer.js:360](railway/vanna_analyzer.js:360) `aggregateByExpiry` (DB 저장값) | (ATM콜IV − ATM풋IV)/ATM IV — 같은 스트라이크 콜/풋 차이라 스큐가 아니라 패리티 잔차 | Call 양수 |
| [vanna_analyzer.js:802](railway/vanna_analyzer.js:802) SPY 경로 | (OTM콜IV − OTM풋IV)/ATM IV | Call 양수 |
| [screener-v2.js:188](cloudflare/src/screener-v2.js:188) | OTM콜IV − OTM풋IV (정규화 없음) | Call 양수 |
| [options-charts.js:125](frontend/js/options-charts.js:125) `calculateSkew` | OTM풋IV − OTM콜IV (정규화 없음) | Put 양수 |
- 프론트 Skew 차트(Put 양수=빨강)와 만기 카드(DB iv_skew>0=빨강, 즉 Call 양수=빨강)의 색 의미가 같은 화면에서 반대.
- [vanna_analyzer.js:360](railway/vanna_analyzer.js:360): OI 1,000 미만이면 null이 아니라 0 저장 → "균형"으로 오독.
- OTM 범위가 ±5% 고정이라 고IV 종목은 거의 ATM → 스큐 과소 측정. (Radar는 1.5σ로 해결)

### 7-3. structure.js 개별 버그
- [structure.js:706](frontend/js/tabs/structure.js:706) `analyzeRes.json()` 이중 호출. 두 번째는 body 소비 후라 항상 null → peak 검증 메시지 블록이 실행되지 않음.
- [structure.js:851](frontend/js/tabs/structure.js:851) `callWallStrike`는 만기별 flip_strike 최대값이지 콜월이 아님. 옵션 시나리오의 Bear Call Spread 스트라이크가 이 값으로 계산됨.
- [options-charts.js:140](frontend/js/options-charts.js:140) `calculateExpectedMove` skewBias 보정이 상단 0.3배 / 하단 1배로 비대칭, 근거 불명.
- Structure 탭 로드 시마다 `POST /analyze-symbol`로 CBOE를 실시간 호출 (저장 데이터와 별개). 비용·지연 원인.

### 7-4. 데이터 파이프라인
- `options_dex` 테이블(날짜별 이력)은 Railway에서 더 이상 쓰는 코드가 없어 비어 가는 중. `/api/options-dex/:symbol/history`는 이름과 달리 오늘 데이터만 반환.
- `price_indicators.avg_volume` 컬럼은 있으나 Railway가 채우지 않음 (항상 null).
- `calcScreenerScore`([vanna_analyzer.js:545](railway/vanna_analyzer.js:545))는 "콜 스큐 양수"를 필수 조건으로 요구 → 풋 스큐 기반 스퀴즈 후보를 걸러냄. (Radar에서는 반대로 풋 스큐가 1순위)

### 7-6. 2026-09-20 세션에서 발견 — 일일 수집 스케줄러가 작동하지 않음 (v0.5에서 수정)
- [index.js:1655](railway/index.js:1655) ET 17:30 수집 트리거가 `if (session !== lastSession)` 블록 **안**에 있어 세션 변경 순간에만 평가됨 → 사실상 절대 실행 안 됨.
  추가로 [index.js:1702](railway/index.js:1702) AFTER 진입 블록이 16:00에 `screenerDone = true`를 세워 이중으로 막힘. 2026-05-27부터 이 상태.
- 결과: 전체 수집은 2026-09-08(수동 "지금 수집") 이후 없음. 이후 갱신은 장중 돌파 재분석분(하루 3~8종목)뿐. NVDA는 09-14 데이터.
  BB 373종목 수집은 이 수집 완료에 체인되어 있어 함께 실행되지 않았음 (chains `bb` 13/394).
- Radar뿐 아니라 Screener·Structure 탭도 같은 오래된 데이터를 보고 있었음.

### 7-5. 2026-09-12 세션에서 추가 발견
- [vanna_analyzer.js:355](railway/vanna_analyzer.js:355) `atmIV = (atmCallIV + atmPutIV)/2` — 비유동 종목에서 CBOE의 깨진 IV(DBRG 0.030, CZR 0.027)를 그대로 저장. Radar는 `MIN_ATM_IV` 가드로 방어했으나 기존 Screener 탭의 iv_skew·atm_iv 표시는 그대로.
- `spy_daily_close`에 **휴장일 행**이 있음 (2026-09-07 노동절 vix_close 15.30). 크론이 휴장일에도 저장. Radar VIX 5일 방향에 1일 오차. hist 검증 시 휴장일 필터 필요.
- KV `snapshot:1min`의 `vix`는 숫자가 아니라 객체 `{price, change, changePct, prevClose, series[]}` (series는 분봉 수백 개). `/api/v2/chains`가 이걸 그대로 전달해 응답이 불필요하게 큼 — `price`만 내려주도록 정리 검토.
- `price_indicators`는 `/api/bb-map-symbols`(8종목)만 수집하고 있었음 → v0.4에서 스크리너 전체로 확대 (수정됨).

---

## 8. 변경 이력

### v0.5 (2026-09-20)
- 선별: 위치·추세 게이트(로그 BB 하단 5일 터치 + 로그 %B ≤ 0.25 + 종가 > sma200), 3기둥 등급, A 추가 조건. 하락 후보 기각
- 데이터: price_indicators에 `bb_log_pos`·`bb_log_low_pos`·`sma50`·`sma200`, Yahoo 1y, chains `bb_hist` 5일
- 화면: 아코디언 상세(소탭 4: 구조·EM·히트맵·만기표, 기존 차트 모듈 import), 목록 미니 그래픽, 지수 섹션, 제외 섹션 접힘
- 저장: `radar_daily_picks` + `POST /api/v2/radar-picks`
- Railway: ET 17:30 수집 스케줄러 버그 수정 (§7-6)

### v0.4 (2026-09-12) — 커밋 `3dd690f`, `2978423`
- 의견 등급(A/B/C/X)·의견순 정렬·기둥 점 표시 (2-6c)
- `wallDistAtr`, 위치 기둥(%B), 사다리 BB 20일선, 이유 문자열에 %B·폭
- `/api/v2/chains`에 `bb_mid`·`atr20`·`vix_hist`. 헤더 VIX `.price` 사용(NaN 수정) + 5일 방향
- `opexCalendar` UTC 정오 통일 (KST에서 OPEX 당일 만기 창 A 오분류 수정)
- 스큐 신뢰도 가드: `MIN_ATM_IV`, null IV 제외, lowConf → keyExpiry 제외 → 신뢰 만기 없으면 'low_conf' 제외
- Railway: BB/ATR 수집을 스크리너 전체로 확대
- 단위 테스트 5 → 37개, 3개 TZ 검증

### v0.3 (2026-09-04) — 커밋 `599d2a3`
- 최초 구현: hist 테이블, `/api/v2/chains`, radar-engine.js, radar.js
