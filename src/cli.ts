#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { SchemaGenerator, formatReport } from "./generator.js";
import { DcpSchema } from "./schema.js";
import { FieldMapping } from "./mapping.js";
import { DcpEncoder } from "./encoder.js";

function readStdinSync(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function readInput(args: string[]): Record<string, unknown>[] {
  const samplesIdx = args.indexOf("--samples");
  const inputIdx = args.indexOf("--input");
  const fileIdx = samplesIdx !== -1 ? samplesIdx : inputIdx;

  let raw: string;
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    raw = readFileSync(args[fileIdx + 1], "utf-8");
  } else {
    raw = readStdinSync();
  }

  if (!raw.trim()) {
    console.error("Error: no input data. Pipe JSON or use --samples <file>");
    process.exit(1);
  }

  // Try JSON array first, then newline-delimited JSON
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object") {
      return parsed;
    }
  }

  // NDJSON
  const lines = trimmed.split("\n").filter((l) => l.trim());
  return lines.map((l) => JSON.parse(l));
}

function cmdInit(args: string[]): void {
  const domain = args[0];
  if (!domain) {
    console.error("Usage: dcp-core init <domain> [--samples file.json]");
    console.error("  e.g.: cat data.json | dcp-core init github-pr");
    process.exit(1);
  }

  const samples = readInput(args.slice(1));
  const gen = new SchemaGenerator();
  const draft = gen.fromSamples(samples, { domain });

  // Print report to stderr
  console.error(formatReport(draft));
  console.error("");

  // Save schema
  const outDir = "dcp-schemas";
  const schemaPath = join(outDir, `${domain}.v1.json`);
  const mappingPath = join(outDir, `${domain}.v1.mapping.json`);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(schemaPath, JSON.stringify(draft.schema, null, 2) + "\n", "utf-8");
  writeFileSync(mappingPath, JSON.stringify(draft.mapping, null, 2) + "\n", "utf-8");

  console.error(`Saved: ${schemaPath}`);
  console.error(`Saved: ${mappingPath}`);

  // Print schema to stdout
  console.log(JSON.stringify(draft.schema, null, 2));
}

function cmdEncode(args: string[]): void {
  const schemaIdx = args.indexOf("--schema");
  if (schemaIdx === -1 || !args[schemaIdx + 1]) {
    console.error("Usage: dcp-core encode --schema <schema.json> [--input file.json]");
    process.exit(1);
  }

  const schemaPath = args[schemaIdx + 1];
  const schema = DcpSchema.fromFile(schemaPath);

  // Try to load mapping from adjacent file
  const mappingPath = schemaPath.replace(".json", ".mapping.json");
  let mapping: FieldMapping;
  try {
    const mappingDef = JSON.parse(readFileSync(mappingPath, "utf-8"));
    mapping = new FieldMapping(mappingDef);
  } catch {
    // Auto-bind: assume field names match source keys
    const paths: Record<string, string> = {};
    for (const f of schema.fields) paths[f] = f;
    mapping = new FieldMapping({ schemaId: schema.id, paths });
  }

  const records = readInput(args);
  const encoder = new DcpEncoder(schema, mapping);
  const batch = encoder.encode(records);

  console.log(DcpEncoder.toString(batch));
}

function cmdInspect(args: string[]): void {
  const schemaPath = args[0];
  if (!schemaPath) {
    console.error("Usage: dcp-core inspect <schema.json>");
    process.exit(1);
  }

  const schema = DcpSchema.fromFile(schemaPath);
  console.log(`Schema: ${schema.id}`);
  console.log(`Fields: ${schema.fieldCount}`);
  console.log(`Header: ${JSON.stringify(schema.sHeader())}`);
  console.log("");
  for (let i = 0; i < schema.fields.length; i++) {
    const f = schema.fields[i];
    const t = schema.types[f];
    const typeStr = t
      ? Array.isArray(t.type) ? t.type.join("|") : t.type
      : "unknown";
    const extras: string[] = [];
    if (t?.enum) extras.push(`enum: ${JSON.stringify(t.enum)}`);
    if (t?.min != null) extras.push(`min: ${t.min}`);
    if (t?.max != null) extras.push(`max: ${t.max}`);
    const extStr = extras.length > 0 ? `  (${extras.join(", ")})` : "";
    console.log(`  [${i}] ${f}: ${typeStr}${extStr}`);
  }
}

// ── Main ───────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "init":
    cmdInit(args.slice(1));
    break;
  case "encode":
    cmdEncode(args.slice(1));
    break;
  case "inspect":
    cmdInspect(args.slice(1));
    break;
  default:
    console.error("dcp-core — Convert JSON to DCP positional-array format");
    console.error("");
    console.error("Commands:");
    console.error("  init <domain> [--samples file.json]   Infer schema from JSON samples");
    console.error("  encode --schema <file> [--input file]  Encode JSON to DCP");
    console.error("  inspect <schema.json>                  Show schema details");
    console.error("");
    console.error("Examples:");
    console.error("  cat api-response.json | dcp-core init github-pr");
    console.error("  cat data.json | dcp-core encode --schema dcp-schemas/github-pr.v1.json");
    console.error("");
    console.error("Learn more: https://dcp-docs.pages.dev");
    process.exit(command ? 1 : 0);
}
