/**
 * Viewport（2Dビューポート）テスト
 * ズーム・パン・回転・左右反転と、スクリーン⇔キャンバス座標変換の整合を検証する。
 * 「ペンカーソルと描画位置のズレ」防止の要となる toScreen/toCanvas の往復一致を重点的にテスト。
 */

import assert from 'node:assert';
import { test, describe } from 'node:test';
import { Viewport } from '../src/viewport.js';

const EPS = 1e-9;
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

/** 既知のスクリーン座標群で toScreen(toCanvas(s)) == s を確認 */
function assertRoundTrip(vp: Viewport, label: string) {
  const pts: [number, number][] = [[640, 360], [0, 0], [100, 80], [1279, 719], [640, 40]];
  for (const [sx, sy] of pts) {
    const c = vp.toCanvas(sx, sy);
    const s = vp.toScreen(c.x, c.y);
    assert.ok(approx(s.x, sx) && approx(s.y, sy),
      `${label}: round-trip mismatch at (${sx},${sy}) -> (${s.x.toFixed(4)},${s.y.toFixed(4)})`);
  }
}

describe('Viewport', () => {
  describe('reset', () => {
    test('スケール1・キャンバス中心が画面中心・回転0・反転なし', () => {
      const vp = new Viewport();
      vp.reset(800, 600, 1280, 720);
      const t = vp.getTransform();
      assert.strictEqual(t.scale, 1);
      assert.strictEqual(t.offsetX, 640);
      assert.strictEqual(t.offsetY, 360);
      assert.strictEqual(t.rotation, 0);
      assert.strictEqual(t.flip, 1);
    });

    test('キャンバス中心が画面中心へ写像される', () => {
      const vp = new Viewport();
      vp.reset(800, 600, 1280, 720);
      const s = vp.toScreen(400, 300); // キャンバス中心
      assert.ok(approx(s.x, 640) && approx(s.y, 360));
    });
  });

  describe('toScreen / toCanvas の往復一致', () => {
    test('既定状態（scale=1）', () => {
      const vp = new Viewport();
      vp.reset(800, 600, 1280, 720);
      assertRoundTrip(vp, 'default');
    });

    test('ズーム後', () => {
      const vp = new Viewport();
      vp.reset(800, 600, 1280, 720);
      vp.zoom(2.5, 640, 360);
      assertRoundTrip(vp, 'zoom');
    });

    test('回転後', () => {
      const vp = new Viewport();
      vp.reset(800, 600, 1280, 720);
      vp.rotate(0.6);
      assertRoundTrip(vp, 'rotate');
    });

    test('左右反転後', () => {
      const vp = new Viewport();
      vp.reset(800, 600, 1280, 720);
      vp.toggleFlip();
      assertRoundTrip(vp, 'flip');
    });

    test('ズーム＋回転＋反転＋パンの複合', () => {
      const vp = new Viewport();
      vp.reset(800, 600, 1280, 720);
      vp.zoom(0.4, 300, 200);
      vp.rotate(-1.2);
      vp.toggleFlip();
      vp.pan(120, -75);
      assertRoundTrip(vp, 'combined');
    });

    test('キャンバスと画面のサイズが異なっても一致する', () => {
      const vp = new Viewport();
      vp.reset(2000, 2000, 1280, 720); // アート≠画面
      vp.zoom(1.7, 500, 500);
      vp.rotate(0.3);
      assertRoundTrip(vp, 'art!=screen');
    });
  });

  describe('zoom', () => {
    test('指定スクリーン座標の下にあるキャンバス点が固定される', () => {
      const vp = new Viewport();
      vp.reset(800, 600, 1280, 720);
      const before = vp.toCanvas(900, 500);
      vp.zoom(3, 900, 500);
      const after = vp.toScreen(before.x, before.y);
      assert.ok(approx(after.x, 900) && approx(after.y, 500), 'ズーム中心のアンカーが維持される');
    });

    test('最大スケール32でクランプされる', () => {
      const vp = new Viewport();
      vp.reset(800, 600, 1280, 720);
      for (let i = 0; i < 50; i++) vp.zoom(2, 640, 360);
      assert.ok(vp.getTransform().scale <= 32 + EPS);
      assert.ok(approx(vp.getTransform().scale, 32));
    });

    test('最小スケール0.1でクランプされる', () => {
      const vp = new Viewport();
      vp.reset(800, 600, 1280, 720);
      for (let i = 0; i < 50; i++) vp.zoom(0.5, 640, 360);
      assert.ok(vp.getTransform().scale >= 0.1 - EPS);
      assert.ok(approx(vp.getTransform().scale, 0.1));
    });
  });

  describe('pan', () => {
    test('オフセットが加算され、描画位置が平行移動する', () => {
      const vp = new Viewport();
      vp.reset(800, 600, 1280, 720);
      const s0 = vp.toScreen(400, 300);
      vp.pan(50, -30);
      const s1 = vp.toScreen(400, 300);
      assert.ok(approx(s1.x - s0.x, 50) && approx(s1.y - s0.y, -30));
    });
  });

  describe('rotate', () => {
    test('回転が累積する', () => {
      const vp = new Viewport();
      vp.reset(800, 600, 1280, 720);
      vp.rotate(0.3);
      vp.rotate(0.2);
      assert.ok(approx(vp.getTransform().rotation, 0.5));
    });

    test('-π〜πに正規化される', () => {
      const vp = new Viewport();
      vp.reset(800, 600, 1280, 720);
      vp.rotate(Math.PI);        // π
      vp.rotate(Math.PI * 0.9);  // 1.9π → 正規化
      const r = vp.getTransform().rotation;
      assert.ok(r >= -Math.PI - EPS && r <= Math.PI + EPS, `rotation=${r} は範囲内`);
    });

    test('resetRotationで0に戻る', () => {
      const vp = new Viewport();
      vp.reset(800, 600, 1280, 720);
      vp.rotate(1.0);
      vp.resetRotation();
      assert.strictEqual(vp.getTransform().rotation, 0);
    });
  });

  describe('flip', () => {
    test('toggleでgetTransform.flipが反転する', () => {
      const vp = new Viewport();
      vp.reset(800, 600, 1280, 720);
      assert.strictEqual(vp.getTransform().flip, 1);
      vp.toggleFlip();
      assert.strictEqual(vp.getTransform().flip, -1);
      vp.toggleFlip();
      assert.strictEqual(vp.getTransform().flip, 1);
    });

    test('反転時はキャンバス中心を軸にX方向が鏡像になる', () => {
      const vp = new Viewport();
      vp.reset(800, 600, 1280, 720); // 中心(400,300)→画面(640,360)
      const right = vp.toScreen(600, 300); // 中心より右
      vp.toggleFlip();
      const rightFlipped = vp.toScreen(600, 300);
      // 反転後は中心(640)を挟んで反対側へ
      assert.ok(approx(rightFlipped.x - 640, -(right.x - 640)), 'X が中心対称');
      assert.ok(approx(rightFlipped.y, right.y), 'Y は不変');
    });
  });

  describe('canvasSize', () => {
    test('setCanvasSize/getCanvasSize', () => {
      const vp = new Viewport();
      vp.setCanvasSize(1234, 567);
      assert.deepStrictEqual(vp.getCanvasSize(), { width: 1234, height: 567 });
    });
  });
});
