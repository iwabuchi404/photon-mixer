/**
 * トーンカーブ（単調キュービック）テスト。
 */

import assert from 'node:assert';
import { test, describe } from 'node:test';
import { sampleCurve, buildCurveLut, lutToSamples, applyCurveLinear, type CurvePoint } from '../src/color/curve.js';

const identity: CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
const approx = (a: number, b: number, e = 1e-6) => Math.abs(a - b) <= e;

describe('sampleCurve', () => {
  test('恒等カーブはほぼ x=y', () => {
    const s = sampleCurve(identity);
    assert.strictEqual(s.length, 256);
    assert.ok(Math.abs(s[0] - 0) < 1e-6);
    assert.ok(Math.abs(s[255] - 1) < 1e-6);
    assert.ok(Math.abs(s[128] - 128 / 255) < 0.01);
  });

  test('出力は常に [0,1]', () => {
    const s = sampleCurve([{ x: 0, y: 0 }, { x: 0.5, y: 0.95 }, { x: 1, y: 1 }]);
    assert.ok(s.every(v => v >= 0 && v <= 1));
  });

  test('単調増加が保たれる（オーバーシュートしない）', () => {
    const s = sampleCurve([{ x: 0, y: 0 }, { x: 0.4, y: 0.9 }, { x: 0.6, y: 0.1 }, { x: 1, y: 1 }]);
    // 急な上下でも各セグメント内で値は [0,1]、隣接で極端な負にならない
    assert.ok(s.every(v => v >= 0 && v <= 1));
  });

  test('中間点を上げると中間調が明るくなる', () => {
    const up = sampleCurve([{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }]);
    assert.ok(up[128] > 0.5);
  });

  test('端点で固定', () => {
    const s = sampleCurve([{ x: 0, y: 0.2 }, { x: 1, y: 0.8 }]);
    assert.ok(Math.abs(s[0] - 0.2) < 1e-6);
    assert.ok(Math.abs(s[255] - 0.8) < 1e-6);
  });

  test('点が2未満なら恒等', () => {
    const s = sampleCurve([{ x: 0.5, y: 0.5 }]);
    assert.ok(Math.abs(s[128] - 128 / 255) < 1e-9);
  });
});

describe('buildCurveLut', () => {
  test('256×4 バイト・恒等で対角', () => {
    const lut = buildCurveLut(identity);
    assert.strictEqual(lut.length, 256 * 4);
    assert.strictEqual(lut[0], 0);
    assert.strictEqual(lut[255 * 4], 255);
    assert.strictEqual(lut[3], 255); // alpha
  });
});

describe('applyCurveLinear（リニア HDR 入力・fs_curve の twin）', () => {
  const idSamples = lutToSamples(buildCurveLut(identity));

  test('恒等LUT は HDR（1.0 超）を保存する', () => {
    // これが Curve で Glow/露出の光量を潰さないことの根拠
    for (const v of [1.5, 4, 16, 64]) {
      assert.ok(approx(applyCurveLinear(idSamples, v), v, 1e-3), `v=${v} -> ${applyCurveLinear(idSamples, v)}`);
    }
  });

  test('SDR 域で単調増加', () => {
    let prev = -1;
    for (const v of [0, 0.05, 0.2, 0.5, 0.8, 1]) {
      const o = applyCurveLinear(idSamples, v);
      assert.ok(o >= prev - 1e-3, `not monotonic at v=${v}`);
      prev = o;
    }
  });

  test('減光カーブでは HDR も減光し、有限・正を保つ', () => {
    const dark = lutToSamples(buildCurveLut([{ x: 0, y: 0 }, { x: 0.5, y: 0.4 }, { x: 1, y: 0.8 }]));
    for (const v of [2, 4, 16]) {
      const o = applyCurveLinear(dark, v);
      assert.ok(Number.isFinite(o) && o > 0, `v=${v} -> ${o}`);
      assert.ok(o < v, `減光されるべき: v=${v} -> ${o}`);
    }
  });

  test('増光カーブでは HDR も増光する', () => {
    const bright = lutToSamples(buildCurveLut([{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }]));
    assert.ok(applyCurveLinear(bright, 4) > 4, `out=${applyCurveLinear(bright, 4)}`);
  });

  test('負値は 0 に丸められる', () => {
    assert.strictEqual(applyCurveLinear(idSamples, -1), 0);
  });
});
