/**
 * HSV カラーピッカー + パレット（履歴色・スウォッチ）
 * 内部は sRGB（0-1）でやり取りし、呼び出し側で Linear へ変換する。
 */

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
  private h = 0; private s = 0; private v = 1; // 初期白
  private svCanvas: HTMLCanvasElement;
  private hueCanvas: HTMLCanvasElement;
  private onChange: (rgb: RGB) => void;
  private history: string[] = [];
  private swatches: string[] = [];
  private container: HTMLElement;

  constructor(container: HTMLElement, onChange: (rgb: RGB) => void) {
    this.container = container;
    this.onChange = onChange;
    this.swatches = this.loadSwatches();

    container.innerHTML = '';
    container.style.cssText = 'display:flex; flex-direction:column; gap:4px;';

    // SV ボックス
    this.svCanvas = document.createElement('canvas');
    this.svCanvas.width = 160; this.svCanvas.height = 100;
    this.svCanvas.style.cssText = 'width:160px; height:100px; cursor:crosshair; border:1px solid #444;';
    container.appendChild(this.svCanvas);

    // 色相バー
    this.hueCanvas = document.createElement('canvas');
    this.hueCanvas.width = 160; this.hueCanvas.height = 12;
    this.hueCanvas.style.cssText = 'width:160px; height:12px; cursor:pointer; border:1px solid #444;';
    container.appendChild(this.hueCanvas);

    // 履歴 + スウォッチ
    const palette = document.createElement('div');
    palette.id = 'cp-palette';
    palette.style.cssText = 'display:flex; flex-wrap:wrap; gap:3px; margin-top:2px;';
    container.appendChild(palette);

    const addBtn = document.createElement('button');
    addBtn.textContent = '＋ 色を保存';
    addBtn.className = 'tool-btn';
    addBtn.style.cssText = 'font-size:10px; padding:2px 0;';
    addBtn.addEventListener('click', () => this.saveCurrentSwatch());
    container.appendChild(addBtn);

    this.bindSvEvents();
    this.bindHueEvents();
    this.renderAll();
  }

  /** 外部から色をセット（sRGB） */
  setRgb(rgb: RGB): void {
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    this.h = hsv.h; this.s = hsv.s; this.v = hsv.v;
    this.renderAll();
  }

  private currentRgb(): RGB {
    return hsvToRgb(this.h, this.s, this.v);
  }

  private emit(addHistory: boolean): void {
    const rgb = this.currentRgb();
    this.onChange(rgb);
    if (addHistory) this.pushHistory(this.rgbToHex(rgb));
  }

  // --- 描画 ---
  private renderAll(): void {
    this.drawSv();
    this.drawHue();
    this.renderPalette();
  }

  private drawSv(): void {
    const ctx = this.svCanvas.getContext('2d')!;
    const w = this.svCanvas.width, hgt = this.svCanvas.height;
    // 色相のベース色
    const base = hsvToRgb(this.h, 1, 1);
    ctx.fillStyle = `rgb(${base.r * 255},${base.g * 255},${base.b * 255})`;
    ctx.fillRect(0, 0, w, hgt);
    // 白→透明（横）
    const gx = ctx.createLinearGradient(0, 0, w, 0);
    gx.addColorStop(0, 'rgba(255,255,255,1)'); gx.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gx; ctx.fillRect(0, 0, w, hgt);
    // 透明→黒（縦）
    const gy = ctx.createLinearGradient(0, 0, 0, hgt);
    gy.addColorStop(0, 'rgba(0,0,0,0)'); gy.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = gy; ctx.fillRect(0, 0, w, hgt);
    // カーソル
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
    for (const hex of all) {
      const chip = document.createElement('div');
      chip.style.cssText = `width:14px; height:14px; background:${hex}; border:1px solid #555; cursor:pointer;`;
      chip.title = hex;
      chip.addEventListener('click', () => {
        this.setRgb(this.hexToRgb(hex));
        this.emit(false);
      });
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

  // --- 履歴・スウォッチ ---
  private pushHistory(hex: string): void {
    this.history = [hex, ...this.history.filter(c => c !== hex)].slice(0, 8);
    this.renderPalette();
  }

  private saveCurrentSwatch(): void {
    const hex = this.rgbToHex(this.currentRgb());
    if (!this.swatches.includes(hex)) {
      this.swatches.push(hex);
      this.saveSwatches();
      this.renderPalette();
    }
  }

  private loadSwatches(): string[] {
    try { return JSON.parse(localStorage.getItem('pm-swatches') || '[]'); } catch { return []; }
  }
  private saveSwatches(): void {
    localStorage.setItem('pm-swatches', JSON.stringify(this.swatches));
  }

  // --- hex 変換 ---
  private rgbToHex(rgb: RGB): string {
    const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
    return `#${f(rgb.r)}${f(rgb.g)}${f(rgb.b)}`;
  }
  private hexToRgb(hex: string): RGB {
    return {
      r: parseInt(hex.substring(1, 3), 16) / 255,
      g: parseInt(hex.substring(3, 5), 16) / 255,
      b: parseInt(hex.substring(5, 7), 16) / 255,
    };
  }
}
