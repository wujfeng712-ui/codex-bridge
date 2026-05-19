import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { execSync } from "node:child_process";

process.on("uncaughtException", (err) => {
  log.error("[proxy] uncaught exception:", err.message);
});
process.on("unhandledRejection", (err) => {
  log.error("[proxy] unhandled rejection:", err.message || err);
});

const PORT = process.env.PROXY_PORT || 4000;

// === Logging ===
//
// LOG_LEVEL = silent | error | warn | info (default) | debug
//   silent: nothing
//   error : only console.error wrappers
//   warn  : + warnings
//   info  : + business + access logs (default)
//   debug : + verbose internal traces
// ACCESS_LOG=0 separately suppresses just the per-request access lines.
const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const LOG_LEVEL = LOG_LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LOG_LEVELS.info;
const ACCESS_LOG_ON = process.env.ACCESS_LOG !== "0" && LOG_LEVEL >= LOG_LEVELS.info;
const log = {
  error: (...a) => { if (LOG_LEVEL >= LOG_LEVELS.error) console.error(...a); },
  warn:  (...a) => { if (LOG_LEVEL >= LOG_LEVELS.warn)  console.warn(...a); },
  info:  (...a) => { if (LOG_LEVEL >= LOG_LEVELS.info)  console.log(...a); },
  debug: (...a) => { if (LOG_LEVEL >= LOG_LEVELS.debug) console.log(...a); },
  access: (...a) => { if (ACCESS_LOG_ON) console.log(...a); },
};

// === Inbound auth ===
//
// Two env vars, both optional:
//
//   PROXY_AUTH_KEY=sk-xxx                       (legacy, single key, no provider lock)
//   PROXY_KEYS=sk-aaa:deepseek,sk-bbb:mimo,sk-ccc:*   (table, optional provider lock)
//
// Each key in the table either:
//   - locks the request to one provider ("deepseek" / "mimo" / "openai") — body.model
//     must resolve to that provider, otherwise 401. If body.model is empty, the
//     provider's default model is used.
//   - is a wildcard ("*") — model field decides routing, same as legacy behaviour.
//
// PROXY_AUTH_KEY (if set) is appended as a wildcard entry, so existing single-key
// setups keep working untouched.
//
// If both env vars are empty, inbound auth is DISABLED — anyone on localhost can
// hit the proxy. /health is always exempt regardless.

const PROXY_AUTH_KEY = (process.env.PROXY_AUTH_KEY || "").trim();
const PROXY_KEYS_RAW = (process.env.PROXY_KEYS || "").trim();

// Map<key, provider | "*">
const PROXY_KEY_TABLE = new Map();
const VALID_LOCK_PROVIDERS = new Set(["deepseek", "mimo", "openai", "*"]);

function loadProxyKeyTable() {
  for (const entry of parseCsv(PROXY_KEYS_RAW)) {
    const idx = entry.lastIndexOf(":");
    if (idx === -1) {
      log.warn(`[proxy] PROXY_KEYS entry missing ':<provider>': "${entry}" — ignored`);
      continue;
    }
    const key = entry.slice(0, idx).trim();
    const provider = entry.slice(idx + 1).trim().toLowerCase();
    if (!key) {
      log.warn(`[proxy] PROXY_KEYS entry has empty key — ignored`);
      continue;
    }
    if (!VALID_LOCK_PROVIDERS.has(provider)) {
      log.warn(`[proxy] PROXY_KEYS entry has unknown provider "${provider}" (allowed: deepseek, mimo, openai, *) — ignored`);
      continue;
    }
    if (PROXY_KEY_TABLE.has(key)) {
      log.warn(`[proxy] PROXY_KEYS entry duplicates key "${key.slice(0, 12)}…" — last wins`);
    }
    PROXY_KEY_TABLE.set(key, provider);
  }
  if (PROXY_AUTH_KEY) {
    if (!PROXY_KEY_TABLE.has(PROXY_AUTH_KEY)) PROXY_KEY_TABLE.set(PROXY_AUTH_KEY, "*");
  }
}
loadProxyKeyTable();

const PROXY_AUTH_ENABLED = PROXY_KEY_TABLE.size > 0;

const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_MODELS = parseCsv(process.env.DEEPSEEK_MODELS || "deepseek-v4-pro,deepseek-v4-flash");

const MIMO_BASE = process.env.MIMO_BASE_URL || "https://token-plan-cn.xiaomimimo.com/v1";
const MIMO_KEY = process.env.MIMO_API_KEY || "";
const MIMO_MODELS = parseCsv(process.env.MIMO_MODELS || "mimo-v2.5-pro");

const OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
// Default empty — OpenAI is opt-in, set OPENAI_MODELS or OPENAI_API_KEY explicitly to enable.
const OPENAI_MODELS = parseCsv(process.env.OPENAI_MODELS || "");
const OPENAI_MODEL_PREFIXES = parseCsv(process.env.OPENAI_MODEL_PREFIXES || "gpt-,o1,o3,o4,codex-,chatgpt-");

const DEFAULT_PROVIDER = (process.env.DEFAULT_PROVIDER || "").trim().toLowerCase();
const TEST_MODE = process.env.CODEX_BRIDGE_TEST === "1";

// GitHub token is fetched lazily on first github.com web_fetch call so we don't
// pay the gh-CLI startup cost during proxy boot. Sentinel "unresolved" means
// "haven't checked yet"; "" means "checked, none available".
let _githubToken = process.env.GITHUB_TOKEN || null; // null = not yet resolved
function getGithubToken() {
  if (_githubToken !== null) return _githubToken;
  try { _githubToken = execSync("gh auth token", { encoding: "utf-8", timeout: 3000 }).trim(); }
  catch { _githubToken = ""; }
  return _githubToken;
}

if (!TEST_MODE && !DEEPSEEK_KEY && !OPENAI_KEY && !MIMO_KEY) {
  console.error("At least one upstream provider key is required: set DEEPSEEK_API_KEY, MIMO_API_KEY, and/or OPENAI_API_KEY");
  process.exit(1);
}

// Optional: read MODEL_CATALOG_PATH (the same proxy-models.json Codex uses) so the
// proxy and Codex agree on which models exist. If a model in the catalog has an
// explicit `provider` field, that wins. Otherwise we infer by name (deepseek-* /
// mimo-* / gpt-*). When the file is absent or unreadable we fall back to the
// env-var lists (DEEPSEEK_MODELS, MIMO_MODELS, OPENAI_MODELS) — i.e. backwards
// compatible with the original setup.
const MODEL_CATALOG_PATH = (process.env.MODEL_CATALOG_PATH || "").trim();
function loadCatalogModels(path) {
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
    const out = { deepseek: [], mimo: [], openai: [] };
    for (const m of raw.models || []) {
      if (!m?.slug) continue;
      let p = (m.provider || "").toLowerCase();
      if (!p) {
        const s = m.slug.toLowerCase();
        if (s.startsWith("deepseek")) p = "deepseek";
        else if (s.startsWith("mimo") || s.startsWith("xiaomi")) p = "mimo";
        else if (s.startsWith("gpt-") || s.startsWith("o1") || s.startsWith("o3") || s.startsWith("o4") || s.startsWith("codex-") || s.startsWith("chatgpt-")) p = "openai";
      }
      if (out[p]) out[p].push(m.slug);
    }
    console.log(`[codex-bridge] model_catalog: loaded ${path} (deepseek=${out.deepseek.length}, mimo=${out.mimo.length}, openai=${out.openai.length})`);
    return out;
  } catch (err) {
    console.warn(`[codex-bridge] model_catalog: ${path} unreadable (${err.message}), falling back to env lists`);
    return null;
  }
}
const CATALOG = MODEL_CATALOG_PATH ? loadCatalogModels(MODEL_CATALOG_PATH) : null;
if (CATALOG) {
  if (CATALOG.deepseek.length) DEEPSEEK_MODELS.splice(0, DEEPSEEK_MODELS.length, ...CATALOG.deepseek);
  if (CATALOG.mimo.length) MIMO_MODELS.splice(0, MIMO_MODELS.length, ...CATALOG.mimo);
  if (CATALOG.openai.length) OPENAI_MODELS.splice(0, OPENAI_MODELS.length, ...CATALOG.openai);
}

// OpenAI-compatible Chat Completions upstreams that share the DeepSeek adapter pipeline
// (Responses-API ⇄ Chat-Completions translation, web_fetch injection, streaming bridge, etc.).
// Add new ones (Kimi, Zhipu, ...) by appending another entry — no other code changes needed.
const OAI_COMPAT_PROVIDERS = {
  deepseek: { base: DEEPSEEK_BASE, key: DEEPSEEK_KEY, models: DEEPSEEK_MODELS, defaultModel: DEEPSEEK_MODELS[0] || "deepseek-v4-pro", envKey: "DEEPSEEK_API_KEY" },
  mimo:     { base: MIMO_BASE,     key: MIMO_KEY,     models: MIMO_MODELS,     defaultModel: MIMO_MODELS[0]     || "mimo-v2.5-pro",   envKey: "MIMO_API_KEY"     },
};

