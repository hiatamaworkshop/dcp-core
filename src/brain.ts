/**
 * brain.ts — Brain AI: pipeline control authority.
 *
 * Brain reads $I packets from IPool, evaluates across schemas and time,
 * and writes control decisions to PostBox outbound channel.
 *
 * Brain never enters the data pipeline. It is purely async and out-of-pipeline.
 *
 * Adapters:
 *   RuleBasedBrain  — deterministic, zero-latency (default)
 *   ClaudeBrain     — Haiku via Anthropic SDK
 *
 * Usage:
 *   // Rule-based (default)
 *   const brain = new Brain(ipool, postbox);
 *
 *   // Haiku
 *   const brain = new Brain(ipool, postbox, {
 *     adapter: new ClaudeBrain({ model: "claude-haiku-5-5" }),
 *   });
 */

import Anthropic from "@anthropic-ai/sdk";
import type { IPool } from "./i-pool.js";
import type { IPacket, AgentProfile } from "./types.js";
import type { PostBox, QuarantineApprovePayload, QuarantineRejectPayload, QuarantinePayload } from "./postbox.js";
import type { Monitor } from "./monitor.js";
import { ClaudeCallLog } from "./claude-meta.js";
import type { ClaudeCallMeta, ClaudeCallStats } from "./claude-meta.js";

// ── Brain adapter interface ───────────────────────────────────────────────────

export interface BrainInput {
  packets: IPacket[];                                      // drained from IPool
  quarantines: { pipelineId: string; payload: QuarantinePayload }[];  // pending quarantine items
}

/**
 * Brain decision — what Brain AI chooses to do.
 * All fields are optional: Brain may act on none, some, or all.
 */
export interface BrainDecision {
  /** Reroute a schema to a different pipeline. */
  rerouteSchema?: { schemaId: string; toPipelineId: string };
  /** Throttle a schema stream (rows/sec). */
  throttle?: { pipelineId: string; schemaId?: string; rps: number };
  /** Stop a pipeline or schema stream. */
  stop?: { pipelineId: string; schemaId?: string };
  /** Rewrite a Bot's AgentProfile (adjust weapon sensitivity). */
  updateProfile?: AgentProfile;
  /** Approve a quarantined record (optionally with correction). */
  quarantineApprove?: { pipelineId: string } & QuarantineApprovePayload;
  /** Reject a quarantined record. */
  quarantineReject?: { pipelineId: string } & QuarantineRejectPayload;
  /**
   * Replace the $V shadow constraints for a schema at runtime.
   * PipelineControl applies this to SchemaRegistry immediately —
   * next record processed uses the new constraints.
   */
  validationUpdate?: {
    pipelineId: string;
    schemaId: string;
    constraints: import("./validator.js").VConstraint extends never
      ? Record<string, unknown>
      : Record<string, import("./validator.js").VConstraint>;
  };
  /** Free-text rationale (logged, not acted on). */
  rationale?: string;
}

export interface BrainAdapter {
  evaluate(input: BrainInput): Promise<BrainDecision>;
}

// ── RuleBasedBrain ────────────────────────────────────────────────────────────

/**
 * RuleBasedBrain — deterministic default.
 *
 * Rules:
 *   any high severity   → stop the pipeline
 *   any medium severity → throttle to 10 rps
 *   all low / empty     → no action
 */
export class RuleBasedBrain implements BrainAdapter {
  async evaluate(input: BrainInput): Promise<BrainDecision> {
    const { packets, quarantines } = input;

    // ── Quarantine: approve all by default (re-inject as-is) ──────────────────
    // RuleBasedBrain has no semantic understanding — pass everything through.
    // Override with a custom adapter for domain-specific triage.
    const decision: BrainDecision = {};

    if (quarantines.length > 0) {
      // Process first quarantine only (one decision per tick)
      const q = quarantines[0];
      decision.quarantineApprove = {
        pipelineId: q.pipelineId,
        quarantineId: q.payload.quarantineId,
      };
    }

    if (packets.length === 0) return decision;

    const maxSeverity = packets.reduce<"low" | "medium" | "high">((max, p) => {
      if (p.severity === "high")                           return "high";
      if (p.severity === "medium" && max !== "high")       return "medium";
      return max;
    }, "low");

    const first = packets[0];

    if (maxSeverity === "high") {
      return {
        ...decision,
        stop: { pipelineId: `pipeline://default`, schemaId: first.schemaId },
        rationale: `[rule] high severity $I from bot=${first.botId} — stop schema stream`,
      };
    }
    if (maxSeverity === "medium") {
      return {
        ...decision,
        throttle: { pipelineId: `pipeline://default`, schemaId: first.schemaId, rps: 10 },
        rationale: `[rule] medium severity $I from bot=${first.botId} — throttle to 10 rps`,
      };
    }
    return { ...decision, rationale: `[rule] all low severity — no action` };
  }
}

