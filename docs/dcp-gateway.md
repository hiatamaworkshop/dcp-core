# DCP Gateway — MCP Transparent Compression Proxy

A generic proxy that sits between any MCP client and any MCP server, automatically compressing tool responses into DCP positional arrays. No server modification required. No client configuration beyond pointing at the gateway.

```
MCP Client (Claude Code, Cursor, custom agent)
  │
  ▼
┌──────────────────────────┐
│       DCP Gateway        │
│                          │
│  tools/list  → compress tool definitions
│  tools/call  → intercept JSON response → DCP encode
│  schema cache + TTL      │
│  preset loader           │
└──────────────────────────┘
  │
  ▼
MCP Server (any — engram, GitHub, DB, Slack, ...)
```

## Problem

MCP servers return JSON. Every record repeats the same keys:

```json
[
  {"id":"abc","score":0.95,"title":"Port conflict fix","tags":["docker"]},
  {"id":"def","score":0.82,"title":"Config path gotcha","tags":["config"]},
  {"id":"ghi","score":0.71,"title":"Build cache issue","tags":["ci"]}
]
```

The LLM pays for every repeated `"id"`, `"score"`, `"title"`, `"tags"`. For 10 records, that's 10x key overhead. The LLM extracts the same information from a positional array at a fraction of the token cost.

The gateway eliminates this overhead transparently — the server doesn't know, the client doesn't care.

## How it works

### Phase 1: Schema learning (first call)

```
Client → tools/call("search", {query: "docker"}) → Gateway → Server
Server → JSON response → Gateway

Gateway:
  1. Pass JSON response to Client unchanged
  2. Feed JSON to SchemaGenerator (no LLM, pure structure analysis)
  3. Cache: tool="search" → schema {id, fields, mapping}
```

The first call is a pass-through. The gateway observes the response structure and prepares an encoder for next time.

### Phase 2: DCP encoding (subsequent calls)

```
Client → tools/call("search", {query: "port"}) → Gateway → Server
Server → JSON response → Gateway

Gateway:
  1. Encode JSON → DCP using cached schema
  2. Return DCP to Client

     ["$S","search-result:v1",4,"id","score","title","tags"]
     ["abc",0.95,"Port conflict fix","docker"]
     ["def",0.82,"Config path gotcha","config"]
```

40-70% token reduction. Every call after the first.

### Phase 3: Tool definition compression

```
Client → tools/list → Gateway → Server
Server → tool definitions (name, description, parameters) → Gateway

Gateway:
  1. Strip JSON Schema meta-fields ($schema, additionalProperties)
  2. Shorten verbose descriptions
  3. Drop parameter descriptions that restate the key name
  4. Return compressed definitions to Client
```

~19% reduction on tool definitions. This runs on every LLM turn — tool definitions ship with every request.

## Schema cache

Each tool's inferred schema is cached with a TTL:

```
schema_cache {
  tool_name:   string        // "mcp_engram_engram_pull"
  schema:      DcpSchema     // {id, fields, mapping}
  last_used:   timestamp     // updated on every hit
  hit_count:   number        // lifetime usage
  ttl:         duration      // default: 30 days
}
```

- **Used tools**: `last_used` refreshes on every call → TTL resets → schema lives indefinitely
- **Unused tools**: TTL expires → schema evicted → next call triggers re-inference
- **Schema drift**: if JSON structure changes (new fields, type mismatch), gateway detects and re-infers

No manual cleanup. No unbounded growth. The cache self-regulates.

## Presets — first-call DCP

The schema learning phase means the first call returns uncompressed JSON. For known MCP servers, presets eliminate this warm-up:

```
presets/
  github.json        # GitHub MCP server schemas
  engram.json        # engram MCP server schemas
  filesystem.json    # filesystem MCP server schemas
  custom/
    my-api.json      # user-defined presets
```

Preset format:

```json
{
  "server": "github",
  "tools": {
    "search_repositories": {
      "id": "gh-repo-search:v1",
      "fields": ["full_name", "description", "stars", "language", "updated_at"]
    },
    "list_issues": {
      "id": "gh-issues:v1",
      "fields": ["number", "title", "state", "labels", "author", "created_at"]
    }
  }
}
```

With a preset loaded, the gateway DCP-encodes from the very first call. Presets are external files — add, remove, or update without rebuilding.

Presets can be contributed by the community. If you use an MCP server regularly, export its schema and share it.

## What gets compressed, what doesn't

| Response type | Gateway action | Why |
|---|---|---|
| JSON array of objects | DCP encode | Repeated keys eliminated — maximum savings |
| Nested objects (e.g. `profile.preferences.theme`) | Flatten to top-level columns | Dot-path resolved at encoding time |
| Array-of-objects fields (e.g. `teams`, `recent_activity`) | Nested `$S` encode | Sub-schema generated per field; items become positional rows |
| Single JSON object | DCP encode if >5 fields | Smaller objects have negligible overhead |
| Plain text | Pass through | Not structured — nothing to compress |
| Error response | Pass through | Errors must be readable as-is |
| Binary / base64 | Pass through | Not text — DCP doesn't apply |

The gateway never breaks a response. If encoding fails or the response isn't JSON, it passes through unchanged.

### Nested DCP encoding

The encoder converts array-of-objects fields using `$N` references. Sub-schemas are stored in the schema cache as `nestSchemas`, not repeated in every output:

