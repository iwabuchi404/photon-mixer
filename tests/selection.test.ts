/**
 * 選択範囲マスクのジオメトリ演算テスト（Phase D）
 * 投げ縄（多角形ラスタライズ）・自動選択（シードフィル）・bounds・反転・輪郭抽出を検証する。
 */

import assert from 'node:assert';
import { test, describe } from 'node:test';
import {
  rasterizePolygon, floodFillMask, maskBounds, invertMask, buildMaskContour,
  type StraightSampler,
} from '../src/selection/mask.js';

const countSelected = (m: Uint8Array) => m.reduce((n, v) => n + (v ? 1 : 0), 0);

describe('rasterizePolygon（投げ縄）', () => {
  test('矩形多角形が内部を塗りつぶす', () => {
    const w = 10, h = 10;
    // (2,2)-(8,2)-(8,8)-(2,8) の正方形
    const m = rasterizePolygon([{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }], w, h);
    assert.strictEqual(m[5 * w + 5], 255, '内部は選択');
    assert.strictEqual(m[2 * w + 2], 255, '左上隅近傍は選択');
    assert.strictEqual(m[7 * w + 7], 255, '右下隅近傍は選択');
    assert.strictEqual(m[0], 0, '外部は未選択');
    assert.strictEqual(m[8 * w + 8], 0, '右下外は未選択');
    assert.deepStrictEqual(maskBounds(m, w, h), { lx: 2, ty: 2, rx: 8, by: 8 });
  });

  test('三角形でも even-odd で正しく塗られる', () => {
    const w = 11, h = 11;
    const m = rasterizePolygon([{ x: 5, y: 1 }, { x: 9, y: 9 }, { x: 1, y: 9 }], w, h);
    assert.strictEqual(m[8 * w + 5], 255, '底辺付近の内部は選択');
    assert.strictEqual(m[2 * w + 0], 0, '頂点脇の外部は未選択');
    assert.ok(countSelected(m) > 0);
  });

  test('頂点が3未満なら空マスク', () => {
    const m = rasterizePolygon([{ x: 1, y: 1 }, { x: 5, y: 5 }], 10, 10);
    assert.strictEqual(countSelected(m), 0);
  });

  test('キャンバス外へはみ出す多角形はクリップされる', () => {
    const w = 6, h = 6;
    const m = rasterizePolygon([{ x: -5, y: -5 }, { x: 3, y: -5 }, { x: 3, y: 3 }, { x: -5, y: 3 }], w, h);
    assert.strictEqual(m[0], 255, '範囲内は選択');
    assert.strictEqual(m[5 * w + 5], 0, '範囲外側は未選択');
    const b = maskBounds(m, w, h)!;
    assert.strictEqual(b.lx, 0);
    assert.strictEqual(b.ty, 0);
  });
});

