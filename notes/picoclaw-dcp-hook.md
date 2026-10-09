# PicoClaw DCP Hook — Design Notes

## Discovery (2026-03-28)

PicoClaw has a modifiable `after_tool` hook that can transform tool output before it reaches the LLM. Out-of-process hooks communicate via JSON-RPC over stdio — any language works, including Node.js.

This means dcp-core can run as an external hook process. No Go port needed.

## Hook System

| Hook | Type | Modifiable |
|------|------|:----------:|
| before_llm | LLMInterceptor | yes |
| after_llm | LLMInterceptor | yes |
| before_tool | ToolInterceptor | yes |
| **after_tool** | **ToolInterceptor** | **yes** |
| approve_tool | ToolApprover | allow/deny |

Out-of-process hooks: JSON-RPC over stdio, configured via command + env + intercept array.

## Full DCP Pipeline via 4 Hooks

PicoClaw's hook system covers the complete DCP cycle. A single external Node.js process handles all four intercept points:

```
after_tool    → INPUT:  Tool JSON → DCP encode (token reduction)
before_llm    → CONTROL: Inject controller schema into prompt
                ("respond as [action,target,detail,cost]")
after_llm     → OUTPUT: Validate DCP compliance, cap non-conforming output
                + DCP decode → human-readable for messaging channels
before_tool   → (optional) Tool argument optimization
```

This maps directly to DCP specification concepts:
- after_tool  = Schema-Driven Encoder (System → AI)
- before_llm  = Shadow Index as Controller (output constraint)
- after_llm   = Cap (safety net) + Decode (DCP → human)

### Input side (after_tool)

```
Tool execution → JSON result
  → after_tool hook (Node.js external process)
    → if tool in dcp-enabled list: dcpEncode(result, schema)
    → else: pass through unchanged
  → LLM receives DCP (or original JSON)
```

Confirmed to reduce tokens. Same mechanism as engram MCP DCP integration.

### Output side (before_llm + after_llm)

```
before_llm: inject into system prompt or last message:
  "For task reports, respond as: [action(done|error|skip), target, detail, cost]"

LLM generates: ["done","/v1/auth","200 ok",42]

after_llm: validate output
  → if valid DCP array: decode → "Completed /v1/auth: 200 ok (42ms)"
  → if natural language: pass through (dialogue mode, no constraint)
  → if malformed array: cap → clamp to schema, then decode
```

The controller is only injected when the mode requires it (log, report, brief).
Dialogue mode = no controller = LLM speaks freely. This is DCP's principle:
constrain only when structured output is needed.

## Config Shape (tentative)

```json
{
  "command": "node",
  "args": ["path/to/dcp-hook.js"],
  "intercept": ["after_tool"],
  "env": {},
  "config": {
    "tools": {
      "mcp_engram_pull": { "id": "engram-recall:v1", "fields": ["id","relevance","summary","tags","hitCount","weight","status"] },
      "mcp_engram_ls": { "id": "engram-scan:v1", "fields": ["id","summary","tags","hitCount","weight","status"] },
      "web_search": "auto"
    }
  }
}
```

- Explicit schema: inline `{ id, fields }` per tool → uses dcpEncode directly
- `"auto"`: run SchemaGenerator on first batch, cache schema for subsequent calls
- Unlisted tools: pass through, no transformation

## What this enables

- DCP compression on any PicoClaw tool output, selectable per tool
- No modification to PicoClaw core
- dcp-core as the encoding engine (Node.js, already built)
- Particularly valuable on edge devices (Raspberry Pi) where token cost matters most

## Why PicoClaw is the ideal testbed

- 4 modifiable hooks = complete DCP pipeline without touching core
- Out-of-process JSON-RPC = Node.js/dcp-core works directly
- Edge devices (Raspberry Pi) = token cost is a real constraint, not theoretical
- 26K stars, active development = visibility for DCP if successful
- MCP native = engram DCP integration works out of the box

## Open Questions

- JSON-RPC message format for each hook: need to inspect PicoClaw source for exact payload shapes
- Schema caching: where to persist auto-generated schemas between hook invocations
- Controller injection format: how before_llm payload allows prompt modification
- Mode switching: how to signal dialogue vs report vs log mode (per-session? per-turn?)

## Dependencies

- PicoClaw v0.2.4+ (hook system)
- dcp-core (npm, already published)
- Node.js runtime on target device

## Status

Research complete. Implementation blocked on: verifying JSON-RPC payload format from PicoClaw source.
