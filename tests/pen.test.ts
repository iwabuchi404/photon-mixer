/**
 * ペン関連モジュールの統合テスト
 * input, stabilization, interpolation, stroke の統合動作を検証
 */

import assert from 'node:assert';
import { test, describe, mock, beforeEach, afterEach } from 'node:test';

// Canvas APIモック
class MockCanvas {
  private listeners: Map<string, Function[]> = new Map();
  private rect = { left: 0, top: 0, width: 800, height: 600 };

  addEventListener(type: string, handler: Function) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(handler);
  }

  removeEventListener(type: string, handler: Function) {
    const handlers = this.listeners.get(type);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    }
  }

  getBoundingClientRect() {
    return this.rect;
  }

  // テスト用：イベントを発火
  emitEvent(type: string, event: any) {
    const handlers = this.listeners.get(type);
    if (handlers) {
      for (const handler of handlers) {
        handler(event);
      }
    }
  }

  // テスト用：キャンバスサイズを設定
  setSize(width: number, height: number) {
    this.rect.width = width;
    this.rect.height = height;
  }
}

// PointerEventモック
class MockPointerEvent implements PointerEvent {
  readonly pointerType: string;
  readonly pressure: number;
  readonly tiltX: number;
  readonly tiltY: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerId: number;
  readonly bubbles = true;
  readonly cancelable = true;
  readonly composed = false;
  readonly ctrlKey = false;
  readonly shiftKey = false;
  readonly altKey = false;
  readonly metaKey = false;
  readonly button = 0;
  readonly buttons = 0;
  readonly movementX = 0;
  readonly movementY = 0;
  readonly width = 1;
  readonly height = 1;
  readonly isPrimary = true;

  constructor(type: string, props: Partial<MockPointerEvent> = {}) {
    Object.assign(this, {
      pointerType: 'pen',
      pressure: 0.5,
      tiltX: 0,
      tiltY: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 1,
      ...props
    });
  }

  preventDefault() {}
  stopPropagation() {}
  stopImmediatePropagation() {}

  // TimeStampはDOMHighResTimeStamp
  readonly timeStamp = performance.now();

  getModifierState(key: string): boolean {
    return false;
  }
}

// performance.now()モック（テスト用）
const originalPerformanceNow = performance.now;

