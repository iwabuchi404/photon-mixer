/**
 * リボンブラシ描画モジュール（メインブラシ用）
 *
 * スタンプ連打ではなく中心線リボンを1ドローで描く。
 * over ブレンド（プリマルチプライド）で isolated へ直接描画するため、
 * 4x bbox + downsample + max 合成パスを通らない。
 */

import type { StrokePoint } from '../pen/stroke.js';
import type { BrushMixMode } from './brush.js';

export interface RibbonConfig {
  color: { r: number; g: number; b: number; a: number };
  usePointColor: boolean;
  alphaLock: boolean;
  pressureOpacity: boolean;
  wetRatio: number;
  mixMode: BrushMixMode;
}

const DEFAULT_RIBBON_CONFIG: RibbonConfig = {
  color: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
  usePointColor: false,
  alphaLock: false,
  pressureOpacity: false,
  wetRatio: 0.0,
  mixMode: 'progressive',
};

export class RibbonRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer;
  private pointBuffer: GPUBuffer;
  private sampler: GPUSampler;
  private selectionSampler: GPUSampler;
  private bindGroup: GPUBindGroup | null = null;
  private bindGroupDirty = true;
  private config: RibbonConfig;
  private shaderPath: string;
  private canvasSize = { width: 0, height: 0 };
  private dummyTexture: GPUTexture;
  private selectionTexture: GPUTexture | null = null;
  private lastCommittedTexture: GPUTexture | null = null;

  private readonly maxPoints = 500000;
  private pointCapacity = this.maxPoints * RIBBON_VERT_BYTES;

  constructor(device: GPUDevice, config: Partial<RibbonConfig> = {}, shaderPath = 'dist/shaders/ribbon.wgsl') {
    this.device = device;
    this.config = { ...DEFAULT_RIBBON_CONFIG, ...config };
    this.shaderPath = shaderPath;

    this.uniformBuffer = device.createBuffer({
      size: 64, // canvas(2) + pad(2) + color(4) + flags(4) + wet(1) + gpu_mix(1) + pad(2) = 16 floats
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.pointBuffer = device.createBuffer({
      size: this.maxPoints * RIBBON_VERT_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.selectionSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.dummyTexture = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const white = new Uint8Array([255, 255, 255, 255]);
    device.queue.writeTexture({ texture: this.dummyTexture }, white, { bytesPerRow: 4 }, [1, 1]);
  }

  async init(canvasWidth: number, canvasHeight: number, format: GPUTextureFormat = 'rgba16float'): Promise<void> {
    this.canvasSize = { width: canvasWidth, height: canvasHeight };
    const response = await fetch(this.shaderPath);
    if (!response.ok) throw new Error(`Failed to load shader: ${this.shaderPath}`);
    const shaderModule = this.device.createShaderModule({ code: await response.text() });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: 'vertex_main' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fragment_main',
        targets: [{
          format,
          // スタンプと同様 max 合成: 一筆内の重なり（折り返し・チャンク境界）で濃くならない。
          // isolated は一筆ごとにクリアされるため、筆全体の committed への合成は bake 時の over 1回のみ。
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.updateUniforms();
    this.bindGroupDirty = true;
  }

  private updateUniforms(): void {
    // WGSL レイアウトに一致させる:
    // canvas(0-8) + pad(8-16) + color(16-32) + flags(32-48) + wet/gpu_mix(48-64)
    const buf = new ArrayBuffer(64);
    const f32 = new Float32Array(buf);
    const u32 = new Uint32Array(buf);
    f32[0] = this.canvasSize.width;
    f32[1] = this.canvasSize.height;
    f32[2] = 0; // _pad0
    f32[3] = 0; // _pad1
    f32[4] = this.config.color.r;
    f32[5] = this.config.color.g;
    f32[6] = this.config.color.b;
    f32[7] = this.config.color.a;
    u32[8] = this.config.usePointColor ? 1 : 0;
    u32[9] = this.config.alphaLock ? 1 : 0;
    u32[10] = this.selectionTexture ? 1 : 0;
    u32[11] = this.config.pressureOpacity ? 1 : 0;
    f32[12] = this.config.wetRatio;
    u32[13] = this.config.mixMode === 'stamp' ? 1 : 0;
    u32[14] = 0; // _pad2
    u32[15] = 0; // _pad3
    this.device.queue.writeBuffer(this.uniformBuffer, 0, buf);
  }

  /** isolated へ直接描く（呼び出し側で render pass を開く） */
  renderStroke(
    renderPass: GPURenderPassEncoder,
    points: StrokePoint[],
    committedTexture: GPUTexture,
  ): void {
    if (points.length === 0 || !this.pipeline) return;

    const { data, vertCount } = tessellateRibbon(points, this.config.color);
    if (vertCount === 0) return;
    // 長い一筆で容量を超えたらバッファを拡張する（bindGroup は作り直し）
    const needBytes = vertCount * RIBBON_VERT_BYTES;
    if (needBytes > this.pointCapacity) {
      while (this.pointCapacity < needBytes) this.pointCapacity *= 2;
      this.pointBuffer.destroy();
      this.pointBuffer = this.device.createBuffer({
        size: this.pointCapacity,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.bindGroupDirty = true;
    }
    this.device.queue.writeBuffer(this.pointBuffer, 0, data);

    if (this.bindGroupDirty || !this.bindGroup || this.lastCommittedTexture !== committedTexture) {
      this.bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: this.pointBuffer } },
          { binding: 2, resource: committedTexture.createView() },
          { binding: 3, resource: this.sampler },
          { binding: 4, resource: (this.selectionTexture ?? this.dummyTexture).createView() },
          { binding: 5, resource: this.selectionSampler },
        ],
      });
      this.bindGroupDirty = false;
      this.lastCommittedTexture = committedTexture;
    }

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    renderPass.draw(vertCount);
  }

  updateConfig(config: Partial<RibbonConfig>): void {
    this.config = { ...this.config, ...config };
    this.updateUniforms();
  }

  getConfig(): RibbonConfig {
    return { ...this.config, color: { ...this.config.color } };
  }

  setSelectionTexture(tex: GPUTexture | null): void {
    this.selectionTexture = tex;
    this.bindGroupDirty = true;
    this.updateUniforms();
  }

  resize(canvasWidth: number, canvasHeight: number): void {
    this.canvasSize = { width: canvasWidth, height: canvasHeight };
    this.updateUniforms();
    this.bindGroupDirty = true;
  }

  dispose(): void {
    this.uniformBuffer.destroy();
    this.pointBuffer.destroy();
    this.dummyTexture.destroy();
  }
}

// ─── CPU テッセレーション ──────────────────────────────────────────────
// 中心線リボンを triangle list へ展開する。結合はベベル＋外側ラウンドファン、
// 端は丸キャップ。平均法線ストリップと違い、密な点列の急旋回でもスパイクや
// 塊が出ない（全頂点は脊柱から筆半径以内の距離に収まる）。

/** 1頂点のバイト数: pos(2) + misc(across, pressure)(2) + color(4) */
export const RIBBON_VERT_BYTES = 8 * 4;

interface SpineSample {
  x: number; y: number; w: number; pressure: number;
  color: { r: number; g: number; b: number; a: number };
}

export interface TessellatedStroke {
  data: Float32Array<ArrayBuffer>;
  vertCount: number;
}

const RIBBON_CAP_SEGS = 6;
const RIBBON_JOIN_STEP = Math.PI / 10; // ファン1分割あたり18°

/**
 * 正確サイズ確保済みバッファへの書き込み器。
 * 中間配列を介さない（頂点1つ: x, y, across, pressure, r, g, b, a）。
 */
class TessWriter {
  private o = 0;
  constructor(private readonly data: Float32Array) {}

  /** 頂点数 */
  get count(): number { return this.o / 8; }

  v(x: number, y: number, across: number, s: SpineSample): void {
    const d = this.data, o = this.o;
    d[o] = x; d[o + 1] = y; d[o + 2] = across; d[o + 3] = s.pressure;
    d[o + 4] = s.color.r; d[o + 5] = s.color.g; d[o + 6] = s.color.b; d[o + 7] = s.color.a;
    this.o = o + 8;
  }

  /** 扇（中心 across=0、弧 across=±1）。a0 から sweep 方向へ segs 分割 */
  fan(
    cx: number, cy: number, w: number,
    a0: number, sweep: number, segs: number,
    s: SpineSample, lnx: number, lny: number,
  ): void {
    for (let i = 0; i < segs; i++) {
      const t0 = a0 + sweep * (i / segs);
      const t1 = a0 + sweep * ((i + 1) / segs);
      const d0x = Math.cos(t0), d0y = Math.sin(t0);
      const d1x = Math.cos(t1), d1y = Math.sin(t1);
      this.v(cx, cy, 0, s);
      this.v(cx + d0x * w, cy + d0y * w, d0x * lnx + d0y * lny >= 0 ? -1 : 1, s);
      this.v(cx + d1x * w, cy + d1y * w, d1x * lnx + d1y * lny >= 0 ? -1 : 1, s);
    }
  }
}

/**
 * ストローク点列をリボンメッシュへ変換する（純粋関数・単体テスト対象）。
 * size は半径として扱う（brush.wgsl と同じ定義）。
 */
export function tessellateRibbon(
  points: StrokePoint[],
  fallbackColor: { r: number; g: number; b: number; a: number },
): TessellatedStroke {
  // 脊柱の整理（完全重複のみ除去。終端属性は最新を優先）
  const spine: SpineSample[] = [];
  for (const p of points) {
    const last = spine[spine.length - 1];
    if (last && (p.x - last.x) ** 2 + (p.y - last.y) ** 2 < 1e-12) {
      last.pressure = p.pressure;
      if (p.color) last.color = p.color;
      continue;
    }
    spine.push({
      x: p.x, y: p.y,
      w: Math.max(p.size, 0.001),
      pressure: p.pressure,
      color: p.color ?? fallbackColor,
    });
  }

  if (spine.length === 0) return { data: new Float32Array(0), vertCount: 0 };

  // 単点は円盤（クリックのドット用）
  if (spine.length === 1) {
    const s = spine[0];
    const segs = RIBBON_CAP_SEGS * 2;
    const data = new Float32Array(segs * 3 * 8);
    const w = new TessWriter(data);
    w.fan(s.x, s.y, s.w, 0, Math.PI * 2, segs, s, 0, 1);
    return { data, vertCount: segs * 3 };
  }

  const n = spine.length;
  // 区間方向（正規化。退化時は前区間か水平を使う）
  const dirx = new Float64Array(n - 1), diry = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dx = spine[i + 1].x - spine[i].x;
    const dy = spine[i + 1].y - spine[i].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) {
      dirx[i] = i > 0 ? dirx[i - 1] : 1;
      diry[i] = i > 0 ? diry[i - 1] : 0;
    } else {
      dirx[i] = dx / len; diry[i] = dy / len;
    }
  }
  // 各柱点の平均方向と左右オフセット（ベベル結合＝ pinch なし・飛び出しなし）
  const lxx = new Float64Array(n), lyy = new Float64Array(n);
  const rxx = new Float64Array(n), ryy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const i0 = i > 0 ? i - 1 : 0;
    const i1 = i < n - 1 ? i : n - 2;
    let ax = dirx[i0] + dirx[i1], ay = diry[i0] + diry[i1];
    if (ax * ax + ay * ay < 1e-6) {
      // 180°折り返し: 入力方向の左法線を枠にする
      ax = -diry[i0]; ay = dirx[i0];
    } else {
      const al = Math.sqrt(ax * ax + ay * ay);
      // 平均「方向」の左法線（= 両区間法線の平均と同等）
      const dx = ax / al, dy = ay / al;
      ax = -dy; ay = dx;
    }
    const s = spine[i];
    lxx[i] = s.x + ax * s.w; lyy[i] = s.y + ay * s.w;
    rxx[i] = s.x - ax * s.w; ryy[i] = s.y - ay * s.w;
  }

  // 結合ファンの分割数を先に数えて正確サイズを1回確保する
  const jSegs = new Int16Array(n); // 0=直線（ファンなし）
  const jA0 = new Float64Array(n);
  const jSweep = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const d0x = dirx[i - 1], d0y = diry[i - 1];
    const cross = d0x * diry[i] - d0y * dirx[i];
    const dot = Math.max(-1, Math.min(1, d0x * dirx[i] + d0y * diry[i]));
    const theta = Math.atan2(Math.abs(cross), dot);
    if (theta < 0.02) continue;
    jSegs[i] = Math.max(1, Math.ceil(theta / RIBBON_JOIN_STEP));
    if (cross > 0) {
      // 左旋回: 外側は右。右法線角から CCW へ theta
      jA0[i] = Math.atan2(d0y, d0x) - Math.PI / 2;
      jSweep[i] = theta;
    } else {
      // 右旋回（180°含む）: 外側は左。左法線角から CW へ theta
      jA0[i] = Math.atan2(d0y, d0x) + Math.PI / 2;
      jSweep[i] = -theta;
    }
  }
  let joinVerts = 0;
  for (let i = 1; i < n - 1; i++) joinVerts += jSegs[i] * 3;
  const vertCount = (n - 1) * 6 + joinVerts + RIBBON_CAP_SEGS * 3 * 2;
  const data = new Float32Array(vertCount * 8);
  const w = new TessWriter(data);

  // 区間クアッド（L=-1, R=+1）
  for (let i = 0; i < n - 1; i++) {
    const a = spine[i], b = spine[i + 1];
    w.v(lxx[i], lyy[i], -1, a);
    w.v(rxx[i], ryy[i], +1, a);
    w.v(lxx[i + 1], lyy[i + 1], -1, b);
    w.v(rxx[i], ryy[i], +1, a);
    w.v(rxx[i + 1], ryy[i + 1], +1, b);
    w.v(lxx[i + 1], lyy[i + 1], -1, b);
  }

  // 結合の外側ラウンドファン（旋回角ぶんだけ。直線はスキップ）
  for (let i = 1; i < n - 1; i++) {
    if (jSegs[i] === 0) continue;
    const s = spine[i];
    const d0x = dirx[i - 1], d0y = diry[i - 1];
    w.fan(s.x, s.y, s.w, jA0[i], jSweep[i], jSegs[i], s, -d0y, d0x);
  }

  // 丸キャップ（始点: 左法線角から CCW で半周／終点: 右法線角から CCW で半周）
  {
    const s0 = spine[0];
    const lnx = -diry[0], lny = dirx[0];
    w.fan(s0.x, s0.y, s0.w, Math.atan2(lny, lnx), Math.PI, RIBBON_CAP_SEGS, s0, lnx, lny);
    const s1 = spine[n - 1];
    const rnx = diry[n - 2], rny = -dirx[n - 2];
    w.fan(s1.x, s1.y, s1.w, Math.atan2(rny, rnx), Math.PI, RIBBON_CAP_SEGS, s1, -diry[n - 2], dirx[n - 2]);
  }

  return { data, vertCount };
}
