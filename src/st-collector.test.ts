/**
 * st-collector.test.ts
 *
 * $ST-f rowsPerSec must reflect real flow on pipelines without a Streamer
 * (Ingestor → Preprocessor → Gate emit vResult but no "flow"). Before this,
 * rowsPerSec stayed 0 there, so `rowsPerSec > N` weapons never fired and
 * `rowsPerSec < N` weapons always did.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { StCollector } from "./st-collector.js";
import { SimpleMonitor } from "./monitor.js";
import type { PipelineMessage } from "./monitor.js";
import type { StFRow, StVRow } from "./st-collector.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const realNow = Date.now;
let clock = 0;
function useClock(start: number): void {
  clock = start;
  Date.now = () => clock;
}

function setup() {
  const monitor = new SimpleMonitor();
  const stF: StFRow[] = [];
  const stV: StVRow[] = [];
  monitor.subscribe("st_f", (m) => stF.push(m.payload as StFRow));
  monitor.subscribe("st_v", (m) => stV.push(m.payload as StVRow));
  // Long window: the test drives flushes itself.
  const collector = new StCollector(monitor, { windowMs: 1_000_000 });
  const flush = () => (collector as unknown as { flush(): void }).flush();
  return { monitor, collector, flush, stF, stV };
}

function vResult(schemaId: string, pass = true): PipelineMessage {
  return {
    type: "vResult", schemaId, ts: clock, priority: "batch",
    payload: { index: 0, pass, failures: [], mode: "flag", emitted: true },
  };
}

function flow(schemaId: string, rowsPerSec: number): PipelineMessage {
  return {
    type: "flow", schemaId, ts: clock, priority: "batch",
    payload: { rowsPerSec, windowMs: 1000 },
  };
}

afterEach(() => { Date.now = realNow; });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("StCollector — $ST-f rowsPerSec", () => {
  it("derives rowsPerSec from vResult count when no flow message arrives", () => {
    useClock(0);
    const { monitor, collector, stF, stV } = setup();
    collector.start();
    for (let i = 0; i < 10; i++) monitor.emit(vResult("s:v1", i < 8));
    clock = 500;
    collector.stop();

    assert.deepEqual(stF, [["$ST-f", "s:v1", 20, 500]]);
    assert.deepEqual(stV, [["$ST-v", "s:v1", 8, 2, 10, 0.8, 500]]);
  });

  it("prefers the flow message value when a source emits one", () => {
    useClock(0);
    const { monitor, collector, stF } = setup();
    collector.start();
    for (let i = 0; i < 10; i++) monitor.emit(vResult("s:v1"));
    monitor.emit(flow("s:v1", 123));
    clock = 1000;
    collector.stop();

    assert.deepEqual(stF, [["$ST-f", "s:v1", 123, 1000]]);
  });

  it("measures a schema that appears mid-window over the whole window", () => {
    useClock(0);
    const { monitor, collector, stF } = setup();
    collector.start();
    clock = 990;
    monitor.emit(vResult("late:v1"));
    clock = 1000;
    collector.stop();

    // 1 row in a 1000 ms window — not 1 row in 10 ms (= 100 rows/sec).
    assert.deepEqual(stF, [["$ST-f", "late:v1", 1, 1000]]);
  });

  it("reports 0 once a seen schema stops flowing", () => {
    useClock(0);
    const { monitor, collector, flush, stF } = setup();
    collector.start();
    for (let i = 0; i < 5; i++) monitor.emit(vResult("s:v1"));
    clock = 1000;
    flush();
    clock = 2000;
    collector.stop();

    assert.deepEqual(stF, [
      ["$ST-f", "s:v1", 5, 1000],
      ["$ST-f", "s:v1", 0, 1000],
    ]);
  });
});
