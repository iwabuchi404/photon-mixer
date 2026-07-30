---
type: review-finding
title: ペンエンジン・レンダリングコア レビュー
created: 2026-07-26
tags: [review, pen-engine, rendering]
related:
  - '[[index]]'
  - '[[color-pipeline]]'
---

## 対象範囲
`src/pen/*.ts`（input, stabilization, interpolation, stroke）、`src/render/*.ts`、`src/core/*.ts`、`shaders/*.wgsl` を `docs/spec.md` のペンエンジン仕様（補間・手ブレ補正・4xサブピクセルバッファ・スタンプ間隔・混色パイプライン等）と突き合わせてレビューした。

---

## Critical

### C1. 4x サブピクセルバッファがキャンバス全体サイズで確保されている（仕様は「ブラシ範囲のみ」）
- **File**: `src/render/pipeline.ts:100`, `src/render/pipeline.ts:139-143`, `src/render/pipeline.ts:230-242`
- **仕様**（`docs/spec.md` 33-36行目）: 「4x サブピクセルバッファ: **ブラシ範囲のみ** 4x 空間で処理しダウンサンプルで確定」「CPU に戻さず全プロセス GPU 内完結」
- **実装**: `brushTexture4x` はキャンバス全体を4倍したサイズで確保される（`init()`: `canvas.width * 4, canvas.height * 4`）。1ストロークの点を打つたびに `drawToIsolated()` がこの全画面4xテクスチャを `clear → 描画 → downsample` している。
- **問題点**: 既定キャンバスサイズ 2000×2000px（ベースライン確認タスクで確認済み）の場合、`brushTexture4x` は 8000×8000 × `rgba16float`(8byte/px) ≒ **488MiB** の GPU テクスチャになる。これを毎ストローク・毎点で `clear` + `downsample`（8000×8000 の compute dispatch）しており、ブラシがキャンバスの一部にしか触れていなくても全面処理が走る。仕様が意図する「ブラシ範囲のみ4x処理」という最適化が実装されておらず、大キャンバスや低スペック環境でVRAM枯渇・フレームレート低下を招く恐れがある。
- **対応候補**: ストロークのバウンディングボックス（+ブラシ半径のマージン）だけを4xで確保・処理するように変更する。Phase 03（リファクタリング）向け。

### C2. 高速時の先端予測描画（仮描画）が実質機能していない
- **File**: `src/pen/interpolation.ts:56-66`（`interpolate()`）
- **仕様**（`docs/spec.md` 19行目）: 「高速時：先端1区間だけ加速度考慮予測で仮描画 → 実点到着時に差替え」
- **実装**:
  ```ts
  const predictedPoints = this.interpolateSegment(
    p1, p2, p3, p2, // p3は次の点がないのでp2で代用
    true,
  );
  ```
  ここで外側スコープの `p2`（`points[i+1]`）と `p3`（`points[min(length-1, i+2)]`）は、最終区間（`i === length-2`）では **同じ最後の実点** を指す（`i+2` が `length-1` にクランプされるため）。呼び出しの引数順は `interpolateSegment(p0, p1, p2, p3, predict)` なので、関数内部では `local p1 === local p2`（共に最後の実点）になり、`distance = |p2-p1| = 0` となる。
- **結果**: 予測区間の両端が同一点に潰れ、`predict` 分岐で計算される仮想 `p3`（`p2 + (p2-p1)`）も `p2-p1=0` のため無意味になる。Catmull-Rom 係数の性質上、`t=0.5` 付近でわずかに（前区間ベクトルの約6%程度）オーバーシュートするだけで、実際には「加速度を考慮して先端を前方に外挿する」という仕様上の効果がほぼ得られていない。速度が上がるほど本来は先端が伸びて遅延を隠すはずが、現状はほぼ何も起きない。
- **対応候補**: 予測点は「最後の実点をさらに1歩先（速度×Δt 相当）へ外挿した仮想点」を明示的に生成し、それを本物の `p3` として Catmull-Rom に渡すよう修正する。Phase 02（バグ修正）向け。

