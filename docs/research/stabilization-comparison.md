---
type: research
title: 他ソフトの手ブレ補正・ペンエンジン実装調査
created: 2026-07-29
tags: [research, stabilization, pen-engine, SAI, ClipStudioPaint, Krita, Photoshop, LazyNezumi]
related:
  - '[[index]]'
  - '[[pen-render-engine]]'
---

## 調査目的

PhotonMixer の手ブレ補正（EMA / 速度適応α）とペンエンジンが、他のお絵描きソフトと比較してどういう位置づけか、今後の改善方向を見極めるための調査。

---

## 調査対象ソフト

| ソフト | 開発元 | 公開レベル |
|---|---|---|
| ペイントツールSAI / SAI2 | SYSTEMAX | アルゴリズム非公開（挙動から推測） |
| CLIP STUDIO PAINT | CELSYS | アルゴリズム非公開（マニュアルから推測） |
| Krita | KDE | **オープンソース**（実装詳細まで確認可能） |
| Photoshop CC 2018+ | Adobe | アルゴリズム非公開（機能名から推測） |
| LazyNezumi Pro | Geraldine Zwang | ドキュメントが詳細（擬似オープン） |
| ibisPaint | ibis Inc. | アルゴリズム非公開（機能名から推測） |

---

## 1. ペイントツールSAI / SAI2

### 手ブレ補正の階層

SAI は手ブレ補正の階層が 2 段階あるのが特徴。

| 設定値 | 特徴 |
|---|---|
| 0〜15 | 通常方式。軽い平滑化。遅延少なめ |
| S-1〜S-7 | 強力補正。大幅な遅延と引き換えに強力な平滑化。動作が重い |

公式 FAQ より:
> 手ぶれ補正のS-?は補正が特別強い半面遅れも大きいので必要がない限りは設定しないでください。

### Ver.1方式 vs 通常方式

SAI2 では手ブレ補正の方式をツールごとに切り替え可能:
- **Ver.1方式**: SAI Ver.1 と同等の処理。線が遅れたり先がにゅっと曲がる現象が報告される
- **通常方式**: SAI2 の新しい処理。Ver.1方式より自然

### 推測される実装

- 0〜15: EMA または移動平均（軽め）
- S-1〜S-7: **Pulled String（紐引き）方式** に近い。強い遅延と強力な平滑化のトレードオフが Pulled String の特性と一致

### ペン入れレイヤー

SAI のペン入れレイヤーは **ベジェ曲線で内部表現** されており、描線を後から編集可能。これ自体が一種の「後補正」に相当:
> ペン入れレイヤーでは描線を後から自由に編集できるように、SAIの内部でベジェ曲線と言われる数式で表現できる曲線に変換されます。

---

## 2. CLIP STUDIO PAINT（クリスタ）

### 手ブレ補正の構成

クリスタは **3 つの補正機能** を組み合わせるのが特徴。

| 機能 | 範囲 | 働き |
|---|---|---|
| 手ブレ補正 | 0〜100 | リアルタイム平滑化。値が大きいほど滑らかだが遅延増 |
| 速度による手ブレ補正 | ON/OFF + 補正タイプ | 速度に応じて補正強度を動的変更 |
| 後補正 | ON/OFF + 強さ | **ストローク確定後** に線全体を平滑化 |

### 速度による手ブレ補正（2モード）

| モード | 働き |
|---|---|
| ゆっくり描いたときに補正をかける | 低速時ほど補正強化。細かなブレを重点補正 |
| すばやく描いたときに弱く補正 | 高速時ほど補正軽減。遅延軽減 |

※手ブレ補正 30 以上では「ゆっくり描いたときに補正をかける」は無効化される（強補正時は速度適応が不要という判断）

→ **PhotonMixer の「速度に応じてαを動的変更」はクリスタの「速度による手ブレ補正」と同じ発想**

### 後補正（事後補正）

