/**
 * テクスチャ合成レンダラー
 */

export class CompositeRenderer {
  private device: GPUDevice;
  private sampler: GPUSampler;
  private uniformBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  
  private bakePipeline: GPURenderPipeline | null = null;
  private eraseBakePipeline: GPURenderPipeline | null = null;
  private displayPipeline: GPURenderPipeline | null = null;
  private eraseDisplayPipeline: GPURenderPipeline | null = null;
  private paperPipeline: GPURenderPipeline | null = null;
  
  private dummyTexture: GPUTexture;

  constructor(device: GPUDevice) {
    this.device = device;
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    // scale, offsetX, offsetY, rotation, cw, ch, sw, sh, flip + pad (12 floats = 48 bytes)
    this.uniformBuffer = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.dummyTexture = this.device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
  }

  async init(canvasFormat: GPUTextureFormat): Promise<void> {
    const response = await fetch('shaders/composite.wgsl');
    if (!response.ok) throw new Error('Failed to load composite.wgsl');
    const module = this.device.createShaderModule({ code: await response.text() });

    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });

    // 通常合成 (Over blend)
    const overBlend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };

    // 消しゴム合成 (Erase blend)
    // 描画先のアルファを削る: dst = dst * (1 - src_alpha)
    const eraseBlend: GPUBlendState = {
      color: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };

    const make = (format: GPUTextureFormat, vs: string, fs: string, blend?: GPUBlendState) =>
      this.device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: vs },
        fragment: { module, entryPoint: fs, targets: [{ format, blend }] },
        primitive: { topology: 'triangle-strip' },
      });

    this.bakePipeline = make('rgba16float', 'vs_bake', 'fs_main', overBlend);
    this.eraseBakePipeline = make('rgba16float', 'vs_bake', 'fs_main', eraseBlend);
    this.displayPipeline = make(canvasFormat, 'vs_display', 'fs_display', overBlend);
    this.eraseDisplayPipeline = make(canvasFormat, 'vs_display', 'fs_display', eraseBlend);
    this.paperPipeline = make(canvasFormat, 'vs_display', 'fs_paper'); 
  }

  updateViewport(scale: number, offsetX: number, offsetY: number, rotation: number, cw: number, ch: number, sw: number, sh: number, flip = 1): void {
    const data = new Float32Array([scale, offsetX, offsetY, rotation, cw, ch, sw, sh, flip, 0, 0, 0]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  draw(pass: GPURenderPassEncoder, texture: GPUTexture, eraseMode = false): void {
    const pipeline = eraseMode ? this.eraseDisplayPipeline! : this.displayPipeline!;
    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4);
  }

  drawPaper(pass: GPURenderPassEncoder): void {
    if (!this.paperPipeline) return;
    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.dummyTexture.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });
    pass.setPipeline(this.paperPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4);
  }

  bake(src: GPUTexture, dst: GPUTexture, eraseMode = false): void {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: dst.createView(), loadOp: 'load', storeOp: 'store' }],
    });
    const pipeline = eraseMode ? this.eraseBakePipeline! : this.bakePipeline!;
    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}
