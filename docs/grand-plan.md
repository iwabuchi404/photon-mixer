# PhotonMixer グランドプラン

## プロジェクト概要

**PhotonMixer** はデジタルネイティブなイラストソフトウェア。  
「光の物理単位（Photon）＋クリエイターの混合（Mixer）」という名の通り、  
アナログ模倣を捨てて、デジタルの正確性を表現ツールとして再定義することを目指す。

### 開発の背景

SAI の軽さ・ペンの自然さ・混色は他ソフトにない。  
ただしフィルター系とパス機能が中途半端。  
これを自作で解決しながら、真のデジタルネイティブなイラストソフトを作る。

### 核となる設計方針

| 方針 | 内容 |
|---|---|
| **内部データ** | float32 リニア光量ベース（sRGB の 256×3 を捨てる） |
| **GPU** | WebGPU ネイティブ・Compute Shader 中心（将来） |
| **目標 fps** | 60fps 以上 |
| **哲学** | アナログメタファーからの脱却、3DCG 的なデータ/表示分離 |
| **出力** | OCIO ポストプロセス経由で sRGB / HDR / P3 / OpenEXR |

---

## 技術スタック

| 領域 | 技術 |
|---|---|
| アプリケーション | Electron 30 |
| 言語 | TypeScript（strict mode） |
| GPU | WebGPU（vertex/fragment shader、将来 Compute Shader） |
| ビルド | tsc（ES2022、ESM） |
| テスト | Node.js built-in test runner（`node:test`） |
| 動作確認 | playwright-core（`_electron` で Electron 自動操作） |
| OS | Windows 11 メイン想定（Electron で macOS 対応可） |

---

## プロジェクト構造

```
photon-mixer/
├── electron/
│   ├── main.ts          Electron メインプロセス
│   └── preload.cjs      プリロードスクリプト
├── src/
│   ├── main.ts          レンダラープロセス エントリーポイント
│   ├── core/            WebGPU デバイス・レンダラー初期化
│   ├── pen/             ペンエンジン（入力・補正・補間・ストローク）
│   ├── render/          GPU 描画パイプライン
│   ├── ui/              UI コンポーネント
│   └── color/           カラー変換ユーティリティ（未実装）
├── shaders/             WGSL シェーダーファイル
├── tests/               テストファイル
├── docs/                設計ドキュメント（本ファイル）
└── scripts/             開発用スクリプト（動作確認等）
```

---

## Phase 1 完了内容（現在地）

### 実装済み

**ペンエンジン** (`src/pen/`)
- `input.ts` — PointerEvent から座標・筆圧・傾きを取得、タッチ除外
- `stabilization.ts` — 速度連動 EMA フィルター（`α = clamp(speed/threshold, minAlpha, maxAlpha)`）
- `interpolation.ts` — Catmull-Rom スプライン補間（spacing=1px 固定、終点バグ修正済み）
- `stroke.ts` — 筆圧→サイズ変換（linear/ease-in/ease-out/smooth）、StrokeHistory

**WebGPU 描画** (`src/render/`)
- `brush.ts` — スタンプ方式、instanced draw（全点を 1 回で描画）、プリマルチプライドα出力、max blend
- `composite.ts` — テクスチャ合成レンダラー（premultiplied over blend）
- `pipeline.ts` — 隔離バッファ方式（isolated texture で max blend → canvas に over blend）
- `shaders/brush.wgsl` — 円形スタンプ、smoothstep アンチエイリアス、プリマルチプライドα
- `shaders/composite.wgsl` — フルスクリーン四角形でテクスチャ転写

**UI** (`src/ui/`, `index.html`)
- サイズ・不透明度スライダー、クリアボタン
- FPS / Latency / Points モニター

### 暫定実装（本実装で置き換え予定）

| 項目 | 現状 | 本実装 |
|---|---|---|
| テクスチャフォーマット | `rgba8unorm` | `rgba16float`（float32 対応）|
| spacing | 1px 固定 | 動的（4x バッファ導入後に不要化）|
| 再描画方式 | 全ストロークを毎フレーム | committed texture ベイク方式 |
| OCIO | 未実装 | Block 2 で導入 |
| レイヤー | なし（単一キャンバス） | Block 5 で実装 |

