/**
 * 選択範囲マスクのジオメトリ演算（純粋関数・GPU/DOM 非依存）
 *
 * 選択マスクは tight な coverage 配列（`w*h` の `Uint8Array`, 0=未選択 / 非0=選択）で表す。
 * RenderPipeline（GPU）と UI（オーバーレイ輪郭）の双方がここを共有する。
 */

/** straight（アンプリマルチプライド）色を返すサンプラー */
export type StraightSampler = (x: number, y: number) => { r: number; g: number; b: number; a: number };

/** 選択範囲の bounds（キャンバスピクセル座標, rx/by は排他） */
export interface MaskBounds { lx: number; ty: number; rx: number; by: number }

/**
 * 多角形（キャンバス座標の頂点列）を even-odd 走査線で coverage マスク化する。
 * 頂点が 3 未満なら空マスクを返す。
 */
export function rasterizePolygon(points: { x: number; y: number }[], w: number, h: number): Uint8Array {
  const data = new Uint8Array(w * h);
  if (points.length < 3) return data;

  let minY = h, maxY = 0;
  for (const p of points) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(h - 1, Math.ceil(maxY));
  const n = points.length;
  const xs: number[] = [];

  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    // 各辺と走査線 yc の交点 x を集める（頂点列は暗黙的に閉じる）
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const pi = points[i], pj = points[j];
      if ((pi.y <= yc && pj.y > yc) || (pj.y <= yc && pi.y > yc)) {
        xs.push(pi.x + (yc - pi.y) / (pj.y - pi.y) * (pj.x - pi.x));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.round(xs[k]));
      const xb = Math.min(w, Math.round(xs[k + 1]));
      if (xb > xa) data.fill(255, y * w + xa, y * w + xb);
    }
  }
  return data;
}

/**
 * シードフィルで連結同色領域を coverage マスク化する（自動選択）。
 * `sample(x,y)` は straight 色を返す。`tolerance`(0..1) 以内の各チャンネル差＋α差を同色とみなす。
 */
export function floodFillMask(
  w: number, h: number, seedX: number, seedY: number,
  sample: StraightSampler, tolerance: number,
): Uint8Array {
  const data = new Uint8Array(w * h);
  const ix = Math.round(seedX), iy = Math.round(seedY);
  if (ix < 0 || ix >= w || iy < 0 || iy >= h) return data;

  const ref = sample(ix, iy);
  const same = (px: number, py: number): boolean => {
    const c = sample(px, py);
    return Math.abs(c.r - ref.r) <= tolerance && Math.abs(c.g - ref.g) <= tolerance
      && Math.abs(c.b - ref.b) <= tolerance && Math.abs(c.a - ref.a) <= tolerance;
  };

  const stack: [number, number][] = [[ix, iy]];
  while (stack.length > 0) {
    const [cx, cy] = stack.pop()!;
    if (data[cy * w + cx] !== 0) continue;
    let lx = cx;
    while (lx > 0 && data[cy * w + (lx - 1)] === 0 && same(lx - 1, cy)) lx--;
    let rx = cx;
    while (rx < w - 1 && data[cy * w + (rx + 1)] === 0 && same(rx + 1, cy)) rx++;
    for (let i = lx; i <= rx; i++) {
      data[cy * w + i] = 255;
      if (cy > 0 && data[(cy - 1) * w + i] === 0 && same(i, cy - 1)) stack.push([i, cy - 1]);
      if (cy < h - 1 && data[(cy + 1) * w + i] === 0 && same(i, cy + 1)) stack.push([i, cy + 1]);
    }
  }
  return data;
}

/** coverage マスクの bounds を算出する。選択ピクセルが無ければ null */
export function maskBounds(data: Uint8Array, w: number, h: number): MaskBounds | null {
  let lx = w, ty = h, rx = 0, by = 0, any = false;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[row + x] !== 0) {
        any = true;
        if (x < lx) lx = x;
        if (x + 1 > rx) rx = x + 1;
        if (y < ty) ty = y;
        if (y + 1 > by) by = y + 1;
      }
    }
  }
  return any ? { lx, ty, rx, by } : null;
}

/** coverage マスクを反転する。null は「全未選択」とみなすので結果は全選択になる */
export function invertMask(data: Uint8Array | null, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = (data && data[i]) ? 0 : 255;
  return out;
}

/**
 * coverage マスクの境界線分を抽出する。
 * 選択ピクセルと未選択ピクセルの境界（穴の縁を含む）を、ピクセル角の単位線分
 * `[x0,y0,x1,y1, ...]`（キャンバス座標）で返す。任意形状（投げ縄/自動選択）に対応。
 */
export function buildMaskContour(data: Uint8Array, w: number, h: number): number[] {
  const seg: number[] = [];
  const sel = (x: number, y: number): boolean =>
    x >= 0 && x < w && y >= 0 && y < h && data[y * w + x] !== 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!sel(x, y)) continue;
      if (!sel(x - 1, y)) seg.push(x, y, x, y + 1);             // 左辺
      if (!sel(x + 1, y)) seg.push(x + 1, y, x + 1, y + 1);     // 右辺
      if (!sel(x, y - 1)) seg.push(x, y, x + 1, y);             // 上辺
      if (!sel(x, y + 1)) seg.push(x, y + 1, x + 1, y + 1);     // 下辺
    }
  }
  return seg;
}
