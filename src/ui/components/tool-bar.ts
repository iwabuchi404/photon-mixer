/**
 * <pm-tool-bar> — カテゴリ別の縦ツールバー（Lit / Light DOM）。
 *
 * TOOLS 定義からボタンを自動生成する（ツール追加＝定義1エントリ）。
 * - Light DOM 描画（createRenderRoot が this を返す）＝既存CSS・`document.getElementById` と互換。
 *   各ボタンは `id="tool-<id>"` を持ち、verify スクリプト互換を維持する。
 * - 反応性は素のフィールド＋`requestUpdate()` で扱う（useDefineForClassFields の落とし穴を回避）。
 */

import { LitElement, html } from 'lit';
import { CATEGORIES, TOOLS, type Tool } from '../tool-config.js';

export class ToolBar extends LitElement {
  /** 現在のアクティブツール（素のフィールド＝非リアクティブ。setActive で再描画） */
  active: Tool = 'ribbon';
  /** ツール選択時のコールバック（main 側で setTool を呼ぶ） */
  onSelect?: (id: Tool) => void;

  // Light DOM で描画（既存CSS適用・getElementById 互換のため）
  protected createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  /** アクティブツールを外部から同期（ショートカット等で切替えた時） */
  setActive(id: Tool): void {
    if (this.active === id) return;
    this.active = id;
    this.requestUpdate();
  }

  protected render() {
    return html`
      ${CATEGORIES.map(cat => html`
        <div class="pm-tool-group" data-category=${cat.id} title=${cat.label}>
          ${TOOLS.filter(t => t.category === cat.id).map(t => html`
            <button
              id=${`tool-${t.id}`}
              class=${`tool-btn${t.id === this.active ? ' active' : ''}`}
              title=${t.shortcut ? `${t.label} (${t.shortcut.toUpperCase()})` : t.label}
              @click=${() => this.onSelect?.(t.id)}
            >${t.icon}</button>`)}
        </div>`)}
    `;
  }
}

customElements.define('pm-tool-bar', ToolBar);
