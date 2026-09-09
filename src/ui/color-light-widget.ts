/**
 * K1: 色の光量ウィジェット（描画エリア内の浮動小物）。
 *
 * カーソル追従はうざいのでやらない。代わりに:
 * - 描画エリアの隅に常駐（初期: 右上）。ドラッグで任意位置へ移動可（位置は保存）
 * - 縮小状態: 現色チップ。HDR（>1.0）なら現色で発光＋EV表示
 * - ホバー: 展開してEVスライダー（カラーピッカーと同一 state、双方向同期）
 * - 描画中は pointer-events 無効＋半透明（描画の邪魔をしない）
 * DOM 動的生成（index.html 非依存）。
 */

import { linearToSrgb } from '../color/linear.js';
import type { LinearColor } from '../color/types.js';

export interface ColorLightWidgetCallbacks {
  getColor(): LinearColor;
  getEV(): number;
  setEV(ev: number): void;
}

const POS_KEY = 'pm-light-widget-pos';
const CHIP = 28;

function toHex(c: LinearColor): string {
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(linearToSrgb(v) * 255))).toString(16).padStart(2, '0');
  return `#${f(c.r)}${f(c.g)}${f(c.b)}`;
}

export class ColorLightWidget {
  private el: HTMLElement;
  private chip: HTMLElement;
  private evLabel: HTMLElement;
  private panel: HTMLElement;
  private slider: HTMLInputElement;
  private panelVal: HTMLElement;
  private dragging = false;

  constructor(private cb: ColorLightWidgetCallbacks) {
    const el = document.createElement('div');
    el.id = 'color-light-widget';
    el.style.cssText = [
      'position:fixed', 'z-index:2500', 'user-select:none',
      'font-family:monospace', 'font-size:10px', 'color:#ddd',
    ].join(';');

    const chip = document.createElement('div');
    chip.style.cssText = [
      `width:${CHIP}px`, `height:${CHIP}px`, 'border-radius:6px',
      'border:1px solid #555', 'cursor:grab',
    ].join(';');

    const evLabel = document.createElement('div');
    evLabel.style.cssText = 'margin-top:2px;text-align:center;color:#ffb24a;display:none;';

    const panel = document.createElement('div');
    panel.style.cssText = [
      'display:none', 'margin-top:4px', 'background:rgba(20,20,20,0.94)',
      'border:1px solid #555', 'border-radius:6px', 'padding:6px 8px', 'width:170px',
    ].join(';');
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '-6'; slider.max = '6'; slider.step = '0.1';
    slider.style.cssText = 'flex:1;accent-color:#ff7a1a;';
    slider.addEventListener('input', () => {
      this.cb.setEV(parseFloat(slider.value));
      this.refresh();
    });
    const panelVal = document.createElement('span');
    panelVal.style.cssText = 'color:#fff;white-space:nowrap;';
    row.appendChild(slider);
    row.appendChild(panelVal);
    panel.appendChild(row);

    el.appendChild(chip);
    el.appendChild(evLabel);
    el.appendChild(panel);
    document.body.appendChild(el);

    this.el = el;
    this.chip = chip;
    this.evLabel = evLabel;
    this.panel = panel;
    this.slider = slider;
    this.panelVal = panelVal;

    // ホバーで展開／離れて閉じる
    el.addEventListener('mouseenter', () => { this.panel.style.display = 'block'; });
    el.addEventListener('mouseleave', () => {
      if (!this.dragging) this.panel.style.display = 'none';
    });

    // ドラッグで移動（スライダー上は除外）
    chip.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('input')) return;
      e.preventDefault();
      this.dragging = true;
      chip.style.cursor = 'grabbing';
      const sx = e.clientX, sy = e.clientY;
      const rect = el.getBoundingClientRect();
      const ox = sx - rect.left, oy = sy - rect.top;
      const move = (ev: PointerEvent) => {
        this.place(ev.clientX - ox, ev.clientY - oy, true);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.dragging = false;
        chip.style.cursor = 'grab';
        this.panel.style.display = 'none';
        this.savePos();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    window.addEventListener('resize', () => this.clampIntoCanvas());
    // 描画中は操作を受け付けない（main 側の編集なしで完結）
    window.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement | null;
      if (e.button === 0 && t?.closest?.('#canvas')) this.setInteractive(false);
    }, true);
    window.addEventListener('pointerup', () => this.setInteractive(true), true);
    this.restorePos();
    this.refresh();
  }

  /** 描画中は操作を受け付けない */
  setInteractive(enabled: boolean): void {
    this.el.style.pointerEvents = enabled ? '' : 'none';
    this.el.style.opacity = enabled ? '1' : '0.35';
  }

  /** 現色・EV を反映 */
  refresh(): void {
    const c = this.cb.getColor();
    const ev = this.cb.getEV();
    const hex = toHex(c);
    const hdr = c.r > 1 || c.g > 1 || c.b > 1;
    this.chip.style.background = hex;
    this.chip.style.boxShadow = hdr
      ? `0 0 10px 2px ${hex}, 0 0 3px 1px ${hex}`
      : 'none';
    this.chip.style.borderColor = hdr ? '#ffb24a' : '#555';
    this.evLabel.style.display = hdr ? 'block' : 'none';
    if (hdr) this.evLabel.textContent = `+${ev.toFixed(1)}`;
    if (document.activeElement !== this.slider) this.slider.value = String(ev);
    this.panelVal.textContent = `${ev >= 0 ? '+' : ''}${ev.toFixed(1)} (×${Math.pow(2, ev).toFixed(2)})`;
  }

  private canvasRect(): DOMRect | null {
    return document.getElementById('canvas')?.getBoundingClientRect() ?? null;
  }

  private place(x: number, y: number, save: boolean): void {
    const rect = this.canvasRect();
    if (!rect) { this.el.style.left = `${x}px`; this.el.style.top = `${y}px`; return; }
    const w = this.el.offsetWidth || 60, h = this.el.offsetHeight || 60;
    const cx = Math.max(rect.left + 4, Math.min(rect.right - w - 4, x));
    const cy = Math.max(rect.top + 4, Math.min(rect.bottom - h - 4, y));
    this.el.style.left = `${cx}px`;
    this.el.style.top = `${cy}px`;
    if (save) {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({
          dx: rect.right - cx,
          dy: cy - rect.top,
        }));
      } catch { /* ignore */ }
    }
  }

  private restorePos(): void {
    const rect = this.canvasRect();
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw && rect) {
        const p = JSON.parse(raw) as { dx: number; dy: number };
        this.place(rect.right - p.dx, rect.top + p.dy, false);
        return;
      }
    } catch { /* ignore */ }
    // 初期: 描画エリア右上
    if (rect) this.place(rect.right - 64, rect.top + 12, false);
    else { this.el.style.right = '280px'; this.el.style.top = '12px'; }
  }

  private clampIntoCanvas(): void {
    const r = this.el.getBoundingClientRect();
    this.place(r.left, r.top, false);
  }

  private savePos(): void {
    const r = this.el.getBoundingClientRect();
    this.place(r.left, r.top, true);
  }
}
