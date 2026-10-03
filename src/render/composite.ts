/**
 * テクスチャ合成レンダラー
 */

export class CompositeRenderer {
  private device: GPUDevice;
  private sampler: GPUSampler;
  private uniformBuffer: GPUBuffer;
  /** 診断用の独立した uniform。製品描画と共有しない（描画ループと競合させないため） */
  private probeUniformBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  
  private bakePipeline: GPURenderPipeline | null = null;
  private eraseBakePipeline: GPURenderPipeline | null = null;
  private maxBakePipeline: GPURenderPipeline | null = null;
  private displayPipeline: GPURenderPipeline | null = null;
  private eraseDisplayPipeline: GPURenderPipeline | null = null;
  private paperPipeline: GPURenderPipeline | null = null;
  /** 診断用: 同一 identity マッピングで fs_display を 1 パス実行する（GPU/CPU パリティ検証） */
  private probePipeline: GPURenderPipeline | null = null;
  private canvasFormat: GPUTextureFormat = 'rgba8unorm';
  
  private dummyTexture: GPUTexture;

  constructor(device: GPUDevice) {
    this.device = device;
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    // scale, offsetX, offsetY, rotation, cw, ch, sw, sh, flip, exposure, tonemap, mode, hdr + pad (16 floats = 64 bytes)
    this.uniformBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.probeUniformBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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
    const response = await fetch('dist/shaders/composite.wgsl');
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
    this.maxBakePipeline = make('rgba16float', 'vs_bake', 'fs_main', {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
    });
    this.displayPipeline = make(canvasFormat, 'vs_display', 'fs_display', overBlend);
    this.eraseDisplayPipeline = make(canvasFormat, 'vs_display', 'fs_display', eraseBlend);
    this.paperPipeline = make(canvasFormat, 'vs_display', 'fs_paper');
    this.probePipeline = make(canvasFormat, 'vs_bake', 'fs_display');
    this.canvasFormat = canvasFormat;
  }

  // 表示変換パラメータ（露出=2^EV, tonemap enum, display mode enum, hdr出力フラグ）
  private dispExposure = 1;
  private dispTonemap = 0;
  private dispMode = 0;
  private dispHdr = 0;

  updateViewport(scale: number, offsetX: number, offsetY: number, rotation: number, cw: number, ch: number, sw: number, sh: number, flip = 1): void {
    const data = new Float32Array([
      scale, offsetX, offsetY, rotation, cw, ch, sw, sh, flip,
      this.dispExposure, this.dispTonemap, this.dispMode, this.dispHdr,
      0, 0, 0,
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  /** 表示変換パラメータを更新（uniform 末尾4要素のみ書き換え） */
  setDisplayParams(exposure: number, tonemap: number, mode: number): void {
    this.dispExposure = exposure;
    this.dispTonemap = tonemap;
    this.dispMode = mode;
    // 先頭から 9 floats(=36 bytes) 目以降に書き込む
    this.device.queue.writeBuffer(this.uniformBuffer, 9 * 4, new Float32Array([exposure, tonemap, mode, this.dispHdr]));
  }

  /** HDR出力（extended canvas）の有効/無効。有効時はトーンマップを介さず光量直通。 */
  setHdrOutput(enabled: boolean): void {
    this.dispHdr = enabled ? 1 : 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 12 * 4, new Float32Array([this.dispHdr]));
  }

  /** probeDisplay が使う pixel バイト数（1px あたり） */
  get probeBytesPerPixel(): number {
    return this.canvasFormat === 'rgba16float' ? 8 : 4;
  }

  /** probeDisplay のターゲットフォーマット（BGRA 系はチャンネル順の読み替えが必要） */
  get probeFormat(): GPUTextureFormat {
    return this.canvasFormat;
  }

  /**
   * 診断用: `fs_display` を指定した表示パラメータで 1 パス実行し、結果を読み戻す。
   *
   * `vs_bake`（テクスチャ全面を identity で覆う）を使うため、ビューポート変換の
   * 影響を受けずに fs_display の分岐だけを検証できる。CPU twin は
   * `src/color/display.ts` の `displayTransform`。HDR の GPU/CPU パリティテスト
   * （scripts/verify-hdr.mjs）の土台。
   *
   * 戻り値は canvasFormat 依存の生バイト列。8bit フォーマットなら 0..255 に量子化されている。
   */
  async probeDisplay(
    src: GPUTexture,
    width: number,
    height: number,
    params: { exposure: number; tonemap: number; mode: number; hdr: number },
  ): Promise<Uint8Array> {
    if (!this.probePipeline) throw new Error('CompositeRenderer not initialized');

    // 製品描画と共有しない独立 uniform に書き込む。共有すると rAF の
    // updateViewport/setDisplayParams と競合し、検証値が上書きされる。
    const data = new Float32Array(16);
    data[9] = params.exposure;
    data[10] = params.tonemap;
    data[11] = params.mode;
    data[12] = params.hdr;
    this.device.queue.writeBuffer(this.probeUniformBuffer, 0, data);

    const target = this.device.createTexture({
      size: [width, height],
      format: this.canvasFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const bpp = this.probeBytesPerPixel;
    const bytesPerRow = Math.ceil(width * bpp / 256) * 256;
    const staging = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(this.probePipeline);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.probeUniformBuffer } },
      ],
    }));
    pass.draw(4);
    pass.end();
    encoder.copyTextureToBuffer({ texture: target }, { buffer: staging, bytesPerRow }, [width, height]);
    this.device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const out = new Uint8Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    target.destroy();
    return out;
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

  /** 一筆内の分割チャンクを、濃度を重ねず channel-wise max で累積する。 */
  mergeMax(src: GPUTexture, dst: GPUTexture): void {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: dst.createView(), loadOp: 'load', storeOp: 'store' }],
    });
    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });
    pass.setPipeline(this.maxBakePipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}
