# DCP Pipeline × Minecraft Server — 設計案

> 実装（dcp-minecraft、2026-04-06〜04-18）の結果と、そこから得た知見は [MINECRAFT_FIELD_NOTES.md](MINECRAFT_FIELD_NOTES.md) にある。

## 目的

DCP Pipeline の有効性を実環境で検証するためのデモプロジェクト案。
金融・産業 IoT は規制・契約が複雑なため、**Minecraft をストリーム処理の題材**に選ぶ。

- プロトコル仕様が公開されている（wiki.vg）
- 高頻度イベント（20tick/sec × 数百プレイヤー）が自然に発生する
- ルールベース制御（チート検知・イベント検出）が自然に実装できる
- Brain AI なしでも DCP の有効性を示せる

---

## アーキテクチャ概要

```
[Minecraft Java Server (Paper)]
  └── Bukkit Plugin
        └── イベントフック（移動・ブロック・戦闘・チャット）
              ↓ HTTP / local IPC
[DCP Pipeline Server (Node.js)]
  ├── IngestorX × 3  (ロードバランサ経由)
  ├── SchemaCache     (インメモリ TTL)
  ├── Preprocessor Core
  ├── Gate ($V)
  ├── $R routing
  ├── $ST 統計収集
  └── GameRuleBot     (ルールベース Brain AI モック)
        ↓
  [PostBox]
        ↓
  [PipelineControl → Lazy Switching]
```

Minecraft Server と DCP Pipeline Server は**プロセス分離**。
Plugin が橋渡しし、DCP Pipeline は Minecraft の内部を知らない。

---

## スキーマ設計

### player_move:v1
```
["$S","player_move:v1",6,"playerId","x","y","z","yaw","ts"]
["$V","player_move:v1","type:[string,float,float,float,float,int]","range:1:-30000000:30000000","range:2:-64:320","range:3:-30000000:30000000"]
```

### block_place:v1
```
["$S","block_place:v1",5,"playerId","x","y","z","blockId"]
["$V","block_place:v1","type:[string,int,int,int,string]"]
```

### combat:v1
```
["$S","combat:v1",5,"attackerId","targetId","damage","weapon","ts"]
["$V","combat:v1","type:[string,string,float,string,int]","range:2:0:100"]
```

### chat:v1
```
["$S","chat:v1",3,"playerId","message","ts"]
["$V","chat:v1","type:[string,string,int]"]
```

---

## ボトルネック分析

```
Minecraft Server (JVM)
  └── 20tick/sec 固定サイクル    ← 天井はここ、DCP と無関係

DCP Pipeline
  └── Gate ($V): O(fields) 算術  ← 数百プレイヤー規模では絶対に詰まらない
```

ボトルネックの層が異なるため干渉しない。
DCP Pipeline は Minecraft Server の**外側**でイベントを処理する。

---

## GameRuleBot — ルールベース Brain AI モック

実 LLM は使わない。ルールベースで十分に DCP の制御層を検証できる。
「LLM なしでもここまでできる」の実証がむしろ目的に合っている。

```typescript
class GameRuleBot implements BrainAdapter {
  evaluate({ packets, quarantines }): BrainDecision {

    // チート検知: 移動速度異常
    if (speedAnomaly(packets))
      return { rerouteSchema: { "player_move:v1": "audit-pipeline" } }

    // イベント集中: 特定座標に戦闘が集中
    if (combatCluster(packets))
      return { rerouteSchema: { "combat:v1": "pvp-pipeline" } }

    // サーバ負荷: $ST の fail率上昇
    if (failRateHigh(packets))
      return { throttle: { "block_place:v1": 100 } }  // 100 rps に制限

    // スキーマ進化: 新バージョンの未知フィールド
    if (quarantines.some(q => q.reason === "unknown_field"))
      return { quarantineApprove: quarantines.map(q => q.payload.quarantineId) }

    return {}
  }
}
```

| トリガー | 判断 | Lazy Switching の効果 |
|---------|------|----------------------|
| 移動速度異常 | チート疑い | `player_move:v1` → audit-pipeline に追加ルート |
| 戦闘集中 | イベント発生 | `combat:v1` → pvp-pipeline に切替 |
| fail率上昇 | 負荷過多 | `block_place:v1` をスロットル |
| unknown_field | バージョンアップ | Quarantine 承認 → スキーマ進化 |

---

## Plugin → Pipeline 通信層

Minecraft Server 本体のプロトコル（Java Edition: TCP バイナリ / Bedrock: RakNet UDP）とは完全に独立している。Plugin が「発信者」になるため、通信方式は自由に選択できる。

### 選択肢の比較

| 方式 | 遅延 | 信頼性 | 用途 |
|------|------|--------|------|
| **HTTP (TCP)** | 高め | 高い | 開発・デバッグ段階 |
| **UDS (Unix Domain Socket)** | ほぼゼロ | 高い | 同一VM本番構成 |
| **UDP** | 最速 | 欠落あり | 複数サーバー集約・欠落許容データ |

### データ種別と推奨方式

