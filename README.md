<h1 align="center">codex-bridge</h1>

<p align="center">
  A zero-dependency local proxy that lets <a href="https://github.com/openai/codex">Codex CLI</a> talk to
  <strong>DeepSeek</strong>, <strong>Xiaomi MiMo</strong>, and <strong>OpenAI</strong> through a single
  <code>base_url</code>.
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white" alt="Node.js 18+"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero Dependencies">
</p>

<p align="center">
  <strong>English</strong> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.es.md">Español</a>
</p>

---

Codex CLI speaks the **OpenAI Responses API**. DeepSeek and MiMo speak **Chat Completions**.
codex-bridge translates between them in both directions — streaming SSE, tool calls, and thinking-mode round-trips — so you can use any supported model inside Codex without patching the client.

## Features

- **Multi-provider routing** — DeepSeek / MiMo / MiniMax / OpenAI / Custom, auto-selected by model name
- **Bi-directional protocol translation** — Responses API ↔ Chat Completions with streaming SSE bridge
- **Per-provider reasoning effort translation** — Codex's `none | minimal | low | medium | high | xhigh` mapped to each upstream's native format
- **Thinking-mode tool-call round-trip** — caches `reasoning_content` and replays it so DeepSeek's thinking mode survives multi-turn tool calls
- **Inbound auth gate** — `PROXY_AUTH_KEY` / `PROXY_KEYS` with optional per-key provider locking
- **Session continuity** — `previous_response_id` works across providers (LRU-bounded store)
- **Built-in `web_fetch` tool** — bypasses sandbox restrictions for URL-heavy conversations
- **Tool-call circuit breaker** — soft warning + hard tool stripping on runaway tool loops
- **Single-file, zero dependencies** — one `proxy.mjs` (~2000 lines), no `npm install`

## Quick Start

### 1. Configure

```bash
git clone https://github.com/wujfeng712-ui/codex-bridge.git
cd codex-bridge
cp env.example .env
```

Edit `.env` — at minimum:

```bash
PROXY_AUTH_KEY=sk-proxy-local-$(openssl rand -hex 24)   # generate one
DEEPSEEK_API_KEY=sk-...                                  # from platform.deepseek.com
```

Or use a custom OpenAI-compatible provider:

```bash
# CUSTOM_BASE_URL=https://your-provider.example.com/v1
# CUSTOM_API_KEY=your-key
# CUSTOM_MODELS=model-a,model-b
# DEFAULT_PROVIDER=custom
```

### 2. Start the proxy

```bash
node --env-file=.env proxy.mjs
```

