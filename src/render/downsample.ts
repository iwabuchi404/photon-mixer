/**
 * ダウンサンプルレンダラー
 * 4x 解像度テクスチャを 1x 解像度にダウンサンプルする (Compute Shader)
 */

export class DownsampleRenderer {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  async init(): Promise<void> {
    const response = await fetch('shaders/downsample.wgsl');
    if (!response.ok) throw new Error('Failed to load downsample.wgsl');
    const module = this.device.createShaderModule({ code: await response.text() });

    this.pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
  }

  /**
   * 4x テクスチャを 1x テクスチャにダウンサンプル
   */
  downsample(src4x: GPUTexture, dst1x: GPUTexture): void {
    if (!this.pipeline) throw new Error('DownsampleRenderer not initialized');

    const encoder = this.device.createCommandEncoder();
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: src4x.createView() },
        { binding: 1, resource: dst1x.createView() },
      ],
    });

    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    
    // ワークグループサイズの計算 (8x8)
    const workgroupCountX = Math.ceil(dst1x.width / 8);
    const workgroupCountY = Math.ceil(dst1x.height / 8);
    pass.dispatchWorkgroups(workgroupCountX, workgroupCountY);
    pass.end();

    this.device.queue.submit([encoder.finish()]);
  }
}
