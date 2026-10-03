/**
 * .pmx (v3) の保存・読み込みと manifest 検証のテスト。
 *
 * 特に次の 2 点を守る:
 *  - float16 タイルが HDR（1.0 超）を往復すること（作品データ = リニアHDRの原本）
 *  - documentSettings.view の enum / viewEV 範囲が不正な値を弾くこと
 *    （通すと indexOf() = -1 → WGSL i32(-0.5) = 0 で別の表示設定へ静かに化ける）
 */

import assert from 'node:assert';
import { test, describe } from 'node:test';
import * as fflate from 'fflate';
import { savePmx, loadPmx, PMX_TILE_SIZE } from '../src/pmx.js';
import { float32ToFloat16, float16ToFloat32 } from '../src/color/float16.js';
import type { CellNode, LayerNode } from '../src/render/layer-model.js';
import type { PmxManifest } from '../src/pmx.js';

const approx = (a: number, b: number, e = 1e-3) => Math.abs(a - b) <= e * Math.max(1, Math.abs(b));

function makeCell(id: string): CellNode {
  return {
    id, name: id, kind: 'cell', visible: true, opacity: 1,
    blendMode: 'normal', alphaLock: false, effects: [],
  };
}

/** manifest のみ差し替えた pmx Blob を作る（不正データ投入用） */
async function blobWithManifest(patch: (m: PmxManifest) => void, tiles: { cellId: string; tx: number; ty: number; data: Uint16Array }[] = []): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const m: PmxManifest = {
    version: '3.0', app: 'PhotonMixer', width: 64, height: 64, tileSize: PMX_TILE_SIZE,
    activeCellId: 'c1', rootNodes: [makeCell('c1')], rootEffects: [],
  };
  patch(m);
  files['manifest.json'] = new TextEncoder().encode(JSON.stringify(m));
  for (const t of tiles) {
    files[`tiles/${t.cellId}/${t.tx}_${t.ty}.f16`] = new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength);
  }
  return new Blob([fflate.zipSync(files)]);
}

describe('float16 変換', () => {
  test('HDR（1.0 超）が往復する', () => {
    for (const v of [0, 0.002, 0.25, 1, 1.5, 4, 16, 64, 1024]) {
      assert.ok(approx(float16ToFloat32(float32ToFloat16(v)), v, 1e-3), `v=${v}`);
    }
  });

  test('負値も往復する', () => {
    for (const v of [-0.5, -2]) {
      assert.ok(approx(float16ToFloat32(float32ToFloat16(v)), v, 1e-3), `v=${v}`);
    }
  });
});

describe('savePmx / loadPmx ラウンドトリップ', () => {
  test('HDR タイル（1.0 超）が保持される', async () => {
    // 64x64 キャンバスのタイル(0,0) は 64*64*4 個の float16 がちょうど入る
    const vals = [4.0, 0.5, 16.0, 0.0];
    const data = new Uint16Array(64 * 64 * 4);
    vals.forEach((v, i) => { data[i * 4] = float32ToFloat16(v); });

    const blob = savePmx(64, 64, [makeCell('c1')] as LayerNode[], [],
      [{ cellId: 'c1', tiles: [{ tx: 0, ty: 0, data }] }], 'c1', PMX_TILE_SIZE);
    const r = await loadPmx(blob);

    assert.strictEqual(r.cellData.length, 1);
    const out = r.cellData[0].tiles[0].data;
    for (let i = 0; i < vals.length; i++) {
      assert.ok(approx(float16ToFloat32(out[i * 4]), vals[i]), `ch${i}: ${float16ToFloat32(out[i * 4])} != ${vals[i]}`);
    }
  });

  test('HDR スウォッチ（1.0 超）が保持される', async () => {
    const swatches = [{ r: 4, g: 0.5, b: 0, a: 1 }, { r: 16, g: 16, b: 16, a: 0.5 }];
    const blob = savePmx(64, 64, [makeCell('c1')] as LayerNode[], [],
      [], 'c1', PMX_TILE_SIZE, {
        documentSettings: { view: { viewEV: 2.5, tonemap: 'agx', viewMode: 'clip' }, swatches },
      });
    const r = await loadPmx(blob);
    assert.ok(r.documentSettings);
    assert.deepStrictEqual(r.documentSettings.view, { viewEV: 2.5, tonemap: 'agx', viewMode: 'clip' });
    assert.deepStrictEqual(r.documentSettings.swatches, swatches);
  });

  test('境界の viewEV（-6 / +6）は通る', async () => {
    for (const ev of [-6, 6]) {
      const blob = savePmx(64, 64, [makeCell('c1')] as LayerNode[], [], [], 'c1', PMX_TILE_SIZE, {
        documentSettings: { view: { viewEV: ev, tonemap: 'none', viewMode: 'transform' }, swatches: [] },
      });
      const r = await loadPmx(blob);
      assert.strictEqual(r.documentSettings!.view.viewEV, ev);
    }
  });
});

