# Block 6: ファイル I/O

## 目的

作業の完全な保存・復元と、他ソフト向けの書き出し・読み込みを実装する。

## 前提条件

- Block 2 完了（カラーパイプライン：正しい色変換が必要）
- Block 5 完了（レイヤーシステム：.pmx のレイヤー構造）

## スコープ

| 含む | 含まない |
|---|---|
| .pmx ネイティブ保存/読み込み | クラウド保存 |
| PNG / JPEG / EXR エクスポート | アニメーション書き出し |
| PNG / JPEG / EXR インポート | SVG インポート |
| PSD インポート（合成モード近似） | PSD エクスポート |

---

## 6-A: .pmx ネイティブ形式

### フォーマット仕様

```
project.pmx (ZIP コンテナ)
├── manifest.json      バージョン・メタデータ
├── document.json      レイヤー構成・設定
└── layers/
    ├── layer-{id}.exr  各レイヤーの committed テクスチャ（float32 EXR）
    └── ...
```

**manifest.json**

```json
{
  "version": "1.0",
  "app": "PhotonMixer",
  "canvas": {
    "width": 2000,
    "height": 2000,
    "dpi": 300,
    "colorSpace": "linear-sRGB"
  },
  "createdAt": "2026-06-01T00:00:00Z",
  "updatedAt": "2026-06-01T12:00:00Z"
}
```

**document.json**

```json
{
  "layers": [
    {
      "id": "layer-001",
      "name": "レイヤー 1",
      "visible": true,
      "opacity": 1.0,
      "blendMode": "normal",
      "textureFile": "layers/layer-001.exr"
    }
  ],
  "activeLayerId": "layer-001"
}
```

### EXR 読み書き（要調査）

**選択肢:**

1. **`openexr` npm パッケージ** — Node.js ネイティブアドオン  
   Electron でのネイティブアドオンはリビルドが必要（`electron-rebuild`）。  
   対応確認が必要。

2. **WebAssembly ビルド** — OpenEXR を wasm にコンパイル  
   `openexr-wasm` 等のパッケージが存在するか確認。  
   Electron のレンダラープロセスで実行可能。

3. **自前実装（簡易版）** — 非圧縮 float32 の EXR を自前で読み書き  
   EXR は仕様が複雑だが、FLAT + NO_COMPRESSION の最小実装は可能。  
   RGBA float32 の単純書き出しのみ対応。

**推奨**: まず選択肢 3（簡易実装）で .pmx を機能させ、後で 1 または 2 に置き換える。

**簡易 EXR writer 最小仕様:**
- チャンネル: RGBA, float32
- 圧縮: なし（NO_COMPRESSION）
- スキャンライン方式
- バイナリフォーマット: EXR magic number + header + scanline data

```typescript
// src/io/exr-writer.ts
export function writeExrRGBAFloat32(
  width: number,
  height: number,
  pixelData: Float32Array, // RGBA 順
): ArrayBuffer {}

export function readExrRGBAFloat32(
  buffer: ArrayBuffer,
): { width: number; height: number; data: Float32Array } {}
```

### GPU テクスチャ → CPU データ転送

EXR として書き出すためには GPU テクスチャのピクセルデータを CPU に取得する必要がある。

```typescript
// src/io/texture-readback.ts
export async function readTexturePixels(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
): Promise<Float32Array> {
  // COPY_SRC バッファを作成してテクスチャをコピー
  const bytesPerRow = Math.ceil(width * 4 * 4 / 256) * 256; // 256 bytes alignment
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow },
    [width, height],
  );
  device.queue.submit([encoder.finish()]);

  await buffer.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(buffer.getMappedRange()).slice();
  buffer.unmap();
  buffer.destroy();
  return result;
}
```

### zip 操作

`adm-zip` npm パッケージ（Node.js、Electron 対応）を使用:

```bash
npm install adm-zip
npm install @types/adm-zip --save-dev
```

```typescript
// src/io/pmx-writer.ts
import AdmZip from 'adm-zip';

export async function savePmx(
  filePath: string,
  layerStack: LayerStack,
  device: GPUDevice,
  canvasConfig: CanvasConfig,
): Promise<void> {
  const zip = new AdmZip();

  // 各レイヤーのテクスチャを EXR として追加
  for (const layer of layerStack.layers) {
    const pixels = await readTexturePixels(device, layer.committedTexture, ...);
    const exrData = writeExrRGBAFloat32(width, height, pixels);
    zip.addFile(`layers/${layer.id}.exr`, Buffer.from(exrData));
  }

  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  zip.addFile('document.json', Buffer.from(JSON.stringify(document, null, 2)));
  zip.writeZip(filePath);
}
```

---

## 6-B: エクスポート

### PNG / JPEG エクスポート

全レイヤーを統合して sRGB 8bit で書き出す。  
OCIO 近似変換（Block 2-E）を適用する。

