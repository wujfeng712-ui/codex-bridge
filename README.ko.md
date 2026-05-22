<h1 align="center">codex-bridge</h1>

<p align="center">
  의존성 제로 로컬 프록시 — <a href="https://github.com/openai/codex">Codex CLI</a>가 단일
  <code>base_url</code>로 <strong>DeepSeek</strong>, <strong>샤오미 MiMo</strong>, <strong>MiniMax</strong>, <strong>OpenAI</strong>, <strong>커스텀 프로바이더</strong>에 접속합니다.
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white" alt="Node.js 18+"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero Dependencies">
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <strong>한국어</strong> ·
  <a href="./README.es.md">Español</a>
</p>

---

Codex CLI는 **OpenAI Responses API**를 사용하고, DeepSeek와 MiMo는 **Chat Completions**를 사용합니다.
codex-bridge는 양방향으로 변환합니다 — 스트리밍 SSE, 도구 호출, 사고 모드 라운드 트립을 포함하여, Codex 클라이언트를 수정하지 않고도 지원되는 모든 모델을 사용할 수 있습니다.

## 기능

- **멀티 프로바이더 라우팅** — DeepSeek / MiMo / MiniMax / OpenAI / 커스텀, 모델명으로 자동 선택
- **양방향 프로토콜 변환** — Responses API ↔ Chat Completions, 스트리밍 SSE 브릿지 포함
- **프로바이더별 추론 강도 변환** — Codex의 `none | minimal | low | medium | high | xhigh`를 각 업스트림의 네이티브 형식으로 매핑
- **사고 모드 + 도구 호출 라운드 트립** — `reasoning_content`를 캐시하고 재생하여 DeepSeek의 사고 모드가 다중 턴 도구 호출에서도 유지
- **인바운드 인증 게이트** — `PROXY_AUTH_KEY` / `PROXY_KEYS`, 키별 프로바이더 잠금 옵션
- **세션 연속성** — `previous_response_id`가 프로바이더 간에 작동 (LRU 한계 저장소)
- **내장 `web_fetch` 도구** — URL 집약 대화에서 샌드박스 제한 우회
- **도구 호출 서킷 브레이커** — 소프트 경고 + 하드 도구 제거로 무한 도구 호출 루프 방지
- **단일 파일, 의존성 제로** — `proxy.mjs` 하나 (약 2000줄), `npm install` 불필요

## 빠른 시작

### 1. 설정

```bash
git clone https://github.com/wujfeng712-ui/codex-bridge.git
cd codex-bridge
cp env.example .env
```

`.env` 편집 — 최소 설정:

```bash
PROXY_AUTH_KEY=sk-proxy-local-$(openssl rand -hex 24)   # 하나 생성
DEEPSEEK_API_KEY=sk-...                                  # platform.deepseek.com에서 발급
```

```bash
# 또는 커스텀 OpenAI 호환 프로바이더 사용:
# CUSTOM_BASE_URL=https://your-provider.example.com/v1
# CUSTOM_API_KEY=your-key
# CUSTOM_MODELS=model-a,model-b
# DEFAULT_PROVIDER=custom
```

### 2. 프록시 시작

```bash
node --env-file=.env proxy.mjs
```

