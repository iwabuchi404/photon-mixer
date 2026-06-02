/**
 * ブラシプリセット管理
 * ZIP入りJSON形式で保存/読み込み
 */

import * as fflate from 'fflate';
import type { BrushConfig } from './render/brush.js';

export interface BrushPreset {
  name: string;
  version: string;
  config: BrushConfig;
  textureData?: string; // Base64エンコードされたPNG
  thumbnail?: string;   // サムネイル（Base64 PNG）
}

export class BrushPresetManager {
  private static readonly PRESET_VERSION = '1.0';
  private static readonly THUMBNAIL_SIZE = 128;

  /**
   * プリセットをZIPとして保存
   */
  static async savePreset(preset: BrushPreset, textureBitmap?: ImageBitmap): Promise<Blob> {
    // プリセットデータ
    const presetData: BrushPreset = {
      ...preset,
      version: this.PRESET_VERSION,
    };

    // テクスチャがあればBase64エンコードして含める
    if (textureBitmap) {
      const canvas = new OffscreenCanvas(textureBitmap.width, textureBitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(textureBitmap, 0, 0);
      const blob = await canvas.convertToBlob();
      const arrayBuffer = await blob.arrayBuffer();
      const base64 = this.arrayBufferToBase64(arrayBuffer);
      presetData.textureData = `data:image/png;base64,${base64}`;
    }

    // JSONをUTF-8エンコード
    const jsonText = JSON.stringify(presetData, null, 2);
    const jsonBytes = new TextEncoder().encode(jsonText);

    // ZIPを作成
    const zipData: Record<string, Uint8Array> = {
      'preset.json': jsonBytes,
    };

    const zipped = fflate.zipSync(zipData);

    return new Blob([zipped], { type: 'application/zip' });
  }

  /**
   * ZIPからプリセットを読み込み
   */
  static async loadPreset(zipBlob: Blob): Promise<BrushPreset & { textureBitmap?: ImageBitmap }> {
    const arrayBuffer = await zipBlob.arrayBuffer();
    const unzipped = fflate.unzipSync(new Uint8Array(arrayBuffer));

    // JSONを読み込み
    const jsonBytes = unzipped['preset.json'];
    if (!jsonBytes) {
      throw new Error('Invalid preset file: preset.json not found');
    }

    const jsonText = new TextDecoder().decode(jsonBytes);
    const preset: BrushPreset = JSON.parse(jsonText);

    // テクスチャがあればデコード
    let textureBitmap: ImageBitmap | undefined;
    if (preset.textureData) {
      const base64Data = preset.textureData.split(',')[1];
      const arrayBuffer = this.base64ToArrayBuffer(base64Data);
      textureBitmap = await createImageBitmap(new Blob([arrayBuffer], { type: 'image/png' }));
    }

    return { ...preset, textureBitmap };
  }

  /**
   * ArrayBufferをBase64に変換
   */
  private static arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Base64をArrayBufferに変換
   */
  private static base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * プリセット名を生成（現在時刻から）
   */
  static generatePresetName(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    return `Brush_${year}${month}${day}_${hour}${minute}`;
  }
}
