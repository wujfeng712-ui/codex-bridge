<h1 align="center">codex-bridge</h1>

<p align="center">
  零依赖本地代理 — 让 <a href="https://github.com/openai/codex">Codex CLI</a> 通过单一
  <code>base_url</code> 访问 <strong>DeepSeek</strong>、<strong>小米 MiMo</strong> 与 <strong>OpenAI</strong>。
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white" alt="Node.js 18+"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero Dependencies">
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <strong>简体中文</strong> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.es.md">Español</a>
</p>

---

Codex CLI 使用 **OpenAI Responses API**，而 DeepSeek 和 MiMo 使用 **Chat Completions**。
codex-bridge 在两者之间双向转换 —— 包含流式 SSE、工具调用与思考模式回合，让你在不修改 Codex 客户端的前提下使用任意支持的模型。

## 特性

- **多供应商路由** —— 根据模型名自动选择 DeepSeek / MiMo / MiniMax / OpenAI / 自定义供应商
- **双向协议转换** —— Responses API ↔ Chat Completions，含流式 SSE 桥接
- **按供应商翻译思考强度** —— 将 Codex 的 `none | minimal | low | medium | high | xhigh` 映射到各上游的原生格式
- **思考模式 + 工具调用回合** —— 缓存并回放 `reasoning_content`，使 DeepSeek 的思考模式跨多轮工具调用保持一致
- **入站鉴权** —— 支持 `PROXY_AUTH_KEY` / `PROXY_KEYS`，可按密钥锁定供应商
- **会话延续** —— `previous_response_id` 跨供应商可用（基于 LRU 上限的存储）
- **内置 `web_fetch` 工具** —— 在 URL 密集场景下绕过沙箱限制
- **工具调用熔断器** —— 软警告 + 硬剥离，防止工具调用死循环
- **单文件零依赖** —— 仅一个 `proxy.mjs`（约 2000 行），无需 `npm install`

## 快速开始

### 1. 配置

```bash
git clone https://github.com/wujfeng712-ui/codex-bridge.git
cd codex-bridge
cp env.example .env
```

编辑 `.env`，至少设置：

```bash
PROXY_AUTH_KEY=sk-proxy-local-$(openssl rand -hex 24)   # 自动生成一个
DEEPSEEK_API_KEY=sk-...                                  # 来自 platform.deepseek.com
```

```bash
# 或使用自定义 OpenAI 兼容供应商：
# CUSTOM_BASE_URL=https://your-provider.example.com/v1
# CUSTOM_API_KEY=your-key
# CUSTOM_MODELS=model-a,model-b
# DEFAULT_PROVIDER=custom
```

### 2. 启动代理

```bash
node --env-file=.env proxy.mjs
```