const enabledProviders = new Set();
for (const [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
  if (cfg.key) enabledProviders.add(name);
}
if (OPENAI_KEY) enabledProviders.add("openai");

const providerModels = {
  ...Object.fromEntries(Object.entries(OAI_COMPAT_PROVIDERS).map(([n, c]) => [n, c.models])),
  openai: OPENAI_MODELS,
};

const explicitModelProvider = new Map();
for (const [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
  for (const model of cfg.models) explicitModelProvider.set(normalizeModelId(model), name);
}
for (const model of OPENAI_MODELS) explicitModelProvider.set(normalizeModelId(model), "openai");

const modelCatalog = [
  ...Object.entries(OAI_COMPAT_PROVIDERS).flatMap(([name, cfg]) => cfg.models.map((id) => ({ id, object: "model", owned_by: name }))),
  ...OPENAI_MODELS.map((id) => ({ id, object: "model", owned_by: "openai" })),
];

// --- Response store for previous_response_id bridging ---

const responseStore = new Map();
const STORE_TTL = Number(process.env.STORE_TTL_MS) || 60 * 60 * 1000; // 1 hour
const STORE_MAX = Number(process.env.STORE_MAX) || 500;
const MAX_CONSECUTIVE_TOOL_CALLS = Number(process.env.MAX_CONSECUTIVE_TOOL_CALLS) || 20; // circuit breaker threshold
const UPSTREAM_TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT_MS) || 120000; // 2 min, applies to upstream chat/completions/responses calls

// --- Proxy-side web_fetch tool (bypasses sandbox restrictions) ---

const WEB_FETCH_TOOL = {
  type: "function",
  function: {
    name: "web_fetch",
    description: "Fetch content from a URL over HTTP/HTTPS. Use this when you need to retrieve content from a web URL. Returns HTTP status and response body, with HTML pages converted to clean markdown. Supports all HTTP methods.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch (http:// or https://)" },
        method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], description: "HTTP method (default: GET)" },
        headers: { type: "object", description: "Optional HTTP headers as key-value pairs" },
        body: { type: "string", description: "Request body for POST/PUT/PATCH requests" },
      },
      required: ["url"],
    },
  },
};

// --- Jina Reader integration for clean markdown fetches ---

const JINA_BASE = (process.env.JINA_BASE || "https://r.jina.ai").replace(/\/+$/, "");
const JINA_FETCH_TIMEOUT = Number(process.env.JINA_FETCH_TIMEOUT_MS) || 20000;
const JINA_MAX_BODY = Number(process.env.JINA_MAX_BODY) || 80000;

async function jinaRead(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JINA_FETCH_TIMEOUT);
  try {
    const res = await fetch(`${JINA_BASE}/${url}`, {
      signal: controller.signal,
      headers: {
        "Accept": "text/plain",
        "X-Return-Format": "markdown",
        "User-Agent": "Mozilla/5.0 (compatible; CodexProxy/1.0)",
      },
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return `Jina error: ${res.status} ${res.statusText}\n${text}`.slice(0, JINA_MAX_BODY);
    }
    let text = await res.text();
    if (text.length > JINA_MAX_BODY) {
      text = text.slice(0, JINA_MAX_BODY) + `\n...[content truncated, ${text.length - JINA_MAX_BODY} chars omitted]`;
    }
    return text;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") return "Jina fetch error: request timed out (20s)";
    return `Jina fetch error: ${err.message}`;
  }
}

const MAX_FETCH_LOOPS = Number(process.env.MAX_FETCH_LOOPS) || 5;
const FETCH_TIMEOUT = Number(process.env.FETCH_TIMEOUT_MS) || 15000;
const FETCH_MAX_BODY = Number(process.env.FETCH_MAX_BODY) || 50000;

async function rawFetch(url, method = "GET", headers = {}, reqBody = null) {
  if (!headers["User-Agent"]) headers["User-Agent"] = "Mozilla/5.0 (compatible; CodexProxy/1.0)";
  if (/api\.github\.com/.test(url) && !headers["Authorization"] && !headers["authorization"]) {
    const tok = getGithubToken();
    if (tok) headers["Authorization"] = `Bearer ${tok}`;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  const fetchOpts = { method, headers, signal: controller.signal, redirect: "follow" };
  // executeWebFetch passes object bodies straight from JSON tool args; coerce to string
  // here so fetch() doesn't get something like "[object Object]" or throw on a Map.
  if (reqBody && /^(POST|PUT|PATCH)$/i.test(method)) {
    if (typeof reqBody === "string" || reqBody instanceof Uint8Array || reqBody instanceof ArrayBuffer) {
      fetchOpts.body = reqBody;
    } else {
      fetchOpts.body = JSON.stringify(reqBody);
      if (!headers["Content-Type"] && !headers["content-type"]) {
        headers["Content-Type"] = "application/json";
      }
    }
  }
  const response = await fetch(url, fetchOpts);
  clearTimeout(timeout);
  const ct = response.headers.get("content-type") || "";
  const status = `HTTP ${response.status} ${response.statusText}`;
  if (/^(HEAD|OPTIONS)$/i.test(method)) {
    const hdrs = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    return `${status}\n${hdrs}`;
  }
  if (/image|audio|video|octet-stream/.test(ct)) {
    return `${status}\nContent-Type: ${ct}\n(binary content, not shown)`;
  }
  let text = await response.text();
  if (text.length > FETCH_MAX_BODY) {
    text = text.slice(0, FETCH_MAX_BODY) + `\n...[truncated, ${text.length - FETCH_MAX_BODY} chars omitted]`;
  }
  return `${status}\n\n${text}`;
}

async function executeWebFetch(argsStr) {
  try {
    const args = typeof argsStr === "string" ? JSON.parse(argsStr) : argsStr;
    const { url, method = "GET", headers = {}, body: reqBody } = args;
    if (!url) return "Error: no URL provided";
    if (method === "GET") return await jinaRead(url);
    return await rawFetch(url, method, headers, reqBody);
  } catch (err) {
    if (err.name === "AbortError") return "Fetch error: request timed out";
    return `Fetch error: ${err.message}`;
  }
}

function parseCsv(value) {
  // Case-insensitive dedup: keep the first-seen casing of each entry.
  const seen = new Set();
  const out = [];
  for (const raw of String(value || "").split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const k = trimmed.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(trimmed);
  }
  return out;
}

function normalizeModelId(model) {
  return String(model || "").trim().toLowerCase();
}

function contentHasUrl(content) {
  if (typeof content === "string") return /https?:\/\//.test(content);
  if (Array.isArray(content)) {
    return content.some((part) => {
      if (typeof part === "string") return /https?:\/\//.test(part);
      if (part && typeof part.text === "string") return /https?:\/\//.test(part.text);
      if (part && typeof part.url === "string") return /https?:\/\//.test(part.url);
      if (part && typeof part.image_url === "string") return /https?:\/\//.test(part.image_url);
      if (part?.image_url?.url && typeof part.image_url.url === "string") return /https?:\/\//.test(part.image_url.url);
      return false;
    });
  }
  return false;
}

function conversationHasUrls(messages) {
  return messages.some((message) => contentHasUrl(message?.content));
}

function ensureWebFetchTool(tools) {
  const list = Array.isArray(tools) ? [...tools] : [];
  const alreadyPresent = list.some((tool) => {
    if (tool?.type !== "function") return false;
    return tool?.function?.name === WEB_FETCH_TOOL.function.name || tool?.name === WEB_FETCH_TOOL.function.name;
  });
  if (!alreadyPresent) list.push(WEB_FETCH_TOOL);
  return list;
}

function ensureWebFetchHint(messages) {
  const hint =
    "[System: You have a `web_fetch` tool available for making HTTP requests. Use it instead of curl, wget, or other shell-based HTTP tools. Call web_fetch with {\"url\": \"...\"} to fetch any URL. It supports GET, HEAD, POST, PUT, DELETE, PATCH, and OPTIONS methods.]";
  const alreadyPresent = messages.some((message) => message?.role === "user" && message?.content === hint);
  if (alreadyPresent) return messages;
  return [...messages, { role: "user", content: hint }];
}

function getFallbackProvider() {
  if (DEFAULT_PROVIDER && enabledProviders.has(DEFAULT_PROVIDER)) return DEFAULT_PROVIDER;
  if (enabledProviders.has("openai")) return "openai";
  for (const name of Object.keys(OAI_COMPAT_PROVIDERS)) {
    if (enabledProviders.has(name)) return name;
  }
  throw new Error("No providers are enabled");
}

// Heuristic name-based routing for OAI-compatible providers when the explicit map misses.
// Order matters: longer/more-specific tokens first so e.g. "deepseek-mimo" wouldn't
// accidentally fall through to MiMo. Keep this list short and add entries when needed.
const OAI_COMPAT_NAME_HINTS = [
  { provider: "deepseek", tokens: ["deepseek"] },
  { provider: "mimo",     tokens: ["mimo", "xiaomi"] },
];

function resolveProviderForModel(model) {
  const normalized = normalizeModelId(model);
  if (normalized) {
    const explicit = explicitModelProvider.get(normalized);
    if (explicit && enabledProviders.has(explicit)) return explicit;
    for (const { provider, tokens } of OAI_COMPAT_NAME_HINTS) {
      if (enabledProviders.has(provider) && tokens.some((t) => normalized.includes(t))) return provider;
    }
    if (enabledProviders.has("openai")) {
      const looksOpenAI = OPENAI_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
      if (looksOpenAI) return "openai";
    }
  }
  return getFallbackProvider();
}

// Read with LRU bookkeeping: refreshes insertion order so frequently-used roots
// don't get evicted by the eviction loop in storeResponse.
function touchResponse(id) {
  if (!id) return undefined;
  const entry = responseStore.get(id);
  if (!entry) return undefined;
  // Re-insert to move it to the most-recently-used end of the Map.
  responseStore.delete(id);
  responseStore.set(id, entry);
  return entry;
}

function buildReasoningIndex(output, reasoningContent) {
  const byCallId = new Map();
  const byItemId = new Map();
  if (!reasoningContent) return { byCallId, byItemId };
  for (const out of output || []) {
    if (out?.type !== "function_call") continue;
    if (out.call_id) byCallId.set(out.call_id, reasoningContent);
    if (out.id) byItemId.set(out.id, reasoningContent);
  }
  return { byCallId, byItemId };
}

function getResponseChainEntries(previousResponseId) {
  const chain = [];
  let currentId = previousResponseId;
  const visited = new Set();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const stored = touchResponse(currentId);
    if (!stored) {
      log.warn(`[proxy] previous_response_id ${currentId} not found in store`);
      break;
    }
    chain.unshift({ id: currentId, stored });
    currentId = stored.previousResponseId;
  }

  return chain;
}

