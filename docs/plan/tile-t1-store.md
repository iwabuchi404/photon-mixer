# T1: タイルストア詳細設計

目標: 4K・100レイヤーをメモリ破綻なしに保持する。描画・合成の正しさを保ちつつ、全面テクスチャ前提を排除する。

非目標: 合成の高速化（T2）、編集系のタイル対応（T3）、mipmap、HDR出力。

## 前提決定（ユーザー確認済み）
- 4K・100レイヤーはマックス想定。疎な内容が普通、全面ベタ100枚は病理
- `.pmx` v1 互換は捨てる。v1読み込みもなし。クリーンブレーク
- TILE_SIZE = 512（`TILE_SIZE` 定数で切替可能。256への変更は1行）
- 予算: タイル分 VRAM 1536MiB既定・RAM spill 4GB既定。統合メモリ機は半分（1024＋2048）＋手動切替

## メモリ試算（4K = 3840×2160、1タイル512² = 2MiB、40タイル/面）
- 全面時1面 63MiB → タイル40枚でも同量。疎なら占有分だけ
- 固定費（一時バッファ）約500MiB: isolated/accum/liveCombined/activeComposite/filterScratch/cellProcTemp/baseCache/displayCache
- 内容率20%×100層 ≈ 1.6GB ＋固定費 → 4GBカードで運用可。50%で溢れる→ spill が吸収

## 却下した案
- **texture_2d_array 一括管理**: バインド上限（ステージあたり16）と動的均一インデックス制約に当たる。T2はバインド2本のscissor ping-pongで行くため配列化の利点がない。個別テクスチャ＋Map管理にする
- **一時バッファのタイル化**: 4Kで計300MiB強に収まる。T1では全面のまま（リボン・スタンプの描画コード無変更）。将来プール共有で半減可

## データ構造

```ts
type TileIndex = number; // ty * tilesX + tx
interface TileRecord {
  texture: GPUTexture | null; // null = 退避中（RAMミラーあり）
  cellId: string;
  tx: number; ty: number;
  mirror: Uint16Array | null; // tight f16。退避コピー
  refcount: number;           // 1 = 所有セル＋履歴参照分
  pinned: boolean;            // 退避禁止（アクティブセル・描画bbox）
  lastUsed: number;           // LRU用世代カウンタ
}
```

- `TileStore`: `Map<TileKey, TileRecord>`（TileKey = cellId + TileIndex）
- 占有集合: `Map<cellId, Set<TileIndex>>`
- 世代カウンタはフレーム毎ではなく利用時に単調増加（u32で十分）

## API

```ts
class TileStore {
  constructor(device, opts: { tileSize, tilesX, tilesY, gpuBudgetBytes, spillBudgetBytes })
  // 取得（なければ確保 or 復帰。予約枠から同期的）
  getTile(cellId, tx, ty, forWrite: boolean): GPUTexture
  // COW: refcount>1 なら複製してから書き込み用に返す
  ensureWritable(cellId, tx, ty): GPUTexture
  addRef(cellId, tx, ty): void
  release(cellId, tx, ty): void
  getOccupancy(cellId): ReadonlySet<TileIndex>
  pinCell(cellId: string, on: boolean): void
  // 予約枠が枯渇したら后台退避。枯渇時は同期的緊急退避（正しさ優先）
  maintain(): Promise<void>
  // T3・サムネ用の橋渡し: 矩形領域を fullscreen scratch へ合成
  composeRegion(x, y, w, h, dst: GPUTexture): void
  readTile(cellId, tx, ty): Promise<Uint16Array>  // pmx保存用
  writeTile(cellId, tx, ty, data: Uint16Array): void // pmx読込用
  releaseCell(cellId: string): void
  stats(): { gpuBytes, spillBytes, tileCount, evictions }
}
```

