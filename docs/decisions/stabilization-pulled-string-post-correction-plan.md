---
type: decisions
title: 手ブレ補正 - Pulled String + 後補正 実装プラン
created: 2026-07-29
status: draft
tags: [plan, stabilization, pulled-string, post-correction]
related:
  - '[[stabilization-comparison]]'
  - '[[pen-render-engine]]'
---

## 概要

現在の EMA + 速度適応α に加え、以下の2つの補正方式を**別オプション**として追加する。

| 方式 | 用途 | 追加理由 |
|---|---|---|
| **Pulled String（紐引き）** | 精密な線画 | 入力の微細な揺れをdead zoneで抑え、EMAより方向変化を残しやすい |
| **後補正（事後補正）** | 仕上げの平滑化 | リアルタイム補正の弱点（遅延・揺らぎ）を補完。クリスタ/ibisPaintが採用 |

リアルタイム補正は **EMA / Pulled String の排他選択**とする。
後補正はリアルタイム補正方式とは独立したオプションとし、どちらの方式とも組み合わせ可能にする。

---

## 現在のアーキテクチャ

### 描画パイプライン

```
pointerdown
  → rawPoints = [transformedPoint]

pointermove (handleStampMove / handleProgressiveMove)
  → rawPoints.push(transformedPoint)
  → stabilizer.stabilizeBatch(rawPoints)        ← EMA補正
  → interpolator.interpolate(stabilized)         ← Catmull-Rom補間
  → strokeManager.finalizeStroke(interpolated)   ← 筆圧→サイズ変換
  → renderPipeline.setCurrentStroke(liveStroke)  ← ライブプレビュー

pointerup
  → stabilizer.stabilizeBatch(rawPoints, true)   ← 終点収束
  → interpolator.interpolate(stabilized)
  → strokeManager.finalizeStroke(interpolated)
  → bakeColorIntoPoints(finalStroke)             ← 色焼き込み
  → renderPipeline.commitStroke(finalStroke)     ← 確定描画
  → activeHistory().addRecord({kind:'stroke', points: finalStroke, ...})  ← 履歴
```

### 関連ファイル

| ファイル | 役割 |
|---|---|
| `src/pen/stabilization.ts` | EMA + 速度適応α + timeAdjustedAlpha |
| `src/pen/interpolation.ts` | Catmull-Rom 補間 + 予測（無効化中） |
| `src/pen/stroke.ts` | StrokePoint定義、StrokeRecord定義、StrokeHistory |
| `src/pen/input.ts` | PointerEvent → PointerPoint 変換 |
| `src/main.ts` | パイプライン統合、UI→エンジン接続 |
| `src/ui/engine-ctx.ts` | UI→エンジン反映の窓口 |
| `src/render/pipeline.ts` | GPU描画、commitStroke、rebakeFromRecords |
| `index.html` | UI（brush-stabilize スライダー等） |

### 現在のUI

```
補正: [スライダー 0-100%]   ← EMA の minAlpha をマッピング
```

---

## Phase 1: Pulled String（紐引き方式）

### 設計方針

- `Stabilizer` クラスと並列する `PulledStringStabilizer` クラスを新設
- 既存の `Stabilizer`（EMA）はそのまま残す
- UI で補正方式を切り替え可能にする
- 出力は `PointerPoint[]` なので、下流の `interpolator` / `strokeManager` は変更不要

### アルゴリズム

```
状態:
  brushPos: PointerPoint  // ブラシの現在位置（出力）
  penPos:   PointerPoint  // ペン先の最新位置（入力）
  radius:   number        // 紐の長さ（dead zone 半径）

入力時:
  penPos = newInput

  dist = distance(brushPos, penPos)

  if dist > radius:
    // 紐が張った → ブラシを引っ張る
    direction = normalize(penPos - brushPos)
    brushPos = penPos - direction × radius
    // ※ブラシは常に紐の長さ分だけペン先より遅れる
    output = brushPos
  else:
    // 紐が緩い → ブラシは動かない（出力なし、または前回と同じ位置）
    output = null  // 描画しない

ペンアップ時:
  // Finish Line オプション:
  // brushPos から最終 penPos まで、描画間隔に合わせた補間点を生成
  output = resampleLine(brushPos, penPos)
```

