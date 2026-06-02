/**
 * レイヤー合成レンダラー
 * dst（下の合成結果）に src（レイヤー）を blend mode + opacity で重ねて target に書く
 */

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'add';

export const BLEND_MODES: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'add'];

const MODE_INDEX: Record<BlendMode, number> = {
  normal: 0, multiply: 1, screen: 2, overlay: 3, add: 4,
};

export class BlendRenderer {
  private device: GPUDevice;
  private sampler: GPUSampler;
  private uniformBuffer: GPUBuffer;
  private pipeline: GPURenderPipeline | null = null;
  private layout: GPUBindGroupLayout | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
    this.sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
    this.uniformBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  async init(format: GPUTextureFormat): Promise<void> {
    const res = await fetch('shaders/blend.wgsl');
    if (!res.ok) throw new Error('Failed to load blend.wgsl');
    const module = this.device.createShaderModule({ code: await res.text() });

    this.layout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-strip' },
    });
  }

  /**
   * dst に src を合成して target に書き込む（target は dst/src と別テクスチャである必要あり）
   */
  blend(dst: GPUTexture, src: GPUTexture, target: GPUTexture, mode: BlendMode, opacity: number): void {
    const u = new ArrayBuffer(16);
    new Uint32Array(u)[0] = MODE_INDEX[mode];
    new Float32Array(u)[1] = opacity;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
    });
    const bindGroup = this.device.createBindGroup({
      layout: this.layout!,
      entries: [
        { binding: 0, resource: dst.createView() },
        { binding: 1, resource: src.createView() },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: { buffer: this.uniformBuffer } },
      ],
    });
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}
