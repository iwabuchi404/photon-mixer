/**
 * 描画パイプライン
 * レンダーパスの管理、キャンバスへの転送
 */

import type { Renderer } from '../core/renderer.js';
import type { StrokePoint } from '../pen/stroke.js';
import { BrushRenderer, type BrushConfig } from './brush.js';

/**
 * 描画パイプラインマネージャー
 */
export class RenderPipeline {
  private renderer: Renderer;
  private brushRenderer: BrushRenderer;
  private strokes: StrokePoint[][] = []; // 完了したストローク
  private currentStroke: StrokePoint[] = []; // 現在のストローク

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    this.brushRenderer = new BrushRenderer(renderer.device);
  }

  /**
   * 初期化
   */
  async init(): Promise<void> {
    await this.brushRenderer.init(
      this.renderer.canvas.width,
      this.renderer.canvas.height,
      this.renderer.format,
    );
  }

  /**
   * 現在のストロークを設定
   */
  setCurrentStroke(points: StrokePoint[]): void {
    this.currentStroke = points;
  }

  /**
   * ストロークを確定（完了したストロークとして追加）
   */
  commitStroke(points: StrokePoint[]): void {
    if (points.length > 0) {
      this.strokes.push([...points]);
    }
    this.currentStroke = [];
  }

  /**
   * すべてのストロークをクリア
   */
  clear(): void {
    this.strokes = [];
    this.currentStroke = [];
  }

  /**
   * フレームを描画
   */
  render(): void {
    const commandEncoder = this.renderer.device.createCommandEncoder();

    const renderPassDescriptor: GPURenderPassDescriptor = {
      colorAttachments: [
        {
          view: this.renderer.context.getCurrentTexture().createView(),
          clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 }, // ダークグレー背景
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    };

    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);

    // pointBufferは共有バッファなので全点をまとめて1回で描画する
    const allPoints = [...this.strokes.flat(), ...this.currentStroke];
    if (allPoints.length > 0) {
      this.brushRenderer.renderStroke(passEncoder, allPoints);
    }

    passEncoder.end();

    this.renderer.device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * リサイズ対応
   */
  resize(width: number, height: number): void {
    this.renderer.canvas.width = width;
    this.renderer.canvas.height = height;
    this.brushRenderer.resize(width, height);
  }

  /**
   * ブラシ設定を更新（色・不透明度）
   */
  updateBrushConfig(config: Partial<BrushConfig>): void {
    this.brushRenderer.updateConfig(config);
  }

  /**
   * リソースを破棄
   */
  dispose(): void {
    this.brushRenderer.dispose();
  }

  /**
   * 現在のストローク数を取得（デバッグ用）
   */
  getStrokeCount(): number {
    return this.strokes.length;
  }
}