function storeResponse(id, data) {
  if (!id) return;

  if (responseStore.size >= STORE_MAX) {
    const now = Date.now();
    for (const [key, val] of responseStore) {
      if (now - val.storedAt > STORE_TTL) responseStore.delete(key);
    }
    if (responseStore.size >= STORE_MAX) {
      // Insertion order = LRU order because every read goes through touchResponse.
      const oldest = responseStore.keys().next().value;
      responseStore.delete(oldest);
    }
  }

  const isToolCallOnly = Array.isArray(data.output) &&
    data.output.length > 0 &&
    data.output.every((o) => o.type === "function_call");

  let consecutiveToolCalls = 0;
  if (data.previousResponseId) {
    const prev = touchResponse(data.previousResponseId);
    if (prev?.breakerFired) {
      // Hard breaker already fired up-chain — counter has been reset; don't propagate.
      consecutiveToolCalls = 0;
    } else if (isToolCallOnly) {
      consecutiveToolCalls = (prev?.consecutiveToolCalls || 0) + 1;
    }
  }

  const reasoningIndex = buildReasoningIndex(data.output, data.reasoningContent);
  responseStore.set(id, { ...data, ...reasoningIndex, storedAt: Date.now(), consecutiveToolCalls });
  log.info(
    `[proxy] stored response ${id} (provider=${data.provider || "unknown"}, store size: ${responseStore.size}${consecutiveToolCalls > 0 ? `, consecutive_tc: ${consecutiveToolCalls}` : ""})`
  );
}

function resolveResponseChain(previousResponseId) {
  const items = [];
  for (const { stored } of getResponseChainEntries(previousResponseId)) {
    if (Array.isArray(stored.input)) items.push(...stored.input);
    if (Array.isArray(stored.output)) items.push(...stored.output);
  }
  return items;
}

function normalizeInputToArray(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  }
  return [];
}

function maybeResolvePreviousResponseChain(body, targetProvider) {
  if (!body.previous_response_id) return;

  const originalPreviousResponseId = body.previous_response_id;
  const previous = responseStore.get(body.previous_response_id);
  if (!previous) {
    if (targetProvider === "deepseek") {
      log.warn(`[proxy] previous_response_id ${body.previous_response_id} missing; DeepSeek request will continue without restored history`);
    }
    return;
  }

  const needsLocalResolution = targetProvider === "deepseek" || previous.provider !== targetProvider;
  if (!needsLocalResolution) return;

  const chainItems = resolveResponseChain(body.previous_response_id);
  if (chainItems.length === 0) return;

  const currentInput = normalizeInputToArray(body.input);
  body.input = [...chainItems, ...currentInput];
  body._resolved_previous_response_id = originalPreviousResponseId;
  delete body.previous_response_id;
  log.info(`[proxy] locally resolved previous_response_id across provider boundary -> ${targetProvider} (${chainItems.length} items prepended)`);
}

// --- Shared message-list normalisation ---
//
// Both the Responses-API translator and the Chat-Completions handler need to:
//   1. Re-order tool messages to sit immediately after the assistant tool_calls they answer
//   2. Merge consecutive same-role messages
//   3. Drop text-only assistant messages that follow tool_calls
//   4. Drop orphan tool messages
//   5. Coerce tool_call.arguments / tool.content to strings (only used by the CC path)
// They used to maintain two separate copies. This is the single source of truth.
function normalizeMessages(messages, { coerceStrings = false } = {}) {
  // Pass 1: re-order tool replies adjacent to their tool_calls.
  const work = [...messages];
  const fixed = [];
  for (let i = 0; i < work.length; i++) {
    const msg = work[i];
    if (msg === null) continue;
    if (msg.role === "assistant" && msg.tool_calls) {
      fixed.push(msg);
      const callIds = new Set(msg.tool_calls.map((tc) => tc.id));
      for (let j = i + 1; j < work.length; j++) {
        if (work[j]?.role === "tool" && callIds.has(work[j].tool_call_id)) {
          fixed.push(work[j]);
          work[j] = null;
        }
      }
    } else if (msg.role === "tool") {
      const lastTc = [...fixed].reverse().find((m) => m.role === "assistant" && m.tool_calls);
      if (lastTc) {
        let insertIdx = fixed.indexOf(lastTc) + 1;
        while (insertIdx < fixed.length && fixed[insertIdx].role === "tool") insertIdx++;
        fixed.splice(insertIdx, 0, msg);
        work[i] = null;
      }
    } else {
      fixed.push(msg);
    }
  }

  // Pass 2: merge consecutive same-role and drop trailing text-only assistant after tool_calls.
  const merged = [];
  for (const msg of fixed) {
    const prev = merged[merged.length - 1];
    if (
      prev && prev.role === msg.role && msg.role === "user" &&
      typeof prev.content === "string" && typeof msg.content === "string"
    ) {
      prev.content += "\n\n" + msg.content;
    } else if (
      prev && prev.role === msg.role && msg.role === "assistant" &&
      !prev.tool_calls && !msg.tool_calls &&
      typeof prev.content === "string" && typeof msg.content === "string"
    ) {
      prev.content += "\n\n" + msg.content;
    } else if (
      prev && prev.role === "assistant" && msg.role === "assistant" &&
      !prev.tool_calls && msg.tool_calls
    ) {
      merged[merged.length - 1] = msg;
    } else if (
      prev && prev.role === "assistant" && msg.role === "assistant" &&
      prev.tool_calls && !msg.tool_calls
    ) {
      // Drop text-only assistant after tool_calls.
    } else {
      merged.push(msg);
    }
  }

  // Pass 3: drop orphan tool messages.
  const validated = [];
  for (const msg of merged) {
    if (msg.role === "tool") {
      const prev = validated[validated.length - 1];
      if (prev && (prev.role === "tool" || (prev.role === "assistant" && prev.tool_calls))) {
        validated.push(msg);
      }
    } else {
      validated.push(msg);
    }
  }

  // Pass 4 (chat/completions only): coerce tool_call args + tool content to strings.
  if (coerceStrings) {
    for (const msg of validated) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (!tc.function) continue;
          const args = tc.function.arguments;
          if (args === undefined || args === null || args === "") {
            tc.function.arguments = "{}";
          } else if (typeof args !== "string") {
            tc.function.arguments = JSON.stringify(args);
          } else {
            try {
              JSON.parse(args);
            } catch {
              log.warn(`[proxy] invalid tool_call arguments for ${tc.function.name} (id: ${tc.id}), wrapping as JSON`);
              tc.function.arguments = JSON.stringify({ input: args });
            }
          }
        }
      }
      if (msg.role === "tool" && typeof msg.content !== "string") {
        msg.content = JSON.stringify(msg.content);
      }
    }
  }

  return validated;
}

// --- Request translation: Responses API -> Chat Completions (DeepSeek path only) ---

// Codex CLI's effort enum is: none | minimal | low | medium | high | xhigh.
//
// Each upstream accepts a different subset (verified via probe):
//   DeepSeek (deepseek-v4-*): low | medium | high | max | xhigh
//     - default = thinking ON (no field needed)
//     - to disable thinking: send `thinking: { type: "disabled" }`
//       (NB: `enable_thinking: false` is silently ignored by DeepSeek)
//   MiMo (mimo-v2.5-*):       low | medium | high
//     - same `thinking: { type: "disabled" }` to disable
//
// Translation rules (per provider):
//
//   Codex effort       DeepSeek                          MiMo
//   ----------------   --------------------------------  --------------------------------
//   none               thinking:{type:"disabled"}        thinking:{type:"disabled"}
//   minimal            reasoning_effort:"low"            reasoning_effort:"low"
//   low / medium / high reasoning_effort:<same>          reasoning_effort:<same>
//   xhigh              reasoning_effort:"xhigh"          reasoning_effort:"high" (clamped)
//
// `max` is NOT in Codex's enum (Codex would refuse it during config parse), so it
// can't reach the proxy from a Codex client. We still accept it here for direct
// callers that want DeepSeek's extended max tier; MiMo clamps it like xhigh.
// Anything else is passed through as-is and the upstream gets to 400 it.
function applyEffortTranslation(req, effort, provider) {
  if (!effort) return;
  const e = String(effort).toLowerCase().trim();
  if (e === "none") {
    req.thinking = { type: "disabled" };
    return;
  }
  if (e === "minimal") {
    req.reasoning_effort = "low";
    return;
  }
  if (provider === "mimo" && (e === "max" || e === "xhigh")) {
    req.reasoning_effort = "high";
    return;
  }
  req.reasoning_effort = e;
}

function buildReasoningReplayIndex(previousResponseId) {
  const byCallId = new Map();
  const byItemId = new Map();

  const addEntry = (entry, source) => {
    if (!entry.byCallId && !entry.byItemId && entry.reasoningContent) {
      const index = buildReasoningIndex(entry.output, entry.reasoningContent);
      entry = { ...entry, ...index };
    }
    for (const [callId, reasoning] of entry.byCallId || []) {
      if (!byCallId.has(callId)) byCallId.set(callId, { reasoning, source });
    }
    for (const [itemId, reasoning] of entry.byItemId || []) {
      if (!byItemId.has(itemId)) byItemId.set(itemId, { reasoning, source });
    }
  };

  if (previousResponseId) {
    for (const { id, stored } of getResponseChainEntries(previousResponseId).reverse()) {
      addEntry(stored, `chain:${id}`);
    }
  }

  for (const [id, entry] of [...responseStore.entries()].reverse()) {
    addEntry(entry, `store:${id}`);
  }

  return { byCallId, byItemId };
}