describe('documentSettings の検証', () => {
  test('viewEV が範囲外なら拒否する', async () => {
    for (const viewEV of [6.1, -6.1, 1000]) {
      const blob = await blobWithManifest(m => {
        m.documentSettings = { view: { viewEV, tonemap: 'pbrNeutral', viewMode: 'transform' }, swatches: [] };
      });
      await assert.rejects(() => loadPmx(blob), /view EV out of range/);
    }
  });

  test('未知の tonemap は拒否する（spec.md の旧 enum 名を含む）', async () => {
    for (const tonemap of ['aces', 'clipWarning', '', 'PBRNeutral']) {
      const blob = await blobWithManifest(m => {
        m.documentSettings = { view: { viewEV: 0, tonemap, viewMode: 'transform' } as never, swatches: [] };
      });
      await assert.rejects(() => loadPmx(blob), /unknown tonemap/);
    }
  });

  test('未知の viewMode は拒否する（display/rawLinear/clipWarning は旧 spec 名）', async () => {
    for (const viewMode of ['display', 'rawLinear', 'clipWarning', '']) {
      const blob = await blobWithManifest(m => {
        m.documentSettings = { view: { viewEV: 0, tonemap: 'pbrNeutral', viewMode } as never, swatches: [] };
      });
      await assert.rejects(() => loadPmx(blob), /unknown view mode/);
    }
  });

  test('全 enum メンバーは通る', async () => {
    for (const tonemap of ['pbrNeutral', 'agx', 'reinhard', 'none'] as const) {
      for (const viewMode of ['transform', 'raw', 'clip'] as const) {
        const blob = await blobWithManifest(m => {
          m.documentSettings = { view: { viewEV: 0, tonemap, viewMode }, swatches: [] };
        });
        const r = await loadPmx(blob);
        assert.strictEqual(r.documentSettings!.view.tonemap, tonemap);
        assert.strictEqual(r.documentSettings!.view.viewMode, viewMode);
      }
    }
  });

  test('非有限なスウォッチ値は拒否する（NaN が currentColor に混入するのを防ぐ）', async () => {
    for (const bad of [{ r: NaN, g: 0, b: 0, a: 1 }, { r: 1, g: 'x', b: 0, a: 1 } as never]) {
      const blob = await blobWithManifest(m => {
        m.documentSettings = { view: { viewEV: 0, tonemap: 'none', viewMode: 'transform' }, swatches: [bad] };
      });
      await assert.rejects(() => loadPmx(blob), /swatch/);
    }
  });

  test('スウォッチの alpha が範囲外なら拒否する', async () => {
    const blob = await blobWithManifest(m => {
      m.documentSettings = { view: { viewEV: 0, tonemap: 'none', viewMode: 'transform' }, swatches: [{ r: 4, g: 0, b: 0, a: 1.5 }] };
    });
    await assert.rejects(() => loadPmx(blob), /alpha out of range/);
  });

  test('スウォッチの HDR 値（1.0 超）は正当とみなす', async () => {
    const blob = await blobWithManifest(m => {
      m.documentSettings = { view: { viewEV: 0, tonemap: 'none', viewMode: 'transform' }, swatches: [{ r: 65504, g: 0, b: 0, a: 1 }] };
    });
    const r = await loadPmx(blob);
    assert.strictEqual(r.documentSettings!.swatches[0].r, 65504);
  });
});

describe('不正ファイル', () => {
  test('manifest 不正で拒否する', async () => {
    // ZIP として不正な入力は読み込み前に弾かれる
    await assert.rejects(() => loadPmx(new Blob([new Uint8Array([1, 2, 3])])));
    // ZIP は正しいが manifest.json が JSON でない
    const bad = new Blob([fflate.zipSync({ 'manifest.json': new Uint8Array([0x00, 0x01]) })]);
    await assert.rejects(() => loadPmx(bad), /JSON/i);
  });

  test('バージョン不一致は拒否する', async () => {
    const blob = await blobWithManifest(m => { (m as { version: string }).version = '2.0'; });
    await assert.rejects(() => loadPmx(blob), /Unsupported \.pmx format/);
  });

  test('タイル長が不一致なら拒否する', async () => {
    const blob = await blobWithManifest(() => {}, [{ cellId: 'c1', tx: 0, ty: 0, data: new Uint16Array(3) }]);
    await assert.rejects(() => loadPmx(blob), /Invalid \.pmx tile size/);
  });
});