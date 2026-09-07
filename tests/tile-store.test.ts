/**
 * TileStore の単体テスト（GPU は fake device）。
 * 占有・rectToTiles・zero-skip・release・予算追跡の純粋ロジックを検証。
 */

import assert from 'node:assert';
import { test, describe } from 'node:test';
import { TileStore, TILE_SIZE, TILE_BYTES, tileRegionNonZero, trimTile } from '../src/render/tile-store.js';

// Node には WebGPU グローバルがないため最小スタブ（値は fake device が無視する）
(globalThis as any).GPUTextureUsage ??= {
  RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, STORAGE_BINDING: 4,
  COPY_SRC: 8, COPY_DST: 16,
};
(globalThis as any).GPUBufferUsage ??= { COPY_DST: 1, MAP_READ: 2 };
(globalThis as any).GPUMapMode ??= { READ: 1 };

function makeFakeDevice() {
  const textures: any[] = [];
  let writeTextures = 0;
  const device = {
    createTexture: (opts: any) => {
      const t = {
        opts,
        destroyed: false,
        createView: () => ({}),
        destroy(this: any) { this.destroyed = true; },
      };
      textures.push(t);
      return t;
    },
    createBuffer: () => ({
      mapAsync: async () => {},
      getMappedRange: () => new ArrayBuffer(TILE_BYTES),
      unmap() {},
      destroy() {},
    }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({ end() {} }),
      copyTextureToTexture() {},
      copyTextureToBuffer() {},
      finish: () => ({}),
    }),
    queue: { submit() {}, writeTexture() { writeTextures++; } },
    __textures: textures,
    __writeCount: () => writeTextures,
  };
  return device as unknown as GPUDevice & { __writeCount(): number };
}

const W = 2000, H = 2000; // 4x4 タイル

