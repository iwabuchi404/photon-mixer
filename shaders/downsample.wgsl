// 4x -> 1x ダウンサンプル (Box Filter)
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dst_pos = gid.xy;
  let dst_size = textureDimensions(dst);
  
  if (dst_pos.x >= dst_size.x || dst_pos.y >= dst_size.y) {
    return;
  }

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
