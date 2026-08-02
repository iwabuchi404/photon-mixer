# Phase 03: リファクタリング

Phase 01 のレビューで指摘されたアーキテクチャ上の問題（`src/main.ts` が約2166行の巨大ファイルになっている、`src/render/pipeline.ts` が約1170行で処理の重複がある、UIコンポーネント間の重複など）を解消する。挙動を変えないことを最優先し、各リファクタリングの後には必ずテストとビルドで動作を確認する。

## Tasks

- [ ] `docs/review/index.md` のリファクタリング候補（refactor opportunity）項目を読み込み、`src/main.ts` と `src/render/pipeline.ts` の現状の行数・責務の混在状況を再確認してから着手する。

- [ ] `src/main.ts` を責務ごとに分割する:
  - ツール/イベント配線、キャンバスのポインター・ペンイベント処理、ファイルI/O（保存・読込・エクスポート）の配線などを、既存の `src/ui/engine-ctx.ts` や `src/ui/tool-config.ts` の構成パターンに倣って別モジュールに切り出す
  - `main.ts` は初期化とモジュール間の配線のみを行う薄いエントリーポイントにする
  - 既存のモジュール分割パターン（`src/ui/`, `src/pen/`, `src/render/` の構成）を参考にし、新しい命名規則を勝手に導入しない

- [ ] `src/render/pipeline.ts` の重複処理を整理する:
  - brush / composite / downsample / filter / transform 各パスで重複しているバッファ確保・バインドグループ生成ロジックを洗い出し、共通ヘルパーとして抽出する
  - 既存の `src/render/blend-renderer.ts` の構成パターンを参考にする
  - ランタイムの描画結果・パフォーマンス特性を変えないことを確認する

- [ ] `src/main.ts` に埋め込まれている汎用ユーティリティ（`float32ToFloat16`, `float16ToFloat32`, `sampleSnapshot` など）を、責務に応じて `src/color/` または新設の `src/core/float16.ts` に切り出し、全ての呼び出し箇所を更新する。

- [ ] `docs/review/ui-layer.md` で指摘された UI コンポーネント間の重複（`color-picker.ts`, `curve-editor.ts`, `tool-settings.ts` などに散在する似たDOM操作・イベントバインディングのパターンなど）を、共通ヘルパーへの抽出によって解消する。

- [ ] 各リファクタリングをひとまとまり完了させるごとに `npm test` と `npm run build` を実行して既存機能が壊れていないことを確認し、最後に `scripts/verify-pen.mjs`、`scripts/verify-layers.mjs`、`scripts/verify-colorpicker.mjs`、`scripts/verify-pmx.mjs` など変更範囲に関連する検証スクリプトを実行して視覚的・機能的な回帰がないことを確認する。

- [ ] `docs/review/index.md` のリファクタリング項目を完了済みに更新し、`docs/grand-plan.md` のプロジェクト構造の記述が新しいモジュール構成と食い違っていないか確認して、必要であれば実態に合わせて更新する。
