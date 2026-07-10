# PhotonMixer

WebGPUネイティブ・float32リニアカラーのデジタルイラストソフトウェア。

GPU直接描画による低遅延ブラシ、光学的に正確な色合成、非破壊エフェクトレイヤーを備えた、デジタルネイティブな描画ツールです。

## 特徴

- **WebGPUネイティブ描画エンジン** — GPU直接描画で低遅延・高品質
- **float32リニアカラー** — HDR対応・光学的に正確な色合成
- **レイヤーシステム** — ペイントレイヤー・非破壊エフェクトレイヤー
- **ブラシツール** — 筆圧カーブ（リニア/標準/入り遅/入り早）、引きずり混色、にじみ、テクスチャブラシ
- **ツール群** — ブラシ・消しゴム・ぼかし・直線・スポイト・バケツ塗り・選択（矩形/投げ縄/自動選択）・移動・変形
- **非破壊エフェクト** — ぼかし・グロー・シャープ・露出・レベル補正・トーンカーブ
- **表示制御** — 露出EV・トーンマップ（PBR Neutral / AgX / Reinhard）・表示モード
- **ファイル形式** — .pmx（ネイティブ・レイヤー完全往復）・PNG書き出し
- **自動保存** — IndexedDB への自動バックアップ
- **ブラシプリセット** — 設定の保存/読込（ZIP形式）

## 動作環境

- **OS**: Windows 10/11 (64-bit)
- **GPU**: WebGPU対応のGPUドライバが必要
- **画面**: フルHD以上推奨

## ダウンロード

[Releases](https://github.com/iwabuchi404/photon-mixer/releases) ページから `PhotonMixer-x.x.x-portable.exe` をダウンロードして実行してください。インストール不要です。

## ショートカットキー

| キー | ツール |
|------|--------|
| B | ブラシ |
| E | 消しゴム |
| U | ぼかし |
| V | 直線 |
| I | スポイト |
| G | バケツ塗り |
| M | 移動 |
| T | 変形 |
| S | 選択 |

## 開発

```bash
# 依存関係のインストール
npm install

# 開発モード起動（DevTools付き）
npm run dev

# テスト
npm test

# ビルド
npm run build

# ポータブルEXE生成
npm run dist:win
```

## 技術スタック

- **Electron** 30 (Chromium WebGPU)
- **TypeScript** (ES2022 / ESM)
- **WebGPU** / **WGSL** シェーダー
- **Lit** (Web Components)
- **fflate** (ZIP圧縮)

## ライセンス

MIT License
