/**
 * ブラシスタンプ描画シェーダー
 * Phase 1: 基本的な円形スタンプ描画
 */

struct Uniforms {
  // Canvasサイズ
  canvas_width: f32,
  canvas_height: f32,
  // ブラシ色（RGBA、リニア空間）
  brush_color: vec4<f32>,
}

struct VertexInput {
  @builtin(vertex_index) vertex_id: u32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

struct FragmentInput {
  @location(0) uv: vec2<f32>,
}

@group(0) @binding(0)
var<uniform> uniforms: Uniforms;

@group(0) @binding(1)
var<storage, read> points: array<vec4<f32>>; // x, y, size, pressure

/**
 * 頂点シェーダー
 * 各点ごとに四角形を生成
 */
@vertex
fn vertex_main(@builtin(instance_index) instance_id: u32, @builtin(vertex_index) vertex_id: u32) -> VertexOutput {
  let point = points[instance_id];
  let center = point.xy;
  let size = point.z;

  // 四角形の4頂点
  let offsets = array<vec2<f32>, 4>(
    vec2<f32>(-1.0, -1.0), // 左下
    vec2<f32>(1.0, -1.0),  // 右下
    vec2<f32>(-1.0, 1.0),  // 左上
    vec2<f32>(1.0, 1.0)    // 右上
  );

  let offset = offsets[vertex_id] * size;
  let pos = center + offset;

  // 画面座標に変換 (0-1 → -1 to 1)
  let screen_x = (pos.x / uniforms.canvas_width) * 2.0 - 1.0;
  let screen_y = 1.0 - (pos.y / uniforms.canvas_height) * 2.0; // Yは反転

  var output: VertexOutput;
  output.position = vec4<f32>(screen_x, screen_y, 0.0, 1.0);
  output.uv = offsets[vertex_id];
  return output;
}

/**
 * フラグメントシェーダー
 * 円形スタンプを描画
 */
@fragment
fn fragment_main(input: FragmentInput) -> @location(0) vec4<f32> {
  // UVを距離に変換（中心からの距離）
  let dist = length(input.uv);

  // 円形判定（1.0以上なら透明）
  if (dist >= 1.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  // 滑らかなエッジ（アンチエイリアス）
  let alpha = 1.0 - smoothstep(0.8, 1.0, dist);

  return vec4<f32>(uniforms.brush_color.rgb, uniforms.brush_color.a * alpha);
}
