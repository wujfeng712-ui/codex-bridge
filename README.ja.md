<h1 align="center">codex-bridge</h1>

<p align="center">
  ゼロ依存のローカルプロキシ — <a href="https://github.com/openai/codex">Codex CLI</a> から単一の
  <code>base_url</code> で <strong>DeepSeek</strong>、<strong>小米 MiMo</strong>、<strong>OpenAI</strong> に接続。
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white" alt="Node.js 18+"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero Dependencies">
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <strong>日本語</strong> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.es.md">Español</a>
</p>

---

Codex CLI は **OpenAI Responses API** を使用し、DeepSeek と MiMo は **Chat Completions** を使用します。
codex-bridge は両方向のプロトコル変換を行います — ストリーミング SSE、ツール呼び出し、思考モードのラウンドトリップに対応 — Codex クライアントにパッチを当てることなく、あらゆる対応モデルを利用できます。

## 特徴

- **マルチプロバイダールーティング** — DeepSeek / MiMo / MiniMax / OpenAI / カスタム、モデル名で自動選択
- **双方向プロトコル変換** — Responses API ↔ Chat Completions、ストリーミング SSE ブリッジ対応
- **プロバイダー別推論強度変換** — Codex の `none | minimal | low | medium | high | xhigh` を各アップストリームのネイティブ形式にマッピング
- **思考モード + ツール呼び出しラウンドトリップ** — `reasoning_content` をキャッシュして再再生、DeepSeek の思考モードがマルチターンツール呼び出しでも維持
- **インバウンド認証ゲート** — `PROXY_AUTH_KEY` / `PROXY_KEYS`、キーごとのプロバイダーロック可
- **セッション継続** — `previous_response_id` がプロバイダー間で機能（LRU 上限付きストア）
- **内蔵 `web_fetch` ツール** — URL 集中型会話でサンドボックス制限をバイパス
- **ツール呼び出しサーキットブレーカー** — ソフト警告 + ハード剥奪でツール呼び出しの無限ループを防止
- **単ファイル・ゼロ依存** — `proxy.mjs` 1 つ（約 2000 行）、`npm install` 不要

## クイックスタート

### 1. 設定

```bash
git clone https://github.com/wujfeng712-ui/codex-bridge.git
cd codex-bridge
cp env.example .env
```

`.env` を編集 — 最低限：

```bash
PROXY_AUTH_KEY=sk-proxy-local-$(openssl rand -hex 24)   # キーを生成
DEEPSEEK_API_KEY=sk-...                                  # platform.deepseek.com から取得
```

```bash
# またはカスタム OpenAI 互換プロバイダーを使用：
# CUSTOM_BASE_URL=https://your-provider.example.com/v1
# CUSTOM_API_KEY=your-key
# CUSTOM_MODELS=model-a,model-b
# DEFAULT_PROVIDER=custom
```

### 2. プロキシを起動

```bash
node --env-file=.env proxy.mjs
```

