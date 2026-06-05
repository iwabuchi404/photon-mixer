/**
 * 変形シェーダー（拡大縮小・回転）
 * dst キャンバス座標を逆変換行列でソーステクスチャ座標に変換し、
 * ベース（穴あき版）と合成して出力する。
 */

struct Uniforms {
  // 逆変換行列（row-major 3x3, 各行を vec4f でパック）
  // transform: dst キャンバス座標(x,y,1) → src テクスチャ座標(u,v)
  inv_m: array<vec4f, 3>,
  src_w: f32,  // src テクスチャ幅（bounds の cw）
  src_h: f32,  // src テクスチャ高さ（bounds の ch）
  dst_w: f32,  // dst テクスチャ幅（キャンバス幅）
  dst_h: f32,  // dst テクスチャ高さ（キャンバス高さ）
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var src_tex:  texture_2d<f32>;
@group(0) @binding(2) var src_samp: sampler;
@group(0) @binding(3) var base_tex: texture_2d<f32>;
@group(0) @binding(4) var base_samp: sampler;

struct VertOut { @builtin(position) pos: vec4f }

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VertOut {
  var corners = array<vec2f, 6>(
    vec2f(-1,-1), vec2f(1,-1), vec2f(-1,1),
    vec2f(-1,1),  vec2f(1,-1), vec2f(1,1),
  );
  var out: VertOut;
  out.pos = vec4f(corners[vi], 0.0, 1.0);
  return out;
}

@fragment fn fs_main(in: VertOut) -> @location(0) vec4f {
  // fragment の dst キャンバス座標（0〜dst_w, 0〜dst_h）
  let p = vec3f(in.pos.x, in.pos.y, 1.0);

  // 逆変換でソーステクスチャのピクセル座標を得る
  let u_coord = dot(u.inv_m[0].xyz, p);
  let v_coord = dot(u.inv_m[1].xyz, p);

  // src UV（0〜1）
  let uv = vec2f(u_coord / u.src_w, v_coord / u.src_h);

  // ベース（穴あき版）をサンプル
  let base_uv = vec2f(in.pos.x / u.dst_w, in.pos.y / u.dst_h);
  let base = textureSampleLevel(base_tex, base_samp, base_uv, 0.0);

  // src 範囲外ならベースのみ返す
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return base;
  }

  // src をサンプル（双線形補間）
  let src = textureSampleLevel(src_tex, src_samp, uv, 0.0);

  // src over base（プリマルチプライドα）
  return src + base * (1.0 - src.a);
}
