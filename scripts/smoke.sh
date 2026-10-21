#!/usr/bin/env bash
# codex-bridge smoke test
# Usage: ./scripts/smoke.sh [base_url]
#   defaults to http://localhost:4000
#
# Verifies:
#   1. /health returns ok
#   2. /v1/models returns at least one model
#   3. /v1/responses accepts the four input shapes Codex CLI / cc-switch may send:
#        a. empty body                              -> 200 (probe short-circuit)
#        b. {model} only, no input                  -> 200 (probe short-circuit)
#        c. {model, input:"string"}                 -> 200 (real call)
#        d. {model, input:[{role,content}], stream:true}  -> 200 (codex_cli_rs shape)
#        e. {model, input:[{type:"message",role,content:[{type:"input_text"}]}]} -> 200
#
# Exits non-zero on any failure.

set -u
set +B  # disable brace expansion so JSON `{...,...}` literals stay intact
BASE="${1:-http://localhost:4000}"
MODEL="${MODEL:-deepseek-v4-pro}"

# Pick up PROXY_AUTH_KEY / PROXY_KEYS from .env if not already in env, so the script
# "just works" after `./scripts/smoke.sh`. Resolve the script's own dir to find the
# .env next to it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
read_env_var() {
  local name="$1"
  if [[ -f "$ENV_FILE" ]]; then
    grep -E "^${name}=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"'"'"
  fi
}

if [[ -z "${PROXY_AUTH_KEY:-}" ]]; then
  PROXY_AUTH_KEY="$(read_env_var PROXY_AUTH_KEY)"
fi
if [[ -z "${PROXY_KEYS:-}" ]]; then
  PROXY_KEYS="$(read_env_var PROXY_KEYS)"
fi

# Pick the key the [1]-[3] tests will use. Prefer PROXY_AUTH_KEY (wildcard, won't
# collide with model). If only PROXY_KEYS is set, find a wildcard entry, else use
# the entry whose provider matches $MODEL's provider (best effort), else the first.
AUTH_KEY=""
if [[ -n "${PROXY_AUTH_KEY:-}" ]]; then
  AUTH_KEY="$PROXY_AUTH_KEY"
elif [[ -n "${PROXY_KEYS:-}" ]]; then
  IFS=',' read -ra _entries <<< "$PROXY_KEYS"
  for e in "${_entries[@]}"; do
    e="${e## }"; e="${e%% }"
    case "$e" in
      *":*") AUTH_KEY="${e%:*}"; break ;;
    esac
  done
  if [[ -z "$AUTH_KEY" ]]; then
    case "$MODEL" in
      deepseek*) want=deepseek ;;
      mimo*)     want=mimo ;;
      MiniMax*|minimax*) want=minimax ;;
      *)         want="" ;;
    esac
    if [[ -n "$want" ]]; then
      for e in "${_entries[@]}"; do
        e="${e## }"; e="${e%% }"
        if [[ "$e" == *":$want" ]]; then AUTH_KEY="${e%:*}"; break; fi
      done
    fi
    if [[ -z "$AUTH_KEY" ]]; then
      AUTH_KEY="${_entries[0]%:*}"
    fi
  fi
fi

