# Block 1: GPU アーキテクチャ刷新

## 目的

Phase 1 の暫定実装を本番アーキテクチャに置き換える。  
以降のすべてのブロックが依存する基盤なので最優先で着手する。

## スコープ

| 含む | 含まない |
|---|---|
| float32 テクスチャへの移行 | カラーパイプライン全体（Block 2） |
| committed texture ベイク方式 | 混色ロジック |
| 4x サブピクセルバッファ | レイヤーシステム |
| spacing の動的化（4x 不要化後） | Compute Shader への全面移行 |

---

## 1-A: テクスチャフォーマットを float32 に移行

### 背景

現状は `rgba8unorm`（0–255 整数正規化）を使用している。  
仕様では float32 リニア光量で内部保持するため `rgba16float` に移行する。

`rgba16float` を選ぶ理由（`rgba32float` ではなく）:
- WebGPU で RENDER_ATTACHMENT + TEXTURE_BINDING の両方が保証される
- 16bit half float は 0.001 精度（イラスト用途で十分）
- VRAM 使用量が `rgba32float` の半分

### 変更対象ファイル

**`src/render/pipeline.ts`**
```typescript
// 変更前
const BUFFER_FORMAT: GPUTextureFormat = 'rgba8unorm';

// 変更後
const BUFFER_FORMAT: GPUTextureFormat = 'rgba16float';
```

**`src/render/brush.ts`**
- `init()` の `format` パラメータで受け取るため変更なし（pipeline 側で `rgba16float` を渡す）
- ただしブレンド設定の `max` 操作が `rgba16float` で正しく動作することを確認する

**`src/render/composite.ts`**
- `bakePipeline` の format も `rgba16float` に変更
```typescript
this.bakePipeline = makePipeline('rgba16float');
```

### 確認事項

```typescript
// WebGPU が rgba16float の以下の usage をサポートするか確認
GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
// → Chrome/Electron の WebGPU では対応済み（feature: 'float32-filterable' が必要な場合あり）
```

`float32-filterable` feature が必要な場合、デバイス要求時に追加:
```typescript
const device = await adapter.requestDevice({
  requiredFeatures: ['float32-filterable'],
});
```

### 完了条件
- `rgba16float` テクスチャで描画が正常に動作する
- 1.0 超の HDR 値がクランプされずに保持される（将来の混色・OCIO 用途）

---

## 1-B: Committed Texture ベイク方式

### 背景

現状は全確定ストロークを毎フレーム再描画している（O(N) フレームコスト）。  
長時間描画でストロークが増えるとパフォーマンスが劣化するため、  
「ペンアップ時に committed texture へベイク」する方式に変更する。

### アーキテクチャ

```
committedTexture    確定済みストロークの蓄積（ペンアップ時に更新）
isolatedTexture     現在ストロークのみ（毎フレームクリア・max blend）

render() per frame:
  isolated をクリア → currentStroke を max blend で描く
  canvas: 背景 → committed → isolated の順に over blend
```

### 変更対象ファイル

**`src/render/pipeline.ts`**

```typescript
// 追加するプロパティ
private committedTexture!: GPUTexture;
private isolatedTexture!: GPUTexture;
// strokes[] は削除（テクスチャに移行）

// commitStroke の変更
commitStroke(points: StrokePoint[]): void {
  // 1. isolated に max blend でスタンプ描画
  // 2. isolated → committed へ over blend でベイク
  // 3. isolated をクリア
}

// render() の変更
render(): void {
  // Pass 1: isolated をクリア → currentStroke を max blend で描画
  // Pass 2: canvas = 背景 → committed (over) → isolated (over)
}
```

**`src/render/composite.ts`**

`bake(src, dst)` メソッドが必要。  
`src` を `dst` に over blend で合成（`loadOp: 'load'`）。

```typescript
bake(src: GPUTexture, dst: GPUTexture): void {
  // 独立した command encoder で dst に src を合成
  // loadOp: 'load' で dst の既存内容を保持したまま上書き
}
```

### 注意事項

- `bake()` は独立した command encoder を使うこと（render() と同エンコーダーに入れない）
- bake 後に isolated をクリアする必要がある（次フレームの render() で再クリアされるが明示的にクリアを推奨）
- resize 時は両テクスチャを再生成し、committed の内容は失われる（現段階で許容）

