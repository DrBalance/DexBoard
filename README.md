# DexBoard

> DEX(Delta Exposure) 실시간 대시보드  
> Cloudflare Workers + Railway + CF Pages

---

## 아키텍처

```
CBOE cdn API (15분 지연, 무료)
  └─→ Railway (Node.js, $5/월)
        ├─ 옵션체인 수집 → 필터링 (ATM ±10%, DTE ≤60)
        ├─ Black-Scholes Vanna / Charm 계산
        ├─ DEX / GEX 그룹별 합산 (0DTE / Weekly / Monthly / Quarterly)
        └─→ CF Workers /kv-write → KV 저장
              └─→ CF Workers API 서빙 (/api/dex/*, /api/snapshot)
                    └─→ CF Pages 프론트엔드 (추후)

Twelve Data (SPY 1분봉) ─→ CF Workers Cron ─→ KV snapshot:1min
Yahoo Finance (VIX)      ─→ CF Workers Cron ─→ KV snapshot:1min
```

---

## 폴더 구조

```
DexBoard/
├── railway/            ← Railway Node.js 서비스
│   ├── index.js        ← HTTP 서버 (POST /calculate)
│   ├── vanna_analyzer.js ← CBOE fetch + BS Greeks + DEX calc + KV write
│   ├── package.json
│   └── .env.example
└── cloudflare/         ← CF Workers
    ├── wrangler.toml
    └── src/
        └── worker.js   ← Cron + API routes + /kv-write endpoint
```

---

## Step 1: Railway 세팅

### 1-1. GitHub 레포 생성
```bash
# GitHub에서 DexBoard 레포 생성 후
git clone https://github.com/YOUR_USERNAME/DexBoard.git
cd DexBoard
```

### 1-2. Railway 프로젝트 생성
1. [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
2. `railway/` 디렉터리를 루트로 지정
3. 환경변수 설정 (아래 참고)

### 1-3. Railway 환경변수
| 변수 | 설명 |
|---|---|
| `CF_KV_URL` | CF Workers 도메인 (예: `https://drbalance-dex.workers.dev`) |
| `CF_KV_SECRET` | CF Workers ↔ Railway 공유 시크릿 |
| `CRON_SECRET` | CF Workers → Railway 인증 시크릿 |
| `PORT` | Railway가 자동 설정 (건드리지 않아도 됨) |

---

## Step 2: CF Workers 세팅

### 2-1. KV 네임스페이스 생성
```bash
cd cloudflare
npx wrangler kv:namespace create DEX_KV
npx wrangler kv:namespace create DEX_KV --preview
```
→ 출력된 `id` 와 `preview_id` 를 `wrangler.toml` 에 붙여넣기

### 2-2. Secrets 등록
```bash
npx wrangler secret put CF_KV_SECRET   # Railway와 동일한 값
npx wrangler secret put CRON_SECRET    # Railway와 동일한 값
npx wrangler secret put TWELVE_DATA_KEY
```

### 2-3. 배포
```bash
npx wrangler deploy
```

---

## KV 구조

| 키 | 내용 | 갱신 주기 |
|---|---|---|
| `snapshot:1min` | SPY 현재가 + VIX | 1분 |
| `snapshot:prev` | 직전 스냅샷 | 1분 |
| `options:spy:open` | 장 시작 스냅샷 (DEXopen 기준) | 1회/일 |
| `dex:spy:0dte` | 0DTE DEX/GEX/Vanna/Charm | 15분 |
| `dex:spy:weekly` | Weekly 만기 | 15분 |
| `dex:spy:monthly` | Monthly 만기 | 15분 |
| `dex:spy:quarterly` | Quarterly 이상 | 15분 |
| `dex:spy:structure` | 전체 합산 요약 | 15분 |

> KV 쓰기 예상: 약 660~690회/일 → 무료 플랜(1,000회/일) 이내

---

## ⚠️ 기존 CF KV 정리 필요

기존 `cache` KV 네임스페이스는 삭제해야 합니다:
```bash
# 네임스페이스 ID 확인
npx wrangler kv:namespace list

# 삭제
npx wrangler kv:namespace delete --namespace-id YOUR_CACHE_KV_ID
```

---

## 로컬 테스트

```bash
# Railway 서비스 로컬 실행
cd railway
cp .env.example .env   # 값 채우기
npm install
npm run dev

# 별도 터미널에서 테스트
curl -X POST http://localhost:3000/calculate \
  -H "Content-Type: application/json" \
  -d '{"spot": 550, "vix": 18}'
```
