// 内部表現：float32 リニア（1.0 超の HDR 値も保持）
export interface LinearColor {
  r: number; // 0.0〜（HDR は 1.0 超可）
  g: number;
  b: number;
  a: number; // 0.0〜1.0
}

// Oklab
export interface OklabColor {
  L: number; // 輝度 0〜1
  a: number; // 緑↔赤 軸
  b: number; // 青↔黄 軸
  alpha: number;
}

// ユーザー向け表示用（クランプ済み）
export interface SRGBColor {
  r: number; // 0〜1
  g: number;
  b: number;
  a: number;
}
