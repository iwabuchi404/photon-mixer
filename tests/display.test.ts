/**
 * 表示変換テスト（露出・トーンマップ・OETF）。
 * 各演算子が単調・[0,1]有界で、黒→0・露出が効くことを検証する。
 */

import assert from 'node:assert';
import { test, describe } from 'node:test';
import {
  evToExposure, tonemap, linearToDisplaySrgb, TONEMAP_IDS, DISPLAY_MODE_IDS,
  type TonemapId, type RGB,
} from '../src/color/display.js';

const inRange01 = (rgb: RGB) => rgb.every(v => v >= -1e-6 && v <= 1 + 1e-6);

describe('evToExposure', () => {
  test('EV0=×1, +1=×2, -1=×0.5', () => {
    assert.ok(Math.abs(evToExposure(0) - 1) < 1e-9);
    assert.ok(Math.abs(evToExposure(1) - 2) < 1e-9);
    assert.ok(Math.abs(evToExposure(-1) - 0.5) < 1e-9);
    assert.ok(Math.abs(evToExposure(2) - 4) < 1e-9);
  });
});

describe('enum インデックスの一貫性', () => {
  test('TONEMAP_IDS / DISPLAY_MODE_IDS の順序が固定', () => {
    assert.deepStrictEqual(TONEMAP_IDS, ['pbrNeutral', 'agx', 'reinhard', 'none']);
    assert.deepStrictEqual(DISPLAY_MODE_IDS, ['transform', 'raw', 'clip']);
  });
});

describe('トーンマップ各演算子', () => {
  for (const id of TONEMAP_IDS) {
    test(`${id}: 黒は黒`, () => {
      const out = tonemap([0, 0, 0], id);
      assert.ok(out.every(v => Math.abs(v) < 1e-3), `${id} black=${out}`);
    });

    test(`${id}: HDR入力でも [0,1] に収まる`, () => {
      for (const v of [0.5, 1, 4, 16, 64]) {
        assert.ok(inRange01(tonemap([v, v, v], id)), `${id} v=${v}`);
      }
    });

    test(`${id}: グレースケールで単調増加`, () => {
      let prev = -1;
      for (const v of [0, 0.1, 0.25, 0.5, 1, 2, 4, 8]) {
        const out = tonemap([v, v, v], id)[0];
        assert.ok(out >= prev - 1e-6, `${id} not monotonic at v=${v} (${out} < ${prev})`);
        prev = out;
      }
    });
  }

  test('none は単純クランプ', () => {
    assert.deepStrictEqual(tonemap([0.3, 1.5, -0.2], 'none'), [0.3, 1, 0]);
  });

  test('reinhard: x/(1+x)', () => {
    const out = tonemap([1, 3, 0], 'reinhard');
    assert.ok(Math.abs(out[0] - 0.5) < 1e-9);
    assert.ok(Math.abs(out[1] - 0.75) < 1e-9);
    assert.strictEqual(out[2], 0);
  });

  test('pbrNeutral: 低輝度はほぼ素通し（しきい値以下は無圧縮）', () => {
    const out = tonemap([0.3, 0.3, 0.3], 'pbrNeutral');
    // startCompression(0.76) 未満 → ほぼ入力どおり（offset 0.04 補正のみ）
    assert.ok(out.every(v => Math.abs(v - 0.3) < 0.05), `out=${out}`);
  });
});

describe('linearToDisplaySrgb', () => {
  test('露出を上げると表示値が上がる（none/中間値）', () => {
    const lo = linearToDisplaySrgb([0.2, 0.2, 0.2], evToExposure(0), 'none');
    const hi = linearToDisplaySrgb([0.2, 0.2, 0.2], evToExposure(1), 'none');
    assert.ok(hi[0] > lo[0]);
  });

  test('sRGB OETF が掛かる（リニア0.5 < 表示値）', () => {
    // none で linear 0.5 → sRGB ≈ 0.735
    const out = linearToDisplaySrgb([0.5, 0.5, 0.5], 1, 'none');
    assert.ok(out[0] > 0.7 && out[0] < 0.76, `out=${out[0]}`);
  });

  test('HDR値も表示は [0,1]', () => {
    const out = linearToDisplaySrgb([10, 5, 1], 1, 'pbrNeutral');
    assert.ok(inRange01(out));
  });
});
