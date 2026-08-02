# Phase 02: バグ修正

Phase 01 のコードレビューで `docs/review/` に記録された発見事項をもとに、実際のバグを優先度順に修正する。スタイルの好みやリファクタリング候補（Phase 03 で扱う）は対象外とし、動作の正確性に関わる問題のみを扱う。各修正は対象範囲を限定し、無関係な変更やリファクタリングを混ぜない。

## Tasks

- [ ] `docs/review/index.md` と各 `docs/review/*.md` を読み込み、確認された正確性バグ（correctness bug）のみを重要度順に一覧化する。修正前に該当ファイルの現在のコードを実際に読み、レビュー時点から変更されていないか、問題が今も再現するかを再確認する。バグが1件も見つからない場合はその旨を記録し、以降のタスクはスキップして Phase 03 に進めることをメモする。

- [ ] `docs/review/pen-render-engine.md` に記録された critical / minor バグを修正する:
  - 対象: `src/pen/*.ts`、`src/render/*.ts`、`src/core/*.ts`、必要に応じて `shaders/*.wgsl`
  - 既存の実装パターン（隔離バッファ方式、プリマルチプライドアルファ、instanced draw など）を踏襲し、無関係な構造変更は行わない

- [ ] `docs/review/color-pipeline.md` に記録されたバグを修正する:
  - 対象: `src/color/*.ts`、`src/selection/*.ts`、`src/pmx.ts`、`src/autosave.ts`
  - `docs/spec.md` のカラーパイプライン仕様（Oklab混色、float32リニア、HDR、.pmx ラウンドトリップ）との整合を優先する

- [ ] `docs/review/ui-layer.md` に記録されたバグ（UI/UXの見た目調整ではなく、動作不良・イベント処理の不具合など）を修正する:
  - 対象: `src/main.ts`、`src/ui/*.ts`、`src/ui/components/*.ts`
  - 見た目のブラッシュアップは行わない（Phase 04 で対応する）

- [ ] 修正した各バグについて、再発防止のための回帰テストを追加・更新する:
  - 該当する `tests/*.test.ts`（`color.test.ts`, `pen.test.ts`, `selection.test.ts` など既存ファイルの構成を参考にする）にケースを追加する
  - 既存のテストヘルパーやアサーションのパターンを再利用し、新しいテストユーティリティを不必要に作らない

- [ ] `npm test` と `npm run build` を実行して全テスト・ビルドが通ることを確認する。加えて、修正した領域に関連する `scripts/verify-*.mjs`（例: ペン修正なら `verify-pen.mjs`、レイヤー関連なら `verify-layers.mjs` など）を実行し、視覚的な回帰がないことを確認する。

- [ ] `docs/review/index.md` を更新し、修正済みの項目に解決済みの印と簡潔な対応内容を追記する。Phase 03 のリファクタリング範囲が大きいために今回は見送った項目があれば、その理由とともに明記する。
