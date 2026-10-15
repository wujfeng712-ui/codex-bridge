# Case study: runaway duplication in proxied Responses-API history

**Symptom.** After a few dozen turns through `codex-bridge`, the model starts
echoing itself — repeating the same goal paragraph, emitting near-empty tool
calls, and eventually answering with a verbatim duplicate of something already
said. Latency and token usage climb every turn. Short sessions are fine; long
ones degrade monotonically.

**Status.** Fixed. Root cause, evidence, and the generalisable lesson below.

## TL;DR

The proxy de-duplicated its **outbound** prompt but persisted the **raw inbound**
history. The next turn rebuilt context from that stored copy, so the duplicates
came straight back and were re-stored — once per round-trip, forever. Dedupe was
working exactly as designed on a copy that nobody re-read, while the copy that
everyone re-read was never touched.

## How the duplication was produced

Two independent sources fed the loop:

1. **Auto-continuation re-sent the goal block once per turn.** A long-running
   Codex session re-injects an internal context block (the "goal") on each
   auto-continuation. Each injection is byte-identical to the last.
2. **Every tool round-trip appended an empty `function_call_output`.** Each
   `function_call` produced a companion output item even when the output was
   empty; those accumulated too.

A real captured request held **630 items, of which only 238 were distinct**
(goal block x51, empty tool outputs x213). Once that redundancy became visible to
the model, the model mirrored it — textual repetition is the model-side symptom
of a context-side problem.

## Why dedupe did not stop it

The relevant code path, before the fix:

```js
const originalInput = body.input;
body.input = dedupeInput(body.input);   // outbound copy: deduped
// ... forward to upstream ...
storeResponse(id, { input: originalInput, ... });   // persisted copy: RAW
```

`dedupeInput` ran on the request that went *out*. `storeResponse` wrote the array
that came *in*. Every subsequent turn with `previous_response_id` rehydrated
history out of the store:

```js
const chainItems = resolveResponseChain(body.previous_response_id);
body.input = [...chainItems, ...currentInput];   // duplicates, resurrected
```

...after which the freshly-reassembled (and still duplicated) array was stored
again. The proxy logged a healthy-looking line every turn —

```
[dedupe] deepseek: input 1211 -> 1199 (removed 11, orphan outputs 1)
```

— because the *outbound* number was genuinely shrinking. The stored number was
not, and it was the one that mattered. The growth was ~11 redundant items per
round-trip, compounding.

## The fix

Snapshot the deduped array at the moment it is final, and persist that:

```js
// after previous_response_id chain resolution
let dedupedInput = applyInputDedupe(body, provider);
// ... and in every storeResponse call ...
storeResponse(id, { input: dedupedInput, ... });
```

All five `storeResponse` call sites were changed. The upstream payload is
byte-identical to before — this is a persistence-only change.

`applyInputDedupe` is also fail-open by construction: any error leaves `body`
untouched, so de-duplication can never break an otherwise valid request.

## How it was verified

1. **Pure-function suite** — `node --test dedupe-input.test.mjs`, 7/7 passing:
   51 identical goal blocks collapse to 1 with the last position preserved;
   matched `function_call` / `function_call_output` pairs survive; orphan
   outputs are dropped; distinct content is never removed; empty input is safe;
   the fingerprinter distinguishes differing tool arguments.
2. **Isolated A/B on real code paths** — a mock upstream plus the real proxy
   module and the real response store, three turns with duplicated goal blocks
   and tool round-trips. Old code: persisted duplicate count 2/3/4, climbing.
   New code: 1/0/1/1, capped at one. Critically, the number of messages reaching
   the upstream was **identical** in both arms (3 -> 5 -> 5), proving nothing was
   dropped from the model's view to make the numbers look good.
3. **Live proxy** — restarted onto the fix, `[dedupe] ... -> ...` immediately
   followed by `stored response ...`, store entries showing a `call_id`
   uniqueness ratio of 1.000 with zero orphan outputs, and a real
   `POST /v1/responses` returning HTTP 200 with a clean stored entry.

## The takeaway

**When you de-duplicate outbound data, also de-duplicate what you persist.**
Any component that rebuilds context from a store is only as clean as the store.
A dedupe step that runs on a copy is not a dedupe step; it is a very convincing
illusion of one — complete with reassuring log output.

Two debugging habits that paid off here:

- **Trace the lifetime, not just the call.** The bug was invisible at the dedupe
  call site and invisible at the store call site. It only appears when you follow
  one item from inbound -> deduped -> forwarded -> stored -> rehydrated.
- **Compare a counter you trust against one you do not.** The `[dedupe]` log was
  trusted; the stored array length was not measured. Printing both side by side
  would have exposed the divergence on turn one.

## Caveats

- Existing sessions keep their already-accumulated history. The proxy no longer
  manufactures new duplicates, but it does not retroactively shrink the old ones.
  Starting a fresh session is the clean reset.
- The `x73`-style entries that look duplicated in a long store are usually
  **not** this bug: in the captured data, 74 such items contained only one
  byte-identical pair. They are distinct continuation contexts and do not grow
  per turn.
