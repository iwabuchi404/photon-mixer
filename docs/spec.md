# PhotonMixer 仕様

> 本書はユーザー提供の更新仕様（正本）。実装はこれに整合させる。

## ペンエンジン

### 入力層
- PointerEvent で float 座標・筆圧・傾き取得
- サンプリングレートのばらつきを CPU 側で吸収

### 描画パイプライン
```
生入力 → 近似で整形 → 4xバッファで高精度描画 → ペンアップ確定 → float32リニアキャンバスに合成 → OCIO → 画面
```

### 補間アルゴリズム
- Catmull-Rom スプラインを基本に拡張
- リアルタイム制約：常に1点1遅延発生
- 低速時：Catmull-Rom のみ、高速時：先端1区間だけ加速度考慮予測で仮描画 → 実点到着時に差替え

### ストローク入力精度コントロール（指標表記：手ブレ補正）
- EMA + 速度連動: `α = clamp(speed / threshold, 0.2, 1.0)`
- 低速時：強い補正、高速時：IIR ほぼ素通し
- イコライザー的 UI：「追従性」「質感」の2軸
- 速度・筆圧でストローク中に動的変化

### スタンプ描画
- スタンプ連打が基本構造
- テクスチャはキャンバス座標系で適用（紙目を「こすって出す」）
- バイリニアサンプリングでサブピクセル処理
- 隔離ストロークバッファで一筆内のアルファ蓄積を防止

### 4x サブピクセルバッファ
- ブラシ範囲のみ 4x 空間で処理しダウンサンプルで確定
- CPU に戻さず全プロセス GPU 内完結（WebGPU Compute Shader）
- ダウンサンプルがアンチエイリアスとして機能

### 筆圧→形状変化
- 不透明度・サイズ・形状すべて非線形マッピング
- 傾きで楕円の角度変化
- 全パラメータを GPU Uniform として一括で渡す

### スタンプ間隔の動的調整
- 基本: `間隔 = ブラシ直径 × 係数`
- 速度連動でかすれ表現

### ペンアップ時の処理
1. 末端減速仮点生成で自然な終端
2. 1ストローク保持データで全体再レンダリング（1回のみ）
3. 隔離バッファ→キャンバスに合成→バッファ破棄

### 1ストローク一時保持
- ペンダウン〜ペンアップの座標・筆圧・時刻を保持
- 永続保存はしない
- 長いストロークは距離/時間窓で分割フラッシュ

### float32 バッファとの接続
- UI 色履歴（知覚空間）→ GPU 内でリニア変換
- プリマルチプライドアルファで統一
- メインキャンバス書き込みは常に float32 リニア、画面表示は常に OCIO 経由

---

## 技術スタック（方向性）
- Electron（Windows メイン） / WebGPU + Compute Shader / TypeScript
- 色管理: OCIO 参考・リニア float32 内部
- 参考: Krita の Scene Linear Painting パイプライン

---

## カラーパイプライン

### 全体フロー
```
①入力  シンプル: HSV/RGB(0-1) / アドバンス: 色相・彩度 + 輝度(EV) → GPU内で float32 リニアへ
②内部保持  float32 リニア（1.0超 HDR 可）・プリマルチプライドα統一
③混色  Normal→Oklab / Screen,Add,Multiply→リニア / Overlay系→リニア+Oklab L軸で閾値判定
④作業表示  A: LinearPreview（白飛び確認） / B: DisplayTransform（OCIO・既定）
⑤出力  OCIO トーンマッピング（1箇所のみ）→ sRGB8bit / HDR10 / P3 / OpenEXR
```

### カラーピッカー
- シンプル/アドバンス2モード
- HDR 色をシンプルで開いたらクランプ表示を明示
- 内部 float 値を常時表示（R:1.000 G:0.502 B:0.000）

### 外部ファイル読み込み
- sRGB→リニアは読み込み時1回のみ
- 合成モードは近似マッピング・見た目変化を通知
- 以降は全てリニア空間

---

