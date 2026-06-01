# Block 5: レイヤーシステム

## 目的

複数レイヤーでの描画を可能にする。  
Block 2 で混色の感触・Block 4 でテクスチャブラシが確定した後に設計するため、  
レイヤー間の合成時に混色やテクスチャの挙動を正しく組み込める。

## 前提条件

- Block 1 完了（float32 テクスチャ、ベイク方式）
- Block 2 完了（カラーパイプライン、Oklab 合成）
- Block 3-A 完了（Undo/Redo、rebake が必要）

## スコープ

| 含む | 含まない |
|---|---|
| レイヤーデータ構造 | ベクターレイヤー |
| 合成シェーダー（6 種のブレンドモード） | クリッピングマスク |
| レイヤー UI（パネル） | グループレイヤー |
| Undo/Redo のレイヤー対応 | 調整レイヤー |
| レイヤーの不透明度・表示/非表示 | |

---

## 5-A: レイヤーデータ構造

**`src/layer/types.ts`**

```typescript
export type BlendMode =
  | 'normal'      // Oklab 空間
  | 'screen'      // リニア空間（光の重ね）
  | 'multiply'    // リニア空間（影・暗くなる）
  | 'overlay'     // リニア + L 閾値判定
  | 'add'         // リニア加算（発光）
  | 'luminosity'; // 輝度のみ合成（将来）

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;              // 0.0〜1.0
  blendMode: BlendMode;
  // GPU リソース
  committedTexture: GPUTexture; // 確定ストロークの蓄積（rgba16float）
  isolatedTexture: GPUTexture;  // 現在ストローク（rgba16float）
  // ストローク履歴（Undo 用）
  strokes: StrokePoint[][];
}

export interface LayerStack {
  layers: Layer[];
  activeLayerId: string;
}
```

**`src/layer/layer-manager.ts`**

```typescript
export class LayerManager {
  private stack: LayerStack;
  private device: GPUDevice;

  addLayer(name?: string): Layer {}
  removeLayer(id: string): void {}
  moveLayer(id: string, direction: 'up' | 'down'): void {}
  setActive(id: string): void {}
  getActive(): Layer {}
  setOpacity(id: string, opacity: number): void {}
  setBlendMode(id: string, mode: BlendMode): void {}
  setVisible(id: string, visible: boolean): void {}

  private createLayerTextures(width: number, height: number): {
    committed: GPUTexture;
    isolated: GPUTexture;
  } {}
}
```

---

## 5-B: 合成シェーダー

### アーキテクチャ

レイヤー合成は下から上へ順次行い、最終結果を表示テクスチャに出力する。

```
layer[0] (最下層)
  ↓ blend: normal
layer[1]
  ↓ blend: multiply
layer[2] (最上層)
  ↓
displayTexture → OCIO → canvas
```

**新規: `shaders/blend.wgsl`**

```wgsl
struct BlendUniforms {
  blend_mode: u32,  // 0=normal, 1=screen, 2=multiply, 3=overlay, 4=add
  layer_opacity: f32,
  _pad: vec2f,
}

@group(0) @binding(0) var<uniform> params: BlendUniforms;
@group(0) @binding(1) var dst_tex: texture_2d<f32>; // 下のレイヤー（合成済み）
@group(0) @binding(2) var src_tex: texture_2d<f32>; // 現在のレイヤー
@group(0) @binding(3) var samp: sampler;

fn blend_normal(src: vec3f, dst: vec3f) -> vec3f {
  // Oklab 空間で合成（src が上）
  let src_ok = linear_to_oklab(src);
  let dst_ok = linear_to_oklab(dst);
  return oklab_to_linear(src_ok); // src が前面にある場合は src の色
}

fn blend_screen(src: vec3f, dst: vec3f) -> vec3f {
  // リニア空間: 1 - (1-src)*(1-dst)
  return 1.0 - (1.0 - src) * (1.0 - dst);
}

fn blend_multiply(src: vec3f, dst: vec3f) -> vec3f {
  // リニア空間
  return src * dst;
}

fn blend_overlay(src: vec3f, dst: vec3f) -> vec3f {
  // Oklab L 軸で判定
  let L = linear_to_oklab(dst).x;
  if (L < 0.5) {
    return 2.0 * src * dst;
  } else {
    return 1.0 - 2.0 * (1.0 - src) * (1.0 - dst);
  }
}

fn blend_add(src: vec3f, dst: vec3f) -> vec3f {
  return clamp(src + dst, vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let src = textureSample(src_tex, samp, in.uv);
  let dst = textureSample(dst_tex, samp, in.uv);

  // src のアルファ × レイヤー不透明度
  let effective_alpha = src.a * params.layer_opacity;

  // un-premultiply
  let src_rgb = src.rgb / max(src.a, 0.0001);
  let dst_rgb = dst.rgb / max(dst.a, 0.0001);

  var blended: vec3f;
  switch (params.blend_mode) {
    case 0u: { blended = blend_normal(src_rgb, dst_rgb); }
    case 1u: { blended = blend_screen(src_rgb, dst_rgb); }
    case 2u: { blended = blend_multiply(src_rgb, dst_rgb); }
    case 3u: { blended = blend_overlay(src_rgb, dst_rgb); }
    case 4u: { blended = blend_add(src_rgb, dst_rgb); }
    default: { blended = src_rgb; }
  }

  // over 合成（premultiply に戻す）
  let out_alpha = effective_alpha + dst.a * (1.0 - effective_alpha);
  let out_rgb = (blended * effective_alpha + dst_rgb * dst.a * (1.0 - effective_alpha))
                / max(out_alpha, 0.0001);
  return vec4f(out_rgb * out_alpha, out_alpha);
}
```

