# T2: ダーティタイル合成キャッシュ（実装済み）

目的: 100層でも合成が破綻しないこと。汚れたタイルだけ再計算する。

## 2段キャッシュ
- `baseCache`: 層スタック結果（背景込み）
- `displayCache`: 撮影スタック＋ライブ適用後（リニアHDR。露出・トーンは表示シェーダー側）
- クリーンなタイルの再描画コストはゼロ。アイドル時は GPU 完全停止

## 再計算方式
- 層スタック: `buildStackOps` で (タイル×層) のブレンド op 列を構築し、`blendTiles` で **1 submit** にまとめる。各 op は scissor 矩形＋タイル UV remap（`blend.wgsl: fs_main_tile`）
- 撮影チェーン: `filterRenderer.apply(..., scissor)`。読みは全域（ぼかしのはみ出しが正しい）、書きだけクリップ
- 中間 ping-pong は compA/compB。最終段だけ displayCache へ直接書く（コピー削減）
- 空タイルは `blankTile`（背景色）コピー

## baseCache 常時正当の不変条件
baseCache は全タイル常に正しい内容を保つ（初期全面クリア＋汚タイル再計算＋ release 時の blank 戻しは不要＝再計算が空タイルを blank で埋めるため）。
これにより display 再計算の入力は常に baseCache でよく、blur のマージン読みも正しい。

## ライブ・modal は override 統一
- ライブストローク・移動・変形プレビューはすべて「指定セルのソース差替」として扱う
- override op は fullscreen テクスチャ＋scissor（legacy `fs_main` 経路）
- erase はライブ合成時（activeComposite）に解決済みのため、display 側の重ねは常に over

## ダーティ規則
- 描画bake: 書き込みタイルを両方汚す
- 移動・変形確定: 書き戻しタイルを両方汚す（ドラッグ中は汚さない）
- 効果パラメータ: display のみ（セル効果は占有＋はみ出し半径、撮影は全占有）
- 不透明度・ブレンド・表示・並べ替え・フォルダ: 両方（影響範囲の占有和）
- 背景色: 全タイル両方＋blankTile 更新
- Undo/redo/クリア/削除: 変更前後の占有和を両方汚す
- リサイズ・読込: 全タイル両方（dirty 集合自体もクリアする。旧グリッドの index 残存に注意）
- パン・ズーム・露出・トーン: 再計算なし（表示変換のみ）

## 振る舞い変更（旧実装から）
- `freezeRootEffects` は透明下地ではなく表示一致（背景込み）で統合する
- `compositeLayers` は廃止。`render()` / `exportToPNG` / `requestCompositeSnapshot` はキャッシュ経由
- リサイズ時の dirty 集合クリア忘れはクラッシュ級になるため、再計算側でも index 検証ガードあり

## 実測（dGPU・2000²・30層・疎）
- 全面再計算: base 0.6ms ＋ display 1.5ms（CPU dispatch 時間）
- 通常ストローク: 汚1〜4タイルのみ。60fps 維持
- リサイズ dirty 残存のクラッシュはガード＋クリアで対応済み

## 残課題（T3 以降）
- modal ドラッグ中は全占有を毎フレーム再計算（現行と同等コスト）。将来は override 差分化
- compA/compB・scratch 群のプール共有化（固定費 700MiB @4K の削減）
- fps 表示が headless 環境で 0 になるのは rAF タイムスタンプ由来の計測アーティファクト（実害なし）
