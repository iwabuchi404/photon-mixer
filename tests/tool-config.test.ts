/**
 * ツール／パラメータ定義の整合性テスト（バグ予防の要）。
 * 定義漏れ・範囲外既定・ショートカット重複などを CI 段階で検出する。
 */

import assert from 'node:assert';
import { test, describe } from 'node:test';
import { TOOLS, CATEGORIES, PARAM_DEFS, getToolDef } from '../src/ui/tool-config.js';
import type { EngineCtx } from '../src/ui/engine-ctx.js';

describe('tool-config 整合性', () => {
  test('全ツールの params が PARAM_DEFS に存在する', () => {
    for (const t of TOOLS) {
      for (const key of t.params) {
        assert.ok(key in PARAM_DEFS, `${t.id} の param '${key}' が PARAM_DEFS に無い`);
      }
    }
  });

  test('PARAM_DEFS の key とレコードキーが一致する', () => {
    for (const [k, def] of Object.entries(PARAM_DEFS)) {
      assert.strictEqual(def.key, k, `PARAM_DEFS['${k}'].key が一致しない`);
    }
  });

  test('range の default が [min,max] 内', () => {
    for (const def of Object.values(PARAM_DEFS)) {
      if (def.kind === 'range') {
        assert.ok(def.default >= def.min && def.default <= def.max,
          `${def.key} の default=${def.default} が範囲外`);
      }
    }
  });

  test('select の default が options に含まれる', () => {
    for (const def of Object.values(PARAM_DEFS)) {
      if (def.kind === 'select') {
        assert.ok(def.options.some(([v]) => v === def.default), `${def.key} の default が options に無い`);
      }
    }
  });

  test('ツールIDが一意', () => {
    const ids = TOOLS.map(t => t.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'ツールIDに重複');
  });

  test('ショートカットが一意', () => {
    const sc = TOOLS.map(t => t.shortcut).filter(Boolean);
    assert.strictEqual(new Set(sc).size, sc.length, 'ショートカットに重複');
  });

  test('各ツールの category が CATEGORIES に存在する', () => {
    const cats = new Set(CATEGORIES.map(c => c.id));
    for (const t of TOOLS) assert.ok(cats.has(t.category), `${t.id} の category '${t.category}' が未定義`);
  });

  test('getToolDef は定義を返し、未知IDで投げる', () => {
    assert.strictEqual(getToolDef('brush').label, 'ブラシ');
    assert.throws(() => getToolDef('unknown' as any));
  });

  test('apply が EngineCtx の対応メソッドを正しく呼ぶ', () => {
    const calls: string[] = [];
    const mock: EngineCtx = {
      setSize: (v) => calls.push(`size:${v}`),
      setOpacity: (v) => calls.push(`opacity:${v}`),
      setWet: (v) => calls.push(`wet:${v}`),
      setStabilize: (v) => calls.push(`stab:${v}`),
      setMixMode: (v) => calls.push(`mix:${v}`),
      setPressureCurve: (v) => calls.push(`curve:${v}`),
      setTextureScale: (v) => calls.push(`tex:${v}`),
      setTolerance: (v) => calls.push(`tol:${v}`),
    };
    (PARAM_DEFS.size as any).apply(40, mock);
    (PARAM_DEFS.opacity as any).apply(50, mock);   // 50% → 0.5
    (PARAM_DEFS.tolerance as any).apply(20, mock);  // 20% → 0.2
    (PARAM_DEFS.mixMode as any).apply('progressive', mock);
    assert.deepStrictEqual(calls, ['size:40', 'opacity:0.5', 'tol:0.2', 'mix:progressive']);
  });
});