- ストローク確定後に線全体を再平滑化
- 「描いた後に線がシュッと整う」挙動
- 推測されるアルゴリズム: **曲線フィッティング（ベジェ近似）** または **点の間引き + 補間**
- 速度による調整・表示倍率による調整もオプション存在

### マウス入力の扱い

クリスタの手ブレ補正は **ペン入力のみ有効**。マウス入力では補正が効かない（後補正はマウスでも有効）。

### ストロークプレビュー

高速描画時や補正強度が高いとき、予測ストロークをプレビュー表示して遅延感を軽減する機能（設定で制御）。
→ **PhotonMixer の C2 修正（先端予測描画）と同じ発想**

---

## 3. Krita（オープンソース・実装詳細あり）

Krita は 4 つの平滑化モードを提供。実装は `libs/ui/tool/kis_tool_freehand_helper.cpp` で確認可能。

### モード一覧

| モード | アルゴリズム | 特徴 |
|---|---|---|
| No Smoothing | なし | 生入力をそのまま使用 |
| Basic Smoothing | 単純移動平均 | 直近 N 点の単純平均 |
| **Weighted Smoothing** | **ガウシアン重み付き平均** | Gimp の sigetch アルゴリズムを改良 |
| **Stabilizer** | **移動平均 + Catch Up + Dead Zone** | Pulled String に近い。常に線を完了させる |

### Weighted Smoothing の詳細（重要）

Gimp の sigetch アルゴリズムをベースにした Krita 独自改良:

- **距離ベースの重み付け**: 速度（時間）ではなく **移動距離** を基準にする。時間計測は実環境で不安定なため
- **ガウシアンカーネル**: `sigma = distance / 3.0` で `3Σ` 範囲のサンプルを重み付け
- **Tail Aggressiveness**: ストローク終端の追従性を制御
- **Smooth Pressure**: 筆圧にも平滑化を適用可能
- **Scalable Distance**: ズームレベルに応じて距離パラメータをスケール

### Stabilizer の詳細

- **Sample Count at Max Speed**: 高速時のサンプル数（少なめが推奨）
- **Sample Count at Min Speed**: 低速時のサンプル数（多めが推奨）
- **Dead Zone**: カーソル周囲の不感帯。鋭い角を作れる
- **Finish Line**: 必ず最終カーソル位置まで線を引く

→ **速度に応じてサンプル数を変える = PhotonMixer の速度適応αと同じ発想**

---

## 4. Photoshop CC 2018+

### Brush Smoothing（0〜100%）

- 0% = 従来の軽い平滑化
- 高い値 = "intelligent smoothing"。遅延増加

### 4 つのモード

| モード | 働き |
|---|---|
| Pulled String Mode | 紐引き方式。平滑化半径内の移動は描画しない |
| Stroke Catch-Up | カーソル停止時も描画が追従し続ける |
| Catch-Up on Stroke End | ストローク終了時に最終位置まで線を引く |
| Adjust for Zoom | ズームレベルに応じて平滑化半径を調整 |

### Brush Leash（紫の線）

平滑化中のブラシ位置とカーソル位置を結ぶ補助線。遅延を視覚化。

---

## 5. LazyNezumi Pro（外部ツール・ドキュメント詳細）

4 つの位置平滑化モードを提供。**最もアルゴリズムが明確**。

| モード | アルゴリズム | 用途 | Catch Up |
|---|---|---|---|
| Pulled String | 紐引き（dead zone） | 遅い精密作業、鋭角 | 固定 |
| Moving Average | 単純移動平均（FIR） | 動的な曲線、柔らかい角 | ON/OFF可 |
| **Exponential Moving Average** | **EMA（IIR）** | 大量の平滑化、長い曲線 | ON/OFF可 |
| **Inertia** | **物理シミュレーション（質量+力+抗力）** | 高速な流れるような線 | 常時ON |

### EMA モード

> 重みが時間的に指数減衰する加重平均。Amount 設定で平滑化量を制御。Catch Up は停止時に直線的に追従する挙動。

