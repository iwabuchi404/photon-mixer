# Block 3: 基本描画ユーザビリティ

## 目的

1 時間の描画セッションが不便なく進められる最低限の機能を実装する。  
Block 1 完了後であれば Block 2 と並行して着手できる。

## スコープ

| 含む | 含まない |
|---|---|
| Undo / Redo（ストローク単位） | ピクセル単位 Undo |
| ズーム / パン | アニメーション |
| キャンバスサイズ設定（新規） | キャンバスリサイズ（既存描画保持） |
| 消しゴムツール | ブラシ選択 UI（Block 4） |
| ツールパネル最小版 | キーボードショートカット全般 |

---

## 3-A: Undo / Redo

### 設計方針

ストローク単位で Undo する。ピクセル単位は不要（ストロークの再描画が現実的）。

```
UndoStack: StrokePoint[][]  確定ストロークの配列
RedoStack: StrokePoint[][]  Undo 後の Redo 用スタック
```

committed texture の再構築:
- Undo 時: `UndoStack.pop()` → committed texture を全ストロークから再ベイク
- undo 数が多いと重いが、設計上許容する（将来的にはチェックポイント方式で最適化）

### 実装

**`src/pen/stroke.ts` の変更**（StrokeHistory は実装済み）

```typescript
export class StrokeHistory {
  private undoStack: StrokePoint[][] = [];
  private redoStack: StrokePoint[][] = [];

  addStroke(stroke: StrokePoint[]): void {
    this.undoStack.push([...stroke]);
    this.redoStack = []; // 新しいストロークで Redo スタックをクリア
  }

  undo(): StrokePoint[] | null {
    const stroke = this.undoStack.pop();
    if (stroke) this.redoStack.push(stroke);
    return stroke ?? null;
  }

  redo(): StrokePoint[] | null {
    const stroke = this.redoStack.pop();
    if (stroke) this.undoStack.push(stroke);
    return stroke ?? null;
  }

  getAll(): StrokePoint[][] {
    return [...this.undoStack];
  }
}
```

**`src/render/pipeline.ts` の変更**

```typescript
// Undo 時: committed texture を全ストロークから再ベイク
rebakeFromStrokes(allStrokes: StrokePoint[][]): void {
  this.clearTexture(this.committedTexture);
  for (const stroke of allStrokes) {
    this.bakeStroke(stroke); // isolated 経由でベイク
  }
}
```

**`src/main.ts` の変更**

```typescript
private history = new StrokeHistory();

// ペンアップ時
case 'up':
  const finalStroke = ...;
  this.renderPipeline.commitStroke(finalStroke);
  this.history.addStroke(finalStroke);
  break;

// Undo
private undo(): void {
  const removed = this.history.undo();
  if (removed) {
    this.renderPipeline.rebakeFromStrokes(this.history.getAll());
  }
}

// キーボードイベント
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'z') this.undo();
  if (e.ctrlKey && e.key === 'y') this.redo();
});
```

### 最大 Undo 数

デフォルト 50 ストローク。超えた場合は古いものから破棄。

---

## 3-B: ズーム / パン

### 設計方針

ビュー変換行列（2D アフィン変換）を管理する。  
ペン入力座標は「スクリーン座標 → キャンバス座標」に変換してから処理する。

```
ViewTransform:
  scale: number         ズーム倍率（0.1〜32.0）
  offsetX: number       パン X オフセット（スクリーンピクセル）
  offsetY: number       パン Y オフセット
```

変換:
```
canvas_x = (screen_x - offsetX) / scale
canvas_y = (screen_y - offsetY) / scale
```

### 新規: `src/viewport.ts`

```typescript
export class Viewport {
  private scale = 1.0;
  private offsetX = 0;
  private offsetY = 0;

  // スクリーン座標 → キャンバス座標
  toCanvas(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.offsetX) / this.scale,
      y: (sy - this.offsetY) / this.scale,
    };
  }

  // ズーム（指定スクリーン座標を中心に）
  zoom(factor: number, cx: number, cy: number): void {
    const newScale = Math.max(0.1, Math.min(32.0, this.scale * factor));
    this.offsetX = cx - (cx - this.offsetX) * (newScale / this.scale);
    this.offsetY = cy - (cy - this.offsetY) * (newScale / this.scale);
    this.scale = newScale;
  }

  // パン
  pan(dx: number, dy: number): void {
    this.offsetX += dx;
    this.offsetY += dy;
  }

  getScale(): number { return this.scale; }
  getTransform(): { scale: number; offsetX: number; offsetY: number } {
    return { scale: this.scale, offsetX: this.offsetX, offsetY: this.offsetY };
  }
}
```

