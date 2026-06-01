# Block 2: カラーパイプライン ＋ 混色 PoC

## 目的

float32 リニアカラーを内部表現として確立し、Oklab 混色の感触を早期に検証する。  
単一レイヤー状態でも混色の実装は可能なため、レイヤーシステム（Block 5）より前に実施する。

## 前提条件

- Block 1-A 完了（`rgba16float` テクスチャ対応）
- Block 1-B 完了（committed texture ベイク方式が安定動作）

混色は「既存キャンバス（committedTexture）の色を読んで混ぜる」ため、  
committed texture が確実に動作していないと混色の精度が出ない。

## スコープ

| 含む | 含まない |
|---|---|
| float32 内部カラー管理モジュール | OCIO ネイティブバインディング |
| Oklab 変換ユーティリティ（CPU・GPU） | レイヤー間の混色 |
| wet mixing（単一レイヤー） | カラーマネジメント全体 |
| カラーピッカー UI | PSD インポート時の変換 |
| OCIO 近似実装（sRGB 出力のみ） | HDR モニター出力 |
| 作業表示モード切り替え | |

---

## 2-A: カラー変換モジュール

### 新規: `src/color/` ディレクトリ

```
src/color/
  linear.ts    sRGB ↔ リニア変換
  oklab.ts     Linear RGB ↔ Oklab 変換
  types.ts     Color 型定義
```

**`src/color/types.ts`**

```typescript
// 内部表現：float32 リニア（1.0 超の HDR 値も保持）
export interface LinearColor {
  r: number; // 0.0〜（HDR は 1.0 超可）
  g: number;
  b: number;
  a: number; // 0.0〜1.0
}

// Oklab
export interface OklabColor {
  L: number; // 輝度 0〜1
  a: number; // 緑↔赤 軸
  b: number; // 青↔黄 軸
  alpha: number;
}

// ユーザー向け表示用（クランプ済み）
export interface SRGBColor {
  r: number; // 0〜1
  g: number;
  b: number;
  a: number;
}
```

**`src/color/linear.ts`**

```typescript
// sRGB → リニア（読み込み時に1回）
export function srgbToLinear(v: number): number {
  return v <= 0.04045
    ? v / 12.92
    : Math.pow((v + 0.055) / 1.055, 2.4);
}

// リニア → sRGB（表示・エクスポート時）
export function linearToSrgb(v: number): number {
  const c = Math.max(0, Math.min(1, v)); // クランプ
  return c <= 0.0031308
    ? c * 12.92
    : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function linearColorToSrgb(c: LinearColor): SRGBColor {
  return {
    r: linearToSrgb(c.r),
    g: linearToSrgb(c.g),
    b: linearToSrgb(c.b),
    a: c.a,
  };
}
```

**`src/color/oklab.ts`**

```typescript
// Linear sRGB → Oklab（混色演算に使用）
export function linearToOklab(c: LinearColor): OklabColor {
  // 参考: https://bottosson.github.io/posts/oklab/
  const l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  const m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  const s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    alpha: c.a,
  };
}

export function oklabToLinear(c: OklabColor): LinearColor {
  const l_ = c.L + 0.3963377774 * c.a + 0.2158037573 * c.b;
  const m_ = c.L - 0.1055613458 * c.a - 0.0638541728 * c.b;
  const s_ = c.L - 0.0894841775 * c.a - 1.2914855480 * c.b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return {
    r:  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    a: c.alpha,
  };
}

// Oklab 空間でのリニア補間（混色の基本演算）
export function mixOklab(a: OklabColor, b: OklabColor, t: number): OklabColor {
  return {
    L: a.L + (b.L - a.L) * t,
    a: a.a + (b.a - a.a) * t,
    b: a.b + (b.b - a.b) * t,
    alpha: a.alpha + (b.alpha - a.alpha) * t,
  };
}
```

---

## 2-B: GPU 側カラー変換（WGSL）

ブラシシェーダーで混色を行うため、WGSL 側にも Oklab 変換が必要。

