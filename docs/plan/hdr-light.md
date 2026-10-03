# HDR / EV / 光コントロール基盤プラン

プロジェクトの核「光の物理単位（Photon）」を実機能化する。現状 float16 リニアで**保持はできる**が、
HDR値(>1.0)を**生む経路**と**見る経路**が無い。ここを土台から作り、その上にフィルター（Glow/Bloom 等）へ進む。

## 現状（出発点）

| 領域 | 現状 | 問題 |
|---|---|---|
| 内部表現 | `rgba16float` プリマルチプライド リニア | HDR保持は可能 |
| 色の作成 | HSV(sRGB 0–1)→`srgbToLinear` | **0–1 に収まりHDRを作れない** |
| 表示 | `fs_display`: `linear→sRGB` を **clamp(0,1)** | 露出・トーンマップ無し→白飛びクリップ |
| 書き出し | `linearToSrgbByte` で clamp | 表示と同じくクリップ |
| 光の単位 | なし | EV/露出/トーンマップ未実装 |

→ 目標: **EVで光を盛れる（HDR authoring）** ＋ **露出＋トーンマップで破綻なく見える/書き出せる（display transform）**。

## 確定事項

| 項目 | 決定 | 理由 |
|---|---|---|
| トーンマップ既定 | **Khronos PBR Neutral** | リニアsRGBで完結＝データ形式と相性◎、ペイントの色忠実性が高い |
| 同梱（切替可） | **AgX**(Rec.709行列内蔵・映画的) / **None**(clamp・生) / **Reinhard**(軽量) | 用途で選べる |
| 明るさ単位 | **EV（ストップ, 2^EV）** | ビュー露出と単位統一・光の物理単位に合致。UIに「+2.0 EV (×4.0)」と倍率併記 |
| クリップ警告 | **含める**（>1.0=赤 / <0=青 のフォルスカラー表示モード） | HDR制作の点検に必須 |
| 作業色空間 | リニア sRGB(Rec.709原色) のまま | 追加の色域変換データを持たない（AgXのみ内部にRec.709行列） |

---

## フェーズ構成

### Phase H1: 表示パイプライン（露出 ＋ トーンマップ ＋ 表示モード）★最優先
HDRを「正しく見る」基盤。これが無いとHDR色を作っても確認できない。

- **ビュー露出 (View EV)**: 合成結果に `scene * 2^viewEV` を掛けてからトーンマップ。
  ハイライトの中身を露出を下げて確認できる（HDR制作に必須）。
- **トーンマップ演算子**（WGSL）: HDR→[0,1] を破綻なく圧縮。複数搭載し切替:
  - `Khronos PBR Neutral`（**既定**・色に忠実・リニアsRGBで完結）/ `AgX`（映画的・Rec.709行列内蔵）/ `Reinhard`（軽量）/ `None(clamp)`（生）
- **表示モード**（確定: 3モード）:
  - 表示変換（露出+トーンマップ+sRGB OETF）＝既定
  - リニア生（clampのみ・現状動作。白飛び確認用）
  - **クリップ警告**（>1.0=赤 / <0=青 のフォルスカラー、白飛び/黒つぶれ点検）
- **実装**:
  - `src/color/display.ts`（純粋TS）: `applyExposure`, 各トーンマップ, `linearToDisplay()` … **ユニットテスト対象**
  - `shaders/display.wgsl`（or `composite.wgsl` 拡張）: 同じ式を WGSL で実装。最終合成結果の表示パスに適用
  - 表示uniform: `exposure(2^viewEV)`, `tonemap(enum)`, `mode(enum)`
  - **PNG書き出しも同じ変換**を通す（WYSIWYG）。`display.ts` を CPU 側でも使い、シェーダと数値一致をテスト
- **UI**: 右ドックに「表示／ライト」パネル（露出EVスライダー / トーンマップ選択 / 表示モード選択）

完了条件: HDR値を含む画像で、露出を上下するとハイライト階調が見え、トーンマップで白飛びが緩和される。表示とPNGが一致。

### Phase H2: HDR / EV カラー authoring
「光を盛る」UI。色 = 色度(HSV由来)×強度(2^EV)。`LinearColor.rgb` が 1.0 超を取れる。

- カラーモデル拡張: 現在の HSV(色度) に **EV（ストップ）** を追加。
  `linear = srgbToLinear(hsv) * 2^colorEV`（EV=0で従来どおり最大~1.0、EV+2で~4.0のHDR）
- `ColorPicker` 拡張:
  - 「アドバンス」トグルで EV スライダー（例 -6〜+6 stop）を表示
  - float内部値（R/G/B リニア）と EV を常時表示、**HDRバッジ**（>1.0で点灯）
  - スウォッチ/履歴を hex ではなく **リニア値（HDR可）** で保持（HDR色を保存・再現できる）
- スポイト: HDR値を拾い、EV/floatを反映（白飛び部の実値が取れる）
- ツール個別状態（既存 ToolSettingsStore）に `colorEV` を載せるかは色=共有方針に従い**色側で共有**

完了条件: EVを上げると内部リニア値が1.0を超え、Phase H1 の露出/トーンマップ越しに「明るい光」として描ける。

### Phase H3: 光ベースの仕上げ・整合
- **加算/スクリーン**等の光合成: レイヤーブレンドに `Add(Linear Dodge)` を追加（既存 Normal/Screen/Multiply/Overlay に並べる）。光を「足す」表現の土台
- 混色(Oklab)が HDR 値でも妥当か確認（>1.0 の cbrt は問題なし。必要なら輝度を保つ調整）
- committed が真のリニアHDRを保持していること（往復・保存）の確認
- `.pmx` は float16 でHDR保持済み。PNGは表示変換経由、（将来）EXRはリニア生

