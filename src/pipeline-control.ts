/**
 * PipelineControl — PostBox outbound → local pipeline application.
 *
 * Subscribes to the PostBox outbound channel filtered by this pipeline's ID.
 * Translates Brain AI decisions into local pipeline state changes:
 *   routing_update     → RoutingLayer.setTable()
 *   throttle           → ThrottleState (Streamer reads this)
 *   stop               → StopState
 *   ap_update          → AgentProfileMap (Brain AI reads; not applicable here)
 *   quarantine_approve → re-inject corrected record into Encoder callback
 *   quarantine_reject  → drop record, emit log entry
 *
 * Brain AI writes to PostBox; PipelineControl applies locally.
 * Brain AI never touches pipeline internals directly.
 */

import type {
  PostBox,
  OutboundMessage,
  RoutingUpdatePayload,
  ThrottlePayload,
  StopPayload,
  QuarantineApprovePayload,
  QuarantineRejectPayload,
  ValidationUpdatePayload,
} from "./postbox.ts";
import type { RoutingLayer, RoutingTable } from "./router.ts";
import type { PipelineConnector, ConnectorTable } from "./pipeline-connector.ts";
import type { Preprocessor } from "./preprocessor.ts";
import type { SchemaRegistry } from "./registry.ts";
import { VShadow } from "./validator.js";


// ── State types ───────────────────────────────────────────────────────────────

export interface ThrottleState {
  /** schemaId → rps cap. undefined key = pipeline-wide cap. */
  limits: Map<string | undefined, number>;
}

export interface StopState {
  /** schemaIds to stop. Empty set = stop entire pipeline. */
  stopped: Set<string | undefined>;
}

/**
 * Callback invoked when Brain AI approves a quarantined record.
 * The Preprocessor (or whoever pushed the quarantine) registers this
 * to re-inject the (possibly corrected) record into the Encoder.
 */
export type QuarantineApproveHandler = (quarantineId: string, record: unknown) => void;

/**
 * Callback invoked when Brain AI rejects a quarantined record.
 * Default behaviour: drop silently. Register to add custom logging.
 */
export type QuarantineRejectHandler = (quarantineId: string, reason: string) => void;

// ── PipelineControl ───────────────────────────────────────────────────────────

/**
 * PipelineControl — wires PostBox outbound to local pipeline components.
 *
 * Usage:
 *   const ctrl = new PipelineControl("pipeline://ingest-01", postbox, router);
 *   // Brain AI calls postbox.issueRoutingUpdate("pipeline://ingest-01", newTable)
 *   // → ctrl applies it to router automatically
 *   ctrl.detach(); // on shutdown
 *
 * Optional connector parameter: when provided, routing_update will also call
 * connector.setTable() with the resolved Preprocessor instances.
 * The caller must supply a resolver function (pipelineId → Preprocessor)
 * because PipelineControl has no visibility into other pipelines' internals.
 */
export class PipelineControl {
  readonly throttle: ThrottleState = { limits: new Map() };
  readonly stop: StopState = { stopped: new Set() };

  private onApprove: QuarantineApproveHandler | null = null;
  private onReject: QuarantineRejectHandler | null = null;
  private readonly extraHandlers = new Map<string, (msg: OutboundMessage) => void>();
  private connectorRef: PipelineConnector | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private connectorResolver: ((pipelineId: string) => Preprocessor<any> | undefined) | null = null;

  private readonly handler: (msg: OutboundMessage) => void;

  constructor(
    readonly pipelineId: string,
    private readonly postbox: PostBox,
    private readonly router: RoutingLayer,
    private readonly registry?: SchemaRegistry,
  ) {
    this.handler = (msg: OutboundMessage) => {
      if (msg.pipelineId !== this.pipelineId) return;
      this.apply(msg);
    };
    postbox.subscribeOutbound("*", this.handler);
  }

  /** Detach from PostBox. Call on pipeline shutdown. */
  detach(): void {
    this.postbox.unsubscribeOutbound("*", this.handler);
  }

  /**
   * Wire a PipelineConnector so that routing_update messages also update it.
   * resolver: given a pipelineId string, return the corresponding Preprocessor.
   * This keeps PipelineControl decoupled from specific pipeline instances.
   */
  setConnector(
    connector: PipelineConnector,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: (pipelineId: string) => Preprocessor<any> | undefined,
  ): void {
    this.connectorRef = connector;
    this.connectorResolver = resolver;
  }

  /**
   * Register a callback for quarantine_approve.
   * Preprocessor calls this to wire re-injection into the Encoder.
   */
  onQuarantineApprove(handler: QuarantineApproveHandler): void {
    this.onApprove = handler;
  }

