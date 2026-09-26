/**
 * ストローク管理
 * 現在のストロークの点列保持、筆圧→サイズマッピング
 */

import type { PointerPoint } from './input.js';
import { sampleCurve, type CurvePoint } from '../color/curve.js';

/**
 * ストロークの点（筆圧→サイズ変換済み）
 */
export interface StrokePoint extends PointerPoint {
  size: number; // 補正後のサイズ
  // progressive 混色用の点ごとの色（リニア、未指定時は uniform のブラシ色を使う）
  color?: { r: number; g: number; b: number; a: number };
}

/**
 * 筆圧→サイズマッピング設定
 */
export interface PressureSizeConfig {
  baseSize: number;      // 基本サイズ（pressure=0）
  maxSize: number;       // 最大サイズ（pressure=1）
  curve: 'linear' | 'ease-in' | 'ease-out' | 'smooth' | 'custom'; // カーブタイプ
  /**
   * 最小サイズ比（0..1）。UI の「最小サイズ %」が maxSize から baseSize を
   * 求める際の換算率。0 で筆圧ゼロ時に線幅ゼロ（ヘアライン化）まで落ちる。
   */
  minSizeRatio: number;
  /** curve='custom' 時の制御点列（[0,1]²、x昇順）。LUT 化して評価する */
  customCurve: CurvePoint[];
}

/**
 * デフォルト設定
 */
const DEFAULT_PRESSURE_CONFIG: PressureSizeConfig = {
  baseSize: 2,      // 最低2px
  maxSize: 20,     // 最大20px
  curve: 'smooth',  // 滑らかなカーブ
  minSizeRatio: 0.1,
  customCurve: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
};

/**
 * ストロークマネージャー
 */
export class StrokeManager {
  private currentStroke: StrokePoint[] = [];
  private pressureConfig: PressureSizeConfig;
  private isDrawing = false; // ストローク状態フラグ

  constructor(config: Partial<PressureSizeConfig> = {}) {
    this.pressureConfig = { ...DEFAULT_PRESSURE_CONFIG, ...config };
  }

  /**
   * 新しいストロークを開始
   */
  beginStroke(): void {
    this.currentStroke = [];
    this.isDrawing = true;
  }

  /**
   * 点を追加
   */
  addPoint(point: PointerPoint): void {
    const strokePoint: StrokePoint = {
      ...point,
      size: this.pressureToSize(point.pressure),
    };
    this.currentStroke.push(strokePoint);
  }

  /**
   * ストロークを終了
   */
  endStroke(): StrokePoint[] {
    const stroke = [...this.currentStroke];
    this.currentStroke = [];
    this.isDrawing = false;
    return stroke;
  }

  /**
   * 補間済みのストロークを確定（ペンアップ時用）
   * ストロークマネージャーの設定を使ってサイズを計算
   */
  finalizeStroke(points: PointerPoint[]): StrokePoint[] {
    return points.map(p => ({
      ...p,
      size: this.pressureToSize(p.pressure),
    }));
  }

  /**
   * 現在のストロークを取得
   */
  getCurrentStroke(): StrokePoint[] {
    return [...this.currentStroke];
  }

  /**
   * 筆圧をサイズに変換（非線形マッピング）
   */
  private pressureToSize(pressure: number): number {
    const { baseSize, maxSize, curve } = this.pressureConfig;
    const range = maxSize - baseSize;

    let t: number;

    switch (curve) {
      case 'linear':
        t = pressure;
        break;

      case 'ease-in':
        // 徐々に増加
        t = pressure * pressure;
        break;

      case 'ease-out':
        // 最初に大きく、その後緩やかに
        t = 1 - (1 - pressure) * (1 - pressure);
        break;

      case 'smooth':
        // 3次スムーズ: 3t^2 - 2t^3 (Hermite)
        t = pressure * pressure * (3 - 2 * pressure);
        break;

      case 'custom': {
        // ユーザー編集カーブ。256エントリLUTを線形補間で参照する。
        const lut = this.getCustomLut();
        const x = Math.max(0, Math.min(1, pressure)) * 255;
        const i = Math.floor(x);
        const f = x - i;
        t = lut[i] + (lut[Math.min(255, i + 1)] - lut[i]) * f;
        break;
      }

      default:
        t = pressure;
    }

    return baseSize + range * t;
  }