**新規: `shaders/color.wgsl`**（他シェーダーから include 相当に使う）

```wgsl
// sRGB → リニア
fn srgb_to_linear(v: f32) -> f32 {
  if (v <= 0.04045) { return v / 12.92; }
  return pow((v + 0.055) / 1.055, 2.4);
}

// リニア → Oklab
fn linear_to_oklab(c: vec3f) -> vec3f {
  let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  let l_ = pow(l, 1.0/3.0);
  let m_ = pow(m, 1.0/3.0);
  let s_ = pow(s, 1.0/3.0);
  return vec3f(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  );
}

// Oklab → リニア
fn oklab_to_linear(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
   -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
   -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  );
}
```

---

## 2-C: 湿式混色（Wet Mixing）

### 概念

ブラシスタンプを描く際に、既存キャンバス（committedTexture）の色を読み込んで混ぜる。  
Oklab 空間で線形補間することで、知覚的に自然な混色になる。

```
canvas_color = committedTexture から現在スタンプ位置の色を読む
mixed_color  = oklab_lerp(canvas_color, brush_color, wet_ratio)
output       = mixed_color を isolatedTexture に書く（max alpha blend）
```

`wet_ratio`:
- 0.0 = 混色なし（通常のブラシ）
- 0.5 = 等比で混ぜる
- 1.0 = キャンバスの色を完全に引き継ぐ（スメア）

### `shaders/brush.wgsl` の変更

Uniform に追加:
```wgsl
struct Uniforms {
  canvas_width: f32,
  canvas_height: f32,
  brush_color: vec4<f32>,
  wet_ratio: f32,       // 0.0〜1.0
  _pad: f32,
  _pad2: vec2<f32>,
}

// 新規バインディング
@group(0) @binding(2)
var<uniform> uniforms: Uniforms;

@group(0) @binding(3)
var committed_texture: texture_2d<f32>; // キャンバス現在色（読み取り専用）

@group(0) @binding(4)
var committed_sampler: sampler;
```

フラグメントシェーダーに混色ロジック追加:
```wgsl
@fragment
fn fragment_main(input: FragmentInput) -> @location(0) vec4f {
  let dist = length(input.uv);
  if (dist >= 1.0) { return vec4f(0.0); }

  let stamp_alpha = uniforms.brush_color.a * (1.0 - smoothstep(0.8, 1.0, dist));

  // 混色なし
  if (uniforms.wet_ratio <= 0.0) {
    return vec4f(uniforms.brush_color.rgb * stamp_alpha, stamp_alpha);
  }

  // committed から既存色を読む
  let uv_canvas = input.canvas_uv; // キャンバス座標系 UV（vertex shader から渡す）
  let existing = textureSample(committed_texture, committed_sampler, uv_canvas);

  // Oklab 空間で混色
  let brush_oklab = linear_to_oklab(uniforms.brush_color.rgb);
  let canvas_oklab = linear_to_oklab(existing.rgb / max(existing.a, 0.001)); // un-premultiply
  let mixed_oklab = mix(brush_oklab, canvas_oklab, uniforms.wet_ratio * existing.a);
  let mixed_linear = oklab_to_linear(mixed_oklab);

  return vec4f(mixed_linear * stamp_alpha, stamp_alpha);
}
```

**注意**: vertex shader に `canvas_uv`（スタンプ中心のキャンバス座標 UV）を追加する必要がある。

### `src/render/brush.ts` の変更

```typescript
interface BrushConfig {
  color: { r: number; g: number; b: number; a: number };
  wetRatio: number; // 0.0〜1.0
}

// init() で committedTexture のバインディングを追加
// renderStroke() に committedTexture を渡すパラメータ追加
renderStroke(
  pass: GPURenderPassEncoder,
  points: StrokePoint[],
  committedTexture: GPUTexture, // 混色用
): void
```

### `src/render/pipeline.ts` の変更

```typescript
render(): void {
  // Pass 1: isolated に描画する際に committed を混色用として渡す
  this.brushRenderer.renderStroke(pass, this.currentStroke, this.committedTexture);
}
```

