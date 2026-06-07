/**
 * トーンカーブ編集 UI（vanilla canvas）。
 * 制御点をドラッグ／追加／削除し、変更時に onChange を呼ぶ。LUT は getLut() で取得。
 */

import { sampleCurve, buildCurveLut, type CurvePoint } from '../color/curve.js';

export class CurveEditor {
  private canvas: HTMLCanvasElement;
  private points: CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  private dragIndex = -1;
  private onChange: () => void;
  private readonly W = 180;
  private readonly H = 140;

  constructor(container: HTMLElement, onChange: () => void) {
    this.onChange = onChange;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.canvas.style.cssText = 'width:100%; height:140px; border:1px solid #444; cursor:crosshair; background:#111;';
    this.canvas.title = 'クリックで点追加 / ドラッグで移動 / 右クリックで削除';
    container.appendChild(this.canvas);

    const reset = document.createElement('button');
    reset.textContent = 'カーブをリセット';
    reset.className = 'tool-btn';
    reset.style.cssText = 'font-size:10px; padding:3px 0; margin-top:4px; width:100%;';
    reset.addEventListener('click', () => { this.points = [{ x: 0, y: 0 }, { x: 1, y: 1 }]; this.draw(); this.onChange(); });
    container.appendChild(reset);

    this.bind();
    this.draw();
  }

  getLut(): Uint8Array { return buildCurveLut(this.points); }
  getPoints(): CurvePoint[] { return this.points.map(p => ({ ...p })); }
  /** 外部から制御点を設定（onChange は発火しない） */
  setPoints(pts: CurvePoint[]): void {
    this.points = pts.length >= 2 ? pts.map(p => ({ ...p })) : [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    this.draw();
  }

  // 座標変換
  private toCanvas(p: CurvePoint) { return { px: p.x * this.W, py: (1 - p.y) * this.H }; }
  private toNorm(px: number, py: number): CurvePoint {
    return { x: Math.max(0, Math.min(1, px / this.W)), y: Math.max(0, Math.min(1, 1 - py / this.H)) };
  }

  private hitTest(px: number, py: number): number {
    for (let i = 0; i < this.points.length; i++) {
      const c = this.toCanvas(this.points[i]);
      if ((c.px - px) ** 2 + (c.py - py) ** 2 <= 64) return i; // 8px 半径
    }
    return -1;
  }

  private localPos(e: MouseEvent): { px: number; py: number } {
    const r = this.canvas.getBoundingClientRect();
    return { px: (e.clientX - r.left) / r.width * this.W, py: (e.clientY - r.top) / r.height * this.H };
  }

  private bind(): void {
    this.canvas.addEventListener('mousedown', (e) => {
      const { px, py } = this.localPos(e);
      let i = this.hitTest(px, py);
      if (i < 0) {
        // 新規点を追加して即ドラッグ
        const np = this.toNorm(px, py);
        this.points.push(np);
        this.points.sort((a, b) => a.x - b.x);
        i = this.points.findIndex(p => p === np);
      }
      this.dragIndex = i;
      const move = (ev: MouseEvent) => this.onDrag(ev);
      const up = () => { this.dragIndex = -1; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this.onChange(); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      this.draw();
      this.onChange();
    });

    // 右クリックで点削除（端点は残す）
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const { px, py } = this.localPos(e);
      const i = this.hitTest(px, py);
      if (i > 0 && i < this.points.length - 1) {
        this.points.splice(i, 1);
        this.draw();
        this.onChange();
      }
    });
  }

  private onDrag(e: MouseEvent): void {
    if (this.dragIndex < 0) return;
    const { px, py } = this.localPos(e);
    const n = this.points.length;
    const np = this.toNorm(px, py);
    const i = this.dragIndex;
    if (i === 0) { this.points[i] = { x: 0, y: np.y }; }
    else if (i === n - 1) { this.points[i] = { x: 1, y: np.y }; }
    else {
      // 隣接点の間に x をクランプ
      const lo = this.points[i - 1].x + 1e-3, hi = this.points[i + 1].x - 1e-3;
      this.points[i] = { x: Math.max(lo, Math.min(hi, np.x)), y: np.y };
    }
    this.draw();
    this.onChange();
  }

  private draw(): void {
    const ctx = this.canvas.getContext('2d')!;
    const { W, H } = this;
    ctx.clearRect(0, 0, W, H);
    // グリッド
    ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 1;
    for (let k = 1; k < 4; k++) {
      const gx = (W / 4) * k, gy = (H / 4) * k;
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
    }
    // 対角参照
    ctx.strokeStyle = '#333';
    ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(W, 0); ctx.stroke();
    // カーブ
    const s = sampleCurve(this.points);
    ctx.strokeStyle = '#7fb2ff'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let k = 0; k < 256; k++) {
      const x = (k / 255) * W, y = (1 - s[k]) * H;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // 制御点
    for (const p of this.points) {
      const c = this.toCanvas(p);
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000';
      ctx.beginPath(); ctx.arc(c.px, c.py, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
}