### C3. ブレンドモードが仕様の「Normal→Oklab / Overlay→Oklab L軸判定」を実装していない
- **File**: `shaders/blend.wgsl:40-49`（`blend_fn`）
- **仕様**（`docs/spec.md` 77行目）: 「③混色 Normal→Oklab / Screen,Add,Multiply→リニア / Overlay系→リニア+Oklab L軸で閾値判定」
- **実装**: `blend_fn` の `default`（normal）はそのまま `cs`（src の straight 色）を返すだけで、Oklab を経由した混色は一切行われていない（=単純な alpha over 合成）。`overlay` も `cb <= 0.5` という **per-channel の RGB 直接比較**によるクラシックな hard-light/overlay 式であり、Oklab の L（明度）軸で閾値判定するという仕様の要求を満たしていない。
- **影響**: 通常描画（Normal）モードの混色がブラシ側（`brush.wgsl` の progressive 混色）でしか Oklab を使っておらず、レイヤー合成側の Normal ブレンドは仕様と異なる色空間で行われている。Overlay も色域によっては仕様意図と異なる境界（チャンネルごとに閾値が変わる＝色相がずれる）で明暗判定される。
- **対応候補**: この項目は `src/color/*.ts` 側の実装とも関係するため、詳細な影響範囲は `[[color-pipeline]]` レビューで扱う。ブレンドシェーダー自体の修正は Phase 02/03 で検討。

---

## Minor

### M1. 手ブレ補正のα計算式が仕様の式と異なる
- **File**: `src/pen/stabilization.ts:101-110`（`calculateAlpha`）
- **仕様**（`docs/spec.md` 22行目）: `α = clamp(speed / threshold, 0.2, 1.0)`
- **実装**:
  ```ts
  const normalized = Math.min(velocity / this.config.threshold, 1.0);
  const alpha = this.config.minAlpha + normalized * (this.config.maxAlpha - this.config.minAlpha);
  ```
  これは `speed/threshold` の比をそのまま `[minAlpha, maxAlpha]` に線形リマップする式であり、仕様の「比をそのまま clamp する」式とは異なるカーブになる。例えば `speed/threshold = 0.5` のとき、仕様式では `α=0.5` だが実装では `α = 0.2 + 0.5×0.8 = 0.6` になる。
- **影響**: 動作自体は破綻しないが、「低速時に強く・高速時に弱く」という補正の効き具合が仕様のチューニング値と一致しない。UI の「追従性」スライダー等が `minAlpha`/`maxAlpha` を仕様と異なる意味でマッピングしている可能性がある。
- **対応候補**: 仕様通りの `clamp(speed/threshold, minAlpha, 1.0)` 形式に合わせるか、意図的な変更であれば `docs/spec.md` 側を更新する（要ユーザー確認）。

---

## Code smell

### S1. サンプリングレートのばらつき検出が未使用（吸収ロジック未実装）
- **File**: `src/pen/input.ts:102-106`
- **仕様**（`docs/spec.md` 9行目）: 「サンプリングレートのばらつきを CPU 側で吸収」
- **実装**:
  ```ts
  if (this.lastTimestamp > 0) {
    const interval = point.timestamp - this.lastTimestamp;
    // あまりに頻繁な場合はスキップ（今後の調整用）
  }
  ```
  `interval` を計算するだけで何も処理せず、コメントも「今後の調整用」で終わっている。仕様が求める「ばらつきの吸収」処理は存在しない。
- **対応候補**: 未実装なら `docs/spec.md` の該当項目を「未対応」として明記するか、Phase 02/03 で実装する。現状はデッドコードなので削除するか実装するかの判断が必要。

### S2. `PenInputManager` の筆圧判定条件が実質無意味
- **File**: `src/pen/input.ts:87`
  ```ts
  const pressure = e.pointerType === 'pen' && e.pressure !== 0.5 ? e.pressure : 0.5;
  ```
