# Block 4: テクスチャブラシ ＋ ブラシプリセット

## 目的

紙目テクスチャ等による表現の幅を広げ、プリセット機能で描画設定の切り替えを容易にする。

## 前提条件

- Block 2-B 完了（WGSL カラー変換、brush.wgsl の拡張に必要）

## スコープ

| 含む | 含まない |
|---|---|
| テクスチャスタンプ（キャンバス座標系サンプリング） | 筆圧で散布するスペシャルブラシ |
| ブラシテクスチャの読み込み・管理 | ブラシエンジンのフル刷新 |
| ブラシプリセット保存/読み込み | クラウド同期 |
| デフォルトプリセット数種類 | |

---

## 4-A: テクスチャスタンプ

### 概念

各スタンプの円形マスクに、テクスチャを乗算する。  
テクスチャはキャンバス座標系でサンプリングするため、  
ストロークを重ねるほど紙目が浮き出る「擦り出す」感覚が得られる。

```
stamp_alpha = circle_sdf_alpha * texture_sample(canvas_uv)
```

### `shaders/brush.wgsl` の変更

Uniform に追加:
```wgsl
struct Uniforms {
  // ... 既存
  use_texture: u32,    // 0=無効, 1=有効
  texture_scale: f32,  // テクスチャのスケール（1.0=ピクセル等倍）
}

@group(0) @binding(5)
var brush_texture: texture_2d<f32>;   // ブラシテクスチャ（グレースケール）

@group(0) @binding(6)
var brush_tex_sampler: sampler;
```

フラグメントシェーダー:
```wgsl
// キャンバス座標 UV でテクスチャサンプリング（vertex shader から渡す）
var stamp_alpha = uniforms.brush_color.a * (1.0 - smoothstep(0.8, 1.0, dist));

if (uniforms.use_texture != 0u) {
  let tex_uv = input.canvas_uv * uniforms.texture_scale;
  let tex_value = textureSample(brush_texture, brush_tex_sampler, tex_uv).r;
  stamp_alpha *= tex_value;
}
```

### `src/render/brush.ts` の変更

```typescript
interface BrushConfig {
  color: { r: number; g: number; b: number; a: number };
  wetRatio: number;
  textureEnabled: boolean;
  textureScale: number;      // 1.0 = 等倍
  textureData: ImageData | null; // null = テクスチャなし
}

// テクスチャ GPUTexture の管理
private brushTexture: GPUTexture | null = null;

setTexture(imageData: ImageData | null): void {
  this.brushTexture?.destroy();
  if (!imageData) {
    this.brushTexture = null;
    return;
  }
  // ImageData → GPUTexture（rgba8unorm, グレースケール）
  this.brushTexture = this.device.createTexture({
    size: [imageData.width, imageData.height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  this.device.queue.writeTexture(
    { texture: this.brushTexture },
    imageData.data,
    { bytesPerRow: imageData.width * 4 },
    [imageData.width, imageData.height],
  );
}
```

### テクスチャ読み込み

**`src/ui/texture-loader.ts`**

```typescript
export async function loadBrushTexture(path: string): Promise<ImageData> {
  // Electron の file:// で PNG を読み込む
  const img = new Image();
  img.src = path;
  await new Promise((r) => img.onload = r);
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}
```

### デフォルトテクスチャ

`textures/` ディレクトリに以下を同梱:
- `paper-rough.png` — 粗い紙目
- `paper-smooth.png` — なめらかな紙目
- `canvas-linen.png` — キャンバス布目

テクスチャは 512×512px のグレースケール PNG（白=不透明、黒=透明）。

---

## 4-B: ブラシプリセット

### プリセット定義

**`src/brush/preset.ts`**

```typescript
export interface BrushPreset {
  id: string;
  name: string;
  // StrokeManager 設定
  maxSize: number;
  baseSize: number;
  pressureCurve: 'linear' | 'ease-in' | 'ease-out' | 'smooth';
  // BrushConfig 設定
  opacity: number;       // 0.0〜1.0
  wetRatio: number;      // 0.0〜1.0
  textureEnabled: boolean;
  texturePath: string | null;
  textureScale: number;
  // Interpolator 設定
  spacing: number;
}

export const DEFAULT_PRESETS: BrushPreset[] = [
  {
    id: 'solid-round',
    name: '丸ブラシ',
    maxSize: 20, baseSize: 2,
    pressureCurve: 'smooth',
    opacity: 1.0, wetRatio: 0.0,
    textureEnabled: false, texturePath: null, textureScale: 1.0,
    spacing: 1,
  },
  {
    id: 'pencil',
    name: '鉛筆',
    maxSize: 8, baseSize: 1,
    pressureCurve: 'ease-in',
    opacity: 0.8, wetRatio: 0.0,
    textureEnabled: true, texturePath: 'textures/paper-rough.png', textureScale: 0.5,
    spacing: 1,
  },
  {
    id: 'wet-brush',
    name: '水彩',
    maxSize: 30, baseSize: 3,
    pressureCurve: 'smooth',
    opacity: 0.6, wetRatio: 0.4,
    textureEnabled: true, texturePath: 'textures/paper-smooth.png', textureScale: 1.0,
    spacing: 1,
  },
];
```

### プリセット保存・読み込み

**`src/brush/preset-manager.ts`**

```typescript
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export class PresetManager {
  private presetsPath: string; // Electron userData/presets.json

  async load(): Promise<BrushPreset[]> {
    try {
      const json = await fs.readFile(this.presetsPath, 'utf-8');
      return [...DEFAULT_PRESETS, ...JSON.parse(json)];
    } catch {
      return [...DEFAULT_PRESETS];
    }
  }

  async save(presets: BrushPreset[]): Promise<void> {
    // DEFAULT_PRESETS を除いたユーザープリセットのみ保存
    const userPresets = presets.filter(p =>
      !DEFAULT_PRESETS.find(d => d.id === p.id)
    );
    await fs.writeFile(this.presetsPath, JSON.stringify(userPresets, null, 2));
  }
}
```

Electron の `app.getPath('userData')` でユーザーデータパスを取得する。  
IPC 経由（preload.cjs）でレンダラーから呼ぶか、  
または `contextBridge` で fs 操作を公開する。

### プリセット UI

```
左サイドバー:
  ┌─────────────────┐
  │ プリセット       │
  │ ● 丸ブラシ       │
  │ ○ 鉛筆           │
  │ ○ 水彩           │
  │ ─────────────── │
  │ [現在の設定を保存] │
  └─────────────────┘
```

プリセット選択時に `strokeManager.updatePressureConfig()` と  
`renderPipeline.updateBrushConfig()` を更新する。

---

## 完了条件

- [ ] テクスチャブラシで紙目を擦り出す感覚が再現できる
- [ ] テクスチャスケールが調整できる
- [ ] ブラシプリセットの切り替えができる
- [ ] 新しいプリセットを保存・読み込みできる
- [ ] デフォルトプリセット 3 種類が同梱されている