→ **PhotonMixer の実装は LazyNezumi の EMA モードと同じアルゴリズム**

### Inertia モード（2023年追加）

- ブラシに質量を与え、ペン位置との距離を力として適用
- drag パラメータで運動量を制御
- Moving Average と同等の平滑化をより少ない遅延で実現
- 筆圧は移動速度から自動計算（テーパリング）

### 筆圧平滑化（4モード）

| モード | 働き |
|---|---|
| Fixed Value | 一定筆圧 |
| Sample & Hold | 冒頭数サンプルで筆圧固定 |
| Moving Average | 軽〜中程度の平滑化 |
| Exponential Moving Average | 軽〜大量の平滑化 |

---

## 6. ibisPaint

### 事前補正 vs 事後補正

| モード | 働き |
|---|---|
| 事前補正 | リアルタイム平滑化（デフォルト） |
| **事後補正** | **ストローク確定後に線がシュッと整う** |

事後補正は「慎重に描いてプルプルになる時」に有効。手を離した瞬間に線が整う。
→ クリスタの後補正と同じ発想

---

## 比較まとめ

### アルゴリズム分類

| アルゴリズム | 採用ソフト | PhotonMixer |
|---|---|---|
| 単純移動平均（FIR） | Krita Basic, LazyNezumi MA | ✗ |
| **指数移動平均（EMA/IIR）** | **LazyNezumi EMA**, Krita（一部） | **✓ 採用** |
| ガウシアン重み付き平均 | Krita Weighted | ✗ |
| Pulled String（紐引き） | SAI S-1〜S-7?, Photoshop, LazyNezumi, Krita Stabilizer | ✗ |
| 物理シミュレーション（慣性） | LazyNezumi Inertia, CloverPaint | ✗ |
| 曲線フィッティング（後補正） | クリスタ後補正, ibisPaint事後補正, SAIペン入れ | ✗ |
| 速度適応型α | **クリスタ**, **Krita Stabilizer**, LazyNezumi Speed Smooth | **✓ 採用** |
| 予測ストロークプレビュー | クリスタ, PhotonMixer(C2) | ✓ 採用（無効化中） |

### 機能比較

| 機能 | SAI | クリスタ | Krita | Photoshop | LazyNezumi | **PhotonMixer** |
|---|---|---|---|---|---|---|
| リアルタイム補正 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 速度適応 | ✗ | ✓ | ✓ | ✗ | ✓ | ✓ |
| 後補正（事後補正） | ✓（ペン入れ） | ✓ | ✗ | ✗ | ✗ | ✗ |
| 予測プレビュー | ✗ | ✓ | ✗ | ✗ | ✗ | ✓（無効化中） |
| Pulled String | ✓（S系?） | ✗ | ✓ | ✓ | ✓ | ✗ |
| 筆圧平滑化 | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ |
| ズーム連動 | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ |
| 終点収束 | ✗ | ✗ | ✓(Finish Line) | ✓(Catch-Up End) | ✓(Catch Up) | ✓（finishAtLastInput） |
| マウス対応 | ✓ | ✗（補正のみ） | ✓ | ✓ | ✓ | ✓ |
| 補正強度 UI | 0-15 + S-1〜7 | 0-100 | 複数パラメータ | 0-100% | 複数パラメータ | 0-100% |

---

## PhotonMixer の位置づけ

### 現在の実装の特徴

- **EMA + 速度適応α** = LazyNezumi EMA + クリスタ速度適応のハイブリッド
- **時間正規化**（timeAdjustedAlpha）= Krita が「距離ベースが安定」と指摘した問題を時間ベースで解決
- **終点収束**（finishAtLastInput）= Photoshop/LazyNezumi/Krita と同等
- **予測プレビュー**（C2）= クリスタと同等（現状無効化中）

### 強み

1. 速度適応で「遅い時は強く・速い時は弱く」を自動切替え（クリスタ/Kritaと同じ発想）
2. サンプリングレート吸収でデバイス間で一貫した挙動（独自）
3. 終点収束で線が途中で止まらない