> 使用 Node 18–19 或后台模式？请参阅 [进阶用法](#进阶用法)。

### 3. 让 Codex CLI 指向代理

编辑 `~/.codex/config.toml`：

```toml
model = "deepseek-v4-flash"
model_provider = "local_proxy"

[model_providers.local_proxy]
name = "local_proxy"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
requires_openai_auth = true
```

设置 Codex 鉴权密钥：

```bash
# ~/.codex/auth.json
{ "OPENAI_API_KEY": "<同 .env 中的 PROXY_AUTH_KEY>" }
```

> **使用 [CC Switch](https://github.com/farion1231/cc-switch)？** 无需手动编辑，直接在 GUI 中添加供应商即可。详见 [配合 CC Switch 使用](#配合-cc-switch-使用)。

运行 `codex` —— 完成。

## 架构

```
┌─────────────┐    Responses API    ┌──────────────┐
│  Codex CLI  │────────────────────▶│ codex-bridge │
│             │  Authorization:     │    :4000     │
└─────────────┘  Bearer <key>       └──────┬───────┘
                                           │  按模型名路由
                   ┌───────────────────────┼────────────────────────┐
                   │                       │                        │
                   ▼                       ▼                        ▼
          ┌────────────────┐      ┌────────────────┐       ┌──────────────┐       ┌────────────────┐
          │   DeepSeek V4  │      │   小米 MiMo    │       │    OpenAI    │       │    自定义      │
          │ Chat Complet.  │      │ Chat Complet.  │       │  Responses   │       │ Chat Complet.  │
          └────────────────┘      └────────────────┘       └──────────────┘       └────────────────┘
```

## 配置

所有配置均通过环境变量（完整说明见 `env.example`）：

### 鉴权

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PROXY_AUTH_KEY` | — | 单一入站密钥（不锁定供应商） |
| `PROXY_KEYS` | — | 多密钥表：`<key>:<provider>,...`，provider ∈ `deepseek` / `mimo` / `minimax` / `openai` / `custom` / `*` |

两者均空 = 关闭鉴权（不推荐）。

### 上游供应商

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | DeepSeek 上游密钥 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | DeepSeek base URL |
| `DEEPSEEK_MODELS` | `deepseek-v4-pro,deepseek-v4-flash` | 对外暴露的模型列表 |
| `MIMO_API_KEY` | — | 小米 MiMo 上游密钥 |
| `MIMO_BASE_URL` | `https://token-plan-cn.xiaomimimo.com/v1` | MiMo base URL |
| `MIMO_MODELS` | `mimo-v2.5-pro` | 对外暴露的模型列表（**必须小写**） |
| `OPENAI_API_KEY` | — | OpenAI 上游密钥（可选） |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI base URL |
| `OPENAI_MODELS` | — | 显式指定的 OpenAI 模型列表 |
| `OPENAI_MODEL_PREFIXES` | `gpt-,o1,o3,o4,codex-,chatgpt-` | 启发式路由前缀 |
| `CUSTOM_API_KEY` | — | 自定义供应商上游密钥（可选） |
| `CUSTOM_BASE_URL` | — | 自定义供应商 base URL（设置 `CUSTOM_API_KEY` 时**必须**填写） |
| `CUSTOM_MODELS` | — | 自定义供应商的模型列表（逗号分隔） |

### 模型清单

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MODEL_CATALOG_PATH` | — | 指向 `proxy-models.json` 的路径，会覆盖上述 `*_MODELS`。即 Codex 通过 `model_catalog_json` 读取的同一文件 |

### 调优

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PROXY_PORT` | `4000` | 监听端口 |
| `DEFAULT_PROVIDER` | auto | 模型未知时的回落供应商（`deepseek` / `mimo` / `minimax` / `openai` / `custom` / `auto`） |
| `LOG_LEVEL` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `ACCESS_LOG` | on | 设为 `0` 可关闭逐请求访问日志 |
| `UPSTREAM_TIMEOUT_MS` | `120000` | 上游请求超时 |
| `STORE_TTL_MS` | `3600000` | 响应存储条目 TTL |
| `STORE_MAX` | `500` | 响应存储 LRU 容量 |
| `GITHUB_TOKEN` | — | 可选；未设置时按需调用 `gh auth token` |

## 路由规则

每个请求按以下优先级根据模型名进行路由：

1. **精确匹配** —— 模型出现在 `DEEPSEEK_MODELS` / `MIMO_MODELS` / `OPENAI_MODELS` / `CUSTOM_MODELS`
2. **前缀启发** —— 以 `OPENAI_MODEL_PREFIXES` 中任一项开头 → OpenAI
3. **名称提示** —— 包含 `deepseek` / `mimo` / `minimax` → 对应供应商
4. **回落** —— `DEFAULT_PROVIDER`（`deepseek` / `mimo` / `minimax` / `openai` / `custom` / `auto`），再退回到第一个已配置密钥的供应商

## 思考强度翻译

Codex 发送 `none | minimal | low | medium | high | xhigh`。各上游接受的子集不同：

| Codex effort | DeepSeek | MiMo | OpenAI |
|---|---|---|---|
| `none` | `thinking: {type: "disabled"}` | `thinking: {type: "disabled"}` | 字段移除 |
| `minimal` | `reasoning_effort: "low"` | `reasoning_effort: "low"` | 透传 |
| `low` / `medium` / `high` | 透传 | 透传 | 透传 |
| `xhigh` | `reasoning_effort: "xhigh"` | 限制为 `high` | 限制为 `high` |

> **注意：** DeepSeek 会静默忽略 `enable_thinking: false`，本代理改用 `thinking: {type: "disabled"}`。

## 端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/health` | 否 | 健康检查 |
| `GET` | `/v1/models` | 是 | 合并后的模型列表 |
| `POST` | `/v1/responses` | 是 | Codex CLI 主端点（Responses API） |
| `POST` | `/v1/chat/completions` | 是 | 直接 Chat Completions 透传 |
| `GET` | `/cop?url=...` | 是 | URL 抓取（Jina Reader / 原生 HTTP） |
| `POST` | `/cop` | 是 | 自定义方法/请求头/请求体的 URL 抓取 |

## 冒烟测试

```bash
./scripts/smoke.sh                    # 默认使用 localhost:4000
./scripts/smoke.sh http://host:4000   # 自定义目标
MODEL=mimo-v2.5-pro ./scripts/smoke.sh  # 测试不同模型
```

执行 30 项检查，覆盖端点、入参形态、鉴权门、流式完成、思考强度翻译、工具调用回合与供应商锁定。

## 配合 CC Switch 使用

[CC Switch](https://github.com/farion1231/cc-switch) 是一款热门桌面应用，可一键管理和切换多种 AI CLI 工具（Claude Code、Codex、Gemini CLI 等）的供应商配置。

### 设置

1. 打开 CC Switch → **Codex** 选项卡 → **添加供应商**
2. 填写供应商信息：

   | 字段 | 值 |
   |---|---|
   | 名称 | `codex-bridge`（或你喜欢的标签） |
   | API Key | `.env` 中的 `PROXY_AUTH_KEY` |
   | Base URL | `http://127.0.0.1:4000/v1` |

3. 点击 **启用** —— CC Switch 会自动写入 `~/.codex/auth.json` 并更新 `config.toml`。

### 多供应商切换

如果你有多个上游密钥（如 DeepSeek 一个、MiMo 一个），可在 `.env` 中使用 `PROXY_KEYS` 创建按供应商隔离的入站密钥：

```bash
PROXY_KEYS=sk-deepseek-aaa:deepseek,sk-mimo-bbb:mimo,sk-all-ccc:*
```

然后在 CC Switch 中为每个密钥创建独立配置 —— 切换配置即切换 codex-bridge 路由的上游供应商。

### CLI 替代方案

如果你更喜欢终端操作，[cc-switch-cli](https://github.com/SaladDay/cc-switch-cli) 提供无 GUI 的配置切换：

```bash
# 列出配置
cc-switch list

# 切换到 codex-bridge 配置
cc-switch use codex-bridge
```

> **提示：** 切换配置后，请重启终端（或在新 shell 中运行 `codex`）使新鉴权生效。

## 进阶用法

- **Node 18–19 启动** —— `--env-file` 在 Node 20 才引入。旧版本请使用：
  ```bash
  set -a && source .env && set +a && node proxy.mjs
  ```
- **后台模式**：
  ```bash
  nohup node --env-file=.env proxy.mjs > /tmp/codex-bridge.log 2>&1 &
  ```
- **多密钥锁定供应商** —— 为每个入站密钥指定固定供应商，便于多配置场景。`PROXY_KEYS` 格式参见 `env.example`。
- **模型清单单一来源** —— 将 `MODEL_CATALOG_PATH` 指向 Codex 使用的同一份 JSON（`config.toml` 中的 `model_catalog_json`），自动保持模型列表同步。

## 开机自启（Windows）

将 codex-bridge 注册为计划任务，开机自动启动：

```powershell
# 以管理员身份运行
powershell -ExecutionPolicy Bypass -File .\register-startup.ps1
```

注册后创建名为 `codex-bridge` 的任务，特性：
- 开机自动启动（无需登录）
- 崩溃后自动重启（最多 3 次，间隔 1 分钟）
- 自动读取 `.env` 配置

**管理任务：**

| 操作 | 命令 |
|---|---|
| 启动 | `schtasks /Run /TN "codex-bridge"` |
| 停止 | `schtasks /End /TN "codex-bridge"` |
| 状态 | `schtasks /Query /TN "codex-bridge"` |
| 卸载 | `powershell -ExecutionPolicy Bypass -File .\unregister-startup.ps1` |

## 常见问题

| 症状 | 原因 | 解决方案 |
|---|---|---|
| `EADDRINUSE :4000` | 端口被占用 | `lsof -ti:4000 \| xargs kill` 或在 `.env` 中更改 `PROXY_PORT` |
| `401 Unauthorized` | 鉴权密钥不匹配 | 确认 `~/.codex/auth.json` 中的 `OPENAI_API_KEY` 与 `.env` 中的 `PROXY_AUTH_KEY` 一致 |
| `--env-file: not recognized` | Node.js 版本 < 20 | 使用 `set -a && source .env && set +a && node proxy.mjs` |
| 上游超时 | 供应商响应慢 | 在 `.env` 中增大 `UPSTREAM_TIMEOUT_MS`（默认 120 000 ms） |
| 模型未找到 | 模型不在 `*_MODELS` 列表中 | 添加到 `DEEPSEEK_MODELS` / `MIMO_MODELS` / `OPENAI_MODELS`，或使用 `MODEL_CATALOG_PATH` |

## 环境要求

- Node.js 18+
- macOS / Linux / Windows
- 至少一个上游 API 密钥（DeepSeek、MiMo 或 OpenAI）

## 许可证

MIT —— 详见 [LICENSE](./LICENSE)。