```
欠落許容できる (UDP / UDS どちらでも可):
  player_move:v1   — 移動ログ、1パケット消えても統計に影響なし
  $ST 統計         — ウィンドウ集計、欠落は誤差範囲

欠落許容できない (UDS 推奨):
  combat:v1        — ダメージ確定イベント
  block_place:v1   — ブロック操作の確定
  chat:v1          — テキスト記録
```

### 実装フェーズ別の推奨

```
Phase A (開発・検証):
  Bukkit Plugin → HTTP POST → HTTPIngestor
  理由: デバッグ容易、Plugin側実装がシンプル

Phase B (同一VM本番):
  Bukkit Plugin → UDS → UDSIngestor
  理由: TCP/IPスタックを通らない、遅延ほぼゼロ、DCPの思想と一致

Phase C (複数サーバー集約):
  Bukkit Plugin × N → UDP → UDPIngestor × 3 (IngestorPool)
  理由: ネットワーク越え、欠落許容データに限定
```

**最初は HTTP で動かす。** ボトルネックになるのを確認してから UDS/UDP に切り替える。最初からストイックにすると実装が詰まる。

---

## デプロイ構成案

### ローカル（開発・検証）

```
localhost
  ├── Paper Server      :25565
  └── DCP Pipeline      :3000  (HTTPIngestor)
        └── Bukkit Plugin → POST localhost:3000/ingest
```

### 公開デモ（Oracle Cloud Free Tier）

```
Oracle Cloud ARM VM (4コア / 24GB / 無料枠)
  ├── Paper Server      :25565  (外部公開)
  ├── DCP Pipeline      UDS     (内部のみ、同一VM)
  └── $ST dashboard     :3001   (外部公開 — ベンチマーク可視化)
```

Oracle Cloud Free Tier が現実的。ARM 4コア・24GB メモリが無料で使える。
同一VM構成なら UDS が自然な選択。

---

## 検証できること

| 検証項目 | 方法 |
|---------|------|
| 高頻度ストリーム処理性能 | $ST の pass_rate / throughput を計測 |
| Lazy Switching の応答遅延 | ルート変更から次行適用までのレイテンシ |
| Quarantine によるスキーマ進化 | Minecraft バージョンアップ時の未知フィールド対応 |
| ルールベース Brain AI の実用性 | LLM なしでの制御精度 |
| ボトルネック層の分離 | Minecraft tick 遅延 vs Pipeline 遅延の独立性確認 |

---

## 最小実装ステップ

1. Paper Server をローカル起動
2. Bukkit Plugin で `PlayerMoveEvent` を JSON で `POST /ingest` に送信
3. `player_move:v1` スキーマ登録
4. Preprocessor → Gate → $ST で throughput 確認
5. 移動速度チェック Weapon を実装し GameRuleBot で Lazy Switching 動作確認

---

## 現時点の方針

**設計案として記録。実装はフォーク新プロジェクトで着手。**

`dcp-wrap` から Pipeline コアをライブラリとして切り出し、
Minecraft Plugin + DCP Pipeline Server を別リポジトリで構成する。

---

## 展開候補: 他ゲームへの DCP 適用

Minecraft で基盤を確立した後、同様の構成で展開できるゲームの候補。

### Factorio — 最有力候補

```
工場の生産ライン = 文字通りのパイプライン

アイテムフロー  → $V  (品質チェック)
ベルトルーティング → $R  (仕分け)
生産統計        → $ST (スループット監視)
Brain AI        → 生産ライン最適化・ボトルネック検知
```

「パイプライン」が比喩でなく実物になる。DCP の思想とゲームの構造が**完全に同型**。
デモとしての説得力は Minecraft より高い。

- MOD API: Lua (公式サポート)
- イベント密度: Minecraft より桁違いに高い（工場規模による）
- 橋渡し層: Lua MOD → HTTP/UDS → DCP Pipeline

### Minetest — 実験台として最適

```
Minecraftクローン、完全 OSS
サーバーコードが公開されている
Lua プラグインで自由に改造可能
制限が最も少ない
```

Minecraft の Bukkit API より自由度が高い。プロトコル層から触れるため、
IngestorX の BinaryAdapter 実装の実験台として適している。

### Veloren — Rust 実装 MMO

```
Rust 製、完全 OSS
パフォーマンス志向のコミュニティ
MMO スケールのイベントストリーム
```

DCP Pipeline も Rust で実装すれば、「Rust ネイティブのゼロコスト DCP パイプライン」というデモになる。

### OpenRA — RTS イベントストリーム

```
Command & Conquer 系、OSS
RTS のユニット移動・戦闘イベントが高頻度
ネットワーク同期問題に DCP の $R / $ST が有効な可能性
```

### 展開ロードマップ案

```
Phase 1: Minecraft (Java / Paper)
  → HTTP/UDS Ingestor、JSONAdapter、GameRuleBot
  → Lazy Switching デモ確立

Phase 2: Factorio
  → Lua MOD ブリッジ、高密度イベントストリーム
  → 「工場ライン = DCP パイプライン」デモ

Phase 3: Minetest or Veloren
  → BinaryAdapter 実装、プロトコル層からの直接変換
  → JSON 経由なしの真の positional array ストリーム
```
