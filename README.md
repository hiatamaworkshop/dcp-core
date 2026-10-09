# dcp-core

TypeScript implementation of [Data Cost Protocol (DCP)](https://dcp-docs.pages.dev) — compact structured data encoding for LLMs, plus a full pipeline control layer for high-throughput AI-driven data streams.

> Formerly published as `dcp-wrap` (up to 0.3.1). To migrate, replace `dcp-wrap` with `dcp-core` in your dependencies and imports, and `npx dcp-wrap` with `npx dcp-core`.

## Two things in one package

**1. DCP Encoder** — Convert JSON to positional-array format. 40–60% token reduction when feeding structured data to LLMs.

**2. Pipeline Control** — A complete streaming pipeline where the LLM never enters the data path. Schema validation (`$V`), routing (`$R`), statistics (`$ST`), and Brain AI decisions — all applied without pausing the stream.

See [dcp-docs.pages.dev](https://dcp-docs.pages.dev) for the full protocol design, and the [Minecraft Pipeline Demo](https://dcp-docs.pages.dev/demos/minecraft) for a working end-to-end example with measured latency numbers.

---

## DCP Encoding

Instead of sending `{"endpoint":"/v1/users","method":"GET","status":200}` per record, DCP declares the schema once and writes values by position:

```
["$S","api-response:v1","endpoint","method","status","latency_ms"]
["/v1/users","GET",200,42]
["/v1/orders","POST",201,187]
```

40–60% token reduction. Zero accuracy cost. See [benchmark](https://dcp-docs.pages.dev/dcp/specification#benchmark-dcp-vs-json-vs-natural-language).

## Install

```bash
npm install dcp-core
```

## CLI

### Infer schema from JSON

```bash
cat api-response.json | npx dcp-core init api-response
```

Output:
```
Schema: api-response:v1
Fields: 4

  endpoint: string (source: endpoint, unique: 4/4)
  method: string (source: method, unique: 2/4)  [enum(2)]
  status: number (source: status, unique: 2/4)
  latency_ms: number (source: latency_ms, unique: 4/4)

Saved: dcp-schemas/api-response.v1.json
Saved: dcp-schemas/api-response.v1.mapping.json
```

### Encode JSON to DCP

```bash
cat data.json | npx dcp-core encode --schema dcp-schemas/api-response.v1.json
```

Output:
```
["$S","api-response:v1","endpoint","method","status","latency_ms"]
["/v1/users","GET",200,42]
["/v1/orders","POST",201,187]
["/v1/auth","POST",200,95]
```

### Inspect a schema

```bash
npx dcp-core inspect dcp-schemas/api-response.v1.json
```

## Programmatic API

### Quick — one function, no files

```typescript
import { dcpEncode } from "dcp-core";

const dcp = dcpEncode(results, {
  id: "engram-recall:v1",
  fields: ["id", "relevance", "summary", "tags", "hitCount", "weight", "status"],
});
// ["$S","engram-recall:v1","id","relevance","summary","tags","hitCount","weight","status"]
// ["abc123",0.95,"port conflict fix","docker,gotcha",12,3.2,"fixed"]
```

Array fields are auto-joined with comma. Use `transform` for custom handling:

```typescript
const dcp = dcpEncode(records, schema, {
  transform: { relevance: (v) => +(v as number).toFixed(3) },
});
```

### Full — schema generation + encoding

```typescript
import { SchemaGenerator, DcpEncoder, DcpSchema, FieldMapping } from "dcp-core";

const gen = new SchemaGenerator();
const draft = gen.fromSamples(jsonRecords, { domain: "github-pr" });

const schema = new DcpSchema(draft.schema);
const mapping = new FieldMapping(draft.mapping);
const encoder = new DcpEncoder(schema, mapping);

const batch = encoder.encode(jsonRecords);
console.log(DcpEncoder.toString(batch));
```

## Nested JSON

Nested objects are automatically flattened via dot-notation:

```json
{"id": "pr-1", "metadata": {"author": "alice", "state": "open"}}
```

The generator maps `metadata.author` → `author`, `metadata.state` → `state`.

## Nested DCP (array-of-objects)

Arrays of objects are encoded using **`$N` references**:

```
["$S","user:v1","id","name","teams"]
["u001","Alice",["$N","user.teams:v1",["t01","Infra","lead"],["t02","Security","member"]]]
["u002","Bob",["$N","user.teams:v1",["t03","Frontend","member"]]]
["u003","Charlie",["$N","user.teams:v1"]]
```

---

## Pipeline Control

dcp-core includes a full streaming pipeline control layer. The core idea: **AI observes and reconfigures the pipeline from outside — it never enters the data path.**

```
IngestionBus
  → Preprocessor     ← structural validation → Quarantine
  → Gate ($V)        ← schema constraint validation → pass/fail
  → StCollector      ← rolling statistics → $ST-v (pass_rate, throughput)
  → Bot              ← anomaly detection → $I packets
  → Brain (2s tick)  ← BrainAdapter.evaluate() → BrainDecision
  → PostBox          ← routing_update / throttle / quarantine_approve
  → PipelineControl  ← applies to next row, zero downtime
```

### Key properties

- **Data path latency**: p50 = 45μs (ingest → Gate pass), measured
- **Control path**: Brain ticks every 2s — observes `$ST` metrics, issues decisions
- **Lazy Switching**: routing and validation changes apply to the next row, no pause, no restart (p50 = 63μs)
- **Self-healing**: when anomaly clears, Brain restores previous routing and `$V` automatically

### Brain AI interface

```typescript
import { Brain, RuleBasedBrain, ClaudeBrain } from "dcp-core";
import type { BrainAdapter, BrainInput, BrainDecision } from "dcp-core";

// Rule-based (no LLM)
class MyBrain implements BrainAdapter {
  async evaluate(input: BrainInput): Promise<BrainDecision> {
    if (input.packets.some(p => p.severity === "high")) {
      return { rerouteSchema: { schemaId: "events:v1", toPipelineId: "audit-pipeline" } };
    }
    return {};
  }
}

// Claude (Haiku) — drop-in replacement, same interface
const brain = new ClaudeBrain({ model: "claude-haiku-5-5" });

// Every API call reports stop_reason, token usage and latency; stats() tallies stop_reasons
const watched = new ClaudeBrain({ onMeta: (m) => console.log(m.stopReason, m.outputTokens) });
```

Switching between rule-based and LLM is a matter of which adapter you pass. The pipeline wiring is identical.

### Shadow layers

| Layer | Role |
|-------|------|
| `$V`  | Schema constraint validation — type, range, enum. Brain can tighten or relax constraints at runtime. |
| `$R`  | Routing table — Brain reroutes schemas to different downstream pipelines. |
| `$ST` | Windowed statistics — pass rate, fail count, throughput per schema (1s window by default). |

For the full protocol specification and design rationale, see [dcp-docs.pages.dev/dcp/pipeline](https://dcp-docs.pages.dev/dcp/pipeline).

### Working demo

The [Minecraft Pipeline Demo](https://dcp-docs.pages.dev/demos/minecraft) shows all three layers working together: anomaly detection, Brain rerouting, `$V` dynamic update, Quarantine approval — verified across three scenarios with no LLM required for the data path.

[dcp-lighthouse](https://dcp-docs.pages.dev/demos/lighthouse) is the reference implementation of an observation layer on top of this pipeline: it re-observes retained raw data through adjustable windows, and its anomaly gate reports its own false-alarm rate.

---

## Working with messy data

| Guard | Default | What it does |
|-------|---------|-------------|
| `maxDepth` | 3 | Stops flattening at 3 levels. |
| `maxFields` | 20 | Keeps top 20 fields by DCP priority. |
| `minPresence` | 0.1 | Fields appearing in less than 10% of samples are excluded. |

Override when needed:

```typescript
const draft = gen.fromSamples(samples, {
  domain: "some-api",
  maxDepth: 2,
  maxFields: 10,
  minPresence: 0.5,
});
```

## Design

- One runtime dependency, `@anthropic-ai/sdk`, used only by the Claude adapters (`ClaudeBrain`, `ClaudeAdapter`)
- Schema generation follows DCP field ordering convention (identifiers → classifiers → numerics → text)
- Supports JSON arrays and NDJSON as input
- Schema + mapping files are plain JSON — review, version, and edit them

## License

Apache-2.0
