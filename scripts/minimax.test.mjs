import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const flash = "MiniMax-M3.1-Flash";
const messages = [{ role: "user", content: "Say hello" }];
const calls = [];
const upstream = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  calls.push({ path: req.url, authorization: req.headers.authorization, body });
  const needsTool = body.messages.some((m) => m.content === "request tool") &&
    !body.messages.some((m) => m.role === "tool");
  const message = needsTool ? {
    role: "assistant", content: "<think>keep inline reasoning</think>Calling tool",
    reasoning_content: "keep separate reasoning",
    tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }],
  } : { role: "assistant", content: "Hello" };
  const finish = needsTool ? "tool_calls" : "stop";
  if (body.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = { ...message, tool_calls: message.tool_calls?.map((tc, index) => ({ ...tc, index })) };
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "chatcmpl_fixture", model: body.model,
      choices: [{ index: 0, message, finish_reason: finish }], usage: {} }));
  }
});

async function startProxy(t, overrides = {}) {
  const reservation = http.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  // Deliberately do not inherit provider keys, CLI credentials, or local .env files.
  const child = spawn(process.execPath, ["proxy.mjs"], {
    cwd: root,
    env: {
      PATH: process.env.PATH, PROXY_PORT: String(port), LOG_LEVEL: "silent", ACCESS_LOG: "0",
      MINIMAX_API_KEY: "fixture-minimax", MINIMAX_BASE_URL: `${base}/global/v1`,
      DEEPSEEK_API_KEY: "fixture-other", DEEPSEEK_BASE_URL: `${base}/other/v1`,
      DEFAULT_PROVIDER: "minimax", PROXY_KEYS: "fixture-locked:minimax,fixture-any:*",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode == null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });
  let output = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Proxy startup timeout: ${output}`)), 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("Listening on")) { clearTimeout(timeout); resolve(); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Proxy exited ${code}: ${output}`)); });
  });
  return async (path, body, key = "fixture-locked") => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    return { status: response.status, text, json: text.startsWith("{") ? JSON.parse(text) : null };
  };
}

function inputFor(path) {
  return path === "/v1/responses" ? { input: "Say hello" } : { messages };
}

function latest() { return calls.at(-1).body; }

