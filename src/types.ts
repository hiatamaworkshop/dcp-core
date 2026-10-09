/** Type definition for a single schema field. */
export interface FieldTypeDef {
  type: string | string[];
  description?: string;
  enum?: unknown[];
  min?: number;
  max?: number;
}

/**
 * Validation shadow — independent verification lens attached to a schema.
 * Shadows are disposable: removing one does not affect the body or other shadows.
 * Bound to schemaId; if the schema ID changes, this shadow is invalid.
 */
export interface ValidationShadow {
  /** Schema this shadow is bound to. Must match DcpSchemaDef.id exactly. */
  schemaId: string;
  /** Per-field constraints, keyed by field name. Unrecognized fields are passed through. */
  fields?: Record<string, ValidationShadowField>;
}

/** Per-field constraint set for a validation shadow. */
export interface ValidationShadowField {
  /** Regex pattern the value must match (string fields). */
  pattern?: string;
  /** Maximum string length. */
  maxLength?: number;
  /** Minimum string length. */
  minLength?: number;
}

/**
 * Routing shadow — declarative distribution control attached to a schema.
 * Declares who receives data and under what conditions.
 * Bound to schemaId; system reads and executes, does not own the logic.
 */
export interface RoutingShadow {
  /** Schema this shadow is bound to. Must match DcpSchemaDef.id exactly. */
  schemaId: string;
  /** Minimum agent density level required (L0–L4). */
  minLevel?: number;
  /** Group-level access control. */
  access?: string[];
  /** Field-value conditions for inclusion. */
  filter?: Record<string, unknown[]>;
}

/** DCP schema definition (the $dcp JSON document). */
export interface DcpSchemaDef {
  $dcp: "schema";
  id: string;
  description: string;
  fields: string[];
  fieldCount: number;
  types: Record<string, FieldTypeDef>;
  /** Nested sub-schemas for array-of-objects fields. Key = field name. */
  nestSchemas?: Record<string, NestSchemaDef>;
  /**
   * Shadows attached to this schema definition.
   * Each shadow is independently disposable — attach one, some, or all.
   * All shadows are bound to this schema's id; id change = shadows invalid.
   */
  shadows?: {
    validation?: ValidationShadow;
    routing?: RoutingShadow;
  };
}

/** Sub-schema + mapping pair for a nested array-of-objects field. */
export interface NestSchemaDef {
  schema: DcpSchemaDef;
  mapping: FieldMappingDef;
}

/** Mapping: schema field name → dot.notation.path in source. */
export interface FieldMappingDef {
  schemaId: string;
  paths: Record<string, string>;
}

/** Options for schema generation. */
export interface GenerateOptions {
  domain: string;
  version?: number;
  description?: string;
  include?: string[];
  exclude?: string[];
  fieldNames?: Record<string, string>;
  /** Max nesting depth to flatten (default: 3). Deeper paths are ignored. */
  maxDepth?: number;
  /** Max fields in generated schema (default: 20). Lowest-presence fields are dropped. */
  maxFields?: number;
  /** Min presence rate to include a field, 0-1 (default: 0.1). Fields appearing in <10% of samples are dropped. */
  minPresence?: number;
}

/** Inference report for a single field. */
export interface FieldReport {
  name: string;
  sourcePath: string;
  category: "identifier" | "classifier" | "numeric" | "text" | "other";
  inferredType: FieldTypeDef;
  presenceRate: number;
  uniqueCount: number;
  sampleCount: number;
  isGroupKeyCandidate: boolean;
}

/** Result of schema generation — inspectable before committing. */
export interface SchemaDraft {
  schema: DcpSchemaDef;
  mapping: FieldMappingDef;
  fieldReports: FieldReport[];
}

/** Encoded DCP output. */
export interface EncodedBatch {
  header: string;
  rows: string[];
  schemaId: string;
  mask: number;
  isCutdown: boolean;
}

// ── Bot / AgentProfile types ──────────────────────────────────────────────────

/**
 * A single numeric filter applied to a $ST metric.
 * Multiple Weapons form the FastGate filter set for a Bot.
 */
export interface Weapon {
  name: string;
  metric: "pass_rate" | "fail" | "rowsPerSec" | string;
  op: "<" | ">" | "<=" | ">=" | "==" | "!=";
  threshold: number;
  weight: number;
  /**
   * Skip this Weapon when the $ST-v window holds fewer rows than this.
   * A rate over a handful of rows is mostly noise (one failed row reads as pass_rate 0).
   * A skipped Weapon counts as not fired. Default: no minimum.
   */
  minTotal?: number;
}

/**
 * When to call the L-LLM after Weapon evaluation.
 *   any   — any single Weapon fires
 *   score — sum(weight of fired Weapons) > scoreThreshold
 *   all   — all Weapons must fire (AND)
 */
export type TriggerMode =
  | { mode: "any" }
  | { mode: "score"; scoreThreshold: number }
  | { mode: "all" };

/**
 * AgentProfile — shared object between Bot and Brain AI.
 *
 * Bot reads its own profile at startup to load weapons and behavior.
 * Brain holds AgentProfileMap (botId -> AgentProfile) and may rewrite
 * profiles via $AP messages to adjust Bot sensitivity without restart.
 */
export interface AgentProfile {
  id: string;
  botId: string;
  model: string;
  weapons: Weapon[];
  trigger: TriggerMode;
  /** Optional context injected into L-LLM prompt. */
  llmPromptHint?: string;
  /** SchemaIds this Bot watches. Empty array = watch all. */
  schemaScope?: string[];
}

/** $I packet — inference result produced by a Bot after L-LLM call. */
export interface IPacket {
  botId: string;
  schemaId: string;
  signal: string;
  severity: "low" | "medium" | "high";
  /** The $ST row that triggered this inference. */
  context: unknown;
  ts: number;
}
