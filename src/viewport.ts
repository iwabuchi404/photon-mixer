/**
 * 2D ビューポート管理
 * ズーム、パン、座標変換
 */

export class Viewport {
  private scale = 1.0;
  private offsetX = 0;
  private offsetY = 0;

  private readonly minScale = 0.1;
  private readonly maxScale = 32.0;

  /**
   * スクリーン座標 -> キャンバス座標
   */
  toCanvas(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.offsetX) / this.scale,
      y: (sy - this.offsetY) / this.scale,
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
   * ビューポートをリセット
   */
  reset(canvasWidth: number, canvasHeight: number, screenWidth: number, screenHeight: number): void {
    // 中央に配置
    this.scale = 1.0;
    this.offsetX = (screenWidth - canvasWidth) / 2;
    this.offsetY = (screenHeight - canvasHeight) / 2;
  }

  getTransform() {
    return {
      scale: this.scale,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
    };
  }
}
