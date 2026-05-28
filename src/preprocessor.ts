/**
 * Preprocessor<T> — Adapter ベースのパイプラインエントリガード。
 *
 * SourceAdapter<T> を受け取り、任意のプロトコル/フォーマット (JSON / バイナリ / CSV...) の
 * 入力を positional array に変換してから下流へ渡す。
 *
 * フロー:
 *   raw: T
 *     → adapter.schemaId(raw)             — schemaId 解決 (null → Drop)
 *     → stop / throttle チェック
 *     → cache.get(schemaId)               — スキーマ解決 (null → Drop)
 *     → adapter.decode(raw, schema)       — positional array 生成 (null → Drop)
 *     → vShadow.validatePositional()      — 型・範囲チェック
 *     → Pass / Quarantine
 *
 * 後方互換:
 *   JSON フォーマットは JSONAdapter + SchemaCache(registry) の組み合わせで従来と等価。
 *   PassHandler が受け取るのは positional array (unknown[]) と schemaId の組。
 *
 * Quarantine reasons:
 *   unknown_field   — フィールド数が schema.fieldCount より多い
 *   missing_field   — フィールド数が schema.fieldCount より少ない / null 含む
 *   type_mismatch   — 型チェック失敗 (enum 違反含む)
 *   range_violation — 数値が min/max 範囲外
 */

import { randomUUID } from "node:crypto";
import type { SourceAdapter } from "./adapter.js";
import type { SchemaCache } from "./schema-cache.js";
import type { PostBox, QuarantineReason } from "./postbox.js";
import type { PipelineControl } from "./pipeline-control.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Called when a record passes preprocessing and is ready for encoding.
 * Receives positional array (schema.fields 順)、schemaId、および元の raw input。
 * raw は PipelineConnector 経由のチェーン転送時に使用する。
 */
export type PassHandler<T = unknown> = (array: unknown[], schemaId: string, raw: T) => void;

/**
 * Called when a record is dropped (corrupt; not quarantinable).
 * Optional — default is silent drop.
 */
export type DropHandler = (record: unknown, reason: string) => void;

export interface PreprocessorOptions {
  /** Pipeline instance ID. PostBox quarantine メッセージの pipelineId に使用。 */
  pipelineId: string;

  /**
   * If true, records with unknown schemaIds are auto-registered from the record
   * structure via registry.registerFromHeader(). This is permissive mode.
   * Default: false — unknown schema → Drop.
   *
   * @deprecated JSONAdapter 固有の動作。Adapter ベースでは cache.get() の結果に委ねる。
   *             互換性のため残すが、Adapter ベースでは効果なし。
   */
  autoRegister?: boolean;

  /**
   * schemaId フィールド名。JSONAdapter との組み合わせ時に使用。
   * Adapter ベース Preprocessor ではこのオプションは Adapter 側で管理する。
   * @deprecated 互換性のため残す。
   */
  schemaField?: string;
}

// ── Preprocessor ─────────────────────────────────────────────────────────────

export class Preprocessor<T = unknown> {
  private passHandler: PassHandler<T> | null = null;
  private dropHandler: DropHandler | null = null;

  private readonly ctrl: PipelineControl;

