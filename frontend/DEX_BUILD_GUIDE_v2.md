# DexBoard v2 — 개발 가이드
> 새 대화창에서 이어받을 완성 레퍼런스 문서

---

## 0. 현재 완료된 것

### 인프라 (완료)
- ✅ CF Worker `drbalance-dex` 배포 (`drbalance-dex.weoncheonlee.workers.dev`)
- ✅ KV `DEX_KV` 생성 + 바인딩
- ✅ Railway 배포 (`dexboard-production.up.railway.app`)
- ✅ CBOE → Railway → CF KV 파이프라인 동작 확인
- ✅ `/api/snapshot`, `/api/snapshot/prev`, `/api/dex/:group`, `/api/dex/open` 엔드포인트 동작 확인

### 프론트엔드 (완료)
- ✅ Vite 프로젝트 구조 세팅
- ✅ 모든 모듈 파일 생성 (뼈대)
- ✅ CSS 3개 파일 분리 (base / layout / components)
- ✅ JS 모듈 분리 (config / state / api / fmt / heatmap / clock / tabs / main)
- ✅ 탭별 JS 뼈대 생성 (live / structure / screener / chart)

---

## 1. 프로젝트 구조

```
DrBalance/DexBoard/
├── cloudflare/
│   └── src/
│       └── worker.js          ← CF Workers (완료)
├── railway/
│   ├── index.js               ← Railway 서버 (완료)
│   ├── vanna_analyzer.js      ← DEX 계산 엔진 (완료)
│   └── package.json
└── frontend/
    ├── index.html             ← HTML 뼈대만
    ├── vite.config.js
    ├── package.json
    ├── css/
    │   ├── base.css           ← reset, CSS 변수
    │   ├── layout.css         ← header, tabs, panel, clock
    │   └── components.css     ← metric, card, table, heatmap, badge
    └── js/
        ├── main.js            ← 진입점, 오케스트레이터
        ├── config.js          ← API endpoint, 상수
        ├── state.js           ← 전역 상태
        ├── api.js             ← fetch 함수들
        ├── fmt.js             ← 숫자/시간 포매터
        ├── heatmap.js         ← canvas 컬러 히트맵
        ├── clock.js           ← ET/KST 시계 + 장 상태
        ├── tabs.js            ← 탭 전환 로직
        └── tabs/
            ├── live.js        ← Tab1: DEX Live (구현 필요)
            ├── structure.js   ← Tab2: Structure (구현 필요)
            ├── screener.js    ← Tab3: Screener (구현 필요)
            └── chart.js       ← Tab4: Chart (구현 필요)
```

---

## 2. KV 구조

| 키 | 내용 | 갱신 주기 |
|---|---|---|
| `snapshot:1min` | SPY가격 + VIX | 1분 |
| `snapshot:prev` | 직전 스냅샷 | 1분 |
| `options:spy:open` | 장 시작 스냅샷 (DEXopen) | 1회/일 |
| `dex:spy:0dte` | 0DTE DEX + Greeks | 15분 |
| `dex:spy:weekly` | 주간 만기 DEX | 15분 |
| `dex:spy:monthly` | 월물 DEX | 15분 |
| `dex:spy:quarterly` | 분기물 DEX | 15분 |
| `dex:spy:structure` | 전체 합산 | 15분 |

---

## 3. API 엔드포인트

```
Base: https://drbalance-dex.weoncheonlee.workers.dev

GET  /api/snapshot        → snapshot:1min
GET  /api/snapshot/prev   → snapshot:prev
GET  /api/dex/0dte        → dex:spy:0dte
GET  /api/dex/weekly      → dex:spy:weekly
GET  /api/dex/monthly     → dex:spy:monthly
GET  /api/dex/quarterly   → dex:spy:quarterly
GET  /api/dex/open        → options:spy:open
GET  /health              → 헬스체크
POST /kv-write            → Railway → KV 쓰기 (내부용)
```

---

## 4. 데이터 소스