  /**
   * 設定を更新
   */
  updatePressureConfig(config: Partial<PressureSizeConfig>): void {
    this.pressureConfig = { ...this.pressureConfig, ...config };
    // 最小サイズ比の更新だけの場合は baseSize を換算し直す
    // （baseSize を個別指定した場合はそちらを優先＝従来互換）
    if (config.minSizeRatio !== undefined && config.baseSize === undefined) {
      this.pressureConfig.baseSize = this.pressureConfig.maxSize * this.pressureConfig.minSizeRatio;
    }
    if (config.customCurve !== undefined) this.customLut = null;
  }

  /** カスタムカーブ LUT（遅延生成してキャッシュ） */
  private customLut: number[] | null = null;
  private getCustomLut(): number[] {
    if (!this.customLut) {
      const pts = this.pressureConfig.customCurve;
      this.customLut = sampleCurve(pts.length >= 2 ? pts : [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    }
    return this.customLut;
  }

  /**
   * 設定を取得
   */
  getPressureConfig(): PressureSizeConfig {
    return { ...this.pressureConfig };
  }

  /**
   * アクティブなストロークがあるか
   */
  hasActiveStroke(): boolean {
    return this.isDrawing && this.currentStroke.length > 0;
  }

  /**
   * ストロークをクリア
   */
  clear(): void {
    this.currentStroke = [];
    this.isDrawing = false;
  }
}

/**
 * 履歴に積む操作レコード
 * - stroke: 通常描画 or 消しゴム（points は色を焼き込み済み）
 * - fill  : バケツ塗り（実行直後の committed スナップショットを保持し、rebake で上書き再現）
 */
export type StrokeRecord =
  | { kind: 'stroke'; points: StrokePoint[]; erase: boolean; alphaLock?: boolean; pressureOpacity?: boolean; brushKind?: 'ribbon' | 'stamp' }
  | { kind: 'fill'; snapshot: Uint16Array; bytesPerRow: number };

/**
 * Undo/Redo を管理するクラス
 */
export class StrokeHistory {
  private undoStack: StrokeRecord[] = [];
  private redoStack: StrokeRecord[] = [];
  private readonly maxUndo = 50;

  /**
   * 操作レコードを追加
   */
  addRecord(record: StrokeRecord): StrokeRecord | null {
    this.undoStack.push(record);
    this.redoStack = []; // 新しい操作で Redo スタックをクリア

    // 最大数を超えた古いレコードは呼び出し元へ返す。
    // GPU 側の固定サイズなラスターチェックポイントへ焼き込んだ後、
    // 大量の点オブジェクトを JS ヒープに残さない。
    if (this.undoStack.length > this.maxUndo) {
      return this.undoStack.shift() ?? null;
    }
    return null;
  }

  /**
   * すべての操作レコードを取得（rebake 用）
   */
  getAllRecords(): StrokeRecord[] {
    return [...this.undoStack];
  }

  /**
   * 直前の操作を取り消し（Undo）。取り消した操作を返す
   */
  undo(): StrokeRecord | null {
    const record = this.undoStack.pop();
    if (record) this.redoStack.push(record);
    return record ?? null;
  }

  /**
   * 取り消した操作をやり直し（Redo）
   */
  redo(): StrokeRecord | null {
    const record = this.redoStack.pop();
    if (record) this.undoStack.push(record);
    return record ?? null;
  }

  /**
   * すべてクリア
   */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  /**
   * 操作数を取得
   */
  getRecordCount(): number {
    return this.undoStack.length;
  }
}
