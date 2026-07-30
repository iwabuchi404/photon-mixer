export interface BrushBbox4x {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/**
 * 4xブラシ領域をキャンバス内へクリップし、1xピクセル境界へ外向きに揃える。
 */
export function alignBrushBbox4x(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  canvasWidth4x: number,
  canvasHeight4x: number,
  scale = 4,
): BrushBbox4x {
  const maxOriginX = Math.max(0, canvasWidth4x - scale);
  const maxOriginY = Math.max(0, canvasHeight4x - scale);
  const alignedMinX = Math.min(maxOriginX, Math.max(0, Math.floor(minX / scale) * scale));
  const alignedMinY = Math.min(maxOriginY, Math.max(0, Math.floor(minY / scale) * scale));
  const alignedMaxX = Math.max(
    alignedMinX + scale,
    Math.min(canvasWidth4x, Math.ceil(maxX / scale) * scale),
  );
  const alignedMaxY = Math.max(
    alignedMinY + scale,
    Math.min(canvasHeight4x, Math.ceil(maxY / scale) * scale),
  );

  return {
    minX: alignedMinX,
    minY: alignedMinY,
    width: Math.max(scale, alignedMaxX - alignedMinX),
    height: Math.max(scale, alignedMaxY - alignedMinY),
  };
}