**新規: `src/render/blend-renderer.ts`**

```typescript
export class BlendRenderer {
  private pipelines: Map<GPUTextureFormat, GPURenderPipeline> = new Map();
  private sampler: GPUSampler;
  private uniformBuffer: GPUBuffer;

  async init(format: GPUTextureFormat): Promise<void> {}

  // src レイヤーを dst に合成
  blend(
    encoder: GPUCommandEncoder,
    src: GPUTexture,
    dst: GPUTexture, // in-place で更新
    target: GPUTexture, // 出力先（dst と同じでも可）
    mode: BlendMode,
    opacity: number,
  ): void {}
}
```

---

## 5-C: レイヤー合成パイプライン

**`src/render/pipeline.ts` の大幅改修**

レイヤー対応版の render():

```typescript
render(): void {
  const { device, context } = this.renderer;
  const encoder = device.createCommandEncoder();

  // アクティブレイヤーの isolated に現在ストロークを描画
  const activeLayer = this.layerManager.getActive();
  this.renderCurrentStroke(encoder, activeLayer.isolatedTexture);

  // レイヤーを下から合成して displayTexture に積み上げる
  this.clearTexture(encoder, this.displayTexture);
  for (const layer of this.layerManager.getLayers()) {
    if (!layer.visible) continue;
    // 各レイヤーの最終外観 = committed + isolated の合成
    const layerFinal = this.mergeLayerTextures(encoder, layer);
    // displayTexture に blend
    this.blendRenderer.blend(
      encoder, layerFinal, this.displayTexture, this.displayTexture,
      layer.blendMode, layer.opacity,
    );
  }

  // OCIO 近似変換（リニア → sRGB）して canvas へ
  this.renderToCanvas(encoder);
  device.queue.submit([encoder.finish()]);
}
```

`displayTexture`: レイヤー合成後の float16 テクスチャ（OCIO 前）

---

## 5-D: レイヤー UI

### パネルレイアウト

```
右サイドバー:
  ┌──────────────────────┐
  │  レイヤー    [+] [-]  │
  ├──────────────────────┤
  │ ● [■] レイヤー 3     │ ← アクティブ
  │ ○ [■] レイヤー 2     │
  │   [不透明度: 80%]    │
  │   [合成: スクリーン] │
  │ ● [■] 背景           │
  └──────────────────────┘
```

**`src/ui/layer-panel.ts`**

```typescript
export class LayerPanel {
  constructor(
    private container: HTMLElement,
    private layerManager: LayerManager,
    private onActiveChange: (id: string) => void,
    private onRepaint: () => void,
  ) {}

  render(): void {} // DOM を更新
}
```

インタラクション:
- クリックでアクティブレイヤー切り替え
- [+] で新規レイヤー追加
- [-] で現在のレイヤー削除
- ドラッグで並べ替え（将来）
- 目アイコンで表示/非表示トグル
- 不透明度スライダー
- 合成モードドロップダウン

---

## 5-E: Undo/Redo のレイヤー対応

Block 3 の Undo をレイヤーを跨いで動作するよう拡張する。

```typescript
interface UndoOperation {
  type: 'stroke-add' | 'stroke-remove' | 'layer-add' | 'layer-remove' | 'layer-move';
  layerId: string;
  data: StrokePoint[] | null;
}
```

Undo 時はアクティブレイヤーの committed texture を  
そのレイヤーの strokes[] から再ベイクする。

---

## 完了条件

- [ ] 複数レイヤーで描画できる
- [ ] レイヤーの表示/非表示・不透明度が機能する
- [ ] Normal / Screen / Multiply / Overlay / Add の各合成モードが正しく動作する
- [ ] レイヤーの追加・削除・並べ替えができる
- [ ] Undo でレイヤーをまたいだ操作が取り消せる
