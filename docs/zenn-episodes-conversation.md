# PhotonMixer 開発エピソード集 — 会話から振り返る（Zenn記事素材）

> Gitコミットメッセージではなく、AIとのペアプログラミング会話の流れから抽出したエピソード。

---

## エピソード1: バグ修正2題 — 「画面サイズ」と「キャンバスサイズ」の混同

### 会話の流れ

ユーザーから「バグを2つ修正して」と指示を受けた。

**Bug 1: スナップショットサンプリングのサイズ不一致**

`buildColoredStroke` メソッドが `sampleSnapshot` を呼ぶ際、`this.renderer!.canvas.width/height`（画面サイズ）を渡していた。しかしサンプリングすべきはドキュメントキャンバスサイズ。

- 修正: `this.viewport.getCanvasSize().width/height` に置換
- 影響: ズーム時にサンプリング座標がずれ、引きずり混色の色が崩れる

**Bug 2: バケツ塗りが選択範囲を無視**

フラッドフィルアルゴリズムが選択マスクを一切考慮していなかった。選択範囲外にも塗料が流れる。

修正内容:
- `getSelectionMaskData()` でマスクデータを取得
- 開始点が選択範囲外なら早期return
- `inSelection(px, py)` ヘルパーを追加
- 左右スキャン（lx/rx ループ）と上下スタック（cy-1/cy+1）の両方に統合

### 記事のポイント
「画面座標とキャンバス座標の混同」はお絵かきソフト開発あるある。ズーム・パンがある環境では、画面ピクセルとドキュメントピクセルは常に別物。フラッドフィルへの選択マスク統合は、境界処理の設計が見どころ。

---

## エピソード2: ポータブルEXE作成 — WebGPUアプリを配布できる形にする

### 会話の流れ

バグ修正が終わった後、ユーザーが「単体で動かせるEXEファイルを作成したい」「ポータブル版」と指示。

### 調査フェーズ
- `package.json` の確認: main は `dist/electron/main.js`、ビルドスクリプトはshadersとpreload.cjsをdistにコピー
- `electron/main.ts` の確認: BrowserWindow作成、contextIsolation有効、preload指定
- `index.html` の確認: `dist/src/main.js` をmodule script としてロード
- `tsconfig.json` の確認: `src/**/*.ts` と `electron/**/*.ts` をコンパイル
- playwright-coreがdependenciesにあったが、ソースコード・テストともに未使用

