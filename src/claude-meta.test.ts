/**
 * claude-meta.test.ts
 *
 * ClaudeAdapter and ClaudeBrain record every call (stop_reason, token usage, block
 * types, latency) and hand it to onMeta, so a refusal or a max_tokens cut can be
 * counted instead of only showing up as a fallback string. Runs against a fake
 * client; no API key or network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ClaudeAdapter } from "./bot.js";
import { ClaudeBrain } from "./brain.js";
import type { ClaudeCallMeta } from "./claude-meta.js";
import type { LlmInput } from "./bot.js";
import type { BrainInput } from "./brain.js";
import type { IPacket } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

interface FakeReply {
  stop_reason: string;
  text?:       string;
  thinking?:   boolean;
  input?:      number;
  output?:     number;
}

/** Swap the adapter's private Anthropic client for one that returns canned replies. */
function fakeClient(target: object, replies: FakeReply[]): Record<string, unknown>[] {
  const requests: Record<string, unknown>[] = [];
  (target as { client: unknown }).client = {
    messages: {
      async create(params: Record<string, unknown>) {
        requests.push(params);
        const r = replies.shift()!;
        const content: unknown[] = [];
        if (r.thinking) content.push({ type: "thinking", thinking: "...", signature: "" });
        if (r.text !== undefined) content.push({ type: "text", text: r.text });
        return {
          id: "msg_test", type: "message", role: "assistant", model: params.model,
          content, stop_reason: r.stop_reason, stop_sequence: null,
          usage: { input_tokens: r.input ?? 100, output_tokens: r.output ?? 50 },
        };
      },
    },
  };
  return requests;
}

const LLM_INPUT: LlmInput = {
  profile:    { id: "p1", botId: "bot://1", model: "claude", weapons: [], trigger: { mode: "any" } },
  schemaId:   "s:v1",
  metrics:    { pass_rate: 0.42, fail: 29, total: 50, rowsPerSec: 3.1 },
  firedNames: ["low_pass"],
};

const PACKET: IPacket = { botId: "bot://1", schemaId: "s:v1", signal: "drop", severity: "high", context: null, ts: 0 };
const BRAIN_INPUT: BrainInput = { packets: [PACKET], quarantines: [] };

// ── ClaudeAdapter ─────────────────────────────────────────────────────────────

describe("ClaudeAdapter call record", () => {
  it("reports usage, block types and visible text length to onMeta", async () => {
    const seen: ClaudeCallMeta[] = [];
    const adapter = new ClaudeAdapter({ apiKey: "test", onMeta: (m) => seen.push(m) });
    const text = JSON.stringify({ signal: "pass rate fell", severity: "high" });
    fakeClient(adapter, [{ stop_reason: "end_turn", thinking: true, text, input: 120, output: 418 }]);

    const out = await adapter.infer(LLM_INPUT);

    assert.equal(out.severity, "high");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, "claude-haiku-5-5");
    assert.equal(seen[0].stopReason, "end_turn");
    assert.equal(seen[0].inputTokens, 120);
    assert.equal(seen[0].outputTokens, 418);
    assert.deepEqual(seen[0].contentBlockTypes, ["thinking", "text"]);
    assert.equal(seen[0].textLength, text.length);
    assert.ok(seen[0].latencyMs >= 0);
  });

  it("counts a refusal by stop_reason instead of hiding it in the fallback", async () => {
    const adapter = new ClaudeAdapter({ apiKey: "test" });
    const text = JSON.stringify({ signal: "ok", severity: "low" });
    fakeClient(adapter, [
      { stop_reason: "end_turn", text },
      { stop_reason: "refusal", output: 0 },
    ]);

    await adapter.infer(LLM_INPUT);
    const out = await adapter.infer(LLM_INPUT);

    assert.match(out.signal, /stop_reason=refusal/);
    const stats = adapter.stats();
    assert.equal(stats.calls, 2);
    assert.deepEqual(stats.stopReasons, { end_turn: 1, refusal: 1 });
    assert.equal(stats.last?.stopReason, "refusal");
  });

  it("a throwing onMeta does not break the call", async () => {
    const adapter = new ClaudeAdapter({ apiKey: "test", onMeta: () => { throw new Error("observer"); } });
    fakeClient(adapter, [{ stop_reason: "end_turn", text: JSON.stringify({ signal: "x", severity: "low" }) }]);
    const warn = console.warn;
    console.warn = () => {};
    try {
      const out = await adapter.infer(LLM_INPUT);
      assert.equal(out.signal, "x");
    } finally {
      console.warn = warn;
    }
  });
});

// ── ClaudeBrain ───────────────────────────────────────────────────────────────

describe("ClaudeBrain call record", () => {
  it("records a max_tokens cut and returns no decision", async () => {
    const seen: ClaudeCallMeta[] = [];
    const brain = new ClaudeBrain({ apiKey: "test", onMeta: (m) => seen.push(m) });
    fakeClient(brain, [{ stop_reason: "max_tokens", thinking: true, text: "{\"ratio", output: 16000 }]);

    const decision = await brain.evaluate(BRAIN_INPUT);

    assert.match(decision.rationale ?? "", /stop_reason=max_tokens/);
    assert.equal(seen[0].stopReason, "max_tokens");
    assert.equal(seen[0].outputTokens, 16000);
    assert.deepEqual(brain.stats().stopReasons, { max_tokens: 1 });
  });

  it("sends effort only with the default model", async () => {
    const byDefault = new ClaudeBrain({ apiKey: "test" });
    const custom    = new ClaudeBrain({ apiKey: "test", model: "claude-haiku-4-5" });
    const empty = JSON.stringify({ rationale: "nothing to do" });
    const r1 = fakeClient(byDefault, [{ stop_reason: "end_turn", text: empty }]);
    const r2 = fakeClient(custom,    [{ stop_reason: "end_turn", text: empty }]);

    await byDefault.evaluate(BRAIN_INPUT);
    await custom.evaluate(BRAIN_INPUT);

    assert.equal((r1[0].output_config as { effort?: string }).effort, "medium");
    assert.equal((r2[0].output_config as { effort?: string }).effort, undefined);
    assert.equal(custom.stats().last?.model, "claude-haiku-4-5");
  });
});
