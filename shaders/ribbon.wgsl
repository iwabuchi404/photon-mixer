/**
 * リボンブラシ描画シェーダー（メインブラシ用）
 *
 * スタンプ連打ではなく、中心線に沿った triangle-strip を1ドローで描く。
 * 重なりが無いため max ハック不要・over 合成で正しく濃度が乗る。
 * 輪郭は SDF（幅方向の距離）+ fwidth AA で解像度非依存。
 *
 * 頂点: 1点あたり2頂点（左右）。vertex_index から点番号と左右を復元する。
 * v1 の制限: 端は butt cap（平端）、結合は平均法線のマイター近似。
 */

struct Uniforms {
  canvas_width: f32,
  canvas_height: f32,
  _pad0: f32, // vec4 アライン調整（brush_color は byte16 から）
  _pad1: f32,
  brush_color: vec4<f32>,
  use_point_color: u32,      // 1=点ごとの色を使う(progressive/smudge), 0=uniform brush_color
  use_alpha_lock: u32,       // 1=透明部分保護
  use_selection: u32,        // 1=選択範囲マスクを適用
  use_pressure_opacity: u32, // 1=筆圧で不透明度を反映
  wet_ratio: f32,            // スタンプ混色の濡れ率
  use_gpu_mix: u32,          // 1=スタンプ混色(GPU), 0=引きずり混色(CPU制御)
  _pad2: u32,
  _pad3: u32,
}

// 頂点データ（CPUテッセレーション済み・triangle list）
// layout: pos(2) + misc(across, pressure)(2) + color(4) = 8 floats
struct RibbonVert {
  pos: vec2f,
  misc: vec2f,
  color: vec4f,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) across: f32,       // 幅方向 -1..1
  @location(1) canvas_uv: vec2<f32>,
  @location(2) point_color: vec4<f32>,
  @location(3) pressure: f32,
}

struct FragmentInput {
  @location(0) across: f32,
  @location(1) canvas_uv: vec2<f32>,
  @location(2) point_color: vec4<f32>,
  @location(3) pressure: f32,
}

@group(0) @binding(0)
var<uniform> uniforms: Uniforms;

@group(0) @binding(1)
var<storage, read> verts: array<RibbonVert>;

@group(0) @binding(2)
var committed_texture: texture_2d<f32>;

@group(0) @binding(3)
var committed_sampler: sampler;

@group(0) @binding(4)
var selection_texture: texture_2d<f32>;

@group(0) @binding(5)
var selection_sampler: sampler;

// --- Color Conversion (from color.wgsl / brush.wgsl) ---
fn linear_to_oklab(c: vec3f) -> vec3f {
  let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  let l_ = sign(l) * pow(abs(l), 1.0/3.0);
  let m_ = sign(m) * pow(abs(m), 1.0/3.0);
  let s_ = sign(s) * pow(abs(s), 1.0/3.0);
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
fn vertex_main(@builtin(vertex_index) vertex_id: u32) -> VertexOutput {
  let v = verts[vertex_id];

  // フルキャンバス 1x テクスチャへの NDC 映射
  let ndc_x = (v.pos.x / uniforms.canvas_width) * 2.0 - 1.0;
  let ndc_y = 1.0 - (v.pos.y / uniforms.canvas_height) * 2.0;

  var output: VertexOutput;
  output.position = vec4<f32>(ndc_x, ndc_y, 0.0, 1.0);
  output.across = v.misc.x;
  output.canvas_uv = vec2<f32>(v.pos.x / uniforms.canvas_width, v.pos.y / uniforms.canvas_height);
  output.point_color = v.color;
  output.pressure = v.misc.y;
  return output;
}

@fragment
fn fragment_main(input: FragmentInput) -> @location(0) vec4<f32> {
  var base_color = uniforms.brush_color;
  if (uniforms.use_point_color != 0u) {
    base_color = input.point_color;
  }

  let pressure_alpha = select(base_color.a, base_color.a * input.pressure, uniforms.use_pressure_opacity != 0u);

  // SDF カバレッジ: |across| 0=中心 1=輪郭。fwidth で 1px 未満の輪郭も潰れない。
  let d = abs(input.across);
  let w = max(fwidth(d) * 1.2, 0.004);
  let coverage = 1.0 - smoothstep(1.0 - w, 1.0, d);
  if (coverage <= 0.0005) {
    discard;
  }
  var alpha = pressure_alpha * coverage;

  var target_color = base_color.rgb;

  // スタンプ混色モード（GPU側処理。brush.wgsl と同式）
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

  // アルファロック: 既存の不透明部分にのみ描画
  if (uniforms.use_alpha_lock != 0u) {
    let existing = textureSampleLevel(committed_texture, committed_sampler, input.canvas_uv, 0.0);
    alpha = alpha * existing.a;
  }

  // 選択範囲: マスク外には描画しない
  if (uniforms.use_selection != 0u) {
    let sel = textureSampleLevel(selection_texture, selection_sampler, input.canvas_uv, 0.0);
    alpha = alpha * sel.r;
  }

  return vec4<f32>(target_color * alpha, alpha);
}
