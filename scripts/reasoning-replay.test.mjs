import assert from "node:assert/strict";

process.env.CODEX_BRIDGE_TEST = "1";
process.env.LOG_LEVEL = "silent";

const { __test } = await import("../proxy.mjs");
const {
  responseStore,
  storeResponse,
  responsesRequestToChatCompletions,
  applyDeepSeekToolRoundTripSafety,
} = __test;

responseStore.clear();

storeResponse("resp_active", {
  provider: "deepseek",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "active" }] }],
  output: [{
    type: "function_call",
    id: "fc_active",
    call_id: "call_same",
    name: "shell",
    arguments: "{\"cmd\":\"active\"}",
    status: "completed",
  }],
  previousResponseId: null,
  reasoningContent: "RIGHT_REASONING",
});

storeResponse("resp_other", {
  provider: "deepseek",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "other" }] }],
  output: [{
    type: "function_call",
    id: "fc_other",
    call_id: "call_same",
    name: "shell",
    arguments: "{\"cmd\":\"other\"}",
    status: "completed",
  }],
  previousResponseId: null,
  reasoningContent: "WRONG_REASONING",
});

const req = responsesRequestToChatCompletions({
  model: "deepseek-v4-pro",
  _resolved_previous_response_id: "resp_active",
  reasoning: { effort: "medium" },
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "active" }] },
    { type: "function_call", call_id: "call_same", name: "shell", arguments: "{\"cmd\":\"active\"}" },
    { type: "function_call_output", call_id: "call_same", output: "ok" },
  ],
}, "deepseek");

const assistantToolMessage = req.messages.find((message) => message.role === "assistant" && message.tool_calls);

assert.equal(assistantToolMessage?.reasoning_content, "RIGHT_REASONING");
assert.equal(req.thinking, undefined);
assert.equal(req.reasoning_effort, "medium");

const webFetchLoopReq = {
  model: "deepseek-v4-pro",
  messages: [
    { role: "user", content: "fetch this URL" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_web_fetch",
        type: "function",
        function: { name: "web_fetch", arguments: "{\"url\":\"http://localhost\"}" },
      }],
    },
    { role: "tool", tool_call_id: "call_web_fetch", content: "ok" },
  ],
  stream: false,
  reasoning_effort: "medium",
};

const disabled = applyDeepSeekToolRoundTripSafety(webFetchLoopReq, "test");
assert.equal(disabled, true);
assert.deepEqual(webFetchLoopReq.thinking, { type: "disabled" });
assert.equal(webFetchLoopReq.reasoning_effort, undefined);

console.log("reasoning replay tests passed");
