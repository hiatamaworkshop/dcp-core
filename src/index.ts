export { DcpSchema } from "./schema.js";
export { FieldMapping, resolvePath, flattenKeys } from "./mapping.js";
export { SchemaGenerator, formatReport } from "./generator.js";
export { DcpEncoder, dcpEncode } from "./encoder.js";
export { DcpDecoder } from "./decoder.js";
export type { InlineSchema } from "./encoder.js";
export type { DecodeResult, TemplateMap } from "./decoder.js";
export type {
  DcpSchemaDef,
  NestSchemaDef,
  FieldTypeDef,
  FieldMappingDef,
  GenerateOptions,
  EncodedBatch,
  SchemaDraft,
  FieldReport,
} from "./types.js";

export { SchemaRegistry } from "./registry.js";
export { VShadow, vShadowFromSchema } from "./validator.js";
export type { RegistryEntry } from "./registry.js";
export type { VConstraint, VFieldResult, VRowResult } from "./validator.js";

export { Gate } from "./gate.js";
export { SimpleMonitor, NullMonitor, PooledMonitor, MessagePool } from "./monitor.js";
export type { GateOptions, GateResult, ValidationMode } from "./gate.js";
export type { Monitor, PipelineMessage, MessageType, MessagePriority, FlowPayload, VResultPayload, Messenger, MessengerFilter } from "./monitor.js";

export { StCollector } from "./st-collector.js";
export type { StVRow, StFRow, StRow, StCollectorOptions } from "./st-collector.js";

export { PostBox } from "./postbox.js";
export type {
  InboundMessage, OutboundMessage, InboundType, OutboundType,
  QuarantinePayload, QuarantineApprovePayload, QuarantineRejectPayload, QuarantineReason,
  RoutingUpdatePayload, ThrottlePayload, StopPayload, AgentProfilePayload,
  InboundHandler, OutboundHandler,
} from "./postbox.js";

export { RoutingLayer } from "./router.js";
export type { RoutingTable, RoutingDestination, RoutedRow, RoutingSink } from "./router.js";

export { ProxyExporter } from "./proxy-exporter.js";
export type { ProxyExporterOptions } from "./proxy-exporter.js";

export { PipelineControl } from "./pipeline-control.js";
export type { ThrottleState, StopState, QuarantineApproveHandler, QuarantineRejectHandler } from "./pipeline-control.js";

export { Preprocessor } from "./preprocessor.js";
export type { PreprocessorOptions, PassHandler, DropHandler, RawRecord } from "./preprocessor.js";

export { IPool } from "./i-pool.js";
export type { IPoolOptions } from "./i-pool.js";
export type { Weapon, TriggerMode, AgentProfile, IPacket } from "./types.js";

export { Bot, RuleBasedLlm, ClaudeAdapter } from "./bot.js";
export type { BotOptions, LlmAdapter, LlmInput, LlmOutput, StMetrics, ClaudeAdapterOptions } from "./bot.js";

export { Recorder, replay } from "./recorder.js";
export type { RecorderOptions, ReplayOptions, SnapshotRecord } from "./recorder.js";

export { Brain, RuleBasedBrain, ClaudeBrain } from "./brain.js";
export type { BrainOptions, BrainAdapter, BrainInput, BrainDecision, ClaudeBrainOptions } from "./brain.js";

export { BrainCollector } from "./brain-collector.js";
export type { StBrainRow, BrainCollectorOptions } from "./brain-collector.js";

export { PipelineConnector } from "./pipeline-connector.js";
export type { ConnectorTable, ConnectorDropHandler } from "./pipeline-connector.js";

export type { IngestorX } from "./ingestor.js";
export { SchemaCache } from "./schema-cache.js";
export type { SchemaCacheOptions } from "./schema-cache.js";
export type { SourceAdapter, AdapterDecodeResult } from "./adapter.js";
export { JSONAdapter } from "./adapters/json-adapter.js";
export { HTTPIngestor } from "./ingestors/http-ingestor.js";
export type { HTTPIngestorOptions } from "./ingestors/http-ingestor.js";
export { IngestorPool } from "./ingestor-pool.js";
export type { IngestorPoolOptions } from "./ingestor-pool.js";
export { IngestionBus } from "./ingestion-bus.js";
export type { BusHandler } from "./ingestion-bus.js";
