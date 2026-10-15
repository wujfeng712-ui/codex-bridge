// Conservative content-level de-duplication for Responses API `input` arrays.
//
// Motivation (evidence-backed):
//   Long Codex Desktop sessions accumulate the SAME boilerplate into `input`
//   over and over (e.g. the `<codex_internal_context source="goal">...` block
//   once per auto-continuation, plus one empty `function_call_output` per tool
//   round-trip). A real captured request contained 630 items of which only 238
//   were distinct: the goal block appeared 51 times and empty tool outputs 213
//   times. That redundancy is what the model then echoes back as "repetition".
//
// Design constraints (deliberately conservative):
//   * Only items whose FULL fingerprint is byte-identical are candidates.
//   * Of a duplicate group, only the LAST occurrence is kept and it stays in
//     its original position; earlier copies are dropped.
//   * Any item whose fingerprint occurs exactly once is always kept.
//   * Tool pairs are repaired afterwards: a `function_call_output` whose
//     `call_id` has no surviving `function_call` is dropped (no orphans), and a
//     `function_call` whose outputs were all dropped keeps its single output if
//     one survives, otherwise it is left untouched.
//   * Pure function. No globals, no I/O, so it can be unit-tested directly.

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part.text === "string") return part.text;
      if (part && typeof part.image_url === "string") return part.image_url;
      return "";
    })
    .join("\u0000");
}

export function fingerprintItem(item) {
  if (!item || typeof item !== "object") return "raw::" + String(item);
  const type = item.type || item.role || "?";
  if (item.type === "function_call") {
    return `function_call::${item.name || ""}::${item.arguments || ""}`;
  }
  if (item.type === "function_call_output") {
    return `function_call_output::${item.call_id || ""}::${textOf(item.output)}`;
  }
  if (item.type === "reasoning") {
    return `reasoning::${textOf(item.content) || item.summary || ""}`;
  }
  return `${type}::${item.role || ""}::${textOf(item.content)}`;
}

export function dedupeInput(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { items: items || [], removed: 0, groups: [], orphanOutputsDropped: 0 };
  }

  // Pass 1: count fingerprints.
  const counts = new Map();
  for (const item of items) {
    const fp = fingerprintItem(item);
    counts.set(fp, (counts.get(fp) || 0) + 1);
  }

  // Pass 2: walk backwards, keep the LAST occurrence of every duplicated
  // fingerprint, keep every singleton, preserve original order.
  const seen = new Set();
  const keepFlags = new Array(items.length).fill(false);
  for (let i = items.length - 1; i >= 0; i--) {
    const fp = fingerprintItem(items[i]);
    if (counts.get(fp) === 1) { keepFlags[i] = true; continue; }
    if (seen.has(fp)) continue;      // earlier duplicate -> drop
    seen.add(fp);
    keepFlags[i] = true;             // last occurrence -> keep
  }

  let kept = items.filter((_, i) => keepFlags[i]);
  const removed = items.length - kept.length;

  // Pass 3: repair tool pairing. Drop outputs whose call_id has no function_call.
  const callIds = new Set(
    kept.filter((it) => it && it.type === "function_call" && it.call_id).map((it) => it.call_id),
  );
  const beforeOrphan = kept.length;
  kept = kept.filter((it) => {
    if (it && it.type === "function_call_output" && it.call_id) return callIds.has(it.call_id);
    return true;
  });
  const orphanOutputsDropped = beforeOrphan - kept.length;

  // Report which fingerprints were collapsed, for observability.
  const groups = [];
  for (const [fp, n] of counts.entries()) {
    if (n > 1) groups.push({ fingerprint: fp.slice(0, 120), kept: 1, dropped: n - 1 });
  }
  groups.sort((a, b) => b.dropped - a.dropped);

  return { items: kept, removed, groups, orphanOutputsDropped };
}
