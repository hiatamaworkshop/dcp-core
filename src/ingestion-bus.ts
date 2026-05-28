/**
 * IngestionBus — schemaId チャンネルベースのイベントバス
 *
 * IngestorX → Preprocessor の接続層。
 * schemaId ごとにハンドラを登録し、push() で該当ハンドラを呼ぶ。
 *
 * Wildcard "*":
 *   subscribe("*", handler) で全 schemaId のイベントを受け取れる。
 *   特定 schemaId のハンドラが存在する場合、
 *   特定ハンドラ + wildcard ハンドラの両方が呼ばれる。
 *
 * 典型的な接続:
 *   bus.subscribe("player_move:v1", (raw) => preA.process(raw));
 *   bus.subscribe("combat:v1",      (raw) => preB.process(raw));
 *   bus.subscribe("*",              (raw) => audit.process(raw));
 *
 *   pool.onReceive((raw) => {
 *     const schemaId = raw["$schema"] as string;
 *     bus.push(raw, schemaId);
 *   });
 */

export type BusHandler<T = unknown> = (raw: T, schemaId: string) => void;

/**
 * Read-only observer of every push, regardless of schemaId.
 * Unlike a wildcard subscriber, a tap is conceptually non-routing: it is meant
 * for layers that watch the raw stream go by (retention buffers, recorders,
 * observation layers) without participating in delivery. The bus itself keeps
 * no buffer — a tap is the seam through which an external layer can build one.
 */
export type BusTap<T = unknown> = (raw: T, schemaId: string) => void;

export class IngestionBus<T = unknown> {
  private readonly channels = new Map<string, BusHandler<T>[]>();
  private readonly taps: BusTap<T>[] = [];

  /**
   * schemaId チャンネルにハンドラを登録する。
   * "* " はワイルドカード — 全 schemaId のイベントを受け取る。
   * 同じ schemaId に複数回 subscribe すると、すべてのハンドラが呼ばれる。
   */
  subscribe(schemaId: string, handler: BusHandler<T>): void {
    const list = this.channels.get(schemaId) ?? [];
    list.push(handler);
    this.channels.set(schemaId, list);
  }

  /**
   * 登録済みハンドラを解除する。
   * 同一ハンドラ関数参照で一致したものを削除する。
   */
  unsubscribe(schemaId: string, handler: BusHandler<T>): void {
    const list = this.channels.get(schemaId);
    if (!list) return;
    const next = list.filter((h) => h !== handler);
    if (next.length === 0) {
      this.channels.delete(schemaId);
    } else {
      this.channels.set(schemaId, next);
    }
  }

  /**
   * IngestorX から呼ぶ投入口。
   * schemaId に対応するハンドラ、続いて wildcard "*" ハンドラを呼ぶ。
   * ハンドラが存在しない場合は何もしない。
   */
  push(raw: T, schemaId: string): void {
    if (this.taps.length > 0) {
      for (const t of this.taps) t(raw, schemaId);
    }
    const specific = this.channels.get(schemaId);
    if (specific) {
      for (const h of specific) h(raw, schemaId);
    }
    const wildcard = this.channels.get("*");
    if (wildcard) {
      for (const h of wildcard) h(raw, schemaId);
    }
  }

  /**
   * Register a read-only tap that observes every push.
   * Returns an unregister function. Taps run before delivery handlers, but a
   * tap must not mutate the record or affect routing — it only watches.
   */
  tap(observer: BusTap<T>): () => void {
    this.taps.push(observer);
    return () => {
      const i = this.taps.indexOf(observer);
      if (i !== -1) this.taps.splice(i, 1);
    };
  }

  /** 登録済み schemaId の一覧 (デバッグ用)。 */
  subscribedChannels(): string[] {
    return [...this.channels.keys()];
  }

  /** 全チャンネルのハンドラをクリアする (テスト用)。 */
  clear(): void {
    this.channels.clear();
  }
}
