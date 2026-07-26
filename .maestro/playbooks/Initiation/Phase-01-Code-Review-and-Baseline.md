# Phase 01: コードレビューとベースライン確認

PhotonMixer（Electron + WebGPU 製のイラストソフト、v0.1.0リリース済み）の現状を確認し、既存のテスト・ビルド・起動が正常に動作するベースラインを確立する。あわせて、ペンエンジン・レンダリングパイプライン・カラーパイプライン・UI層・テスト体制を横断的にレビューし、発見した問題を `docs/review/` 配下に構造化された Markdown として記録する。このレビュー結果が後続フェーズ（バグ修正・リファクタリング・UI整理）の作業リストになる。

## Tasks

- [x] 既存のビルド・テストを実行してベースラインを確認する:
  - `npm test` を実行し、`tests/*.test.ts` の全テストが通ることを確認して結果を記録する
  - `npm run build` を実行し、TypeScript のビルド（`tsc`）がエラーなく完了することを確認する
  - 実行結果（成功/失敗、警告、エラー内容）を後続タスクのレビュー文書に反映できるようメモしておく（このタスクではコード修正はしない）

  **実行結果 (2026-07-26):**
  - `npm test`: **成功**。33 suites / 143 tests、全て pass（fail 0, cancelled 0, skipped 0, todo 0）。duration ~984ms。
  - `npm run build`: **成功**。`tsc` はエラー・警告ともに出力なし（クリーンコンパイル）。`shaders/` と `electron/preload.cjs` のコピーも正常完了。`dist/electron/main.js`、`dist/shaders/*.wgsl` の生成を確認。
  - コード修正は行っていない。ベースラインは健全であり、後続のアプリ起動確認・レビュータスクに進める状態。

- [ ] ビルド済みアプリを起動してベースライン動作を確認する:
  - `scripts/verify-pen.mjs` など既存の `scripts/verify-*.mjs`（playwright-core の `_electron` で Electron を起動しスクリーンショットを撮るパターン）を参考に、アプリが正常に起動しメインウィンドウが表示されることを確認する
  - 起動時にコンソールエラーが出ていないか確認する
  - 起動直後のスクリーンショットを `screenshots/baseline-review.png` として保存する

- [ ] ペンエンジン・レンダリングコアをレビューする:
  - `src/pen/*.ts`（input, stabilization, interpolation, stroke）、`src/render/*.ts`、`src/core/*.ts`、`shaders/*.wgsl` を読み、`docs/spec.md` のペンエンジン仕様（補間・手ブレ補正・4xサブピクセルバッファ・スタンプ間隔等）と実装の整合性を確認する
  - 正確性の問題、エラーハンドリングの不足、デッドコード、仕様との乖離を洗い出す
  - `docs/review/pen-render-engine.md` に YAML front matter（`type: review-finding`, `title`, `created`, `tags: [review, pen-engine, rendering]`）付きで記録し、各問題に重要度（critical / minor / code-smell）を付ける

- [ ] カラーパイプライン・選択範囲まわりをレビューする:
  - `src/color/*.ts`、`src/selection/*.ts`、`src/pmx.ts`、`src/autosave.ts` を読み、`docs/spec.md` のカラーパイプライン仕様（Oklab混色、float32リニア、Color EV、HDR、.pmx保存/読込のラウンドトリップ）との整合性を確認する
  - 発見した問題を `docs/review/color-pipeline.md` に front matter 付き（`tags: [review, color, pmx]`）で記録する

- [ ] UI層をレビューする:
  - `src/main.ts`（約2166行）、`src/ui/*.ts`、`src/ui/components/*.ts`、`index.html` を読み、責務の混在（UI配線・イベント処理・ファイルI/O・数値変換ユーティリティが `main.ts` に集中している点など）、コンポーネント間の重複コード、UI/UXの粗を洗い出す
  - 発見内容を `docs/review/ui-layer.md` に front matter 付き（`tags: [review, ui, architecture]`）で記録し、リファクタリング候補とUI改善候補を分けて記載する

- [ ] テストカバレッジ・開発ツールをレビューする:
  - `tests/*.test.ts`、`scripts/verify-*.mjs`、`tsconfig.json`、`package.json` の scripts を確認し、テストされていないモジュール、型チェック専用スクリプトの有無、CI相当の仕組みの有無など、開発体制のギャップを洗い出す
  - `docs/review/test-tooling.md` に front matter 付き（`tags: [review, testing, tooling]`）で記録する

- [ ] 全レビュー結果を統合したインデックス文書を作成する:
  - `docs/review/index.md` を作成し、front matter（`type: report`, `tags: [review, index]`）を付ける
  - `docs/review/pen-render-engine.md`、`docs/review/color-pipeline.md`、`docs/review/ui-layer.md`、`docs/review/test-tooling.md` の各発見事項を `[[pen-render-engine]]` のような Wiki リンクで参照しながら一覧化する
  - 重要度順（critical bug > minor bug > code smell > refactor opportunity > UI polish）に並べ、Phase 02（バグ修正）・Phase 03（リファクタリング）・Phase 04（UI整理）にどの項目が対応するか分類して明記する
