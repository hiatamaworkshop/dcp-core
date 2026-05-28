/**
 * extension-points.test.ts
 *
 * Regression tests for the generic extension seams added to support an external
 * observation layer (the Lighthouse Model lives outside dcp-core). These tests
 * pin two things: the seams work, and they do NOT change default behaviour when
 * unused.
 *
 *   1. StCollector.setWindowMs / getWindowMs — runtime window reshape
 *   2. IngestionBus.tap — read-only observation of every push
 *   3. PipelineControl.onExtraDecision — forwarding of unrecognized outbound types
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { StCollector }    from "./st-collector.js";
import { IngestionBus }   from "./ingestion-bus.js";
import { PostBox }        from "./postbox.js";
import { RoutingLayer }   from "./router.js";
import { MessagePool, NullMonitor } from "./monitor.js";
import { PipelineControl } from "./pipeline-control.js";
import type { OutboundMessage } from "./postbox.js";

// ── 1. StCollector runtime window ──────────────────────────────────────────────

describe("StCollector — runtime window reshape", () => {
  it("reports the constructor window by default", () => {
    const c = new StCollector(new NullMonitor(), { windowMs: 2000 });
    assert.equal(c.getWindowMs(), 2000);
  });

  it("defaults to 1000ms when unspecified", () => {
    const c = new StCollector(new NullMonitor());
    assert.equal(c.getWindowMs(), 1000);
  });

  it("setWindowMs changes the reported window without start()", () => {
    const c = new StCollector(new NullMonitor(), { windowMs: 1000 });
    c.setWindowMs(250);
    assert.equal(c.getWindowMs(), 250);
  });

  it("setWindowMs rejects non-positive values", () => {
    const c = new StCollector(new NullMonitor());
    assert.throws(() => c.setWindowMs(0), RangeError);
    assert.throws(() => c.setWindowMs(-5), RangeError);
  });

  it("setWindowMs while running restarts the timer cleanly", () => {
    const c = new StCollector(new NullMonitor(), { windowMs: 1000 });
    c.start();
    c.setWindowMs(500);
    assert.equal(c.getWindowMs(), 500);
    c.stop();
  });
});

// ── 2. IngestionBus tap ────────────────────────────────────────────────────────

describe("IngestionBus — read-only tap", () => {
  it("delivers normally with no tap registered (default unchanged)", () => {
    const bus = new IngestionBus<{ n: number }>();
    const seen: number[] = [];
    bus.subscribe("s:v1", (raw) => seen.push(raw.n));
    bus.push({ n: 1 }, "s:v1");
    assert.deepEqual(seen, [1]);
  });

  it("a tap observes every push regardless of schemaId", () => {
    const bus = new IngestionBus<{ n: number }>();
    const tapped: [number, string][] = [];
    bus.tap((raw, schemaId) => tapped.push([raw.n, schemaId]));
    bus.push({ n: 1 }, "a:v1");
    bus.push({ n: 2 }, "b:v1");
    assert.deepEqual(tapped, [[1, "a:v1"], [2, "b:v1"]]);
  });

  it("a tap does not suppress normal delivery", () => {
    const bus = new IngestionBus<{ n: number }>();
    const delivered: number[] = [];
    bus.subscribe("s:v1", (raw) => delivered.push(raw.n));
    bus.tap(() => {/* observe only */});
    bus.push({ n: 7 }, "s:v1");
    assert.deepEqual(delivered, [7]);
  });

  it("the returned unregister function removes the tap", () => {
    const bus = new IngestionBus<{ n: number }>();
    const tapped: number[] = [];
    const off = bus.tap((raw) => tapped.push(raw.n));
    bus.push({ n: 1 }, "s:v1");
    off();
    bus.push({ n: 2 }, "s:v1");
    assert.deepEqual(tapped, [1]);
  });
});

// ── 3. PipelineControl extra-decision forwarding ───────────────────────────────

describe("PipelineControl — extra decision forwarding", () => {
  function makeControl(pipelineId: string) {
    const postbox = new PostBox();
    const pool = new MessagePool();
    const router = new RoutingLayer(pool, { receive: () => {} });
    const ctrl = new PipelineControl(pipelineId, postbox, router);
    return { postbox, ctrl };
  }

  it("forwards an unrecognized outbound type to its registered handler", () => {
    const { postbox, ctrl } = makeControl("pipeline://p1");
    const received: OutboundMessage[] = [];
    ctrl.onExtraDecision("observe_update", (msg) => received.push(msg));

    postbox.pushOutbound({
      type: "observe_update" as never,
      pipelineId: "pipeline://p1",
      ts: Date.now(),
      payload: { foo: "bar" } as never,
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].pipelineId, "pipeline://p1");
  });

  it("ignores an unrecognized type with no handler (no throw)", () => {
    const { postbox } = makeControl("pipeline://p2");
    assert.doesNotThrow(() => {
      postbox.pushOutbound({
        type: "mystery" as never,
        pipelineId: "pipeline://p2",
        ts: Date.now(),
        payload: {} as never,
      });
    });
  });

  it("does not invoke an extra handler for messages to another pipeline", () => {
    const { postbox, ctrl } = makeControl("pipeline://p3");
    let called = 0;
    ctrl.onExtraDecision("observe_update", () => { called++; });

    postbox.pushOutbound({
      type: "observe_update" as never,
      pipelineId: "pipeline://other",
      ts: Date.now(),
      payload: {} as never,
    });

    assert.equal(called, 0);
  });

  it("unregister stops forwarding", () => {
    const { postbox, ctrl } = makeControl("pipeline://p4");
    let called = 0;
    const off = ctrl.onExtraDecision("observe_update", () => { called++; });

    postbox.pushOutbound({
      type: "observe_update" as never,
      pipelineId: "pipeline://p4",
      ts: Date.now(),
      payload: {} as never,
    });
    off();
    postbox.pushOutbound({
      type: "observe_update" as never,
      pipelineId: "pipeline://p4",
      ts: Date.now(),
      payload: {} as never,
    });

    assert.equal(called, 1);
  });
});
