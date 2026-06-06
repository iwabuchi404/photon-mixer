/**
 * フィルターレンダラー（オフスクリーン処理）
 * committed のコピー（src）を入力に、ガウシアンぼかし / グローを適用して dst に書き込む。
 * 選択マスクがあればその範囲のみ反映する（マスク外は original のまま）。
 */

const FORMAT: GPUTextureFormat = 'rgba16float';

export type FilterType = 'blur' | 'glow';
export interface FilterParams {
  radius: number;     // ぼかし半径(px)
  threshold: number;  // グロー抽出しきい値（リニア）
  intensity: number;  // グロー強度
}

export class FilterRenderer {
  private device: GPUDevice;
  private sampler: GPUSampler;
  private uniformBuffer: GPUBuffer;
  private layout: GPUBindGroupLayout | null = null;
  private pipelines: Record<string, GPURenderPipeline> = {};
  private dummy: GPUTexture;

  private tmpA!: GPUTexture;
  private tmpB!: GPUTexture;
  private w = 0;
  private h = 0;

  constructor(device: GPUDevice) {
    this.device = device;
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.uniformBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.dummy = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
  }

  async init(width: number, height: number): Promise<void> {
    const res = await fetch('shaders/filter.wgsl');
    if (!res.ok) throw new Error('Failed to load filter.wgsl');
    const module = this.device.createShaderModule({ code: await res.text() });

    this.layout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const pl = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const make = (fs: string) => this.device.createRenderPipeline({
      layout: pl,
      vertex: { module, entryPoint: 'vs_fullscreen' },
      fragment: { module, entryPoint: fs, targets: [{ format: FORMAT }] },
      primitive: { topology: 'triangle-strip' },
    });
    this.pipelines = {
      blur: make('fs_blur'),
      threshold: make('fs_threshold'),
      addGlow: make('fs_add_glow'),
      maskComposite: make('fs_mask_composite'),
    };
    this.resize(width, height);
  }

  resize(width: number, height: number): void {
    if (this.w === width && this.h === height && this.tmpA) return;
    this.w = width; this.h = height;
    this.tmpA?.destroy(); this.tmpB?.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.tmpA = this.device.createTexture({ size: [width, height], format: FORMAT, usage });
    this.tmpB = this.device.createTexture({ size: [width, height], format: FORMAT, usage });
  }

  /** 1パス実行（target に描画） */
  private pass(
    entry: string, target: GPUTexture,
    t0: GPUTexture, t1: GPUTexture | null, t2: GPUTexture | null,
    uni: number[],
  ): void {
    this.device.queue.writeBuffer(this.uniformBuffer, 0, new Float32Array(uni));
    const enc = this.device.createCommandEncoder();
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view: target.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
    });
    const bind = this.device.createBindGroup({
      layout: this.layout!,
      entries: [
        { binding: 0, resource: t0.createView() },
        { binding: 1, resource: (t1 ?? this.dummy).createView() },
        { binding: 2, resource: (t2 ?? this.dummy).createView() },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: { buffer: this.uniformBuffer } },
      ],
    });
    rp.setPipeline(this.pipelines[entry]);
    rp.setBindGroup(0, bind);
    rp.draw(4);
    rp.end();
    this.device.queue.submit([enc.finish()]);
  }

  /**
   * フィルターを適用。src（原本）から計算し、選択マスクで合成して dst に書く。
   * src と dst は別テクスチャであること。
   */
  apply(type: FilterType, params: FilterParams, src: GPUTexture, mask: GPUTexture | null, dst: GPUTexture): void {
    const tx = 1 / this.w, ty = 1 / this.h;
    const r = params.radius;
    const useMask = mask ? 1 : 0;

    let filtered: GPUTexture;
    if (type === 'blur') {
      this.pass('blur', this.tmpA, src, null, null, [tx, ty, 1, 0, r, 0, 0, 0]); // 水平
      this.pass('blur', this.tmpB, this.tmpA, null, null, [tx, ty, 0, 1, r, 0, 0, 0]); // 垂直
      filtered = this.tmpB;
    } else {
      // glow: 抽出 → ぼかし → 加算
      this.pass('threshold', this.tmpA, src, null, null, [tx, ty, 0, 0, 0, params.threshold, 0, 0]);
      this.pass('blur', this.tmpB, this.tmpA, null, null, [tx, ty, 1, 0, r, 0, 0, 0]);
      this.pass('blur', this.tmpA, this.tmpB, null, null, [tx, ty, 0, 1, r, 0, 0, 0]);
      this.pass('addGlow', this.tmpB, src, this.tmpA, null, [tx, ty, 0, 0, 0, 0, params.intensity, 0]);
      filtered = this.tmpB;
    }
    // 選択マスクで original と合成して dst へ
    this.pass('maskComposite', dst, filtered, src, mask, [tx, ty, 0, 0, 0, 0, 0, useMask]);
  }

  dispose(): void {
    this.uniformBuffer.destroy();
    this.dummy.destroy();
    this.tmpA?.destroy();
    this.tmpB?.destroy();
  }
}