> Node 18–19 또는 백그라운드 모드가 필요하신가요? [고급 사용법](#고급-사용법)을 참조하세요.

### 3. Codex CLI를 프록시로 연결

`~/.codex/config.toml` 편집:

```toml
model = "deepseek-v4-flash"
model_provider = "local_proxy"

[model_providers.local_proxy]
name = "local_proxy"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
requires_openai_auth = true
```

Codex 인증 키 설정:

```bash
# ~/.codex/auth.json
{ "OPENAI_API_KEY": "<.env의 PROXY_AUTH_KEY와 동일>" }
```

> **[CC Switch](https://github.com/farion1231/cc-switch)를 사용 중이신가요?** 수동 편집을 건너뛰고 GUI에서 프로바이더를 추가하세요. [CC Switch와 함께 사용하기](#cc-switch와-함께-사용하기)를 참조하세요.

`codex` 실행 — 완료.

## 아키텍처

```
┌─────────────┐    Responses API    ┌──────────────┐
│  Codex CLI  │────────────────────▶│ codex-bridge │
│             │  Authorization:     │    :4000     │
└─────────────┘  Bearer <key>       └──────┬───────┘
                                           │  모델명 기반 라우팅
                   ┌───────────────────────┼────────────────────────┬───────────────────────┐
                   │                       │                        │                       │
                   ▼                       ▼                        ▼                       ▼
          ┌────────────────┐      ┌────────────────┐       ┌──────────────┐       ┌────────────────┐
          │   DeepSeek V4  │      │  샤오미 MiMo   │       │    OpenAI    │       │    커스텀      │
          │ Chat Complet.  │      │ Chat Complet.  │       │  Responses   │       │ Chat Complet.  │
          └────────────────┘      └────────────────┘       └──────────────┘       └────────────────┘
```

## 설정

모든 설정은 환경 변수를 통해 지정합니다 (자세한 내용은 `env.example` 참조):

### 인증

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PROXY_AUTH_KEY` | — | 단일 인바운드 키 (프로바이더 잠금 없음) |
| `PROXY_KEYS` | — | 다중 키 테이블: `<key>:<provider>,...`, provider ∈ `deepseek`/`mimo`/`minimax`/`openai`/`custom`/`*` |

둘 다 비어 있으면 = 인증 비활성화 (권장하지 않음).

### 업스트림 프로바이더

| 변수 | 기본값 | 설명 |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | DeepSeek 업스트림 키 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | DeepSeek 베이스 URL |
| `DEEPSEEK_MODELS` | `deepseek-v4-pro,deepseek-v4-flash` | 광고할 모델 목록 |
| `MIMO_API_KEY` | — | 샤오미 MiMo 업스트림 키 |
| `MIMO_BASE_URL` | `https://token-plan-cn.xiaomimimo.com/v1` | MiMo 베이스 URL |
| `MIMO_MODELS` | `mimo-v2.5-pro` | 광고할 모델 목록 (**소문자 필수**) |
| `OPENAI_API_KEY` | — | OpenAI 업스트림 키 (선택) |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI 베이스 URL |
| `OPENAI_MODELS` | — | 명시적 OpenAI 모델 목록 |
| `OPENAI_MODEL_PREFIXES` | `gpt-,o1,o3,o4,codex-,chatgpt-` | 휴리스틱 라우팅 접두사 |
| `CUSTOM_API_KEY` | — | 커스텀 프로바이더 업스트림 키 (선택) |
| `CUSTOM_BASE_URL` | — | 커스텀 프로바이더 베이스 URL (`CUSTOM_API_KEY` 설정 시 **필수**) |
| `CUSTOM_MODELS` | — | 커스텀 프로바이더 모델 목록 (쉼표 구분) |

### 모델 카탈로그

| 변수 | 기본값 | 설명 |
|---|---|---|
| `MODEL_CATALOG_PATH` | — | `proxy-models.json` 파일 경로. `*_MODELS` 변수를 덮어씁니다. Codex가 `model_catalog_json`으로 읽는 동일 파일 |

### 튜닝

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PROXY_PORT` | `4000` | 수신 포트 |
| `DEFAULT_PROVIDER` | auto | 모델을 알 수 없을 때 폴백 (`deepseek` / `mimo` / `openai` / `custom` / `auto`) |
| `LOG_LEVEL` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `ACCESS_LOG` | on | `0`으로 설정 시 요청별 액세스 로그 비활성화 |
| `UPSTREAM_TIMEOUT_MS` | `120000` | 업스트림 요청 타임아웃 |
| `STORE_TTL_MS` | `3600000` | 응답 저장 항목 TTL |
| `STORE_MAX` | `500` | 응답 저장 LRU 용량 |
| `GITHUB_TOKEN` | — | 선택; 미설정 시 필요에 따라 `gh auth token` 호출 |

## 라우팅 규칙

각 요청은 모델명을 기준으로 다음 우선순위로 라우팅됩니다:

1. **정확한 일치** — 모델이 `DEEPSEEK_MODELS`, `MIMO_MODELS`, `OPENAI_MODELS`, 또는 `CUSTOM_MODELS`에 포함
2. **접두사 휴리스틱** — 모델이 `OPENAI_MODEL_PREFIXES` 항목으로 시작 → OpenAI
3. **이름 힌트** — 모델에 `deepseek`, `mimo`, 또는 `minimax` 포함 → 해당 프로바이더
4. **폴백** — `DEFAULT_PROVIDER` (`custom` 포함), 다음으로 키가 설정된 첫 번째 프로바이더

## 추론 강도 변환

Codex는 `none | minimal | low | medium | high | xhigh`를 전송합니다. 각 업스트림이 지원하는 하위 집합은 다릅니다:

| Codex 강도 | DeepSeek | MiMo | OpenAI |
|---|---|---|---|
| `none` | `thinking: {type: "disabled"}` | `thinking: {type: "disabled"}` | 필드 제거 |
| `minimal` | `reasoning_effort: "low"` | `reasoning_effort: "low"` | 통과 |
| `low` / `medium` / `high` | 통과 | 통과 | 통과 |
| `xhigh` | `reasoning_effort: "xhigh"` | `high`로 제한 | `high`로 제한 |

> **참고:** DeepSeek는 `enable_thinking: false`를 조용히 무시합니다. 본 프록시는 대신 `thinking: {type: "disabled"}`를 사용합니다.

## 엔드포인트

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| `GET` | `/health` | 아니요 | 상태 확인 |
| `GET` | `/v1/models` | 예 | 병합된 모델 목록 |
| `POST` | `/v1/responses` | 예 | Codex CLI 메인 엔드포인트 (Responses API) |
| `POST` | `/v1/chat/completions` | 예 | 직접 Chat Completions 통과 |
| `GET` | `/cop?url=...` | 예 | URL 가져오기 (Jina Reader / 네이티브 HTTP) |
| `POST` | `/cop` | 예 | 커스텀 메서드/헤더/바디로 URL 가져오기 |

## 스모크 테스트

```bash
./scripts/smoke.sh                    # 기본적으로 localhost:4000 사용
./scripts/smoke.sh http://host:4000   # 커스텀 대상
MODEL=mimo-v2.5-pro ./scripts/smoke.sh  # 다른 모델 테스트
```

엔드포인트, 입력 형태, 인증 게이트, 스트리밍 완료, 추론 강도 변환, 도구 호출 라운드 트립, 프로바이더 잠금을 포함한 30개 항목을 검사합니다.

## CC Switch와 함께 사용하기

[CC Switch](https://github.com/farion1231/cc-switch)는 다양한 AI CLI 도구 (Claude Code, Codex, Gemini CLI 등)의 프로바이더 프로필을 관리하고 전환할 수 있는 인기 있는 데스크톱 앱입니다. 원클릭으로 codex-bridge와 다른 프로바이더를 전환할 수 있습니다.

### 설정

1. CC Switch 열기 → **Codex** 탭 → **프로바이더 추가**
2. 프로바이더 필드 입력:

   | 필드 | 값 |
   |---|---|
   | 이름 | `codex-bridge` (또는 원하는 라벨) |
   | API Key | `.env`의 `PROXY_AUTH_KEY` |
   | Base URL | `http://127.0.0.1:4000/v1` |

3. **활성화** 클릭 — CC Switch가 `~/.codex/auth.json`에 키를 쓰고 `config.toml`을 자동 업데이트합니다.

### 멀티 프로바이더 전환

여러 업스트림 키가 있는 경우 (예: DeepSeek용 하나, MiMo용 하나), `.env`에서 `PROXY_KEYS`를 사용하여 프로바이더별 인바운드 키를 만들 수 있습니다:

```bash
PROXY_KEYS=sk-deepseek-aaa:deepseek,sk-mimo-bbb:mimo,sk-all-ccc:*
```

그런 다음 각 키에 대해 별도의 CC Switch 프로필을 만듭니다 — 프로필을 전환하면 codex-bridge가 라우팅하는 업스트림 프로바이더가 변경됩니다.

### CLI 대안

터미널을 선호한다면, [cc-switch-cli](https://github.com/SaladDay/cc-switch-cli)가 GUI 없이 동일한 프로필 전환을 제공합니다:

```bash
# 프로필 나열
cc-switch list

# codex-bridge 프로필로 전환
cc-switch use codex-bridge
```

> **팁:** 프로필 전환 후 새 인증이 적용되려면 터미널을 재시작하거나 (또는 새 셸에서 `codex`를 실행) 하세요.

## 고급 사용법

- **Node 18–19 시작** — `--env-file`은 Node 20에 추가되었습니다. 구버전에서는:
  ```bash
  set -a && source .env && set +a && node proxy.mjs
  ```
- **백그라운드 모드**:
  ```bash
  nohup node --env-file=.env proxy.mjs > /tmp/codex-bridge.log 2>&1 &
  ```
- **다중 키 프로바이더 잠금** — 각 인바운드 키를 특정 프로바이더에 지정하여 멀티 프로필 설정에 활용. `PROXY_KEYS` 형식은 `env.example` 참조.
- **모델 카탈로그 단일 소스** — `MODEL_CATALOG_PATH`를 Codex가 사용하는 동일한 JSON 파일 (`config.toml`의 `model_catalog_json`)로 지정하면 모델 목록이 자동으로 동기화됩니다.

## 부팅 시 자동 시작（Windows）

codex-bridge를 예약 작업으로 등록하여 부팅 시 자동 시작:

```powershell
# 관리자 권한으로 실행
powershell -ExecutionPolicy Bypass -File .\register-startup.ps1
```

`codex-bridge`라는 작업이 생성되며 다음 기능을 제공합니다:
- 부팅 시 자동 시작 (로그인 불필요)
- 충돌 시 자동 재시작 (최대 3회, 1분 간격)
- `.env`에서 설정 자동 로드

**작업 관리:**

| 작업 | 명령 |
|---|---|
| 시작 | `schtasks /Run /TN "codex-bridge"` |
| 중지 | `schtasks /End /TN "codex-bridge"` |
| 상태 | `schtasks /Query /TN "codex-bridge"` |
| 제거 | `powershell -ExecutionPolicy Bypass -File .\unregister-startup.ps1` |

## 문제 해결

| 증상 | 원인 | 해결 방법 |
|---|---|---|
| `EADDRINUSE :4000` | 포트가 이미 사용 중 | `lsof -ti:4000 \| xargs kill` 또는 `.env`에서 `PROXY_PORT` 변경 |
| `401 Unauthorized` | 인증 키 불일치 | `~/.codex/auth.json`의 `OPENAI_API_KEY`가 `.env`의 `PROXY_AUTH_KEY`와 일치하는지 확인 |
| `--env-file: not recognized` | Node.js < 20 | `set -a && source .env && set +a && node proxy.mjs` 사용 |
| 업스트림 타임아웃 | 프로바이더 응답 지연 | `.env`에서 `UPSTREAM_TIMEOUT_MS` 증가 (기본 120,000ms) |
| 모델을 찾을 수 없음 | 모델이 `*_MODELS` 목록에 없음 | `DEEPSEEK_MODELS` / `MIMO_MODELS` / `OPENAI_MODELS`에 추가, 또는 `MODEL_CATALOG_PATH` 사용 |

## 요구 사항

- Node.js 18+
- macOS / Linux / Windows
- 최소 하나의 업스트림 API 키 (DeepSeek, MiMo, OpenAI 또는 커스텀)

## 라이선스

MIT — [LICENSE](./LICENSE) 참조.
