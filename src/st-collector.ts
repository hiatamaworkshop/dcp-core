/**
 * $ST Collector — windowed statistics subscriber.
 *
 * Subscribes to "vResult" and "flow" messages on a Monitor and accumulates
 * per-schema statistics. At each window boundary, emits:
 *
 *   $ST-v  validation statistics:
 *     ["$ST-v", schemaId, pass_count, fail_count, sample_n, pass_rate, windowMs]
 *
 *   $ST-f  flow statistics:
 *     ["$ST-f", schemaId, rowsPerSec, windowMs]
 *
 * rowsPerSec comes from "flow" messages when a source emits them (Streamer).
 * Otherwise it is derived from the vResult count, so pipelines fed by an
 * Ingestor (no Streamer) still report real flow instead of a constant 0.
 *
 * Consumers (lightweight AI agents) subscribe to the type they care about.
 */

import type { Monitor, PipelineMessage, VResultPayload, FlowPayload } from "./monitor.js";

// ── $ST-v ──────────────────────────────────────────────────────

/**
 * $ST-v positional array: ["$ST-v", schemaId, pass, fail, total, pass_rate, windowMs]
 */
export type StVRow = [
  "$ST-v",
  string,   // schemaId
  number,   // pass_count
  number,   // fail_count
  number,   // sample_n (total)
  number,   // pass_rate  e.g. 0.999
  number,   // windowMs
];

// ── $ST-f ──────────────────────────────────────────────────────

/**
 * $ST-f positional array: ["$ST-f", schemaId, rowsPerSec, windowMs]
 */
export type StFRow = [
  "$ST-f",
  string,   // schemaId
  number,   // rowsPerSec
  number,   // windowMs
];

/** @deprecated Use StVRow */
export type StRow = StVRow;

// ── Internal window state ──────────────────────────────────────

interface VWindow {
  pass: number;
  fail: number;
  windowStart: number;
}

interface FWindow {
  rowsPerSec: number;   // latest value from flow message
  fromFlow: boolean;    // a flow message arrived in this window
  rows: number;         // vResult count in this window (fallback source)
  windowStart: number;
}

export interface StCollectorOptions {
  /** Flush interval in ms. Default: 1000 */
  windowMs?: number;
}

// ── StCollector ────────────────────────────────────────────────

export class StCollector {
  private windowMs: number;
  private readonly vWindows: Map<string, VWindow> = new Map();
  private readonly fWindows: Map<string, FWindow> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Start of the current window; new schemas join it rather than starting their own. */
  private lastFlush = Date.now();

  constructor(
    private readonly monitor: Monitor,
    options: StCollectorOptions = {},
  ) {
    this.windowMs = options.windowMs ?? 1000;
    this.onVResult = this.onVResult.bind(this);
    this.onFlow    = this.onFlow.bind(this);
  }

  start(): void {
    this.monitor.subscribe("vResult", this.onVResult);
    this.monitor.subscribe("flow",    this.onFlow);
    this.lastFlush = Date.now();
    this.timer = setInterval(() => this.flush(), this.windowMs);
  }

  /** Current flush interval (ms). */
  getWindowMs(): number {
    return this.windowMs;
  }

  /**
   * Replace the flush interval at runtime.
   *
   * The collector itself holds no opinion about *who* changes this or *why* —
   * it is a plain extension point so an external observation layer can reshape
   * the aggregation window on a live stream without restarting ingestion.
   * If the collector is running, the flush timer is restarted on the new interval.
   */
  setWindowMs(windowMs: number): void {
    if (windowMs <= 0) throw new RangeError("windowMs must be positive");
    this.windowMs = windowMs;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.flush(), this.windowMs);
    }
  }

  stop(): void {
    this.monitor.unsubscribe("vResult", this.onVResult);
    this.monitor.unsubscribe("flow",    this.onFlow);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  // ── Handlers ───────────────────────────────────────────────

  private onVResult(msg: PipelineMessage): void {
    const p = msg.payload as VResultPayload;
    let win = this.vWindows.get(msg.schemaId);
    if (!win) {
      win = { pass: 0, fail: 0, windowStart: Date.now() };
      this.vWindows.set(msg.schemaId, win);
    }
    if (p.pass) win.pass++; else win.fail++;
    this.fWindow(msg.schemaId).rows++;
  }

  private onFlow(msg: PipelineMessage): void {
    const p = msg.payload as FlowPayload;
    const win = this.fWindow(msg.schemaId);
    win.rowsPerSec = p.rowsPerSec;
    win.fromFlow = true;
  }

  private fWindow(schemaId: string): FWindow {
    let win = this.fWindows.get(schemaId);
    if (!win) {
      win = { rowsPerSec: 0, fromFlow: false, rows: 0, windowStart: this.lastFlush };
      this.fWindows.set(schemaId, win);
    }
    return win;
  }

  // ── Flush ──────────────────────────────────────────────────

  private flush(): void {
    const now = Date.now();

    // $ST-v
    for (const [schemaId, win] of this.vWindows) {
      const total = win.pass + win.fail;
      if (total === 0) continue;

      const elapsed = now - win.windowStart;
      const row: StVRow = [
        "$ST-v",
        schemaId,
        win.pass,
        win.fail,
        total,
        parseFloat((win.pass / total).toFixed(3)),
        elapsed,
      ];

      this.monitor.emit({
        type: "st_v",
        schemaId,
        ts: now,
        priority: "batch",
        payload: row,
      });

      win.pass = 0;
      win.fail = 0;
      win.windowStart = now;
    }

    // $ST-f
    for (const [schemaId, win] of this.fWindows) {
      const elapsed = now - win.windowStart;
      const rowsPerSec = win.fromFlow
        ? win.rowsPerSec
        : elapsed > 0 ? Math.round((win.rows / elapsed) * 1000) : 0;
      const row: StFRow = [
        "$ST-f",
        schemaId,
        rowsPerSec,
        elapsed,
      ];

      this.monitor.emit({
        type: "st_f",
        schemaId,
        ts: now,
        priority: "batch",
        payload: row,
      });

      win.rowsPerSec = 0;
      win.fromFlow = false;
      win.rows = 0;
      win.windowStart = now;
    }
    this.lastFlush = now;
  }
}