```
["$S","search_users:v1","id","name","role","teams","recent_activity"]
["u001","Alice","admin",
  ["$N","search_users.teams:v1",
   ["t01","Infrastructure","lead"],
   ["t02","Security","member"]],
  ["$N","search_users.recent_activity:v1",
   ["deploy",{"env":"production","version":"2.1.0"},"api-v2","2026-03-28T14:30:00Z"]]]
["u003","Charlie","user",
  ["$N","search_users.teams:v1"],
  ["$N","search_users.recent_activity:v1"]]
```

The schema cache entry for `search_users` contains the full `nestSchemas`:

```json
{
  "$dcp": "schema",
  "id": "search_users:v1",
  "nestSchemas": {
    "teams": { "schema": { "id": "search_users.teams:v1", "fields": ["id","name","role"], ... }, "mapping": ... },
    "recent_activity": { "schema": { "id": "search_users.recent_activity:v1", "fields": ["action","metadata","target","timestamp"], ... }, "mapping": ... }
  }
}
```

This fits the gateway's existing flow naturally:
1. **Phase 1** (first call): `SchemaGenerator.fromSamples()` infers root schema + `nestSchemas` → cached together
2. **Phase 2** (subsequent): `DcpEncoder` reads `nestSchemas` from the cached schema → emits `$N` references

Key design decisions:
- **Sub-schema depth is capped at 0** (top-level fields only within nested objects). Heterogeneous nested objects (e.g. variable `metadata` keys) stay as opaque JSON to avoid sparse column explosion.
- **Empty arrays** → `["$N", "schema-id"]` with no rows. Type information preserved via schema ID.
- **Static vs dynamic**: The gateway uses static `nestSchemas` (stored in cache). A dynamic alternative (inline `$S` preamble before the main header) was also implemented and may be useful for standalone/streaming scenarios where no schema cache exists.

## Transport

MCP uses two transports:

| Transport | Gateway acts as | Implementation |
|---|---|---|
| **stdio** | Pipe relay — reads server stdout, writes to client stdin | Spawn child process, intercept streams |
| **SSE** | HTTP proxy — POST to server, SSE to client | HTTP middleware |

Both transports carry the same JSON-RPC messages. The gateway's DCP logic is transport-agnostic — it operates on the parsed JSON-RPC layer.

### stdio configuration

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["dcp-gateway", "--server", "node", "path/to/mcp-server.js"]
    }
  }
}
```

From the client's perspective, `dcp-gateway` is the MCP server. The gateway spawns the real server as a child process.

### SSE configuration

```json
{
  "mcpServers": {
    "my-server": {
      "url": "http://localhost:3200/sse",
      "note": "DCP gateway proxying to upstream MCP server at :3100"
    }
  }
}
```

## Metrics

The gateway tracks compression statistics per tool:

```
dcp-gateway stats:

  engram_pull:    87 calls, avg 68% reduction, schema: engram-recall:v1
  github_search:  23 calls, avg 52% reduction, schema: gh-search:v1
  db_query:       156 calls, avg 71% reduction, schema: db-rows:v1
  web_fetch:      12 calls, pass-through (plain text)

  Total saved: ~2.4M tokens (estimated)
```

These metrics serve two purposes:
1. **User visibility** — prove the gateway is doing something useful
2. **DCP validation** — real-world compression ratios across diverse MCP servers

## Scope and non-goals

**What the gateway does:**
- Transparent DCP compression of MCP tool responses
- Tool definition compression via tools/list interception
- Schema learning, caching, and preset loading
- Compression metrics

**What the gateway does not do:**
- Authentication, authorization, or token forwarding (the MCP gateway spec's primary concern)
- Session management or affinity
- Data loss prevention or content inspection
- Modification of tool call arguments (no queryType injection — server-agnostic means server-unaware)
- LLM system prompt or output control (outside MCP protocol scope)

The gateway is a compression layer, not a security layer. It can coexist with an enterprise MCP gateway that handles auth and audit — DCP gateway handles efficiency, enterprise gateway handles governance.

## Relation to existing work

| Component | Role |
|---|---|
| **dcp-core** | Library — `dcpEncode()`, `SchemaGenerator`, CLI. The engine inside the gateway. |
| **mcp-server-contract.md** | Convention for MCP servers that natively support DCP via `queryType`. Ideal but requires server modification. |
| **picoclaw-hook** | Framework-specific hook (PicoClaw only). Proof of concept for the gateway pattern. |
| **DCP Gateway** | Framework-agnostic proxy. Works with any MCP server, no modification needed. Generalizes what picoclaw-hook proved. |

The gateway uses dcp-core internally. If an MCP server already supports `queryType: "agent"`, the gateway can inject it — but this is optional optimization, not a requirement.

## Implementation plan

### Phase 1: stdio proxy + response encoding
- Spawn MCP server as child process
- Relay JSON-RPC messages
- Intercept `tools/call` responses → SchemaGenerator → DCP encode
- Schema cache with TTL

### Phase 2: tools/list compression + presets
- Intercept `tools/list` → compress descriptions and schemas
- Load preset files at startup
- Preset file format and community contribution model

### Phase 3: SSE transport + metrics
- HTTP proxy mode for SSE-based MCP servers
- Per-tool compression statistics
- Stats endpoint or CLI command

### Phase 4: multi-server aggregation
- Single gateway fronting multiple MCP servers
- Unified schema cache across all backends
- Client sees one MCP endpoint with all tools available