  // Throttle tracking: schemaId → { windowStart, count }
  private readonly throttleCounters = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly adapter: SourceAdapter<T>,
    private readonly cache: SchemaCache,
    private readonly postbox: PostBox,
    pipelineControl: PipelineControl,
    private readonly options: PreprocessorOptions,
  ) {
    this.ctrl = pipelineControl;

    // Wire Brain AI approve → re-inject into onPass
    pipelineControl.onQuarantineApprove((_quarantineId, record) => {
      this.reInject(record);
    });
  }

  /** Register the downstream pass handler. */
  onPass(handler: PassHandler<T>): void {
    this.passHandler = handler;
  }

  /** Register an optional drop handler for logging. */
  onDrop(handler: DropHandler): void {
    this.dropHandler = handler;
  }

  /**
   * Process a single raw input.
   * Adapter を通じて schemaId を解決し、decode → validate → Pass / Drop / Quarantine。
   */
  process(raw: T): void {
    // ── Pipeline-wide stop check ──────────────────────────────────────────────
    if (this.ctrl.isStopped()) {
      this.drop(raw, "pipeline stopped");
      return;
    }

    // ── schemaId 解決 ─────────────────────────────────────────────────────────
    const schemaId = this.adapter.schemaId(raw);
    if (!schemaId) {
      this.drop(raw, "schemaId unresolvable");
      return;
    }

    // ── Schema-level stop check ───────────────────────────────────────────────
    if (this.ctrl.isStopped(schemaId)) {
      this.drop(raw, `schema stopped: ${schemaId}`);
      return;
    }

    // ── Throttle check ────────────────────────────────────────────────────────
    const rpsLimit = this.ctrl.getRpsLimit(schemaId);
    if (rpsLimit !== undefined && this.isThrottled(schemaId, rpsLimit)) {
      this.drop(raw, `throttled: ${schemaId} exceeds ${rpsLimit} rps`);
      return;
    }

    // ── Schema lookup (cache) ─────────────────────────────────────────────────
    const entry = this.cache.get(schemaId);
    if (!entry) {
      this.drop(raw, `unknown schemaId: ${schemaId}`);
      return;
    }

    const { schema, vShadow } = entry;

    // ── Decode → positional array ─────────────────────────────────────────────
    const result = this.adapter.decode(raw, schema);
    if (!result) {
      this.drop(raw, "decode failed");
      return;
    }

    const { array, extraFields } = result;

    // ── Field count checks ────────────────────────────────────────────────────
    // extraFields: Adapter が検出したスキーマ外キー → unknown_field quarantine
    if (extraFields && Object.keys(extraFields).length > 0) {
      this.quarantine(array, schemaId, "unknown_field",
        `unknown fields: ${Object.keys(extraFields).join(", ")}`);
      return;
    }

    // array 長チェック: Adapter が extraFields を提供しない場合のフォールバック
    if (array.length > schema.fieldCount) {
      this.quarantine(array, schemaId, "unknown_field",
        `decoded array length ${array.length} exceeds schema fieldCount ${schema.fieldCount}`);
      return;
    }

    // missing フィールド: array が短い場合 (Adapter が null で埋めない場合)
    if (array.length < schema.fieldCount) {
      this.quarantine(array, schemaId, "missing_field",
        `decoded array length ${array.length} shorter than schema fieldCount ${schema.fieldCount}`);
      return;
    }

    // null 値によるフィールド欠落検出 (JSONAdapter のパターン)
    const missingIndices = array
      .map((v, i) => (v === null || v === undefined ? schema.fields[i] : null))
      .filter((f): f is string => f !== null);
    if (missingIndices.length > 0) {
      this.quarantine(array, schemaId, "missing_field",
        `missing fields: ${missingIndices.join(", ")}`);
      return;
    }

    // ── VShadow バリデーション ────────────────────────────────────────────────
    const vResult = vShadow.validatePositional(schema.fields, array);
    if (!vResult.pass) {
      const first = vResult.failures[0];
      const qReason: QuarantineReason =
        (first.reason?.includes("< min") || first.reason?.includes("> max"))
          ? "range_violation" : "type_mismatch";
      this.quarantine(array, schemaId, qReason,
        first.reason ?? `validation failed: ${first.field}`);
      return;
    }

    // ── Pass ──────────────────────────────────────────────────────────────────
    this.passHandler?.(array, schemaId, raw);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private quarantine(
    array: unknown[],
    schemaId: string,
    reason: QuarantineReason,
    detail: string,
  ): void {
    const quarantineId = randomUUID();
    this.postbox.pushQuarantine(this.options.pipelineId, {
      quarantineId,
      schemaId,
      reason,
      detail,
      record: array,
    });
  }

  private reInject(record: unknown): void {
    // Brain AI approved — re-inject as raw T if possible.
    // correctedRecord は RawRecord (plain object) で来る想定。
    // Adapter が decode できれば Pass まで再処理する。
    if (record === null || record === undefined) return;
    // record を T として process() に投げる (型安全のため unknown 経由)
    this.process(record as T);
  }

  private drop(record: unknown, reason: string): void {
    this.dropHandler?.(record, reason);
  }

  private isThrottled(schemaId: string, rpsLimit: number): boolean {
    const now = Date.now();
    let counter = this.throttleCounters.get(schemaId);
    if (!counter || now - counter.windowStart >= 1000) {
      counter = { windowStart: now, count: 0 };
      this.throttleCounters.set(schemaId, counter);
    }
    if (counter.count >= rpsLimit) return true;
    counter.count++;
    return false;
  }
}

// ── 後方互換型エイリアス ──────────────────────────────────────────────────────

/**
 * Raw JSON object arriving at the pipeline ingress.
 * @deprecated 型参照用。Preprocessor<Record<string, unknown>> を使うこと。
 */
export type RawRecord = Record<string, unknown>;