> Need Node 18–19 or background mode? See [Advanced Usage](#advanced-usage).

### 3. Point Codex CLI at the proxy

Edit `~/.codex/config.toml`:

```toml
model = "deepseek-v4-flash"
model_provider = "local_proxy"

[model_providers.local_proxy]
name = "local_proxy"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
requires_openai_auth = true
```

Set the auth key for Codex:

```bash
# ~/.codex/auth.json
{ "OPENAI_API_KEY": "<same PROXY_AUTH_KEY from .env>" }
```

> **Using [CC Switch](https://github.com/farion1231/cc-switch)?** Skip the manual edit — add a provider in the GUI instead. See [Using with CC Switch](#using-with-cc-switch).

Run `codex` — done.

## Architecture

```
┌─────────────┐    Responses API    ┌──────────────┐
│  Codex CLI  │────────────────────▶│ codex-bridge │
│             │  Authorization:     │    :4000     │
└─────────────┘  Bearer <key>       └──────┬───────┘
                                           │  model-based routing
                   ┌───────────────────────┼────────────────────────┬───────────────────────┐
                   │                       │                        │                       │
                   ▼                       ▼                        ▼                       ▼
          ┌────────────────┐      ┌────────────────┐       ┌──────────────┐       ┌────────────────┐
          │   DeepSeek V4  │      │  Xiaomi MiMo   │       │    OpenAI    │       │    Custom      │
          │ Chat Complet.  │      │ Chat Complet.  │       │  Responses   │       │ Chat Complet.  │
          └────────────────┘      └────────────────┘       └──────────────┘       └────────────────┘
```

## Configuration

All settings via environment variables (see `env.example` for full documentation):

### Auth

| Variable | Default | Description |
|---|---|---|
| `PROXY_AUTH_KEY` | — | Single inbound key (no provider lock) |
| `PROXY_KEYS` | — | Multi-key table: `<key>:<provider>,...` where provider ∈ `deepseek`/`mimo`/`minimax`/`openai`/`custom`/`*` |

Both empty = auth disabled (not recommended).

### Upstream Providers

| Variable | Default | Description |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | DeepSeek upstream key |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | DeepSeek base URL |
| `DEEPSEEK_MODELS` | `deepseek-v4-pro,deepseek-v4-flash` | Models to advertise |
| `MIMO_API_KEY` | — | Xiaomi MiMo upstream key |
| `MIMO_BASE_URL` | `https://token-plan-cn.xiaomimimo.com/v1` | MiMo base URL |
| `MIMO_MODELS` | `mimo-v2.5-pro` | Models to advertise (**must be lowercase**) |
| `OPENAI_API_KEY` | — | OpenAI upstream key (opt-in) |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI base URL |
| `OPENAI_MODELS` | — | Explicit OpenAI model list |
| `OPENAI_MODEL_PREFIXES` | `gpt-,o1,o3,o4,codex-,chatgpt-` | Heuristic routing prefixes |
| `CUSTOM_API_KEY` | — | Custom provider upstream key (opt-in) |
| `CUSTOM_BASE_URL` | — | Custom provider base URL (**required** if `CUSTOM_API_KEY` is set) |
| `CUSTOM_MODELS` | — | Comma-separated model list for custom provider |

### Model Catalog

| Variable | Default | Description |
|---|---|---|
| `MODEL_CATALOG_PATH` | — | Path to a `proxy-models.json` file. Overrides `*_MODELS` vars. Same file Codex reads via `model_catalog_json` |

### Tuning

| Variable | Default | Description |
|---|---|---|
| `PROXY_PORT` | `4000` | Listen port |
| `DEFAULT_PROVIDER` | auto | Fallback when model is unknown (`deepseek` / `mimo` / `openai` / `custom` / `auto`) |
| `LOG_LEVEL` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `ACCESS_LOG` | on | Set `0` to suppress per-request access logs |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Upstream request timeout |
| `STORE_TTL_MS` | `3600000` | Response store entry TTL |
| `STORE_MAX` | `500` | Response store LRU capacity |
| `GITHUB_TOKEN` | — | Optional; falls back to `gh auth token` lazily |

## Routing Rules

Each request is routed by model name, in priority order:

1. **Exact match** — model appears in `DEEPSEEK_MODELS`, `MIMO_MODELS`, `OPENAI_MODELS`, or `CUSTOM_MODELS`
2. **Prefix heuristic** — model starts with an `OPENAI_MODEL_PREFIXES` entry → OpenAI
3. **Name hint** — model contains `deepseek`, `mimo`, or `minimax` → corresponding provider
4. **Fallback** — `DEFAULT_PROVIDER` (including `custom`), then first provider with a configured key

## Reasoning Effort Translation

Codex sends `none | minimal | low | medium | high | xhigh`. Each upstream accepts a different subset:

| Codex effort | DeepSeek | MiMo | OpenAI |
|---|---|---|---|
| `none` | `thinking: {type: "disabled"}` | `thinking: {type: "disabled"}` | field removed |
| `minimal` | `reasoning_effort: "low"` | `reasoning_effort: "low"` | passthrough |
| `low` / `medium` / `high` | passthrough | passthrough | passthrough |
| `xhigh` | `reasoning_effort: "xhigh"` | clamped to `high` | clamped to `high` |

> **Note:** DeepSeek silently ignores `enable_thinking: false`. The proxy uses `thinking: {type: "disabled"}` instead.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | No | Health check |
| `GET` | `/v1/models` | Yes | Merged model list |
| `POST` | `/v1/responses` | Yes | Codex CLI main endpoint (Responses API) |
| `POST` | `/v1/chat/completions` | Yes | Direct Chat Completions passthrough |
| `GET` | `/cop?url=...` | Yes | URL fetch (Jina Reader / native HTTP) |
| `POST` | `/cop` | Yes | URL fetch with custom method/headers/body |

## Smoke Test

```bash
./scripts/smoke.sh                    # uses localhost:4000 by default
./scripts/smoke.sh http://host:4000   # custom target
MODEL=mimo-v2.5-pro ./scripts/smoke.sh  # test a different model
```

Runs 30 checks covering endpoints, input shapes, auth gate, streaming completion, effort translation, tool-call round-trips, and provider locking.

## Using with CC Switch

[CC Switch](https://github.com/farion1231/cc-switch) is a popular desktop app for managing provider profiles across AI CLI tools (Claude Code, Codex, Gemini CLI, etc.). You can use it to switch between codex-bridge and other providers with one click.

### Setup

1. Open CC Switch → **Codex** tab → **Add Provider**
2. Fill in the provider fields:

   | Field | Value |
   |---|---|
   | Name | `codex-bridge` (or any label you prefer) |
   | API Key | Your `PROXY_AUTH_KEY` from `.env` |
   | Base URL | `http://127.0.0.1:4000/v1` |

3. Click **Enable** to activate — CC Switch writes the key to `~/.codex/auth.json` and updates `config.toml` automatically.

### Multi-provider switching

If you have multiple upstream keys (e.g., one for DeepSeek, one for MiMo), use `PROXY_KEYS` in `.env` to create per-provider inbound keys:

```bash
PROXY_KEYS=sk-deepseek-aaa:deepseek,sk-mimo-bbb:mimo,sk-all-ccc:*
```

Then create a separate CC Switch profile for each key — switching profiles swaps which upstream provider codex-bridge routes to.

### CLI alternative

If you prefer the terminal, [cc-switch-cli](https://github.com/SaladDay/cc-switch-cli) provides the same profile switching without a GUI:

```bash
# List profiles
cc-switch list

# Switch to the codex-bridge profile
cc-switch use codex-bridge
```

> **Tip:** After switching profiles, restart your terminal (or run `codex` in a new shell) for the new auth to take effect.

## Advanced Usage

- **Node 18–19 startup** — `--env-file` was added in Node 20. On older versions:
  ```bash
  set -a && source .env && set +a && node proxy.mjs
  ```
- **Background mode**:
  ```bash
  nohup node --env-file=.env proxy.mjs > /tmp/codex-bridge.log 2>&1 &
  ```
- **Multi-key provider locking** — assign each inbound key to a specific provider for multi-profile setups. See `env.example` for the `PROXY_KEYS` format.
- **Model catalog single source of truth** — point `MODEL_CATALOG_PATH` at the same JSON file Codex uses (`model_catalog_json` in `config.toml`) to keep model lists in sync automatically.

## Auto-Start at Boot (Windows)

Register codex-bridge as a scheduled task so it starts automatically when the machine boots:

```powershell
# Run as administrator
powershell -ExecutionPolicy Bypass -File .\register-startup.ps1
```

This creates a task named `codex-bridge` that:
- Starts at boot (no login required)
- Auto-restarts on crash (up to 3 times, 1-minute delay)
- Reads configuration from `.env`

**Manage the task:**

| Action | Command |
|---|---|
| Start | `schtasks /Run /TN "codex-bridge"` |
| Stop | `schtasks /End /TN "codex-bridge"` |
| Status | `schtasks /Query /TN "codex-bridge"` |
| Uninstall | `powershell -ExecutionPolicy Bypass -File .\unregister-startup.ps1` |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `EADDRINUSE :4000` | Port already in use | `lsof -ti:4000 \| xargs kill` or change `PROXY_PORT` in `.env` |
| `401 Unauthorized` | Auth key mismatch | Ensure `OPENAI_API_KEY` in `~/.codex/auth.json` matches `PROXY_AUTH_KEY` in `.env` |
| `--env-file: not recognized` | Node.js < 20 | Use `set -a && source .env && set +a && node proxy.mjs` |
| Upstream timeout | Slow provider response | Increase `UPSTREAM_TIMEOUT_MS` in `.env` (default 120 000 ms) |
| Model not found | Model not in any `*_MODELS` list | Add it to `DEEPSEEK_MODELS` / `MIMO_MODELS` / `OPENAI_MODELS`, or use `MODEL_CATALOG_PATH` |

## Requirements

- Node.js 18+
- macOS / Linux / Windows
- At least one upstream API key (DeepSeek, MiMo, or OpenAI)

## License

MIT — see [LICENSE](./LICENSE).