### 検証ポイント（PoC として確認したいこと）

1. **wet_ratio の感触**: 0.1 / 0.3 / 0.5 でどれが自然か
2. **速度連動**: 速く動かすと混ざりにくい（筆圧・速度で wet_ratio を変動させるか）
3. **Oklab vs リニア**: 混色の色相ずれの有無
4. **パフォーマンス**: committed をサンプリングする追加コストの測定

---

## 2-D: カラーピッカー UI

### UI 構成

```
┌─────────────────────────────┐
│ ○ シンプル  ● アドバンス     │
├─────────────────────────────┤
│ [色相ホイール / HSV ボックス] │
│                             │
│ H: [===|===] 240°           │
│ S: [======|] 80%            │
│ V: [=======] 100%           │
├─────────────────────────────┤
│ L(EV): [==|===] -1.0        │（アドバンスモードのみ）
├─────────────────────────────┤
│ R: 0.000  G: 0.000  B: 1.0  │（float32 内部値を常時表示）
│ ████████████████ (現在色)    │
└─────────────────────────────┘
```

### 実装ファイル

**新規: `src/ui/color-picker.ts`**

```typescript
export class ColorPicker {
  private currentColor: LinearColor;

  constructor(container: HTMLElement) {}

  // カラー変更時のコールバック
  onColorChange(callback: (color: LinearColor) => void): void {}

  // 外部から色をセット（HDR 値対応）
  setColor(color: LinearColor): void {}

  getColor(): LinearColor {}
}
```

HTML は `index.html` に追加。CSS は既存スタイルに合わせてモノクロ・ダークテーマ。

### HDR 対応の注意点

シンプルモードで HDR 色（r > 1.0 等）を開いた場合:
- HSV のスライダーは 0–1 にクランプして表示
- `「この色は HDR 値を含みます（表示値は近似）」`と通知
- float32 内部値は常に正確に表示

---

## 2-E: OCIO 近似実装（sRGB 出力）

### 方針決定（要検討）

OCIO ネイティブバインディングは調査が必要なため、まず近似実装でリリースし後で置き換える。

**近似実装の内容**:
- float32 リニア → sRGB（`linearToSrgb` 関数）
- エクスポート時に canvas をこの変換で 8bit 化する
- Composite shader に `linear → sRGB` 変換を追加して表示

**将来の OCIO 本実装時**:
- 近似実装を OCIO LUT 適用に置き換えるだけ
- 内部パイプラインは変更不要（float32 リニアで統一されているため）

### `shaders/composite.wgsl` の変更

```wgsl
// 表示変換（リニア → sRGB 近似）
fn linear_to_srgb(v: f32) -> f32 {
  let c = clamp(v, 0.0, 1.0);
  if (c <= 0.0031308) { return c * 12.92; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let linear = textureSample(tex, samp, in.uv);
  // 表示時にリニア → sRGB 変換
  return vec4f(
    linear_to_srgb(linear.r),
    linear_to_srgb(linear.g),
    linear_to_srgb(linear.b),
    linear.a,
  );
}
```

### 作業表示モード

```typescript
// src/main.ts に追加
type DisplayMode = 'linear-preview' | 'display-transform';

// LinearPreview: 変換なし（白飛びチェック用）
// DisplayTransform: sRGB 変換あり（デフォルト）
```

---

## 実装順序

```
2-A（カラーモジュール）→ 2-B（WGSL カラー変換）→ 2-C（湿式混色）
→ 2-D（カラーピッカー）→ 2-E（OCIO 近似）
```

2-C が最優先（早期検証の目的）。2-D と 2-E は 2-C 後で並行可能。

---

## 完了条件

- [ ] Oklab 混色でパレット上で色が混ざる感触が確認できる
- [ ] wet_ratio パラメータの適切な値が決定している
- [ ] カラーピッカーで float32 色を設定できる
- [ ] HDR 値（r > 1.0）が内部で保持される
- [ ] PNG エクスポートで sRGB 変換が正しく適用される
