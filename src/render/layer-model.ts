/**
 * レイヤーモデル（3オブジェクト構造）
 *
 * 整理フォルダ / 素材セル / 効果チェーン の3オブジェクトで構成。
 * フォルダは合成上の意味を持たない（opacity/blendMode なし）。
 * 効果チェーンは素材セルまたはルート（撮影スタック）に付属し、レイヤーリストの外にある。
 *
 * 詳細: docs/decisions/ui-redesign-v2-plan.md
 */

import type { BlendMode } from './blend-renderer.js';
import type { FilterType, FilterParams } from './filter.js';
import type { CurvePoint } from '../color/curve.js';

// --- 型定義 ---

/** レイヤーツリーのノード（フォルダ or セル） */
export type LayerNode = FolderNode | CellNode;

/** 整理フォルダ: 畳む・名前をつける・子を一括表示制御のみ。合成には参加しない */
export interface FolderNode {
  id: string;
  name: string;
  kind: 'folder';
  collapsed: boolean;
  visible: boolean;         // 子を一括制御（Photoshop型）。opacity/blendMode は持たない
  children: LayerNode[];
}

/** 素材セル: 合成されて1枚の画像を作る。常に isolated。効果チェーンを付属 */
export interface CellNode {
  id: string;
  name: string;
  kind: 'cell';
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
  alphaLock: boolean;
  effects: EffectChainItem[];
}

/** 効果チェーンの1項目。セルまたはルート（撮影スタック）に付属 */
export interface EffectChainItem {
  id: string;
  name: string;
  filterType: FilterType;
  params: FilterParams;
  curvePoints?: CurvePoint[];
  visible: boolean;
  opacity: number;
}

/** 効果レイヤーの既定パラメータ（pipeline.ts から移動） */
export const DEFAULT_FILTER_PARAMS: FilterParams = {
  radius: 8, threshold: 1, intensity: 1, ev: 0,
  inLow: 0, inHigh: 1, gamma: 1, outLow: 0, outHigh: 1,
};

/** 効果のラベル */
export const EFFECT_LABELS: Record<FilterType, string> = {
  blur: 'ぼかし', glow: 'グロー', sharpen: 'シャープ', exposure: '露出', levels: 'レベル', curve: 'トーンカーブ',
};

let nodeIdCounter = 0;

/** 一意のノードIDを生成 */
export function genNodeId(prefix: string): string {
  return `${prefix}-${++nodeIdCounter}`;
}

// --- ツリーユーティリティ ---

/** ツリー内からノードをIDで検索 */
export function findNode(nodes: LayerNode[], id: string): LayerNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.kind === 'folder') {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** セルをIDで検索（フォルダは除外） */
export function findCell(nodes: LayerNode[], id: string): CellNode | null {
  const n = findNode(nodes, id);
  return n && n.kind === 'cell' ? n : null;
}

/** ノードの親の children 配列とインデックスを取得 */
export function findParent(nodes: LayerNode[], id: string): { parent: LayerNode[]; index: number } | null {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { parent: nodes, index: i };
    if (n.kind === 'folder') {
      const found = findParent(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** ツリーを平坦化してセルのみを積み順（深さ優先・下から）で返す */
export function flattenCells(nodes: LayerNode[]): CellNode[] {
  const cells: CellNode[] = [];
  for (const n of nodes) {
    if (n.kind === 'cell') {
      cells.push(n);
    } else if (n.kind === 'folder') {
      cells.push(...flattenCells(n.children));
    }
  }
  return cells;
}

/** フォルダの表示状態を考慮して、表示すべきセルのみを積み順で返す */
export function visibleCells(nodes: LayerNode[]): CellNode[] {
  const cells: CellNode[] = [];
  const walk = (list: LayerNode[], folderVisible: boolean) => {
    for (const n of list) {
      if (n.kind === 'cell') {
        if (folderVisible && n.visible) cells.push(n);
      } else if (n.kind === 'folder') {
        walk(n.children, folderVisible && n.visible);
      }
    }
  };
  walk(nodes, true);
  return cells;
}

/** ツリー内の全セルと全効果から効果をIDで検索 */
export function findEffect(nodes: LayerNode[], rootEffects: EffectChainItem[], id: string): { effect: EffectChainItem; owner: { kind: 'cell'; cellId: string } | { kind: 'root' } } | null {
  // ルート効果チェーンを先に検索
  for (const e of rootEffects) {
    if (e.id === id) return { effect: e, owner: { kind: 'root' } };
  }
  // セルの効果チェーンを検索
  const walk = (list: LayerNode[]): { effect: EffectChainItem; owner: { kind: 'cell'; cellId: string } } | null => {
    for (const n of list) {
      if (n.kind === 'cell') {
        for (const e of n.effects) {
          if (e.id === id) return { effect: e, owner: { kind: 'cell', cellId: n.id } };
        }
      } else if (n.kind === 'folder') {
        const found = walk(n.children);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(nodes);
}

/** セルを作成 */
export function createCell(name: string): CellNode {
  return {
    id: genNodeId('layer'),
    name,
    kind: 'cell',
    visible: true,
    opacity: 1.0,
    blendMode: 'normal',
    alphaLock: false,
    effects: [],
  };
}

/** フォルダを作成 */
export function createFolder(name: string): FolderNode {
  return {
    id: genNodeId('folder'),
    name,
    kind: 'folder',
    collapsed: false,
    visible: true,
    children: [],
  };
}

/** 効果チェーン項目を作成 */
export function createEffect(type: FilterType): EffectChainItem {
  return {
    id: genNodeId('effect'),
    name: `効果: ${EFFECT_LABELS[type]}`,
    filterType: type,
    params: { ...DEFAULT_FILTER_PARAMS },
    curvePoints: type === 'curve' ? [{ x: 0, y: 0 }, { x: 1, y: 1 }] : undefined,
    visible: true,
    opacity: 1.0,
  };
}

/** ノードを削除（ツリーから取り除く。削除されたノードを返す） */
export function removeNode(nodes: LayerNode[], id: string): LayerNode | null {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) {
      return nodes.splice(i, 1)[0];
    }
    if (n.kind === 'folder') {
      const removed = removeNode(n.children, id);
      if (removed) return removed;
    }
  }
  return null;
}

/** ノードを上下に移動（同じ親の中で） */
export function moveNode(nodes: LayerNode[], id: string, dir: 'up' | 'down'): boolean {
  const parent = findParent(nodes, id);
  if (!parent) return false;
  const to = dir === 'up' ? parent.index + 1 : parent.index - 1;
  if (to < 0 || to >= parent.parent.length) return false;
  const [n] = parent.parent.splice(parent.index, 1);
  parent.parent.splice(to, 0, n);
  return true;
}