**Phase 1では Catch Up（停止時追従）を実装しない。**
現在のライブプレビューは入力イベントを契機にストローク全体を再計算するため、
入力が止まっている間にブラシだけを追従させることができない。
Catch Up は「確定済み区間と可変末尾の分離」および `requestAnimationFrame` ベースの逐次更新と同じ後続フェーズで扱う。

### 実装ステップ

#### 1-1. `src/pen/pulled-string.ts` 新設

```typescript
export interface PulledStringConfig {
  radius: number;        // 紐の長さ（px）。大きいほど強い補正
  finishLine: boolean;   // ペンアップ時に最終位置まで引く
}

export class PulledStringStabilizer {
  private config: PulledStringConfig;
  private brushPos: PointerPoint | null = null;
  private penPos: PointerPoint | null = null;

  stabilize(point: PointerPoint): PointerPoint | null {
    // 初回はブラシ位置 = ペン位置
    // dist > radius のみブラシを移動
  }

  stabilizeBatch(points: PointerPoint[]): PointerPoint[] {
    // バッチ処理。null（描画スキップ）をフィルタ
  }

  finish(point: PointerPoint): PointerPoint[] {
    // finishLine: ブラシ→最終ペン位置までの補間点を生成
  }
}
```

**注意点**: `stabilize()` が `null` を返す可能性がある（紐が緩い間は描画しない）。これは既存の `Stabilizer` との違い。

→ **方針**: `stabilizeBatch` では `null` をフィルタし、始点だけは必ず保持する。
前回位置を重複出力しない。既存の `Interpolator` は同一座標を除去するため、
重複点を追加しても下流の点列維持にはならず、時刻・筆圧の意味だけが曖昧になる。

#### 1-2. `src/pen/stabilization-mode.ts` 新設（方式切り替え）

```typescript
export type StabilizationMode = 'ema' | 'pulled-string';

export interface StabilizationSettings {
  mode: StabilizationMode;
  // EMA 用
  emaConfig: Partial<StabilizationConfig>;
  // Pulled String 用
  pulledStringConfig: Partial<PulledStringConfig>;
}

// 統合インターフェース: mode に応じて内部で切り替え
export class StabilizationController {
  private ema: Stabilizer;
  private pulledString: PulledStringStabilizer;
  private settings: StabilizationSettings;

  stabilizeBatch(points: PointerPoint[], finishAtLastInput = false): PointerPoint[] {
    if (this.settings.mode === 'pulled-string') {
      return this.pulledString.stabilizeBatch(points, finishAtLastInput);
    }
    return this.ema.stabilizeBatch(points, finishAtLastInput);
  }

  setMode(mode: StabilizationMode): void { ... }
  updateEmaConfig(config: Partial<StabilizationConfig>): void { ... }
  updatePulledStringConfig(config: Partial<PulledStringConfig>): void { ... }
}
```

#### 1-3. `src/main.ts` 変更

- `this.stabilizer` を `StabilizationController` に置き換え
- `stabilizeBatch` の呼び出し箇所（3箇所）はインターフェース互換なので変更不要
- `handleStampMove` / `handleProgressiveMove` / `buildColoredStroke` はそのまま動作

#### 1-4. `src/ui/engine-ctx.ts` 変更

```typescript
setStabilizeMode(mode: 'ema' | 'pulled-string'): void {
  stabilizer.setMode(mode);
}
setPulledStringRadius(px: number): void {
  stabilizer.updatePulledStringConfig({ radius: px });
}
```

#### 1-5. `index.html` UI 変更

現在:
```
補正: [スライダー 0-100%]
```

変更後:
```
補正方式: [EMA ▼] [Pulled String ▼]
補正強度: [スライダー 0-100%]
```

- EMA 選択時: スライダー = minAlpha マッピング（既存通り）
- Pulled String 選択時: スライダー = radius マッピング（0% = 0px, 100% = 50px 等）

#### 1-6. テスト