### Phase H4: フィルター基盤へ（次フェーズの入口）
HDR土台の上で「光に効く」フィルターが活きる:
- **Glow/Bloom**（しきい値>1.0 を抽出→ぼかし→加算）= HDRが本領を発揮
- 露出/レベル/カーブ、ガウシアンぼかし、シャープ等
- ここから本格的なフィルターアーキテクチャ（オフスクリーン処理パス）に展開

---

## アーキテクチャ方針（拡張性・バグ耐性）

- **表示変換は純粋関数に集約**: `src/color/display.ts`（CPU の `displayTransform`）と
  `composite.wgsl`（GPU の `fs_display`）を**同一式・同一分岐順**で実装し、
  `scripts/verify-hdr.mjs` で実 GPU の代表値と数値照合する。表示とPNGの不一致バグを防ぐ。
- **パラメータは既存の `EngineCtx`/データ駆動に載せる**: 露出・トーンマップ・表示モードを `PARAM_DEFS` 同様の
  定義で追加し、UI生成・反映を一本道に。
- **非破壊**: 内部はリニアHDRのまま不変。表示/書き出しのみ変換を通す（3DCG的なデータ/表示分離を徹底）。
- 既存テスト方針を踏襲（color変換・display変換を headless `node:test` で固定）。

## 影響ファイル（想定）
- 新規 `src/color/display.ts`（露出・トーンマップ・OETF）＋ `tests/display.test.ts`
- `shaders/display.wgsl`（or `composite.wgsl` 拡張）＋ `src/render/composite.ts`/`pipeline.ts`（表示uniform・PNG経路）
- `src/ui/color-picker.ts`（EV/アドバンス/HDR表示・スウォッチのリニア化）
- `src/ui/tool-config.ts` 風の表示パラメータ定義 ＋ 右ドックに「表示」パネル
- `src/render/blend-renderer.ts`/`blend.wgsl`（Add ブレンド追加・H3）

## 完了条件（基盤全体）
- [x] EVで内部リニア値が1.0超を取れ、保存/復元できる
- [x] 露出・トーンマップ・表示モードで HDR を破綻なく確認できる
- [x] 表示とPNG書き出しが一致する（同一変換）
- [x] 加算ブレンドで光を足せる
- [x] フィルター(Glow等)を載せる前提（リニアHDR＋オフスクリーン処理）が整う

## 2026-10 HDRレビュー後の一部改修

- **Levels / Curve の HDR 破壊を修正**（`filter.wgsl`）。旧実装は符号化域で `clamp(v,0,1)` を通していたため、
  Glow/露出で作った 1.0 超が不可逆に潰れていた。拡張 sRGB（上限クランプなし）で符号化し直し、
  補正は 0..1 域のまま（SDR の挙動は不変）、1.0 超の超過分を補正の局所ゲインで引き伸ばす方式に変更。
  twin を `applyLevelsLinear` / `applyCurveLinear` として `src/color/` に置き、ユニットテストで担保。
- **`.pmx` の `documentSettings.view` を厳格検証**。enum は `typeof string` 検査のみだと
  `indexOf() = -1` → uniform に -1 → WGSL `i32(-0.5) = 0` で「PBR Neutral / 表示変換」に静かに化け、
  その 空文字 が再保存で焼き直されていた。enum 検証・viewEV 範囲検証・swatch 数値検証を追加。
- **HDR 出力 ON 時はトーンマップ／リニア生 UI を無効表示**（`fs_display` が分岐より前でバイパスするため）。
- **スポイト乖離チップを HDR 出力時に忠実化**（「表示」を fs_display と同じ計算にし、白超えを明示）。
- **float16 変換を `src/color/float16.ts` に集約**（`main.ts` と `pipeline.ts` に重複実装があった）。
- **表示変換を一本化**: `fs_display` の CPU twin として `displayTransform`（`src/color/display.ts`）を追加。
  PNG 書き出しとスポイトチップがこれを共有し Previously あった clip 分岐の重複実装がなくなった。

## 検証網（2026-10 追加）

- `tests/display.test.ts` — `displayTransform` の**全分岐**（transform / raw / clip / hdrOut の分岐順、
  クリップ警告が露出前で判定されること、hdrOut が 1.0 超を返すこと、hdrOut 以外は必ず [0,1]、単調性）
- `tests/pmx.test.ts`（新規）— f16 の HDR 往復、全 enum メンバー、不正 enum / viewEV 範囲外 /
  NaN swatch / タイル長不一致の拒否
- `tests/levels.test.ts` / `tests/curve.test.ts` — identity で HDR を厳密保持すること、
  SDR 域では従来と同一であること
- `tests/color.test.ts` — 拡張 sRGB 変換の往復（1.0 超を含む）
- **`scripts/verify-hdr.mjs`（新規・`npm run verify:hdr`）** — **実 GPU での CPU/GPU パリティ検証**。
  診断フック `__hdrProbe` が `fs_display` をオフスクリーンに 1 パス実行して読み戻すので、
  「表示と PNG が一致する」ことを数値で担保できる。2 系統を回す:
  - SDR suite（通常起動・canvas は 8bit）— 全トーンマップ×全モード、露出 ±6EV、HDR 入力、クリップ警告
  - HDR suite（`?hdr=1` 強制・canvas は rgba16float）— 上記＋HDR 出力の 1.0 超保持、
    トーンマップ bypass、トグルと UI 無効化
  HDR 非対応 display でも `?hdr=1` なら rgba16float canvas が受理されるため、
  extended 経路はどの環境でも検証できる（実測の CPU/GPU 差は float16 精度の 5e-4 以下）。
