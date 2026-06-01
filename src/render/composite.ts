/**
 * テクスチャ合成レンダラー
 * プリマルチプライドαテクスチャをフルスクリーン四角形で描画・合成する
 */

export class CompositeRenderer {
  private device: GPUDevice;
  private sampler: GPUSampler;
  // 中間テクスチャへのベイク用（rgba8unorm）
  private bakePipeline: GPURenderPipeline | null = null;
  // 画面への表示用（canvasフォーマット）
  private displayPipeline: GPURenderPipeline | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  async init(canvasFormat: GPUTextureFormat): Promise<void> {
    const response = await fetch('shaders/composite.wgsl');
    if (!response.ok) throw new Error('Failed to load composite.wgsl');
    const module = this.device.createShaderModule({ code: await response.text() });

    // プリマルチプライドαの over 合成
    const blendState: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };

    const makePipeline = (format: GPUTextureFormat): GPURenderPipeline =>
      this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format, blend: blendState }] },
        primitive: { topology: 'triangle-strip' },
      });

    this.bakePipeline = makePipeline('rgba8unorm');
    this.displayPipeline = makePipeline(canvasFormat);
  }

  /**
   * テクスチャをレンダーパスに描画
   * @param bake true のとき rgba8unorm ターゲット（committed への書き込み用）
   */
  draw(pass: GPURenderPassEncoder, texture: GPUTexture, bake = false): void {
    const pipeline = bake ? this.bakePipeline! : this.displayPipeline!;
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: this.sampler },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4);
  }

  /**
   * src テクスチャを dst テクスチャに over 合成（ストロークのベイク用）
   */
  bake(src: GPUTexture, dst: GPUTexture): void {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: dst.createView(),
        loadOp: 'load',   // 既存の内容の上に合成
        storeOp: 'store',
      }],
    });
    this.draw(pass, src, true);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}
