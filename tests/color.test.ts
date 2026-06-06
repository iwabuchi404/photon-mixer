/**
 * カラー変換テスト
 * sRGB⇔リニア、リニア⇔Oklab、Oklab補間（混色の基礎演算）を検証する。
 */

import assert from 'node:assert';
import { test, describe } from 'node:test';
import {
  srgbToLinear, linearToSrgb, linearColorToSrgb, srgbColorToLinear,
} from '../src/color/linear.js';
import { linearToOklab, oklabToLinear, mixOklab } from '../src/color/oklab.js';

const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

describe('sRGB ⇔ リニア', () => {
  test('境界値 0/1 は保存される', () => {
    assert.strictEqual(srgbToLinear(0), 0);
    assert.ok(approx(srgbToLinear(1), 1));
    assert.strictEqual(linearToSrgb(0), 0);
    assert.ok(approx(linearToSrgb(1), 1));
  });

  test('中間値 sRGB 0.5 ≈ リニア 0.214', () => {
    assert.ok(approx(srgbToLinear(0.5), 0.21404, 1e-4));
  });

  test('低域は線形区間（/12.92）', () => {
    assert.ok(approx(srgbToLinear(0.04), 0.04 / 12.92));
    assert.ok(approx(linearToSrgb(0.002), 0.002 * 12.92));
  });

  test('往復一致 srgb→linear→srgb', () => {
    for (const v of [0, 0.04045, 0.1, 0.25, 0.5, 0.73, 1]) {
      assert.ok(approx(linearToSrgb(srgbToLinear(v)), v), `v=${v}`);
    }
  });

  test('linearToSrgb は 0..1 にクランプする', () => {
    assert.strictEqual(linearToSrgb(-0.5), 0);
    assert.ok(approx(linearToSrgb(2.0), 1));
  });

  test('色オブジェクト変換はαを保持して往復一致', () => {
    const srgb = { r: 0.2, g: 0.5, b: 0.8, a: 0.42 };
    const lin = srgbColorToLinear(srgb);
    const back = linearColorToSrgb(lin);
    assert.ok(approx(back.r, srgb.r) && approx(back.g, srgb.g) && approx(back.b, srgb.b));
    assert.strictEqual(lin.a, 0.42, 'αはリニア変換で不変');
    assert.strictEqual(back.a, 0.42);
  });
});

describe('リニア ⇔ Oklab', () => {
  test('白(1,1,1)は L≈1, a≈0, b≈0', () => {
    const ok = linearToOklab({ r: 1, g: 1, b: 1, a: 1 });
    assert.ok(approx(ok.L, 1, 1e-4), `L=${ok.L}`);
    assert.ok(approx(ok.a, 0, 1e-4), `a=${ok.a}`);
    assert.ok(approx(ok.b, 0, 1e-4), `b=${ok.b}`);
  });

  test('黒(0,0,0)は L≈0', () => {
    const ok = linearToOklab({ r: 0, g: 0, b: 0, a: 1 });
    assert.ok(approx(ok.L, 0, 1e-6));
  });

  test('往復一致 linear→oklab→linear', () => {
    const colors = [
      { r: 0.8, g: 0.1, b: 0.1, a: 1 },
      { r: 0.1, g: 0.6, b: 0.3, a: 0.5 },
      { r: 0.05, g: 0.05, b: 0.7, a: 1 },
      { r: 0.5, g: 0.5, b: 0.5, a: 0.25 },
    ];
    for (const c of colors) {
      const back = oklabToLinear(linearToOklab(c));
      assert.ok(approx(back.r, c.r, 1e-5) && approx(back.g, c.g, 1e-5) && approx(back.b, c.b, 1e-5),
        `${JSON.stringify(c)} -> ${JSON.stringify(back)}`);
    }
  });

  test('αが両変換で保持される', () => {
    const ok = linearToOklab({ r: 0.3, g: 0.4, b: 0.5, a: 0.33 });
    assert.strictEqual(ok.alpha, 0.33);
    assert.strictEqual(oklabToLinear(ok).a, 0.33);
  });
});

describe('mixOklab（Oklab線形補間）', () => {
  const A = { L: 0.2, a: 0.1, b: -0.1, alpha: 0.4 };
  const B = { L: 0.8, a: -0.2, b: 0.3, alpha: 1.0 };

  test('t=0 は a 側、t=1 は b 側', () => {
    const at0 = mixOklab(A, B, 0);
    assert.ok(approx(at0.L, A.L) && approx(at0.a, A.a) && approx(at0.b, A.b) && approx(at0.alpha, A.alpha));
    const at1 = mixOklab(A, B, 1);
    assert.ok(approx(at1.L, B.L) && approx(at1.a, B.a) && approx(at1.b, B.b) && approx(at1.alpha, B.alpha));
  });

  test('t=0.5 は中点', () => {
    const m = mixOklab(A, B, 0.5);
    assert.ok(approx(m.L, 0.5));
    assert.ok(approx(m.a, -0.05));
    assert.ok(approx(m.b, 0.1));
    assert.ok(approx(m.alpha, 0.7));
  });
});
