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

// --- Oklab 変換（linear sRGB ⇄ Oklab）---
// 仕様（docs/spec.md）: Normal 混色は Oklab 空間、Overlay は Oklab L 軸で閾値判定。
// linear → Oklab。負値耐性のため sign*abs で cbrt を計算。
fn linear_to_oklab(c: vec3f) -> vec3f {
  let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  let l_ = sign(l) * pow(abs(l), 1.0 / 3.0);
  let m_ = sign(m) * pow(abs(m), 1.0 / 3.0);
  let s_ = sign(s) * pow(abs(s), 1.0 / 3.0);
  return vec3f(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  );
}

// Oklab → linear sRGB
fn oklab_to_linear(c: vec3f) -> vec3f {
  let l_ = c.r + 0.3963377774 * c.g + 0.2158037573 * c.b;
  let m_ = c.r - 0.1055613458 * c.g - 0.0638541728 * c.b;
  let s_ = c.r - 0.0894841775 * c.g - 1.2914855480 * c.b;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  );
}

// 分離可能なブレンド関数 B(Cb, Cs)（straight color）
// Normal は fs_main 側で Oklab 補間として処理するためここでは未使用。
fn blend_fn(mode: u32, cb: vec3f, cs: vec3f) -> vec3f {
  switch (mode) {
    case 1u: { return cb * cs; }                       // multiply (linear)
    case 2u: { return cb + cs - cb * cs; }             // screen (linear)
    case 3u: {                                         // overlay: リニア演算 + Oklab L 軸で閾値判定
      let Lb = linear_to_oklab(cb).x;
      if (Lb <= 0.5) {
        return 2.0 * cs * cb;
      } else {
        return 1.0 - 2.0 * (1.0 - cs) * (1.0 - cb);
      }
    }
    case 4u: { return cs + cb; }                       // add (linear dodge) — HDRに蓄積（表示時にトーンマップ）
    default: { return cs; }                            // normal (Oklab path は fs_main で処理)
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

  let out_a = sa + da * (1.0 - sa);

  var out_rgb: vec3f;
  if (params.mode == 0u) {
    // Normal: Oklab 空間で知覚均等に補間（仕様: Normal → Oklab）。
    // 補間係数 = source が最終 α に占める割合。da=0 なら t=1（Cs 単独）、sa=0 なら t=0（Cb 単独）。
    let t = select(0.0, sa / out_a, out_a > 0.0001);
    let lab_b = linear_to_oklab(Cb);
    let lab_s = linear_to_oklab(Cs);
    let lab_mix = lab_b + (lab_s - lab_b) * t;
    out_rgb = oklab_to_linear(lab_mix) * out_a;
  } else {
    // W3C: backdrop α に応じてブレンド結果と素の src を補間
    let B = blend_fn(params.mode, Cb, Cs);
    let mixed = (1.0 - da) * Cs + da * B;
    // プリマルチプライドで合成
    out_rgb = sa * mixed + d.rgb * (1.0 - sa);
  }

  return vec4f(out_rgb, out_a);
}
