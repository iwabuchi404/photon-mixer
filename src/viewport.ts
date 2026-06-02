/**
 * 2D ビューポート管理
 * ズーム、パン、回転、座標変換
 */

export interface ViewportTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
  rotation: number; // ラジアン
  flip: number;     // 1=通常, -1=左右反転
}

export class Viewport {
  private scale = 1.0;
  private offsetX = 0;
  private offsetY = 0;
  private rotation = 0; // ラジアン
  private flipX = false;
  private canvasWidth = 0;
  private canvasHeight = 0;

  private readonly minScale = 0.1;
  private readonly maxScale = 32.0;

  /**
   * スクリーン座標 -> キャンバス座標
   * シェーダーの逆変換：パンを引く → 回転の逆 → スケールで割る → キャンバス中心を戻す
   */
  toCanvas(sx: number, sy: number): { x: number; y: number } {
    // 1. パンを引く
    const ox = sx - this.offsetX;
    const oy = sy - this.offsetY;

    // 2. 回転の逆を適用（逆回転 = -rotation）
    const cos = Math.cos(-this.rotation);
    const sin = Math.sin(-this.rotation);
    const rx = ox * cos - oy * sin;
    const ry = ox * sin + oy * cos;

    // 3. スケールで割る
    let cx = rx / this.scale;
    const cy = ry / this.scale;

    // 4. 左右反転の逆（flip は ±1 で自己逆元）
    if (this.flipX) cx = -cx;

    // 5. キャンバス中心を戻す
    return {
      x: cx + this.canvasWidth / 2,
      y: cy + this.canvasHeight / 2,
    };
  }

  /**
   * ズーム（指定スクリーン座標を中心に）
   */
  zoom(factor: number, cx: number, cy: number): void {
    const newScale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * factor));
    
    // 中心を維持するためのオフセット計算
    this.offsetX = cx - (cx - this.offsetX) * (newScale / this.scale);
    this.offsetY = cy - (cy - this.offsetY) * (newScale / this.scale);
    this.scale = newScale;
  }

  /**
   * パン
   */
  pan(dx: number, dy: number): void {
    this.offsetX += dx;
    this.offsetY += dy;
  }

  /**
   * 回転（指定角度を追加）
   * @param deltaRotation 追加する回転角（ラジアン）
   */
  rotate(deltaRotation: number): void {
    this.rotation += deltaRotation;
    // 正規化（-π～π）
    while (this.rotation > Math.PI) this.rotation -= 2 * Math.PI;
    while (this.rotation < -Math.PI) this.rotation += 2 * Math.PI;
  }

  /**
   * 回転をリセット
   */
  resetRotation(): void {
    this.rotation = 0;
  }

  /**
   * 左右反転をトグル
   */
  toggleFlip(): void {
    this.flipX = !this.flipX;
  }

  /**
   * キャンバスサイズを設定
   */
  setCanvasSize(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
  }

  /**
   * キャンバスサイズを取得
   */
  getCanvasSize(): { width: number; height: number } {
    return { width: this.canvasWidth, height: this.canvasHeight };
  }

  /**
   * ビューポートをリセット
   */
  reset(canvasWidth: number, canvasHeight: number, screenWidth: number, screenHeight: number): void {
    // キャンバスサイズを保存
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;

    // 中央に配置
    // vs_display はキャンバス中心を引いてから回転・スケール・オフセットを適用するため
    // offset = 「キャンバス中心が画面上のどこに来るか」= 画面中心
    this.scale = 1.0;
    this.offsetX = screenWidth / 2;
    this.offsetY = screenHeight / 2;
    this.rotation = 0;
    this.flipX = false;
  }

  getTransform(): ViewportTransform {
    return {
      scale: this.scale,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
      rotation: this.rotation,
      flip: this.flipX ? -1 : 1,
    };
  }
}
