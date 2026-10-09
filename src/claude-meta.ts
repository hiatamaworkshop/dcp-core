/**
 * claude-meta.ts — per-call record for the Claude adapters (ClaudeAdapter, ClaudeBrain).
 *
 * Without it a refusal or a max_tokens cut surfaces only as a fallback string, so it can be
 * neither counted nor told apart from a quiet model. Thinking counts toward outputTokens, so
 * the visible text length says nothing about how close a call came to max_tokens.
 */

import type Anthropic from "@anthropic-ai/sdk";

export interface ClaudeCallMeta {
  model:             string;
  stopReason:        string | null;
  inputTokens:       number;
  /** Includes thinking. */
  outputTokens:      number;
  contentBlockTypes: string[];
  textLength:        number;
  latencyMs:         number;
}

export interface ClaudeCallStats {
  calls:       number;
  /** Count per stop_reason, e.g. { end_turn: 12, refusal: 1 }. */
  stopReasons: Record<string, number>;
  last?:       ClaudeCallMeta;
}

export class ClaudeCallLog {
  private calls = 0;
  private readonly stopReasons: Record<string, number> = {};
  private last?: ClaudeCallMeta;

  constructor(private readonly onMeta?: (meta: ClaudeCallMeta) => void) {}

  record(model: string, msg: Anthropic.Message, startedAt: number): void {
    const meta: ClaudeCallMeta = {
      model,
      stopReason:        msg.stop_reason,
      inputTokens:       msg.usage.input_tokens,
      outputTokens:      msg.usage.output_tokens,
      contentBlockTypes: msg.content.map((b) => b.type),
      textLength:        msg.content.reduce((n, b) => n + (b.type === "text" ? b.text.length : 0), 0),
      latencyMs:         Date.now() - startedAt,
    };
    this.calls++;
    const key = meta.stopReason ?? "null";
    this.stopReasons[key] = (this.stopReasons[key] ?? 0) + 1;
    this.last = meta;
    // A failing observer must not take the decision path down with it.
    try {
      this.onMeta?.(meta);
    } catch (err) {
      console.warn("[claude-meta] onMeta threw:", err);
    }
  }

  stats(): ClaudeCallStats {
    return { calls: this.calls, stopReasons: { ...this.stopReasons }, last: this.last };
  }
}
