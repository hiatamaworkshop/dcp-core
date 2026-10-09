import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SchemaGenerator } from "./generator.js";
import { DcpSchema } from "./schema.js";
import { DcpEncoder } from "./encoder.js";
import { FieldMapping } from "./mapping.js";

const userSamples = [
  {
    id: "u001",
    name: "Alice Johnson",
    email: "alice@example.com",
    role: "admin",
    score: 95,
    active: true,
    profile: {
      bio: "Platform engineer, 10 years experience",
      avatar_url: "https://cdn.example.com/avatars/alice.png",
      preferences: {
        theme: "dark",
        locale: "en-US",
        notifications: { email: true, push: false, sms: false },
      },
    },
    teams: [
      { id: "t01", name: "Infrastructure", role: "lead" },
      { id: "t02", name: "Security", role: "member" },
    ],
    recent_activity: [
      {
        action: "deploy",
        target: "api-v2",
        timestamp: "2026-03-28T14:30:00Z",
        metadata: { env: "production", version: "2.1.0" },
      },
      {
        action: "review",
        target: "PR#412",
        timestamp: "2026-03-27T09:15:00Z",
        metadata: { verdict: "approved" },
      },
    ],
  },
  {
    id: "u002",
    name: "Bob Smith",
    email: "bob@example.com",
    role: "user",
    score: 72,
    active: true,
    profile: {
      bio: "Junior dev, learning the ropes",
      avatar_url: "https://cdn.example.com/avatars/bob.png",
      preferences: {
        theme: "light",
        locale: "ja-JP",
        notifications: { email: true, push: true, sms: false },
      },
    },
    teams: [{ id: "t03", name: "Frontend", role: "member" }],
    recent_activity: [
      {
        action: "commit",
        target: "feature/navbar",
        timestamp: "2026-03-28T16:00:00Z",
        metadata: { files_changed: 3 },
      },
    ],
  },
  {
    id: "u003",
    name: "Charlie Brown",
    email: "charlie@example.com",
    role: "user",
    score: 88,
    active: false,
    profile: {
      bio: "On sabbatical",
      avatar_url: null,
      preferences: {
        theme: "dark",
        locale: "en-GB",
        notifications: { email: false, push: false, sms: false },
      },
    },
    teams: [],
    recent_activity: [],
  },
];