### 弱み・改善候補

1. **Pulled String モードがない**
   - SAI S系・Photoshop・LazyNezumi・Krita Stabilizer が持つ「強力だが鋭角も作れる」モード
   - 精密な線画作業で需要が高い
   - 実装コスト: 中（dead zone + catch up ロジック）

2. **後補正（事後補正）がない**
   - クリスタ・ibisPaint が持つ「描いた後に線が整う」機能
   - リアルタイム補正の弱点（ラグ・予測揺らぎ）を補完できる
   - 実装コスト: 高（曲線フィッティング or 間引き+補間）

3. **筆圧平滑化がない**
   - Krita・LazyNezumi が持つ機能
   - 筆圧のブレ（特に安価なタブレット）を抑える
   - 実装コスト: 低（位置のEMAと同じロジックを筆圧に適用）

4. **ガウシアン重み付き平均モードがない**
   - Krita Weighted が採用。EMAより自然な平滑化
   - 実装コスト: 中（サンプル履歴を保持する必要あり）

5. **ズーム連動がない**
   - クリスタ・Krita・Photoshop が持つ機能
   - ズームアウト時は強く・ズームイン時は弱く
   - 実装コスト: 低（補正強度にズーム倍率を掛けるだけ）

6. **物理シミュレーション（Inertia）モードがない**
   - LazyNezumi Inertia が採用。少ない遅延で滑らかな線
   - 実装コスト: 中（質量+力+抗力のシミュレーション）

---

## 推奨改善優先度

| 優先 | 機能 | 理由 | コスト |
|---|---|---|---|
| ★★★ | Pulled String モード追加 | 精密線画で需要高。SAI/Photoshop/LazyNezumi/Krita全てが持つ | 中 |
| ★★★ | 筆圧平滑化オプション | 安価タブレットで需要高。実装が簡単 | 低 |
| ★★ | ズーム連動 | ズーム時の描き心地改善。実装が簡単 | 低 |
| ★★ | 後補正（事後補正） | リアルタイム補正の弱点を補完。クリスタ/ibisPaintが持つ | 高 |
| ★ | ガウシアン重み付きモード | EMAより自然だが、現状で十分滑らか | 中 |
| ★ | Inertia モード | 流れるような線向きだが、需要はニッチ | 中 |

---

## 参考リンク

- [ペイントツールSAI マニュアル - 手ぶれ補正とは？](https://w.atwiki.jp/wiki3_sai/pages/151.html)
- [SAI2 更新履歴](http://www.systemax.jp/ja/sai/history_v2.txt)
- [CLIP STUDIO PAINT ツール設定ガイド - 補正](http://www.clip-studio.com/site/gd/csp/manual/toolguide/csp_toolguide/100_reference/100_reference_hosei.htm)
- [Krita Freehand Brush ドキュメント](https://docs.krita.org/en/_sources/reference_manual/tools/freehand_brush.rst.txt)
- [Krita kis_tool_freehand_helper.cpp](https://github.com/KDE/krita/blob/master/libs/ui/tool/kis_tool_freehand_helper.cpp)
- [LazyNezumi Pro - Line Smoothing Tutorial](https://lazynezumi.com/smoothing)
- [LazyNezumi Pro Documentation PDF](https://lazynezumi.com/downloads/LazyNezumiProDoc.pdf)
- [Photoshop CC 2018 Brush Smoothing](https://retouchingacademy.com/brush-stroke-smoothing-in-photoshop-cc-2018/)
- [お絵描きソフトの手ぶれ補正を実現する技術について](https://zenn.dev/yoshi333/articles/72dc07c6ef6711)
- [stroke-stabilizer ライブラリ](https://zenn.dev/yoshi333/articles/06aa493c13a011)
- [CloverPaint 手ぶれ補正実装](https://cloverpaint.hatenablog.com/entry/2014/02/03/223316)
