/**
 * .pmx ネイティブ形式の保存/読み込み（v3: タイル対応）
 *
 * ZIP コンテナ:
 *   manifest.json   バージョン・キャンバスサイズ・タイルサイズ・レイヤーツリー・ルート効果チェーン・View設定・スウォッチ
 *   tiles/<cellId>/<tx>_<ty>.f16 各タイルの tight float16 RGBA（プリマルチプライド・リニア・非空のみ）
 *
 * v3 ではレイヤーツリー（FolderNode/CellNode）とルート効果チェーンを manifest に保存する。
 * 効果チェーンはセルまたはルートに付属し、ピクセルを持たない。
 *
 * 旧形式（v2 以前の全面画像）からの自動変換は行わない。
 */

import * as fflate from 'fflate';
import type { LayerNode, CellNode, EffectChainItem } from './render/layer-model.js';
import type { TonemapId, DisplayModeId } from './color/display.js';

const PMX_VERSION = '3.0';

/** セルのタイル保存用データ */
export interface PmxTileData {
  tx: number;
  ty: number;
  data: Uint16Array; // tight float16 RGBA（tw*th*4）
}

/** セルの保存用データ（ピクセル + セル情報） */
export interface PmxCellData {
  cell: CellNode;
  tiles: PmxTileData[];
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
  tileSize: number;
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
  cellData: { cellId: string; tiles: PmxTileData[] }[];
  documentSettings?: PmxDocumentSettings;
}

/** .pmx を生成 */
export function savePmx(
  width: number, height: number,
  rootNodes: LayerNode[], rootEffects: EffectChainItem[],
  cellData: { cellId: string; tiles: PmxTileData[] }[],
  activeCellId: string,
  tileSize: number,
  extras: PmxSaveExtras = {},
): Blob {
  const manifest: PmxManifest = {
    version: PMX_VERSION,
    app: 'PhotonMixer',
    width, height, tileSize, activeCellId,
    rootNodes,
    rootEffects,
    documentSettings: extras.documentSettings,
  };

  const files: Record<string, Uint8Array> = {
    'manifest.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  };
  for (const { cellId, tiles } of cellData) {
    for (const { tx, ty, data } of tiles) {
      files[`tiles/${cellId}/${tx}_${ty}.f16`] = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
  }

  const zipped = fflate.zipSync(files);
  return new Blob([zipped], { type: 'application/octet-stream' });
}

/** .pmx を読み込み（v3 タイル形式のみ） */
export async function loadPmx(blob: Blob): Promise<PmxLoadResult> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const unzipped = fflate.unzipSync(buf);

  const manifestBytes = unzipped['manifest.json'];
  if (!manifestBytes) throw new Error('Invalid .pmx: manifest.json not found');
  const manifest: PmxManifest = JSON.parse(new TextDecoder().decode(manifestBytes));

  // v3 形式のみ対応（全面画像の v2 以前は非対応）
  if (manifest.version !== '3.0' || !manifest.rootNodes || !manifest.tileSize) {
    throw new Error('Unsupported .pmx format (pre-v3 full-image). Not supported.');
  }

  // 各セルのタイルデータを読み込み
  const cellData: { cellId: string; tiles: PmxTileData[] }[] = [];
  const collectCells = (nodes: LayerNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'cell') {
        const tiles: PmxTileData[] = [];
        const prefix = `tiles/${n.id}/`;
        for (const name of Object.keys(unzipped)) {
          if (!name.startsWith(prefix) || !name.endsWith('.f16')) continue;
          const base = name.slice(prefix.length, -'.f16'.length);
          const [tx, ty] = base.split('_').map(Number);
          if (!Number.isInteger(tx) || !Number.isInteger(ty)) continue;
          const bytes = unzipped[name];
          const copy = bytes.slice();
          tiles.push({ tx, ty, data: new Uint16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2) });
        }
        if (tiles.length > 0) cellData.push({ cellId: n.id, tiles });
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
