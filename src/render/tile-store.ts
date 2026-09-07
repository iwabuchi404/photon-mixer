/**
 * T1: 疎タイルストア（コミット済みセルの backing store）
 *
 * 全面テクスチャの代わりに 512² タイルの疎集合でセル内容を保持する。
 * - 空タイルは確保しない（占有集合で管理）
 * - 占有は増える一方。縮小はセル削除・クリア・rebake からの再構築時のみ。
 *   （過剰保持の上限は全面1枚分＝現行コストと同等。T1b/T3 で GC 検討）
 * - RAM spill・ピン留め・参照カウントは T1b。以降のための field 予約なし
 *
 * GPU が要る操作（確保・コピー・readback）は device 経由。
 * 純粋ロジック（占有・rectToTiles・zero-skip）は単体テスト対象。
 */

import type { TileBakeRenderer } from './tile-bake.js';

export const TILE_SIZE = 512;
/** rgba16float 1タイルのバイト数 */
export const TILE_BYTES = TILE_SIZE * TILE_SIZE * 8;

export interface TileRecord {
  /** null = 退避中（mirror が正本） */
  texture: GPUTexture | null;
  /** 退避コピー（full 512² tight）。復帰後は破棄する */
  mirror: Uint16Array | null;
  cellId: string;
  index: number; // ty * tilesX + tx
  pinned: boolean;
  lastUsed: number;
}

export class TileStore {
  private readonly device: GPUDevice;
  readonly tilesX: number;
  readonly tilesY: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  /** GPU 常駐タイル数の予算（T1a は追跡のみ。強制退避は T1b） */
  readonly gpuBudgetBytes: number;

  private tiles = new Map<string, TileRecord>();
  private occupancy = new Map<string, Set<number>>();
  /** owner（セル or 履歴 `h:<cellId>`）ごとの内容世代。compose キャッシュの正当性判定用 */
  private versions = new Map<string, number>();
  /** writeTile 用の使い回しバッファ（1タイル分 tight） */
  private readonly scratchTile = new Uint16Array((TILE_SIZE * TILE_SIZE * 4) as number);
  private clock = 0;
  private maintaining = false;
  /** 退避が発生した回数（verify・診断用） */
  evictions = 0;

  constructor(
    device: GPUDevice,
    canvasWidth: number,
    canvasHeight: number,
    opts: { gpuBudgetBytes?: number } = {},
  ) {
    this.device = device;
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
    this.tilesX = Math.max(1, Math.ceil(canvasWidth / TILE_SIZE));
    this.tilesY = Math.max(1, Math.ceil(canvasHeight / TILE_SIZE));
    this.gpuBudgetBytes = opts.gpuBudgetBytes ?? 1536 * 1024 * 1024;
  }

  static key(cellId: string, index: number): string {
    return `${cellId}:${index}`;
  }

  static txOf(index: number, tilesX: number): number {
    return index % tilesX;
  }

  static tyOf(index: number, tilesX: number): number {
    return Math.floor(index / tilesX);
  }

  /** タイルのキャンバス矩形（端数タイルはクランプ） */
  tileRect(tx: number, ty: number): { x: number; y: number; w: number; h: number } {
    const x = tx * TILE_SIZE, y = ty * TILE_SIZE;
    return {
      x, y,
      w: Math.min(TILE_SIZE, this.canvasWidth - x),
      h: Math.min(TILE_SIZE, this.canvasHeight - y),
    };
  }

