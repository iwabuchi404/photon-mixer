/**
 * .pmx ネイティブ形式の保存/読み込み
 *
 * MVP: ZIP コンテナ + 生 float16 RGBA データ（プリマルチプライド・リニア）
 *   manifest.json          バージョン・キャンバスサイズ・レイヤー構成
 *   layers/<id>.f16         各レイヤーの tight packed float16 RGBA（width*height*4 u16）
 *
 * 注: 仕様では EXR を予定しているが、ライブラリ依存を避けつつ完全精度を保つため
 *     当面は生 float16 を採用。EXR 互換書き出しは将来対応。
 */

import * as fflate from 'fflate';
import type { LayerInfo } from './render/pipeline.js';

const PMX_VERSION = '1.0';

export interface PmxLayer {
  info: LayerInfo;
  data: Uint16Array; // tight packed float16 RGBA
}

export interface PmxManifest {
  version: string;
  app: string;
  width: number;
  height: number;
  activeId: string;
  layers: (LayerInfo & { file: string })[];
}

/**
 * .pmx を生成
 */
export function savePmx(width: number, height: number, layers: PmxLayer[], activeId: string): Blob {
  const manifest: PmxManifest = {
    version: PMX_VERSION,
    app: 'PhotonMixer',
    width, height, activeId,
    layers: layers.map(l => ({ ...l.info, file: `layers/${l.info.id}.f16` })),
  };

  const files: Record<string, Uint8Array> = {
    'manifest.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  };
  for (const l of layers) {
    // Uint16Array を Uint8Array ビューに（リトルエンディアンのまま格納）
    files[`layers/${l.info.id}.f16`] = new Uint8Array(l.data.buffer, l.data.byteOffset, l.data.byteLength);
  }

  const zipped = fflate.zipSync(files);
  return new Blob([zipped], { type: 'application/octet-stream' });
}

/**
 * .pmx を読み込み
 */
export async function loadPmx(blob: Blob): Promise<{ width: number; height: number; activeId: string; layers: PmxLayer[] }> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const unzipped = fflate.unzipSync(buf);

  const manifestBytes = unzipped['manifest.json'];
  if (!manifestBytes) throw new Error('Invalid .pmx: manifest.json not found');
  const manifest: PmxManifest = JSON.parse(new TextDecoder().decode(manifestBytes));

  const layers: PmxLayer[] = [];
  for (const entry of manifest.layers) {
    const bytes = unzipped[entry.file];
    if (!bytes) throw new Error(`Invalid .pmx: ${entry.file} not found`);
    // byteOffset がアライン外の可能性があるためコピーして Uint16Array 化
    const copy = bytes.slice();
    const data = new Uint16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2);
    const { file, ...info } = entry;
    layers.push({ info, data });
  }

  return { width: manifest.width, height: manifest.height, activeId: manifest.activeId, layers };
}