**`src/main.ts` の変更**

```typescript
private viewport = new Viewport();

// マウスホイールでズーム
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  this.viewport.zoom(factor, e.clientX, e.clientY);
});

// スペース + ドラッグでパン
private isPanning = false;
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') this.isPanning = true;
});

// ペン入力の座標変換
private handlePenInput(event) {
  const { x, y } = this.viewport.toCanvas(event.point.x, event.point.y);
  const transformedPoint = { ...event.point, x, y };
  // 以降は transformedPoint を使用
}
```

**`src/render/pipeline.ts` / `shaders/brush.wgsl` の変更**

ズーム時: ブラシシェーダーの uniform に scale を追加してスタンプサイズを補正  
（ズームアウト時にブラシサイズが見かけ上縮小するのは意図通り）

---

## 3-C: キャンバスサイズ設定

### UI

起動時に表示するダイアログ（または設定パネル）:

```
┌────────────────────────┐
│  新規キャンバス          │
│  幅:  [2000] px        │
│  高さ: [2000] px       │
│  解像度: [300] dpi     │
│  [キャンセル]  [作成]   │
└────────────────────────┘
```

### 実装

**`src/canvas-config.ts`**

```typescript
export interface CanvasConfig {
  width: number;   // ピクセル
  height: number;
  dpi: number;     // 表示用メタデータ（レンダリングには不使用）
}

export const DEFAULT_CONFIG: CanvasConfig = {
  width: 2000,
  height: 2000,
  dpi: 300,
};
```

キャンバス作成時に `pipeline.resize(width, height)` を呼ぶ。

---

## 3-D: 消しゴムツール

### 設計方針

消しゴムは「透明色（alpha=0）でブラシを描く」として実装する。  
ただし max blend のままでは透明にできない（max は alpha を上書きできない）。

**消しゴムのブレンドモード**: `dst - src`（減算）または erase blend を使用。

WebGPU では erase blend を直接サポートしていないため、  
消しゴム用に別のパスを使う:

```
消しゴムストローク → eraseTexture（アルファマスク）
render():
  committed: 通常描画
  erase マスクを committed に適用（乗算 blend）
  isolated: 現在ストローク
```

または、シンプルに **committed texture の特定領域をゼロクリア** する方式:

```
消しゴムスタンプ位置で committed テクスチャに (0,0,0,0) を書き込む
→ fragment shader で erasing=true の場合は出力を (0,0,0,0) に
→ max blend ではなく replace blend を使用
```

消しゴム専用の replace blend パイプラインを brush.ts に追加:
```typescript
// erase モード用: dst_factor='zero'（完全上書き）
eraseBlend: {
  color: { srcFactor: 'zero', dstFactor: 'zero', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'zero', operation: 'add' },
}
```

### `src/main.ts` の変更

```typescript
type Tool = 'brush' | 'eraser';
private currentTool: Tool = 'brush';

private handlePenInput(event) {
  if (this.currentTool === 'eraser') {
    // 消しゴムモード: brush renderer に erase フラグを渡す
    this.renderPipeline.setEraseMode(true);
  }
}
```

---

## 3-E: ツールパネル最小版

### UI レイアウト

```
左サイドバー（または上部ツールバー）:
  [B] ブラシ
  [E] 消しゴム
  ─────────
  サイズ: [=====|] 20px
  不透明度: [=====] 100%
  にじみ: [=|====]  0%    ← wet_ratio（Block 2 で追加）
  ─────────
  [■] 現在色（クリックでカラーピッカー）
```

**`index.html` / CSS の変更**

現在右上にある brush-controls パネルを左サイドバーに移動・整理する。

---

## 完了条件

- [ ] Ctrl+Z で最後のストロークが取り消される
- [ ] Ctrl+Y で Redo できる
- [ ] ホイールでズームイン/アウトできる
- [ ] スペース+ドラッグでパンできる
- [ ] 消しゴムで描いた部分が消える
- [ ] キャンバスサイズを設定して新規作成できる
