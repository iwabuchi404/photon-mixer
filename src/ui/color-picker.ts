/**
 * HSV カラーピッカー + EV（HDR）+ パレット（履歴色・スウォッチ）
 *
 * 色 = 色度(HSV, sRGB) × 強度(2^EV)。EV を上げると内部リニア値が 1.0 を超える（HDR）。
 * onChange は **LinearColor（HDR可, a=1）** を返す。呼び出し側は α を別途管理する。
 */

import { srgbToLinear, linearToSrgb } from '../color/linear.js';
import type { LinearColor } from '../color/types.js';

export interface RGB { r: number; g: number; b: number } // sRGB 0-1

// HSV(0-360,0-1,0-1) → sRGB(0-1)
export function hsvToRgb(h: number, s: number, v: number): RGB {
  const c = v * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = v - c;
  return { r: r + m, g: g + m, b: b + m };
}

// sRGB(0-1) → HSV(0-360,0-1,0-1)
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max > 0 ? d / max : 0;
  return { h, s, v: max };
}

export class ColorPicker {
  private h = 0; private s = 0; private v = 1; // 色度(sRGB HSV)。初期白
  private ev = 0;                              // 強度（ストップ）。0=LDR
  private svCanvas: HTMLCanvasElement;
  private hueCanvas: HTMLCanvasElement;
  private evSlider!: HTMLInputElement;
  private onChange: (color: LinearColor) => void;
  private history: LinearColor[] = [];
  private swatches: LinearColor[] = [];
  private container: HTMLElement;

  constructor(container: HTMLElement, onChange: (color: LinearColor) => void) {
    this.container = container;
    this.onChange = onChange;
    this.swatches = this.loadSwatches();

    container.innerHTML = '';
    container.style.cssText = 'display:flex; flex-direction:column; gap:5px;';

    // SV ボックス
    this.svCanvas = document.createElement('canvas');
    this.svCanvas.width = 160; this.svCanvas.height = 100;
    this.svCanvas.style.cssText = 'width:100%; height:100px; cursor:crosshair; border:1px solid #444;';
    container.appendChild(this.svCanvas);

    // 色相バー
    this.hueCanvas = document.createElement('canvas');
    this.hueCanvas.width = 160; this.hueCanvas.height = 12;
    this.hueCanvas.style.cssText = 'width:100%; height:12px; cursor:pointer; border:1px solid #444;';
    container.appendChild(this.hueCanvas);

    // EV（強度）スライダー
    const evRow = document.createElement('div');
    evRow.className = 'ctrl-row';
    evRow.style.cssText = 'margin:0;';
    evRow.innerHTML = `<span class="ctrl-label" style="width:auto;">EV</span>`;
    this.evSlider = document.createElement('input');
    this.evSlider.type = 'range';
    this.evSlider.min = '-6'; this.evSlider.max = '6'; this.evSlider.step = '0.1'; this.evSlider.value = '0';
    this.evSlider.style.flex = '1';
    const evVal = document.createElement('span');
    evVal.className = 'ctrl-val'; evVal.id = 'cp-ev-val'; evVal.style.width = '64px'; evVal.textContent = '0.0 (×1.0)';
    evRow.appendChild(this.evSlider);
    evRow.appendChild(evVal);
    container.appendChild(evRow);
    this.evSlider.addEventListener('input', () => {
      this.ev = parseFloat(this.evSlider.value);
      this.updateReadout();
      this.emit(false);
    });
    this.evSlider.addEventListener('change', () => this.emit(true));

    // float リニア値の読み出し + HDR バッジ
    const readout = document.createElement('div');
    readout.id = 'cp-readout';
    readout.style.cssText = 'font-size:10px; color:#9a9; display:flex; gap:6px; align-items:center;';
    container.appendChild(readout);

    // 履歴 + スウォッチ
    const palette = document.createElement('div');
    palette.id = 'cp-palette';
    palette.style.cssText = 'display:flex; flex-wrap:wrap; gap:3px; margin-top:2px;';
    container.appendChild(palette);

    const addBtn = document.createElement('button');
    addBtn.textContent = '＋ 色を保存';
    addBtn.className = 'tool-btn';
    addBtn.style.cssText = 'font-size:10px; padding:3px 0;';
    addBtn.addEventListener('click', () => this.saveCurrentSwatch());
    container.appendChild(addBtn);

    this.bindSvEvents();
    this.bindHueEvents();
    this.renderAll();
  }