  /**
   * 矩形と交差するタイル index 列挙（ダーティ計算用・純粋関数の中核）。
   * キャンバス外はクリップする。
   */
  rectToTiles(x0: number, y0: number, x1: number, y1: number): number[] {
    const lx = Math.max(0, Math.min(x0, x1));
    const rx = Math.min(this.canvasWidth, Math.max(x0, x1));
    const ty0 = Math.max(0, Math.min(y0, y1));
    const by = Math.min(this.canvasHeight, Math.max(y0, y1));
    if (rx - lx <= 0 || by - ty0 <= 0) return [];
    const out: number[] = [];
    const tx0 = Math.floor(lx / TILE_SIZE), tx1 = Math.floor((rx - 1e-6) / TILE_SIZE);
    const tyA = Math.floor(ty0 / TILE_SIZE), tyB = Math.floor((by - 1e-6) / TILE_SIZE);
    for (let ty = tyA; ty <= tyB; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        out.push(ty * this.tilesX + tx);
      }
    }
    return out;
  }

  /** ピン留め owner 集合。新規タイルは生まれながらピン留めされる */
  private pinnedOwners = new Set<string>();

  /** owner のピン留め設定（アクティブセル用）。解除時は即時退避しない */
  pinOwner(owner: string, on: boolean): void {
    if (on) this.pinnedOwners.add(owner);
    else this.pinnedOwners.delete(owner);
    for (const rec of this.tiles.values()) {
      if (rec.cellId === owner) rec.pinned = on;
    }
  }

  private touch(rec: TileRecord): void {
    rec.lastUsed = ++this.clock;
  }

  /** タイル取得（なければ確保＋クリア、退避中なら復帰）。占有を更新 */
  getTile(cellId: string, tx: number, ty: number): GPUTexture {
    const index = ty * this.tilesX + tx;
    const k = TileStore.key(cellId, index);
    let rec = this.tiles.get(k);
    if (!rec) {
      const texture = this.device.createTexture({
        size: [TILE_SIZE, TILE_SIZE],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      });
      // 新規タイルは透明クリア（旧 makeLayerTexture と同等）
      const encoder = this.device.createCommandEncoder();
      encoder.beginRenderPass({
        colorAttachments: [{
          view: texture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      }).end();
      this.device.queue.submit([encoder.finish()]);
      rec = { texture, mirror: null, cellId, index, pinned: this.pinnedOwners.has(cellId), lastUsed: 0 };
      this.tiles.set(k, rec);
      let occ = this.occupancy.get(cellId);
      if (!occ) { occ = new Set(); this.occupancy.set(cellId, occ); }
      occ.add(index);
      this.bump(cellId);
    } else if (!rec.texture) {
      this.restore(rec);
    }
    this.touch(rec);
    return rec.texture!;
  }

  /** 退避タイルを GPU へ復帰（同期的・mirror 消費） */
  private restore(rec: TileRecord): void {
    const mirror = rec.mirror;
    if (!mirror) throw new Error(`Tile has no texture or mirror: ${rec.cellId}:${rec.index}`);
    const texture = this.device.createTexture({
      size: [TILE_SIZE, TILE_SIZE],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture },
      mirror as unknown as BufferSource,
      { bytesPerRow: TILE_SIZE * 8, rowsPerImage: TILE_SIZE },
      [TILE_SIZE, TILE_SIZE],
    );
    rec.texture = texture;
    rec.mirror = null; // RAM を即時解放（次回退避時に再 readback）
    this.touch(rec);
  }

  /** 1タイルを RAM へ退避（非破壊 readback）。呼び出し側で予算判断すること */
  private async evictTile(rec: TileRecord): Promise<void> {
    if (!rec.texture || rec.pinned) return;
    const staging = this.device.createBuffer({
      size: TILE_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: rec.texture },
      { buffer: staging, bytesPerRow: TILE_SIZE * 8 },
      [TILE_SIZE, TILE_SIZE],
    );
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    rec.mirror = new Uint16Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    rec.texture.destroy();
    rec.texture = null;
    this.evictions++;
  }

  /**
   * 予算維持（后台）。GPU 常駐が予算超過の間、LRU・非ピンから退避する。
   * 退避不能（全ピン）の場合は false を返し、超過を許容する（正しさ優先）。
   * 多重起動ガード付き。fire-and-forget で呼ぶこと。
   */
  async maintain(): Promise<boolean> {
    if (this.maintaining) return true;
    this.maintaining = true;
    try {
      for (;;) {
        if (this.gpuBytes() <= this.gpuBudgetBytes) return true;
        let oldest: TileRecord | null = null;
        for (const rec of this.tiles.values()) {
          if (!rec.texture || rec.pinned) continue;
          if (!oldest || rec.lastUsed < oldest.lastUsed) oldest = rec;
        }
        if (!oldest) return false;
        await this.evictTile(oldest);
      }
    } finally {
      this.maintaining = false;
    }
  }

  /** GPU 常駐バイト数（退避中は数えない） */
  gpuBytes(): number {
    let n = 0;
    for (const rec of this.tiles.values()) if (rec.texture) n++;
    return n * TILE_BYTES;
  }

  /** RAM spill バイト数 */
  spillBytes(): number {
    let n = 0;
    for (const rec of this.tiles.values()) if (rec.mirror) n++;
    return n * TILE_BYTES;
  }

  getOccupancy(cellId: string): ReadonlySet<number> {
    return this.occupancy.get(cellId) ?? TileStore.EMPTY_SET;
  }
  private static readonly EMPTY_SET: ReadonlySet<number> = new Set();

  /**
   * 合成読み出し用に常駐を保証する。退避中なら復帰させる。
   * 占有なし → null（呼び出し側で占有確認済みのはず）。
   */
  ensureResidentTile(owner: string, index: number): GPUTexture | null {
    const rec = this.tiles.get(TileStore.key(owner, index));
    if (!rec) return null;
    if (!rec.texture) this.restore(rec);
    this.touch(rec);
    return rec.texture!;
  }

  /** 内容世代（書き込み・破棄のたびに増加）。compose キャッシュのタグ用 */
  version(owner: string): number {
    return this.versions.get(owner) ?? 0;
  }

  private bump(owner: string): void {
    this.versions.set(owner, (this.versions.get(owner) ?? 0) + 1);
  }

  hasTile(cellId: string, index: number): boolean {
    return this.tiles.has(TileStore.key(cellId, index));
  }

  /** セルの全タイルを破棄（削除・クリア・再構築用）。mirror も解放する */
  releaseCell(cellId: string): void {
    const occ = this.occupancy.get(cellId);
    if (occ) {
      for (const index of occ) {
        const k = TileStore.key(cellId, index);
        const rec = this.tiles.get(k);
        if (rec) {
          rec.texture?.destroy();
          rec.mirror = null;
          this.tiles.delete(k);
        }
      }
      this.occupancy.delete(cellId);
      this.bump(cellId);
    }
  }

  clearAll(): void {
    for (const rec of this.tiles.values()) {
      rec.texture?.destroy();
      rec.mirror = null;
    }
    this.tiles.clear();
    this.occupancy.clear();
    this.pinnedOwners.clear();
    this.evictions = 0;
  }

  /**
   * 全面 tight データから採用（fill・freeze・pmx読込用）。
   * 旧占有は破棄し、非ゼロタイルだけ確保する。
   */
  adoptTightData(cellId: string, data: Uint16Array, w: number, h: number): void {
    this.adoptData(cellId, data, w * 4, w, h);
  }

  /**
   * 全面データ（行ストライド指定）から採用。スナップショット系は aligned のまま渡せる。
   * 旧占有は破棄し、非ゼロタイルだけ確保する。
   */
  adoptData(cellId: string, data: Uint16Array, rowStrideU16: number, w: number, h: number): void {
    this.releaseCell(cellId);
    for (let ty = 0; ty < this.tilesY; ty++) {
      for (let tx = 0; tx < this.tilesX; tx++) {
        const r = this.tileRect(tx, ty);
        if (r.w <= 0 || r.h <= 0) continue;
        if (!tileRegionNonZero(data, rowStrideU16, r.x, r.y, r.w, r.h)) continue;
        const tex = this.getTile(cellId, tx, ty);
        this.writeTilePixels(tex, data, rowStrideU16, r.x, r.y, r.w, r.h);
      }
    }
    this.bump(cellId);
  }

  /**
   * 全面 tight データを指定タイル集合へ散布書き込み（占有は union で拡大）。
   * move/transform 確定・cancel 復元用。ゼロ判定はしない（呼び出し側の shape 維持）。
   */
  scatterTiles(cellId: string, indices: Iterable<number>, data: Uint16Array, w: number, h: number): void {
    this.scatterData(cellId, indices, data, w * 4, w, h);
  }

  /** 全面データ（行ストライド指定）を指定タイル集合へ散布書き込み */
  scatterData(
    cellId: string, indices: Iterable<number>,
    data: Uint16Array, rowStrideU16: number, _w: number, _h: number,
  ): void {
    for (const index of indices) {
      const tx = TileStore.txOf(index, this.tilesX);
      const ty = TileStore.tyOf(index, this.tilesX);
      const r = this.tileRect(tx, ty);
      if (r.w <= 0 || r.h <= 0) continue;
      const tex = this.getTile(cellId, tx, ty);
      this.writeTilePixels(tex, data, rowStrideU16, r.x, r.y, r.w, r.h);
    }
    this.bump(cellId);
  }

  /** 全面バッファからタイル矩形分を GPU へ書き込む（行ストライド指定） */
  private writeTilePixels(
    tex: GPUTexture, data: Uint16Array, rowStrideU16: number,
    x: number, y: number, w: number, h: number,
  ): void {
    const dst = this.scratchTile;
    for (let row = 0; row < h; row++) {
      const si = (y + row) * rowStrideU16 + x * 4;
      dst.set(data.subarray(si, si + w * 4), row * w * 4);
    }
    this.device.queue.writeTexture(
      { texture: tex },
      dst as unknown as BufferSource,
      { bytesPerRow: w * 8, rowsPerImage: h },
      [w, h],
    );
  }

  /** 単タイル書き込み（tight tw*th*4。pmx読込用。ゼロチェックなし） */
  writeTileData(cellId: string, index: number, data: Uint16Array): void {
    const tx = TileStore.txOf(index, this.tilesX);
    const ty = TileStore.tyOf(index, this.tilesX);
    const r = this.tileRect(tx, ty);
    if (r.w <= 0 || r.h <= 0) return;
    const tex = this.getTile(cellId, tx, ty);
    this.device.queue.writeTexture(
      { texture: tex },
      data as unknown as BufferSource,
      { bytesPerRow: r.w * 8, rowsPerImage: r.h },
      [r.w, r.h],
    );
    this.bump(cellId);
  }

  /**
   * GPU 上で fullscreen ソースから指定タイルへ散布（readback なし）。
   * transform/filter/freeze 確定用。各タイルはクリア後に over 転写＝置換になる。
   */
  scatterTexture(
    src: GPUTexture, cellId: string, indices: Iterable<number>,
    baker: TileBakeRenderer,
  ): void {
    const { device } = this;
    for (const index of indices) {
      const tx = TileStore.txOf(index, this.tilesX);
      const ty = TileStore.tyOf(index, this.tilesX);
      const r = this.tileRect(tx, ty);
      if (r.w <= 0 || r.h <= 0) continue;
      const tex = this.getTile(cellId, tx, ty);
      // 置換にするため一旦クリアしてから転写する
      const clearEnc = device.createCommandEncoder();
      clearEnc.beginRenderPass({
        colorAttachments: [{
          view: tex.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      }).end();
      device.queue.submit([clearEnc.finish()]);
      baker.bakeRect(src, tex, 'over', r.x, r.y, r.w, r.h, this.canvasWidth, this.canvasHeight);
    }
    this.bump(cellId);
  }

  /**
   * owner の全タイルを dstOwner へ深複製（Undo基準の再構築用）。
   * 基準を残したまま committed 側を書き換え可能にする。共有なし。
   */
  copyOwner(srcOwner: string, dstOwner: string): void {
    this.releaseCell(dstOwner);
    const occ = this.occupancy.get(srcOwner);
    if (!occ) return;
    const { device } = this;
    for (const index of occ) {
      const src = this.tiles.get(TileStore.key(srcOwner, index));
      if (!src) continue;
      if (!src.texture) this.restore(src);
      this.touch(src);
      const tx = TileStore.txOf(index, this.tilesX);
      const ty = TileStore.tyOf(index, this.tilesX);
      const dst = this.getTile(dstOwner, tx, ty);
      const enc = device.createCommandEncoder();
      enc.copyTextureToTexture(
        { texture: src.texture! }, { texture: dst },
        [TILE_SIZE, TILE_SIZE],
      );
      device.queue.submit([enc.finish()]);
    }
    this.bump(dstOwner);
  }

  /**
   * セル内容を fullscreen scratch へ合成（clear なし。呼び出し側で clear）。
   * 退避タイルは復帰してから複写する。ブレンド・サンプリング・readback の入力用。
   */
  composeCell(cellId: string, dst: GPUTexture): void {
    const enc = this.device.createCommandEncoder();
    const occ = this.occupancy.get(cellId);
    if (occ) {
      for (const index of occ) {
        const k = TileStore.key(cellId, index);
        const rec = this.tiles.get(k);
        if (!rec) continue;
        if (!rec.texture) this.restore(rec);
        this.touch(rec);
        const tx = TileStore.txOf(index, this.tilesX);
        const ty = TileStore.tyOf(index, this.tilesX);
        const r = this.tileRect(tx, ty);
        enc.copyTextureToTexture(
          { texture: rec.texture!, origin: { x: 0, y: 0 } },
          { texture: dst, origin: { x: r.x, y: r.y } },
          [r.w, r.h],
        );
      }
    }
    this.device.queue.submit([enc.finish()]);
  }

  /**
   * 単タイル読み出し（tight・端数トリム済み）。pmx保存用。
   * 512×8=4096B/行で256アライン適合のためパディングなし。
   */
  async readTile(cellId: string, index: number): Promise<Uint16Array> {
    const rec = this.tiles.get(TileStore.key(cellId, index));
    if (!rec) throw new Error(`Tile not found: ${cellId}:${index}`);
    const tx = TileStore.txOf(index, this.tilesX);
    const ty = TileStore.tyOf(index, this.tilesX);
    const r = this.tileRect(tx, ty);
    // 退避中は mirror から直接（GPU 不要）
    if (!rec.texture) {
      if (!rec.mirror) throw new Error(`Tile has no data: ${cellId}:${index}`);
      return trimTile(rec.mirror, r.w, r.h);
    }
    const { device } = this;
    const staging = device.createBuffer({
      size: TILE_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: rec.texture },
      { buffer: staging, bytesPerRow: TILE_SIZE * 8 },
      [TILE_SIZE, TILE_SIZE],
    );
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const full = new Uint16Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return trimTile(full, r.w, r.h);
  }

  stats(): { tileCount: number; gpuBytes: number; spillBytes: number; budgetBytes: number; cells: number; evictions: number } {
    return {
      tileCount: this.tiles.size,
      gpuBytes: this.gpuBytes(),
      spillBytes: this.spillBytes(),
      budgetBytes: this.gpuBudgetBytes,
      cells: this.occupancy.size,
      evictions: this.evictions,
    };
  }
}

/** full 512² tight から tw*th へトリム（端数タイル用・純粋関数） */
export function trimTile(full: Uint16Array, w: number, h: number): Uint16Array {
  if (w === TILE_SIZE && h === TILE_SIZE) return full.slice(0);
  const tight = new Uint16Array(w * h * 4);
  const fullU16PerRow = TILE_SIZE * 4;
  for (let row = 0; row < h; row++) {
    tight.set(full.subarray(row * fullU16PerRow, row * fullU16PerRow + w * 4), row * w * 4);
  }
  return tight;
}

/** 全面 tight バッファの矩形領域に非ゼロがあるか（占有判定用・純粋関数） */
export function tileRegionNonZero(
  data: Uint16Array, u16PerRow: number,
  x: number, y: number, w: number, h: number,
): boolean {
  for (let row = 0; row < h; row++) {
    const base = (y + row) * u16PerRow + x * 4;
    for (let i = 0; i < w * 4; i++) {
      if (data[base + i] !== 0) return true;
    }
  }
  return false;
}
