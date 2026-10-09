# DCP Output Control — Claw-Type Agent Scenario

## Background

OpenClaw-style agents execute tasks on behalf of users via messaging apps (Signal, Telegram, etc). The agent performs many steps and reports results. Current output is unrestricted natural language — expensive and unnecessary for routine task reports.

## Insight

This is a rare case where **constraining AI output** makes sense. Task execution results (success/fail, status codes, counts) don't need LLM expressiveness. A DCP controller schema restricts the output to structured positional arrays.

```
Controller: ["action(done|error|skip)", "target", "detail", "cost"]

AI output:  ["done","/v1/auth","200 ok",42]
            ["error","/v1/orders","timeout",0]
```

Shadow Index layering applies: if the agent needs to explain something complex, the schema allows it (e.g. detail field as free-form). Routine reports stay compact.

## DCP Decode — First Real Use Case

Traditional DCP flow: encode (System) → DCP → AI consumes (no decode needed)

Claw-type flow: AI outputs DCP (controller-constrained) → DCP → **decode** → human reads

This reverses the direction. The decode step (DCP positional array → human-readable format) has no implementation yet because there was no demand. Claw-type agents create that demand.

## Decode is trivial

```
schema + row → key-value pairs → natural language template
["done","/v1/auth","200 ok",42] → "Completed /v1/auth: 200 ok (42ms)"
```

The schema already carries field names. Decode is a lookup, not inference.

## Why this matters for dcp-core

dcp-core currently covers: JSON → schema inference → DCP encode.

A future addition: DCP → decode → human-readable. This completes the round-trip. The decode function would be small — schema + row → object or formatted string.

## Status

Concept only. Depends on understanding claw-type agent internals and actual output patterns. Revisit when OpenClaw or similar tools are better understood.
