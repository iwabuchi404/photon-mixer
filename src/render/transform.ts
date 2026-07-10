/**
 * 変形レンダラー（拡大縮小・回転）
 * 逆変換行列を使い、dst テクスチャ座標 → src テクスチャ座標 をマッピングして描画する。
 */

export class TransformRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer;
  private sampler: GPUSampler;
  private readonly shaderPath: string;

  constructor(device: GPUDevice, shaderPath = 'dist/shaders/transform.wgsl') {
    this.device = device;
    // uniform: array<vec4f,3>(48) + 4 floats(16) = 64 bytes
    this.uniformBuffer = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.shaderPath = shaderPath;
  }

  async init(format: GPUTextureFormat): Promise<void> {
    const res = await fetch(this.shaderPath);
    const code = await res.text();
    const module = this.device.createShaderModule({ code });
    const bgl = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: { module, entryPoint: 'vs_main' },
      fragment: {
        module, entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  /**
   * 変形を適用して dstTex に書き込む。
   * invMatrix: row-major 3x3 を array<vec4f,3> 形式（12 floats）で渡す。
   *   [r00,r01,r02,0, r10,r11,r12,0, r20,r21,r22,0]
   */
  render(
    srcTex: GPUTexture,
    baseTex: GPUTexture,
    dstTex: GPUTexture,
    invMatrix: Float32Array,
    srcW: number, srcH: number,
    dstW: number, dstH: number,
  ): void {
    if (!this.pipeline) return;

    const buf = new Float32Array(16);
    buf.set(invMatrix, 0);    // inv_m（12 floats）
    buf[12] = srcW; buf[13] = srcH;
    buf[14] = dstW; buf[15] = dstH;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, buf);

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: srcTex.createView() },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: baseTex.createView() },
        { binding: 4, resource: this.sampler },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: dstTex.createView(),
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    this.uniformBuffer.destroy();
  }
}
