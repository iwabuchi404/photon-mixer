/**
 * TouchGestureManager の単体テスト（DOM モック＋合成 PointerEvent）。
 * 1本指パン / 2本指ピンチ / パームリジェクション / タッチ描画ON時の譲渡を確認。
 */
import assert from 'node:assert';
import { test, describe } from 'node:test';
import { TouchGestureManager } from '../src/pen/touch-gestures.js';

interface FiredEvent {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
}

function makeCanvas() {
  const listeners = new Map<string, (e: FiredEvent) => void>();
  const canvas = {
    addEventListener: (type: string, fn: (e: FiredEvent) => void) => {
      listeners.set(type, fn);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  const fire = (type: string, e: FiredEvent) => listeners.get(type)?.(e);
  return { canvas: canvas as unknown as HTMLCanvasElement, fire };
}

function touch(id: number, x: number, y: number): FiredEvent {
  return { pointerId: id, pointerType: 'touch', clientX: x, clientY: y };
}

describe('TouchGestureManager', () => {
  test('1本指ドラッグでパンする', () => {
    const { canvas, fire } = makeCanvas();
    const pans: Array<[number, number]> = [];
    let syncs = 0;
    new TouchGestureManager(canvas, {
      pan: (dx, dy) => pans.push([dx, dy]),
      zoom: () => assert.fail('zoom should not fire'),
      sync: () => syncs++,
    });
    fire('pointerdown', touch(1, 100, 100));
    fire('pointermove', touch(1, 120, 130));
    assert.deepStrictEqual(pans, [[20, 30]]);
    assert.strictEqual(syncs, 1);
    fire('pointerup', touch(1, 120, 130));
  });

  test('2本指ピンチアウトで拡大する', () => {
    const { canvas, fire } = makeCanvas();
    const zooms: Array<[number, number, number]> = [];
    new TouchGestureManager(canvas, {
      pan: () => {},
      zoom: (f, cx, cy) => zooms.push([f, cx, cy]),
      sync: () => {},
    });
    fire('pointerdown', touch(1, 100, 100));
    fire('pointerdown', touch(2, 200, 100)); // 距離100, 中点(150,100)
    fire('pointermove', touch(2, 220, 100)); // 距離120
    assert.strictEqual(zooms.length, 1);
    assert.ok(Math.abs(zooms[0][0] - 1.2) < 1e-9, `factor=${zooms[0][0]}`);
    assert.ok(Math.abs(zooms[0][1] - 160) < 1e-9, `cx=${zooms[0][1]}`);
  });

  test('ペン入力中はタッチを無視する（パームリジェクション）', () => {
    const { canvas, fire } = makeCanvas();
    let pans = 0;
    new TouchGestureManager(canvas, {
      pan: () => pans++,
      zoom: () => assert.fail('zoom should not fire'),
      sync: () => {},
    });
    fire('pointerdown', touch(1, 100, 100));
    fire('pointerdown', { pointerId: 99, pointerType: 'pen', clientX: 300, clientY: 300 });
    fire('pointermove', touch(1, 150, 150));
    assert.strictEqual(pans, 0);
    fire('pointerup', { pointerId: 99, pointerType: 'pen', clientX: 300, clientY: 300 });
    fire('pointerup', touch(1, 150, 150));
  });

  test('タッチ描画ONでは1本指をパンしない（描画へ譲る）', () => {
    const { canvas, fire } = makeCanvas();
    let pans = 0;
    const mgr = new TouchGestureManager(canvas, {
      pan: () => pans++,
      zoom: () => {},
      sync: () => {},
    });
    mgr.setTouchDrawEnabled(true);
    fire('pointerdown', touch(1, 100, 100));
    fire('pointermove', touch(1, 150, 150));
    assert.strictEqual(pans, 0);
    fire('pointerup', touch(1, 150, 150));
  });

  test('マウスは無視する', () => {
    const { canvas, fire } = makeCanvas();
    let pans = 0;
    new TouchGestureManager(canvas, {
      pan: () => pans++,
      zoom: () => assert.fail('zoom should not fire'),
      sync: () => {},
    });
    fire('pointerdown', { pointerId: 7, pointerType: 'mouse', clientX: 100, clientY: 100 });
    fire('pointermove', { pointerId: 7, pointerType: 'mouse', clientX: 200, clientY: 200 });
    assert.strictEqual(pans, 0);
  });

  test('ペン接触で onPenDetected が呼ばれる', () => {
    const { canvas, fire } = makeCanvas();
    let detected = 0;
    new TouchGestureManager(canvas, {
      pan: () => {},
      zoom: () => {},
      sync: () => {},
      onPenDetected: () => detected++,
    });
    fire('pointerdown', { pointerId: 9, pointerType: 'pen', clientX: 300, clientY: 300 });
    assert.strictEqual(detected, 1);
    fire('pointerup', { pointerId: 9, pointerType: 'pen', clientX: 300, clientY: 300 });
  });
});
