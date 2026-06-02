/**
 * レイヤー合成シェーダー（W3C 互換のブレンドモード）
 * 入力はリニア・プリマルチプライドα。dst（下の合成結果）に src（このレイヤー）を重ねる。
 */

struct BlendUniforms {
  mode: u32,       // 0=normal,1=multiply,2=screen,3=overlay,4=add
  opacity: f32,    // 0-1
  _pad0: u32,
  _pad1: u32,
}

@group(0) @binding(0) var dst_tex: texture_2d<f32>;
@group(0) @binding(1) var src_tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> params: BlendUniforms;

struct VOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VOut {
  var pos = array<vec2f, 4>(
    vec2f(-1.0, -1.0), vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0), vec2f( 1.0,  1.0)
  );
  var uv = array<vec2f, 4>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 0.0)
  );
  var o: VOut;
  o.position = vec4f(pos[vid], 0.0, 1.0);
  o.uv = uv[vid];
  return o;
}

// 分離可能なブレンド関数 B(Cb, Cs)（straight color）
fn blend_fn(mode: u32, cb: vec3f, cs: vec3f) -> vec3f {
  switch (mode) {
    case 1u: { return cb * cs; }                       // multiply
    case 2u: { return cb + cs - cb * cs; }             // screen
    case 3u: {                                         // overlay = hardlight(cs,cb)
      return select(1.0 - 2.0 * (1.0 - cs) * (1.0 - cb), 2.0 * cs * cb, cb <= vec3f(0.5));
    }
    case 4u: { return min(cs + cb, vec3f(1.0)); }      // add (linear dodge)
    default: { return cs; }                            // normal
  }
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4f {
  let s = textureSample(src_tex, samp, in.uv); // premultiplied
  let d = textureSample(dst_tex, samp, in.uv);

  let sa = s.a * params.opacity;
  if (sa <= 0.0001 && d.a <= 0.0001) {
    return vec4f(0.0);
  }

  let da = d.a;
  // straight colors
  let Cs = select(vec3f(0.0), s.rgb / s.a, s.a > 0.0001);
  let Cb = select(vec3f(0.0), d.rgb / da, da > 0.0001);

  // W3C: backdrop α に応じてブレンド結果と素の src を補間
  let B = blend_fn(params.mode, Cb, Cs);
  let mixed = (1.0 - da) * Cs + da * B;

  // プリマルチプライドで合成
  let out_rgb = sa * mixed + d.rgb * (1.0 - sa);
  let out_a = sa + da * (1.0 - sa);
  return vec4f(out_rgb, out_a);
}