describe('TileStore', () => {
  test('tilesX/Y が切り上げになる', () => {
    const s = new TileStore(makeFakeDevice(), W, H);
    assert.strictEqual(s.tilesX, 4);
    assert.strictEqual(s.tilesY, 4);
  });

  test('rectToTiles: 矩形と交差するタイルだけ', () => {
    const s = new TileStore(makeFakeDevice(), W, H);
    // (0,0)-(512,512) はタイル0のみ
    assert.deepStrictEqual(s.rectToTiles(0, 0, 512, 512), [0]);
    // 境界をまたぐ
    assert.deepStrictEqual(s.rectToTiles(500, 500, 600, 600), [0, 1, 4, 5]);
    // 空矩形
    assert.deepStrictEqual(s.rectToTiles(10, 10, 10, 10), []);
    // キャンバス外はクリップ
    assert.deepStrictEqual(s.rectToTiles(-100, -100, 100, 100), [0]);
    assert.deepStrictEqual(s.rectToTiles(1990, 1990, 3000, 3000), [15]);
  });

  test('tileRect: 端数タイルはクランプ', () => {
    const s = new TileStore(makeFakeDevice(), W, H);
    assert.deepStrictEqual(s.tileRect(0, 0), { x: 0, y: 0, w: 512, h: 512 });
    // 2000 = 3*512 + 464
    assert.deepStrictEqual(s.tileRect(3, 3), { x: 1536, y: 1536, w: 464, h: 464 });
    assert.deepStrictEqual(s.tileRect(3, 0), { x: 1536, y: 0, w: 464, h: 512 });
  });

  test('getTile で占有が増える・同一タイルは再利用', () => {
    const s = new TileStore(makeFakeDevice(), W, H);
    const a = s.getTile('c1', 0, 0);
    const b = s.getTile('c1', 0, 0);
    assert.strictEqual(a, b);
    assert.deepStrictEqual([...s.getOccupancy('c1')], [0]);
    s.getTile('c1', 1, 0);
    assert.deepStrictEqual([...s.getOccupancy('c1')].sort((x, y) => x - y), [0, 1]);
    assert.strictEqual(s.stats().tileCount, 2);
    assert.strictEqual(s.stats().gpuBytes, 2 * 512 * 512 * 8);
  });

  test('releaseCell で破棄・占有クリア', () => {
    const device = makeFakeDevice();
    const s = new TileStore(device, W, H);
    const t = s.getTile('c1', 0, 0) as any;
    s.getTile('c1', 1, 1);
    s.releaseCell('c1');
    assert.ok(t.destroyed);
    assert.strictEqual(s.getOccupancy('c1').size, 0);
    assert.strictEqual(s.stats().tileCount, 0);
  });

  test('adoptTightData: 非ゼロタイルだけ確保', () => {
    const s = new TileStore(makeFakeDevice(), W, H);
    const data = new Uint16Array(W * H * 4);
    // (600, 600) 付近の数ピクセルだけ立てる → タイル5 (tx=1,ty=1)
    const idx = (600 * W + 600) * 4;
    data[idx] = 0x3c00; data[idx + 3] = 0x3c00;
    s.adoptTightData('c1', data, W, H);
    assert.deepStrictEqual([...s.getOccupancy('c1')], [5]);
  });

  test('adoptTightData: 全ゼロなら何も確保しない', () => {
    const s = new TileStore(makeFakeDevice(), W, H);
    s.adoptTightData('c1', new Uint16Array(W * H * 4), W, H);
    assert.strictEqual(s.getOccupancy('c1').size, 0);
    assert.strictEqual(s.stats().tileCount, 0);
  });

  test('予算超過でLRUから退避し、使うと復帰する', async () => {
    const device = makeFakeDevice();
    const s = new TileStore(device, W, H, { gpuBudgetBytes: TILE_BYTES * 2 });
    s.getTile('c1', 0, 0);
    s.getTile('c1', 1, 0);
    s.getTile('c1', 2, 0); // 3枚目で超過
    assert.strictEqual(s.stats().gpuBytes, TILE_BYTES * 3);
    const ok = await s.maintain();
    assert.strictEqual(ok, true);
    assert.strictEqual(s.stats().gpuBytes, TILE_BYTES * 2);
    assert.strictEqual(s.stats().spillBytes, TILE_BYTES);
    assert.strictEqual(s.stats().evictions, 1);
    // 占有は維持される
    assert.deepStrictEqual([...s.getOccupancy('c1')].sort((a, b) => a - b), [0, 1, 2]);
    // 退避タイルに触ると復帰する（writeTexture 発生）
    const writesBefore = (device as any).__writeCount();
    s.getTile('c1', 0, 0);
    assert.ok((device as any).__writeCount() > writesBefore);
    assert.strictEqual(s.stats().spillBytes, 0);
  });

  test('ピン留めは退避しない。退避不能なら超過を許容して false', async () => {
    const device = makeFakeDevice();
    const s = new TileStore(device, W, H, { gpuBudgetBytes: TILE_BYTES * 2 });
    s.pinOwner('c1', true);
    s.getTile('c1', 0, 0);
    s.getTile('c1', 1, 0);
    s.getTile('c1', 2, 0);
    const ok = await s.maintain();
    assert.strictEqual(ok, false);
    assert.strictEqual(s.stats().evictions, 0);
    assert.strictEqual(s.stats().gpuBytes, TILE_BYTES * 3);
    // 解除後は退避できる
    s.pinOwner('c1', false);
    assert.strictEqual(await s.maintain(), true);
    assert.strictEqual(s.stats().evictions, 1);
  });

  test('LRU: 最も古いものから退避する', async () => {
    const device = makeFakeDevice();
    const s = new TileStore(device, W, H, { gpuBudgetBytes: TILE_BYTES * 2 });
    s.getTile('c1', 0, 0); // 最古
    s.getTile('c1', 1, 0);
    s.getTile('c1', 1, 0); // touch して新しくする
    s.getTile('c1', 2, 0); // 超過 → タイル0が退避されるはず
    await s.maintain();
    // タイル0は mirror のみ、タイル1,2は常駐
    const st = s.stats();
    assert.strictEqual(st.spillBytes, TILE_BYTES);
    const t0 = await s.readTile('c1', 0); // mirror 経由で読める
    assert.strictEqual(t0.length, TILE_SIZE * TILE_SIZE * 4);
  });

  test('trimTile: 端数はトリム・等倍はコピー', () => {
    const full = new Uint16Array(TILE_SIZE * TILE_SIZE * 4);
    full.fill(7);
    const same = trimTile(full, TILE_SIZE, TILE_SIZE);
    assert.strictEqual(same.length, full.length);
    assert.strictEqual(same[0], 7);
    const small = trimTile(full, 10, 5);
    assert.strictEqual(small.length, 10 * 5 * 4);
    assert.ok(small.every(v => v === 7));
  });

  test('tileRegionNonZero', () => {
    const data = new Uint16Array(10 * 10 * 4);
    assert.strictEqual(tileRegionNonZero(data, 40, 0, 0, 10, 10), false);
    data[(5 * 10 + 5) * 4 + 2] = 1;
    assert.strictEqual(tileRegionNonZero(data, 40, 0, 0, 10, 10), true);
    assert.strictEqual(tileRegionNonZero(data, 40, 0, 0, 5, 5), false);
    assert.strictEqual(tileRegionNonZero(data, 40, 5, 5, 5, 5), true);
  });
});
