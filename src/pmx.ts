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
import { TONEMAP_IDS, DISPLAY_MODE_IDS, VIEW_EV_MIN, VIEW_EV_MAX, type TonemapId, type DisplayModeId } from './color/display.js';

const PMX_VERSION = '3.0';
export const PMX_TILE_SIZE = 512;
const MAX_PMX_INPUT_BYTES = 1024 * 1024 * 1024;
const MAX_PMX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PMX_ENTRIES = 100_000;
const MAX_PMX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_CANVAS_DIMENSION = 8192;
const MAX_NODE_COUNT = 4096;
const MAX_FOLDER_DEPTH = 64;
const VALID_BLEND_MODES = new Set(['normal', 'multiply', 'screen', 'overlay', 'add']);
const VALID_FILTER_TYPES = new Set(['blur', 'glow', 'sharpen', 'exposure', 'levels', 'curve']);
const MAX_SWATCHES = 1024;

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

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid .pmx: ${label} must be an object`);
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid .pmx: invalid ${label}`);
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid .pmx: invalid ${label}`);
}

function validateEffect(value: unknown, ids: Set<string>): EffectChainItem {
  assertRecord(value, 'effect');
  assertSafeId(value.id, 'effect id');
  if (ids.has(value.id)) throw new Error(`Invalid .pmx: duplicate effect id ${value.id}`);
  ids.add(value.id);
  if (typeof value.name !== 'string' || typeof value.filterType !== 'string' || !VALID_FILTER_TYPES.has(value.filterType)) {
    throw new Error('Invalid .pmx: invalid effect');
  }
  if (typeof value.visible !== 'boolean') throw new Error('Invalid .pmx: invalid effect visibility');
  assertFiniteNumber(value.opacity, 'effect opacity');
  if (value.opacity < 0 || value.opacity > 1) throw new Error('Invalid .pmx: effect opacity out of range');
  assertRecord(value.params, 'effect params');
  for (const key of ['radius', 'threshold', 'intensity', 'ev', 'inLow', 'inHigh', 'gamma', 'outLow', 'outHigh']) {
    assertFiniteNumber(value.params[key], `effect param ${key}`);
  }
  if (value.curvePoints !== undefined) {
    if (!Array.isArray(value.curvePoints)) throw new Error('Invalid .pmx: invalid curve points');
    for (const point of value.curvePoints) {
      assertRecord(point, 'curve point');
      assertFiniteNumber(point.x, 'curve point x');
      assertFiniteNumber(point.y, 'curve point y');
    }
  }
  return value as unknown as EffectChainItem;
}

function validateNode(
  value: unknown,
  nodeIds: Set<string>,
  effectIds: Set<string>,
  cellIds: Set<string>,
  depth = 0,
): asserts value is LayerNode {
  assertRecord(value, 'layer node');
  if (depth > MAX_FOLDER_DEPTH) throw new Error('Invalid .pmx: layer tree too deep');
  if (nodeIds.size >= MAX_NODE_COUNT) throw new Error('Invalid .pmx: too many layer nodes');
  assertSafeId(value.id, 'layer id');
  if (nodeIds.has(value.id)) throw new Error(`Invalid .pmx: duplicate layer id ${value.id}`);
  nodeIds.add(value.id);
  if (typeof value.name !== 'string' || typeof value.visible !== 'boolean') throw new Error('Invalid .pmx: invalid layer node');
  if (value.kind === 'folder') {
    if (typeof value.collapsed !== 'boolean' || !Array.isArray(value.children)) throw new Error('Invalid .pmx: invalid folder');
    for (const child of value.children) validateNode(child, nodeIds, effectIds, cellIds, depth + 1);
  } else if (value.kind === 'cell') {
    if (!VALID_BLEND_MODES.has(String(value.blendMode)) || typeof value.alphaLock !== 'boolean' || !Array.isArray(value.effects)) {
      throw new Error('Invalid .pmx: invalid cell');
    }
    assertFiniteNumber(value.opacity, 'cell opacity');
    if (value.opacity < 0 || value.opacity > 1) throw new Error('Invalid .pmx: cell opacity out of range');
    cellIds.add(value.id);
    for (const effect of value.effects) validateEffect(effect, effectIds);
  } else {
    throw new Error('Invalid .pmx: invalid layer kind');
  }
}

function validateDocumentSettings(value: unknown): void {
  assertRecord(value, 'document settings');
  const view = value.view;
  assertRecord(view, 'view settings');
  assertFiniteNumber(view.viewEV, 'view EV');
  // UI のスライダー範囲を超えると、UI が表示する露出とエンジンに実際に渡る
  // 露出がずれて、再保存時に viewEV が静かに書き換わるため範囲外を弾く
  if (view.viewEV < VIEW_EV_MIN || view.viewEV > VIEW_EV_MAX) {
    throw new Error(`Invalid .pmx: view EV out of range (${VIEW_EV_MIN}..${VIEW_EV_MAX})`);
  }
  // enum は indexOf() が -1 を返すと uniform に -1 が入り、WGSL 側で
  // 意図しない既定演算子へ化けるため、メンバーを厳密に検証する
  if (!TONEMAP_IDS.includes(view.tonemap as TonemapId)) throw new Error('Invalid .pmx: unknown tonemap');
  if (!DISPLAY_MODE_IDS.includes(view.viewMode as DisplayModeId)) throw new Error('Invalid .pmx: unknown view mode');
  if (!Array.isArray(value.swatches) || value.swatches.length > MAX_SWATCHES) {
    throw new Error('Invalid .pmx: invalid swatches');
  }
  for (const swatch of value.swatches) {
    assertRecord(swatch, 'swatch');
    // r/g/b は HDR（1.0 超）を保持しうるので有限性のみ。a は 0..1。
    assertFiniteNumber(swatch.r, 'swatch r');
    assertFiniteNumber(swatch.g, 'swatch g');
    assertFiniteNumber(swatch.b, 'swatch b');
    assertFiniteNumber(swatch.a, 'swatch a');
    if (swatch.a < 0 || swatch.a > 1) throw new Error('Invalid .pmx: swatch alpha out of range');
  }
}

function validateManifest(value: unknown): { manifest: PmxManifest; cellIds: Set<string> } {
  assertRecord(value, 'manifest');
  if (value.version !== '3.0' || value.tileSize !== PMX_TILE_SIZE) throw new Error('Unsupported .pmx format');
  assertFiniteNumber(value.width, 'canvas width');
  assertFiniteNumber(value.height, 'canvas height');
  if (!Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 || value.width > MAX_CANVAS_DIMENSION || value.height > MAX_CANVAS_DIMENSION) {
    throw new Error('Invalid .pmx: canvas size out of range');
  }
  if (!Array.isArray(value.rootNodes) || !Array.isArray(value.rootEffects)) throw new Error('Invalid .pmx: layer tree');
  const nodeIds = new Set<string>();
  const effectIds = new Set<string>();
  const cellIds = new Set<string>();
  for (const node of value.rootNodes) validateNode(node, nodeIds, effectIds, cellIds);
  for (const effect of value.rootEffects) validateEffect(effect, effectIds);
  if (cellIds.size === 0) throw new Error('Invalid .pmx: no cell');
  assertSafeId(value.activeCellId, 'active cell id');
  if (!cellIds.has(value.activeCellId)) throw new Error('Invalid .pmx: active cell not found');
  if (typeof value.app !== 'string') throw new Error('Invalid .pmx: app');
  if (value.documentSettings !== undefined) validateDocumentSettings(value.documentSettings);
  return { manifest: value as unknown as PmxManifest, cellIds };
}

function validateTileEntry(name: string, bytes: Uint8Array, cellIds: Set<string>, width: number, height: number): void {
  const parts = name.split('/');
  if (parts.length !== 3 || parts[0] !== 'tiles' || !cellIds.has(parts[1]) || !parts[2].endsWith('.f16')) {
    throw new Error(`Invalid .pmx tile path ${name}`);
  }
  const base = parts[2].slice(0, -4);
  const coords = base.split('_');
  if (coords.length !== 2) throw new Error(`Invalid .pmx tile path ${name}`);
  const tx = Number(coords[0]);
  const ty = Number(coords[1]);
  if (!Number.isInteger(tx) || !Number.isInteger(ty) || tx < 0 || ty < 0 || tx >= Math.ceil(width / PMX_TILE_SIZE) || ty >= Math.ceil(height / PMX_TILE_SIZE)) {
    throw new Error(`Invalid .pmx tile coordinates ${name}`);
  }
  const tileW = Math.min(PMX_TILE_SIZE, width - tx * PMX_TILE_SIZE);
  const tileH = Math.min(PMX_TILE_SIZE, height - ty * PMX_TILE_SIZE);
  if (bytes.byteLength !== tileW * tileH * 8) throw new Error(`Invalid .pmx tile size ${name}`);
}

function unzipPmx(buf: Uint8Array): fflate.Unzipped {
  let entries = 0;
  let expandedBytes = 0;
  return fflate.unzipSync(buf, {
    filter: (info) => {
      entries++;
      expandedBytes += info.originalSize;
      if (entries > MAX_PMX_ENTRIES || info.originalSize > MAX_PMX_EXPANDED_BYTES || expandedBytes > MAX_PMX_EXPANDED_BYTES) {
        throw new Error('Invalid .pmx: expanded data is too large');
      }
      return true;
    },
  });
}

export async function loadPmx(blob: Blob): Promise<PmxLoadResult> {
  if (blob.size > MAX_PMX_INPUT_BYTES) throw new Error('Invalid .pmx: file is too large');
  const buf = new Uint8Array(await blob.arrayBuffer());
  const unzipped = unzipPmx(buf);
  const names = Object.keys(unzipped);
  if (names.length > MAX_PMX_ENTRIES) throw new Error('Invalid .pmx: too many entries');
  const expandedBytes = names.reduce((sum, name) => sum + unzipped[name].byteLength, 0);
  if (expandedBytes > MAX_PMX_EXPANDED_BYTES) throw new Error('Invalid .pmx: expanded data is too large');

  const manifestBytes = unzipped['manifest.json'];
  if (!manifestBytes || manifestBytes.byteLength > MAX_PMX_MANIFEST_BYTES) throw new Error('Invalid .pmx: invalid manifest');
  const parsed: unknown = JSON.parse(new TextDecoder().decode(manifestBytes));
  const { manifest, cellIds } = validateManifest(parsed);
  for (const name of names) {
    if (name.startsWith('tiles/')) validateTileEntry(name, unzipped[name], cellIds, manifest.width, manifest.height);
  }

  const cellData: { cellId: string; tiles: PmxTileData[] }[] = [];
  const collectCells = (nodes: LayerNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'cell') {
        const tiles: PmxTileData[] = [];
        const prefix = `tiles/${n.id}/`;
        for (const name of names) {
          if (!name.startsWith(prefix) || !name.endsWith('.f16')) continue;
          const base = name.slice(prefix.length, -'.f16'.length);
          const [tx, ty] = base.split('_').map(Number);
          const copy = unzipped[name].slice();
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
    rootEffects: manifest.rootEffects,
    cellData,
    documentSettings: manifest.documentSettings,
  };
}