function applyDeepSeekToolRoundTripSafety(req, context = "request") {
  if (req.thinking?.type === "disabled") return false;
  const assistantToolMessages = (req.messages || []).filter(
    (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
  );
  const missingReasoningCount = assistantToolMessages.filter((m) => {
    if (typeof m.reasoning_content !== "string") return true;
    return m.reasoning_content.trim().length === 0;
  }).length;
  if (missingReasoningCount === 0) return false;

  req.thinking = { type: "disabled" };
  delete req.reasoning_effort;
  log.warn(
    `[proxy] deepseek safety-net (${context}): ${missingReasoningCount}/${assistantToolMessages.length} assistant tool_call message(s) missing reasoning_content -> forcing thinking:disabled`
  );
  return true;
}

function responsesRequestToChatCompletions(body, provider) {
  const messages = [];
  const previousResponseIdForReplay = body.previous_response_id || body._resolved_previous_response_id || null;

  if (body.instructions) {
    messages.push({
      role: "user",
      content: "[System Instructions] " + body.instructions + "\n\nNote: Be efficient with tool calls. Avoid repeating the same tool call unnecessarily.",
    });
  }

  const reasoningReplay = provider === "deepseek" ? buildReasoningReplayIndex(previousResponseIdForReplay) : null;

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    let pendingToolCalls = [];
    const flushPendingToolCalls = () => {
      if (pendingToolCalls.length === 0) return;
      const msg = { role: "assistant", content: null, tool_calls: pendingToolCalls };
      // Attach reasoning if any of the calls in this batch has one cached.
      // (DeepSeek emits one reasoning per response, shared by all tool_calls.)
      for (const tc of pendingToolCalls) {
        const hit = reasoningReplay?.byCallId.get(tc.id) || reasoningReplay?.byItemId.get(tc.id);
        if (hit?.reasoning) {
          msg.reasoning_content = hit.reasoning;
          log.debug(`[proxy] deepseek reasoning replay hit (${hit.source}, call_id=${tc.id})`);
          break;
        }
      }
      messages.push(msg);
      pendingToolCalls = [];
    };

    for (const item of body.input) {
      // Tolerate items without explicit `type`: if it has a role/content shape,
      // treat it as a plain message (Codex CLI / cc-switch health probe sends
      // `[{role,content}]` without setting type, and OpenAI's Responses API
      // accepts that form too).
      const itemType = item.type || (item.role ? "message" : undefined);
      if (itemType === "message") {
        const role = (item.role === "developer" || item.role === "system") ? "user" : item.role;
        let content;

        if (typeof item.content === "string") {
          content = item.content;
        } else if (Array.isArray(item.content)) {
          content = item.content.map((block) => {
            if (block.type === "input_text") return { type: "text", text: block.text };
            if (block.type === "output_text") return { type: "text", text: block.text };
            if (block.type === "input_image") {
              return { type: "image_url", image_url: { url: block.image_url || block.url } };
            }
            return block;
          });
          if (content.length === 1 && content[0].type === "text") {
            content = content[0].text;
          }
        }

        if (pendingToolCalls.length > 0 && role === "assistant") {
          flushPendingToolCalls();
        } else {
          flushPendingToolCalls();
          messages.push({ role, content });
        }
      } else if (itemType === "function_call") {
        pendingToolCalls.push({
          id: item.call_id || item.id,
          type: "function",
          function: { name: item.name, arguments: item.arguments },
        });
      } else if (itemType === "function_call_output") {
        flushPendingToolCalls();
        messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output });
      }
    }

    flushPendingToolCalls();
  }

  const merged = normalizeMessages(messages);

  const TOOL_OUTPUT_MAX = 2000;
  const KEEP_RECENT_FULL = 10;
  for (let i = 0; i < Math.max(0, merged.length - KEEP_RECENT_FULL); i++) {
    const msg = merged[i];
    if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > TOOL_OUTPUT_MAX) {
      msg.content = msg.content.slice(0, TOOL_OUTPUT_MAX) + "\n...[output truncated, " + (msg.content.length - TOOL_OUTPUT_MAX) + " chars removed]";
    }
  }

  const MAX_MESSAGES = 55;
  let finalMessages = merged;
  if (merged.length > MAX_MESSAGES) {
    const head = merged.slice(0, 2);
    let tail = merged.slice(-(MAX_MESSAGES - 3));
    while (tail.length > 0 && tail[0].role === "tool") tail.shift();
    finalMessages = [
      ...head,
      {
        role: "user",
        content: "[Earlier conversation trimmed. Do not repeat previous statements or tool calls you already made. Continue with the current task. If you have enough information, respond to the user instead of making more tool calls.]",
      },
      ...tail,
    ];
    log.info(`[proxy] trimmed ${merged.length} -> ${finalMessages.length} messages`);
  }

  // After trim we may have left orphan tool messages — re-normalise to drop them.
  if (merged.length > MAX_MESSAGES) {
    finalMessages = normalizeMessages(finalMessages);
  }

  const req = {
    model: body.model,
    messages: finalMessages,
    stream: body.stream || false,
  };

  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  req.max_tokens = body.max_output_tokens || 16384;

  if (body.tools?.length > 0) {
    const supported = body.tools.filter((t) => t.type === "function");
    if (supported.length > 0) {
      req.tools = supported.map((t) => {
        if (!t.function) {
          return {
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          };
        }
        return t;
      });
    }
  }

  if (body.tool_choice != null) {
    if (typeof body.tool_choice === "object" && body.tool_choice.name) {
      req.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
    } else {
      req.tool_choice = body.tool_choice;
    }
  }

  applyEffortTranslation(req, body.reasoning?.effort, provider);
  if (body.parallel_tool_calls != null) req.parallel_tool_calls = body.parallel_tool_calls;

  // DeepSeek thinking-mode + tool-call round-trip safety net.
  //
  // When DeepSeek runs in thinking mode (the default unless we send
  // `thinking:{type:"disabled"}`), it requires the original `reasoning_content`
  // to be sent back attached to any prior assistant tool_call message; otherwise
  // it 400s with "The `reasoning_content` in the thinking mode must be passed
  // back to the API.". Codex CLI does NOT round-trip `reasoning_content` through
  // this proxy (we strip it from the upstream stream and Codex stores nothing
  // we can replay), so any conversation that includes an assistant tool_call
  // must run with thinking disabled — otherwise the very next turn dies.
  //
  // We trigger this defensively whenever the request body contains an assistant
  // message with `tool_calls` and `req.thinking` isn't already disabled. This
  // also covers the case where the client sends `reasoning:{}` without an
  // explicit effort (then applyEffortTranslation is a no-op and DeepSeek would
  // default to thinking ON).
  if (provider === "deepseek") applyDeepSeekToolRoundTripSafety(req, "responses");

  return req;
}

// --- Response translation: Chat Completions -> Responses (DeepSeek path) ---

function uid() {
  return crypto.randomBytes(12).toString("base64url");
}