## ファイルフォーマット
- ネイティブ `.pmx`: ZIP（manifest.json + document.json + layers/*.exr 圧縮EXRタイル）
- インポート: PSD(sRGB→リニア・合成近似・通知) / PNG/JPEG(sRGB→リニア) / OpenEXR(float32そのまま)
- エクスポート: OCIO 経由 — sRGB8bit(PNG/JPEG) / HDR10 / P3 / OpenEXR / 将来アニメ
- タイル: 512×512 単位 VRAM 管理・表示/編集範囲のみ展開・ズームでミップマップ

---

## Photon Experience MVP

Block 7 前に「光を描ける」体験を成立させる小フェーズ。

### 基本原則
表示操作は作品データを変えない。View EV・トーンマップ・クリップ警告・リニア確認はすべて「見るための操作」。
```
作品データ = リニア HDR の原本
表示       = 原本をどう見るか
効果レイヤー = 原本に残る非破壊処理
書き出し   = 表示変換を焼くか、原本を出すかを選ぶ
```

### Light Panel v1（表示専用・作品データ不変）
- 表示露出 `viewEV`: -6.0〜+6.0 EV、既定 0.0、表示例 `+2.0 EV (x4.0)`
- 見え方 `tonemap`: 既定 `PBR Neutral` / `AgX` / `Reinhard` / `None`
- 確認モード `viewMode`: 既定 `表示変換` / `リニア確認` / `白飛び確認`
- 白飛び確認: `>1.0`=赤 / `<0.0`=青

### Color EV v1
色を「色度 + 光量」として扱い、内部リニア >1.0 を作れる。
- 光量 `colorEV`: -6.0〜+6.0 EV、既定 0.0
- スライダー: SDR域(通常)とHDR域(発光スタイル)を同一スライダー上で視覚分離・境界を強調
  - 補助テキスト（「ここから発光」）は初回のみ
  - 語彙「普通の色の上に光る色がある」（デジタルズーム比喩は不使用）
- 変換 `linear = srgbToLinear(hsvColor) * 2^colorEV`
- HDR 表示: `max(rgb)>1.0` で高光量/HDR 表示・内部 float 表示・シンプルUIでも黙ってクランプしない

### スポイト v1
- **全レイヤー合成結果の内部リニア値**を拾う（表示変換後 8bit は拾わない）
- Color EV / currentColor に反映
- 将来: アクティブ/表示後/背景込みを選択
- 知覚ギャップ対応: 内部値と表示の乖離が大きい時のみ「取得内部値 / 表示見え方」色チップ表示
  - 条件: `max(r,g,b)>1.0` OR `viewEV≠0` OR `tonemap≠none`

### スウォッチ v1
- hex でなく `LinearColor` を保存（HDR >1.0 保持）
- v1 は localStorage、将来 `.pmx` document swatches
- チップは表示用変換、HDR にはバッジ、クリックで内部値を currentColor に戻す
```ts
interface PhotonSwatch { id: string; name?: string; color: {r,g,b,a}; createdAt: number; }
```

### Glow / Bloom v1
- 非破壊効果レイヤー・対象=下の合成結果
- 抽出 `max(rgb)>threshold`、抽出色=元の HDR、ぼかしてリニア加算、表示変換を通す
- params: `threshold` 0–8 既定1 step0.1 / `radius` 1–128px 既定16 / `intensity` 0–4 既定1 step0.1
- v1 非対象: 多段Bloom・レンズ汚れ・色収差・ノードUI・解像度依存最適化

### Add / Linear Dodge v1
- 内部 `add` / UI 名 `加算（光）` / tooltip `Linear Dodge: リニア空間で光量を足します`
- Photoshop 互換ではなく PhotonMixer の光量合成。用途: 発光・ライト・反射・ハイライト

### .pmx 保存対象
```ts
interface PmxDocumentSettings {
  view: { viewEV: number; tonemap: 'pbrNeutral'|'agx'|'reinhard'|'none'; viewMode: 'display'|'rawLinear'|'clipWarning'; };
  swatches: PhotonSwatch[];
}
interface PmxEffectLayer {
  id: string; name: string; visible: boolean; opacity: number; blendMode: 'normal';
  kind: 'effect'; filterType: 'glow'|'blur'|'sharpen'|'exposure'|'levels'|'curve';
  params: Record<string, number>; curvePoints?: { x: number; y: number }[];
}
```

### 完了条件
- [x] +EV の色で描くと内部リニア >1.0
- [x] 表示露出を下げると HDR 部の階調が見える
- [x] 白飛び確認で >1.0 が赤
- [x] スポイトで**合成結果の** HDR 色を拾い Color EV に戻せる（requestCompositeSnapshot）
- [x] スウォッチに HDR 色保存・再選択で同じ内部値
- [x] Glow が HDR を拾って発光
- [x] `加算（光）` レイヤーで光量加算（UI 名称「加算（光）」＋ Linear Dodge tooltip）
- [x] `.pmx` 保存・再読込で View settings / swatches / 効果レイヤー復元
- [x] PNG 書き出しが表示変換と一致

> 未対応（v1範囲外）: スポイトの知覚ギャップ色チップ表示 / Color EV スライダーの SDR・HDR 視覚分離UI / EXR・タイル。
```
