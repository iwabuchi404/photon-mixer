/**
 * ツール／パラメータ定義 — UI の「単一の真実」。
 *
 * ツールバー・オプションパネル・ショートカット・個別状態の既定値は、すべてここから導出する。
 * ツール追加は TOOLS に1エントリ、パラメータ追加は PARAM_DEFS に1エントリで完結する。
 * ※このモジュールは DOM / GPU / Lit に依存しない（純粋データ＋apply関数）。
 */

import type { EngineCtx, PressureCurve } from './engine-ctx.js';
import type { BrushMixMode } from '../render/brush.js';

export type Tool =
  | 'brush' | 'eraser' | 'blur' | 'line'
  | 'spoit' | 'bucket'
  | 'select' | 'move' | 'transform';

export type Category = 'draw' | 'fill' | 'select';

export type ParamKey =
  | 'size' | 'opacity' | 'wet' | 'stabilize'
  | 'textureScale' | 'tolerance' | 'mixMode' | 'curve';

/** コントロール種別ごとの定義（判別可能ユニオン） */
export type ParamDef =
  | {
      key: ParamKey; kind: 'range'; label: string;
      min: number; max: number; step?: number; unit?: string;
      default: number; apply(v: number, e: EngineCtx): void;
    }
  | {
      key: ParamKey; kind: 'select'; label: string;
      options: [value: string, label: string][];
      default: string; apply(v: string, e: EngineCtx): void;
    };

export interface ToolDef {
  id: Tool;
  label: string;
  icon: string;
  category: Category;
  shortcut?: string;       // 単キーショートカット（小文字）
  params: ParamKey[];      // 表示・個別保持するパラメータ
}

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'draw', label: '描画' },
  { id: 'fill', label: '色・塗り' },
  { id: 'select', label: '選択・変形' },
];

/** パラメータ定義。range の値はスライダー整数値（apply 内で 0..1 等へ換算） */
export const PARAM_DEFS: Record<ParamKey, ParamDef> = {
  size:         { key: 'size',         kind: 'range', label: 'サイズ', min: 1, max: 100, unit: 'px', default: 20, apply: (v, e) => e.setSize(v) },
  opacity:      { key: 'opacity',      kind: 'range', label: '不透明', min: 1, max: 100, unit: '%',  default: 100, apply: (v, e) => e.setOpacity(v / 100) },
  wet:          { key: 'wet',          kind: 'range', label: 'にじみ', min: 0, max: 100, unit: '%',  default: 0,   apply: (v, e) => e.setWet(v / 100) },
  stabilize:    { key: 'stabilize',    kind: 'range', label: '補正',   min: 0, max: 100, unit: '%',  default: 30,  apply: (v, e) => e.setStabilize(v) },
  textureScale: { key: 'textureScale', kind: 'range', label: 'スケール', min: 1, max: 20, unit: 'x', default: 1,   apply: (v, e) => e.setTextureScale(v) },
  tolerance:    { key: 'tolerance',    kind: 'range', label: '許容値', min: 0, max: 100, unit: '%',  default: 0,   apply: (v, e) => e.setTolerance(v / 100) },
  mixMode:      {
    key: 'mixMode', kind: 'select', label: '方式', default: 'progressive',
    options: [['stamp', 'スタンプ'], ['progressive', '引きずり']],
    apply: (v, e) => e.setMixMode(v as BrushMixMode),
  },
  curve:        {
    key: 'curve', kind: 'select', label: '筆圧', default: 'linear',
    options: [['smooth', '標準'], ['linear', 'リニア'], ['ease-in', '入り遅'], ['ease-out', '入り早']],
    apply: (v, e) => e.setPressureCurve(v as PressureCurve),
  },
};

export const TOOLS: ToolDef[] = [
  { id: 'brush',     label: 'ブラシ',   icon: '🖌️', category: 'draw',   shortcut: 'b', params: ['size', 'opacity', 'wet', 'mixMode', 'stabilize', 'curve', 'textureScale'] },
  { id: 'eraser',    label: '消しゴム', icon: '🧹', category: 'draw',   shortcut: 'e', params: ['size', 'opacity', 'stabilize', 'curve'] },
  { id: 'blur',      label: 'ぼかし',   icon: '💧', category: 'draw',   shortcut: 'u', params: ['size', 'stabilize'] },
  { id: 'line',      label: '直線',     icon: '📏', category: 'draw',   shortcut: 'v', params: ['size', 'opacity'] },
  { id: 'spoit',     label: 'スポイト', icon: '🧪', category: 'fill',   shortcut: 'i', params: [] },
  { id: 'bucket',    label: 'バケツ',   icon: '🪣', category: 'fill',   shortcut: 'g', params: ['tolerance'] },
  { id: 'select',    label: '選択',     icon: '⬚', category: 'select', shortcut: 'm', params: ['tolerance'] },
  { id: 'move',      label: '移動',     icon: '✥', category: 'select', shortcut: 'w', params: [] },
  { id: 'transform', label: '変形',     icon: '⤢', category: 'select', shortcut: 't', params: [] },
];

/** id からツール定義を引く */
export function getToolDef(id: Tool): ToolDef {
  const def = TOOLS.find(t => t.id === id);
  if (!def) throw new Error(`unknown tool: ${id}`);
  return def;
}