`tests/stabilization.test.ts` に追加:

- `PulledStringStabilizer` の単体テスト
  - 紐が緩い間は出力が変化しない
  - 紐が張ったら ブラシが引かれる
  - finishLine で最終位置まで到達
  - `radius=0` で入力位置と一致
  - 60Hz / 120Hz / 240Hz 相当の入力で形状差が許容範囲内
  - finishLine が長い1区間を作らず、描画間隔に沿って再サンプリングされる
- `StabilizationController` の切り替えテスト
  - mode 切り替えで内部インスタンスが切り替わる
  - 各モードで stabilizeBatch が正しく動作

### 懸念事項

1. **「全体再描画」方式との相性**
   - 現状のライブプレビューは `rawPoints` 全体を毎フレーム `stabilizeBatch` に渡して再処理している
   - Pulled String は「状態を持つ」フィルタなので、毎回 `reset()` して全点を通すと、紐が張るまでの間は出力が1点に潰れる
   - → **対策**: Phase 1は決定的なバッチ変換として実装し、始点のみ保持して移動が発生するまで1点のままとする
   - → Catch Up は実装せず、確定済み区間と可変末尾を分離する後続フェーズへ送る

2. **radius の単位**
   - スクリーン座標（px）かキャンバス座標か
   - ズーム時の挙動が変わる
   - → **初期方針**: キャンバス座標で処理（既存の `stabilizeBatch` と単位を揃える）
   - → Kamoxで複数ズーム倍率を比較し、画面上の補正感を一定にする必要があれば `screenPx / zoom` へ変換する

---

## Phase 2: 後補正（Post-Correction）

### 設計方針

- ペンアップ時、`PointerPoint[]` の段階でストローク全体を再構成する
- 後補正は `finalizeStroke`（筆圧→サイズ変換）と色焼き込みより**前**に行う
- リアルタイム補正（EMA/Pulled String）とは**独立したオプション**
- オン/オフ + 強度スライダー
- アルゴリズムは**弧長リサンプリング + RDP間引き + centripetal Catmull-Rom再補間**
- Phase 2の対象は通常ブラシ（引きずり混色なし）と消しゴムとする
- ぼかしおよび引きずり混色中のブラシはsmudge経路を使うため、後補正を無効化する

### アルゴリズム選定

| 方式 | コスト | 角の保持 | 採用 |
|---|---|---|---|
| 曲線フィッティング（ベジェ近似） | 高 | ✗ | ✗ 棄却（実装複雑） |
| **間引き + 補間** | **中** | **形状特徴を残しやすい** | **✓ 採用** |
| ガウシアン平滑化 | 低 | ✗ | ✗ 棄却（EMAと同じ弱点） |

### 間引き + 補間のアルゴリズム

```
入力: PointerPoint[] (リアルタイム補正後、確定前のストローク)

Step 1: 弧長リサンプリング
  - 入力イベントの不均一な点間隔を揃える
  - 既存の Interpolator.resampleByArcLength() を再利用

Step 2: 間引き（Ramer-Douglas-Peucker法）
  - 特徴点（角・方向変化点）を残し、直線上の中間点を削除
  - tolerance パラメータで間引き強度を制御
  - 始点・終点は必ず保持

Step 3: 再補間
  - 残った特徴点間を centripetal Catmull-Rom で再補間
  - 既存の Interpolator.interpolate() を再利用可能

出力: PointerPoint[] (後補正済み)
```

RDPは「角を完全に維持する」処理ではない。大きな形状変化を制御点として残しやすくする処理であり、
その後のCatmull-Rom補間によって角は曲線化される。Phase 2では移動平均を重ねず、意図しない頂点移動を避ける。

### 実装ステップ

#### 2-1. `src/pen/post-correction.ts` 新設

