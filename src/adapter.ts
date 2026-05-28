/**
 * SourceAdapter<T>
 *
 * Protocol-specific adapter interface.
 * Converts raw bytes/objects from a source into a positional array
 * conformant with the target schema — without JSON as a required intermediary.
 *
 * T = raw input type (Buffer for binary, Record for JSON, string for CSV...)
 */

import type { DcpSchema } from "./schema.js";

/**
 * Result of a successful decode operation.
 *
 * array       — positional values in schema.fields order
 * extraFields — keys present in the raw input that are not in schema.fields
 *               (excluding the schemaId field itself, e.g. "$schema").
 *               undefined means the adapter does not track extra fields.
 *               An empty object means no extras were found.
 */
export interface AdapterDecodeResult {
  array: unknown[];
  extraFields?: Record<string, unknown>;
}

export interface SourceAdapter<T = unknown> {
  /**
   * Extract schemaId from the raw input.
   * Returns null if the source cannot be identified (→ Drop).
   */
  schemaId(raw: T): string | null;

  /**
   * Convert raw input to a positional array conforming to the resolved schema.
   * Returns a DecodeResult on success, or null if conversion fails (→ Drop).
   *
   * extraFields should be populated when the adapter can detect keys in the
   * raw input that are not part of the schema — these signal schema evolution
   * and will be quarantined as "unknown_field" by the Preprocessor.
   */
  decode(raw: T, schema: DcpSchema): AdapterDecodeResult | null;
}
