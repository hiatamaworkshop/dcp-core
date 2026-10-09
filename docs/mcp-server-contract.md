# MCP Server DCP Contract

How to build MCP tools that support compact output for AI agents — reducing token cost by 40-70% without breaking human-readable defaults.

This applies to **any MCP server** consumed by **any agent framework** (PicoClaw, Claude Code, Cursor, custom agents). The patterns here are not framework-specific.

## The problem

Most MCP tools return human-readable text:

```
[1] DCP formatter placement: OUT-side...
    hits=2 weight=-2.58 status=recent relevance=0.345
    tags: why, dcp, formatter, architecture
    id: a7b5dce9-...
```

Every field label (`hits=`, `weight=`, `status=`, `tags:`, `id:`) repeats per record. For 10 records, that's 10x overhead. The LLM pays for all of it, then extracts the same information that a positional array conveys in a fraction of the tokens:

```
["$S","engram-recall:v1",7,"id","relevance","summary","tags","hitCount","weight","status"]
["a7b5dce9","0.345","DCP formatter placement: OUT-side...","why,dcp,formatter,architecture",2,-2.58,"recent"]
```

Same data. 70% fewer tokens. The LLM reads both equally well.

## The contract: `queryType` parameter

Add a `queryType` parameter to any tool that returns structured data:

```typescript
server.tool("my_search", {
  query: z.string(),
  queryType: z.enum(["human", "agent"]).optional()
    .describe("'agent' returns DCP compact format. Default: 'human'."),
}, async ({ query, queryType }) => {
  const results = await search(query);

  if (queryType === "agent") {
    return { content: [{ type: "text", text: dcpEncode(results, schema) }] };
  }

  return { content: [{ type: "text", text: formatHuman(results) }] };
});
```

- `human` (default): verbose natural language. Compatible with everything.
- `agent`: DCP positional arrays. 40-70% token reduction.

The consumer decides. The LLM doesn't need to know — agent frameworks inject `queryType: "agent"` automatically via hooks or middleware.

## Schema design rules

### 1. Do not use `additionalProperties: false`

Agent frameworks inject parameters at runtime via hooks. If your schema blocks unexpected properties, injection fails.

```typescript
// BAD — blocks parameter injection
server.tool("my_tool", z.object({
  query: z.string(),
}).strict(), handler);  // .strict() = additionalProperties: false

// GOOD — allows parameter injection
server.tool("my_tool", z.object({
  query: z.string(),
  queryType: z.enum(["human", "agent"]).optional(),
}), handler);
```

Real failure mode: a `before_tool` hook injects `queryType: "agent"`, but the framework validates against the original schema and rejects the call with `"unexpected property"`. The tool never executes.

**Best practice:** Define `queryType` explicitly rather than relying on open schemas. This documents the capability and makes the tool self-describing.

### 2. Add `queryType` to every search/list tool

Not just the main query tool — any tool that returns structured data:

```typescript
const dcpParam = z.enum(["human", "agent"]).optional()
  .describe("'agent' returns DCP compact format. Default: 'human'.");

server.tool("my_pull",   { query: z.string(), queryType: dcpParam }, pullHandler);
server.tool("my_ls",     { tag: z.string().optional(), queryType: dcpParam }, lsHandler);
server.tool("my_status", { /* no queryType — small fixed payload */ }, statusHandler);
```

**Rule of thumb:** if the tool returns >5 records or >500 chars, it should accept `queryType`.

Tools with small, fixed-structure responses (status checks, config reads) don't need it — the overhead of adding DCP format exceeds the savings.

### 3. Handle null arguments

LLMs (Claude, GPT) sometimes send `null` instead of `{}` for tools with all-optional parameters. MCP SDKs often reject this:

```
Tool call: my_status(null)
MCP error: "expected record, received null"
```

Defend against this:

```typescript
// Option A: have at least one parameter with a default
server.tool("my_status", {
  projectId: z.string().optional().describe("Project filter"),
}, handler);  // LLM sends {} or {"projectId":"..."}, rarely null

// Option B: guard in handler
server.tool("my_status", {}, async (params) => {
  const args = params ?? {};
  // ...
});
```

### 4. Separate data format from output density

If your tool already has a `format` parameter for data format, don't overload it:

```typescript
server.tool("export", {
  format: z.enum(["json", "csv"]),       // what the data looks like
  queryType: z.enum(["human", "agent"]),  // how dense the output is
}, handler);
```

`format` controls structure. `queryType` controls verbosity. They're orthogonal.

## The DCP output format

When `queryType: "agent"`, return DCP positional arrays:

```typescript
import { dcpEncode } from "dcp-core";

const schema = { id: "my-results:v1", fields: ["id", "score", "title", "tags"] };

function formatAgent(results: Record<string, unknown>[]): string {
  return dcpEncode(results, schema);
}
```

Output:
```
["$S","my-results:v1",4,"id","score","title","tags"]
["abc",0.95,"Port conflict fix","docker,networking"]
["def",0.82,"Config path gotcha","config,paths"]
```

The `$S` header declares the schema once. Each row is a positional array — no key repetition. The LLM reads positional data as well as keyed JSON, at a fraction of the token cost.

If you don't want a dependency on dcp-core, format manually:

```typescript
function formatAgent(results: any[]): string {
  const header = `["$S","my-results:v1",${fields.length},${fields.map(f => `"${f}"`).join(",")}]`;
  const rows = results.map(r => JSON.stringify(fields.map(f => r[f] ?? null)));
  return [header, ...rows].join("\n");
}
```

## Why this matters

Without the `queryType` contract:
- External hooks can only observe text output, not compress it
- Every agent framework must parse every tool's text format independently
- Token costs scale linearly with output verbosity

With the `queryType` contract:
- One parameter, one convention across all MCP servers
- Agent frameworks inject it once — no per-tool configuration
- 40-70% token reduction, measured in production (engram MCP: 5649 → 1697 chars, 10 results)
- Human format stays default — nothing breaks for consumers that don't support DCP

## Checklist for MCP server authors

- [ ] Tools returning structured data accept `queryType: "human" | "agent"` parameter
- [ ] `human` is the default — omitting `queryType` returns human-readable text
- [ ] `agent` returns DCP positional arrays with `$S` header
- [ ] No `additionalProperties: false` / `.strict()` on tool schemas
- [ ] Null arguments handled gracefully (no crash on `null` params)
- [ ] `queryType` is separate from any existing `format` parameter

## References

- [DCP Specification](https://dcp-docs.pages.dev/dcp/specification) — full protocol design
- [dcp-core](https://github.com/hiatamaworkshop/dcp-core) — encoder/decoder library + CLI