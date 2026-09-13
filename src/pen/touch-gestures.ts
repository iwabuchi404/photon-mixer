/**
 * タッチジェスチャ管理（1本指パン / 2本指ピンチズーム）
 *
 * - ペン入力中はタッチを無視する（パームリジェクション）
 * - 「タッチで描画」ON のとき1本指タッチは描画へ譲る（PenInputManager が処理）
 * - マウス/ペンは一切扱わない（既存の Space/中ドラッグパンと独立）
 */
export interface TouchGestureCallbacks {
  pan(dx: number, dy: number): void;
  zoom(factor: number, cx: number, cy: number): void;
  /** pan/zoom 後に呼び出される（パイプラインへの反映用）。頻繁に呼ばれる。 */
  sync(): void;
}

export class TouchGestureManager {
  private pointers = new Map<number, { x: number; y: number }>();
  private penActive = false;
  private pinchDist = 0;
  private pinchMid = { x: 0, y: 0 };
  private lastSingle = { x: 0, y: 0 };
  private mode: 'none' | 'pan' | 'pinch' = 'none';
  private touchDrawEnabled = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private cb: TouchGestureCallbacks,
  ) {
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onUp(e));
  }

  setTouchDrawEnabled(enabled: boolean): void {
    this.touchDrawEnabled = enabled;
  }

  private pos(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onDown(e: PointerEvent): void {
    if (e.pointerType === 'pen') {
      // ペンが触れたらジェスチャ追跡を捨てる（パームリジェクション）
      this.penActive = true;
      this.pointers.clear();
      this.mode = 'none';
      return;
    }
    if (e.pointerType !== 'touch') return;
    if (this.penActive) return; // 描画中の手のひらは無視
    const p = this.pos(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      if (this.touchDrawEnabled) {
        // 描画へ譲る（PenInputManager が処理する）
        this.mode = 'none';
      } else {
        this.mode = 'pan';
        this.lastSingle = { x: p.x, y: p.y };
      }
    } else if (this.pointers.size === 2) {
      const pts = [...this.pointers.values()];
      this.pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      this.pinchMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      this.mode = this.pinchDist > 0 ? 'pinch' : 'none';
    } else {
      this.mode = 'none';
    }
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerType !== 'touch' || this.penActive) return;
    const tracked = this.pointers.get(e.pointerId);
    if (!tracked) return;
    const p = this.pos(e);
    tracked.x = p.x;
    tracked.y = p.y;
    if (this.mode === 'pan' && this.pointers.size === 1) {
      this.cb.pan(p.x - this.lastSingle.x, p.y - this.lastSingle.y);
      this.lastSingle = p;
      this.cb.sync();
    } else if (this.mode === 'pinch' && this.pointers.size === 2) {
      const pts = [...this.pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      if (this.pinchDist > 0 && dist > 0) {
        this.cb.zoom(dist / this.pinchDist, mid.x, mid.y);
        this.cb.pan(mid.x - this.pinchMid.x, mid.y - this.pinchMid.y);
        this.cb.sync();
      }
      this.pinchDist = dist;
      this.pinchMid = mid;
    }
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerType === 'pen') {
      this.penActive = false;
      return;
    }
    if (e.pointerType !== 'touch') return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 1) {
      const [p] = [...this.pointers.values()];
      if (this.touchDrawEnabled || this.penActive) {
        this.mode = 'none';
      } else {
        this.mode = 'pan';
        this.lastSingle = { x: p.x, y: p.y };
      }
    } else if (this.pointers.size === 0) {
      this.mode = 'none';
    }
  }
}
