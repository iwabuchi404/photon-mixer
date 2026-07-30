// 4x -> 1x ダウンサンプル (Box Filter)
// 仕様: ブラシ範囲のみ 4x 処理。src はブラシ bbox の 4x テクスチャ、
// dst はキャンバス全体の isolatedTexture。dst_offset で bbox 原点へ書き込む。
struct DownsampleUniforms {
  dst_offset_x: u32,
  dst_offset_y: u32,
  _pad0: u32,
  _pad1: u32,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u: DownsampleUniforms;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let local = gid.xy;
  // src は bbox サイズ×4。bbox 1x サイズ = src サイズ / 4。
  let src_size = textureDimensions(src);
  let bbox_size = src_size / 4u;
  if (local.x >= bbox_size.x || local.y >= bbox_size.y) {
    return;
  }

  let src_pos = local * 4u;

  // 4x4 ピクセルの平均を取る
  var sum = vec4f(0.0);
  for (var dy = 0u; dy < 4u; dy++) {
    for (var dx = 0u; dx < 4u; dx++) {
      sum += textureLoad(src, src_pos + vec2u(dx, dy), 0);
    }
  }

  let dst_pos = local + vec2u(u.dst_offset_x, u.dst_offset_y);
  textureStore(dst, dst_pos, sum / 16.0);
}
