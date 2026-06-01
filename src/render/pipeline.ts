/**
 * 描画パイプライン（隔離バッファ方式）
 *
 * 仕組み:
 *   isolatedTexture に全ストロークを max blend で描画
 *   → 同一ストローク内でスタンプが重なっても α が蓄積しない
 *   → canvas に over blend で転写
 *
 * 将来: 確定済みストロークを committed テクスチャにベイクして
 *       再描画コストを下げる（現在は全点を毎フレーム描画）
 */

import type { Renderer } from '../core/renderer.js';
import type { StrokePoint } from '../pen/stroke.js';
import { BrushRenderer, type BrushConfig } from './brush.js';
import { CompositeRenderer } from './composite.js';

const BUFFER_FORMAT: GPUTextureFormat = 'rgba8unorm';

export class RenderPipeline {
  private renderer: Renderer;
  private brushRenderer: BrushRenderer;
  private compositeRenderer: CompositeRenderer;

  // 全描画の中間バッファ（max blend でαを正しく積む）
  private isolatedTexture!: GPUTexture;
  // 確定済みストローク（毎フレーム再描画）
  private strokes: StrokePoint[][] = [];
  private currentStroke: StrokePoint[] = [];

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    this.brushRenderer = new BrushRenderer(renderer.device);
    this.compositeRenderer = new CompositeRenderer(renderer.device);
  }

  async init(): Promise<void> {
    const { canvas, format } = this.renderer;
    await this.brushRenderer.init(canvas.width, canvas.height, BUFFER_FORMAT);
    await this.compositeRenderer.init(format);
    this.isolatedTexture = this.makeTexture(canvas.width, canvas.height);
  }

  private makeTexture(width: number, height: number): GPUTexture {
    return this.renderer.device.createTexture({
      size: [width, height],
      format: BUFFER_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  setCurrentStroke(points: StrokePoint[]): void {
    this.currentStroke = points;
  }

  commitStroke(points: StrokePoint[]): void {
    if (points.length > 0) {
      this.strokes.push([...points]);
    }
    this.currentStroke = [];
  }

  render(): void {
    const { device, context } = this.renderer;
    const allPoints = [...this.strokes.flat(), ...this.currentStroke];
    const encoder = device.createCommandEncoder();

    // Pass 1: isolated をクリアして全点を max blend で描画（α蓄積なし）
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.isolatedTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      if (allPoints.length > 0) {
        this.brushRenderer.renderStroke(pass, allPoints);
      }
      pass.end();
    }

    // Pass 2: 背景色でクリアして isolated を over blend で転写
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      this.compositeRenderer.draw(pass, this.isolatedTexture);
      pass.end();
    }

    device.queue.submit([encoder.finish()]);
  }

  updateBrushConfig(config: Partial<BrushConfig>): void {
    this.brushRenderer.updateConfig(config);
  }

  clear(): void {
    this.strokes = [];
    this.currentStroke = [];
  }

  resize(width: number, height: number): void {
    this.renderer.canvas.width = width;
    this.renderer.canvas.height = height;
    this.brushRenderer.resize(width, height);
    this.isolatedTexture.destroy();
    this.isolatedTexture = this.makeTexture(width, height);
  }

  dispose(): void {
    this.brushRenderer.dispose();
    this.isolatedTexture?.destroy();
  }
}