describe("Nested DCP Encoding", () => {
  it("generates nestSchemas on DcpSchemaDef", () => {
    const gen = new SchemaGenerator();
    const draft = gen.fromSamples(userSamples, { domain: "search_users" });

    assert.ok(draft.schema.nestSchemas, "schema should have nestSchemas");
    assert.ok(draft.schema.nestSchemas!["teams"], "teams nestSchema should exist");
    assert.ok(draft.schema.nestSchemas!["recent_activity"], "recent_activity nestSchema should exist");

    const teamsSub = draft.schema.nestSchemas!["teams"];
    assert.equal(teamsSub.schema.id, "search_users.teams:v1");
    assert.ok(teamsSub.schema.fields.length > 0);
    assert.ok(teamsSub.mapping.paths);
  });

  it("encodes array-of-objects with $N references (no preamble)", () => {
    const gen = new SchemaGenerator();
    const draft = gen.fromSamples(userSamples, { domain: "search_users" });
    const schema = new DcpSchema(draft.schema);
    const mapping = new FieldMapping(draft.mapping);
    const encoder = new DcpEncoder(schema, mapping);

    const batch = encoder.encode(userSamples);
    const output = DcpEncoder.toString(batch);
    const lines = output.split("\n");

    // First line is the main header (no preamble)
    const mainHeader = JSON.parse(lines[0]);
    assert.equal(mainHeader[0], "$S");
    assert.equal(mainHeader[1], "search_users:v1");

    // Alice's row
    const aliceRow = JSON.parse(lines[1]);
    // Header is ["$S", id, fieldCount, ...fields], so field i sits at header index i + 3.
    const teamsIdx = mainHeader.indexOf("teams") - 3;
    const teamsVal = aliceRow[teamsIdx];

    // teams: ["$N", "search_users.teams:v1", [row1], [row2]]
    assert.ok(Array.isArray(teamsVal), "teams should be array");
    assert.equal(teamsVal[0], "$N", "nested field starts with $N");
    assert.ok(teamsVal[1].startsWith("search_users.teams:"), "$N references sub-schema ID");
    assert.equal(teamsVal.length, 4, "$N + schemaId + 2 team rows");
    assert.ok(Array.isArray(teamsVal[2]), "team row 1 is an array");
  });

  it("handles empty arrays as $N with no rows", () => {
    const gen = new SchemaGenerator();
    const draft = gen.fromSamples(userSamples, { domain: "search_users" });
    const schema = new DcpSchema(draft.schema);
    const mapping = new FieldMapping(draft.mapping);
    const encoder = new DcpEncoder(schema, mapping);

    const batch = encoder.encode(userSamples);
    const lines = DcpEncoder.toString(batch).split("\n");
    const mainHeader = JSON.parse(lines[0]);

    // Charlie's row (3rd data row)
    const charlieRow = JSON.parse(lines[3]);
    const teamsIdx = mainHeader.indexOf("teams") - 3;

    // Empty → ["$N", "search_users.teams:v1"]
    const teamsVal = charlieRow[teamsIdx];
    assert.ok(Array.isArray(teamsVal), "empty teams should be array");
    assert.equal(teamsVal[0], "$N", "starts with $N");
    assert.equal(teamsVal.length, 2, "$N + schemaId only, no rows");
  });

  it("nestSchemas persist in schema JSON (serializable)", () => {
    const gen = new SchemaGenerator();
    const draft = gen.fromSamples(userSamples, { domain: "search_users" });

    // Round-trip: serialize → parse → DcpSchema
    const json = JSON.stringify(draft.schema);
    const parsed = JSON.parse(json);
    const restored = new DcpSchema(parsed);

    assert.ok(restored.def.nestSchemas, "nestSchemas survives round-trip");
    assert.ok(restored.def.nestSchemas!["teams"]);

    // Encode with restored schema
    const mapping = new FieldMapping(draft.mapping);
    const encoder = new DcpEncoder(restored, mapping);
    const batch = encoder.encode(userSamples);
    const lines = DcpEncoder.toString(batch).split("\n");
    const row = JSON.parse(lines[1]);
    const header = JSON.parse(lines[0]);
    const teamsIdx = header.indexOf("teams") - 3;
    assert.equal(row[teamsIdx][0], "$N", "$N works after schema round-trip");
  });

  it("produces smaller output than JSON", () => {
    const gen = new SchemaGenerator();
    const draft = gen.fromSamples(userSamples, { domain: "search_users" });
    const schema = new DcpSchema(draft.schema);
    const mapping = new FieldMapping(draft.mapping);
    const encoder = new DcpEncoder(schema, mapping);

    const batch = encoder.encode(userSamples);
    const dcpOutput = DcpEncoder.toString(batch);
    const jsonOutput = JSON.stringify(userSamples);

    const reduction = (1 - dcpOutput.length / jsonOutput.length) * 100;
    console.log(`JSON: ${jsonOutput.length} chars, DCP: ${dcpOutput.length} chars, reduction: ${reduction.toFixed(1)}%`);

    assert.ok(reduction > 10, `expected >10% reduction, got ${reduction.toFixed(1)}%`);
  });

  it("scales: 30+ records exceed 30% reduction", () => {
    const gen = new SchemaGenerator();
    const draft = gen.fromSamples(userSamples, { domain: "search_users" });
    const schema = new DcpSchema(draft.schema);
    const mapping = new FieldMapping(draft.mapping);
    const encoder = new DcpEncoder(schema, mapping);

    const scaled = [];
    for (let i = 0; i < 30; i++) {
      const s = JSON.parse(JSON.stringify(userSamples[i % 3]));
      s.id = `u${String(i).padStart(3, "0")}`;
      scaled.push(s);
    }

    const batch = encoder.encode(scaled);
    const dcpOutput = DcpEncoder.toString(batch);
    const jsonOutput = JSON.stringify(scaled);
    const reduction = (1 - dcpOutput.length / jsonOutput.length) * 100;

    assert.ok(reduction > 30, `30 records: expected >30% reduction, got ${reduction.toFixed(1)}%`);
  });
});