  /** スウォッチ取得（.pmx 保存用・LinearColor 配列） */
  getSwatches(): LinearColor[] { return this.swatches.map(c => ({ ...c })); }
  /** スウォッチ設定（.pmx 読込時） */
  setSwatches(sw: LinearColor[]): void {
    this.swatches = (sw ?? []).map(c => ({ ...c }));
    this.saveSwatches();
    this.renderPalette();
  }

  /** 外部から色をセット（sRGB・LDR） */
  setRgb(rgb: RGB): void {
    this.setLinear({ r: srgbToLinear(rgb.r), g: srgbToLinear(rgb.g), b: srgbToLinear(rgb.b), a: 1 });
  }

  /** 外部から色をセット（LinearColor・HDR可）。色度とEVに分解する */
  setLinear(color: LinearColor): void {
    const peak = Math.max(color.r, color.g, color.b, 0);
    const scale = Math.max(1, peak);
    this.ev = peak > 0 ? Math.log2(scale) : 0;
    const tone = {
      r: linearToSrgb(color.r / scale),
      g: linearToSrgb(color.g / scale),
      b: linearToSrgb(color.b / scale),
    };
    const hsv = rgbToHsv(tone.r, tone.g, tone.b);
    this.h = hsv.h; this.s = hsv.s; this.v = hsv.v;
    this.evSlider.value = this.ev.toFixed(2);
    this.renderAll();
  }

  /** 現在の色（LinearColor, HDR可, a=1） */
  private currentLinear(): LinearColor {
    const tone = hsvToRgb(this.h, this.s, this.v);
    const scale = Math.pow(2, this.ev);
    return {
      r: srgbToLinear(tone.r) * scale,
      g: srgbToLinear(tone.g) * scale,
      b: srgbToLinear(tone.b) * scale,
      a: 1,
    };
  }

  private emit(addHistory: boolean): void {
    const color = this.currentLinear();
    this.onChange(color);
    this.updateReadout();
    if (addHistory) this.pushHistory(color);
  }

  // --- 描画 ---
  private renderAll(): void {
    this.drawSv();
    this.drawHue();
    this.renderPalette();
    this.updateReadout();
  }

  private updateReadout(): void {
    const el = this.container.querySelector('#cp-readout') as HTMLElement | null;
    if (!el) return;
    const c = this.currentLinear();
    const hdr = c.r > 1 || c.g > 1 || c.b > 1;
    const f = (v: number) => v.toFixed(v >= 10 ? 1 : 3);
    el.innerHTML =
      `<span>R:${f(c.r)} G:${f(c.g)} B:${f(c.b)}</span>` +
      (hdr ? `<span style="color:#000;background:#ffb24a;border-radius:6px;padding:0 5px;font-weight:bold;">HDR</span>` : '');
    const evVal = this.container.querySelector('#cp-ev-val') as HTMLElement | null;
    if (evVal) evVal.textContent = `${this.ev >= 0 ? '+' : ''}${this.ev.toFixed(1)} (×${Math.pow(2, this.ev).toFixed(2)})`;
  }

  private drawSv(): void {
    const ctx = this.svCanvas.getContext('2d')!;
    const w = this.svCanvas.width, hgt = this.svCanvas.height;
    const base = hsvToRgb(this.h, 1, 1);
    ctx.fillStyle = `rgb(${base.r * 255},${base.g * 255},${base.b * 255})`;
    ctx.fillRect(0, 0, w, hgt);
    const gx = ctx.createLinearGradient(0, 0, w, 0);
    gx.addColorStop(0, 'rgba(255,255,255,1)'); gx.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gx; ctx.fillRect(0, 0, w, hgt);
    const gy = ctx.createLinearGradient(0, 0, 0, hgt);
    gy.addColorStop(0, 'rgba(0,0,0,0)'); gy.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = gy; ctx.fillRect(0, 0, w, hgt);
    const cxp = this.s * w, cyp = (1 - this.v) * hgt;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cxp, cyp, 4, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.arc(cxp, cyp, 5, 0, Math.PI * 2); ctx.stroke();
  }