// ── ClaudeBrain ───────────────────────────────────────────────────────────────

/**
 * Response schema enforced via structured outputs (output_config.format).
 * Every object needs additionalProperties: false, so correctedRecord travels
 * as a JSON-encoded string and is decoded in ClaudeBrain.evaluate().
 */
const BRAIN_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    rerouteSchema: {
      type: "object", additionalProperties: false,
      properties: { schemaId: { type: "string" }, toPipelineId: { type: "string" } },
      required: ["schemaId", "toPipelineId"],
    },
    throttle: {
      type: "object", additionalProperties: false,
      properties: { schemaId: { type: "string" }, rps: { type: "number" } },
      required: ["rps"],
    },
    stop: {
      type: "object", additionalProperties: false,
      properties: { schemaId: { type: "string" } },
      required: [],
    },
    quarantineApprove: {
      type: "object", additionalProperties: false,
      properties: {
        quarantineId:    { type: "string" },
        correctedRecord: { type: "string", description: "JSON-encoded corrected record, if the record needs fixing" },
      },
      required: ["quarantineId"],
    },
    quarantineReject: {
      type: "object", additionalProperties: false,
      properties: { quarantineId: { type: "string" }, reason: { type: "string" } },
      required: ["quarantineId", "reason"],
    },
    rationale: { type: "string" },
  },
} as const;

export interface ClaudeBrainOptions {
  model?:         string;
  apiKey?:        string;
  /** Domain-specific context injected at the top of every prompt. */
  systemContext?: string;
  /** The pipeline ID that control actions target. Filled in by code; the model never chooses it. */
  pipelineId?:   string;
  /**
   * Thinking depth (output_config.effort). Defaults to "medium" only with the default model;
   * with a custom model it is sent only when set, since older models (e.g. Haiku 4.5) reject it.
   */
  effort?:        "low" | "medium" | "high" | "max";
  /** Called after every completed API call (not one that throws) with its stop_reason, token usage and latency. */
  onMeta?:        (meta: ClaudeCallMeta) => void;
}

/**
 * ClaudeBrain — Haiku as Brain AI.
 *
 * Receives all drained $I packets, reasons across them,
 * and returns a structured BrainDecision.
 */
export class ClaudeBrain implements BrainAdapter {
  private readonly client:        Anthropic;
  private readonly model:         string;
  private readonly systemContext: string;
  private readonly pipelineId:    string;
  private readonly effort:        ClaudeBrainOptions["effort"];
  private readonly log:           ClaudeCallLog;

  constructor(options: ClaudeBrainOptions = {}) {
    this.client        = new Anthropic({ apiKey: options.apiKey });
    this.model         = options.model ?? "claude-haiku-5-5";
    this.systemContext = options.systemContext ?? "";
    this.pipelineId    = options.pipelineId   ?? "pipeline://default";
    this.effort        = options.effort       ?? (options.model ? undefined : "medium");
    this.log           = new ClaudeCallLog(options.onMeta);
  }

  /** Call count and stop_reason tally, so refusals and max_tokens cuts can be read back. */
  stats(): ClaudeCallStats {
    return this.log.stats();
  }

