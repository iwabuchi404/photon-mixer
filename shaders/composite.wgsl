/**
 * テクスチャ合成シェーダー
 * Phase 3: ビューポート変換（ズーム・パン・回転）＋キャンバス背景・枠対応
 */

struct ViewportUniforms {
  scale: f32,
  offsetX: f32,
  offsetY: f32,
  rotation: f32,  // 回転角（ラジアン）
  canvas_width: f32,
  canvas_height: f32,
  screen_width: f32,
  screen_height: f32,
  flip: f32,        // 左右反転（1=通常, -1=反転）
  exposure: f32,    // ビュー露出 = 2^EV
  tonemap: f32,     // 0=PBR Neutral, 1=AgX, 2=Reinhard, 3=None
  display_mode: f32, // 0=表示変換, 1=リニア生(clamp), 2=クリップ警告
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> viewport: ViewportUniforms;

// 通常のベイク用頂点シェーダー（テクスチャ全体をカバー）
@vertex
fn vs_bake(@builtin(vertex_index) vid: u32) -> VertexOutput {
  var pos = array<vec2f, 4>(
    vec2f(-1.0, -1.0), vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0,  1.0)
  );
  var uv = array<vec2f, 4>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 0.0)
  );
  var out: VertexOutput;
  out.position = vec4f(pos[vid], 0.0, 1.0);
  out.uv = uv[vid];
  return out;
}

// 画面表示用頂点シェーダー（ズーム・パン・回転を適用）
@vertex
fn vs_display(@builtin(vertex_index) vid: u32) -> VertexOutput {
  var canvas_pos = array<vec2f, 4>(
    vec2f(0.0, viewport.canvas_height),
    vec2f(viewport.canvas_width, viewport.canvas_height),
    vec2f(0.0, 0.0),
    vec2f(viewport.canvas_width, 0.0)
  );

  var uv = array<vec2f, 4>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 0.0)
  );

  // 変換順序: キャンバス中心 → 左右反転 → スケール → 回転 → パン
  var c_pos = canvas_pos[vid] - vec2f(viewport.canvas_width, viewport.canvas_height) * 0.5;
  c_pos.x = c_pos.x * viewport.flip; // 中心軸で左右反転

  // スケールを適用
  let scaled = c_pos * viewport.scale;

  // 回転を適用
  let cos_r = cos(viewport.rotation);
  let sin_r = sin(viewport.rotation);
  let rotated = vec2f(
    scaled.x * cos_r - scaled.y * sin_r,
    scaled.x * sin_r + scaled.y * cos_r
  );

  // パンを適用（スクリーン座標系）
  let screen_pos = rotated + vec2f(viewport.offsetX, viewport.offsetY);

  // 画面中心を原点に
  let nx = (screen_pos.x / viewport.screen_width) * 2.0 - 1.0;
  let ny = 1.0 - (screen_pos.y / viewport.screen_height) * 2.0;

  var out: VertexOutput;
  out.position = vec4f(nx, ny, 0.0, 1.0);
  out.uv = uv[vid];
  return out;
}

// --- 表示変換 (リニア -> sRGB 近似) ---
fn linear_to_srgb(v: f32) -> f32 {
  let c = clamp(v, 0.0, 1.0);
  if (c <= 0.0031308) { return c * 12.92; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

fn linear_to_srgb3(c: vec3f) -> vec3f {
  return vec3f(linear_to_srgb(c.r), linear_to_srgb(c.g), linear_to_srgb(c.b));
}

// --- トーンマップ（入力: 露出適用済みリニア / 出力: 表示リニア [0,1]）---
// display.ts と同一式。enum: 0=PBR Neutral, 1=AgX, 2=Reinhard, 3=None

fn tonemap_pbr_neutral(color_in: vec3f) -> vec3f {
  let startCompression = 0.8 - 0.04;
  let desaturation = 0.15;
  var color = color_in;
  let x = min(color.r, min(color.g, color.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  color = color - offset;
  let peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) { return color; }
  let d = 1.0 - startCompression;
  let newPeak = 1.0 - d * d / (peak + d - startCompression);
  color = color * (newPeak / peak);
  let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3f(newPeak), g);
}

fn agx_contrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

fn tonemap_agx(color_in: vec3f) -> vec3f {
  let inset = mat3x3<f32>(
    vec3f(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3f(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3f(0.0482516061458583, 0.101439036467562, 0.811302368396859),
  );
  let outset = mat3x3<f32>(
    vec3f(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3f(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3f(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405),
  );
  let minEv = -12.47393;
  let maxEv = 4.026069;
  var color = inset * color_in;
  color = max(color, vec3f(1e-10));
  color = log2(color);
  color = (color - minEv) / (maxEv - minEv);
  color = clamp(color, vec3f(0.0), vec3f(1.0));
  color = agx_contrast(color);
  color = outset * color;
  color = pow(max(vec3f(0.0), color), vec3f(2.2));
  return clamp(color, vec3f(0.0), vec3f(1.0));
}

fn apply_tonemap(color: vec3f, mode: i32) -> vec3f {
  if (mode == 0) { return tonemap_pbr_neutral(color); }
  if (mode == 1) { return tonemap_agx(color); }
  if (mode == 2) { return color / (1.0 + color); } // Reinhard
  return clamp(color, vec3f(0.0), vec3f(1.0));      // None
}

// そのまま出力 (ベイク用)
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  return textureSample(tex, samp, in.uv);
}

// 表示変換して出力（画面表示用）: 露出 → トーンマップ → sRGB OETF
@fragment
fn fs_display(in: VertexOutput) -> @location(0) vec4f {
  let linear = textureSample(tex, samp, in.uv);
  let a = linear.a;
  if (a < 0.0001) { return vec4f(0.0); }
  let scene = linear.rgb / a; // アンプリマルチプライド（straight）リニア（HDR）
  let mode = i32(viewport.display_mode + 0.5);

  // クリップ警告: シーン値の範囲外を点検（>1=赤, <0=青）
  if (mode == 2) {
    if (max(scene.r, max(scene.g, scene.b)) > 1.0) { return vec4f(1.0, 0.0, 0.0, 1.0); }
    if (min(scene.r, min(scene.g, scene.b)) < 0.0) { return vec4f(0.0, 0.3, 1.0, 1.0); }
  }

  let exposed = scene * viewport.exposure;
  var disp: vec3f;
  if (mode == 1) {
    disp = clamp(exposed, vec3f(0.0), vec3f(1.0)); // リニア生（トーンマップ無し・clamp）
  } else {
    disp = apply_tonemap(exposed, i32(viewport.tonemap + 0.5));
  }
  let srgb = linear_to_srgb3(disp);
  return vec4f(srgb * a, a); // over blend 用にプリマルチプライドで返す
}

// キャンバスの背景（紙）と枠を描画
@fragment
fn fs_paper(in: VertexOutput) -> @location(0) vec4f {
  // 枠線の太さ (1px 相当を UV 空間に変換)
  let border_x = 1.5 / viewport.canvas_width;
  let border_y = 1.5 / viewport.canvas_height;
  
  // 枠線判定
  if (in.uv.x < border_x || in.uv.x > 1.0 - border_x || in.uv.y < border_y || in.uv.y > 1.0 - border_y) {
    return vec4f(0.3, 0.3, 0.3, 1.0); // 枠線の色 (ダークグレー)
  }
  
  return vec4f(0.18, 0.18, 0.18, 1.0); // キャンバスの色 (背景より少し明るい)
}