function chatCompletionToResponse(cc, model, previousResponseId, metadata) {
  const responseId = `resp_${uid()}`;
  const output = [];
  const choice = cc.choices?.[0];

  if (!choice) {
    return {
      id: responseId,
      object: "response",
      created_at: cc.created || Math.floor(Date.now() / 1000),
      status: "completed",
      model: model || cc.model,
      output: [],
      usage: translateUsage(cc.usage),
    };
  }

  const msg = choice.message;

  if (msg.tool_calls?.length > 0) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: "function_call",
        id: `fc_${uid()}`,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: "completed",
      });
    }
  }

  let text = msg.content || "";
  text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
  if (text) {
    output.push({
      type: "message",
      id: `msg_${uid()}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }

  if (msg.refusal) {
    const msgItem = output.find((o) => o.type === "message") || {
      type: "message",
      id: `msg_${uid()}`,
      status: "completed",
      role: "assistant",
      content: [],
    };
    msgItem.content.push({ type: "refusal", refusal: msg.refusal });
    if (!output.find((o) => o.type === "message")) output.push(msgItem);
  }

  let status = "completed";
  let incompleteDetails = null;
  if (choice.finish_reason === "length") {
    status = "incomplete";
    incompleteDetails = { reason: "max_output_tokens" };
  } else if (choice.finish_reason === "content_filter") {
    status = "incomplete";
    incompleteDetails = { reason: "content_filter" };
  }

  return {
    id: responseId,
    object: "response",
    created_at: cc.created || Math.floor(Date.now() / 1000),
    status,
    model: model || cc.model,
    output,
    previous_response_id: previousResponseId || null,
    metadata: metadata || {},
    usage: translateUsage(cc.usage),
    incomplete_details: incompleteDetails,
  };
}

function translateUsage(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  return {
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
    total_tokens: u.total_tokens || 0,
    input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens || 0 },
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0 },
  };
}

// --- Streaming translation for DeepSeek chat completions -> Responses SSE ---

function buildStreamingResponseEvents(responseId, model, previousResponseId, metadata) {
  const baseResponse = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "in_progress",
    model,
    output: [],
    previous_response_id: previousResponseId || null,
    metadata: metadata || {},
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };

  return {
    created: () => `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: baseResponse })}\n\n`,
    inProgress: () => `event: response.in_progress\ndata: ${JSON.stringify({ type: "response.in_progress", response: baseResponse })}\n\n`,
    outputItemAdded: (index, item) => `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: index, item })}\n\n`,
    contentPartAdded: (outIdx, contentIdx, part) => `event: response.content_part.added\ndata: ${JSON.stringify({ type: "response.content_part.added", output_index: outIdx, content_index: contentIdx, part })}\n\n`,
    textDelta: (outIdx, contentIdx, delta) => `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: outIdx, content_index: contentIdx, delta })}\n\n`,
    textDone: (outIdx, contentIdx, text) => `event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", output_index: outIdx, content_index: contentIdx, text })}\n\n`,
    contentPartDone: (outIdx, contentIdx, part) => `event: response.content_part.done\ndata: ${JSON.stringify({ type: "response.content_part.done", output_index: outIdx, content_index: contentIdx, part })}\n\n`,
    outputItemDone: (outIdx, item) => `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: outIdx, item })}\n\n`,
    fnCallArgsDelta: (outIdx, callId, delta) => `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", output_index: outIdx, call_id: callId, delta })}\n\n`,
    fnCallArgsDone: (outIdx, callId, args) => `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: outIdx, call_id: callId, arguments: args })}\n\n`,
    completed: (response) => `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
  };
}

async function handleStreamingResponse(req, upstreamRes, res, model, previousResponseId, metadata) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const teardown = wireClientCancel(res, upstreamRes);
  const responseId = `resp_${uid()}`;
  const events = buildStreamingResponseEvents(responseId, model, previousResponseId, metadata);
  await writeWithBackpressure(res, events.created());
  await writeWithBackpressure(res, events.inProgress());

  let fullText = "";
  let reasoningContent = "";
  let inThink = false;
  let messageStarted = false;
  let completionSent = false;
  const toolCalls = new Map();
  let outputIndex = 0;
  let textOutputIdx = -1;
  let buffer = "";
  let streamOutput = null;
  const decoder = new TextDecoder();

  try {
    for await (const chunk of upstreamRes.body) {
      if (clientGone(res)) break;
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          if (!completionSent) {
            completionSent = true;
            streamOutput = await sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, null, null, previousResponseId, metadata);
          }
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = parsed.choices?.[0]?.delta;
        const finishReason = parsed.choices?.[0]?.finish_reason;
        if (!delta && !finishReason) continue;

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const tcOutIdx = (messageStarted && textOutputIdx === 0) ? outputIndex + idx + 1 : outputIndex + idx;
            if (!toolCalls.has(idx)) {
              const callId = tc.id || `call_${uid()}`;
              const fcId = `fc_${uid()}`;
              toolCalls.set(idx, { id: fcId, callId, name: tc.function?.name || "", arguments: "", outputIdx: tcOutIdx });
              await writeWithBackpressure(res, events.outputItemAdded(tcOutIdx, {
                type: "function_call",
                id: fcId,
                call_id: callId,
                name: tc.function?.name || "",
                arguments: "",
                status: "in_progress",
              }));
            }
            if (tc.function?.arguments) {
              const tcData = toolCalls.get(idx);
              tcData.arguments += tc.function.arguments;
              await writeWithBackpressure(res, events.fnCallArgsDelta(tcData.outputIdx, tcData.callId, tc.function.arguments));
            }
          }
          if (finishReason && !completionSent) {
            completionSent = true;
            streamOutput = await sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, finishReason, parsed.usage, previousResponseId, metadata);
          }
          continue;
        }

        if (typeof delta?.reasoning_content === "string") {
          // Capture but don't forward — Codex CLI doesn't round-trip Responses-API
          // reasoning items through this proxy. We stash the raw string on the
          // stored response and replay it on the next turn (see
          // `responsesRequestToChatCompletions`) so DeepSeek's thinking-mode
          // tool-call round-trip doesn't 400 on a missing `reasoning_content`.
          reasoningContent += delta.reasoning_content;
          continue;
        }

        if (delta?.content) {
          let text = delta.content;
          if (text.includes("<think>")) { inThink = true; text = text.replace(/<think>/g, ""); }
          if (text.includes("</think>")) { inThink = false; text = text.replace(/<\/think>/g, ""); }
          if (inThink || !text) continue;

          if (!messageStarted) {
            messageStarted = true;
            textOutputIdx = outputIndex + toolCalls.size;
            await writeWithBackpressure(res, events.outputItemAdded(textOutputIdx, {
              type: "message",
              id: `msg_${uid()}`,
              status: "in_progress",
              role: "assistant",
              content: [],
            }));
            await writeWithBackpressure(res, events.contentPartAdded(textOutputIdx, 0, { type: "output_text", text: "", annotations: [] }));
          }

          fullText += text;
          await writeWithBackpressure(res, events.textDelta(textOutputIdx, 0, text));
        }

        if (finishReason && !completionSent) {
          completionSent = true;
          streamOutput = await sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, finishReason, parsed.usage, previousResponseId, metadata);
        }
      }
    }
  } finally {
    teardown();
  }

  if (clientGone(res)) {
    log.warn(`[proxy] client disconnected mid-stream (${responseId})`);
    try { res.end(); } catch { /* ignore */ }
    return { responseId, output: streamOutput || [], reasoningContent };
  }

  if (!completionSent) {
    completionSent = true;
    const wasGenerating = fullText.length > 0 || toolCalls.size > 0;
    const fallbackReason = wasGenerating ? "length" : "stop";
    log.warn(`[proxy] stream ended without finish_reason (wasGenerating=${wasGenerating}, reason=${fallbackReason})`);
    streamOutput = await sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, fallbackReason, null, previousResponseId, metadata);
  }

  res.end();
  return { responseId, output: streamOutput || [], reasoningContent };
}

async function sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, finishReason, usage, previousResponseId, metadata) {
  for (const [idx, tc] of toolCalls) {
    const tcIdx = tc.outputIdx != null ? tc.outputIdx : outputIndex + idx;
    await writeWithBackpressure(res, events.fnCallArgsDone(tcIdx, tc.callId, tc.arguments));
    await writeWithBackpressure(res, events.outputItemDone(tcIdx, {
      type: "function_call",
      id: tc.id,
      call_id: tc.callId,
      name: tc.name,
      arguments: tc.arguments,
      status: "completed",
    }));
  }

  const msgOutIdx = textOutputIdx >= 0 ? textOutputIdx : outputIndex + toolCalls.size;
  const trimmed = fullText.trim();
  if (trimmed) {
    const donePart = { type: "output_text", text: trimmed, annotations: [] };
    await writeWithBackpressure(res, events.textDone(msgOutIdx, 0, trimmed));
    await writeWithBackpressure(res, events.contentPartDone(msgOutIdx, 0, donePart));
    await writeWithBackpressure(res, events.outputItemDone(msgOutIdx, {
      type: "message",
      id: `msg_${uid()}`,
      status: "completed",
      role: "assistant",
      content: [donePart],
    }));
  }

  const outputItems = [];
  for (const [idx, tc] of toolCalls) {
    const tcIdx = tc.outputIdx != null ? tc.outputIdx : outputIndex + idx;
    outputItems.push({
      sortIdx: tcIdx,
      item: {
        type: "function_call",
        id: tc.id,
        call_id: tc.callId,
        name: tc.name,
        arguments: tc.arguments,
        status: "completed",
      },
    });
  }
  if (trimmed) {
    outputItems.push({
      sortIdx: msgOutIdx,
      item: {
        type: "message",
        id: `msg_${uid()}`,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: trimmed, annotations: [] }],
      },
    });
  }
  outputItems.sort((a, b) => a.sortIdx - b.sortIdx);
  const finalOutput = outputItems.map((o) => o.item);

  let status = "completed";
  let incompleteDetails = null;
  if (finishReason === "length") {
    status = "incomplete";
    incompleteDetails = { reason: "max_output_tokens" };
  }

  const finalResponse = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: finalOutput,
    previous_response_id: previousResponseId || null,
    metadata: metadata || {},
    usage: translateUsage(usage),
    incomplete_details: incompleteDetails,
  };

  await writeWithBackpressure(res, events.completed(finalResponse));
  return finalOutput;
}

async function sendResponseAsStream(res, response, req) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const events = buildStreamingResponseEvents(response.id, response.model, response.previous_response_id, response.metadata);
  await writeWithBackpressure(res, events.created());
  await writeWithBackpressure(res, events.inProgress());

  for (let i = 0; i < response.output.length; i++) {
    if (clientGone(res)) break;
    const item = response.output[i];
    if (item.type === "function_call") {
      await writeWithBackpressure(res, events.outputItemAdded(i, { ...item, status: "in_progress", arguments: "" }));
      await writeWithBackpressure(res, events.fnCallArgsDelta(i, item.call_id, item.arguments));
      await writeWithBackpressure(res, events.fnCallArgsDone(i, item.call_id, item.arguments));
      await writeWithBackpressure(res, events.outputItemDone(i, item));
    } else if (item.type === "message") {
      await writeWithBackpressure(res, events.outputItemAdded(i, { ...item, status: "in_progress", content: [] }));
      for (let ci = 0; ci < item.content.length; ci++) {
        const part = item.content[ci];
        if (part.type === "output_text") {
          await writeWithBackpressure(res, events.contentPartAdded(i, ci, { type: "output_text", text: "", annotations: [] }));
          const text = part.text;
          for (let c = 0; c < text.length; c += 80) {
            if (clientGone(res)) break;
            await writeWithBackpressure(res, events.textDelta(i, ci, text.slice(c, c + 80)));
          }
          await writeWithBackpressure(res, events.textDone(i, ci, text));
          await writeWithBackpressure(res, events.contentPartDone(i, ci, part));
        }
      }
      await writeWithBackpressure(res, events.outputItemDone(i, item));
    }
  }

  await writeWithBackpressure(res, events.completed(response));
  res.end();
}

// --- Generic upstream helpers ---

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

// Wrap fetch with an AbortController so a stuck upstream eventually fails
// instead of hanging the request forever. Defaults to UPSTREAM_TIMEOUT (env-tunable).
async function fetchWithTimeout(url, opts, timeoutMs = UPSTREAM_TIMEOUT) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  // Honour caller-provided signal too (chain abort).
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// Wire client-disconnect to upstream cancel so Ctrl+C in Codex CLI doesn't leave
// the upstream stream running. Returns a teardown fn the caller invokes on success.
//
// IMPORTANT: we listen on `res` (ServerResponse), not `req` (IncomingMessage). On
// Node's http server, `req.destroyed` becomes `true` and `req` emits `close` as
// soon as the request body is fully consumed — even while the client is still
// happily waiting for the response. Listening on `req.close` would therefore fire
// a false "client gone" the moment we finished reading the POST body and would
// kill the upstream stream before any chunk got out. `res.close` only fires when
// the underlying socket actually goes away.
//
// `clientGone(res)` is the corresponding "is the socket actually dead?" check
// used inside the SSE loops below; it must NOT consult req.destroyed for the same
// reason.
function wireClientCancel(res, upstreamRes) {
  if (!res || !upstreamRes?.body) return () => {};
  let cancelled = false;
  const onClose = () => {
    if (cancelled) return;
    cancelled = true;
    try { upstreamRes.body.cancel?.(); } catch { /* ignore */ }
  };
  res.once("close", onClose);
  return () => {
    cancelled = true;
    res.off("close", onClose);
  };
}

// True iff the response socket is gone — i.e. the client really disconnected.
// Use this in SSE loops instead of `req.destroyed`, which falsely turns true the
// moment the request body finishes streaming in.
//
// `res.destroyed` flips true on socket teardown. `res.closed` flips true when the
// underlying socket emits 'close'. We deliberately do NOT check `res.writableEnded`
// because that becomes true after our own `res.end()` call — and we don't want
// "we finished writing" to look like "client disappeared".
function clientGone(res) {
  return !!(res && (res.destroyed || res.closed));
}

// Backpressure-aware write. Honours res.write's false return by awaiting drain
// before resolving. Use in SSE loops so slow clients don't blow up memory.
function writeWithBackpressure(res, chunk) {
  if (res.write(chunk)) return;
  return new Promise((resolve) => res.once("drain", resolve));
}

async function readJsonBody(req, res) {
  let rawBody = "";
  for await (const chunk of req) rawBody += chunk;
  try {
    return JSON.parse(rawBody);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return null;
  }
}

async function sendUpstreamError(upstreamRes, res) {
  const errText = await upstreamRes.text();
  log.error(`[proxy] upstream error: ${upstreamRes.status} ${errText}`);
  if (!res.headersSent) {
    res.writeHead(upstreamRes.status, { "Content-Type": upstreamRes.headers.get("content-type") || "application/json" });
    res.end(errText);
  }
}

async function pipeResponsesStreamAndCapture(req, upstreamRes, res, onCompleted) {
  res.writeHead(upstreamRes.status, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const teardown = wireClientCancel(res, upstreamRes);
  let buffer = "";
  const decoder = new TextDecoder();

  const handleBlock = (block) => {
    const lines = block.split("\n");
    let eventType = "";
    const dataLines = [];

    for (const line of lines) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }

    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") return;

    try {
      const parsed = JSON.parse(data);
      if (eventType === "response.completed" || parsed.type === "response.completed") {
        onCompleted(parsed.response || parsed);
      }
    } catch {
      // Ignore parse failures in streamed event capture; stream still passes through.
    }
  };

  try {
    for await (const chunk of upstreamRes.body) {
      if (clientGone(res)) break;
      await writeWithBackpressure(res, chunk);
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");

      let splitIdx;
      while ((splitIdx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, splitIdx);
        buffer = buffer.slice(splitIdx + 2);
        handleBlock(block);
      }
    }

    if (buffer.trim()) handleBlock(buffer);
  } finally {
    teardown();
  }
  res.end();
}

async function forwardOpenAIResponses(req, body, res, originalInput, originalPreviousResponseId) {
  // OpenAI Responses API doesn't accept thinking:{type:"disabled"}; "none" means
  // strip the reasoning hint entirely. Other values pass through unchanged
  // (OpenAI accepts the same enum names: minimal/low/medium/high).
  const eff = body.reasoning?.effort;
  if (eff) {
    const e = String(eff).toLowerCase().trim();
    if (e === "none") delete body.reasoning;
    else if (e === "xhigh") body.reasoning = { ...body.reasoning, effort: "high" };
    // minimal / low / medium / high pass through.
  }

  const upstreamRes = await fetchWithTimeout(`${OPENAI_BASE}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!upstreamRes.ok) {
    await sendUpstreamError(upstreamRes, res);
    return;
  }

  if (body.stream) {
    await pipeResponsesStreamAndCapture(req, upstreamRes, res, (completedResponse) => {
      if (completedResponse?.id && Array.isArray(completedResponse.output)) {
        storeResponse(completedResponse.id, {
          provider: "openai",
          input: originalInput,
          output: completedResponse.output,
          previousResponseId: originalPreviousResponseId || null,
        });
      }
    });
    return;
  }

  const response = await upstreamRes.json();
  if (response?.id && Array.isArray(response.output)) {
    storeResponse(response.id, {
      provider: "openai",
      input: originalInput,
      output: response.output,
      previousResponseId: originalPreviousResponseId || null,
    });
  }
  sendJson(res, upstreamRes.status, response);
}

