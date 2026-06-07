/**
 * .pmx ネイティブ形式の保存/読み込み
 *
 * ZIP コンテナ:
 *   manifest.json   バージョン・キャンバスサイズ・レイヤー構成・View設定・スウォッチ・効果レイヤー
 *   layers/<id>.f16 各ペイントレイヤーの tight packed float16 RGBA（プリマルチプライド・リニア）
 *
 * 効果（非破壊）レイヤーはピクセルを持たず manifest にパラメータのみ保存する。
 * stackOrder で paint/effect の積み順を保持する。
 */

import * as fflate from 'fflate';
import type { LayerInfo } from './render/pipeline.js';
import type { TonemapId, DisplayModeId } from './color/display.js';
import type { FilterType, FilterParams } from './render/filter.js';
import type { CurvePoint } from './color/curve.js';

const PMX_VERSION = '1.1';

export interface PmxLayer {
  info: LayerInfo;
  data: Uint16Array; // tight packed float16 RGBA
}

export interface PmxEffectLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blendMode: 'normal';
  kind: 'effect';
  filterType: FilterType;
  params: FilterParams;
  curvePoints?: CurvePoint[];
  source?: string; // 入力ソース: 'below' or ペイントレイヤーID
}

export interface PmxDocumentSettings {
  view: { viewEV: number; tonemap: TonemapId; viewMode: DisplayModeId };
  swatches: { r: number; g: number; b: number; a: number }[];
}

export interface PmxSaveExtras {
  documentSettings?: PmxDocumentSettings;
  effectLayers?: PmxEffectLayer[];
  stackOrder?: string[]; // 全レイヤー（paint+effect）の id を積み順で
}

export interface PmxManifest {
  version: string;
  app: string;
  width: number;
  height: number;
  activeId: string;
  layers: (LayerInfo & { file: string })[];
  effectLayers?: PmxEffectLayer[];
  stackOrder?: string[];
  documentSettings?: PmxDocumentSettings;
}

export interface PmxLoadResult {
  width: number;
  height: number;
  activeId: string;
  layers: PmxLayer[];
  effectLayers: PmxEffectLayer[];
  stackOrder: string[];
  documentSettings?: PmxDocumentSettings;
}

/** .pmx を生成 */
export function savePmx(width: number, height: number, layers: PmxLayer[], activeId: string, extras: PmxSaveExtras = {}): Blob {
  const manifest: PmxManifest = {
    version: PMX_VERSION,
    app: 'PhotonMixer',
    width, height, activeId,
    layers: layers.map(l => ({ ...l.info, file: `layers/${l.info.id}.f16` })),
    effectLayers: extras.effectLayers,
    stackOrder: extras.stackOrder,
    documentSettings: extras.documentSettings,
  };

  const files: Record<string, Uint8Array> = {
    'manifest.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  };
  for (const l of layers) {
    files[`layers/${l.info.id}.f16`] = new Uint8Array(l.data.buffer, l.data.byteOffset, l.data.byteLength);
  }

  const zipped = fflate.zipSync(files);
  return new Blob([zipped], { type: 'application/octet-stream' });
}

/** .pmx を読み込み */
export async function loadPmx(blob: Blob): Promise<PmxLoadResult> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const unzipped = fflate.unzipSync(buf);

  const manifestBytes = unzipped['manifest.json'];
  if (!manifestBytes) throw new Error('Invalid .pmx: manifest.json not found');
  const manifest: PmxManifest = JSON.parse(new TextDecoder().decode(manifestBytes));

  const layers: PmxLayer[] = [];
  for (const entry of manifest.layers) {
    const bytes = unzipped[entry.file];
    if (!bytes) throw new Error(`Invalid .pmx: ${entry.file} not found`);
    const copy = bytes.slice();
    const data = new Uint16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2);
    const { file, ...info } = entry;
    layers.push({ info, data });
  }

  const effectLayers = manifest.effectLayers ?? [];
  const stackOrder = manifest.stackOrder ?? [...layers.map(l => l.info.id), ...effectLayers.map(e => e.id)];

  return {
    width: manifest.width, height: manifest.height, activeId: manifest.activeId,
    layers, effectLayers, stackOrder, documentSettings: manifest.documentSettings,
  };
}