  async evaluate(input: BrainInput): Promise<BrainDecision> {
    const { packets, quarantines } = input;
    if (packets.length === 0 && quarantines.length === 0) return {};

    console.log(`[CLAUDE-BRAIN] evaluate called: packets=${packets.length} quarantines=${quarantines.length}`);

    // "observer" = the Bot that fired the signal. The action target pipeline is
    // not in the prompt: it is set from this.pipelineId after parsing.
    const packetSummary = packets.map((p) =>
      `- observer=${p.botId} | schema=${p.schemaId} | severity=${p.severity} | signal="${p.signal}"`,
    ).join("\n") || "(none)";

    const quarantineSummary = quarantines.map((q) =>
      `- quarantineId=${q.payload.quarantineId} | schema=${q.payload.schemaId} | reason=${q.payload.reason} | detail="${q.payload.detail}"`,
    ).join("\n") || "(none)";

    const prompt = [
      "You are a pipeline control authority (Brain AI).",
      "You receive inference signals ($I) from Bot observers and quarantined records.",
      "Based on the inputs below, decide what control action to take.",
      ...(this.systemContext ? ["", "## Domain context", this.systemContext] : []),
      "",
      "$I packets:",
      packetSummary,
      "",
      "Quarantined records (decide approve or reject for each):",
      quarantineSummary,
      "",
      "Available actions (omit fields you don't use):",
      JSON.stringify({
        rerouteSchema:    { schemaId: "<id>", toPipelineId: "pipeline://<id>" },
        throttle:         { schemaId: "<optional>", rps: 10 },
        stop:             { schemaId: "<optional>" },
        quarantineApprove: { quarantineId: "<id>", correctedRecord: "<optional>" },
        quarantineReject:  { quarantineId: "<id>", reason: "<explanation>" },
        rationale:        "<one sentence explanation>",
      }, null, 2),
    ].join("\n");

    const startedAt = Date.now();
    const msg = await this.client.messages.create({
      model:      this.model,
      // A ceiling, not a target: models that think by default count thinking toward it.
      max_tokens: 16000,
      messages:   [{ role: "user", content: prompt }],
      output_config: {
        ...(this.effort ? { effort: this.effort } : {}),
        format: { type: "json_schema", schema: BRAIN_DECISION_SCHEMA },
      },
    });
    this.log.record(this.model, msg, startedAt);

    // Schema-valid JSON is guaranteed only for a completed turn
    // (max_tokens truncates it; a refusal may not follow the schema).
    if (msg.stop_reason !== "end_turn") {
      return { rationale: `[claude-brain] no decision: stop_reason=${msg.stop_reason}` };
    }

    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    console.log(`[CLAUDE-BRAIN] response: ${text.slice(0, 300)}`);

    const decision = JSON.parse(text) as BrainDecision;
    // The target pipeline is fixed by configuration, not chosen by the model.
    for (const action of [decision.throttle, decision.stop, decision.quarantineApprove, decision.quarantineReject]) {
      if (action) action.pipelineId = this.pipelineId;
    }
    const corrected = decision.quarantineApprove?.correctedRecord;
    if (typeof corrected === "string") {
      try {
        decision.quarantineApprove!.correctedRecord = JSON.parse(corrected);
      } catch {
        delete decision.quarantineApprove!.correctedRecord;
      }
    }
    return decision;
  }
}

// ── Brain ─────────────────────────────────────────────────────────────────────

export interface BrainOptions {
  adapter?:          BrainAdapter;
  /** How often to drain IPool and evaluate (ms). Default: 2000 */
  intervalMs?:       number;
  /** Pipeline ID used as default target for control actions. Default: "pipeline://default" */
  pipelineId?:       string;
  /**
   * Canonical (holy scripture) adapter — deterministic, immutable reference.
   * When provided, Brain runs both this and the primary adapter in parallel,
   * emits $ST-brain divergence metrics via monitor, and passes the canonical
   * decision as context to the primary adapter on the next tick.
   */
  canonicalAdapter?: BrainAdapter;
  /** Monitor to emit $ST-brain messages on. Required when canonicalAdapter is set. */
  monitor?:          Monitor;
}

// ── Action kind classifier (for divergence comparison) ────────────────────────

type ActionKind = "rerouteSchema" | "throttle" | "stop" | "updateProfile"
  | "quarantineApprove" | "quarantineReject" | "validationUpdate" | "none";

