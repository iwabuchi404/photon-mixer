/**
 * .pmx ネイティブ形式の保存/読み込み（v2: 3オブジェクト構造対応）
 *
 * ZIP コンテナ:
 *   manifest.json   バージョン・キャンバスサイズ・レイヤーツリー・ルート効果チェーン・View設定・スウォッチ
 *   layers/<id>.f16 各セルの tight packed float16 RGBA（プリマルチプライド・リニア）
 *
 * v2 ではレイヤーツリー（FolderNode/CellNode）とルート効果チェーンを manifest に保存する。
 * 効果チェーンはセルまたはルートに付属し、ピクセルを持たない。
 *
 * 旧形式（v1.x）からの自動変換は行わない（手動マイグレーション）。
 */

import * as fflate from 'fflate';
import type { LayerNode, CellNode, EffectChainItem } from './render/layer-model.js';
import type { TonemapId, DisplayModeId } from './color/display.js';

const PMX_VERSION = '2.0';

/** セルの保存用データ（ピクセル + セル情報） */
export interface PmxCellData {
  cell: CellNode;
  data: Uint16Array; // tight packed float16 RGBA
}

export interface PmxDocumentSettings {
  view: { viewEV: number; tonemap: TonemapId; viewMode: DisplayModeId };
  swatches: { r: number; g: number; b: number; a: number }[];
}

export interface PmxSaveExtras {
  documentSettings?: PmxDocumentSettings;
}

export interface PmxManifest {
  version: string;
  app: string;
  width: number;
  height: number;
  activeCellId: string;
  rootNodes: LayerNode[];
  rootEffects: EffectChainItem[];
  documentSettings?: PmxDocumentSettings;
}

export interface PmxLoadResult {
  width: number;
  height: number;
  activeCellId: string;
  rootNodes: LayerNode[];
  rootEffects: EffectChainItem[];
  cellData: { cellId: string; data: Uint16Array }[];
  documentSettings?: PmxDocumentSettings;
}

/** .pmx を生成 */
export function savePmx(
  width: number, height: number,
  rootNodes: LayerNode[], rootEffects: EffectChainItem[],
  cellData: { cellId: string; data: Uint16Array }[],
  activeCellId: string,
  extras: PmxSaveExtras = {},
): Blob {
  const manifest: PmxManifest = {
    version: PMX_VERSION,
    app: 'PhotonMixer',
    width, height, activeCellId,
    rootNodes,
    rootEffects,
    documentSettings: extras.documentSettings,
  };

  const files: Record<string, Uint8Array> = {
    'manifest.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  };
  for (const { cellId, data } of cellData) {
    files[`layers/${cellId}.f16`] = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
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

  // v2 形式のみ対応（旧形式は手動マイグレーション）
  if (!manifest.rootNodes) {
    throw new Error('Unsupported .pmx format (v1.x). Manual migration required.');
  }

  // 各セルのピクセルデータを読み込み
  const cellData: { cellId: string; data: Uint16Array }[] = [];
  const collectCells = (nodes: LayerNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'cell') {
        const bytes = unzipped[`layers/${n.id}.f16`];
        if (bytes) {
          const copy = bytes.slice();
          const data = new Uint16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2);
          cellData.push({ cellId: n.id, data });
        }
      } else if (n.kind === 'folder') {
        collectCells(n.children);
      }
    }
  };
  collectCells(manifest.rootNodes);

  return {
    width: manifest.width, height: manifest.height,
    activeCellId: manifest.activeCellId,
    rootNodes: manifest.rootNodes,
    rootEffects: manifest.rootEffects ?? [],
    cellData,
    documentSettings: manifest.documentSettings,
  };
}