### 完了条件
- 50 ストローク描画後も 60fps を維持する
- ペンアップ後にストロークが正しく committed に保存されている
- 新しいストロークを描いても既存ストロークが消えない

---

## 1-C: 4x サブピクセルバッファ

### 背景

現状は spacing=1px の固定で対応しているが、根本的な解決策は  
「4x 解像度テクスチャで描画 → ダウンサンプル」である。

効果:
- 0.5px 相当のブラシが実現可能（4x では 2px になるため描画可能）
- ダウンサンプルがアンチエイリアスとして自然に機能する
- spacing=1px が不要になる（spacing を brush 直径の 10–25% に戻せる）

### アーキテクチャ

```
brushTexture4x    キャンバスの 4 倍解像度（ブラシ描画先）
↓ downsample compute shader
committedTexture  実解像度（rgba16float）
```

### 変更対象ファイル

**新規: `shaders/downsample.wgsl`**（Compute Shader）

```wgsl
// 4x → 1x ダウンサンプル（Box filter）
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dst_pos = gid.xy;
  let src_pos = dst_pos * 4u;
  // 4x4 ピクセルの平均を取る
  var sum = vec4f(0.0);
  for (var dy = 0u; dy < 4u; dy++) {
    for (var dx = 0u; dx < 4u; dx++) {
      sum += textureLoad(src, src_pos + vec2u(dx, dy), 0);
    }
  }
  textureStore(dst, dst_pos, sum / 16.0);
}
```

**新規: `src/render/downsample.ts`**

```typescript
export class DownsampleRenderer {
  // Compute pipeline で 4x → 1x ダウンサンプル
  async init(): Promise<void>
  downsample(src4x: GPUTexture, dst: GPUTexture): void
}
```

**`src/render/brush.ts` の変更**

```typescript
// init() で 4x テクスチャへのパイプライン作成
// renderStroke() の座標変換を 4x スケールに変更
// canvasWidth/Height を 4 倍して uniform に渡す
```

**`src/render/pipeline.ts` の変更**

```typescript
private brushTexture4x!: GPUTexture; // 4x 解像度

// createTextures() で 4x テクスチャも生成
private createTextures(width: number, height: number): void {
  this.brushTexture4x = this.makeTexture(width * 4, height * 4, 'rgba16float');
  this.isolatedTexture = this.makeTexture(width, height, 'rgba16float');
  this.committedTexture = this.makeTexture(width, height, 'rgba16float');
}

// render() でのフロー
// 1. brushTexture4x をクリア → currentStroke を max blend で 4x 描画
// 2. downsample: brushTexture4x → isolatedTexture
// 3. canvas: 背景 → committed → isolated
```

**`src/main.ts` の変更**

`spacing` を `maxSize * 0.1`（ブラシ直径の約 10%）に戻す:
```typescript
this.interpolator = new Interpolator({
  spacing: Math.max(1, Math.round(maxSize * 0.2)), // 4x 後は動的化
  speedThreshold: 2000,
});
```

### 完了条件
- ブラシサイズ 1px でギャップなく描ける
- 0.5px 相当（ブラシサイズ 2 / 4x 空間で 8px）が滑らかに描画できる
- spacing を 1px から動的値に戻してもギャップが出ない

---

## 実装順序

```
1-A（フォーマット移行）→ 1-B（ベイク方式）→ 1-C（4x バッファ）
```

1-A は小さな変更で影響が大きいため最初に確認する。  
1-B は 1-A が安定してから着手する。  
1-C は 1-B のベイク方式が確立してから着手する（4x テクスチャはベイクが前提）。

---

## テスト

```bash
# ビルド & 動作確認
npm run build
node scripts/verify-pen.mjs

# 確認すべき点
# - スクリーンショットで2本のストロークが両方表示されているか
# - コンソールエラーがないか（WebGPU バリデーションエラーに注意）
# - FPS が 56fps 以上を維持しているか
```

`rgba16float` 対応の GPU バリデーションエラーが出た場合は  
`adapter.features` を確認して `float32-filterable` の有無を確認する。