function primaryAction(d: BrainDecision): ActionKind {
  if (d.rerouteSchema)     return "rerouteSchema";
  if (d.throttle)          return "throttle";
  if (d.stop)              return "stop";
  if (d.updateProfile)     return "updateProfile";
  if (d.quarantineApprove) return "quarantineApprove";
  if (d.quarantineReject)  return "quarantineReject";
  if (d.validationUpdate)  return "validationUpdate";
  return "none";
}

export class Brain {
  private readonly ipool:           IPool;
  private readonly postbox:         PostBox;
  private readonly adapter:         BrainAdapter;
  private readonly intervalMs:      number;
  private readonly pipelineId:      string;
  private readonly canonicalAdapter: BrainAdapter | null;
  private readonly monitor:         Monitor | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly quarantineBuffer: { pipelineId: string; payload: QuarantinePayload }[] = [];

  constructor(ipool: IPool, postbox: PostBox, options: BrainOptions = {}) {
    this.ipool            = ipool;
    this.postbox          = postbox;
    this.adapter          = options.adapter          ?? new RuleBasedBrain();
    this.intervalMs       = options.intervalMs       ?? 2000;
    this.pipelineId       = options.pipelineId       ?? "pipeline://default";
    this.canonicalAdapter = options.canonicalAdapter ?? null;
    this.monitor          = options.monitor          ?? null;

    // Subscribe to quarantine inbound — buffer until next tick
    this.postbox.subscribeInbound("quarantine", (msg) => {
      this.quarantineBuffer.push({
        pipelineId: msg.pipelineId,
        payload: msg.payload as QuarantinePayload,
      });
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Drain IPool and evaluate immediately (useful for testing / demos). */
  async flush(): Promise<BrainDecision> {
    return this.tick();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async tick(): Promise<BrainDecision> {
    const packets     = this.ipool.drain();
    const quarantines = this.quarantineBuffer.splice(0);
    const input       = { packets, quarantines };

    if (this.canonicalAdapter && this.monitor) {
      // Run canonical (holy scripture) and primary adapter in parallel
      const [canonicalDecision, decision] = await Promise.all([
        this.canonicalAdapter.evaluate(input),
        this.adapter.evaluate(input),
      ]);

      // Emit $ST-brain divergence metric
      const canonicalAction = primaryAction(canonicalDecision);
      const llmAction       = primaryAction(decision);
      const aligned         = canonicalAction === llmAction;
      this.monitor.emit({
        type:     "st_brain",
        schemaId: packets[0]?.schemaId ?? "*",
        ts:       Date.now(),
        priority: "batch",
        payload:  {
          aligned,
          canonicalAction,
          llmAction,
          packetCount: packets.length,
        },
      });

      // Primary adapter's decision takes effect
      this.apply(decision);
      return decision;
    }

    const decision = await this.adapter.evaluate(input);
    this.apply(decision);
    return decision;
  }

  private apply(decision: BrainDecision): void {
    if (decision.stop) {
      this.postbox.issueStop(decision.stop.pipelineId, decision.stop.schemaId);
    }
    if (decision.throttle) {
      this.postbox.issueThrottle(
        decision.throttle.pipelineId,
        decision.throttle.rps,
        decision.throttle.schemaId,
      );
    }
    if (decision.rerouteSchema) {
      const table = new Map([[decision.rerouteSchema.schemaId, decision.rerouteSchema.toPipelineId]]);
      this.postbox.issueRoutingUpdate(this.pipelineId, table);
    }
    if (decision.updateProfile) {
      this.postbox.issueAgentProfileUpdate(
        decision.updateProfile.botId,
        decision.updateProfile,
      );
    }
    if (decision.quarantineApprove) {
      const { pipelineId, ...payload } = decision.quarantineApprove;
      this.postbox.issueQuarantineApprove(pipelineId, payload);
    }
    if (decision.quarantineReject) {
      const { pipelineId, ...payload } = decision.quarantineReject;
      this.postbox.issueQuarantineReject(pipelineId, payload);
    }
    if (decision.validationUpdate) {
      const { pipelineId, schemaId, constraints } = decision.validationUpdate;
      this.postbox.issueValidationUpdate(pipelineId, schemaId, constraints);
    }
  }
}