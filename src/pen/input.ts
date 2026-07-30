/**
 * PointerEvent 入力処理
 * ペンから座標、筆圧、傾きを取得
 */

/**
 * 単一の入力点
 */
export interface PointerPoint {
  x: number;
  y: number;
  pressure: number; // 0-1
  tiltX: number;    // -90 to 90
  tiltY: number;    // -90 to 90
  timestamp: number; // ミリ秒
}

/**
 * ペン入力イベント
 */
export interface PenInputEvent {
  type: 'down' | 'move' | 'up';
  point: PointerPoint;
}

/**
 * ペン入力ハンドラー
 */
export type PenInputHandler = (event: PenInputEvent) => void;

/**
 * ペン入力マネージャー
 */
export class PenInputManager {
  private handlers: PenInputHandler[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.setupEventListeners();
  }

  /**
   * イベントリスナーを設定
   */
  private setupEventListeners(): void {
    // pointerdown: ペンが触れた
    this.canvas.addEventListener('pointerdown', (e) => {
      this.handlePointerEvent(e, 'down');
    });

    // pointermove: ペンが動いた
    this.canvas.addEventListener('pointermove', (e) => {
      this.handlePointerMove(e);
    });

    // pointerup: ペンが離れた
    this.canvas.addEventListener('pointerup', (e) => {
      this.handlePointerEvent(e, 'up');
    });

    // pointerleave: ペンがキャンバス外に出た
    this.canvas.addEventListener('pointerleave', (e) => {
      this.handlePointerEvent(e, 'up');
    });

    // pointer cancel: 入力がキャンセルされた
    this.canvas.addEventListener('pointercancel', (e) => {
      this.handlePointerEvent(e, 'up');
    });
  }

  /**
   * OSが1回のpointermoveへまとめた高密度サンプルを発生順に処理する。
   * getCoalescedEvents() 非対応環境では通常イベント1点へフォールバックする。
   */
  private handlePointerMove(e: PointerEvent): void {
    if (e.pointerType === 'touch') return;

    const coalesced = typeof e.getCoalescedEvents === 'function'
      ? e.getCoalescedEvents()
      : [];
    const samples = coalesced.length > 0 ? coalesced : [e];

    for (const sample of samples) {
      this.handlePointerEvent(sample, 'move');
    }
  }

  /**
   * ポインターイベントを処理
   */
  private handlePointerEvent(e: PointerEvent, type: 'down' | 'move' | 'up'): void {
    // タッチは除外（タブレットでの誤操作防止）
    if (e.pointerType === 'touch') {
      return;
    }

    // キャンバス上の座標を取得
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // 筆圧を取得（ペン: 0-1、マウス: 常に0.5）
    const pressure = e.pointerType === 'pen' && e.pressure !== 0.5 ? e.pressure : 0.5;

    // 傾きを取得（ペン: -90 to 90、マウス: 常に0）
    const tiltX = e.pointerType === 'pen' ? e.tiltX : 0;
    const tiltY = e.pointerType === 'pen' ? e.tiltY : 0;

    const point: PointerPoint = {
      x,
      y,
      pressure,
      tiltX,
      tiltY,
      // performance.now() で受信時刻を付け直すと、coalesced event が全て同時刻に
      // なって速度計算が壊れる。ブラウザが各サンプルへ付けた時刻を保持する。
      timestamp: Number.isFinite(e.timeStamp) ? e.timeStamp : performance.now(),
    };

    // ハンドラーを呼び出し
    for (const handler of this.handlers) {
      handler({ type, point });
    }
  }

  /**
   * ハンドラーを登録
   */
  onPenInput(handler: PenInputHandler): void {
    this.handlers.push(handler);
  }

  /**
   * すべてのハンドラーをクリア
   */
  clearHandlers(): void {
    this.handlers = [];
  }
}