AUTH_HEADER=()
if [[ -n "$AUTH_KEY" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer $AUTH_KEY")
fi

PASS=0
FAIL=0
FAIL_NAMES=()

check() {
  local name="$1"
  local want="$2"
  local got="$3"
  if [[ "$got" == "$want" ]]; then
    printf "  PASS  %-40s -> %s\n" "$name" "$got"
    PASS=$((PASS + 1))
  else
    printf "  FAIL  %-40s -> got %s, want %s\n" "$name" "$got" "$want"
    FAIL=$((FAIL + 1))
    FAIL_NAMES+=("$name")
  fi
}

post_status() {
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE$1" \
    -H 'Content-Type: application/json' \
    "${AUTH_HEADER[@]}" \
    -d "$2"
}

post_status_noauth() {
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE$1" \
    -H 'Content-Type: application/json' \
    -d "$2"
}

get_status() {
  curl -sS -o /dev/null -w '%{http_code}' "${AUTH_HEADER[@]}" "$BASE$1"
}

get_status_noauth() {
  curl -sS -o /dev/null -w '%{http_code}' "$BASE$1"
}

echo "codex-bridge smoke @ $BASE (model=$MODEL, auth=$([[ -n "$AUTH_KEY" ]] && echo on || echo off))"
echo

echo "[1] endpoints"
check "GET /health"     "200" "$(get_status /health)"
check "GET /v1/models"  "200" "$(get_status /v1/models)"

echo "[2] /v1/responses input shapes"
check "empty body"                "200" "$(post_status /v1/responses '{}')"
check "model only, no input"      "200" "$(post_status /v1/responses "{\"model\":\"$MODEL\"}")"
check "string input"              "200" "$(post_status /v1/responses "{\"model\":\"$MODEL\",\"input\":\"reply pong\"}")"
check "array {role,content}"      "200" "$(post_status /v1/responses "{\"model\":\"$MODEL\",\"stream\":true,\"input\":[{\"role\":\"user\",\"content\":\"reply pong\"}]}")"
check "array message+input_text"  "200" "$(post_status /v1/responses "{\"model\":\"$MODEL\",\"stream\":true,\"input\":[{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"reply pong\"}]}]}")"

if [[ -n "$AUTH_KEY" ]]; then
  echo "[3] inbound auth gate"
  check "GET /health no auth ok"      "200" "$(get_status_noauth /health)"
  check "GET /v1/models no auth 401"  "401" "$(get_status_noauth /v1/models)"
  check "POST /v1/responses no auth"  "401" "$(post_status_noauth /v1/responses "{\"model\":\"$MODEL\",\"input\":\"x\"}")"
fi

echo "[S] streaming completion (must emit response.completed — guards the bug where"
echo "    req.destroyed=true post-body-read killed every SSE stream after one chunk)"
# Issue a real streaming request and check the SSE actually finishes. Curl will
# exit 0 even for a half-closed stream, so we verify by counting the terminator
# event in the captured body. We use --max-time so a hanging proxy fails fast.
SSE_TMP="$(mktemp -t codex-bridge-sse.XXXXXX)"
curl -sS -N --max-time 30 -X POST "$BASE/v1/responses" \
  -H 'Content-Type: application/json' \
  "${AUTH_HEADER[@]}" \
  -d "{\"model\":\"$MODEL\",\"stream\":true,\"input\":[{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"reply with the single word: pong\"}]}]}" \
  >"$SSE_TMP" 2>/dev/null
SSE_DONE_COUNT="$(grep -c '^event: response.completed' "$SSE_TMP" || true)"
rm -f "$SSE_TMP"
check "stream emits response.completed" "1" "$SSE_DONE_COUNT"

echo "[E] effort translation (smoke — these only verify the proxy doesn't 4xx the request"
echo "    locally; the model side-effect lives in the upstream and isn't asserted here)"
# Codex can send any of: none | minimal | low | medium | high | xhigh.
# The proxy normalises these into per-provider shapes (deepseek vs mimo vs openai).
# We hit /v1/responses with the Codex Responses-API shape so the translator runs.
EFFORT_BODY() {
  local model="$1"; local effort="$2"
  printf '{"model":"%s","input":"ping","reasoning":{"effort":"%s"}}' "$model" "$effort"
}
# Pick a known-enabled deepseek/mimo model from .env if present, else fall back
# to the defaults baked into the proxy.
DS_MODEL="$(read_env_var DEEPSEEK_MODELS | tr ',' '\n' | head -1)"
[[ -z "$DS_MODEL" ]] && DS_MODEL="deepseek-v4-pro"
MI_MODEL="$(read_env_var MIMO_MODELS | tr ',' '\n' | head -1)"
[[ -z "$MI_MODEL" ]] && MI_MODEL="mimo-v2.5-pro"

# DeepSeek path: every Codex effort value should produce a 200 from the proxy.
# (We can't easily peek at the upstream payload from a shell smoke test, but a 200
#  proves the translator didn't blow up and the upstream accepted whatever we sent.)
for eff in none minimal low medium high xhigh; do
  check "deepseek effort=$eff"  "200" "$(post_status /v1/responses "$(EFFORT_BODY "$DS_MODEL" "$eff")")"
done
# MiMo path: same — but `xhigh` must be clamped to `high` by the proxy or MiMo 400s.
for eff in none minimal low medium high xhigh; do
  check "mimo effort=$eff"      "200" "$(post_status /v1/responses "$(EFFORT_BODY "$MI_MODEL" "$eff")")"
done

echo "[T] deepseek tool-call round-trip (regression: thinking-mode + assistant tool_calls"
echo "    without cached reasoning_content used to 400 with 'reasoning_content must be"
echo "    passed back'). Two scenarios: (a) cache hit -> thinking preserved, reasoning_tokens > 0;"
echo "    (b) cache miss with synthetic call_id -> safety-net forces thinking off, just 200."
# (a) Cache HIT: do a real round-1 turn so the proxy captures reasoning_content,
#     then send round-2 with the SAME call_id and verify reasoning_tokens > 0
#     (proves we replayed reasoning + DeepSeek kept thinking on).
TOOL_RT_TMP="$(mktemp -t codex-bridge-rt.XXXXXX)"
curl -sS --max-time 30 -X POST "$BASE/v1/responses" \
  -H 'Content-Type: application/json' \
  "${AUTH_HEADER[@]}" \
  -d "{
    \"model\":\"$DS_MODEL\",
    \"stream\":false,
    \"reasoning\":{\"effort\":\"medium\"},
    \"tools\":[{\"type\":\"function\",\"name\":\"shell\",\"description\":\"r\",\"parameters\":{\"type\":\"object\",\"properties\":{\"cmd\":{\"type\":\"string\"}},\"required\":[\"cmd\"]}}],
    \"input\":[{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"call shell with cmd=ls. only the call.\"}]}]
  }" > "$TOOL_RT_TMP" 2>/dev/null
RT_CALL_ID="$(python3 -c 'import sys,json; d=json.load(open(sys.argv[1])); print(next((o["call_id"] for o in d.get("output",[]) if o.get("type")=="function_call"), ""))' "$TOOL_RT_TMP" 2>/dev/null)"
if [[ -n "$RT_CALL_ID" ]]; then
  RT2_TOKENS="$(curl -sS --max-time 30 -X POST "$BASE/v1/responses" \
    -H 'Content-Type: application/json' \
    "${AUTH_HEADER[@]}" \
    -d "{
      \"model\":\"$DS_MODEL\",\"stream\":false,\"reasoning\":{\"effort\":\"medium\"},
      \"tools\":[{\"type\":\"function\",\"name\":\"shell\",\"description\":\"r\",\"parameters\":{\"type\":\"object\",\"properties\":{\"cmd\":{\"type\":\"string\"}},\"required\":[\"cmd\"]}}],
      \"input\":[
        {\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"call shell with cmd=ls. only the call.\"}]},
        {\"type\":\"function_call\",\"call_id\":\"$RT_CALL_ID\",\"name\":\"shell\",\"arguments\":\"{\\\"cmd\\\":\\\"ls\\\"}\"},
        {\"type\":\"function_call_output\",\"call_id\":\"$RT_CALL_ID\",\"output\":\"a\\nb\\nc\"}
      ]
    }" 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(1 if d.get("usage",{}).get("output_tokens_details",{}).get("reasoning_tokens",0) > 0 else 0)' 2>/dev/null)"
  check "deepseek tool-roundtrip (cache HIT, thinking preserved)" "1" "${RT2_TOKENS:-0}"
else
  check "deepseek tool-roundtrip (cache HIT, thinking preserved)" "1" "skipped-no-call-id"
fi
rm -f "$TOOL_RT_TMP"

# (b) Cache MISS: synthetic unknown call_id, safety-net should force thinking off
#     and the upstream should still 200 (because no reasoning_content needed).
TOOL_RT_MISS_BODY=$(cat <<'JSON'
{
  "model":"deepseek-v4-flash","stream":false,"reasoning":{"summary":"auto"},
  "tools":[{"type":"function","name":"shell","description":"run","parameters":{"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}}],
  "input":[
    {"type":"message","role":"user","content":[{"type":"input_text","text":"run ls"}]},
    {"type":"function_call","call_id":"call_smoke_unknown_xyz","name":"shell","arguments":"{\"cmd\":\"ls\"}"},
    {"type":"function_call_output","call_id":"call_smoke_unknown_xyz","output":"file1\nfile2"}
  ]
}
JSON
)
check "deepseek tool-roundtrip (cache MISS, safety-net)" "200" "$(post_status /v1/responses "$TOOL_RT_MISS_BODY")"

if [[ -n "${PROXY_KEYS:-}" ]]; then
  echo "[4] provider-lock"
  # macOS ships bash 3.2 which has no `declare -A`. Use plain vars instead.
  IFS=',' read -ra _entries <<< "$PROXY_KEYS"
  ds_key=""
  mi_key=""
  mx_key=""
  oa_key=""
  for e in "${_entries[@]}"; do
    e="${e## }"; e="${e%% }"
    [[ "$e" == *":*" ]] && continue
    p="${e##*:}"
    k="${e%:*}"
    case "$p" in
      deepseek) [[ -z "$ds_key" ]] && ds_key="$k" ;;
      mimo)     [[ -z "$mi_key" ]] && mi_key="$k" ;;
      minimax)  [[ -z "$mx_key" ]] && mx_key="$k" ;;
      openai)   [[ -z "$oa_key" ]] && oa_key="$k" ;;
    esac
  done

  post_with_key() {
    local key="$1"
    curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE$2" \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $key" \
      -d "$3"
  }

  if [[ -n "$ds_key" ]]; then
    check "deepseek-key + deepseek model"     "200" "$(post_with_key "$ds_key" /v1/responses '{"model":"deepseek-v4-flash","input":"x"}')"
    if [[ -n "$mi_key" ]] || grep -q '^MIMO_API_KEY=' "$ENV_FILE" 2>/dev/null; then
      check "deepseek-key + mimo model 401"   "401" "$(post_with_key "$ds_key" /v1/responses '{"model":"mimo-v2.5-pro","input":"x"}')"
    fi
    check "deepseek-key, no model -> default" "200" "$(post_with_key "$ds_key" /v1/responses '{"input":"x"}')"
  fi
  if [[ -n "$mi_key" ]]; then
    check "mimo-key + mimo model"             "200" "$(post_with_key "$mi_key" /v1/responses '{"model":"mimo-v2.5-pro","input":"x"}')"
    if [[ -n "$ds_key" ]]; then
      check "mimo-key + deepseek model 401"   "401" "$(post_with_key "$mi_key" /v1/responses '{"model":"deepseek-v4-flash","input":"x"}')"
    fi
  fi
  if [[ -n "$mx_key" ]]; then
    check "minimax-key + minimax model"       "200" "$(post_with_key "$mx_key" /v1/responses '{"model":"MiniMax-M3","input":"x"}')"
    if [[ -n "$ds_key" ]]; then
      check "minimax-key + deepseek model 401" "401" "$(post_with_key "$mx_key" /v1/responses '{"model":"deepseek-v4-flash","input":"x"}')"
    fi
  fi
fi

echo
echo "summary: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  printf '  failures: %s\n' "${FAIL_NAMES[*]}"
  exit 1
fi
