/**
 * K3: 表示露出のペン位置 HUD。
 * 中クリックでカーソル位置に開き、スライダー／ホイールで表示露出を変える。
 * 再中クリック・Esc・外側クリックで閉じる。無彩色・枠スタイル（K1 の発光とは区別）。
 * DOM 動的生成（index.html 非依存）。
 */

export interface LightHudCallbacks {
  /** 現在の表示露出 EV を読む */
  getEV: () => number;
  /** 表示露出 EV を書く（エンジン反映まで行う） */
  setEV: (ev: number) => void;
}

const EV_MIN = -6;
const EV_MAX = 6;

export function clampEV(ev: number): number {
  return Math.max(EV_MIN, Math.min(EV_MAX, ev));
}

export function formatEV(ev: number): string {
  const sign = ev >= 0 ? '+' : '';
  return `${sign}${ev.toFixed(1)} EV (×${Math.pow(2, ev).toFixed(2)})`;
}

export class LightHud {
  private el: HTMLElement | null = null;
  private slider: HTMLInputElement | null = null;
  private readout: HTMLElement | null = null;

  constructor(private cb: LightHudCallbacks) {}

  isOpen(): boolean {
    return this.el !== null;
  }

  /** カーソル位置（client 座標）に開く。画面内に収める */
  open(clientX: number, clientY: number): void {
    this.close();
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'z-index:3000',
      'background:rgba(20,20,20,0.94)', 'color:#ddd',
      'border:1px solid #555', 'border-radius:6px',
      'padding:8px 10px', 'font-family:monospace', 'font-size:11px',
      'user-select:none', 'white-space:nowrap',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '表示露出';
    title.style.cssText = 'color:#888;font-size:10px;letter-spacing:0.1em;margin-bottom:6px;';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(EV_MIN);
    slider.max = String(EV_MAX);
    slider.step = '0.1';
    slider.style.cssText = 'width:140px;accent-color:#ff7a1a;';
    slider.addEventListener('input', () => {
      this.cb.setEV(parseFloat(slider.value));
      this.refresh();
    });
    // HUD 内ホイールも露出に使う（ページスクロール抑止は呼び出し側）
    slider.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

    const readout = document.createElement('span');
    readout.style.cssText = 'color:#fff;min-width:110px;text-align:right;';

    row.appendChild(slider);
    row.appendChild(readout);
    el.appendChild(title);
    el.appendChild(row);
    document.body.appendChild(el);

    // 画面内に収める（推定サイズ 220x64）
    const x = Math.max(4, Math.min(window.innerWidth - 230, clientX - 110));
    const y = Math.max(4, Math.min(window.innerHeight - 80, clientY - 70));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;

    this.el = el;
    this.slider = slider;
    this.readout = readout;
    this.refresh();
  }

  close(): void {
    this.el?.remove();
    this.el = null;
    this.slider = null;
    this.readout = null;
  }

  /** 開いている HUD を現在の EV に同期 */
  refresh(): void {
    if (!this.el || !this.slider || !this.readout) return;
    const ev = clampEV(this.cb.getEV());
    if (document.activeElement !== this.slider) this.slider.value = String(ev);
    this.readout.textContent = formatEV(ev);
  }

  /** HUD 要素内か */
  contains(target: EventTarget | null): boolean {
    return !!this.el && !!target && target instanceof Node && this.el.contains(target);
  }
}