describe('ペン入力統合テスト', () => {
  let mockCanvas: MockCanvas;
  let currentTime = 0;

  beforeEach(() => {
    mockCanvas = new MockCanvas();
    currentTime = 0;
    // performance.now()をモック
    (globalThis.performance as any).now = () => currentTime;
  });

  afterEach(() => {
    (globalThis.performance as any).now = originalPerformanceNow;
  });

  describe('PenInputManager', async () => {
    const { PenInputManager } = await import('../src/pen/input.js');

    test('ペン入力マネージャーを初期化できる', () => {
      const manager = new PenInputManager(mockCanvas as any);
      assert.ok(manager);
    });

    test('pointerdownイベントをハンドリングできる', (t) => {
      const manager = new PenInputManager(mockCanvas as any);

      let receivedEvent: any = null;
      manager.onPenInput((event) => {
        receivedEvent = event;
      });

      currentTime = 1000;
      const mockEvent = new MockPointerEvent('pointerdown', {
        clientX: 100,
        clientY: 200,
        pressure: 0.8,
        pointerType: 'pen'
      });

      mockCanvas.emitEvent('pointerdown', mockEvent);

      assert.strictEqual(receivedEvent?.type, 'down');
      assert.strictEqual(receivedEvent?.point.x, 100);
      assert.strictEqual(receivedEvent?.point.y, 200);
      assert.strictEqual(receivedEvent?.point.pressure, 0.8);
      assert.strictEqual(receivedEvent?.point.tiltX, 0);
      assert.strictEqual(receivedEvent?.point.tiltY, 0);
    });

    test('タッチ入力を除外できる', (t) => {
      const manager = new PenInputManager(mockCanvas as any);

      let receivedCount = 0;
      manager.onPenInput(() => {
        receivedCount++;
      });

      const touchEvent = new MockPointerEvent('pointerdown', {
        pointerType: 'touch'
      });

      mockCanvas.emitEvent('pointerdown', touchEvent);

      assert.strictEqual(receivedCount, 0, 'タッチイベントは無視されるべき');
    });

    test('マウス入力を処理できる（デフォルト筆圧0.5）', (t) => {
      const manager = new PenInputManager(mockCanvas as any);

      let receivedPoint: any = null;
      manager.onPenInput((event) => {
        receivedPoint = event.point;
      });

      const mouseEvent = new MockPointerEvent('pointermove', {
        pointerType: 'mouse',
        clientX: 300,
        clientY: 400
      });

      mockCanvas.emitEvent('pointermove', mouseEvent);

      assert.strictEqual(receivedPoint?.pressure, 0.5, 'マウスはデフォルト筆圧0.5');
      assert.strictEqual(receivedPoint?.tiltX, 0, 'マウスは傾きなし');
      assert.strictEqual(receivedPoint?.tiltY, 0);
    });

    test('ペン入力で傾きを取得できる', (t) => {
      const manager = new PenInputManager(mockCanvas as any);

      let receivedPoint: any = null;
      manager.onPenInput((event) => {
        receivedPoint = event.point;
      });

      const penEvent = new MockPointerEvent('pointermove', {
        pointerType: 'pen',
        tiltX: 30,
        tiltY: -15,
        pressure: 0.7
      });

      mockCanvas.emitEvent('pointermove', penEvent);

      assert.strictEqual(receivedPoint?.tiltX, 30);
      assert.strictEqual(receivedPoint?.tiltY, -15);
      assert.strictEqual(receivedPoint?.pressure, 0.7);
    });

    test('複数のハンドラーを登録できる', (t) => {
      const manager = new PenInputManager(mockCanvas as any);

      const results: string[] = [];
      manager.onPenInput(() => results.push('handler1'));
      manager.onPenInput(() => results.push('handler2'));
      manager.onPenInput(() => results.push('handler3'));

      mockCanvas.emitEvent('pointerdown', new MockPointerEvent('pointerdown'));

      assert.deepStrictEqual(results, ['handler1', 'handler2', 'handler3']);
    });

    test('ハンドラーをクリアできる', (t) => {
      const manager = new PenInputManager(mockCanvas as any);

      let callCount = 0;
      manager.onPenInput(() => callCount++);

      mockCanvas.emitEvent('pointerdown', new MockPointerEvent('pointerdown'));
      assert.strictEqual(callCount, 1);

      manager.clearHandlers();

      mockCanvas.emitEvent('pointerdown', new MockPointerEvent('pointerdown'));
      assert.strictEqual(callCount, 1, 'クリア後はハンドラーが呼ばれない');
    });
  });

  describe('Stabilizer', async () => {
    const { Stabilizer } = await import('../src/pen/stabilization.js');

    test('デフォルト設定で初期化できる', () => {
      const stabilizer = new Stabilizer();
      const config = stabilizer.getConfig();

      assert.strictEqual(config.threshold, 1000);
      assert.strictEqual(config.minAlpha, 0.2);
      assert.strictEqual(config.maxAlpha, 1.0);
    });

    test('カスタム設定で初期化できる', () => {
      const stabilizer = new Stabilizer({
        threshold: 500,
        minAlpha: 0.1,
        maxAlpha: 0.9
      });
      const config = stabilizer.getConfig();

      assert.strictEqual(config.threshold, 500);
      assert.strictEqual(config.minAlpha, 0.1);
      assert.strictEqual(config.maxAlpha, 0.9);
    });

    test('最初の点はそのまま返す', () => {
      const stabilizer = new Stabilizer();
      const point = { x: 100, y: 200, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 1000 };

      const result = stabilizer.stabilize(point);

      assert.strictEqual(result.x, 100);
      assert.strictEqual(result.y, 200);
    });

    test('低速移動時に強い補正を適用する', () => {
      const stabilizer = new Stabilizer({
        threshold: 1000,
        minAlpha: 0.2,
        maxAlpha: 1.0
      });

      // 最初の点
      stabilizer.stabilize({ x: 100, y: 100, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 });

      // 低速移動（100px/sec）
      const result = stabilizer.stabilize({
        x: 110,
        y: 110,
        pressure: 0.5,
        tiltX: 0,
        tiltY: 0,
        timestamp: 1000 // 1秒後
      });

      // 低速なので小さいα（0.2付近）、元の点(100,100)に近いはず
      assert.ok(result.x < 110, '低速時は補正が強く、入力点より小さくなる');
      assert.ok(result.x > 100, '最初の点よりは進む');
    });

    test('高速移動時に補正を弱める', () => {
      const stabilizer = new Stabilizer({
        threshold: 1000,
        minAlpha: 0.2,
        maxAlpha: 1.0
      });

      stabilizer.stabilize({ x: 100, y: 100, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 });

      // 高速移動（2000px/sec）
      const result = stabilizer.stabilize({
        x: 300,
        y: 300,
        pressure: 0.5,
        tiltX: 0,
        tiltY: 0,
        timestamp: 100 // 0.1秒で200px移動
      });

      // 高速なのでα=1に近く、入力点に近いはず
      assert.ok(result.x > 250, '高速時は補正が弱く、入力点に近い');
    });

    test('筆圧は補正しない', () => {
      const stabilizer = new Stabilizer();

      stabilizer.stabilize({ x: 100, y: 100, pressure: 0.3, tiltX: 0, tiltY: 0, timestamp: 0 });

      const result = stabilizer.stabilize({
        x: 110,
        y: 110,
        pressure: 0.8,
        tiltX: 0,
        tiltY: 0,
        timestamp: 100
      });

      assert.strictEqual(result.pressure, 0.8, '筆圧はそのまま');
    });

    test('バッチ処理で複数の点を補正できる', () => {
      const stabilizer = new Stabilizer();

      const points = [
        { x: 100, y: 100, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 },
        { x: 110, y: 110, pressure: 0.6, tiltX: 0, tiltY: 0, timestamp: 100 },
        { x: 120, y: 120, pressure: 0.7, tiltX: 0, tiltY: 0, timestamp: 200 }
      ];

      const results = stabilizer.stabilizeBatch(points);

      assert.strictEqual(results.length, 3);
      assert.strictEqual(results[0].x, 100, '最初の点はそのまま');
    });

    test('リセットで内部状態をクリアできる', () => {
      const stabilizer = new Stabilizer();

      stabilizer.stabilize({ x: 100, y: 100, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 });
      assert.strictEqual(stabilizer.getLastVelocity(), 0);

      stabilizer.stabilize({ x: 150, y: 150, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 100 });
      assert.ok(stabilizer.getLastVelocity() > 0);

      stabilizer.reset();
      assert.strictEqual(stabilizer.getLastVelocity(), 0, 'リセット後は速度が0');
    });

    test('設定を更新できる', () => {
      const stabilizer = new Stabilizer();

      stabilizer.updateConfig({ threshold: 500, minAlpha: 0.1 });
      const config = stabilizer.getConfig();

      assert.strictEqual(config.threshold, 500);
      assert.strictEqual(config.minAlpha, 0.1);
      assert.strictEqual(config.maxAlpha, 1.0, '更新してない項目は保持される');
    });
  });

  describe('Interpolator', async () => {
    const { Interpolator } = await import('../src/pen/interpolation.js');

    test('デフォルト設定で初期化できる', () => {
      const interpolator = new Interpolator();
      const config = interpolator.getConfig();

      assert.strictEqual(config.spacing, 4);
      assert.strictEqual(config.speedThreshold, 2000);
    });

    test('点が2点未満の場合は補間しない', () => {
      const interpolator = new Interpolator();

      const singlePoint = { x: 100, y: 100, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 };
      const result = interpolator.interpolate([singlePoint]);

      assert.strictEqual(result.length, 1);
    });

    test('2点間を補間できる', () => {
      const interpolator = new Interpolator({ spacing: 10 });

      const points = [
        { x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 },
        { x: 50, y: 50, pressure: 0.8, tiltX: 0, tiltY: 0, timestamp: 100 }
      ];

      const result = interpolator.interpolate(points);

      assert.ok(result.length > 2, '補間点が追加される');
      assert.strictEqual(result[0].x, 0, '最初の点は保持される');
      // Catmull-Romスプラインは最後の点が元の点に近い値になる
      assert.ok(Math.abs(result[result.length - 1].x - 50) < 5, '最後の点は元の点に近い');
    });

    test('高速移動時に予測補間を行う', () => {
      const interpolator = new Interpolator({
        spacing: 10,
        speedThreshold: 1000
      });

      const points = [
        { x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 },
        { x: 200, y: 200, pressure: 0.8, tiltX: 0, tiltY: 0, timestamp: 50 } // 4000px/sec
      ];

      const result = interpolator.interpolate(points);

      assert.ok(result.length >= 2);
      // 高速時は予測点が含まれる可能性がある
    });

    test('低速移動時に通常補間を行う', () => {
      const interpolator = new Interpolator({
        spacing: 10,
        speedThreshold: 1000
      });

      const points = [
        { x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 },
        { x: 50, y: 50, pressure: 0.8, tiltX: 0, tiltY: 0, timestamp: 1000 } // 70.7px/sec
      ];

      const result = interpolator.interpolate(points);

      assert.ok(result.length >= 2);
    });

    test('筆圧を線形補間する', () => {
      const interpolator = new Interpolator({ spacing: 25 });

      const points = [
        { x: 0, y: 0, pressure: 0.0, tiltX: 0, tiltY: 0, timestamp: 0 },
        { x: 100, y: 0, pressure: 1.0, tiltX: 0, tiltY: 0, timestamp: 1000 }
      ];

      const result = interpolator.interpolate(points);

      // 中間点の筆圧を確認（0.0と1.0の間にあるはず）
      const midPoint = result[Math.floor(result.length / 2)];
      assert.ok(midPoint.pressure > 0 && midPoint.pressure < 1);
    });

    test('複数区間を連続して補間できる', () => {
      const interpolator = new Interpolator({ spacing: 5 });

      const points = [
        { x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 },
        { x: 30, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 100 },
        { x: 60, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 200 },
        { x: 90, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 300 }
      ];

      const result = interpolator.interpolate(points);

      assert.ok(result.length > points.length, '補間により点数が増える');
      assert.strictEqual(result[0].x, 0);
      // Catmull-Romスプラインは最後の点が元の点に近い値になる
      assert.ok(Math.abs(result[result.length - 1].x - 90) < 5, '最後の点は元の点に近い');
    });
  });

  describe('StrokeManager', async () => {
    const { StrokeManager } = await import('../src/pen/stroke.js');

    test('デフォルト設定で初期化できる', () => {
      const manager = new StrokeManager();
      const config = manager.getPressureConfig();

      assert.strictEqual(config.baseSize, 2);
      assert.strictEqual(config.maxSize, 20);
      assert.strictEqual(config.curve, 'smooth');
    });

    test('ストロークを開始・終了できる', () => {
      const manager = new StrokeManager();

      assert.strictEqual(manager.hasActiveStroke(), false, '初期状態はアクティブではない');

      manager.beginStroke();
      // 点を追加して初めてアクティブになる
      assert.strictEqual(manager.hasActiveStroke(), false, '点がない場合はアクティブではない');

      manager.addPoint({ x: 100, y: 100, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 });
      assert.strictEqual(manager.hasActiveStroke(), true, '点追加後はアクティブ');

      manager.endStroke();
      assert.strictEqual(manager.hasActiveStroke(), false, '終了後は非アクティブ');
    });

    test('点を追加できる', () => {
      const manager = new StrokeManager();

      manager.beginStroke();
      manager.addPoint({ x: 100, y: 100, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 });
      manager.addPoint({ x: 110, y: 110, pressure: 0.7, tiltX: 0, tiltY: 0, timestamp: 100 });

      const current = manager.getCurrentStroke();
      assert.strictEqual(current.length, 2);
    });

    test('筆圧をサイズに変換する（linear）', () => {
      const manager = new StrokeManager({ curve: 'linear' });

      manager.beginStroke();
      manager.addPoint({ x: 0, y: 0, pressure: 0.0, tiltX: 0, tiltY: 0, timestamp: 0 });
      manager.addPoint({ x: 10, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 100 });
      manager.addPoint({ x: 20, y: 0, pressure: 1.0, tiltX: 0, tiltY: 0, timestamp: 200 });

      const stroke = manager.getCurrentStroke();
      assert.strictEqual(stroke[0].size, 2, 'pressure=0はbaseSize');
      assert.strictEqual(stroke[2].size, 20, 'pressure=1はmaxSize');
    });

    test('筆圧をサイズに変換する（smooth）', () => {
      const manager = new StrokeManager({ curve: 'smooth', baseSize: 0, maxSize: 100 });

      manager.beginStroke();
      manager.addPoint({ x: 0, y: 0, pressure: 0.0, tiltX: 0, tiltY: 0, timestamp: 0 });
      manager.addPoint({ x: 10, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 100 });
      manager.addPoint({ x: 20, y: 0, pressure: 1.0, tiltX: 0, tiltY: 0, timestamp: 200 });

      const stroke = manager.getCurrentStroke();
      assert.strictEqual(stroke[0].size, 0);
      assert.strictEqual(stroke[2].size, 100);

      // smoothカーブは中間値が3t^2-2t^3
      // t=0.5のとき 3*0.25-2*0.125 = 0.75-0.25 = 0.5
      // 実装では pressure * pressure * (3 - 2 * pressure)
      assert.ok(stroke[1].size > 40 && stroke[1].size < 60);
    });

    test('筆圧をサイズに変換する（ease-in）', () => {
      const manager = new StrokeManager({ curve: 'ease-in', baseSize: 0, maxSize: 100 });

      manager.beginStroke();
      manager.addPoint({ x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 });

      const stroke = manager.getCurrentStroke();
      // ease-in: t^2、t=0.5のとき0.25
      assert.ok(stroke[0].size < 30);
    });

    test('筆圧をサイズに変換する（ease-out）', () => {
      const manager = new StrokeManager({ curve: 'ease-out', baseSize: 0, maxSize: 100 });

      manager.beginStroke();
      manager.addPoint({ x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 });

      const stroke = manager.getCurrentStroke();
      // ease-out: 1-(1-t)^2、t=0.5のとき1-0.25=0.75
      assert.ok(stroke[0].size > 70);
    });

    test('ストロークを終了して点列を取得できる', () => {
      const manager = new StrokeManager();

      manager.beginStroke();
      manager.addPoint({ x: 100, y: 100, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 });
      manager.addPoint({ x: 110, y: 110, pressure: 0.7, tiltX: 0, tiltY: 0, timestamp: 100 });

      const stroke = manager.endStroke();
      assert.strictEqual(stroke.length, 2);
      assert.strictEqual(manager.hasActiveStroke(), false);
    });

    test('設定を更新できる', () => {
      const manager = new StrokeManager();

      manager.updatePressureConfig({ baseSize: 5, maxSize: 30, curve: 'linear' });
      const config = manager.getPressureConfig();

      assert.strictEqual(config.baseSize, 5);
      assert.strictEqual(config.maxSize, 30);
      assert.strictEqual(config.curve, 'linear');
    });

    test('クリアで現在のストロークを削除できる', () => {
      const manager = new StrokeManager();

      manager.beginStroke();
      manager.addPoint({ x: 100, y: 100, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 });

      assert.strictEqual(manager.hasActiveStroke(), true);

      manager.clear();
      assert.strictEqual(manager.hasActiveStroke(), false);
    });
  });

  describe('StrokeHistory', async () => {
    const { StrokeHistory } = await import('../src/pen/stroke.js');

    const strokeRecord = (x: number) => ({
      kind: 'stroke' as const,
      points: [{ x, y: x, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0, size: 10 }],
      erase: false,
    });

    test('操作レコードを追加・取得できる', () => {
      const history = new StrokeHistory();
      const rec = strokeRecord(100);

      history.addRecord(rec);

      const all = history.getAllRecords();
      assert.strictEqual(all.length, 1);
      assert.deepStrictEqual(all[0], rec);
    });

    test('複数の操作レコードを管理できる', () => {
      const history = new StrokeHistory();

      history.addRecord(strokeRecord(0));
      history.addRecord(strokeRecord(10));
      history.addRecord(strokeRecord(20));

      assert.strictEqual(history.getRecordCount(), 3);
    });

    test('Undoで直前の操作を削除して返す', () => {
      const history = new StrokeHistory();
      const rec1 = strokeRecord(0);
      const rec2 = strokeRecord(10);

      history.addRecord(rec1);
      history.addRecord(rec2);

      const undone = history.undo();
      assert.deepStrictEqual(undone, rec2);
      assert.strictEqual(history.getRecordCount(), 1);
    });

    test('Undoがないときはnullを返す', () => {
      const history = new StrokeHistory();
      assert.strictEqual(history.undo(), null);
    });

    test('RedoでUndoした操作をやり直せる', () => {
      const history = new StrokeHistory();
      const rec = strokeRecord(5);

      history.addRecord(rec);
      history.undo();
      assert.strictEqual(history.getRecordCount(), 0);

      const redone = history.redo();
      assert.deepStrictEqual(redone, rec);
      assert.strictEqual(history.getRecordCount(), 1);
    });

    test('新しい操作でRedoスタックがクリアされる', () => {
      const history = new StrokeHistory();
      history.addRecord(strokeRecord(0));
      history.undo();
      // Undo 後に新規操作 → Redo は無効化される
      history.addRecord(strokeRecord(1));
      assert.strictEqual(history.redo(), null);
    });

    test('fill レコード（スナップショット）も保持できる', () => {
      const history = new StrokeHistory();
      const snapshot = new Uint16Array([1, 2, 3, 4]);
      history.addRecord({ kind: 'fill', snapshot, bytesPerRow: 256 });

      const all = history.getAllRecords();
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0].kind, 'fill');
    });

    test('maxUndo(50)を超えると古いレコードが捨てられる', () => {
      const history = new StrokeHistory();
      for (let i = 0; i < 60; i++) history.addRecord(strokeRecord(i));
      assert.strictEqual(history.getRecordCount(), 50, '最大50件に制限される');
    });

    test('クリアですべての操作を削除できる', () => {
      const history = new StrokeHistory();
      history.addRecord(strokeRecord(0));
      history.addRecord(strokeRecord(10));

      history.clear();
      assert.strictEqual(history.getRecordCount(), 0);
    });
  });

  describe('ペンパイプライン統合テスト', async () => {
    const { PenInputManager } = await import('../src/pen/input.js');
    const { Stabilizer } = await import('../src/pen/stabilization.js');
    const { Interpolator } = await import('../src/pen/interpolation.js');
    const { StrokeManager } = await import('../src/pen/stroke.js');

    test('入力→補正→補間→ストロークのフロー', () => {
      const manager = new PenInputManager(mockCanvas as any);
      const stabilizer = new Stabilizer();
      const interpolator = new Interpolator({ spacing: 3 });
      const strokeManager = new StrokeManager();

      strokeManager.beginStroke();

      // 擬似的な入力シーケンス（点間距離を大きくして補間点を生成）
      const rawPoints = [
        { x: 100, y: 100, pressure: 0.3, tiltX: 0, tiltY: 0, timestamp: 0 },
        { x: 120, y: 110, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 50 },
        { x: 140, y: 120, pressure: 0.7, tiltX: 0, tiltY: 0, timestamp: 100 },
        { x: 160, y: 130, pressure: 0.6, tiltX: 0, tiltY: 0, timestamp: 150 },
        { x: 180, y: 140, pressure: 0.4, tiltX: 0, tiltY: 0, timestamp: 200 }
      ];

      // ステップ1: 手ブレ補正
      const stabilizedPoints = rawPoints.map(p => stabilizer.stabilize(p));

      // ステップ2: 補間
      const interpolatedPoints = interpolator.interpolate(stabilizedPoints);

      // ステップ3: ストロークに追加
      for (const point of interpolatedPoints) {
        strokeManager.addPoint(point);
      }

      const stroke = strokeManager.endStroke();

      assert.ok(stroke.length > rawPoints.length, '補間により点数が増える');
      assert.ok(stroke.every(p => typeof p.size === 'number'), 'すべての点にサイズが設定されている');
    });

    test('高速ストロークの処理', () => {
      const stabilizer = new Stabilizer({ threshold: 1000, minAlpha: 0.2, maxAlpha: 1.0 });
      const interpolator = new Interpolator({ spacing: 10, speedThreshold: 1500 });
      const strokeManager = new StrokeManager();

      strokeManager.beginStroke();

      // 高速ストローク
      const fastPoints = [
        { x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 },
        { x: 200, y: 200, pressure: 0.8, tiltX: 0, tiltY: 0, timestamp: 50 }, // 4000px/sec
        { x: 400, y: 400, pressure: 0.6, tiltX: 0, tiltY: 0, timestamp: 100 }
      ];

      const stabilized = fastPoints.map(p => stabilizer.stabilize(p));
      const interpolated = interpolator.interpolate(stabilized);

      for (const p of interpolated) {
        strokeManager.addPoint(p);
      }

      const stroke = strokeManager.endStroke();

      assert.ok(stroke.length >= 3, '高速でもストロークが生成される');
    });

    test('低速精密ストロークの処理', () => {
      const stabilizer = new Stabilizer({ threshold: 1000, minAlpha: 0.1, maxAlpha: 1.0 });
      const interpolator = new Interpolator({ spacing: 1, speedThreshold: 500 });
      const strokeManager = new StrokeManager({ baseSize: 1, maxSize: 10, curve: 'smooth' });

      strokeManager.beginStroke();

      // 低速精密ストローク（点間距離を大きくして補間点を生成）
      const slowPoints = [
        { x: 100, y: 100, pressure: 0.2, tiltX: 0, tiltY: 0, timestamp: 0 },
        { x: 110, y: 100, pressure: 0.3, tiltX: 0, tiltY: 0, timestamp: 1000 }, // 10px/sec
        { x: 120, y: 100, pressure: 0.4, tiltX: 0, tiltY: 0, timestamp: 2000 },
        { x: 130, y: 100, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 3000 }
      ];

      const stabilized = slowPoints.map(p => stabilizer.stabilize(p));
      const interpolated = interpolator.interpolate(stabilized);

      for (const p of interpolated) {
        strokeManager.addPoint(p);
      }

      const stroke = strokeManager.endStroke();

      // 低速・高精度補間で多くの点が生成される
      assert.ok(stroke.length > 4, '低速精密ストロークは高密度補間');

      // サイズの変動を確認
      const sizes = stroke.map(p => p.size);
      assert.ok(sizes[0] < sizes[sizes.length - 1], '筆圧に応じてサイズが変化');
    });
  });
});