- **問題点**: `e.pressure !== 0.5` の条件が真でも偽でも、いずれの分岐も最終的な値は `e.pressure` の値と一致する（偽になるのは `e.pressure === 0.5` のときだけで、そのとき代入される `0.5` は元の値と同じ）。つまりこの条件分岐は結果に一切影響しない冗長なコードで、意図（ペンで筆圧が未サポートの場合に既定値へフォールバックする、等）を誤解させる書き方になっている。
- **対応候補**: `e.pointerType === 'pen' ? e.pressure : 0.5` に簡略化する（Phase 03 リファクタリング向け）。

---

## 良好だった点（参考）

- **Catmull-Rom 補間の基本式・係数**は標準的な実装で仕様の「Catmull-Rom スプラインを基本に拡張」と整合している。
- **隔離ストロークバッファ**（`isolatedTexture`）と `brush.wgsl` の `max` ブレンド演算は、仕様の「隔離ストロークバッファで一筆内のアルファ蓄積を防止」を正しく満たしている。
- **ダウンサンプル**（`downsample.wgsl`）は 4×4 ボックスフィルタで仕様の「ダウンサンプルがアンチエイリアスとして機能」と一致。
- **筆圧→サイズの非線形マッピング**（`smooth` 等のカーブ）は仕様の「非線形マッピング」の意図に沿っている。
- **1ストローク保持データからの再レンダリング**（`rebakeFromRecords`）は Undo/Redo 用途と合わせて仕様の「1ストローク保持データで全体再レンダリング」を満たしている。

---

## Phase 分類（サマリ）

| ID | 重要度 | 概要 | 状態 | 対応内容 |
|---|---|---|---|---|
| C2 | critical | 高速時の先端予測描画が機能していない | ✅ 完了 | `interpolation.ts` に `predictNextPoint` を実装。現行の「ストローク全体再描画」方式では予測点がシャギーを生むため `predict=false` で運用（アーキテクチャ更新後に有効化） |
| C3 | critical | Normal/Overlay ブレンドが Oklab 仕様と不一致 | ✅ 完了 | `blend.wgsl` に `linear_to_oklab` / `oklab_to_linear` を実装。Normal は Oklab 空間で補間、Overlay は Oklab L 軸で閾値判定後にリニア演算 |
| C1 | critical | 4x バッファが全画面サイズ確保（VRAM/性能） | ✅ 完了 | `brushTexture4x`（全画面 4x）を廃止し、ストローク bbox に基づく動的 `brushBboxTexture` を生成。`brush.wgsl` は `bbox_origin` / `bbox_size` で NDC マッピング、`downsample.wgsl` は `dst_offset_x/y` で本体テクスチャへ書き込み |
| M1 | minor | 手ブレ補正 α 計算式が仕様と不一致 | ✅ 完了 | `stabilization.ts` の `calculateAlpha` を仕様通りの `clamp(speed/threshold, minAlpha, maxAlpha)` 形式に修正 |
| S1 | code-smell | サンプリングレート吸収が未実装 | ✅ 完了 | `stabilization.ts` に `timeAdjustedAlpha` を追加。120Hz 基準で `1 - (1 - α)^(dt/nominalDt)` によりサンプリング周波数のばらつきを吸収。`lastRawPoint` / `lastOutputPoint` を分離し速度は生入力同士から計算。`stabilizeBatch(points, finishAtLastInput)` でペンアップ時に最終生入力へ収束 |
| S2 | code-smell | 筆圧判定の冗長な条件式 | ⏳ 未対応 | `input.ts:87` の `e.pointerType === 'pen' && e.pressure !== 0.5 ? e.pressure : 0.5` を `e.pointerType === 'pen' ? e.pressure : 0.5` に簡略化予定 |

---

## 検証

- `npm run build`: ✅ 通過
- `npm test`: ✅ 183/183 通過
- `scripts/verify-*.mjs`: ✅ エラーなし、~60 FPS