async function forwardOpenAIChatCompletions(req, body, res) {
  // Same effort normalisation as the responses path. Chat Completions uses the
  // flat `reasoning_effort` field; either form may arrive from callers.
  const eff = body.reasoning_effort || body.reasoning?.effort;
  if (eff) {
    const e = String(eff).toLowerCase().trim();
    delete body.reasoning_effort;
    delete body.reasoning;
    if (e === "none") {
      // Drop entirely — OpenAI doesn't support disabling thinking via a flag.
    } else if (e === "xhigh") {
      body.reasoning_effort = "high";
    } else {
      body.reasoning_effort = e;
    }
  }

  const upstreamRes = await fetchWithTimeout(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!upstreamRes.ok) {
    await sendUpstreamError(upstreamRes, res);
    return;
  }

  if (body.stream) {
    res.writeHead(upstreamRes.status, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const teardown = wireClientCancel(res, upstreamRes);
    try {
      for await (const chunk of upstreamRes.body) {
        if (clientGone(res)) break;
        await writeWithBackpressure(res, chunk);
      }
    } finally {
      teardown();
    }
    res.end();
    return;
  }

  const response = await upstreamRes.json();
  sendJson(res, upstreamRes.status, response);
}

// Run the model in a loop, feeding back any web_fetch tool_calls it makes until
// either (a) it stops requesting fetches, (b) it asks for the same URL twice in
// a row (stuck loop), or (c) MAX_FETCH_LOOPS is hit. Returns the final upstream
// chat-completions response with web_fetch tool_calls stripped from the message.
//
// `prefix` is just for log lines so callers can distinguish responses-path vs
// chat-completions-path output.
async function runWebFetchLoop({ baseRequest, initialMessages, upstreamUrl, upstreamKey, provider = "", prefix = "" }) {
  let loopMessages = [...initialMessages];
  let finalCcResponse = null;
  let fetchLoopCount = 0;
  const fetchCache = new Map();
  let prevFetchUrls = "";
  const tag = prefix ? `${prefix}: ` : "";

  for (let loop = 0; loop <= MAX_FETCH_LOOPS; loop++) {
    const loopReq = { ...baseRequest, messages: loopMessages, stream: false };
    if (provider === "deepseek") applyDeepSeekToolRoundTripSafety(loopReq, `${tag || "responses"}web_fetch loop ${loop + 1}`);
    const upstreamRes = await fetchWithTimeout(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstreamKey}`,
      },
      body: JSON.stringify(loopReq),
    }, UPSTREAM_TIMEOUT);

    if (!upstreamRes.ok) {
      return { ok: false, errorRes: upstreamRes };
    }

    const ccResponse = await upstreamRes.json();
    const msg = ccResponse.choices?.[0]?.message;
    const webFetchCalls = (msg?.tool_calls || []).filter((tc) => tc.function?.name === "web_fetch");
    const currentFetchUrls = webFetchCalls.map((tc) => {
      try { return JSON.parse(tc.function.arguments).url; }
      catch { return ""; }
    }).sort().join("|");
    const isStuckLoop = webFetchCalls.length > 0 && currentFetchUrls === prevFetchUrls;

    if (webFetchCalls.length === 0 || loop === MAX_FETCH_LOOPS || isStuckLoop) {
      if (isStuckLoop) {
        log.warn(`[proxy] ${tag}web_fetch loop stuck — model re-requested same URL(s), breaking early at loop ${loop + 1}`);
      }
      if (loop === MAX_FETCH_LOOPS && webFetchCalls.length > 0) {
        log.warn(`[proxy] ${tag}web_fetch MAX_FETCH_LOOPS (${MAX_FETCH_LOOPS}) exhausted — stripping remaining fetches`);
      }
      if (msg?.tool_calls) {
        msg.tool_calls = msg.tool_calls.filter((tc) => tc.function?.name !== "web_fetch");
        if (msg.tool_calls.length === 0) {
          delete msg.tool_calls;
          if (ccResponse.choices[0].finish_reason === "tool_calls") {
            ccResponse.choices[0].finish_reason = "stop";
          }
        }
      }
      finalCcResponse = ccResponse;
      fetchLoopCount = loop;
      break;
    }

    prevFetchUrls = currentFetchUrls;
    log.info(`[proxy] ${tag}executing ${webFetchCalls.length} web_fetch call(s) (loop ${loop + 1}/${MAX_FETCH_LOOPS})`);
    const results = await Promise.all(webFetchCalls.map(async (tc) => {
      const fetchUrl = (() => {
        try { return JSON.parse(tc.function.arguments).url; }
        catch { return "unknown"; }
      })();
      if (fetchCache.has(fetchUrl)) {
        log.info(`[proxy] ${tag}web_fetch ${fetchUrl} -> ${fetchCache.get(fetchUrl).length} chars (cached)`);
        return { role: "tool", tool_call_id: tc.id, content: fetchCache.get(fetchUrl) };
      }
      const content = await executeWebFetch(tc.function.arguments);
      fetchCache.set(fetchUrl, content);
      log.info(`[proxy] ${tag}web_fetch ${fetchUrl} -> ${content.length} chars`);
      return { role: "tool", tool_call_id: tc.id, content };
    }));

    const assistantMessage = { role: "assistant", content: null, tool_calls: webFetchCalls };
    if (typeof msg?.reasoning_content === "string" && msg.reasoning_content.trim().length > 0) {
      assistantMessage.reasoning_content = msg.reasoning_content;
    }
    loopMessages = [...loopMessages, assistantMessage, ...results];
  }

  if (fetchLoopCount > 0) {
    log.info(`[proxy] ${tag}web_fetch resolved after ${fetchLoopCount} loop(s)`);
  }
  return { ok: true, response: finalCcResponse };
}

// --- OAI-compatible handlers (DeepSeek, MiMo, ...) ---

async function handleOaiCompatResponses(req, provider, body, res, originalInput) {
  const cfg = OAI_COMPAT_PROVIDERS[provider];
  if (!cfg || !cfg.key) {
    sendJson(res, 400, { error: { message: `${cfg?.envKey || provider.toUpperCase() + "_API_KEY"} is not configured` } });
    return;
  }

  const originalPreviousResponseId = body.previous_response_id || null;
  maybeResolvePreviousResponseChain(body, provider);

  if (originalPreviousResponseId) {
    const prevStored = touchResponse(originalPreviousResponseId);
    const consecutiveTc = prevStored?.consecutiveToolCalls || 0;
    if (consecutiveTc >= MAX_CONSECUTIVE_TOOL_CALLS) {
      log.warn(`[proxy] CIRCUIT BREAKER: ${consecutiveTc} consecutive tool-call-only responses detected — injecting stop-loop nudge`);
      const nudge = {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: `[SYSTEM: You have made ${consecutiveTc} consecutive tool calls without responding to the user. You MUST now stop making tool calls and provide a text response summarizing your progress, findings, and any remaining work. Do NOT make any more tool calls in this response.]`,
        }],
      };
      const currentInput = normalizeInputToArray(body.input);
      body.input = [...currentInput, nudge];
    } else if (consecutiveTc >= Math.floor(MAX_CONSECUTIVE_TOOL_CALLS * 0.75)) {
      log.warn(`[proxy] tool-call loop warning: ${consecutiveTc}/${MAX_CONSECUTIVE_TOOL_CALLS} consecutive tool-call responses`);
    }
  }

  const chatReq = responsesRequestToChatCompletions(body, provider);
  // Honour the model the client asked for if it belongs to this provider; otherwise fall back to the
  // provider's first configured model. (Codex usually sends the configured `model` field already.)
  const requested = normalizeModelId(chatReq.model);
  const isProviderModel = cfg.models.some((m) => normalizeModelId(m) === requested);
  chatReq.model = isProviderModel ? chatReq.model : cfg.defaultModel;
  const isStream = chatReq.stream;

  const upstreamUrl = `${cfg.base}/chat/completions`;
  const upstreamKey = cfg.key;
  const routeLabel = `${provider}(${chatReq.model})`;

  let hardBreakerFired = false;
  if (originalPreviousResponseId) {
    const prevStored = touchResponse(originalPreviousResponseId);
    const consecutiveTc = prevStored?.consecutiveToolCalls || 0;
    if (consecutiveTc >= MAX_CONSECUTIVE_TOOL_CALLS + 3) {
      log.warn("[proxy] HARD CIRCUIT BREAKER: stripping all tools to force text response");
      delete chatReq.tools;
      delete chatReq.tool_choice;
      hardBreakerFired = true;
    }
  }

  const hasConversationUrls = conversationHasUrls(chatReq.messages);
  if (hasConversationUrls) {
    chatReq.tools = ensureWebFetchTool(chatReq.tools);
    chatReq.messages = ensureWebFetchHint(chatReq.messages);
  }

  log.info(
    `[proxy] ${routeLabel} | stream=${isStream} | messages=${chatReq.messages.length}${hasConversationUrls ? " | web_fetch_injected" : ""} | roles=[${chatReq.messages.map((m) => m.role + (m.tool_calls ? "(tc)" : "")).join(",")}]`
  );

  if (hasConversationUrls) {
    const result = await runWebFetchLoop({
      baseRequest: chatReq,
      initialMessages: chatReq.messages,
      upstreamUrl,
      upstreamKey,
      provider,
      prefix: "",
    });
    if (!result.ok) {
      await sendUpstreamError(result.errorRes, res);
      return;
    }
    const responsesResponse = chatCompletionToResponse(result.response, body.model, originalPreviousResponseId, body.metadata);
    storeResponse(responsesResponse.id, {
      provider,
      input: originalInput,
      output: responsesResponse.output,
      previousResponseId: originalPreviousResponseId,
      breakerFired: hardBreakerFired,
      reasoningContent: result.response?.choices?.[0]?.message?.reasoning_content || "",
    });

    if (isStream) await sendResponseAsStream(res, responsesResponse, req);
    else sendJson(res, 200, responsesResponse);
    return;
  }

  const upstreamRes = await fetchWithTimeout(upstreamUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${upstreamKey}`,
    },
    body: JSON.stringify(chatReq),
  });

  if (!upstreamRes.ok) {
    await sendUpstreamError(upstreamRes, res);
    return;
  }

  if (isStream) {
    const { responseId: streamRespId, output: streamOutput, reasoningContent: streamReasoning } = await handleStreamingResponse(
      req,
      upstreamRes,
      res,
      body.model,
      originalPreviousResponseId,
      body.metadata
    );
    storeResponse(streamRespId, {
      provider,
      input: originalInput,
      output: streamOutput,
      previousResponseId: originalPreviousResponseId,
      breakerFired: hardBreakerFired,
      reasoningContent: streamReasoning || "",
    });
    return;
  }

  const ccResponse = await upstreamRes.json();
  const responsesResponse = chatCompletionToResponse(ccResponse, body.model, originalPreviousResponseId, body.metadata);
  const nonStreamReasoning = ccResponse.choices?.[0]?.message?.reasoning_content || "";
  storeResponse(responsesResponse.id, {
    provider,
    input: originalInput,
    output: responsesResponse.output,
    reasoningContent: nonStreamReasoning,
    previousResponseId: originalPreviousResponseId,
    breakerFired: hardBreakerFired,
  });
  sendJson(res, 200, responsesResponse);
}

