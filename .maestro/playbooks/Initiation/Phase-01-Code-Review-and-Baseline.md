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

- [x] ビルド済みアプリを起動してベースライン動作を確認する:
  - `scripts/verify-pen.mjs` など既存の `scripts/verify-*.mjs`（playwright-core の `_electron` で Electron を起動しスクリーンショットを撮るパターン）を参考に、アプリが正常に起動しメインウィンドウが表示されることを確認する
  - 起動時にコンソールエラーが出ていないか確認する
  - 起動直後のスクリーンショットを `screenshots/baseline-review.png` として保存する

  **実行結果 (2026-07-26):**
  - 既存の `verify-*.mjs` パターンを踏襲した `scripts/verify-baseline.mjs` を新規作成し、Electron 起動 → メインウィンドウ確認 → スクリーンショット保存を行った。
  - **環境上の問題**: `playwright-core` が `package.json` の devDependencies に含まれておらず（`package-lock.json` にも存在せず、グローバルインストールも無し）、既存の `verify-*.mjs` 群も含めて起動不能な状態だった。`npm install --save-dev playwright-core` で追加インストールして解消。この依存関係欠落は開発ツール体制のギャップとして `docs/review/test-tooling.md`（後続タスク）に記録する。
  - 起動結果: ウィンドウタイトル `PhotonMixer Phase 1`、URL `file:///D:/work/photon-mixer/index.html`、ウィンドウ数 1。`#canvas` 要素の存在を確認。
  - WebGPU 状態: `{"hasGPU":true,"adapterOk":true,"errorMsg":null}` — アダプタ取得成功。
  - コンソールエラー: **なし**（`console` の error イベント、`pageerror` イベントともに 0 件）。
  - 起動直後は「新規キャンバス」作成ダイアログ（幅/高さ入力、既定 2000x2000px）が表示される仕様であることを確認。ブラシ設定パネル・カラーパイプラインUI（EV、露出、トーン、モード等）も正常に描画されている。
  - スクリーンショットを `screenshots/baseline-review.png` に保存済み。

- [x] ペンエンジン・レンダリングコアをレビューする:
  - `src/pen/*.ts`（input, stabilization, interpolation, stroke）、`src/render/*.ts`、`src/core/*.ts`、`shaders/*.wgsl` を読み、`docs/spec.md` のペンエンジン仕様（補間・手ブレ補正・4xサブピクセルバッファ・スタンプ間隔等）と実装の整合性を確認する
  - 正確性の問題、エラーハンドリングの不足、デッドコード、仕様との乖離を洗い出す
  - `docs/review/pen-render-engine.md` に YAML front matter（`type: review-finding`, `title`, `created`, `tags: [review, pen-engine, rendering]`）付きで記録し、各問題に重要度（critical / minor / code-smell）を付ける

  **実行結果 (2026-07-26):**
  - `docs/review/pen-render-engine.md` を作成し、critical 3件・minor 1件・code-smell 2件を記録。
  - 主な発見: (1) `src/render/pipeline.ts` の4xブラシバッファがキャンバス全体サイズで確保されており仕様の「ブラシ範囲のみ4x処理」に反しVRAM/性能面で問題（既定2000x2000キャンバスで約488MiB）。(2) `src/pen/interpolation.ts` の高速時先端予測が、区間の始点・終点が同一点に潰れるバグにより実質機能していない（仕様の「加速度考慮予測」が効いていない）。(3) `shaders/blend.wgsl` の Normal/Overlay ブレンドが仕様の「Oklab経由」「Oklab L軸判定」を満たしておらず単純RGB演算になっている。minor は手ブレ補正のα計算式が仕様の `clamp` 式と異なる点。code-smell は入力層のサンプリングレート吸収が未実装（検出のみでデッドコード）な点と、筆圧判定の冗長な条件式。
  - 良好点（Catmull-Rom基本式、隔離ストロークバッファ、ダウンサンプルAA、筆圧非線形マッピング、Undo再レンダリング）も文書内に記録済み。
  - コード修正は行っていない（レビューのみ、このタスクの範囲外）。

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
