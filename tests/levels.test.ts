/**
 * レベル補正の計算テスト。
 */

import assert from 'node:assert';
import { test, describe } from 'node:test';
import { applyLevels, type LevelsParams } from '../src/color/levels.js';

const identity: LevelsParams = { inLow: 0, inHigh: 1, gamma: 1, outLow: 0, outHigh: 1 };
const approx = (a: number, b: number, e = 1e-6) => Math.abs(a - b) <= e;

describe('applyLevels', () => {
  test('恒等（0,1,1,0,1）は値を変えない', () => {
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      assert.ok(approx(applyLevels(v, identity), v), `v=${v}`);
    }
  });

  test('入力黒点を上げると暗部が黒へ潰れる', () => {
    const p = { ...identity, inLow: 0.25 };
    assert.strictEqual(applyLevels(0.2, p), 0);   // inLow 未満は 0
    assert.ok(approx(applyLevels(0.25, p), 0));
    assert.ok(applyLevels(0.625, p) > 0.49 && applyLevels(0.625, p) < 0.51); // 中点付近
  });

  test('入力白点を下げると明部が白へ飛ぶ', () => {
    const p = { ...identity, inHigh: 0.5 };
    assert.ok(approx(applyLevels(0.5, p), 1));
    assert.strictEqual(applyLevels(0.8, p), 1); // クランプ
  });

  test('ガンマ>1 で中間調が明るくなる', () => {
    assert.ok(applyLevels(0.5, { ...identity, gamma: 2 }) > 0.5);
  });
  test('ガンマ<1 で中間調が暗くなる', () => {
    assert.ok(applyLevels(0.5, { ...identity, gamma: 0.5 }) < 0.5);
  });

  test('出力レンジで圧縮される', () => {
    const p = { ...identity, outLow: 0.2, outHigh: 0.8 };
    assert.ok(approx(applyLevels(0, p), 0.2));
    assert.ok(approx(applyLevels(1, p), 0.8));
    assert.ok(approx(applyLevels(0.5, p), 0.5));
  });

  test('範囲外入力でも出力は [outLow,outHigh] に収まる', () => {
    const p = { inLow: 0.1, inHigh: 0.9, gamma: 1.5, outLow: 0.1, outHigh: 0.95 };
    for (const v of [-1, 0, 0.5, 1, 2]) {
      const o = applyLevels(v, p);
      assert.ok(o >= 0.1 - 1e-6 && o <= 0.95 + 1e-6, `v=${v} -> ${o}`);
    }
  });
});