> Node 18–19 またはバックグラウンドモードが必要ですか？[高度な使い方](#高度な使い方) を参照。

### 3. Codex CLI をプロキシに向ける

`~/.codex/config.toml` を編集：

```toml
model = "deepseek-v4-flash"
model_provider = "local_proxy"

[model_providers.local_proxy]
name = "local_proxy"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
requires_openai_auth = true
```

Codex の認証キーを設定：

```bash
# ~/.codex/auth.json
{ "OPENAI_API_KEY": "<.env の PROXY_AUTH_KEY と同じ値>" }
```

> **[CC Switch](https://github.com/farion1231/cc-switch) を使用中？** 手動編集は不要 — GUI でプロバイダーを追加してください。[CC Switch との連携](#cc-switch-との連携) を参照。

`codex` を実行 — 完了。

## アーキテクチャ

```
┌─────────────┐    Responses API    ┌──────────────┐
│  Codex CLI  │────────────────────▶│ codex-bridge │
│             │  Authorization:     │    :4000     │
└─────────────┘  Bearer <key>       └──────┬───────┘
                                           │  モデル名ベースルーティング
                   ┌───────────────────────┼────────────────────────┬───────────────────────┐
                   │                       │                        │                       │
                   ▼                       ▼                        ▼                       ▼
          ┌────────────────┐      ┌────────────────┐       ┌──────────────┐       ┌────────────────┐
          │   DeepSeek V4  │      │  Xiaomi MiMo   │       │    OpenAI    │       │    カスタム    │
          │ Chat Complet.  │      │ Chat Complet.  │       │  Responses   │       │ Chat Complet.  │
          └────────────────┘      └────────────────┘       └──────────────┘       └────────────────┘
```

## 設定

すべて環境変数で設定（詳細は `env.example` を参照）：

### 認証

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PROXY_AUTH_KEY` | — | 単一インバウンドキー（プロバイダーロックなし） |
| `PROXY_KEYS` | — | 複数キーテーブル：`<key>:<provider>,...`（provider ∈ `deepseek`/`mimo`/`minimax`/`openai`/`custom`/`*`） |

両方空 = 認証無効（非推奨）。

### アップストリームプロバイダー

| 変数 | デフォルト | 説明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | DeepSeek アップストリームキー |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | DeepSeek ベース URL |
| `DEEPSEEK_MODELS` | `deepseek-v4-pro,deepseek-v4-flash` | 公開するモデルリスト |
| `MIMO_API_KEY` | — | Xiaomi MiMo アップストリームキー |
| `MIMO_BASE_URL` | `https://token-plan-cn.xiaomimimo.com/v1` | MiMo ベース URL |
| `MIMO_MODELS` | `mimo-v2.5-pro` | 公開するモデルリスト（**小文字必須**） |
| `OPENAI_API_KEY` | — | OpenAI アップストリームキー（オプション） |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI ベース URL |
| `OPENAI_MODELS` | — | 明示的な OpenAI モデルリスト |
| `OPENAI_MODEL_PREFIXES` | `gpt-,o1,o3,o4,codex-,chatgpt-` | ヒューリスティックルーティングプレフィックス |
| `CUSTOM_API_KEY` | — | カスタムプロバイダーのアップストリームキー（オプション） |
| `CUSTOM_BASE_URL` | — | カスタムプロバイダーのベース URL（`CUSTOM_API_KEY` 設定時は**必須**） |
| `CUSTOM_MODELS` | — | カスタムプロバイダーのモデルリスト（カンマ区切り） |

### モデルカタログ

| 変数 | デフォルト | 説明 |
|---|---|---|
| `MODEL_CATALOG_PATH` | — | `proxy-models.json` ファイルへのパス。上記 `*_MODELS` を上書き。Codex が `model_catalog_json` で読み取るのと同じファイル |

### チューニング

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PROXY_PORT` | `4000` | リスンポート |
| `DEFAULT_PROVIDER` | auto | モデル不明時のフォールバックプロバイダー（`deepseek` / `mimo` / `openai` / `custom` / `auto`） |
| `LOG_LEVEL` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `ACCESS_LOG` | on | `0` に設定するとリクエスト単位のアクセスログを抑制 |
| `UPSTREAM_TIMEOUT_MS` | `120000` | アップストリームリクエストタイムアウト |
| `STORE_TTL_MS` | `3600000` | レスポンスストアエントリの TTL |
| `STORE_MAX` | `500` | レスポンスストアの LRU 容量 |
| `GITHUB_TOKEN` | — | オプション；未設定時は `gh auth token` を遅延呼び出し |

## ルーティングルール

各リクエストはモデル名により、以下の優先順位でルーティングされます：

1. **完全一致** — モデルが `DEEPSEEK_MODELS`、`MIMO_MODELS`、`OPENAI_MODELS`、`CUSTOM_MODELS` のいずれかに含まれる
2. **プレフィックスヒューリスティック** — モデルが `OPENAI_MODEL_PREFIXES` のいずれかで始まる → OpenAI
3. **名前ヒント** — モデル名に `deepseek`、`mimo`、または `minimax` を含む → 対応プロバイダー
4. **フォールバック** — `DEFAULT_PROVIDER`（`custom` を含む）、次に設定済みキーのある最初のプロバイダー

## 推論強度変換

Codex は `none | minimal | low | medium | high | xhigh` を送信します。各アップストリームが受け入れるサブセットは異なります：

| Codex effort | DeepSeek | MiMo | OpenAI |
|---|---|---|---|
| `none` | `thinking: {type: "disabled"}` | `thinking: {type: "disabled"}` | フィールド削除 |
| `minimal` | `reasoning_effort: "low"` | `reasoning_effort: "low"` | パススルー |
| `low` / `medium` / `high` | パススルー | パススルー | パススルー |
| `xhigh` | `reasoning_effort: "xhigh"` | `high` にクランプ | `high` にクランプ |

> **注意：** DeepSeek は `enable_thinking: false` を黙って無視します。本プロキシは代わりに `thinking: {type: "disabled"}` を使用します。

## エンドポイント

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| `GET` | `/health` | 不要 | ヘルスチェック |
| `GET` | `/v1/models` | 必要 | 統合モデルリスト |
| `POST` | `/v1/responses` | 必要 | Codex CLI メインエンドポイント（Responses API） |
| `POST` | `/v1/chat/completions` | 必要 | 直接 Chat Completions パススルー |
| `GET` | `/cop?url=...` | 必要 | URL フェッチ（Jina Reader / ネイティブ HTTP） |
| `POST` | `/cop` | 必要 | カスタムメソッド/ヘッダー/ボディによる URL フェッチ |

## スモークテスト

```bash
./scripts/smoke.sh                    # デフォルトで localhost:4000 を使用
./scripts/smoke.sh http://host:4000   # カスタムターゲット
MODEL=mimo-v2.5-pro ./scripts/smoke.sh  # 別モデルでテスト
```

エンドポイント、入力形状、認証ゲート、ストリーミング完了、推論強度変換、ツール呼び出しラウンドトリップ、プロバイダーロックをカバーする 30 項目のチェックを実行。

## CC Switch との連携

[CC Switch](https://github.com/farion1231/cc-switch) は、複数の AI CLI ツール（Claude Code、Codex、Gemini CLI など）のプロバイダー設定をワンクリックで管理・切り替えできる人気のデスクトップアプリです。

### セットアップ

1. CC Switch を開く → **Codex** タブ → **プロバイダーを追加**
2. プロバイダー情報を入力：

   | フィールド | 値 |
   |---|---|
   | 名前 | `codex-bridge`（またはお好みのラベル） |
   | API Key | `.env` の `PROXY_AUTH_KEY` |
   | Base URL | `http://127.0.0.1:4000/v1` |

3. **有効化** をクリック — CC Switch が `~/.codex/auth.json` に書き込み、`config.toml` を自動更新。

### マルチプロバイダー切り替え

複数のアップストリームキーがある場合（例：DeepSeek 用と MiMo 用）、`.env` の `PROXY_KEYS` でプロバイダー別のインバウンドキーを作成：

```bash
PROXY_KEYS=sk-deepseek-aaa:deepseek,sk-mimo-bbb:mimo,sk-all-ccc:*
```

CC Switch で各キーに個別のプロファイルを作成 — プロファイルを切り替えると、codex-bridge がルーティングするアップストリームプロバイダーが切り替わります。

### CLI 代替手段

ターミナルを好む場合、[cc-switch-cli](https://github.com/SaladDay/cc-switch-cli) が GUI なしのプロファイル切り替えを提供：

```bash
# プロファイル一覧
cc-switch list

# codex-bridge プロファイルに切り替え
cc-switch use codex-bridge
```

> **ヒント：** プロファイル切り替え後、新しい認証を有効にするためにターミナルを再起動（または新しいシェルで `codex` を実行）してください。

## 高度な使い方

- **Node 18–19 での起動** — `--env-file` は Node 20 で追加されました。旧バージョンでは：
  ```bash
  set -a && source .env && set +a && node proxy.mjs
  ```
- **バックグラウンドモード**：
  ```bash
  nohup node --env-file=.env proxy.mjs > /tmp/codex-bridge.log 2>&1 &
  ```
- **マルチキープロバイダーロック** — 各インバウンドキーに特定プロバイダーを割り当て、マルチプロファイル設定に対応。`PROXY_KEYS` の形式は `env.example` を参照。
- **モデルカタログの単一ソース** — `MODEL_CATALOG_PATH` を Codex が使用する同じ JSON ファイル（`config.toml` の `model_catalog_json`）に向け、モデルリストを自動同期。

## 自動起動（Windows）

codex-bridge をスケジュールタスクとして登録し、マシン起動時に自動開始：

```powershell
# 管理者として実行
powershell -ExecutionPolicy Bypass -File .\register-startup.ps1
```

`codex-bridge` という名前のタスクが作成され、以下の機能を持ちます：
- 起動時に自動開始（ログイン不要）
- クラッシュ時の自動再起動（最大3回、1分間隔）
- `.env` から設定を自動読み込み

**タスク管理：**

| 操作 | コマンド |
|---|---|
| 開始 | `schtasks /Run /TN "codex-bridge"` |
| 停止 | `schtasks /End /TN "codex-bridge"` |
| 状態 | `schtasks /Query /TN "codex-bridge"` |
| 削除 | `powershell -ExecutionPolicy Bypass -File .\unregister-startup.ps1` |

## トラブルシューティング

| 症状 | 原因 | 解決策 |
|---|---|---|
| `EADDRINUSE :4000` | ポートが既に使用中 | `lsof -ti:4000 \| xargs kill` または `.env` で `PROXY_PORT` を変更 |
| `401 Unauthorized` | 認証キーの不一致 | `~/.codex/auth.json` の `OPENAI_API_KEY` が `.env` の `PROXY_AUTH_KEY` と一致するか確認 |
| `--env-file: not recognized` | Node.js < 20 | `set -a && source .env && set +a && node proxy.mjs` を使用 |
| アップストリームタイムアウト | プロバイダーの応答が遅い | `.env` で `UPSTREAM_TIMEOUT_MS` を増加（デフォルト 120 000 ms） |
| モデルが見つからない | モデルが `*_MODELS` リストにない | `DEEPSEEK_MODELS` / `MIMO_MODELS` / `OPENAI_MODELS` に追加、または `MODEL_CATALOG_PATH` を使用 |

## 動作要件

- Node.js 18+
- macOS / Linux / Windows
- アップストリーム API キーが少なくとも 1 つ必要（DeepSeek、MiMo、または OpenAI）

## ライセンス

MIT — 詳細は [LICENSE](./LICENSE) を参照。