describe('floodFillMask（自動選択）', () => {
  test('連結した同色領域だけを選択する（tolerance=0）', () => {
    const w = 5, h = 5;
    // 左2列=赤、それ以外=透明黒
    const sample: StraightSampler = (x) =>
      x < 2 ? { r: 1, g: 0, b: 0, a: 1 } : { r: 0, g: 0, b: 0, a: 0 };
    const m = floodFillMask(w, h, 0, 0, sample, 0);
    assert.strictEqual(countSelected(m), 2 * h, '左2列のみ');
    assert.strictEqual(m[0 * w + 0], 255);
    assert.strictEqual(m[0 * w + 1], 255);
    assert.strictEqual(m[0 * w + 2], 0, '色境界で止まる');
  });

  test('toleranceで近似色まで拡張する', () => {
    const w = 6, h = 1;
    // x ごとに段階的に明るくなるグラデーション
    const sample: StraightSampler = (x) => ({ r: x * 0.1, g: x * 0.1, b: x * 0.1, a: 1 });
    const ref = floodFillMask(w, h, 0, 0, sample, 0);
    assert.strictEqual(countSelected(ref), 1, 'tol=0 は始点のみ');

    const wide = floodFillMask(w, h, 0, 0, sample, 0.25);
    // |0.1x - 0| <= 0.25 → x=0,1,2 まで（x=3 は 0.3 で除外）
    assert.strictEqual(countSelected(wide), 3);
    assert.strictEqual(wide[3], 0);
  });

  test('始点がキャンバス外なら空マスク', () => {
    const sample: StraightSampler = () => ({ r: 1, g: 1, b: 1, a: 1 });
    assert.strictEqual(countSelected(floodFillMask(5, 5, -1, 0, sample, 1)), 0);
    assert.strictEqual(countSelected(floodFillMask(5, 5, 5, 0, sample, 1)), 0);
  });

  test('非連結の同色領域は選択されない', () => {
    const w = 5, h = 1;
    // x=0,1 と x=3,4 が同色（赤）、x=2 が別色で分断
    const sample: StraightSampler = (x) =>
      x === 2 ? { r: 0, g: 0, b: 0, a: 0 } : { r: 1, g: 0, b: 0, a: 1 };
    const m = floodFillMask(w, h, 0, 0, sample, 0);
    assert.strictEqual(m[0], 255);
    assert.strictEqual(m[1], 255);
    assert.strictEqual(m[3], 0, '分断された同色は対象外');
    assert.strictEqual(m[4], 0);
  });
});

describe('maskBounds', () => {
  test('空マスクは null', () => {
    assert.strictEqual(maskBounds(new Uint8Array(16), 4, 4), null);
  });

  test('選択ピクセルの外接矩形（rx/byは排他）', () => {
    const w = 5, h = 5;
    const m = new Uint8Array(w * h);
    m[1 * w + 1] = 255;
    m[3 * w + 2] = 255;
    assert.deepStrictEqual(maskBounds(m, w, h), { lx: 1, ty: 1, rx: 3, by: 4 });
  });
});

describe('invertMask', () => {
  test('null は全選択になる', () => {
    const m = invertMask(null, 3, 2);
    assert.strictEqual(countSelected(m), 6);
  });

  test('選択/未選択が反転する', () => {
    const w = 3, h = 1;
    const src = new Uint8Array([255, 0, 255]);
    const inv = invertMask(src, w, h);
    assert.deepStrictEqual(Array.from(inv), [0, 255, 0]);
  });
});

describe('buildMaskContour（輪郭線分）', () => {
  const segSet = (seg: number[]) => {
    const s = new Set<string>();
    for (let i = 0; i < seg.length; i += 4) s.add(seg.slice(i, i + 4).join(','));
    return s;
  };

  test('単一ピクセルは単位正方形の4辺になる', () => {
    const w = 3, h = 3;
    const m = new Uint8Array(w * h);
    m[1 * w + 1] = 255;
    const seg = buildMaskContour(m, w, h);
    assert.strictEqual(seg.length, 16, '4辺×4数値');
    const s = segSet(seg);
    assert.ok(s.has('1,1,1,2'), '左辺');
    assert.ok(s.has('2,1,2,2'), '右辺');
    assert.ok(s.has('1,1,2,1'), '上辺');
    assert.ok(s.has('1,2,2,2'), '下辺');
  });

  test('塗りつぶし矩形は外周のみ（内部辺なし）', () => {
    const w = 4, h = 4;
    const m = new Uint8Array(w * h).fill(0);
    // 2x2 ブロック (1,1)-(2,2) を選択
    for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]] as const) m[y * w + x] = 255;
    const seg = buildMaskContour(m, w, h);
    // 周長 = 各辺2セル×4辺 = 8線分 = 32数値（内部の隣接辺は出ない）
    assert.strictEqual(seg.length, 32);
  });

  test('空マスクは線分なし', () => {
    assert.strictEqual(buildMaskContour(new Uint8Array(16), 4, 4).length, 0);
  });
});
