# dcp-minecraft から得た知見

dcp-minecraft（2026-04-06〜04-18）は、dcp-wrap を `file:` 依存で使い、実際の Minecraft サーバーのイベントを
パイプラインに流した実験場である。コアの概念はすべて dcp-wrap で定義されていて、dcp-minecraft には
ドメイン固有の部品（Bukkit アダプタ、GameFilter、GameRuleBrain、ダッシュボード、ベンチマーク用サーバー）がある。

この文書は、そこで分かったことのうちコアに効くものを集める。設計の前提は
[MINECRAFT_PIPELINE_PROPOSAL.md](MINECRAFT_PIPELINE_PROPOSAL.md)、出典は dcp-minecraft の
`docs/BENCHMARK_RESULTS.md`、`docs/MAPPING_LAYER_DESIGN.md`、`server/src/` とそのコミット履歴。

---

## 1. 計測結果（2026-04-07、ローカル）

### データ経路のレイテンシ

計測範囲は `HTTPIngestor.onReceive` の入口から `gate.process()` の完了まで
（IngestionBus → Preprocessor → GameFilter → Gate）。`process.hrtime.bigint()` で取り、直近 1000 件で集計した。

| 条件 | n | p50 | avg | p99 |
|---|---|---|---|---|
| 通常プレイ約 30 秒 | 182 | 63 μs | 89 μs | 427 μs |
| 通常プレイ約 3 分（JIT 安定後） | 365 | 67 μs | 94 μs | 375 μs |
| 比較ベンチ（n=500） | 500 | 55 μs | 135 μs | 4679 μs |

比較ベンチの p99 が跳ねたのは、GameFilter の fail が多く Brain が `routing_update` を出した tick に
リクエストが重なったため。Brain が静かなときの実質コストは p50 の 55 μs とみてよい。

README の「p50 = 45μs」は、上の計測のどれとも一致しない。出典を確かめるか、計測値に合わせる必要がある。

### 素の if 文、AJV との比較（n=500、同じイベントを並行送信）

| | p50 | avg | p99 |
|---|---|---|---|
| if 文 | 1.7 μs | 2 μs | 17.9 μs |
| AJV | 5.4 μs | 8 μs | 52.9 μs |
| DCP パイプライン | 55 μs | 135 μs | 4679 μs |

DCP の数値は検証以外の段（ルーティング、Preprocessor、GameFilter）も含み、if 文と AJV は
`JSON.parse` 後の検証だけを測っている。同じ処理量の比較ではない。
クライアントから見た往復時間は 3 つとも p50 で 2 ms 前後で、差はネットワークに埋もれる。
「検証そのものが速い」とは言えず、主張できるのは「制御の層を足しても往復時間に対して無視できる」まで。

### 動的な切り替えの実動確認（実プレイ）

| 操作 | 結果 |
|---|---|
| `/tp` 連打（瞬間移動） | `player_move:v1` が audit pipeline へ切り替わり、収まると戻った |
| ブロック連打 | 2 秒で 11 枚の高速設置を検出 |
| 異常な攻撃力で攻撃 | damage 447〜756 が `range_violation` として隔離された |
| 攻撃力 30 で連打 | `combat:v1` が pvp pipeline へ切り替わり、`$V` の damage 上限が 100 から 15 に下がった。収まると 100 に戻った |

---

## 2. Brain は状態を持たない。状態はシャドウ側の表に置く

GameRuleBrain は当初、「今どこへ迂回させているか」「`$V` を厳しくしたか」を自分の private フィールドで覚えていた。
これには次の問題があった。

- Brain を再起動すると状態が消え、パイプラインの実際の状態と食い違う。
- GameRuleBrain を ClaudeBrain に差し替えると、状態を引き継げない。
- 「今 `combat:v1` は迂回中か」を外から知る手段がない。

dcp-minecraft では、シャドウの現在値をすべて一つの表（MappingLayer、キーは `$<shadow>.<schemaId>.<field>`）に置き、
Brain はその表を読んで判断し、変えるときは理由つきで書き込むようにした。表は変更履歴を持つので、
いつ・何が・なぜ変わったかを追える。

**コアへの含意:** `BrainAdapter` は状態を持たない前提で書く。迂回中かどうか、`$V` を上書き中かどうかは、
アダプタの外（SchemaRegistry、RoutingLayer、またはそれらをまとめた表）から読む。
MappingLayer 自体は、設計時（2026-04-07）に「dcp-minecraft 層の責務であり、コアに取り込まない」と決めている。
[POSITION_AND_DIRECTION.md](POSITION_AND_DIRECTION.md) が決定の追跡対象に「MappingLayer の差分」を挙げているため、
コアに取り込むかどうかはこの判断を見直すときに決める。