```typescript
// src/io/export.ts
export async function exportPng(
  filePath: string,
  displayTexture: GPUTexture, // OCIO 変換済みの表示テクスチャ
  device: GPUDevice,
): Promise<void> {
  // GPU テクスチャ → Uint8Array（sRGB 変換済み）
  const pixels = await readTexturePixelsU8(device, displayTexture, width, height);

  // Electron の nativeImage または sharp で PNG に変換
  const { nativeImage } = await import('electron');
  const image = nativeImage.createFromBuffer(
    Buffer.from(pixels),
    { width, height },
  );
  await fs.writeFile(filePath, image.toPNG());
}
```

### OpenEXR エクスポート

float32 そのまま書き出す（トーンマッピングなし）。

```typescript
export async function exportExr(
  filePath: string,
  committedTexture: GPUTexture,
): Promise<void> {
  const pixels = await readTexturePixels(device, committedTexture, width, height);
  const exrData = writeExrRGBAFloat32(width, height, pixels);
  await fs.writeFile(filePath, Buffer.from(exrData));
}
```

---

## 6-C: インポート

### PNG / JPEG インポート

```typescript
export async function importImage(
  filePath: string,
  device: GPUDevice,
): Promise<GPUTexture> {
  // Canvas API で読み込み → ImageData 取得
  const img = new Image();
  img.src = filePath;
  await new Promise(r => img.onload = r);

  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);

  // sRGB → リニア変換（読み込み時に1回のみ）
  const linearData = new Float32Array(img.width * img.height * 4);
  for (let i = 0; i < imageData.data.length; i += 4) {
    linearData[i]   = srgbToLinear(imageData.data[i]   / 255);
    linearData[i+1] = srgbToLinear(imageData.data[i+1] / 255);
    linearData[i+2] = srgbToLinear(imageData.data[i+2] / 255);
    linearData[i+3] = imageData.data[i+3] / 255;
  }

  // GPU テクスチャに転送
  const texture = device.createTexture({
    size: [img.width, img.height],
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  // writeTexture で転送...
  return texture;
}
```

### PSD インポート

`ag-psd` ライブラリを使用（要調査・要インストール）:

```bash
npm install ag-psd
```

```typescript
import { readPsd } from 'ag-psd';

export async function importPsd(
  filePath: string,
  device: GPUDevice,
): Promise<LayerStack> {
  const buffer = await fs.readFile(filePath);
  const psd = readPsd(buffer);

  // 合成モードのマッピング（近似）
  const blendModeMap: Record<string, BlendMode> = {
    'norm': 'normal',
    'scrn': 'screen',
    'mul ': 'multiply',
    'over': 'overlay',
    'lddg': 'add',
  };

  // ユーザーに通知: 合成モードが近似で変換される旨
  // 見た目が変わる可能性を事前に表示

  const layers: Layer[] = [];
  for (const psdLayer of psd.children ?? []) {
    // sRGB → リニア変換してレイヤーテクスチャに
    // ...
    layers.push({
      id: generateId(),
      name: psdLayer.name ?? 'レイヤー',
      blendMode: blendModeMap[psdLayer.blendMode ?? 'norm'] ?? 'normal',
      opacity: (psdLayer.opacity ?? 255) / 255,
      visible: !psdLayer.hidden,
      // ...
    });
  }

  return { layers, activeLayerId: layers[0]?.id };
}
```

---

## 6-D: Electron ネイティブダイアログ

ファイル保存・読み込みには Electron の `dialog` API を使用する。  
main プロセスで `dialog.showSaveDialog` / `dialog.showOpenDialog` を呼び、  
IPC 経由でレンダラーに結果を返す。

**`electron/main.ts` の変更**

```typescript
import { dialog, ipcMain } from 'electron';

ipcMain.handle('dialog:save', async (_, filters) => {
  const result = await dialog.showSaveDialog({ filters });
  return result.filePath;
});

ipcMain.handle('dialog:open', async (_, filters) => {
  const result = await dialog.showOpenDialog({ filters });
  return result.filePaths[0];
});
```

**`electron/preload.cjs` の変更**

```javascript
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveDialog: (filters) => ipcRenderer.invoke('dialog:save', filters),
  openDialog: (filters) => ipcRenderer.invoke('dialog:open', filters),
  saveFile: (path, data) => ipcRenderer.invoke('fs:write', path, data),
  readFile: (path) => ipcRenderer.invoke('fs:read', path),
});
```

---

## 完了条件

- [ ] .pmx で保存して完全に復元できる（レイヤー構成・全ストロークの色が正確）
- [ ] PNG エクスポートで sRGB 変換が正しく適用される（白が #FFFFFF になる）
- [ ] OpenEXR で float32 値が保持される
- [ ] PNG / JPEG インポートで sRGB → リニア変換が行われる
- [ ] PSD インポートで合成モードが近似変換され、変換内容がユーザーに通知される
