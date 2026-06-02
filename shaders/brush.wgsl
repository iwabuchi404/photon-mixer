/**
 * ブラシスタンプ描画シェーダー
 * Phase 4: テクスチャブラシ対応
 */

struct Uniforms {
  canvas_width: f32,
  canvas_height: f32,
  wet_ratio: f32,
  use_gpu_mix: u32,      // 1=スタンプ混色(GPU), 0=引きずり混色(CPU制御)
  brush_color: vec4<f32>,
  use_point_color: u32,  // 1=点ごとの色を使う(progressive), 0=uniform brush_color
  use_texture: u32,      // 1=テクスチャブラシ, 0=円形ブラシ
  texture_scale: f32,    // テクスチャのスケール（繰り返し回数）
  _pad0: u32,
}

// 点ごとのデータ: data=(x, y, size, pressure), color=(r, g, b, a)
struct Point {
  data: vec4<f32>,
  color: vec4<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) canvas_uv: vec2<f32>,
  @location(2) point_color: vec4<f32>,
}

struct FragmentInput {
  @location(0) uv: vec2<f32>,
  @location(1) canvas_uv: vec2<f32>,
  @location(2) point_color: vec4<f32>,
}

@group(0) @binding(0)
var<uniform> uniforms: Uniforms;

@group(0) @binding(1)
var<storage, read> points: array<Point>;

@group(0) @binding(2)
var committed_texture: texture_2d<f32>;

@group(0) @binding(3)
var committed_sampler: sampler;

@group(0) @binding(4)
var brush_texture: texture_2d<f32>;

@group(0) @binding(5)
var brush_sampler: sampler;

// --- Color Conversion (from color.wgsl) ---
fn linear_to_oklab(c: vec3f) -> vec3f {
  let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  let l_ = pow(max(0.0, l), 1.0/3.0);
  let m_ = pow(max(0.0, m), 1.0/3.0);
  let s_ = pow(max(0.0, s), 1.0/3.0);
  return vec3f(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  );
}

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
// ------------------------------------------

@vertex
fn vertex_main(@builtin(instance_index) instance_id: u32, @builtin(vertex_index) vertex_id: u32) -> VertexOutput {
  let point = points[instance_id];
  let center = point.data.xy;
  let size = point.data.z;

  let offsets = array<vec2<f32>, 4>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0)
  );

  let offset = offsets[vertex_id] * size;
  let pos = center + offset;

  let screen_x = (pos.x / uniforms.canvas_width) * 2.0 - 1.0;
  let screen_y = 1.0 - (pos.y / uniforms.canvas_height) * 2.0;

  var output: VertexOutput;
  output.position = vec4<f32>(screen_x, screen_y, 0.0, 1.0);
  output.uv = offsets[vertex_id];
  // キャンバス座標系 UV (0-1)
  output.canvas_uv = vec2<f32>(pos.x / uniforms.canvas_width, pos.y / uniforms.canvas_height);
  output.point_color = point.color;

  return output;
}

@fragment
fn fragment_main(input: FragmentInput) -> @location(0) vec4<f32> {
  // 点ごとの色（progressive）か uniform のブラシ色（stamp）かを選ぶ
  var base_color = uniforms.brush_color;
  if (uniforms.use_point_color != 0u) {
    base_color = input.point_color;
  }

  var stamp_alpha: f32;

  // テクスチャブラシか円形ブラシか
  if (uniforms.use_texture != 0u) {
    // テクスチャブラシ：キャンバス座標系でテクスチャをサンプリング
    // input.canvas_uv を texture_scale 倍して繰り返しサンプリング
    let tex_uv = input.canvas_uv * uniforms.texture_scale;
    let tex_color = textureSampleLevel(brush_texture, brush_sampler, tex_uv, 0.0);
    // 輝度をマスクに使う（黒=透明・白=不透明、グレースケール素材に対応）
    // α も併用して、α付き素材は α でも抜けるようにする
    let lum = dot(tex_color.rgb, vec3<f32>(0.299, 0.587, 0.114));
    let mask = lum * tex_color.a;
    // 円形フォールオフも掛けてスタンプの角を丸める
    let dist = length(input.uv);
    let falloff = 1.0 - smoothstep(0.8, 1.0, dist);
    stamp_alpha = mask * base_color.a * falloff;
  } else {
    // 円形ブラシ
    let dist = length(input.uv);
    if (dist >= 1.0) {
      return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }
    stamp_alpha = base_color.a * (1.0 - smoothstep(0.8, 1.0, dist));
  }

  var target_color = base_color.rgb;

  // スタンプ混色モード（GPU側処理）
  // 引きずり混色モードでは色が CPU 側で確定済みためここでは何もしない
  if (uniforms.use_gpu_mix != 0u && uniforms.wet_ratio > 0.0) {
    let existing = textureSampleLevel(committed_texture, committed_sampler, input.canvas_uv, 0.0);
    if (existing.a > 0.001) {
      let brush_oklab = linear_to_oklab(target_color);
      let canvas_oklab = linear_to_oklab(existing.rgb / existing.a);
      let mixed_oklab = mix(brush_oklab, canvas_oklab, uniforms.wet_ratio * existing.a);
      target_color = oklab_to_linear(mixed_oklab);
    }
  }

  return vec4<f32>(target_color * stamp_alpha, stamp_alpha);
}
