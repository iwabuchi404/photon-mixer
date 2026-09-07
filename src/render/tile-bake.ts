/**
 * T1: タイル書き込み用ベイクレンダラー
 *
 * fullscreen ソースの部分矩形をタイルテクスチャ全体へ転写する。
 * ブレンドは composite と同じ3種（over / erase / max）。
 * composite.wgsl の vs_bake_rect + fs_main を使う独自レイアウト。
 */

export type TileBakeMode = 'over' | 'erase' | 'max';

export class TileBakeRenderer {
  private device: GPUDevice;
  private sampler: GPUSampler;
  private rectBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private pipelines: Record<TileBakeMode, GPURenderPipeline | null> = {
    over: null, erase: null, max: null,
  };

  constructor(device: GPUDevice) {
    this.device = device;
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    // src_offset(2) + src_size(2) = 16 bytes
    this.rectBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  async init(): Promise<void> {
    const response = await fetch('dist/shaders/composite.wgsl');
    if (!response.ok) throw new Error('Failed to load composite.wgsl');
    const module = this.device.createShaderModule({ code: await response.text() });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });

    const overBlend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    const eraseBlend: GPUBlendState = {
      color: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    const maxBlend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
    };
    const make = (blend: GPUBlendState) =>
      this.device.createRenderPipeline({
        layout,
        vertex: { module, entryPoint: 'vs_bake_rect' },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba16float', blend }] },
        primitive: { topology: 'triangle-strip' },
      });
    this.pipelines.over = make(overBlend);
    this.pipelines.erase = make(eraseBlend);
    this.pipelines.max = make(maxBlend);
  }

  /**
   * ソースのキャンバス矩形 (sx, sy, sw, sh) をタイル全体へ転写する。
   * erase=true のとき消しゴム合成。
   * scissor 指定時は dst の矩形内だけ書く（T2 ライブ重ね用。uv 写像は不変）。
   */
  bakeRect(
    src: GPUTexture, dst: GPUTexture,
    mode: TileBakeMode,
    sx: number, sy: number, sw: number, sh: number,
    canvasW: number, canvasH: number,
    scissor?: { x: number; y: number; w: number; h: number },
  ): void {
    const pipeline = this.pipelines[mode];
    if (!pipeline || !this.bindGroupLayout) return;
    this.device.queue.writeBuffer(
      this.rectBuffer, 0,
      new Float32Array([sx / canvasW, sy / canvasH, sw / canvasW, sh / canvasH]),
    );
    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.rectBuffer } },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: dst.createView(), loadOp: 'load', storeOp: 'store' }],
    });
    if (scissor) pass.setScissorRect(scissor.x, scissor.y, scissor.w, scissor.h);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    this.rectBuffer.destroy();
  }
}