| 항목 | 소스 | 주기 | 비용 |
|---|---|---|---|
| SPY 실시간 현재가 | Finnhub WebSocket | 실시간 | 무료 |
| VIX | Yahoo Finance | 1분 | 무료 |
| 장 상태 | Twelve Data `/market_state` | 5분 | 무료(크레딧) |
| OBV | Twelve Data REST | 1분 | 유료 |
| 옵션체인 | CBOE cdn API | 15분 | 무료 |
| Greeks (Vanna/Charm) | Railway BS 계산 | 15분 | 계산 |

---

## 5. 색상 규칙 (확정)

| 지표 | 색상 |
|---|---|
| DEX 양수 / Call | `--green: #22c55e` |
| DEX 음수 / Put | `--red: #ef4444` |
| Vanna | `--purple: #a78bfa` |
| Charm | `--teal: #2dd4bf` |
| 현재가 마커 | `--amber: #f59e0b` |
| VIX 낮음 | green |
| VIX 보통 (17~25) | amber |
| VIX 높음 (>25) | red |

---

## 6. 헤더 구성 (확정)

```
DEXboard  [DEX Live] [Structure] [Screener] [Chart]    🟢 정규장 | 23:42:07 KST | 09:42:07 ET
```

- 장 상태 뱃지: `정규장 / 프리마켓 / 애프터마켓 / 마감`
- 시계: KST + ET 동시 표시
- 장 상태 기반 폴링 on/off (CLOSED 상태에서는 폴링 중단)

---

## 7. DEX 계산 공식

### 0DTE 실시간 추정
```
DEXt = DEXt-15 + (ΔSpot × Gamma합산) + (ΔVIX × Vanna합산)
```

### 기간물 추정
```
DEXTerm = DEXopen + (ΔVIX × Vanna합산) + (ΔTime × Charm합산)
```

---

## 8. 개발 순서 (앞으로 할 것)

```
Step 1: 로컬 개발 환경 시작
  cd frontend
  npm install
  npm run dev

Step 2: clock.js 검증
  - 헤더 시계 KST/ET 표시 확인
  - 장 상태 뱃지 색상 확인
  - Twelve Data market_state 연결 (config.js에 키 입력)

Step 3: Tab1 DEX Live 구현 (js/tabs/live.js)
  - 메트릭카드 (SPY, VIX, DEX, GEX, Vanna, Charm)
  - 0DTE 히트맵
  - DEX 실시간 추정 바
  - Strike 테이블

Step 4: Finnhub WebSocket 연결
  - js/ws.js 파일 신규 생성
  - SPY 실시간 현재가 → state.spotLive
  - live.js에서 spotLive 우선 사용

Step 5: Tab2 Structure 구현 (js/tabs/structure.js)
  - 만기 토글 (Weekly / Monthly / Quarterly)
  - Term DEX estimate
  - Strike 히트맵 + 테이블

Step 6: Tab3 Screener 구현 (js/tabs/screener.js)
  - SPY 만기별 Bull/Bear 신호
  - 클릭 → Chart 탭 연동

Step 7: Tab4 Chart 구현 (js/tabs/chart.js)
  - 스크리너에서 클릭 시 연동
  - 히트맵 + Strike 테이블

Step 8: CF Pages 배포
  - GitHub push
  - CF Pages 빌드: npm run build / dist 폴더

Step 9: OBV 추가 (Twelve Data)
  - worker.js fetchSnapshot에 OBV 계산 추가
  - live.js 메트릭카드에 OBV 추가
```

---

## 9. 로컬 개발 시작 방법

```bash
# 1. 프로젝트 클론
git clone https://github.com/DrBalance/DexBoard.git
cd DexBoard/frontend

# 2. 의존성 설치
npm install

# 3. config.js에 API 키 입력
# js/config.js → FINNHUB_TOKEN, TWELVE_KEY 입력

# 4. 개발 서버 시작
npm run dev
# → http://localhost:5173 열림

# 5. 빌드 (CF Pages 배포용)
npm run build
# → dist/ 폴더 생성
```

---

## 10. CF Pages 배포 설정

```
Repository:      DrBalance/DexBoard
Branch:          main
Root directory:  frontend
Build command:   npm run build
Output dir:      dist
```

---

*새 대화창에서 "Step 2: clock.js 검증부터 시작하자" 라고 하면 이어서 진행 가능*