### 実装
1. `electron-builder` をdevDependenciesに追加
2. `package.json` に `build` 設定を追加:
   - `appId`, `productName`, `directories.output`
   - `files`: index.html, dist/**, 必要なnode_modulesのみ
   - `win.target`: `portable`
3. `dist:win` スクリプトを追加
4. `playwright-core` を依存から除去（未使用）
5. `cross-env` を追加（PM_DEV環境変数用）
6. `electron/main.ts` のDevToolsを環境変数制御に変更

### ビルド結果
- `release/PhotonMixer-0.1.0-portable.exe`（約67MB）が生成
- Electron 30.5.1（Chromium WebGPU対応）を内包

### 記事のポイント
「WebGPUアプリを配布可能なEXEにする」までの道のり。electron-builderの設定、不要依存の除外、DevToolsの本番/開発分離など。

---

## エピソード3: 「キャンバスが作れない」— パッケージ化の罠との格闘

### 会話の流れ

EXEが生成されたので起動してもらったが、「起動はするがキャンバスが作れない、サイズを入れて作成を押しても反応なし」。

### デバッグの試行

**ステップ1: エラー可視化の追加**

まず `index.html` にエラーハンドラを追加して画面にエラーを表示する仕組みを入れた:
- `window.addEventListener('error', ...)` で赤いボックスにエラー表示
- `window.addEventListener('unhandledrejection', ...)` でPromiseエラー表示
- 3秒後にモジュールがロードされていなければ警告表示

→ 結果: 「何も出ない」

**ステップ2: DevToolsを強制有効化**

`electron/main.ts` で本番でもDevToolsを開くように変更:
```ts
if (process.env.PM_DEV) mainWindow.webContents.openDevTools();
else mainWindow.webContents.openDevTools(); // デバッグ用
```

→ DevToolsのConsoleからエラーメッセージを取得できるようになった

**ステップ3: エラー特定**

ユーザーから以下のエラーが報告された:
```
GET file:///C:/Users/.../app.asar/shaders/brush.wgsl net::ERR_FILE_NOT_FOUND
Failed to fetch
    at BrushRenderer.init (brush.js:61)
    at RenderPipeline.init (pipeline.js:66)
    at PhotonMixerApp.init (main.js:160)
```

### 原因

開発時は `fetch('shaders/brush.wgsl')` で動いていた。しかし:
- `index.html` はルートにある
- パッケージ化すると `app.asar` 内の構造は `index.html` + `dist/` + `node_modules/`
- シェーダーは `dist/shaders/` にコピーされる（ビルドスクリプトが `shaders/` → `dist/shaders/` にコピー）
- しかしfetchパスは `shaders/` のまま → ファイルが見つからない

### 修正

6ファイル全てのfetchパスを `shaders/` → `dist/shaders/` に変更:
- `src/render/brush.ts`: `shaders/brush.wgsl` → `dist/shaders/brush.wgsl`
- `src/render/filter.ts`: `shaders/filter.wgsl` → `dist/shaders/filter.wgsl`
- `src/render/downsample.ts`: `shaders/downsample.wgsl` → `dist/shaders/downsample.wgsl`
- `src/render/composite.ts`: `shaders/composite.wgsl` → `dist/shaders/composite.wgsl`
- `src/render/blend-renderer.ts`: `shaders/blend.wgsl` → `dist/shaders/blend.wgsl`
- `src/render/transform.ts`: `./shaders/transform.wgsl` → `dist/shaders/transform.wgsl`

→ 起動成功、キャンバス作成も動作

### 記事のポイント
「Webアプリは動くがパッケージ化すると動かない」の典型例。相対パスの解決が開発時とパッケージ時で異なる。特にElectronのasarアーカイブ内ではファイル構造が変わるため、fetchのパス設計が重要。デバッグの段取り（エラー可視化→DevTools→原因特定）も再現性がある。

---

## エピソード4: ブラシデフォルトの調整 — ユーザーの好みに合わせる

### 会話の流れ

EXEが動くようになった後、ユーザーから「ブラシツールのデフォルトを筆圧リニア、方式引きずりにして」と指示。

### 修正箇所（4ファイル）

1. **`src/ui/tool-config.ts`** — PARAM_DEFSのdefault値
   - `mixMode`: `stamp` → `progressive`
   - `curve`: `smooth` → `linear`

2. **`src/main.ts`** — AppState初期値とStrokeManager初期値
   - `state.mixMode`: `stamp` → `progressive`
   - `StrokeManager` の `curve`: `smooth` → `linear`

3. **`src/render/brush.ts`** — DEFAULT_BRUSH_CONFIG
   - `mixMode`: `stamp` → `progressive`

4. **`index.html`** — select要素のoption順序
   - 筆圧: `linear`を先頭に
   - 方式: `progressive`を先頭に

### ハマりポイント
`tool-config.ts` の `mixMode` を編集した際、マルチエディットの順序で最初のeditが2つ目のeditによって上書きされてしまい、`stamp`に戻ってしまった。再修正が必要だった。

### 記事のポイント
「デフォルト値は4箇所に分散している」という設計上の問題。UI定義・状態初期値・エンジン初期値・HTML要素、すべてを一貫して変更する必要がある。

---

## エピソード5: DevTools除去とリリース準備

### 会話の流れ

デフォルト調整後、ユーザーが「ビルドして」→確認→「DEVTOOLを消して」と指示。

### DevTools除去
`electron/main.ts` のデバッグ用else分岐を削除:
```ts
// 修正前
if (process.env.PM_DEV) mainWindow.webContents.openDevTools();
else mainWindow.webContents.openDevTools(); // TODO: パッケージ版デバッグ用

// 修正後
if (process.env.PM_DEV) mainWindow.webContents.openDevTools();
```

### リリース準備
ユーザーが「最初のリリースをしたい、やり方とノートを考えて」と指示。

実施したクリーンアップ:
1. **`.gitignore`** — `release/`, `.codex/` を追加
2. **`README.md`** — 概要・特徴・動作環境・ショートカット・開発手順・技術スタック
3. **`index.html`** — デバッグ用エラー表示スクリプト（3種類）を削除
4. **`package.json`** — `author: "iwabuchi404"`, `license: "MIT"` を追加
5. **`LICENSE`** — MIT License

### 検証
- `tsc --noEmit` 型チェック: OK
- テスト143件: 全パス
- `npm run dist:win`: EXE生成成功

### リリース実行
- コミット: `release: v0.1.0 — README, LICENSE, デバッグコード除去`
- タグ: `v0.1.0`
- プッシュ: `main` + tags

### 記事のポイント
「動くものができた → 配布できる形にする → 公開する」の3段階。デバッグコードの除去、ドキュメント整備、ライセンス選定など、コード以外の作業の重要性。

---

## エピソード6: Zenn記事のネタ出し — 振り返ってみて見えたもの

### 会話の流れ

リリース後、ユーザーが「Zennとかで記事を書きたい、記事にできるような実装中のエピソードをまとめてほしい」と指示。

最初はGit履歴から整理したが、ユーザーが「Git履歴ではなく会話履歴から出して」と指示修正。

### 記事のポイント
「AIとのペアプログラミングでソフトウェアを作る」過程そのものが記事になる。Gitコミットには結果しか残らないが、会話には試行錯誤のプロセスが残る。

---

## 記事構成案

### パターンA: 1本の長記事
```
タイトル: 「AIとペアプログラミングでWebGPUお絵かきソフトをリリースした話」

1. きっかけ — バグ修正からEXE化まで
2. ポータブルEXE作成 — electron-builder設定
3. 「キャンバスが作れない」— パッケージ化の罠
   - エラー可視化の試行錯誤
   - DevTools強制有効化
   - シェーダーパス問題の特定と修正
4. デフォルト調整 — 4箇所の分散した設定値
5. リリース準備 — ドキュメント・ライセンス・タグ
6. 振り返り
```

### パターンB: 分割
- 記事1: 「Electronアプリをパッケージ化したら動かなくなった話 — シェーダーパスの罠」
  → エピソード3単体。再現性が高く、解決までの道のりがストーリーになる。
- 記事2: 「WebGPUお絵かきソフトのバグ修正 — 座標系と選択マスク」
  → エピソード1単体。技術的に深い。
- 記事3: 「AIとのペアプログラミングでゼロからリリースまで」
  → 全体のプロセス振り返り。

### 推奨
**パターンA**がZenn向け。特にエピソード3（パッケージ化の罠）は、デバッグの試行錯誤がそのまま記事の構成になる。「何も出ない」→エラー可視化→DevTools→原因特定→6ファイル修正、という流れがストーリー性を持つ。