```typescript
export interface PostCorrectionConfig {
  enabled: boolean;
  tolerance: number;  // 間引きの許容誤差（px）。大きいほど強い平滑化
}

export class PostCorrector {
  private config: PostCorrectionConfig;

  correct(points: PointerPoint[]): PointerPoint[] {
    if (!this.config.enabled || points.length < 3) return points;

    // Step 1: 入力間隔を弧長で揃える
    const resampled = this.interpolator.resampleByArcLength(points);

    // Step 2: Ramer-Douglas-Peucker で間引き
    const simplified = this.rdpSimplify(resampled, this.config.tolerance);

    // Step 3: Catmull-Rom で再補間（既存 Interpolator を利用）
    return this.interpolator.interpolate(simplified);
  }

  private rdpSimplify(points: PointerPoint[], tolerance: number): PointerPoint[] {
    // Ramer-Douglas-Peucker 法
    // 非再帰または再帰深度を抑えた実装とし、始点・終点を必ず保持
  }
}
```

#### 2-2. `src/main.ts` 変更

`pointerup` 時、リアルタイム補正後かつ `finalizeStroke` より前に後補正を挟む:

```typescript
// 現在:
const finalStroke = this.strokeManager.finalizeStroke(interpolated);
this.bakeColorIntoPoints(finalStroke);
this.renderPipeline?.commitStroke(finalStroke);

// 変更後:
const stabilized = this.stabilizer.stabilizeBatch(this.rawPoints, true);
const interpolated = this.postCorrector.getConfig().enabled
  ? this.postCorrector.correct(stabilized)       // RDP + Catmull-Rom 済み
  : this.interpolator.interpolate(stabilized);  // 通常の補間
const finalStroke = this.strokeManager.finalizeStroke(interpolated);
this.bakeColorIntoPoints(finalStroke);
this.renderPipeline?.commitStroke(finalStroke);
```

smudge（引きずり混色）は、補正後の経路で色を再サンプリングしない限り色の連続性を保証できない。
Phase 2では後補正を適用せず、既存の `buildColoredStroke(true)` をそのまま使用する。

#### 2-3. 履歴との整合性

`StrokeRecord` には、後補正後の経路から生成した最終 `StrokePoint[]` を保存する。
→ `rebakeFromRecords` は後補正後の点列をそのまま描画すれば再現可能。**変更不要**。

#### 2-4. `src/ui/engine-ctx.ts` 変更

```typescript
setPostCorrection(enabled: boolean): void {
  postCorrector.updateConfig({ enabled });
}
setPostCorrectionStrength(pct: number): void {
  // 0% = tolerance=0.5px（弱）, 100% = tolerance=10px（強）
  const tolerance = 0.5 + (pct / 100) * 9.5;
  postCorrector.updateConfig({ tolerance });
}
```

#### 2-5. `index.html` UI 変更

補正方式の下に追加:
```
後補正: [チェックボックス] [スライダー 0-100%]
```

- チェックボックス: 後補正のオン/オフ
- スライダー: tolerance のマッピング

#### 2-6. テスト

`tests/post-correction.test.ts` 新設:

- `rdpSimplify` の単体テスト
  - 直線上の中間点が削除される
  - 始点・終点が必ず保持される
  - 大きな方向変化の頂点が許容誤差内で保持される
  - tolerance が大きいほど多く削除
- `correct` の統合テスト
  - ブレたストロークが平滑化される
  - 始点・終点が補正前と一致する
  - 鋭角で許容範囲を超えるオーバーシュートがない
  - 筆圧の単調変化が維持される
  - enabled=false で素通し
  - 点数が少なすぎる場合は素通し
- パイプライン統合テスト
  - 後補正後に筆圧からsizeが再計算される
  - smudgeでは後補正が適用されない
  - 確定描画とUndo/Redo後の再描画が一致する
  - 長いストロークでも再帰上限や極端な確定遅延が発生しない

### 懸念事項

1. **ペンアップ時の処理時間**
   - RDP は最悪 O(n²) であり、再帰実装にはスタック上限の問題もある
   - → 非再帰実装または再帰深度を制限した実装にし、処理時間を計測する
   - → 5000点を超える場合はスキップではなく、先に粗い弧長リサンプリングで入力数を抑える

2. **UX: 「シュッと整う」演出**
   - クリスタは意図的にアニメーション付きで後補正を表示
   - PhotonMixer では即時確定でも違和感ないはず（ライブプレビューが既に滑らかなら）

