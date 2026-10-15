import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeInput, fingerprintItem } from "./dedupe-input.mjs";

const msg = (role, text) => ({ type: "message", role, content: [{ type: "input_text", text }] });

test("case 1: 51 identical goal blocks collapse to 1, last position preserved", () => {
  const goal = '<codex_internal_context source="goal">\n解决重复问题\n</codex_internal_context>';
  const items = [];
  for (let i = 0; i < 50; i++) items.push(msg("user", goal));
  items.push(msg("user", "real question"));
  items.push(msg("user", goal)); // last copy

  const out = dedupeInput(items);
  const goalCount = out.items.filter((it) => it.content?.[0]?.text === goal).length;
  assert.equal(goalCount, 1, "goal block must be reduced to a single copy");
  assert.equal(out.items.length, 2, "one goal + one real question survive");
  assert.equal(out.items[1].content[0].text, goal, "surviving goal is the LAST occurrence");
  assert.equal(out.removed, 50);
  assert.equal(out.orphanOutputsDropped, 0);
});

test("case 2: duplicated function_call + output pairs kept paired, no orphans", () => {
  const fc = { type: "function_call", call_id: "call_A", name: "exec_command", arguments: '{"cmd":"ls"}' };
  const fo = { type: "function_call_output", call_id: "call_A", output: "" };
  const items = [fc, fo, fc, fo, fc, fo];
  const out = dedupeInput(items);
  const fcs = out.items.filter((it) => it.type === "function_call");
  const fos = out.items.filter((it) => it.type === "function_call_output");
  assert.equal(fcs.length, 1);
  assert.equal(fos.length, 1);
  assert.equal(fcs[0].call_id, "call_A");
  assert.equal(fos[0].call_id, "call_A");
  assert.equal(out.orphanOutputsDropped, 0);
});

test("case 3: distinct content is never removed", () => {
  const items = [
    msg("user", "alpha"),
    msg("assistant", "beta"),
    msg("user", "gamma"),
    msg("assistant", "delta"),
  ];
  const out = dedupeInput(items);
  assert.equal(out.removed, 0);
  assert.equal(out.items.length, 4);
  assert.deepEqual(out.items.map((i) => i.content[0].text), ["alpha", "beta", "gamma", "delta"]);
});

test("case 4: repeated identical user question collapses (documented tradeoff, visible in groups)", () => {
  const items = [msg("user", "how do I fix it?"), msg("assistant", "try X"), msg("user", "how do I fix it?")];
  const out = dedupeInput(items);
  const q = out.items.filter((it) => it.content?.[0]?.text === "how do I fix it?");
  assert.equal(q.length, 1, "identical repeats collapse to last only");
  assert.equal(out.removed, 1);
  assert.ok(out.groups.length >= 1, "collapse must be reported in groups for observability");
  assert.ok(out.groups[0].dropped >= 1);
});

test("case 5: orphan function_call_output (no matching function_call) is dropped", () => {
  const items = [
    { type: "function_call_output", call_id: "call_ghost", output: "" },
    msg("user", "hello"),
  ];
  const out = dedupeInput(items);
  assert.equal(out.items.length, 1);
  assert.equal(out.orphanOutputsDropped, 1);
  assert.equal(out.items[0].content[0].text, "hello");
});

test("case 6: empty input is handled safely", () => {
  assert.deepEqual(dedupeInput([]).items, []);
  assert.equal(dedupeInput([]).removed, 0);
  assert.deepEqual(dedupeInput(null).items, []);
});

test("case 7: fingerprinter distinguishes different tool arguments", () => {
  const a = { type: "function_call", call_id: "x", name: "exec_command", arguments: '{"cmd":"a"}' };
  const b = { type: "function_call", call_id: "y", name: "exec_command", arguments: '{"cmd":"b"}' };
  assert.notEqual(fingerprintItem(a), fingerprintItem(b));
});
