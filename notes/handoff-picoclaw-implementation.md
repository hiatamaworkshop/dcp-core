# PicoClaw DCP Hook 実装 — 引き継ぎ

## 前提
- dcp-core: npm パッケージ公開済み (github.com/hiatamaworkshop/dcp-core)
  - dcpEncode() — inline schema で1関数エンコード
  - SchemaGenerator — 未知JSON からスキーマ推定
  - 防御ガード: maxDepth=3, maxFields=20, minPresence=0.1
  - GitHub API ベンチマーク: 7fields=33%削減, 15fields=50%削減

- dcp-docs: 仕様サイト公開済み (dcp-docs.pages.dev)

- dcp-output-controller: GitHub公開済み、45テスト通過
  - コアロジック(decode/inject/intercept)はランタイム非依存

## OpenClaw 実験結果
- skill/prompt レベルの DCP 制約は効かない（内蔵 prompt が優先）
- hook レベルが必須だが OpenClaw は output hook 未実装 (#12914)
- OpenClaw Docker起動中(port 18789), Telegram bot接続済み
- API key: Anthropicクレジット$5投入済み、Haiku動作確認済み
- → PicoClaw after_tool で先行実証する方針に確定

## PicoClaw hook 設計 (notes/picoclaw-dcp-hook.md)
- after_tool (ToolInterceptor, modifiable) → 入力 DCP 化
- before_llm (LLMInterceptor, modifiable) → コントローラ注入
- after_llm (LLMInterceptor, modifiable) → Cap + Decode
- Out-of-process: JSON-RPC over stdio → Node.js/dcp-core 直結
- PicoClaw: Go製, 26K stars, MCP native, v0.2.4

## 完了ステップ (2026-03-28)
1. ✓ PicoClaw ソースから JSON-RPC ペイロード形式を確認
   - ToolResultHookResponse: { meta, tool, arguments, result: { for_llm, for_user, silent, is_error }, duration }
   - レスポンス: { action: "modify", result: { ...modified payload } }
2. ✓ after_tool hook で dcp-core を呼ぶ外部プロセスを実装 → src/picoclaw-hook.ts
   - hook.hello / hook.after_tool ハンドラ
   - 明示スキーマ (id + fields) と "auto" (SchemaGenerator) の両対応
   - PICOCLAW_DCP_TOOLS env で tool→schema マッピング設定
3. ✓ テスト 6/6 通過 (picoclaw-hook.test.ts)
   - hello, passthrough, DCP encode, error passthrough, non-JSON passthrough, auto-schema
4. ✓ PicoClaw config 例 → examples/picoclaw-config.json

## 次のステップ
1. PicoClaw 実機で動作確認 (Telegram bot 経由)
2. before/after token 数の比較データを取得
3. before_llm hook でコントローラ注入 (output DCP 化)
4. after_llm hook で Cap + Decode (messaging channel 向け)

## 関連リポジトリ
- github.com/hiatamaworkshop/dcp-core
- github.com/hiatamaworkshop/dcp-docs
- github.com/sipeed/picoclaw
- github.com/openclaw/openclaw (output hook #12914 未実装)