async function handleOaiCompatChatCompletions(req, provider, body, res) {
  const cfg = OAI_COMPAT_PROVIDERS[provider];
  if (!cfg || !cfg.key) {
    sendJson(res, 400, { error: { message: `${cfg?.envKey || provider.toUpperCase() + "_API_KEY"} is not configured` } });
    return;
  }

  const requested = normalizeModelId(body.model);
  const isProviderModel = body.model && cfg.models.some((m) => normalizeModelId(m) === requested);
  body.model = isProviderModel ? body.model : cfg.defaultModel;
  const isStream = body.stream || false;

  const validated = normalizeMessages(body.messages || [], { coerceStrings: true });
  body.messages = validated;
  if (!body.max_tokens) body.max_tokens = 16384;

  // Translate effort hints on the chat/completions path too. Either:
  //   - body.reasoning_effort (Chat Completions native field)
  //   - body.reasoning?.effort (Responses-style field, in case caller mixes them)
  // are normalised through the same per-provider translator that the responses path uses.
  const ccEffort = body.reasoning_effort || body.reasoning?.effort;
  if (ccEffort) {
    delete body.reasoning_effort;
    delete body.reasoning;
    applyEffortTranslation(body, ccEffort, provider);
  }

  const ccHasUrls = conversationHasUrls(validated);

  if (ccHasUrls) {
    body.tools = ensureWebFetchTool(body.tools);
    body.messages = ensureWebFetchHint(body.messages);
  }

  log.info(`[proxy] chat/completions ${provider}(${body.model}) | stream=${isStream} | messages=${body.messages.length}${ccHasUrls ? " | web_fetch_injected" : ""} | roles=[${body.messages.map((m) => m.role + (m.tool_calls ? "(tc)" : "")).join(",")}]`);

  if (ccHasUrls) {
    const result = await runWebFetchLoop({
      baseRequest: body,
      initialMessages: body.messages,
      upstreamUrl: `${cfg.base}/chat/completions`,
      upstreamKey: cfg.key,
      provider,
      prefix: "cc",
    });
    if (!result.ok) {
      await sendUpstreamError(result.errorRes, res);
      return;
    }
    const finalCcResponse = result.response;

    if (isStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const msg = finalCcResponse.choices?.[0]?.message;
      if (msg?.tool_calls) {
        for (let i = 0; i < msg.tool_calls.length; i++) {
          const tc = msg.tool_calls[i];
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] } }] })}\n\n`);
        }
      }
      if (msg?.content) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: msg.content } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finalCcResponse.choices[0].finish_reason }], usage: finalCcResponse.usage })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    sendJson(res, 200, finalCcResponse);
    return;
  }

  const upstreamRes = await fetchWithTimeout(`${cfg.base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.key}`,
    },
    body: JSON.stringify(body),
  });

  if (!upstreamRes.ok) {
    await sendUpstreamError(upstreamRes, res);
    return;
  }

  if (isStream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const teardown = wireClientCancel(res, upstreamRes);
    try {
      for await (const chunk of upstreamRes.body) {
        if (clientGone(res)) break;
        await writeWithBackpressure(res, chunk);
      }
    } finally {
      teardown();
    }
    res.end();
    return;
  }

  const data = await upstreamRes.json();
  sendJson(res, 200, data);
}

// --- HTTP server ---

const server = TEST_MODE ? null : http.createServer(async (req, res) => {
  // Lightweight access log so we can see what cc-switch / Codex actually sends.
  // Toggle off by setting ACCESS_LOG=0 in .env.
  if (process.env.ACCESS_LOG !== "0") {
    const ua = req.headers["user-agent"] || "";
    log.access(`[access] ${req.method} ${req.url} ua="${ua.slice(0, 60)}"`);
  }

  // Inbound auth gate. /health stays open so cc-switch's reachability ping works
  // without a key (and so smoke tests can verify the server is up before auth kicks in).
  // On success, req.lockedProvider is set to "deepseek" / "mimo" / "openai" / "*".
  req.lockedProvider = "*";
  if (PROXY_AUTH_ENABLED) {
    const isHealth = req.method === "GET" && (req.url === "/health" || req.url === "/");
    if (!isHealth) {
      const header = req.headers["authorization"] || "";
      const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const lock = presented ? PROXY_KEY_TABLE.get(presented) : undefined;
      if (!lock) {
        if (process.env.ACCESS_LOG !== "0") {
          log.access(`[access] 401 unauthorized (presented=${presented ? presented.slice(0, 8) + "…" : "<none>"})`);
        }
        sendJson(res, 401, {
          error: {
            message: "Invalid or missing proxy key. Set Authorization: Bearer <key> using one of the keys configured in PROXY_KEYS or PROXY_AUTH_KEY.",
            type: "invalid_request_error",
            code: "proxy_auth_required",
          },
        });
        return;
      }
      req.lockedProvider = lock;
    }
  }

  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    sendJson(res, 200, {
      status: "ok",
      proxy: "codex-bridge",
      providers: [...enabledProviders],
      default_provider: getFallbackProvider(),
    });
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && req.url.startsWith("/cop")) {
    let url = "";
    let method = "GET";
    let body2 = null;
    let headers2 = {};

    if (req.method === "GET") {
      const parsed = new URL(req.url, "http://localhost");
      url = parsed.searchParams.get("url") || "";
    } else {
      const parsedBody = await readJsonBody(req, res);
      if (!parsedBody) return;
      url = parsedBody.url || "";
      method = parsedBody.method || "GET";
      body2 = parsedBody.body || null;
      headers2 = parsedBody.headers || {};
    }

    if (!url) {
      sendJson(res, 400, { error: "url parameter required" });
      return;
    }

    log.info(`[proxy] /cop ${method} ${url}`);
    const content = await executeWebFetch({ url, method, headers: headers2, body: body2 });
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(content);
    return;
  }

  if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
    sendJson(res, 200, {
      object: "list",
      data: modelCatalog,
      default_provider: getFallbackProvider(),
    });
    return;
  }

  if (req.method === "POST" && (req.url === "/v1/responses" || req.url === "/responses")) {
    const body = await readJsonBody(req, res);
    if (!body) return;

    if (process.env.ACCESS_LOG !== "0") {
      const inputType = Array.isArray(body.input) ? `array(${body.input.length})` : typeof body.input;
      log.access(`[access] /v1/responses body keys=${Object.keys(body).join(",")} model=${body.model || "<none>"} input=${inputType} stream=${!!body.stream}`);
    }

    try {
      // If the inbound key locks the request to one provider, fill in the provider's
      // default model when body.model is missing — this lets cc-switch probes (which
      // omit `model` entirely) still get a sensible synthetic response.
      const lock = req.lockedProvider || "*";
      if (lock !== "*" && (!body.model || !String(body.model).trim())) {
        const lockCfg = OAI_COMPAT_PROVIDERS[lock];
        if (lockCfg) body.model = lockCfg.defaultModel;
        else if (lock === "openai") body.model = OPENAI_MODELS[0] || "";
      }

      const provider = resolveProviderForModel(body.model);

      // Provider-lock enforcement: the inbound key dictates which upstream is allowed.
      // If body.model resolves to a different provider, refuse (the user almost certainly
      // forgot to /model after switching cc-switch profile, or is reusing a key).
      if (lock !== "*" && provider !== lock) {
        if (process.env.ACCESS_LOG !== "0") {
          log.access(`[access] 401 provider lock mismatch (key locks=${lock}, model=${body.model || "<none>"} -> provider=${provider})`);
        }
        sendJson(res, 401, {
          error: {
            message: `This proxy key is locked to provider "${lock}", but the request model "${body.model || "<none>"}" routes to "${provider}". Either switch model or use a different key.`,
            type: "invalid_request_error",
            code: "proxy_provider_lock",
          },
        });
        return;
      }

      const originalInput = normalizeInputToArray(body.input);

      // Health-check / probe short-circuit: cc-switch (and similar managers) ping the
      // proxy with empty or input-less bodies just to verify reachability. Forwarding
      // those upstream produces a 400 ("Empty input messages") which surfaces in the UI
      // as "供应商拒绝了请求格式". Detect probes (no input AND no previous_response_id)
      // and answer locally without touching the upstream provider.
      const hasInput = originalInput.length > 0 || (typeof body.input === "string" && body.input.trim().length > 0);
      const hasPrevious = !!body.previous_response_id;
      if (!hasInput && !hasPrevious) {
        if (process.env.ACCESS_LOG !== "0") {
          log.access(`[access] /v1/responses probe short-circuit (provider=${provider})`);
        }
        const probeId = `resp_probe_${Math.random().toString(36).slice(2, 12)}`;
        sendJson(res, 200, {
          id: probeId,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "completed",
          model: body.model || (OAI_COMPAT_PROVIDERS[provider]?.defaultModel) || "probe",
          output: [
            {
              type: "message",
              id: `msg_probe_${Math.random().toString(36).slice(2, 10)}`,
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          previous_response_id: null,
          metadata: { probe: true },
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
          incomplete_details: null,
        });
        return;
      }

      if (provider === "openai") {
        if (!OPENAI_KEY) {
          sendJson(res, 400, { error: { message: "OPENAI_API_KEY is not configured" } });
          return;
        }
        const originalPreviousResponseId = body.previous_response_id || null;
        maybeResolvePreviousResponseChain(body, "openai");
        log.info(`[proxy] responses openai(${body.model || OPENAI_MODELS[0] || "default"}) | stream=${!!body.stream}`);
        await forwardOpenAIResponses(req, body, res, originalInput, originalPreviousResponseId);
        return;
      }

      if (OAI_COMPAT_PROVIDERS[provider]) {
        await handleOaiCompatResponses(req, provider, body, res, originalInput);
        return;
      }

      sendJson(res, 400, { error: { message: `Unknown provider resolved: ${provider}` } });
    } catch (err) {
      log.error("[proxy] responses route error:", err.message);
      if (!res.headersSent) sendJson(res, 500, { error: { message: err.message } });
    }
    return;
  }

  if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
    const body = await readJsonBody(req, res);
    if (!body) return;

    try {
      const lock = req.lockedProvider || "*";
      if (lock !== "*" && (!body.model || !String(body.model).trim())) {
        const lockCfg = OAI_COMPAT_PROVIDERS[lock];
        if (lockCfg) body.model = lockCfg.defaultModel;
        else if (lock === "openai") body.model = OPENAI_MODELS[0] || "";
      }
      const provider = resolveProviderForModel(body.model);
      if (lock !== "*" && provider !== lock) {
        if (process.env.ACCESS_LOG !== "0") {
          log.access(`[access] 401 provider lock mismatch (key locks=${lock}, model=${body.model || "<none>"} -> provider=${provider})`);
        }
        sendJson(res, 401, {
          error: {
            message: `This proxy key is locked to provider "${lock}", but the request model "${body.model || "<none>"}" routes to "${provider}". Either switch model or use a different key.`,
            type: "invalid_request_error",
            code: "proxy_provider_lock",
          },
        });
        return;
      }
      if (provider === "openai") {
        if (!OPENAI_KEY) {
          sendJson(res, 400, { error: { message: "OPENAI_API_KEY is not configured" } });
          return;
        }
        log.info(`[proxy] chat/completions openai(${body.model || OPENAI_MODELS[0] || "default"}) | stream=${!!body.stream}`);
        await forwardOpenAIChatCompletions(req, body, res);
        return;
      }

      if (OAI_COMPAT_PROVIDERS[provider]) {
        await handleOaiCompatChatCompletions(req, provider, body, res);
        return;
      }

      sendJson(res, 400, { error: { message: `Unknown provider resolved: ${provider}` } });
    } catch (err) {
      log.error("[proxy] chat/completions route error:", err.message);
      if (!res.headersSent) sendJson(res, 500, { error: { message: err.message } });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found. Use POST /v1/responses" });
});

if (server) {
server.timeout = 0;
server.keepAliveTimeout = 300000;
server.headersTimeout = 300000;
server.requestTimeout = 0;

server.listen(PORT, () => {
  console.log(`[codex-bridge] Listening on http://localhost:${PORT}`);
  console.log(`[codex-bridge] Default provider: ${getFallbackProvider()}`);
  for (const [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
    const label = name.charAt(0).toUpperCase() + name.slice(1);
    console.log(`[codex-bridge] ${label.padEnd(8)}: ${cfg.key ? `${cfg.base} | models=${cfg.models.join(", ")}` : "DISABLED"}`);
  }
  console.log(`[codex-bridge] OpenAI  : ${OPENAI_KEY ? `${OPENAI_BASE} | models=${OPENAI_MODELS.join(", ")}` : "DISABLED"}`);
  console.log(`[codex-bridge] GitHub  : ${process.env.GITHUB_TOKEN ? "authenticated (env)" : "lazy (will run `gh auth token` on first api.github.com fetch)"}`);
  if (!PROXY_AUTH_ENABLED) {
    console.log(`[codex-bridge] Inbound : OPEN — anyone on localhost can use this proxy (set PROXY_AUTH_KEY or PROXY_KEYS to lock down)`);
  } else {
    console.log(`[codex-bridge] Inbound : auth required (${PROXY_KEY_TABLE.size} key${PROXY_KEY_TABLE.size === 1 ? "" : "s"} loaded)`);
    for (const [key, lock] of PROXY_KEY_TABLE) {
      const lockLabel = lock === "*" ? "any provider" : `locked to ${lock}`;
      console.log(`[codex-bridge]           ${key.slice(0, 16)}… (${key.length} chars) — ${lockLabel}`);
    }
  }
});
}

export const __test = TEST_MODE ? {
  responseStore,
  storeResponse,
  responsesRequestToChatCompletions,
  applyDeepSeekToolRoundTripSafety,
} : {};