  /**
   * Register a callback for quarantine_reject.
   * Optional — default is silent drop.
   */
  onQuarantineReject(handler: QuarantineRejectHandler): void {
    this.onReject = handler;
  }

  /**
   * Register a handler for an outbound message type the core does not handle
   * natively. This is the extension seam for control concepts that live
   * outside dcp-core (e.g. an observation layer issuing its own decision types).
   * The core neither defines nor interprets these types — it only forwards a
   * matching message to the registered handler. Returns an unregister function.
   */
  onExtraDecision(type: string, handler: (msg: OutboundMessage) => void): () => void {
    this.extraHandlers.set(type, handler);
    return () => {
      if (this.extraHandlers.get(type) === handler) this.extraHandlers.delete(type);
    };
  }

  /** True if the given schemaId (or the pipeline entirely) has been stopped. */
  isStopped(schemaId?: string): boolean {
    return this.stop.stopped.has(undefined) || this.stop.stopped.has(schemaId);
  }

  /** rps cap for the given schemaId, or pipeline-wide cap, or undefined (uncapped). */
  getRpsLimit(schemaId?: string): number | undefined {
    return this.throttle.limits.get(schemaId) ?? this.throttle.limits.get(undefined);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private apply(msg: OutboundMessage): void {
    switch (msg.type) {
      case "routing_update":
        this.applyRoutingUpdate(msg.payload as RoutingUpdatePayload);
        break;
      case "throttle":
        this.applyThrottle(msg.payload as ThrottlePayload);
        break;
      case "stop":
        this.applyStop(msg.payload as StopPayload);
        break;
      case "ap_update":
        // AgentProfile updates are consumed by Brain AI's in-memory registry.
        // PipelineControl receives them but has no local action to take.
        break;
      case "validation_update":
        this.applyValidationUpdate(msg.payload as ValidationUpdatePayload);
        break;
      case "quarantine_approve":
        this.applyQuarantineApprove(msg.payload as QuarantineApprovePayload);
        break;
      case "quarantine_reject":
        this.applyQuarantineReject(msg.payload as QuarantineRejectPayload);
        break;
      default:
        this.applyExtra(msg);
        break;
    }
  }

  /** Forward an unrecognized outbound type to its registered handler, if any. */
  private applyExtra(msg: OutboundMessage): void {
    const handler = this.extraHandlers.get(msg.type as string);
    if (handler) handler(msg);
  }

  private applyRoutingUpdate(payload: RoutingUpdatePayload): void {
    const table: RoutingTable = new Map();
    for (const [schemaId, dest] of payload.table) {
      table.set(schemaId, dest);
    }
    this.router.setTable(table);

    // If a connector is wired, resolve pipelineId strings → Preprocessor instances
    // and update the connector's routing table in sync.
    if (this.connectorRef && this.connectorResolver) {
      const connectorTable: ConnectorTable = new Map();
      for (const [schemaId, dest] of payload.table) {
        if (Array.isArray(dest)) {
          const targets = dest
            .map((id) => this.connectorResolver!(id))
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .filter((p): p is Preprocessor<any> => p !== undefined);
          if (targets.length > 0) connectorTable.set(schemaId, targets.length === 1 ? targets[0] : targets);
        } else {
          const target = this.connectorResolver(dest);
          if (target) connectorTable.set(schemaId, target);
        }
      }
      this.connectorRef.setTable(connectorTable);
    }
  }

  private applyThrottle(payload: ThrottlePayload): void {
    // schemaId undefined = pipeline-wide throttle
    this.throttle.limits.set(payload.schemaId, payload.rps);
  }

  private applyStop(payload: StopPayload): void {
    // schemaId undefined = stop entire pipeline
    this.stop.stopped.add(payload.schemaId);
  }

  private applyQuarantineApprove(payload: QuarantineApprovePayload): void {
    if (this.onApprove) {
      const record = payload.correctedRecord ?? null;
      this.onApprove(payload.quarantineId, record);
    }
  }

  private applyQuarantineReject(payload: QuarantineRejectPayload): void {
    if (this.onReject) {
      this.onReject(payload.quarantineId, payload.reason);
    }
    // default: silent drop — no handler required
  }

  private applyValidationUpdate(payload: ValidationUpdatePayload): void {
    if (!this.registry) return;
    const vShadow = new VShadow(payload.schemaId, payload.constraints);
    this.registry.updateVShadow(payload.schemaId, vShadow);
  }
}