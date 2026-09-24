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
  pointerId?: number;
}

/**
 * ペン入力イベント
 */
export interface PenInputEvent {
  type: 'down' | 'move' | 'up' | 'cancel';
  point: PointerPoint;
  pointerId: number;
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
  private activePointerId: number | null = null;
  /** true のときタッチも描画入力として受け付ける（既定 false: 誤操作防止） */
  private touchDrawEnabled = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.setupEventListeners();
  }

  setTouchDrawEnabled(enabled: boolean): void {
    this.touchDrawEnabled = enabled;
  }

  /**
   * イベントリスナーを設定
   */
  private setupEventListeners(): void {
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && !this.touchDrawEnabled) return;
      if (this.activePointerId !== null && this.activePointerId !== e.pointerId) return;
      if (this.activePointerId === null) {
        this.activePointerId = e.pointerId;
        try { this.canvas.setPointerCapture(e.pointerId); } catch {}
      }
      this.handlePointerEvent(e, 'down');
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (this.activePointerId !== null && this.activePointerId !== e.pointerId) return;
      this.handlePointerMove(e);
    });

    this.canvas.addEventListener('pointerup', (e) => {
      if (this.activePointerId !== null && this.activePointerId !== e.pointerId) return;
      this.handlePointerEvent(e, 'up');
      this.activePointerId = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
    });

    this.canvas.addEventListener('pointercancel', (e) => {
      if (this.activePointerId !== null && this.activePointerId !== e.pointerId) return;
      this.handlePointerEvent(e, 'cancel');
      this.activePointerId = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
    });
  }

  /**
   * OSが1回のpointermoveへまとめた高密度サンプルを発生順に処理する。
   * getCoalescedEvents() 非対応環境では通常イベント1点へフォールバックする。
   */
  private handlePointerMove(e: PointerEvent): void {
    if (e.pointerType === 'touch' && !this.touchDrawEnabled) return;

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
  private handlePointerEvent(e: PointerEvent, type: 'down' | 'move' | 'up' | 'cancel'): void {
    if (e.pointerType === 'touch' && !this.touchDrawEnabled) return;

    // キャンバス上の座標を取得
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // 筆圧を取得（ペン: 0-1、マウス: 常に0.5、タッチ: 報告値がなければ0.5）
    const pressure = e.pointerType === 'pen' && e.pressure !== 0.5 ? e.pressure
      : e.pointerType === 'touch' ? (e.pressure > 0 ? e.pressure : 0.5)
      : 0.5;

    // 傾きを取得（ペン: -90 to 90、マウス: 常に0）
    const tiltX = e.pointerType === 'pen' ? e.tiltX : 0;
    const tiltY = e.pointerType === 'pen' ? e.tiltY : 0;

    const point: PointerPoint = {
      x,
      y,
      pressure,
      tiltX,
      tiltY,
      timestamp: Number.isFinite(e.timeStamp) ? e.timeStamp : performance.now(),
      pointerId: e.pointerId,
    };

    for (const handler of this.handlers) {
      handler({ type, point, pointerId: e.pointerId });
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
