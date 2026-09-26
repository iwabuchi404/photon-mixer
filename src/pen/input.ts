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
  pointerType: string;
  /** 消しゴムスイッチ（button 5）で開始したストローク */
  eraser: boolean;
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
  /** 消しゴムスイッチで開始したストローク（up まで有効） */
  private strokeEraser = false;
  /** blur 時の確定用にアクティブポインタの最終点を保持 */
  private lastPoint: PointerPoint | null = null;
  /** getBoundingClientRect の結果キャッシュ（サンプルごとのレイアウト計算を避ける） */
  private cachedRect: DOMRect | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.setupEventListeners();
  }

  setTouchDrawEnabled(enabled: boolean): void {
    this.touchDrawEnabled = enabled;
  }

  /** canvas の位置を再取得させる（リサイズ・レイアウト変更時） */
  invalidateRect(): void {
    this.cachedRect = null;
  }

  /**
   * イベントリスナーを設定
   */
  private setupEventListeners(): void {
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && !this.touchDrawEnabled) return;
      // 主ボタン(0) か消しゴムスイッチ(5) 以外では描画を開始しない。
      // これでペンのサイドボタン(2)・マウスの右/中クリックによる誤描画を防ぐ。
      if (e.button !== 0 && e.button !== 5) return;
      if (this.activePointerId !== null && this.activePointerId !== e.pointerId) return;
      if (this.activePointerId === null) {
        this.activePointerId = e.pointerId;
        this.strokeEraser = e.button === 5;
        try { this.canvas.setPointerCapture(e.pointerId); } catch {}
      }
      this.handlePointerEvent(e, 'down');
    });

    // move/up/cancel はアクティブポインタのものだけ処理する。
    // ホバーや別ポインタのイベントをアプリ層へ流さない
    // （無駄な座標変換・状態遷移を省き、取りこぼし up の混入も防ぐ）
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.activePointerId === null || this.activePointerId !== e.pointerId) return;
      this.handlePointerMove(e);
    });

    this.canvas.addEventListener('pointerup', (e) => {
      if (this.activePointerId === null || this.activePointerId !== e.pointerId) return;
      this.handlePointerEvent(e, 'up');
      this.activePointerId = null;
      this.strokeEraser = false;
      this.lastPoint = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
    });

    this.canvas.addEventListener('pointercancel', (e) => {
      if (this.activePointerId === null || this.activePointerId !== e.pointerId) return;
      this.handlePointerEvent(e, 'cancel');
      this.activePointerId = null;
      this.strokeEraser = false;
      this.lastPoint = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
    });

    // OS 起因でキャプチャが失われた場合（up/cancel の後始末では
    // activePointerId が先に null になるので、ここに来るのは取りこぼしのみ）
    this.canvas.addEventListener('lostpointercapture', (e) => {
      if (this.activePointerId === null || this.activePointerId !== e.pointerId) return;
      this.handlePointerEvent(e, 'up');
      this.activePointerId = null;
      this.strokeEraser = false;
      this.lastPoint = null;
    });

    // ウィンドウのフォーカス喪失（Alt+Tab・OS通知等）でも描画を確定して閉じる
    // （Node テスト環境には window がないためガード）
    if (typeof window !== 'undefined') {
      window.addEventListener('blur', () => this.finishActiveStrokeOnBlur());
      window.addEventListener('resize', () => this.invalidateRect());
    }

    // 右クリックメニューは描画操作と競合するため抑止
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // canvas 座標の rect はリサイズ・レイアウト変更時のみ再取得
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.invalidateRect()).observe(this.canvas);
    }
  }

  /**
   * blur 等でイベント列が途切れたとき、アクティブなストロークを
   * 直前の位置で 'up' として確定する（キャンセルではなくコミット側に寄せる）
   */
  private finishActiveStrokeOnBlur(): void {
    if (this.activePointerId === null) return;
    const pointerId = this.activePointerId;
    const point = this.lastPoint ?? {
      x: 0, y: 0, pressure: 0, tiltX: 0, tiltY: 0,
      timestamp: performance.now(), pointerId,
    };
    const eraser = this.strokeEraser;
    for (const handler of this.handlers) {
      handler({ type: 'up', point, pointerId, pointerType: 'pen', eraser });
    }
    this.activePointerId = null;
    this.strokeEraser = false;
    this.lastPoint = null;
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

    // キャンバス上の座標を取得（rect はキャッシュを使う）
    if (!this.cachedRect) this.cachedRect = this.canvas.getBoundingClientRect();
    const x = e.clientX - this.cachedRect.left;
    const y = e.clientY - this.cachedRect.top;

    // 筆圧を取得（ペン: 0-1、マウス: 常に0.5、タッチ: 報告値がなければ0.5）
    // up イベントはペンが離れて筆圧 0 になりがちなので、直前の値を継承する
    const rawPressure = e.pointerType === 'pen' && e.pressure !== 0.5 ? e.pressure
      : e.pointerType === 'touch' ? (e.pressure > 0 ? e.pressure : 0.5)
      : 0.5;
    const pressure = (type === 'up' || type === 'cancel') && this.lastPoint
      ? this.lastPoint.pressure
      : rawPressure;

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

    this.lastPoint = point;
    const eraser = this.strokeEraser;
    for (const handler of this.handlers) {
      handler({ type, point, pointerId: e.pointerId, pointerType: e.pointerType, eraser });
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