  private drawHue(): void {
    const ctx = this.hueCanvas.getContext('2d')!;
    const w = this.hueCanvas.width, hgt = this.hueCanvas.height;
    const g = ctx.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 6; i++) {
      const c = hsvToRgb(i * 60, 1, 1);
      g.addColorStop(i / 6, `rgb(${c.r * 255},${c.g * 255},${c.b * 255})`);
    }
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, hgt);
    const hx = (this.h / 360) * w;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.strokeRect(hx - 1.5, 0, 3, hgt);
  }

  private renderPalette(): void {
    const palette = this.container.querySelector('#cp-palette') as HTMLElement;
    if (!palette) return;
    palette.innerHTML = '';
    const all = [...this.history.slice(0, 8), ...this.swatches];
    for (const color of all) {
      const hdr = color.r > 1 || color.g > 1 || color.b > 1;
      const chip = document.createElement('div');
      chip.style.cssText =
        `width:14px; height:14px; background:${this.linearToHex(color)}; ` +
        `border:1px solid ${hdr ? '#ffb24a' : '#555'}; cursor:pointer;`;
      chip.title = hdr ? 'HDR色' : '';
      chip.addEventListener('click', () => { this.setLinear(color); this.emit(false); });
      palette.appendChild(chip);
    }
  }

  // --- 操作 ---
  private bindSvEvents(): void {
    const move = (e: MouseEvent) => {
      const rect = this.svCanvas.getBoundingClientRect();
      this.s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      this.v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
      this.drawSv();
      this.emit(false);
    };
    this.svCanvas.addEventListener('mousedown', (e) => {
      move(e);
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this.emit(true); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  private bindHueEvents(): void {
    const move = (e: MouseEvent) => {
      const rect = this.hueCanvas.getBoundingClientRect();
      this.h = Math.max(0, Math.min(360, ((e.clientX - rect.left) / rect.width) * 360));
      this.drawSv(); this.drawHue();
      this.emit(false);
    };
    this.hueCanvas.addEventListener('mousedown', (e) => {
      move(e);
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this.emit(true); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  // --- 履歴・スウォッチ（LinearColor で保持） ---
  private colorKey(c: LinearColor): string {
    return `${c.r.toFixed(3)},${c.g.toFixed(3)},${c.b.toFixed(3)}`;
  }

  private pushHistory(color: LinearColor): void {
    const key = this.colorKey(color);
    this.history = [color, ...this.history.filter(c => this.colorKey(c) !== key)].slice(0, 8);
    this.renderPalette();
  }

  private saveCurrentSwatch(): void {
    const color = this.currentLinear();
    const key = this.colorKey(color);
    if (!this.swatches.some(c => this.colorKey(c) === key)) {
      this.swatches.push(color);
      this.saveSwatches();
      this.renderPalette();
    }
  }

  private loadSwatches(): LinearColor[] {
    try {
      const arr = JSON.parse(localStorage.getItem('pm-swatches-v2') || '[]');
      return Array.isArray(arr) ? arr.filter(c => c && typeof c.r === 'number') : [];
    } catch { return []; }
  }
  private saveSwatches(): void {
    localStorage.setItem('pm-swatches-v2', JSON.stringify(this.swatches));
  }

  // --- hex（表示用・クランプ済み sRGB） ---
  private linearToHex(c: LinearColor): string {
    const f = (v: number) => Math.max(0, Math.min(255, Math.round(linearToSrgb(v) * 255))).toString(16).padStart(2, '0');
    return `#${f(c.r)}${f(c.g)}${f(c.b)}`;
  }
}
