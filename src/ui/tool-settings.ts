/**
 * ToolSettingsStore — ツールごとのパラメータ値を個別保持する純粋ストア。
 *
 * - 各ツールは定義（ToolDef.params）に基づき、PARAM_DEFS の既定値で初期化される。
 * - `set` は range の min/max でクランプ、select は許可値のみ受理（唯一の正規化点）。
 * - DOM / エンジンには触れない（反映は呼び出し側が PARAM_DEFS[key].apply で行う）。
 */

import type { Tool, ParamKey, ParamDef, ToolDef } from './tool-config.js';

export type ParamValue = number | string;

export class ToolSettingsStore {
  private store = new Map<Tool, Map<ParamKey, ParamValue>>();
  private defs: Record<ParamKey, ParamDef>;

  constructor(tools: ToolDef[], defs: Record<ParamKey, ParamDef>) {
    this.defs = defs;
    for (const tool of tools) {
      const m = new Map<ParamKey, ParamValue>();
      for (const key of tool.params) m.set(key, defs[key].default);
      this.store.set(tool.id, m);
    }
  }

  /** ツールが保持する全パラメータ値（読み取り専用コピー） */
  getAll(tool: Tool): Map<ParamKey, ParamValue> {
    return new Map(this.store.get(tool) ?? new Map());
  }

  /** 単一パラメータ値。未保持なら undefined */
  get(tool: Tool, key: ParamKey): ParamValue | undefined {
    return this.store.get(tool)?.get(key);
  }

  /** 値を正規化して保存。保持していないツール/キーは無視。正規化後の値を返す */
  set(tool: Tool, key: ParamKey, value: ParamValue): ParamValue | undefined {
    const m = this.store.get(tool);
    if (!m || !m.has(key)) return undefined;
    const normalized = this.normalize(key, value);
    if (normalized === undefined) return undefined; // 不正値は捨てる（既存値維持）
    m.set(key, normalized);
    return normalized;
  }

  /** 定義に基づく値の正規化。range はクランプ＋step丸め、select は許可値のみ */
  private normalize(key: ParamKey, value: ParamValue): ParamValue | undefined {
    const def = this.defs[key];
    if (def.kind === 'range') {
      let v = typeof value === 'number' ? value : parseFloat(String(value));
      if (!Number.isFinite(v)) return undefined;
      v = Math.max(def.min, Math.min(def.max, v));
      const step = def.step ?? 1;
      v = def.min + Math.round((v - def.min) / step) * step;
      return Math.max(def.min, Math.min(def.max, v));
    }
    // select: 許可値のみ
    const sv = String(value);
    return def.options.some(([opt]) => opt === sv) ? sv : undefined;
  }
}
