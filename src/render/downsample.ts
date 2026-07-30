/**
 * ダウンサンプルレンダラー
 * 4x 解像度テクスチャを 1x 解像度にダウンサンプルする (Compute Shader)
 *
 * 仕様（docs/spec.md）: 4x サブピクセルバッファは「ブラシ範囲のみ」。
 * src はブラシ bbox の 4x テクスチャ、dst はキャンバス全体の isolatedTexture。
 * dst_offset で bbox 原点（1x キャンバス座標）を指定し、対応領域のみ書き込む。
 */

export class DownsampleRenderer {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline | null = null;
  private uniformBuffer: GPUBuffer;

  constructor(device: GPUDevice) {
    this.device = device;
    this.uniformBuffer = device.createBuffer({
      size: 16, // u32 x4 (dst_offset_x, dst_offset_y, pad, pad)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  async init(): Promise<void> {
    const response = await fetch('dist/shaders/downsample.wgsl');
    if (!response.ok) throw new Error('Failed to load downsample.wgsl');
    const module = this.device.createShaderModule({ code: await response.text() });

    this.pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
  }

  /**
   * 4x テクスチャを 1x テクスチャの指定オフセット位置にダウンサンプル
   * @param src4x ブラシ bbox の 4x テクスチャ（サイズ = bbox1x * 4）
   * @param dst1x キャンバス全体の 1x 書き込み先テクスチャ
   * @param dstOffsetX bbox 原点の 1x キャンバス X 座標
   * @param dstOffsetY bbox 原点の 1x キャンバス Y 座標
   */
  downsample(src4x: GPUTexture, dst1x: GPUTexture, dstOffsetX: number, dstOffsetY: number): void {
    if (!this.pipeline) throw new Error('DownsampleRenderer not initialized');

    // bbox 1x サイズ = src4x サイズ / 4
    const bboxW = Math.max(1, Math.floor(src4x.width / 4));
    const bboxH = Math.max(1, Math.floor(src4x.height / 4));

    const u = new ArrayBuffer(16);
    const u32 = new Uint32Array(u);
    u32[0] = Math.floor(dstOffsetX);
    u32[1] = Math.floor(dstOffsetY);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u);

    const encoder = this.device.createCommandEncoder();
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: src4x.createView() },
        { binding: 1, resource: dst1x.createView() },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });

    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);

    // ワークグループサイズ 8x8。dispatch は bbox 1x サイズ基準
    const workgroupCountX = Math.ceil(bboxW / 8);
    const workgroupCountY = Math.ceil(bboxH / 8);
    pass.dispatchWorkgroups(workgroupCountX, workgroupCountY);
    pass.end();

    this.device.queue.submit([encoder.finish()]);
  }
}