**永続化の方針:** Brain による一時的な変更はメモリ上だけに置き、再起動すると config の初期値に戻す。
人間が確かめた変更だけを config に書き戻す。Brain は 2 秒の tick で状態を判断し直すので、再起動を
「まっさらな状態から始める」として扱う方が予測しやすい。

---

## 3. 自動の戻しにはクールダウンが要る

README は「異常が収まると Brain が迂回と `$V` を自動で元に戻す」と書いている。dcp-minecraft では、これが早すぎた。
異常を検出した次の tick で IPool が空になる（`$I` が途切れる）と、その tick で「収まった」と判断して即座に戻していた。

修正（dcp-minecraft `62dac1b`）では、発火した時刻を記録し、最後の発火から 3 tick（6 秒）経つまでは戻さないようにした。
「`$I` が無い」ことは「異常が収まった」ことの証拠にならない。戻しを判断する Brain アダプタは、
どれもこのクールダウンを持つ必要がある。RuleBasedBrain はまだ戻しをしないが、同じ形の戻しを入れるときに要る。

---

## 4. Ingestor 構成での `rowsPerSec`

`$ST-f` の `rowsPerSec` は、Monitor の `flow` メッセージから来る。`flow` を出すのは Streamer だけなので、
HTTPIngestor → Preprocessor → Gate という構成では、かつて `rowsPerSec` が常に 0 だった。
その結果、`rowsPerSec > N` の Weapon は決して発火せず（dcp-minecraft の `high_flow` Weapon はこの理由で外した。`b80e522`）、
`rowsPerSec < N` の Weapon は常に発火していた。

現在の StCollector は、ウィンドウ内に `flow` が届かなかったスキーマについて、vResult の件数をウィンドウ長で割って
`rowsPerSec` を出す（[src/st-collector.ts](../src/st-collector.ts)、テストは [src/st-collector.test.ts](../src/st-collector.test.ts)）。
この値が数えるのは Gate に届いた登録済みスキーマの行である。Preprocessor で隔離された行と、Gate が素通しする未登録スキーマの行は含まない。
dcp-minecraft で外した `high_flow` Weapon は、この前提で戻せる。

---

## 5. ShadowRuleBrain の到達点

設計は [BRAIN_AI_NOTES.md](BRAIN_AI_NOTES.md) §8 にある。実装（`dcp-minecraft/server/src/shadow-rule-brain.ts`）が
どこまで来ているかは次のとおり。

- **できていること:** アクションの種類ごとの weight、`$ST-brain` の集計を受けて weight を動かす `absorb()`、snapshot と復元。
- **配線されていないこと:** weight はログに出るだけで、判断には使われていない。`evaluate()` は基準の GameRuleBrain に
  そのまま委ね、`isAutonomous()` で Brain の呼び出しを省く経路も無い。
- **計算の偏り:** `absorb()` は基準側（`canonAction`）の weight しか動かさず、LLM が何を選んだか（`llmAction`）は使っていない。
- **重複:** アクションの種類（`ActionKind`）と主アクションの判定（`primaryAction`）を、dcp-wrap の [src/brain.ts](../src/brain.ts)
  と同じ内容で書き直している。dcp-wrap 側が export していないためである。

コアに持ってくるなら、weight を Brain の呼び出しを省く判断に使う配線、`llmAction` の扱い、`ActionKind` の export を先に決める。
lighthouse の実測（[POSITION_AND_DIRECTION.md](POSITION_AND_DIRECTION.md) §3）では、LLM の Brain の提案は
「いつ、何に対して」がノイズに近かった。LLM との一致率で weight を育てる前提は、この結果と突き合わせて見直す必要がある。

---

## 6. すでに dcp-wrap に戻ったもの

- **botId と pipelineId の取り違え:** ClaudeBrain で、アクション対象の pipelineId をコードが埋めるようにした（[BRAIN_AI_NOTES.md](BRAIN_AI_NOTES.md) §2）。
- **スキーマに無いフィールドの検出:** `SourceAdapter.decode()` が `extraFields` を返し、Preprocessor が `unknown_field` として隔離する（`e47e210`）。
  dcp-minecraft の Bukkit アダプタ（`fb86dbe`）が最初の利用者。
- **ドメイン知識の外出し:** ClaudeBrain の `systemContext` オプション（dcp-minecraft の `config/brain-prompt.json` を渡す形）。

## 7. 持ってこないもの

GameFilter、GameRuleBrain、Bukkit アダプタ、ダッシュボード、ベンチマーク用サーバーは Minecraft 固有なので、dcp-minecraft に残す。
