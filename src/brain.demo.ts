/**
 * brain.demo.ts — Full pipeline + Bot + Brain demo
 *
 * Run: node dist/brain.demo.js
 *
 * Flow:
 *   mock_data_dirty.json
 *     → Preprocessor → Gate → StCollector → $ST
 *     → Bot(RuleBasedLlm) → $I → IPool
 *     → Brain(RuleBasedBrain).flush() → decision → PostBox outbound
 *
 * To use Haiku:
 *   const brain = new Brain(ipool, postbox, {
 *     adapter: new ClaudeBrain({ model: "claude-haiku-5-5" }),
 *   });
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SchemaRegistry } from "./registry.js";
import { PostBox } from "./postbox.js";
import { RoutingLayer } from "./router.js";
import { SimpleMonitor, MessagePool } from "./monitor.js";
import { PipelineControl } from "./pipeline-control.js";
import { StCollector } from "./st-collector.js";
import { Preprocessor } from "./preprocessor.js";
import { SchemaCache } from "./schema-cache.js";
import { JSONAdapter } from "./adapters/json-adapter.js";
import { Gate } from "./gate.js";
import { IPool } from "./i-pool.js";
import { Bot } from "./bot.js";
import { Brain } from "./brain.js";
import type { DcpSchemaDef, AgentProfile } from "./types.js";
import type { QuarantinePayload } from "./postbox.js";
import type { StVRow, StFRow } from "./st-collector.js";

const __dir    = dirname(fileURLToPath(import.meta.url));
const dataPath = join(__dir, "..", "tests", "mock_data_dirty.json");

// ── 1. Schema ─────────────────────────────────────────────────────────────────

const SCHEMA: DcpSchemaDef = {
  $dcp: "schema",
  id: "knowledge-entry:v1",
  description: "Knowledge base entry",
  fields: ["summary", "tags", "content", "flags", "importance"],
  fieldCount: 5,
  types: {
    summary:    { type: ["string", "null"] },
    tags:       { type: "array" },
    content:    { type: "string" },
    flags:      { type: "int",    min: 0 },
    importance: { type: "number", min: 0, max: 1 },
  },
};

// ── 2. Bot AgentProfile ───────────────────────────────────────────────────────

const PROFILE: AgentProfile = {
  id:     "profile-quality-watcher:v1",
  botId:  "bot-quality-watcher",
  model:  "rule-based",
  weapons: [
    { name: "low_pass_rate", metric: "pass_rate", op: "<",  threshold: 0.9, weight: 1.0 },
    { name: "high_fail",     metric: "fail",      op: ">",  threshold: 2,   weight: 0.5 },
    { name: "slow_flow",     metric: "rowsPerSec",op: "<",  threshold: 5,   weight: 0.3 },
  ],
  trigger: { mode: "any" },
  schemaScope: ["knowledge-entry:v1"],
  llmPromptHint: "This is a knowledge base ingestion pipeline.",
};

// ── 3. Wire components ────────────────────────────────────────────────────────

const registry = new SchemaRegistry();
registry.register(SCHEMA);

const monitor = new SimpleMonitor();
const postbox = new PostBox();
const router  = new RoutingLayer(new MessagePool(), { receive: () => {} });
const ctrl    = new PipelineControl("pipeline://demo-01", postbox, router);

const gate      = new Gate(registry, { defaultMode: "flag", monitor });
gate.onSchemaHeader(SCHEMA.id);

const collector = new StCollector(monitor, { windowMs: 500 });
const ipool     = new IPool({ capacity: 64 });
const bot       = new Bot(monitor, postbox, ipool, PROFILE);
const brain     = new Brain(ipool, postbox, { pipelineId: "pipeline://demo-01" });
// Haiku swap:
// const brain = new Brain(ipool, postbox, {
//   adapter: new ClaudeBrain({ model: "claude-haiku-5-5" }),
//   pipelineId: "pipeline://demo-01",
// });

const pre = new Preprocessor(new JSONAdapter("$schema"), new SchemaCache(registry), postbox, ctrl, {
  pipelineId: "pipeline://demo-01",
});

// ── 4. Observe PostBox outbound (Brain AI decisions) ──────────────────────────

postbox.subscribeOutbound("*", (msg) => {
  console.log(`\n[BRAIN→] type=${msg.type}  pipeline=${msg.pipelineId}`);
  console.log(`         payload=${JSON.stringify(msg.payload)}`);
});

// ── 5. $ST log ────────────────────────────────────────────────────────────────

monitor.subscribe("st_v", (msg) => {
  const [, schemaId, pass, fail, total, passRate] = msg.payload as StVRow;
  console.log(`\n[$ST-v] schema=${schemaId}  pass=${pass}  fail=${fail}  total=${total}  pass_rate=${passRate}`);
});

monitor.subscribe("st_f", (msg) => {
  const [, schemaId, rowsPerSec] = msg.payload as StFRow;
  console.log(`[$ST-f] schema=${schemaId}  rowsPerSec=${rowsPerSec}`);
});

// ── 6. Preprocessor → Gate bridge ────────────────────────────────────────────

let passed = 0, quarantined = 0, dropped = 0;
let rowIndex = 0;

pre.onPass((array, schemaId) => {
  passed++;
  const entry = registry.get(schemaId);
  if (!entry) return;
  // array is already positional — normalize null values to "-"
  const row = array.map((v) => {
    if (v == null) return "-";
    if (Array.isArray(v)) return v.join(",") || "-";
    return v;
  });
  gate.process(schemaId, entry.schema.fields, row, rowIndex++);
});

pre.onDrop((_record, _reason) => { dropped++; });

postbox.subscribeInbound("quarantine", (msg) => {
  const q = msg.payload as QuarantinePayload;
  quarantined++;
  const record = q.record as Record<string, unknown>;
  if (q.reason === "missing_field") {
    postbox.issueQuarantineApprove(msg.pipelineId, {
      quarantineId: q.quarantineId,
      correctedRecord: { ...record, $schema: "knowledge-entry:v1", flags: 0, importance: 0.5 },
    });
  } else if (q.reason === "type_mismatch" || q.reason === "range_violation") {
    postbox.issueQuarantineApprove(msg.pipelineId, { quarantineId: q.quarantineId });
  } else {
    postbox.issueQuarantineReject(msg.pipelineId, { quarantineId: q.quarantineId, reason: `cannot fix: ${q.reason}` });
  }
});

// ── 7. Process records ────────────────────────────────────────────────────────

const records = JSON.parse(readFileSync(dataPath, "utf-8")) as unknown[];
console.log(`\n=== Brain demo — ${records.length} records ===\n`);

collector.start();
bot.start();

for (const record of records) {
  let toProcess: unknown;
  if (record !== null && typeof record === "object" && !Array.isArray(record) && !("$schema" in (record as object))) {
    toProcess = { ...(record as Record<string, unknown>), $schema: "knowledge-entry:v1" };
  } else {
    toProcess = record;
  }
  pre.process(toProcess as Record<string, unknown>);
}

// ── 8. Stop — flush $ST → Bot → Brain ────────────────────────────────────────

setTimeout(async () => {
  collector.stop();   // $ST-v / $ST-f emitted synchronously → Bot evaluates
  bot.stop();

  console.log(`\n[$I pool] ${ipool.length} packet(s) ready`);

  const decision = await brain.flush();   // drain IPool → Brain decides → PostBox outbound
  brain.stop();

  console.log(`\n[BRAIN decision]`);
  console.log(`  rationale : ${decision.rationale ?? "(none)"}`);
  if (decision.stop)         console.log(`  stop      : pipeline=${decision.stop.pipelineId}  schema=${decision.stop.schemaId ?? "*"}`);
  if (decision.throttle)     console.log(`  throttle  : pipeline=${decision.throttle.pipelineId}  rps=${decision.throttle.rps}`);
  if (decision.rerouteSchema)console.log(`  reroute   : ${decision.rerouteSchema.schemaId} → ${decision.rerouteSchema.toPipelineId}`);
  if (decision.updateProfile)console.log(`  ap_update : bot=${decision.updateProfile.botId}`);

  console.log(`
=== Summary ===
  Total input  : ${records.length}
  PASS (pre)   : ${passed}
  QUARANTINE   : ${quarantined}
  DROP         : ${dropped}
  $I packets   : ${ipool.length + (decision.stop || decision.throttle ? 1 : 0)}
`);
}, 700);