3. **smudge（引きずり混色）との相性**
   - 後補正で点列が間引かれると、色の連続性が崩れる可能性
   - → **Phase 2の対策**: smudge モードでは後補正を無効化
   - → 将来対応する場合は、補正後の経路に沿って混色を再サンプリングする

---

## 実装順序とマイルストーン

| 順序 | タスク | 想定作業 | 影響ファイル |
|---|---|---|---|
| 1 | `PulledStringStabilizer` 実装 | 新規 | `src/pen/pulled-string.ts` |
| 2 | `StabilizationController` 実装 | 新規 | `src/pen/stabilization-mode.ts` |
| 3 | `main.ts` を Controller に置き換え | 変更 | `src/main.ts` |
| 4 | `engine-ctx.ts` に方式切り替え追加 | 変更 | `src/ui/engine-ctx.ts` |
| 5 | UI に方式セレクタ追加 | 変更 | `index.html` |
| 6 | Pulled String のテスト | 新規 | `tests/stabilization.test.ts` |
| 7 | ビルド＋テスト検証 | — | — |
| — | **↑ Phase 1 完了** | — | — |
| 8 | `PostCorrector` + RDP 実装 | 新規 | `src/pen/post-correction.ts` |
| 9 | `main.ts` の stabilize 後・finalizeStroke 前に後補正挿入 | 変更 | `src/main.ts` |
| 10 | `engine-ctx.ts` に後補正制御追加 | 変更 | `src/ui/engine-ctx.ts` |
| 11 | UI に後補正チェック+スライダー追加 | 変更 | `index.html` |
| 12 | 後補正のテスト | 新規 | `tests/post-correction.test.ts` |
| 13 | Undo/Redo・smudge無効化・長ストローク検証 | 変更 | `tests/`, Kamox |
| 14 | ビルド＋テスト＋Kamox検証 | — | — |
| — | **↑ Phase 2 完了** | — | — |

Catch Up（停止時追従）はPhase 1・2に含めない。
確定済み区間と可変末尾を分離するライブ描画設計を先に作り、
`requestAnimationFrame` 中の追従、Undo/Redo、確定結果との一致を検証できる段階で別プランとして扱う。

---

## UI 最終イメージ

```
┌─────────────────────────────┐
│ 補正方式: [EMA ▼]            │
│ 補正強度: [━━━━━───] 50%    │
│                             │
│ 後補正:  [✓] [━━───] 20%   │
└─────────────────────────────┘
```

- **補正方式**: EMA / Pulled String のドロップダウン
- **補正強度**: 方式に応じて意味が変わるスライダー
  - EMA: minAlpha マッピング
  - Pulled String: radius マッピング
- **後補正**: チェックボックス + 強度スライダー（方式に関わらず独立動作）

---

## 仕様との整合性

`docs/spec.md` の手ブレ補正仕様（22行目）:
> α = clamp(speed / threshold, 0.2, 1.0)

→ M1修正済み。EMA方式は仕様準拠。

Pulled String / 後補正は仕様に**未記載**。
→ 実装とKamox検証後、ユーザー確認を得てから `docs/spec.md` と現在地を連鎖更新する。

---

## リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| Pulled String が「全体再描画」方式で挙動不審 | 高 | 決定的なバッチ変換に限定し、Catch Upはライブ末尾分離まで延期 |
| 後補正で smudge の色連続性が崩れる | 中 | smudge モードでは後補正無効化 |
| RDP の計算時間・再帰深度が大ストロークで問題 | 中 | 弧長リサンプリングで入力数を抑え、非再帰実装と時間計測を行う |
| UI の複雑化 | 低 | 方式切替は上級者向け。デフォルトは EMA のまま |
| 既存テストが壊れる | 低 | `StabilizationController` は `Stabilizer` とインターフェース互換 |

---

## 今後の拡張候補（本プランのスコープ外）

- 筆圧平滑化（実装コスト低、需要あり）
- ズーム連動（実装コスト低）
- Inertia モード（物理シミュレーション）
- ガウシアン重み付き平均モード
