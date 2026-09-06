/**
 * リボンテッセレーションの単体テスト。
 * ゆっくり方向転換した際のスパイク・塊の回帰防止が主目的。
 */

import assert from 'node:assert';
import { test, describe } from 'node:test';
import { tessellateRibbon } from '../src/render/ribbon.js';
import type { StrokePoint } from '../src/pen/stroke.js';

const WHITE = { r: 1, g: 1, b: 1, a: 1 };

const pt = (x: number, y: number, size = 10, pressure = 0.8): StrokePoint => ({
  x, y, pressure, tiltX: 0, tiltY: 0, timestamp: 0, size,
  color: { ...WHITE },
});

/** 点→線分のクランプ距離 */
function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** 全頂点が脊柱ポリラインから 筆半径+許容 以内に収まること（スパイク検出） */
function maxOverhang(data: Float32Array, vertCount: number, poly: { x: number; y: number }[], w: number): number {
  let max = 0;
  for (let i = 0; i < vertCount; i++) {
    const x = data[i * 8], y = data[i * 8 + 1];
    let best = Infinity;
    for (let j = 0; j < poly.length - 1; j++) {
      best = Math.min(best, distToSeg(x, y, poly[j].x, poly[j].y, poly[j + 1].x, poly[j + 1].y));
    }
    if (poly.length === 1) best = Math.hypot(x - poly[0].x, y - poly[0].y);
    max = Math.max(max, best - w);
  }
  return max;
}

describe('tessellateRibbon', () => {
  test('直線は三角形リストを生成する', () => {
    const pts = [pt(0, 0), pt(50, 0), pt(100, 0)];
    const { data, vertCount } = tessellateRibbon(pts, WHITE);
    assert.ok(vertCount > 0 && vertCount % 3 === 0, `vertCount=${vertCount}`);
    assert.strictEqual(data.length, vertCount * 8);
    for (let i = 0; i < vertCount; i++) {
      assert.ok(Math.abs(data[i * 8 + 2]) <= 1, 'across は ±1 以内');
    }
  });

  test('単点は円盤になる', () => {
    const { data, vertCount } = tessellateRibbon([pt(10, 10), pt(10, 10)], WHITE);
    assert.ok(vertCount > 0 && vertCount % 3 === 0);
    // 全頂点が半径以内の円盤
    for (let i = 0; i < vertCount; i++) {
      assert.ok(Math.hypot(data[i * 8] - 10, data[i * 8 + 1] - 10) <= 10 + 1e-6);
    }
  });

  test('ゆっくり方向転換（密な点列の急旋回）でも筆幅以上に飛び出さない', () => {
    // 東へ密に進み、半径5pxのタイトなUターンをゆっくり描く
    const pts: StrokePoint[] = [];
    const poly: { x: number; y: number }[] = [];
    for (let i = 0; i <= 30; i++) { pts.push(pt(i * 0.3, 0)); poly.push({ x: i * 0.3, y: 0 }); }
    for (let k = 1; k <= 20; k++) {
      const a = -Math.PI / 2 + (Math.PI * k) / 20;
      const x = 9 + 5 * Math.cos(a), y = 5 + 5 * Math.sin(a);
      pts.push(pt(x, y)); poly.push({ x, y });
    }
    const { data, vertCount } = tessellateRibbon(pts, WHITE);
    assert.ok(vertCount > 0);
    assert.ok(maxOverhang(data, vertCount, poly, 10) <= 1.0, 'スパイク状の飛び出しがある');
  });

  test('180°切り替えしでも筆幅以上に飛び出さない', () => {
    const pts: StrokePoint[] = [];
    const poly: { x: number; y: number }[] = [];
    for (let i = 0; i <= 20; i++) { pts.push(pt(i * 5, 0)); poly.push({ x: i * 5, y: 0 }); }
    for (let i = 20; i >= 0; i--) { pts.push(pt(i * 5, 4)); poly.push({ x: i * 5, y: 4 }); }
    const { data, vertCount } = tessellateRibbon(pts, WHITE);
    assert.ok(vertCount > 0);
    assert.ok(maxOverhang(data, vertCount, poly, 10) <= 1.0, '切り替えしで飛び出しがある');
  });
});
