/**
 * ToolSettingsStore テスト — ツール個別状態の保持・クランプ・分離を検証。
 */

import assert from 'node:assert';
import { test, describe } from 'node:test';
import { ToolSettingsStore } from '../src/ui/tool-settings.js';
import { TOOLS, PARAM_DEFS } from '../src/ui/tool-config.js';

const newStore = () => new ToolSettingsStore(TOOLS, PARAM_DEFS);

describe('ToolSettingsStore', () => {
  test('各ツールが定義の params を既定値で初期化する', () => {
    const s = newStore();
    assert.strictEqual(s.get('brush', 'size'), 20);
    assert.strictEqual(s.get('brush', 'opacity'), 100);
    assert.strictEqual(s.get('brush', 'pressureOpacity'), false);
    assert.strictEqual(s.get('bucket', 'tolerance'), 0);
    // brush は wet を持つが eraser は持たない
    assert.strictEqual(s.get('eraser', 'wet'), undefined);
  });

  test('set→get で値が保存される', () => {
    const s = newStore();
    s.set('brush', 'size', 45);
    assert.strictEqual(s.get('brush', 'size'), 45);
  });

  test('range はクランプされる', () => {
    const s = newStore();
    assert.strictEqual(s.set('brush', 'size', 999), 100);
    assert.strictEqual(s.set('brush', 'size', -5), 1);
    assert.strictEqual(s.get('brush', 'size'), 1);
  });

  test('ツール間で値が混ざらない（個別保持）', () => {
    const s = newStore();
    s.set('brush', 'size', 80);
    s.set('eraser', 'size', 12);
    assert.strictEqual(s.get('brush', 'size'), 80);
    assert.strictEqual(s.get('eraser', 'size'), 12);
  });

  test('保持していないキーへの set は無視される', () => {
    const s = newStore();
    assert.strictEqual(s.set('eraser', 'wet', 50), undefined);
    assert.strictEqual(s.get('eraser', 'wet'), undefined);
  });

  test('select は許可値のみ受理（不正値は既存維持）', () => {
    const s = newStore();
    assert.strictEqual(s.set('brush', 'mixMode', 'progressive'), 'progressive');
    assert.strictEqual(s.set('brush', 'mixMode', 'bogus'), undefined);
    assert.strictEqual(s.get('brush', 'mixMode'), 'progressive', '不正値で上書きされない');
  });

  test('checkbox はbooleanだけを正規化して保持する', () => {
    const s = newStore();
    assert.strictEqual(s.set('brush', 'pressureOpacity', true), true);
    assert.strictEqual(s.set('brush', 'pressureOpacity', 'false'), false);
    assert.strictEqual(s.set('brush', 'pressureOpacity', 'bogus'), undefined);
    assert.strictEqual(s.get('brush', 'pressureOpacity'), false);
  });

  test('getAll はツールの全保持値を返す', () => {
    const s = newStore();
    const all = s.getAll('blur');
    assert.deepStrictEqual([...all.keys()].sort(), ['size', 'stabilize']);
  });

  test('保存→別ツールへ→戻ると値が復元される', () => {
    const s = newStore();
    s.set('brush', 'size', 33);
    // 別ツールを操作しても brush の値は不変
    s.set('eraser', 'size', 7);
    assert.strictEqual(s.get('brush', 'size'), 33);
  });
});
