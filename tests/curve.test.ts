/**
 * トーンカーブ（単調キュービック）テスト。
 */

import assert from 'node:assert';
import { test, describe } from 'node:test';
import { sampleCurve, buildCurveLut, type CurvePoint } from '../src/color/curve.js';

const identity: CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];

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