## 退避・復帰ルール
- 退避対象: `refcount == 1`（履歴に掴まれていない）かつ `!pinned` かつ clean。LRU順
- 退避は readback（`copyTextureToBuffer`。512×8=4096B/行で256アライン適合）→ mirror 保持 → texture.destroy()
- 復帰は `writeTexture`（アライン不要）→ mirror 破棄。復帰タイルは clean 扱い
- 予約枠: 常時8タイル分を確保維持。下回ったら后台退避、枯渇時は緊急同期待避
- 参照カウント: 所有セル分1＋履歴参照分。履歴破棄・Undo上限超過で release

## 履歴（Undo基準画像）の扱い
現行の `historyBaseTextures`（セル毎 fullscreen）は廃止。基準画像はタイル参照集合＋refcount で持つ。追い出し時は `ensureWritable` で COW 複製するため、履歴が壊れないし重複確保もしない。

## pipeline.ts 移行箇所
- `committedTexture`（セル毎）→ TileStore。`drawToIsolated` の参照先・`bake` の書込先がタイル集合になる
- bake 書き込みはダーティタイル rect のみ。既存 bake パイプラインに srcRect uniform を追加（既定は全面＝現行動作）
- `readAllCells` / `writeCellData` → タイル反復（占有集合のみ）
- `requestCommittedSnapshot`（自動選択・smudge参照）→ `composeRegion` 全面版
- `getCellTexture`（UI）→ 当面 `composeRegion` で代用（サムネはT3で検討）
- `resizeCanvasSize` → tilesX/Y 再計算＋ストア再構築（中身破棄。T1ではリサイズでクリア扱いを維持）
- 選択・移動・変形・フィルターの CPU readback 系は T1 では `composeRegion` 経由のまま（T3で gather/scatter 化）

## `.pmx` v2
```
document.pmx (ZIP)
  ├── manifest.json   { version: 2, width, height, tileSize: 512, cells, rootEffects, view, swatches }
  └── tiles/<cellId>/<tx>_<ty>.f16   （非空タイルのみ・tight）
```
v1 は読み書きとも廃止。

## T2 への受け渡し
- 占有集合＋`rectToTiles` ヘルパー（ダーティ集合計算用）
- `markClean(tile)`／合成側のキャッシュは T2 で実装（baseCache/displayCache＋scissor ping-pong＋ダーティマスク）
- TileStore 自体は T2 で変更なしの想定

## テスト
- 単体（GPUモック）: 占有・LRU・refcount/COW・予算・ピン留め。TileStore を薄い Device 抽象に載せて fake で検証
- 実機（verify-*.mjs）: タイル境界またぎ描画の継ぎ目一致、微小予算での退避・復帰・再描画一致、100層積み上げの fps 計測
- 回帰: 既存 verify 群はそのまま通す（描画結果不变が条件）

## フェーズ
- **T1a**: TileStore 本体（spill なし）＋ committed 移行＋ pmx v2。単一キャンバス verify ✅完了
- **T1b**: RAM spill＋ピン留め＋退避 verify（微小予算）✅完了。COW履歴は不要と確定（深複製で足りる）。
  composeRegion は composeCell（セル全面）で代用し、矩形版は作らず。T3 で必要になれば追加

## As-built 差分（T1a 実装時）
- 履歴は参照＋COW ではなく**深複製**にした。redo のため基準を残す必要があり、
  複製（GPU copy・40タイル以下）は Undo 頻度なら十分速い。共有がないため refcount 不要
- 占有は**増える一方**（縮小はセル削除・クリア・再構築のみ）。上限は全面1枚分＝現行コストと同等のためリーク懸念なし。GC は T3 以降で検討
- 合成はセル毎 compose＋即時ブレンド（submit はセル数分）。バッチ共有 scratch は不正になるため採用せず。T2 で scissor＋ダーティに戻す
- 破壊的フィルターモーダルは死にコードのため削除（効果チェーンが現行経路）
- 移動・変形は previewTexture＋override 方式。タイルは確定まで触らず、cancel は捨てるだけ
- `.pmx` バージョンは `3.0`（タイル形式）。v2 以前の読み込みは廃止