await test("MiniMax HTTP boundary", async (t) => {
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const request = await startProxy(t);

  await t.test("ordinary catalog is Flash first; non-MiniMax entries survive", async () => {
    const { json } = await request("/v1/models");
    assert.deepEqual(json.data.filter((m) => m.owned_by === "minimax").map((m) => m.id), [flash, "MiniMax-M3"]);
    assert.ok(json.data.some((m) => m.id === "deepseek-v4-pro"));
    const example = JSON.parse(fs.readFileSync(new URL("../proxy-models.example.json", import.meta.url)));
    const models = example.models.filter((m) => m.slug.startsWith("MiniMax"));
    assert.deepEqual(models.map((m) => m.slug), [flash, "MiniMax-M3"]);
    assert.ok(models[0].priority < models[1].priority);
    assert.ok(!models[0].supported_reasoning_levels.some((r) => r.effort === "none"));
  });

  for (const path of ["/v1/responses", "/v1/chat/completions"]) {
    await t.test(`${path}: omitted model uses Flash through real HTTP`, async () => {
      for (const key of ["fixture-locked", "fixture-any"]) {
        const response = await request(path, inputFor(path), key);
        assert.equal(response.status, 200, response.text);
        assert.equal(latest().model, flash);
        assert.equal(latest().reasoning_effort, undefined);
        assert.equal(latest().thinking, undefined);
        assert.equal(latest().service_tier, undefined);
        assert.equal(calls.at(-1).path, "/global/v1/chat/completions");
        assert.equal(calls.at(-1).authorization, "Bearer fixture-minimax");
      }
    });
    for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      await t.test(`${path}: Flash ${effort}`, async () => {
        const hint = path === "/v1/responses" ? { reasoning: { effort } } : { reasoning_effort: effort };
        const response = await request(path, { ...inputFor(path), model: flash, ...hint });
        assert.equal(response.status, 200, response.text);
        assert.equal(latest().reasoning_effort, effort === "minimal" ? "low" : effort);
        assert.notEqual(latest().thinking?.type, "disabled");
      });
    }
    await t.test(`${path}: reject unsupported Flash settings before upstream`, async () => {
      for (const option of [{ reasoning: { effort: "none" } }, { thinking: { type: "disabled" } },
        { service_tier: "priority" }, { reasoning_split: false }, { reasoning: { effort: "invalid" } }]) {
        const before = calls.length;
        const response = await request(path, { ...inputFor(path), model: flash, ...option });
        assert.equal(response.status, 400, response.text);
        assert.equal(calls.length, before);
      }
    });
    await t.test(`${path}: M3 supports disabled/adaptive without effort depth`, async () => {
      for (const effort of [undefined, "none", "low", "xhigh", "max"]) {
        const response = await request(path, { ...inputFor(path), model: "MiniMax-M3", reasoning: { effort } });
        assert.equal(response.status, 200, response.text);
        assert.equal(latest().model, "MiniMax-M3");
        assert.equal(latest().reasoning_effort, undefined);
        assert.equal(latest().thinking?.type, effort === undefined ? undefined : effort === "none" ? "disabled" : "adaptive");
      }
    });
    await t.test(`${path}: explicit M3 thinking takes precedence over depth hints`, async () => {
      const response = await request(path, { ...inputFor(path), model: "MiniMax-M3",
        thinking: { type: "disabled" }, reasoning: { effort: "high" } });
      assert.equal(response.status, 200, response.text);
      assert.deepEqual(latest().thinking, { type: "disabled" });
      assert.equal(latest().reasoning_effort, undefined);
    });
    await t.test(`${path}: saved legacy and explicit custom models are not reset`, async () => {
      for (const model of ["MiniMax-M2.7", "MiniMax-custom"]) {
        const response = await request(path, { ...inputFor(path), model, reasoning: { effort: "xhigh" } });
        assert.equal(response.status, 200, response.text);
        assert.equal(latest().model, model);
        assert.equal(latest().reasoning_effort, "high");
      }
    });
    await t.test(`${path}: streaming reaches the upstream`, async () => {
      const response = await request(path, { ...inputFor(path), stream: true });
      assert.equal(response.status, 200, response.text);
      assert.equal(latest().stream, true);
      assert.match(response.text, /Hello/);
    });
    await t.test(`${path}: other providers and provider lock remain unchanged`, async () => {
      const body = { ...inputFor(path), model: "deepseek-v4-pro", reasoning: { effort: "xhigh" } };
      assert.equal((await request(path, body)).status, 401);
      assert.equal((await request(path, body, "fixture-any")).status, 200);
      assert.equal(latest().model, "deepseek-v4-pro");
      assert.equal(latest().reasoning_effort, "xhigh");
      assert.equal(calls.at(-1).path, "/other/v1/chat/completions");
    });
  }

  await t.test("Chat Completions preserves media and complete tool history", async () => {
    const history = [
      { role: "user", content: [{ type: "text", text: "Inspect media" },
        { type: "image_url", image_url: { url: "data:image/png;base64,Zg==", detail: "high" } },
        { type: "video_url", video_url: { url: "mm_file://fixture", fps: 1 } }] },
      { role: "assistant", content: "<think>original</think>", reasoning_content: "reasoning", tool_calls: [
        { id: "call_media", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_media", content: "result" },
    ];
    assert.equal((await request("/v1/chat/completions", { model: flash, messages: history })).status, 200);
    assert.deepEqual(latest().messages, history);
  });

  await t.test("Responses preserves image/video parts through translation", async () => {
    const content = [{ type: "input_text", text: "Inspect media" },
      { type: "input_image", image_url: "data:image/png;base64,Zg==" },
      { type: "video_url", video_url: { url: "mm_file://fixture", fps: 1 } }];
    assert.equal((await request("/v1/responses", { model: flash,
      input: [{ role: "user", content }] })).status, 200);
    assert.deepEqual(latest().messages[0].content, [{ type: "text", text: "Inspect media" },
      { type: "image_url", image_url: { url: "data:image/png;base64,Zg==" } }, content[2]]);
  });

  for (const stream of [false, true]) {
    await t.test(`Responses tool history preserves reasoning and inline content (stream=${stream})`, async () => {
      const first = await request("/v1/responses", { model: flash, input: "request tool", stream,
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] });
      assert.equal(first.status, 200, first.text);
      const result = stream ? first.text.split("\n").filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice(6))).find((event) => event.type === "response.completed").response : first.json;
      const second = await request("/v1/responses", { model: flash, previous_response_id: result.id,
        input: [{ type: "function_call_output", call_id: "call_fixture", output: "result" }] });
      assert.equal(second.status, 200, second.text);
      const assistant = latest().messages.find((m) => m.tool_calls);
      assert.equal(assistant.reasoning_content, "keep separate reasoning");
      assert.equal(assistant.content, "<think>keep inline reasoning</think>Calling tool");
      assert.equal(assistant.tool_calls[0].id, "call_fixture");
      assert.ok(latest().messages.some((m) => m.role === "tool" && m.content === "result"));
      assert.equal(latest().previous_response_id, undefined);
    });
  }

  await t.test("configured regional URL and explicit model list remain supported", async (t) => {
    const request = await startProxy(t, { MINIMAX_BASE_URL: `http://127.0.0.1:${upstream.address().port}/cn/v1`,
      MINIMAX_MODELS: "saved-deployment,MiniMax-M2.7" });
    for (const path of ["/v1/responses", "/v1/chat/completions"]) {
      assert.equal((await request(path, inputFor(path))).status, 200);
      assert.equal(latest().model, "saved-deployment");
      assert.equal(calls.at(-1).path, "/cn/v1/chat/completions");
    }
    assert.deepEqual((await request("/v1/models")).json.data.filter((m) => m.owned_by === "minimax").map((m) => m.id),
      ["saved-deployment", "MiniMax-M2.7"]);
  });

  await t.test("explicit catalog controls routing and preserves custom entries", async (t) => {
    const request = await startProxy(t, { MODEL_CATALOG_PATH: "scripts/fixtures/minimax-catalog.json" });
    for (const path of ["/v1/responses", "/v1/chat/completions"]) {
      assert.equal((await request(path, inputFor(path))).status, 200);
      assert.equal(latest().model, "saved-catalog-deployment");
      assert.equal((await request(path, { ...inputFor(path), model: "MiniMax-M2.7" })).status, 200);
      assert.equal(latest().model, "MiniMax-M2.7");
    }
  });
});
