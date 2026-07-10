/**
 * フィルターレンダラー（オフスクリーン処理）
 * committed のコピー（src）を入力に、ガウシアンぼかし / グローを適用して dst に書き込む。
 * 選択マスクがあればその範囲のみ反映する（マスク外は original のまま）。
 */

const FORMAT: GPUTextureFormat = 'rgba16float';

export type FilterType = 'blur' | 'glow' | 'sharpen' | 'exposure' | 'levels' | 'curve';
export interface FilterParams {
  radius: number;     // ぼかし/グロー/シャープ半径(px)
  threshold: number;  // グロー抽出しきい値（リニア）
  intensity: number;  // グロー/シャープ強度
  ev: number;         // 露出調整(ストップ)
  inLow: number;      // レベル: 入力黒
  inHigh: number;     // レベル: 入力白
  gamma: number;      // レベル: ガンマ
  outLow: number;     // レベル: 出力黒
  outHigh: number;    // レベル: 出力白
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
  private curveLut: GPUTexture | null = null; // トーンカーブ LUT（256×1, rgba8unorm）
  private w = 0;
  private h = 0;

  constructor(device: GPUDevice) {
    this.device = device;
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.uniformBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.dummy = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
  }

  async init(width: number, height: number): Promise<void> {
    const res = await fetch('dist/shaders/filter.wgsl');
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
      sharpen: make('fs_sharpen'),
      exposure: make('fs_exposure'),
      levels: make('fs_levels'),
      curve: make('fs_curve'),
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

  /** トーンカーブ LUT（256×4 バイト）を設定 */
  setCurveLut(data: Uint8Array): void {
    if (!this.curveLut) {
      this.curveLut = this.device.createTexture({
        size: [256, 1], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    }
    this.device.queue.writeTexture({ texture: this.curveLut }, data as unknown as BufferSource, { bytesPerRow: 256 * 4 }, [256, 1]);
  }

  /** uniform を構築（WGSL FilterU と同順） */
  private uni(o: {
    dirX?: number; dirY?: number; radius?: number; threshold?: number; intensity?: number;
    useMask?: number; ev?: number; levels?: FilterParams; strength?: number;
  }): number[] {
    const l = o.levels;
    return [
      1 / this.w, 1 / this.h,
      o.dirX ?? 0, o.dirY ?? 0,
      o.radius ?? 0, o.threshold ?? 0, o.intensity ?? 0, o.useMask ?? 0,
      o.ev ?? 0,
      l?.inLow ?? 0, l?.inHigh ?? 1, l?.gamma ?? 1, l?.outLow ?? 0, l?.outHigh ?? 1,
      o.strength ?? 1, 0,
    ];
  }

  /**
   * フィルターを適用。src（原本）から計算し、選択マスクで合成して dst に書く。
   * src と dst は別テクスチャであること。
   */
  apply(type: FilterType, params: FilterParams, src: GPUTexture, mask: GPUTexture | null, dst: GPUTexture, strength = 1): void {
    const r = params.radius;
    const useMask = mask ? 1 : 0;

    let filtered: GPUTexture;
    if (type === 'blur') {
      this.pass('blur', this.tmpA, src, null, null, this.uni({ dirX: 1, radius: r }));
      this.pass('blur', this.tmpB, this.tmpA, null, null, this.uni({ dirY: 1, radius: r }));
      filtered = this.tmpB;
    } else if (type === 'glow') {
      this.pass('threshold', this.tmpA, src, null, null, this.uni({ threshold: params.threshold }));
      this.pass('blur', this.tmpB, this.tmpA, null, null, this.uni({ dirX: 1, radius: r }));
      this.pass('blur', this.tmpA, this.tmpB, null, null, this.uni({ dirY: 1, radius: r }));
      this.pass('addGlow', this.tmpB, src, this.tmpA, null, this.uni({ intensity: params.intensity }));
      filtered = this.tmpB;
    } else if (type === 'sharpen') {
      this.pass('blur', this.tmpA, src, null, null, this.uni({ dirX: 1, radius: r }));
      this.pass('blur', this.tmpB, this.tmpA, null, null, this.uni({ dirY: 1, radius: r }));
      this.pass('sharpen', this.tmpA, src, this.tmpB, null, this.uni({ intensity: params.intensity }));
      filtered = this.tmpA;
    } else if (type === 'exposure') {
      this.pass('exposure', this.tmpA, src, null, null, this.uni({ ev: params.ev }));
      filtered = this.tmpA;
    } else if (type === 'levels') {
      this.pass('levels', this.tmpA, src, null, null, this.uni({ levels: params }));
      filtered = this.tmpA;
    } else {
      // curve（LUT は setCurveLut 済み前提。未設定なら dummy で恒等にならないため src そのまま）
      this.pass('curve', this.tmpA, src, this.curveLut ?? this.dummy, null, this.uni({}));
      filtered = this.tmpA;
    }
    // 選択マスクと効果不透明度で original と合成して dst へ
    this.pass('maskComposite', dst, filtered, src, mask, this.uni({ useMask, strength }));
  }

  dispose(): void {
    this.uniformBuffer.destroy();
    this.dummy.destroy();
    this.tmpA?.destroy();
    this.tmpB?.destroy();
    this.curveLut?.destroy();
  }
}
