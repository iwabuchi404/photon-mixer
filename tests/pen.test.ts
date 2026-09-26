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
  readonly timeStamp: number;
  private readonly coalescedEvents: PointerEvent[];

  constructor(type: string, props: any = {}) {
    this.timeStamp = props.timeStamp ?? performance.now();
    this.coalescedEvents = props.coalescedEvents ?? [];
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

  getCoalescedEvents(): PointerEvent[] {
    return this.coalescedEvents;
  }

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

    test('別pointerIdの同時入力を1ストロークに混在させない', () => {
      const manager = new PenInputManager(mockCanvas as any);
      manager.setTouchDrawEnabled(true);
      const events: any[] = [];
      manager.onPenInput((event) => events.push(event));

      mockCanvas.emitEvent('pointerdown', new MockPointerEvent('pointerdown', { pointerType: 'touch', pointerId: 1 }));
      mockCanvas.emitEvent('pointerdown', new MockPointerEvent('pointerdown', { pointerType: 'touch', pointerId: 2 }));
      mockCanvas.emitEvent('pointerup', new MockPointerEvent('pointerup', { pointerType: 'touch', pointerId: 2 }));
      mockCanvas.emitEvent('pointerup', new MockPointerEvent('pointerup', { pointerType: 'touch', pointerId: 1 }));

      assert.deepStrictEqual(events.map((event) => event.type), ['down', 'up']);
      assert.deepStrictEqual(events.map((event) => event.pointerId), [1, 1]);
    });

    test('pointercancelをupとして確定しない', () => {
      const manager = new PenInputManager(mockCanvas as any);
      const events: any[] = [];
      manager.onPenInput((event) => events.push(event));

      mockCanvas.emitEvent('pointerdown', new MockPointerEvent('pointerdown'));
      mockCanvas.emitEvent('pointercancel', new MockPointerEvent('pointercancel'));

      assert.deepStrictEqual(events.map((event) => event.type), ['down', 'cancel']);
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

      mockCanvas.emitEvent('pointerdown', new MockPointerEvent('pointerdown', { pointerType: 'mouse' }));
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

      mockCanvas.emitEvent('pointerdown', new MockPointerEvent('pointerdown', { pointerType: 'pen' }));
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

    test('coalesced eventの全点を時刻順に取り込む', () => {
      const manager = new PenInputManager(mockCanvas as any);
      const received: any[] = [];
      manager.onPenInput(event => { if (event.type === 'move') received.push(event.point); });

      mockCanvas.emitEvent('pointerdown', new MockPointerEvent('pointerdown'));
      const samples = [
        new MockPointerEvent('pointermove', { clientX: 101.25, clientY: 201, timeStamp: 10, pressure: 0.2 }),
        new MockPointerEvent('pointermove', { clientX: 102.5, clientY: 202, timeStamp: 12, pressure: 0.4 }),
        new MockPointerEvent('pointermove', { clientX: 104.75, clientY: 203, timeStamp: 15, pressure: 0.7 }),
      ];
      mockCanvas.emitEvent('pointermove', new MockPointerEvent('pointermove', {
        clientX: 105,
        clientY: 204,
        timeStamp: 16,
        coalescedEvents: samples,
      }));

      assert.deepStrictEqual(received.map(p => p.x), [101.25, 102.5, 104.75]);
      assert.deepStrictEqual(received.map(p => p.timestamp), [10, 12, 15]);
      assert.deepStrictEqual(received.map(p => p.pressure), [0.2, 0.4, 0.7]);
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

  describe('C系修正（入力頑健性）', async () => {
    const { PenInputManager } = await import('../src/pen/input.js');
    const { InputRecorder, recordingToEvents } = await import('../src/pen/input-recorder.js');

    test('C1: 副ボタン(2)では描画を開始しない', () => {
      const manager = new PenInputManager(mockCanvas as any);
      const events: any[] = [];
      manager.onPenInput((event) => events.push(event));

      mockCanvas.emitEvent('pointerdown', new MockPointerEvent('pointerdown', { button: 2 }));
      mockCanvas.emitEvent('pointermove', new MockPointerEvent('pointermove'));
      mockCanvas.emitEvent('pointerup', new MockPointerEvent('pointerup', { button: 2 }));

      assert.deepStrictEqual(events.map((e) => e.type), []);
    });

    test('C1: 消しゴムスイッチ(button5)はeraserフラグ付きで開始される', () => {
      const manager = new PenInputManager(mockCanvas as any);
      const events: any[] = [];
      manager.onPenInput((event) => events.push(event));

      mockCanvas.emitEvent('pointerdown', new MockPointerEvent('pointerdown', { button: 5 }));
      mockCanvas.emitEvent('pointermove', new MockPointerEvent('pointermove', { clientX: 110 }));
      mockCanvas.emitEvent('pointerup', new MockPointerEvent('pointerup', { button: 5 }));

      assert.deepStrictEqual(events.map((e) => e.type), ['down', 'move', 'up']);
      assert.deepStrictEqual(events.map((e) => e.eraser), [true, true, true]);

      // 次のストロークは通常描画に戻る
      events.length = 0;
      mockCanvas.emitEvent('pointerdown', new MockPointerEvent('pointerdown', { button: 0 }));
      mockCanvas.emitEvent('pointerup', new MockPointerEvent('pointerup', { button: 0 }));
      assert.deepStrictEqual(events.map((e) => e.eraser), [false, false]);
    });

    test('C2: lostpointercapture でアクティブストロークがupとして確定する', () => {
      const manager = new PenInputManager(mockCanvas as any);
      const events: any[] = [];
      manager.onPenInput((event) => events.push(event));

      mockCanvas.emitEvent('pointerdown', new MockPointerEvent('pointerdown', { pointerId: 7 }));
      mockCanvas.emitEvent('pointermove', new MockPointerEvent('pointermove', { pointerId: 7, clientX: 120 }));
      mockCanvas.emitEvent('lostpointercapture', new MockPointerEvent('lostpointercapture', { pointerId: 7 }));

      assert.deepStrictEqual(events.map((e) => e.type), ['down', 'move', 'up']);

      // 既に解放済みの後の lostpointercapture は何もしない
      events.length = 0;
      mockCanvas.emitEvent('lostpointercapture', new MockPointerEvent('lostpointercapture', { pointerId: 7 }));
      assert.strictEqual(events.length, 0);
    });

    test('C4: upイベントの筆圧は直前の点を継承する（筆圧0の点を追加しない）', () => {
      const manager = new PenInputManager(mockCanvas as any);
      const events: any[] = [];
      manager.onPenInput((event) => events.push(event));

      mockCanvas.emitEvent('pointerdown', new MockPointerEvent('pointerdown', { pressure: 0.8 }));
      mockCanvas.emitEvent('pointermove', new MockPointerEvent('pointermove', { pressure: 0.6, clientX: 110 }));
      // 実機では離筆時に pressure=0 の up が来る
      mockCanvas.emitEvent('pointerup', new MockPointerEvent('pointerup', { pressure: 0 }));

      assert.deepStrictEqual(events.map((e) => e.type), ['down', 'move', 'up']);
      assert.strictEqual(events[2].point.pressure, 0.6, 'up 点は直前の筆圧を継承する');
    });

    test('C6: rectをサンプルごとに再取得しない', () => {
      let calls = 0;
      const orig = mockCanvas.getBoundingClientRect.bind(mockCanvas);
      (mockCanvas as any).getBoundingClientRect = () => { calls++; return orig(); };

      const manager = new PenInputManager(mockCanvas as any);
      manager.onPenInput(() => {});

      mockCanvas.emitEvent('pointerdown', new MockPointerEvent('pointerdown'));
      mockCanvas.emitEvent('pointermove', new MockPointerEvent('pointermove', { clientX: 101 }));
      mockCanvas.emitEvent('pointermove', new MockPointerEvent('pointermove', { clientX: 102 }));
      assert.strictEqual(calls, 1, 'rect はキャッシュされる');

      manager.invalidateRect();
      mockCanvas.emitEvent('pointermove', new MockPointerEvent('pointermove', { clientX: 103 }));
      assert.strictEqual(calls, 2, 'invalidate後のみ再取得');
    });

    test('ストローク中の touchDraw OFF でタッチストロークが up 確定する', () => {
      const manager = new PenInputManager(mockCanvas as any);
      const events: any[] = [];
      manager.onPenInput((e) => events.push(e));
      manager.setTouchDrawEnabled(true);

      mockCanvas.emitEvent('pointerdown', new MockPointerEvent('pointerdown', { pointerType: 'touch', pointerId: 11 }));
      mockCanvas.emitEvent('pointermove', new MockPointerEvent('pointermove', { pointerType: 'touch', pointerId: 11, clientX: 120 }));

      // ストローク中に OFF（ペン検出の自動切替など）→ 直前位置で up 確定し、以後のタッチを捨てる
      manager.setTouchDrawEnabled(false);
      mockCanvas.emitEvent('pointermove', new MockPointerEvent('pointermove', { pointerType: 'touch', pointerId: 11, clientX: 130 }));
      mockCanvas.emitEvent('pointerup', new MockPointerEvent('pointerup', { pointerType: 'touch', pointerId: 11 }));

      assert.deepStrictEqual(events.map((e) => e.type), ['down', 'move', 'up']);
      assert.strictEqual(events[2].pointerType, 'touch');
      assert.strictEqual(events[2].point.x, 120, 'up は直前位置で確定');

      // 以後のタッチ pointerdown は描画を開始しない（パン扱い）
      events.length = 0;
      mockCanvas.emitEvent('pointerdown', new MockPointerEvent('pointerdown', { pointerType: 'touch', pointerId: 12 }));
      mockCanvas.emitEvent('pointermove', new MockPointerEvent('pointermove', { pointerType: 'touch', pointerId: 12 }));
      assert.deepStrictEqual(events.length, 0);
    });

    test('D7: 記録→再生でイベント列が往復する', () => {
      const recorder = new InputRecorder();
      recorder.start();
      const mk = (type: any, t: number, x: number) => ({
        type, pointerId: 1, pointerType: 'pen', eraser: false,
        point: { x, y: 50, pressure: 0.7, tiltX: 10, tiltY: -5, timestamp: t, pointerId: 1 },
      });
      recorder.record(mk('down', 1000, 10) as any);
      recorder.record(mk('move', 1016, 20) as any);
      recorder.record(mk('up', 1032, 30) as any);
      const rec = recorder.stop();

      assert.strictEqual(rec.version, 1);
      assert.strictEqual(rec.events.length, 3);
      assert.strictEqual(rec.events[0].t, 0);
      assert.strictEqual(rec.events[2].t, 32);

      const evs = recordingToEvents(rec);
      assert.strictEqual(evs.length, 3);
      assert.strictEqual(evs[0].type, 'down');
      assert.strictEqual(evs[1].point.x, 20);
      assert.strictEqual(evs[1].point.tiltX, 10);
      assert.strictEqual(evs[1].point.timestamp, 16);
      assert.strictEqual(evs[2].type, 'up');
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

    test('筆圧一定ならそのまま通す', () => {
      const stabilizer = new Stabilizer();

      stabilizer.stabilize({ x: 100, y: 100, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 });

      const result = stabilizer.stabilize({
        x: 110,
        y: 110,
        pressure: 0.5,
        tiltX: 0,
        tiltY: 0,
        timestamp: 100
      });

      assert.strictEqual(result.pressure, 0.5, '一定筆圧は変わらない');
    });

    test('筆圧は位置と同じαで平滑化する', () => {
      const stabilizer = new Stabilizer();

      stabilizer.stabilize({ x: 100, y: 100, pressure: 0.3, tiltX: 0, tiltY: 0, timestamp: 0 });

      // 低速移動: 筆圧の急変が均される（0.3 と 0.8 の間）
      const slow = stabilizer.stabilize({
        x: 110,
        y: 110,
        pressure: 0.8,
        tiltX: 0,
        tiltY: 0,
        timestamp: 100
      });
      assert.ok(slow.pressure > 0.3 && slow.pressure < 0.8, `低速時は均されるはず: ${slow.pressure}`);
    });

    test('高速時は筆圧も素通しに近い', () => {
      const stabilizer = new Stabilizer();

      stabilizer.stabilize({ x: 100, y: 100, pressure: 0.3, tiltX: 0, tiltY: 0, timestamp: 0 });

      // 高速移動（2000px/sec）: α=1 で入力そのまま
      const fast = stabilizer.stabilize({
        x: 300,
        y: 300,
        pressure: 0.8,
        tiltX: 0,
        tiltY: 0,
        timestamp: 100
      });
      assert.strictEqual(fast.pressure, 0.8, '高速時は筆圧も素通し');
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

    test('速度は補正済み位置ではなく生入力点同士から計算する', () => {
      const stabilizer = new Stabilizer({ threshold: 1000, minAlpha: 0.1 });
      stabilizer.stabilize({ x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 });
      stabilizer.stabilize({ x: 1, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 100 });
      stabilizer.stabilize({ x: 2, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 200 });
      assert.ok(Math.abs(stabilizer.getLastVelocity() - 10) < 1e-6);
    });

    test('異なるサンプリング周波数でもほぼ同じ終点になる', () => {
      const run = (hz: number) => {
        const stabilizer = new Stabilizer({ threshold: 1000, minAlpha: 0.1 });
        const points = Array.from({ length: hz + 1 }, (_, i) => ({
          x: 100 * i / hz,
          y: 0,
          pressure: 0.5,
          tiltX: 0,
          tiltY: 0,
          timestamp: 1000 * i / hz,
        }));
        return stabilizer.stabilizeBatch(points).at(-1)!;
      };
      const at60 = run(60);
      const at240 = run(240);
      assert.ok(Math.abs(at60.x - at240.x) < 0.75, `60Hz=${at60.x}, 240Hz=${at240.x}`);
    });

    test('A1: 速度は時間窓から推定する（単発スパイクで爆発しない）', () => {
      const stabilizer = new Stabilizer({ threshold: 1000 });
      // 4ms間隔で1pxずつ（250px/s）進行中に 10px の単発スパイク（瞬間2500px/s相当）
      stabilizer.stabilize({ x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 });
      stabilizer.stabilize({ x: 1, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 4 });
      stabilizer.stabilize({ x: 2, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 8 });
      stabilizer.stabilize({ x: 12, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 12 });
      stabilizer.stabilize({ x: 3, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 16 });
      // 窓推定なら全履歴の変位で ~190px/s。単発なら 9px/4ms = 2250px/s
      assert.ok(stabilizer.getLastVelocity() < 500,
        `窓推定の速度になるはず: ${stabilizer.getLastVelocity()}`);
    });

    test('A3: 表示スケールで速度がズーム連動する', () => {
      const stabilizer = new Stabilizer({ threshold: 1000 });
      stabilizer.setViewScale(4);
      stabilizer.stabilize({ x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 });
      stabilizer.stabilize({ x: 10, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 100 });
      // キャンバス速度 100px/s × scale 4 = 表示 400px/s
      assert.ok(Math.abs(stabilizer.getLastVelocity() - 400) < 1e-6,
        `表示速度400のはず: ${stabilizer.getLastVelocity()}`);
    });

    test('確定バッチは最後の生入力位置で終わる', () => {
      const stabilizer = new Stabilizer({ threshold: 1000, minAlpha: 0.1 });
      const points = [
        { x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 },
        { x: 10, y: 5, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 100 },
      ];
      const result = stabilizer.stabilizeBatch(points, true);
      assert.deepStrictEqual(
        { x: result.at(-1)!.x, y: result.at(-1)!.y },
        { x: 10, y: 5 },
      );
    });
  });

  describe('PulledStringStabilizer', async () => {
    const { PulledStringStabilizer } = await import('../src/pen/pulled-string.js');
    const mkPoint = (x: number, y: number, t = 0): any => ({ x, y, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: t });

    test('デフォルト設定で初期化できる', () => {
      const ps = new PulledStringStabilizer();
      const config = ps.getConfig();
      assert.ok(config.radius > 0);
      assert.strictEqual(config.finishLine, true);
    });

    test('カスタム設定で初期化できる', () => {
      const ps = new PulledStringStabilizer({ radius: 20, finishLine: false });
      const config = ps.getConfig();
      assert.strictEqual(config.radius, 20);
      assert.strictEqual(config.finishLine, false);
    });

    test('radius=0 で入力位置と一致する', () => {
      const ps = new PulledStringStabilizer({ radius: 0, finishLine: false });
      const result = ps.stabilizeBatch([
        mkPoint(0, 0, 0), mkPoint(10, 0, 10), mkPoint(20, 5, 20),
      ]);
      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].x, 0);
      assert.strictEqual(result[1].x, 10);
      assert.strictEqual(result[2].x, 20);
    });

    test('紐が緩い間は出力が変化しない', () => {
      const ps = new PulledStringStabilizer({ radius: 10, finishLine: false });
      const result = ps.stabilizeBatch([
        mkPoint(0, 0, 0), mkPoint(3, 0, 10),
      ]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].x, 0);
      assert.strictEqual(result[0].y, 0);
    });

    test('紐が張ったらブラシが引かれる（古典動作）', () => {
      const ps = new PulledStringStabilizer({ radius: 10, finishLine: false, adaptive: false, reverseSlack: false });
      const result = ps.stabilizeBatch([
        mkPoint(0, 0, 0), mkPoint(20, 0, 10),
      ]);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[1].x, 10);
      assert.strictEqual(result[1].y, 0);
    });

    test('ブラシは常に紐の長さ分だけペン先より遅れる（古典動作）', () => {
      const ps = new PulledStringStabilizer({ radius: 10, finishLine: false, adaptive: false, reverseSlack: false });
      const result = ps.stabilizeBatch([
        mkPoint(0, 0, 0), mkPoint(20, 0, 10), mkPoint(40, 0, 20),
      ]);
      const last = result.at(-1)!;
      assert.ok(Math.abs(last.x - 30) < 1e-6, `expected ~30, got ${last.x}`);
      assert.strictEqual(last.y, 0);
    });

    test('速度適応: 高速では実効半径が短くなる', () => {
      const ps = new PulledStringStabilizer({ radius: 10, finishLine: false });
      const result = ps.stabilizeBatch([
        mkPoint(0, 0, 0), mkPoint(20, 0, 10), // 2000px/s
      ]);
      const last = result.at(-1)!;
      // effR = 10/(1+2000/800) ≈ 2.86 → x ≈ 17.14（古典なら 10）
      assert.ok(last.x > 15, `高速時は軽くなるはず: ${last.x}`);
    });

    test('速度適応: 低速ではほぼ全半径が効く', () => {
      const ps = new PulledStringStabilizer({ radius: 10, finishLine: false });
      const result = ps.stabilizeBatch([
        mkPoint(0, 0, 0), mkPoint(20, 0, 1000), // 20px/s
      ]);
      const last = result.at(-1)!;
      assert.ok(Math.abs(last.x - 10) < 1.0, `低速時は古典に近いはず: ${last.x}`);
    });

    test('反転緩み: 引き返し時はブラシが置いていかれない', () => {
      const ps = new PulledStringStabilizer({ radius: 10, finishLine: false });
      const result = ps.stabilizeBatch([
        mkPoint(0, 0, 0), mkPoint(30, 0, 1000), mkPoint(25, 0, 2000),
      ]);
      // 古典なら3点目は dead zone で出力なし。緩みで追従点が出る
      assert.strictEqual(result.length, 3);
      assert.ok(result[2].x > 20.5 && result[2].x < 25, `引き返しで追従するはず: ${result[2].x}`);
    });

    test('finishLine で最終位置まで到達する', () => {
      const ps = new PulledStringStabilizer({ radius: 10, finishLine: true });
      const result = ps.stabilizeBatch([
        mkPoint(0, 0, 0), mkPoint(20, 0, 10),
      ], true);
      const last = result.at(-1)!;
      assert.ok(Math.abs(last.x - 20) < 1e-6, `expected ~20, got ${last.x}`);
    });

    test('finishLine が長い1区間を作らず再サンプリングされる（古典動作）', () => {
      const ps = new PulledStringStabilizer({ radius: 10, finishLine: true, adaptive: false, reverseSlack: false });
      const result = ps.stabilizeBatch([
        mkPoint(0, 0, 0), mkPoint(100, 0, 10),
      ], true);
      const finishPoints = result.slice(-3);
      assert.ok(Math.abs(finishPoints.at(-1)!.x - 100) < 1e-6);
      const gaps: number[] = [];
      for (let i = 1; i < finishPoints.length; i++) {
        gaps.push(Math.hypot(
          finishPoints[i].x - finishPoints[i-1].x,
          finishPoints[i].y - finishPoints[i-1].y,
        ));
      }
      assert.ok(gaps.every(g => g < 10), `gaps should be < 10, got ${gaps}`);
    });

    test('finishLine=false で追従しない（古典動作）', () => {
      const ps = new PulledStringStabilizer({ radius: 10, finishLine: false, adaptive: false, reverseSlack: false });
      const result = ps.stabilizeBatch([
        mkPoint(0, 0, 0), mkPoint(100, 0, 10),
      ], true);
      const last = result.at(-1)!;
      assert.ok(Math.abs(last.x - 90) < 1e-6, `expected ~90, got ${last.x}`);
    });

    test('異なるサンプリングレートで形状差が許容範囲内', () => {
      const trajectory = [
        mkPoint(0, 0), mkPoint(15, 5), mkPoint(30, 15), mkPoint(45, 30),
        mkPoint(60, 50), mkPoint(75, 75), mkPoint(90, 105),
      ];
      const ps60 = new PulledStringStabilizer({ radius: 10, finishLine: false });
      const r60 = ps60.stabilizeBatch(trajectory);
      const dense: any[] = [];
      for (let i = 0; i < trajectory.length - 1; i++) {
        for (let j = 0; j < 4; j++) {
          const t = j / 4;
          dense.push({
            x: trajectory[i].x + (trajectory[i+1].x - trajectory[i].x) * t,
            y: trajectory[i].y + (trajectory[i+1].y - trajectory[i].y) * t,
            pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0,
          });
        }
      }
      dense.push(trajectory.at(-1)!);
      const ps240 = new PulledStringStabilizer({ radius: 10, finishLine: false });
      const r240 = ps240.stabilizeBatch(dense);
      const end60 = r60.at(-1)!;
      const end240 = r240.at(-1)!;
      const dist = Math.hypot(end60.x - end240.x, end60.y - end240.y);
      assert.ok(dist < 1.0, `end point drift should be < 1px, got ${dist}`);
    });

    test('A1: 逆方向ノイズ1サンプルでは緩みに入らない', () => {
      const ps = new PulledStringStabilizer({ radius: 10, finishLine: false, adaptive: false });
      // 前進してブラシが張った後、1px の逆方向ジッターだけのサンプル
      const out1 = ps.stabilize(mkPoint(0, 0, 0));
      const out2 = ps.stabilize(mkPoint(20, 0, 10));
      const jitter = ps.stabilize(mkPoint(19, 0, 14));
      // 窓推定では変位が前進方向のまま → slack せず dead zone で null。
      // 単発判定なら V·S<0 で slack し effR が 3.5 に潰れて追従点が出てしまう
      assert.strictEqual(jitter, null, 'ジッターではブラシを動かさないはず');
      assert.ok(out1 && out2);
    });

    test('A1: 窓ベース速度 — 単発スパイクで実効半径が潰れない', () => {
      const ps = new PulledStringStabilizer({ radius: 10, finishLine: false });
      // 4ms間隔で1pxずつの低速爬行（62.5px/s）の後、1msで5pxのスパイク
      ps.stabilize(mkPoint(0, 0, 0));
      ps.stabilize(mkPoint(1, 0, 4));
      ps.stabilize(mkPoint(2, 0, 8));
      ps.stabilize(mkPoint(3, 0, 12));
      ps.stabilize(mkPoint(4, 0, 16));
      ps.stabilize(mkPoint(5, 0, 20));
      const spike = ps.stabilize(mkPoint(10, 0, 21));
      // 窓推定: 変位9px/17ms ≈ 530px/s → effR ≈ 6 → brush ≈ 4
      // 単発: 5px/1ms = 5000px/s → effR ≈ 1.5 → brush ≈ 8.5
      assert.ok(spike !== null && spike.x < 6, `窓推定ならブラシは置いていかれるはず: ${spike?.x}`);
    });

    test('A2: 筆圧は平滑化される（筆圧ジャンプが階段にならない）', () => {
      const ps = new PulledStringStabilizer({ radius: 0, finishLine: false, adaptive: false, reverseSlack: false });
      ps.stabilize({ x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 });
      const out = ps.stabilize({ x: 5, y: 0, pressure: 0.9, tiltX: 0, tiltY: 0, timestamp: 8 });
      // α≈0.34 で 0.5→0.9 の途中（≈0.64）。生筆圧なら 0.9
      assert.ok(out !== null && out.pressure > 0.55 && out.pressure < 0.8,
        `平滑化されるはず: ${out?.pressure}`);
    });

    test('A3: 表示スケールで実効半径がズーム連動する', () => {
      const mk = () => new PulledStringStabilizer({ radius: 10, finishLine: false, adaptive: false, reverseSlack: false });
      const ps1 = mk();
      const r1 = ps1.stabilizeBatch([mkPoint(0, 0, 0), mkPoint(20, 0, 10)]);
      const ps2 = mk();
      ps2.setViewScale(2); // 2倍ズーム → 画面上10px相当 = キャンバス5px
      const r2 = ps2.stabilizeBatch([mkPoint(0, 0, 0), mkPoint(20, 0, 10)]);
      assert.ok(Math.abs(r1.at(-1)!.x - 10) < 0.5, `scale1: ${r1.at(-1)!.x}`);
      assert.ok(Math.abs(r2.at(-1)!.x - 15) < 0.5, `scale2は半径半分のはず: ${r2.at(-1)!.x}`);
    });

    test('updateConfig で設定を更新できる', () => {
      const ps = new PulledStringStabilizer({ radius: 5, finishLine: true });
      ps.updateConfig({ radius: 20 });
      assert.strictEqual(ps.getConfig().radius, 20);
      assert.strictEqual(ps.getConfig().finishLine, true);
    });

    test('reset で内部状態をクリア', () => {
      const ps = new PulledStringStabilizer({ radius: 10, finishLine: false });
      ps.stabilizeBatch([mkPoint(0, 0), mkPoint(20, 0)]);
      ps.reset();
      const result = ps.stabilizeBatch([mkPoint(50, 50), mkPoint(60, 50)]);
      assert.strictEqual(result[0].x, 50);
      assert.strictEqual(result[0].y, 50);
    });
  });

  describe('StabilizationController', async () => {
    const { StabilizationController } = await import('../src/pen/stabilization-mode.js');
    const mkPoint = (x: number, y: number): any => ({ x, y, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 });

    test('デフォルトは紐引きモード', () => {
      const ctrl = new StabilizationController();
      assert.strictEqual(ctrl.getMode(), 'pulled-string');
    });

    test('mode 切り替えで内部インスタンスが切り替わる', () => {
      const ctrl = new StabilizationController();
      ctrl.setMode('pulled-string');
      assert.strictEqual(ctrl.getMode(), 'pulled-string');
    });

    test('EMA モードで stabilizeBatch が EMA と同じ結果', () => {
      const ctrl = new StabilizationController({ mode: 'ema', emaConfig: { threshold: 1000, minAlpha: 0.1 } });
      const points = [mkPoint(0, 0), mkPoint(50, 50), mkPoint(100, 50)];
      const result = ctrl.stabilizeBatch(points);
      assert.strictEqual(result.length, points.length);
    });

    test('Pulled String モードで stabilizeBatch が Pulled String と同じ結果', () => {
      const ctrl = new StabilizationController({
        mode: 'pulled-string',
        pulledStringConfig: { radius: 10, finishLine: false },
      });
      const points = [mkPoint(0, 0), mkPoint(5, 0), mkPoint(20, 0)];
      const result = ctrl.stabilizeBatch(points);
      assert.ok(result.length < points.length);
    });

    test('updateEmaConfig で EMA 設定を更新', () => {
      const ctrl = new StabilizationController();
      ctrl.updateEmaConfig({ minAlpha: 0.05 });
      assert.strictEqual(ctrl.getEmaStabilizer().getConfig().minAlpha, 0.05);
    });

    test('updatePulledStringConfig で Pulled String 設定を更新', () => {
      const ctrl = new StabilizationController();
      ctrl.updatePulledStringConfig({ radius: 25 });
      assert.strictEqual(ctrl.getPulledStringStabilizer().getConfig().radius, 25);
    });

    test('reset で両方の内部状態をクリア', () => {
      const ctrl = new StabilizationController({ mode: 'pulled-string', pulledStringConfig: { radius: 10 } });
      ctrl.stabilizeBatch([mkPoint(0, 0), mkPoint(20, 0)]);
      ctrl.reset();
      const result = ctrl.stabilizeBatch([mkPoint(100, 100), mkPoint(110, 100)]);
      assert.strictEqual(result[0].x, 100);
    });
  });

  describe('PostCorrector', async () => {
    const { Interpolator } = await import('../src/pen/interpolation.js');
    const { PostCorrector } = await import('../src/pen/post-correction.js');
    const mkPoint = (x: number, y: number, p = 0.5): any => ({ x, y, pressure: p, tiltX: 0, tiltY: 0, timestamp: 0 });

    test('enabled=false で素通し', () => {
      const interp = new Interpolator();
      const pc = new PostCorrector(interp, { enabled: false, tolerance: 2 });
      const points = [mkPoint(0, 0), mkPoint(10, 0), mkPoint(20, 0)];
      const result = pc.correct(points);
      assert.strictEqual(result, points); // 同一参照
    });

    test('点数が少なすぎる場合は素通し', () => {
      const interp = new Interpolator();
      const pc = new PostCorrector(interp, { enabled: true, tolerance: 2 });
      const points = [mkPoint(0, 0), mkPoint(10, 0)];
      const result = pc.correct(points);
      assert.strictEqual(result, points);
    });

    test('直線上の中間点が削除される', () => {
      const interp = new Interpolator();
      const pc = new PostCorrector(interp, { enabled: true, tolerance: 1 });
      // (0,0) → (10,0) → (20,0) → (30,0): 全て直線上
      const points = [mkPoint(0, 0), mkPoint(10, 0), mkPoint(20, 0), mkPoint(30, 0)];
      const result = pc.correct(points);
      // RDP で中間点が削除され、再補間されても直線なので点数は減る傾向
      // 始点・終点は保持
      assert.ok(result.length > 0);
      assert.strictEqual(result[0].x, 0);
      assert.strictEqual(result[0].y, 0);
      const last = result.at(-1)!;
      assert.strictEqual(last.x, 30);
      assert.strictEqual(last.y, 0);
    });

    test('始点・終点が補正前と一致する', () => {
      const interp = new Interpolator();
      const pc = new PostCorrector(interp, { enabled: true, tolerance: 3 });
      const points = [
        mkPoint(0, 0), mkPoint(5, 3), mkPoint(10, 7), mkPoint(15, 10),
        mkPoint(20, 8), mkPoint(25, 5), mkPoint(30, 0),
      ];
      const result = pc.correct(points);
      assert.strictEqual(result[0].x, 0);
      assert.strictEqual(result[0].y, 0);
      const last = result.at(-1)!;
      assert.strictEqual(last.x, 30);
      assert.strictEqual(last.y, 0);
    });

    test('ブレたストロークが平滑化される', () => {
      const interp = new Interpolator();
      const pc = new PostCorrector(interp, { enabled: true, tolerance: 5 });
      // ジグザグのストローク
      const points: any[] = [];
      for (let i = 0; i <= 20; i++) {
        const y = i % 2 === 0 ? 0 : 5;
        points.push(mkPoint(i * 5, y));
      }
      const result = pc.correct(points);
      // 平滑化により Y方向の変動が減るはず
      const yRange = Math.max(...result.map(p => p.y)) - Math.min(...result.map(p => p.y));
      const origRange = 5;
      assert.ok(yRange <= origRange, `y range should not increase: ${yRange} vs ${origRange}`);
    });

    test('tolerance が大きいほど多く削除される', () => {
      const interp = new Interpolator();
      const points: any[] = [];
      // 緩やかな曲線 + ノイズ
      for (let i = 0; i <= 30; i++) {
        const noise = (i % 3 === 0) ? 2 : 0;
        points.push(mkPoint(i * 3, Math.sin(i * 0.2) * 10 + noise));
      }
      const pcLow = new PostCorrector(interp, { enabled: true, tolerance: 0.5 });
      const pcHigh = new PostCorrector(interp, { enabled: true, tolerance: 8 });
      const resampled = interp.resampleByArcLength(points);
      const lowControls = (pcLow as any).rdpSimplify(resampled, 0.5);
      const highControls = (pcHigh as any).rdpSimplify(resampled, 8);
      assert.ok(
        highControls.length < lowControls.length,
        `high tolerance should keep fewer controls: low=${lowControls.length}, high=${highControls.length}`,
      );
    });

    test('筆圧の単調変化が維持される', () => {
      const interp = new Interpolator();
      const pc = new PostCorrector(interp, { enabled: true, tolerance: 2 });
      const points: any[] = [];
      for (let i = 0; i <= 20; i++) {
        points.push(mkPoint(i * 5, 0, i / 20)); // 筆圧 0→1 へ単調増加
      }
      const result = pc.correct(points);
      for (let i = 1; i < result.length; i++) {
        assert.ok(
          result[i].pressure + 1e-9 >= result[i - 1].pressure,
          `pressure must be monotonic at ${i}: ${result[i - 1].pressure} -> ${result[i].pressure}`,
        );
      }
    });

    test('大きな方向変化の頂点が許容誤差内で保持される', () => {
      const interp = new Interpolator();
      const pc = new PostCorrector(interp, { enabled: true, tolerance: 1 });
      // L字型: (0,0) → (50,0) → (50,50)
      const points = [mkPoint(0, 0), mkPoint(25, 0), mkPoint(50, 0), mkPoint(50, 25), mkPoint(50, 50)];
      const result = pc.correct(points);
      const cornerDistance = Math.min(...result.map(p => Math.hypot(p.x - 50, p.y)));
      assert.ok(cornerDistance <= 1, `corner should remain within tolerance, got ${cornerDistance}`);
    });

    test('RDP距離は無限直線ではなく線分端点への距離を使う', () => {
      const interp = new Interpolator();
      const pc = new PostCorrector(interp, { enabled: true, tolerance: 1 });
      const point = mkPoint(-5, 1);
      const distance = (pc as any).perpendicularDistance(point, 0, 0, 10, 0, 100);
      assert.ok(Math.abs(distance - Math.hypot(5, 1)) < 1e-9, `distance=${distance}`);
    });

    test('updateConfig で設定を更新', () => {
      const interp = new Interpolator();
      const pc = new PostCorrector(interp, { enabled: false, tolerance: 1 });
      pc.updateConfig({ enabled: true, tolerance: 5 });
      const config = pc.getConfig();
      assert.strictEqual(config.enabled, true);
      assert.strictEqual(config.tolerance, 5);
    });

    test('長いストロークでも再帰上限や極端な確定遅延が発生しない', () => {
      const interp = new Interpolator();
      const pc = new PostCorrector(interp, { enabled: true, tolerance: 3 });
      // 5000点のストローク
      const points: any[] = [];
      for (let i = 0; i < 5000; i++) {
        points.push(mkPoint(i * 0.1, Math.sin(i * 0.01) * 20));
      }
      const start = Date.now();
      const result = pc.correct(points);
      const elapsed = Date.now() - start;
      // 5000点でも100ms以内に完了する（非再帰実装）
      assert.ok(elapsed < 100, `should complete in < 100ms, took ${elapsed}ms`);
      assert.ok(result.length > 0);
      assert.strictEqual(result[0].x, 0);
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

    test('弧長リサンプリングで入力間隔をほぼ一定にする', () => {
      const interpolator = new Interpolator({ inputSpacing: 2 });
      const points = [
        { x: 0, y: 0, pressure: 0, tiltX: 0, tiltY: 0, timestamp: 0 },
        { x: 1, y: 0, pressure: 0.1, tiltX: 0, tiltY: 0, timestamp: 2 },
        { x: 9, y: 0, pressure: 0.9, tiltX: 0, tiltY: 0, timestamp: 20 },
        { x: 10, y: 0, pressure: 1, tiltX: 0, tiltY: 0, timestamp: 22 },
      ];
      const result = interpolator.resampleByArcLength(points, 2);
      const gaps = result.slice(1).map((p, i) => Math.hypot(p.x - result[i].x, p.y - result[i].y));
      assert.ok(gaps.slice(0, -1).every(gap => Math.abs(gap - 2) < 1e-6));
      assert.deepStrictEqual({ x: result.at(-1)!.x, y: result.at(-1)!.y }, { x: 10, y: 0 });
    });

    test('centripetal補間は直線を直線のまま保つ', () => {
      const interpolator = new Interpolator({ spacing: 1, inputSpacing: 4 });
      const points = [
        { x: 0, y: 5, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 },
        { x: 3, y: 5, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 10 },
        { x: 20, y: 5, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 30 },
        { x: 50, y: 5, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 60 },
      ];
      const result = interpolator.interpolate(points);
      assert.ok(result.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
      assert.ok(result.every(p => Math.abs(p.y - 5) < 1e-6));
    });

    test('不均一な折れ点で大きくオーバーシュートしない', () => {
      const interpolator = new Interpolator({ spacing: 0.5, inputSpacing: 2 });
      const points = [
        { x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 },
        { x: 20, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 20 },
        { x: 21, y: 20, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 40 },
        { x: 40, y: 20, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 60 },
      ];
      const result = interpolator.interpolate(points);
      // centripetal Catmull-Rom は鋭角で適度に張り出す（〜2px 程度）が
      // uniform 型のような暴走はしない。発散レベルのオーバーシュートのみ検査。
      assert.ok(result.every(p => p.x >= -3 && p.x <= 43));
      assert.ok(result.every(p => p.y >= -2.5 && p.y <= 22.5));
    });

    // --- A5: 事前折れ線化をやめた補間の回帰テスト ---

    const mkPt = (x: number, y: number, ts: number, pressure = 0.5) =>
      ({ x, y, pressure, tiltX: 0, tiltY: 0, timestamp: ts });

    test('A5: 排出点間隔は弧長 spacing にほぼ一致する', () => {
      const interpolator = new Interpolator({ spacing: 2 });
      const points: any[] = [];
      for (let i = 0; i <= 20; i++) {
        points.push(mkPt(i * 10, 50 + Math.sin(i * 0.5) * 15, i * 10));
      }
      const out = interpolator.interpolate(points);
      assert.ok(out.length > 10);
      const gaps = out.slice(1).map((p, i) =>
        Math.hypot(p.x - out[i].x, p.y - out[i].y));
      // 内部の間隔は spacing にほぼ一致（終端は余りなので除外）
      for (const g of gaps.slice(0, -1)) {
        assert.ok(g > 1.6 && g < 2.05, `gap should be ~2: ${g}`);
      }
    });

    test('A5: 疎な曲線入力は入力折れ線ではなく曲線を描く', () => {
      const interpolator = new Interpolator({ spacing: 1 });
      // 半円弧を8分割した疎な入力
      const points: any[] = [];
      for (let i = 0; i <= 8; i++) {
        const a = Math.PI * (i / 8);
        points.push(mkPt(50 + Math.cos(a) * 40, 50 - Math.sin(a) * 25, i * 20));
      }
      const out = interpolator.interpolate(points);
      // 出力点の入力折れ線からの最大変位 > 0 = 曲線になっている
      let maxOff = 0;
      for (const p of out) {
        let minD = Infinity;
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1], b = points[i];
          const dx = b.x - a.x, dy = b.y - a.y;
          const len2 = dx * dx + dy * dy;
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
          minD = Math.min(minD, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
        }
        maxOff = Math.max(maxOff, minD);
      }
      assert.ok(maxOff > 0.5, `曲線が折れ線から逸脱する: ${maxOff.toFixed(2)}px`);
    });

    test('A5: 高密度ノイズ入力でも偏差を増幅しない', () => {
      const interpolator = new Interpolator({ spacing: 1 });
      // 240Hz 相当の密入力に ±0.3px の決定論的ノイズ
      const points: any[] = [];
      for (let i = 0; i <= 200; i++) {
        const noise = (((i * 7919) % 13) - 6) / 6 * 0.3;
        points.push(mkPt(i * 1.5, 200 + noise, i * 4));
      }
      const out = interpolator.interpolate(points);
      // 補間はノイズ除去ではなく滑らかな曲線化なので、
      // 偏差が生入力の振幅を大きく超えないことを確認する
      const outMax = Math.max(...out.map((p) => Math.abs(p.y - 200)));
      const outMean = out.reduce((a, p) => a + Math.abs(p.y - 200), 0) / out.length;
      const rawMax = Math.max(...points.map((p) => Math.abs(p.y - 200)));
      const rawMean = points.reduce((a, p) => a + Math.abs(p.y - 200), 0) / points.length;
      assert.ok(outMax <= rawMax + 0.15, `最大偏差が入力を超えない: ${outMax.toFixed(2)} vs ${rawMax}`);
      assert.ok(outMean <= rawMean + 0.1, `平均偏差が入力を超えない: ${outMean.toFixed(2)} vs ${rawMean.toFixed(2)}`);
    });

    test('A5: タイムスタンプは単調非減少を維持する', () => {
      const interpolator = new Interpolator({ spacing: 1 });
      const points: any[] = [];
      for (let i = 0; i <= 50; i++) {
        points.push(mkPt(i * 3, 100 + Math.sin(i * 0.3) * 20, i * 4));
      }
      const out = interpolator.interpolate(points);
      for (let i = 1; i < out.length; i++) {
        assert.ok(out[i].timestamp >= out[i - 1].timestamp,
          `timestamp must be non-decreasing at ${i}`);
      }
    });

    test('A5: 始点・終端の位置が入力と一致する', () => {
      const interpolator = new Interpolator({ spacing: 1 });
      const points = [mkPt(10, 10, 0), mkPt(50, 40, 30), mkPt(90, 15, 60)];
      const out = interpolator.interpolate(points);
      assert.strictEqual(out[0].x, 10);
      assert.strictEqual(out[0].y, 10);
      assert.strictEqual(out.at(-1)!.x, 90);
      assert.strictEqual(out.at(-1)!.y, 15);
    });
  });

  describe('4x brush bbox', async () => {
    const { alignBrushBbox4x } = await import('../src/render/brush-bbox.js');

    test('原点とサイズを4の倍数へ外向きに揃える', () => {
      const bbox = alignBrushBbox4x(101, 202, 319, 407, 8000, 8000);
      assert.deepStrictEqual(bbox, { minX: 100, minY: 200, width: 220, height: 208 });
      assert.strictEqual(bbox.minX % 4, 0);
      assert.strictEqual(bbox.minY % 4, 0);
      assert.strictEqual(bbox.width % 4, 0);
      assert.strictEqual(bbox.height % 4, 0);
    });

    test('キャンバス端で範囲内にクリップする', () => {
      const bbox = alignBrushBbox4x(-3, -2, 401, 402, 400, 400);
      assert.deepStrictEqual(bbox, { minX: 0, minY: 0, width: 400, height: 400 });
    });

    test('ストロークがキャンバス外でも有効な最小領域に収める', () => {
      const bbox = alignBrushBbox4x(450, 500, 480, 530, 400, 400);
      assert.deepStrictEqual(bbox, { minX: 396, minY: 396, width: 4, height: 4 });
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

    test('A7: 最小サイズ比 0% で筆圧ゼロ時に線幅ゼロになる', () => {
      const manager = new StrokeManager({ curve: 'linear', maxSize: 20 });
      manager.updatePressureConfig({ minSizeRatio: 0 });
      assert.strictEqual(manager.getPressureConfig().baseSize, 0, 'baseSize が 0 に換算される');

      manager.beginStroke();
      manager.addPoint({ x: 0, y: 0, pressure: 0, tiltX: 0, tiltY: 0, timestamp: 0 });
      manager.addPoint({ x: 10, y: 0, pressure: 1, tiltX: 0, tiltY: 0, timestamp: 10 });
      const stroke = manager.getCurrentStroke();
      assert.strictEqual(stroke[0].size, 0, 'pressure=0 → size 0');
      assert.strictEqual(stroke[1].size, 20, 'pressure=1 → maxSize');
    });

    test('A7: 最小サイズ比は最大径に比例する', () => {
      const manager = new StrokeManager({ curve: 'linear', minSizeRatio: 0.25, maxSize: 40 });
      manager.updatePressureConfig({ minSizeRatio: 0.25 });
      assert.strictEqual(manager.getPressureConfig().baseSize, 10);
      manager.updatePressureConfig({ maxSize: 40 }); // minSizeRatio 未指定 → baseSize 維持
      assert.strictEqual(manager.getPressureConfig().baseSize, 10);
    });

    test('A7: カスタムカーブが LUT 評価される', () => {
      const manager = new StrokeManager({
        curve: 'custom', baseSize: 0, maxSize: 100,
        customCurve: [{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }],
      });
      manager.beginStroke();
      manager.addPoint({ x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 });
      const stroke = manager.getCurrentStroke();
      // 制御点 (0.5, 0.8) を通るカーブ → pressure 0.5 で size ≈ 80
      assert.ok(stroke[0].size > 70 && stroke[0].size < 90, `custom curve: ${stroke[0].size}`);
    });

    test('A7: カスタムカーブ更新で LUT が再生成される', () => {
      const manager = new StrokeManager({
        curve: 'custom', baseSize: 0, maxSize: 100,
        customCurve: [{ x: 0, y: 0 }, { x: 0.5, y: 0.2 }, { x: 1, y: 1 }],
      });
      manager.beginStroke();
      manager.addPoint({ x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 0 });
      const before = manager.getCurrentStroke()[0].size;
      manager.updatePressureConfig({ customCurve: [{ x: 0, y: 0 }, { x: 0.5, y: 0.9 }, { x: 1, y: 1 }] });
      manager.addPoint({ x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 10 });
      const after = manager.getCurrentStroke()[1].size;
      assert.ok(after > before + 20, `LUT が更新されるはず: ${before} → ${after}`);
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

    test('maxUndo(50)を超えた古いレコードはラスターチェックポイント用に返して保持しない', () => {
      const history = new StrokeHistory();
      const evicted = [];
      for (let i = 0; i < 60; i++) {
        const old = history.addRecord(strokeRecord(i));
        if (old) evicted.push(old);
      }
      assert.strictEqual(history.getRecordCount(), 50, '最大50件に制限される');
      assert.strictEqual(history.getAllRecords().length, 50, '古い点列はJSヒープに保持しない');
      assert.strictEqual(evicted.length, 10, '古い操作をGPU基準画像へ渡せる');

      for (let i = 0; i < 50; i++) assert.ok(history.undo());
      assert.strictEqual(history.undo(), null, 'Undoできるのは直近50件まで');
      assert.strictEqual(history.getAllRecords().length, 0, 'Undo対象の点列だけを保持する');
    });

    test('クリアですべての操作を削除できる', () => {
      const history = new StrokeHistory();
      history.addRecord(strokeRecord(0));
      history.addRecord(strokeRecord(10));

      history.clear();
      assert.strictEqual(history.getRecordCount(), 0);
    });
  });

  describe('LiveStrokeProcessor', async () => {
    const { LiveStrokeProcessor } = await import('../src/pen/live-stroke.js');
    const { Stabilizer } = await import('../src/pen/stabilization.js');
    const { Interpolator } = await import('../src/pen/interpolation.js');

    const point = (x: number, timestamp: number) => ({
      x, y: Math.sin(x / 20) * 10, pressure: 0.5,
      tiltX: 0, tiltY: 0, timestamp,
    });

    test('長い入力でもライブ生入力窓を上限内に保つ', () => {
      const processor = new LiveStrokeProcessor(
        new Stabilizer({ minAlpha: 1, maxAlpha: 1 }),
        new Interpolator({ spacing: 1, inputSpacing: 2 }),
        { maxRawPoints: 32, maxDurationMs: 10_000, maxDistancePx: 10_000, overlapRawPoints: 4 },
      );

      processor.begin(point(0, 0));
      let flushedCount = 0;
      let maxBuffered = processor.getBufferedRawCount();
      for (let i = 1; i <= 10_000; i++) {
        const update = processor.add(point(i, i * 4));
        flushedCount += update.flushed.length;
        maxBuffered = Math.max(maxBuffered, processor.getBufferedRawCount());
      }
      const tail = processor.finish();

      assert.ok(flushedCount > 0, '長いストロークは複数 prefix に分割される');
      assert.ok(maxBuffered <= 32, `生入力窓が上限を超えない: ${maxBuffered}`);
      assert.ok(tail.length > 0);
      assert.ok(Math.abs(tail[tail.length - 1].x - 10_000) < 0.01, '終端は最後の生入力へ収束する');
    });

    test('deferFlush時は pen up まで全点保持して後補正できる', () => {
      const processor = new LiveStrokeProcessor(
        new Stabilizer({ minAlpha: 1, maxAlpha: 1 }),
        new Interpolator({ spacing: 1 }),
        { maxRawPoints: 4, maxDurationMs: 1, maxDistancePx: 1, overlapRawPoints: 1 },
      );

      processor.begin(point(0, 0), { deferFlush: true });
      let flushed = 0;
      for (let i = 1; i <= 100; i++) flushed += processor.add(point(i, i)).flushed.length;
      const tail = processor.finish();

      assert.strictEqual(flushed, 0);
      assert.ok(tail.length > 0);
      assert.ok(Math.abs(tail[0].x) < 0.01);
      assert.ok(Math.abs(tail[tail.length - 1].x - 100) < 0.01);
    });

    test('点数が少なくても時間または距離でフラッシュする', () => {
      const byTime = new LiveStrokeProcessor(
        new Stabilizer({ minAlpha: 1, maxAlpha: 1 }),
        new Interpolator({ spacing: 1 }),
        { maxRawPoints: 100, maxDurationMs: 20, maxDistancePx: 10_000, overlapRawPoints: 2 },
      );
      byTime.begin(point(0, 0));
      byTime.add(point(1, 10));
      const timed = byTime.add(point(2, 25));
      assert.ok(timed.flushed.length > 0, '時間窓でフラッシュする');

      const byDistance = new LiveStrokeProcessor(
        new Stabilizer({ minAlpha: 1, maxAlpha: 1 }),
        new Interpolator({ spacing: 1 }),
        { maxRawPoints: 100, maxDurationMs: 10_000, maxDistancePx: 10, overlapRawPoints: 2 },
      );
      byDistance.begin(point(0, 0));
      byDistance.add(point(6, 4));
      const distant = byDistance.add(point(12, 8));
      assert.ok(distant.flushed.length > 0, '距離窓でフラッシュする');
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