---

## 実装ブロック一覧

### Block 1: GPU アーキテクチャ刷新
**目的**: 暫定実装を本番アーキテクチャに置き換える  
**主な内容**: float32 テクスチャ移行・committed texture ベイク・4x サブピクセルバッファ  
**完了条件**: 0.5px ブラシが滑らかに描画できる、長時間描画でもパフォーマンスが安定する

### Block 2: カラーパイプライン ＋ 混色 PoC
**目的**: float32 リニアカラーと Oklab 混色の感触を早期検証する  
**主な内容**: float32 内部カラー管理・Oklab 変換・wet mixing（単一レイヤー）・カラーピッカー・OCIO 近似実装  
**完了条件**: 実ペンで混色の感触を確認できる、半透明ブラシが正しく動作する

### Block 3: 基本描画ユーザビリティ
**目的**: 実用的な描画セッションに必要な最低限の機能を揃える  
**主な内容**: Undo/Redo・ズーム/パン・キャンバスサイズ設定・消しゴム  
**完了条件**: 1時間の描画セッションが不便なく進められる

### Block 4: テクスチャブラシ ＋ ブラシプリセット
**目的**: 紙目テクスチャ等による表現の幅を広げる  
**主な内容**: テクスチャスタンプ（キャンバス座標系サンプリング）・ブラシプリセット保存/読み込み  
**完了条件**: テクスチャブラシで紙目を擦り出す感覚が再現できる

### Block 5: レイヤーシステム
**目的**: 複数レイヤーでの作業を可能にする（混色の感触確定後に設計）  
**主な内容**: レイヤーデータ構造・合成シェーダー（Normal/Screen/Multiply/Overlay）・レイヤー UI  
**完了条件**: レイヤーを使った一般的なイラスト作業ができる

### Block 6: ファイル I/O
**目的**: 作業の保存・書き出し・読み込みができる  
**主な内容**: .pmx ネイティブ形式（ZIP + EXR）・PNG/JPEG/EXR エクスポート・PSD インポート  
**完了条件**: .pmx でフル精度保存/復元できる、PNG/JPEG で正しい色で書き出せる

### Block 7: フィルター・パス（後フェーズ）
**目的**: SAI で不足していた機能領域を実装する  
**主な内容**: ぼかし/シャープ等フィルター・ベジェパス・テキスト  
**完了条件**: Block 1–6 完了後に詳細設計

---

## ブロック依存関係

```
Block 1 (GPU 基盤)
  ├─▶ Block 2 (カラー+混色)
  │     └─▶ Block 4 (テクスチャブラシ)
  │               └─▶ Block 5 (レイヤー)
  │                         └─▶ Block 6 (ファイル I/O)
  └─▶ Block 3 (ユーザビリティ) ─▶ Block 5 (レイヤー)
```

Block 1 が全ての基盤。Block 2 と Block 3 は並行作業可能。

---

## 未解決・要調査事項

| 項目 | 内容 | 影響ブロック | 優先度 |
|---|---|---|---|
| OCIO バインディング | wasm / native addon / 近似実装の選択 | 2, 6 | 高 |
| EXR 読み書きライブラリ | `openexr` npm パッケージの評価 | 6 | 中 |
| Oklab 合成の GPU コスト | per-pixel 変換のパフォーマンス測定 | 2, 5 | 中 |
| PSD パーサー | `ag-psd` 等のライブラリ選定 | 6 | 低 |

---

## 推奨着手順序

```
Block 1 → Block 2（並行: Block 3）→ Block 4 → Block 5 → Block 6 → Block 7
```

**理由**:
- Block 1 で float32 テクスチャと committed bake が確定しないと Block 2 の実装精度が落ちる
- Block 2 で混色の感触を確定させてから Block 5 のレイヤー設計に入る
- Block 3 は Block 1 後であれば GPU 設計に依存しないため並行可能

---

## 開発・テスト手順

```bash
# ビルド
npm run build

# 起動（開発）
npm run dev

# テスト（ペンエンジン単体）
npm test

# 動作確認（自動・スクリーンショット付き）
node scripts/verify-pen.mjs
```

---

*最終更新: 2026-06-01 / Phase 1 完了時点*
