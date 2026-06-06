# UI改善プラン（ツール拡張対応・操作性向上）

ツールが増え、単一パネル全部入りで使いづらくなった UI を、拡張に強く・ツールごとに最適化された
レイアウトへ刷新する。**本書は方針確定版（実装は次ステップ）**。

## 背景・現状の問題

現状は [index.html](../../index.html) の `#brush-controls` 1枚にツール・全パラメータ・カラー・
背景・プリセット・ファイル操作・が縦積みで同居している。

- ツール9個が絵文字1行（増えると溢れる）
- 全パラメータ常時表示（消しゴム時の「にじみ/テクスチャ」、ブラシ時の「許容値」など無関係項目が出っぱなし）
- 状態がツール間で共有（`AppState` + `strokeManager`/`stabilizer`）→ ツールごとの設定が保持されない
- ツール用パラメータと文書操作（保存/PNG/クリア/背景）が混在
- 絵文字ボタン・36px の数値入力など、押しづらい・編集しづらい

## 決定事項（確定）

| 項目 | 決定 |
|---|---|
| UI実装技術 | **Lit（Web Components）**。サイドパネルのみ。キャンバス/描画/入力はバニラ維持 |
| ツールバー配置 | **左に縦バー（カテゴリ別）** |
| 「色」の扱い | **色は全ツール共通**／サイズ・不透明度・にじみ等は**ツール個別** |
| 進め方 | プラン承認 → 実装は次ステップ。配信は段階的（各ステップ単体でビルド可能） |

## 目標レイアウト

```
┌──────────────────────────────────────────────────────┐
│[FPS/Zoom]                           ┌ ツールオプション ┐│
│ ┌─┐                                 │ ブラシ          ││
│ │描│ 🖌 ✏ 💧 📏    ←描画系          │ サイズ [==o==] 20 px ││
│ │画│                                │ 不透明 [===o=] 100% ││
│ ├─┤                                 │ にじみ [o====]  0% ││
│ │塗│ 🧪 🪣         ←色・塗り        │ 補正  [==o==] 30% ││
│ ├─┤                                 │ 方式  [スタンプ ▾] ││
│ │選│ ⬚ ✦ ✥ ⤢      ←選択・変形      └────────────────┘│
│ └─┘                                 ┌ カラー(HSV+履歴) ┐│
│  ↑左:縦ツールバー(カテゴリ区切り)    └────────────────┘│
│              [ canvas ]             ┌ レイヤー ───────┐│
│                                     └────────────────┘│
│                          [ファイル: 保存 開く PNG クリア]│
└──────────────────────────────────────────────────────┘
```

- 左＝縦ツールバー（カテゴリ別の区切り。増えても縦に伸ばせる）
- 右上＝**アクティブツールのオプションのみ**を文脈表示
- カラー / レイヤー / ファイル操作を別エリアに分離。各セクションは折りたたみ可能

---

## ① ツール状態を個別保持

`Map<Tool, ToolSettings>` を導入。`setTool()` で「離脱ツールの現値を保存 → 選択ツールの値を
UIとエンジン（`strokeManager`/`stabilizer`/`RenderPipeline`）へ復元」する。

```ts
interface ToolSettings {
  size?: number; opacity?: number; wet?: number;
  mixMode?: BrushMixMode; pressureCurve?: PressureCurve;
  stabilize?: number; useTexture?: boolean; textureScale?: number;
  tolerance?: number; selectMode?: 'rect' | 'lasso' | 'wand';
}
```

**共有（global, 個別化しない）**: 描画色（HSV＋履歴）、背景、レイヤー、ファイル操作、キャンバス。

**ツール別の保持項目／表示項目**:

| ツール | 個別保持・表示するパラメータ |
|---|---|
| ブラシ | size / opacity / wet / mixMode / stabilize / curve / texture / scale |
| 消しゴム | size / opacity / stabilize / curve |
| ぼかし | size / wet(=強さ) / stabilize |
| 直線 | size / opacity |
| バケツ | tolerance |
| スポイト | （なし） |
| 選択 | selectMode / tolerance(自動選択時) |
| 移動 | （なし。操作ヒント表示） |
| 変形 | 確定 / 取消 |

`setTool` フロー: `saveCurrentToolSettings(prev)` → `currentTool=next` → オプションパネル再描画
→ `loadToolSettings(next)`（UIとエンジンへ反映）。

---

## ②③ カテゴリ整理 ＆ 拡張に強い仕組み（データ駆動）

ツール定義を1か所（`src/ui/tool-config.ts`）に集約し、**ツールバーとオプションパネルを自動生成**する。
ツール追加は定義を1エントリ足すだけ。

```ts
// カテゴリ
type Category = 'draw' | 'fill' | 'select';

// ツール定義
const TOOLS: ToolDef[] = [
  { id:'brush',  label:'ブラシ',   icon:'🖌', category:'draw',
    shortcut:'B', params:['size','opacity','wet','mixMode','stabilize','curve','texture'] },
  { id:'eraser', label:'消しゴム', icon:'✏', category:'draw',
    shortcut:'E', params:['size','opacity','stabilize','curve'] },
  // ... blur / line / spoit / bucket / select / move / transform
];

// パラメータ定義（コントロールの種類・範囲・反映先）
const PARAM_DEFS: Record<ParamKey, ParamDef> = {
  size:    { kind:'slider+num', label:'サイズ', min:1, max:100, unit:'px', apply:(v)=>... },
  opacity: { kind:'slider',     label:'不透明', min:1, max:100, unit:'%',  apply:(v)=>... },
  wet:     { kind:'slider',     label:'にじみ', min:0, max:100, unit:'%',  apply:(v)=>... },
  mixMode: { kind:'select',     label:'方式', options:[['stamp','スタンプ'],['progressive','引きずり']] },
  // ...
};
```

- **ツールバー**: `TOOLS` を `category` でグループ化して縦バーへ描画（カテゴリ間に区切り線）
- **オプションパネル**: アクティブツールの `params` を `PARAM_DEFS` から描画（無関係項目は出さない）
- ショートカットも定義から一元登録（既存 B/E/I/G/U/V/M/W/T を踏襲）

---

## ④ ボタン・数値入力のUI改善

- CSS変数でトークン化（色・余白・サイズ）。`.tool-btn` / `.ctrl-row` を共通コンポーネント化
- ツールアイコン 32–36px、ホバー/アクティブ状態を明確化、ツールチップにショートカット併記
- 数値入力は「スライダー＋数値＋単位」の統一様式。数値欄を広げ、`±`ステッパー・ホイール/上下キー増減・Enterでクランプ
- 折りたたみセクション（`<details>`）でカテゴリが増えても破綻しない

---

## 実装ステップ（段階リリース・各ステップ単体でビルド/確認可能）

1. **CSS基盤**: 変数・共通ボタン/入力クラス整備、既存パネルの見た目刷新（機能変更なし・低リスク）
2. **ツール定義**: `src/ui/tool-config.ts`（`TOOLS`/`PARAM_DEFS`）追加 → **左縦ツールバー**をデータ駆動生成、既存ボタンと差し替え
3. **オプション文脈表示**: アクティブツールの `params` のみ動的描画
4. **ツール個別状態**: `ToolSettings` 導入、`setTool` で保存/復元
5. **エリア分離**: カラー / レイヤー / ファイル操作を独立セクション化、折りたたみ対応

## 実装アーキテクチャ（拡張性・バグ耐性）

### 設計原則

1. **単一の真実（Single Source of Truth）**: ツール／パラメータは `tool-config.ts` の定義だけが真実。
   ツールバー・オプションパネル・ショートカット・個別状態の既定値は**すべて定義から導出**する。
   → ツール追加＝定義1エントリ。UI/状態/ショートカットを個別に直す必要がない。
2. **反映経路を一本化（Single apply path）**: 「コントロール変更」も「ツール切替時の復元」も
   必ず `PARAM_DEFS[key].apply(value, engine)` を通る。現状のように各イベントハンドラが
   ばらばらに `updateBrushConfig` を呼ぶ構造をやめる。→ あるパラメータの反映ロジックは1か所だけ。
3. **純粋コアと薄いアダプタ**: 状態管理（`ToolSettingsStore`）と定義は DOM/GPU 非依存の純粋ロジックにし、
   `panel.ts` が DOM、`EngineCtx` が描画エンジンへの薄い橋渡しに徹する。→ コアを headless でテスト可能
   （`selection/mask.ts` と同じ方針）。
4. **型でミスを潰す**: `Record<Tool, ...>` / 判別可能ユニオン / `assertNever` で、ツールやパラメータの
   定義漏れ・分岐漏れを**コンパイルエラー**にする。
5. **値の正規化を集中**: クランプ（min/max/step）は `PARAM_DEFS` と `store.set` の1か所のみ。
   → 範囲外値が UI・状態・エンジンに伝播しない。

### モジュール構成

```
src/ui/
  tool-config.ts    # CATEGORIES / TOOLS / PARAM_DEFS（純粋データ＋apply関数）= 真実 ※フレームワーク非依存
  tool-settings.ts  # ToolSettingsStore（個別状態の保持・保存/復元・既定値・クランプ）= 純粋 ※同上
  engine-ctx.ts     # EngineCtx（strokeManager/stabilizer/pipeline/共有state への反映窓口）
  components/        # Lit コンポーネント（DOMアダプタ。ロジックは持たず上記を描画/束縛）
    tool-bar.ts       # <pm-tool-bar>     左縦ツールバー（TOOLS をカテゴリ別に描画）
    tool-options.ts   # <pm-tool-options> アクティブツールの params を描画
    param-control.ts  # <pm-param>        range/select/toggle を PARAM_DEFS から描画
    store-controller.ts # ToolSettingsStore を Lit の ReactiveController で橋渡し
```

- **純粋コア（config / settings / engine-ctx）は Lit に依存しない** → headless でユニットテスト可能。
- Lit コンポーネントは「描画と束縛」だけの薄い層。状態変更は `store.set` → `apply` の一本道を呼ぶだけ。
- `main.ts` は「エンジン生成・`EngineCtx` 提供・コンポーネントのマウント・`setTool` の保存/復元」に縮小。

### Lit 採用の具体方針（ビルド・互換・反応性）

- **バンドラ不要**: `lit` は ESM。`fflate` と同様に **importmap** に追記して `node_modules` から読み込む。
  ビルドは `tsc` のまま（`index.html` の importmap に `"lit": "./node_modules/lit/index.js"` 等を追加）。
- **tsconfig**: Lit 3 は TS 5 の標準デコレータで動く。デコレータ運用が不安なら
  **デコレータなし**（`static properties` ＋ `customElements.define`）でも実装可能 → まずは無デコレータで安全に。
- **Shadow DOM を使わず Light DOM で描画**（`createRenderRoot() { return this; }`）。理由:
  - 既存スタイル（CSS変数・共通クラス）をそのまま適用できる
  - **既存の `verify-*.mjs` が `document.getElementById('tool-brush')` 等で要素を取得**しているため、
    Shadow DOM に隠すと壊れる。Light DOM＋**安定ID/命名規則を定義から生成**して互換を維持
    （`id="tool-${id}"`, 選択モード `select-mode-*`, `bucket-tolerance` 等を踏襲）
- **反応性**: `ToolSettingsStore` はフレームワーク非依存のまま。`store-controller.ts`（Lit ReactiveController）が
  ストアの変更を購読してコンポーネントを再描画する。エンジンへの反映は購読側ではなく
  `store.set` 時に `PARAM_DEFS[key].apply(value, engineCtx)` を呼ぶ（UIと描画の二重管理を避ける）。
- **境界**: Lit が触るのはサイドパネルのコンテナのみ。`#canvas` / `#selection-overlay` / `#brush-cursor` と
  ポインタ入力・WebGPU 描画ループは現状のバニラ実装のまま。

### 型定義（要点）

```ts
export type Category = 'draw' | 'fill' | 'select';
export type ParamKey = 'size'|'opacity'|'wet'|'mixMode'|'stabilize'|'curve'|'textureScale'|'tolerance'|'selectMode';

export interface ToolDef {
  id: Tool; label: string; icon: string; category: Category;
  shortcut?: string;
  params: ParamKey[];       // 表示・個別保持するパラメータ
  actions?: ActionKey[];    // ボタン群（選択: all/clear/invert、変形: commit/cancel）
}

// コントロール種別は判別可能ユニオン → 描画も apply も網羅的に分岐できる
export type ParamDef =
  | { key: ParamKey; kind: 'range';  label: string; min: number; max: number; step?: number; unit?: string; default: number;  apply(v: number,  e: EngineCtx): void }
  | { key: ParamKey; kind: 'select'; label: string; options: [value: string, label: string][]; default: string; apply(v: string,  e: EngineCtx): void }
  | { key: ParamKey; kind: 'toggle'; label: string; default: boolean; apply(v: boolean, e: EngineCtx): void };

// エンジンへの反映窓口（apply は具体クラスではなくこの facade に依存）
export interface EngineCtx {
  setSize(px: number): void;          // strokeManager の base/max を更新
  setOpacity(a01: number): void;      // currentColor.a 更新＋pipeline反映（色は共有）
  setWet(w01: number): void;
  setStabilize(p01: number): void;    // stabilizer.updateConfig へマッピング
  setMixMode(m: BrushMixMode): void;
  setPressureCurve(c: PressureCurve): void;
  setTextureScale(x: number): void;
  setTolerance(t01: number): void;
  setSelectMode(m: 'rect'|'lasso'|'wand'): void;
}
```

### データフロー（単方向・一本道）

```
[UIコントロール変更]
      │ onInput(value)
      ▼
ToolSettingsStore.set(tool, key, value)   ← min/max でクランプ（唯一の正規化点）
      │
      ▼
PARAM_DEFS[key].apply(value, engineCtx)   ← 反映ロジックは各paramに1つだけ
      │
      ▼
[strokeManager / stabilizer / RenderPipeline / 共有state]

setTool(next):
  saveCurrentControls() → store へ（離脱ツール）
  currentTool = next
  panel.renderOptions(next)                 ← 定義から該当paramのみ描画
  for key of next.params:                    ← 復元
      v = store.get(next, key)
      panel.setControl(key, v); PARAM_DEFS[key].apply(v, engineCtx)
```

復元は `apply` を再実行するだけ＝**冪等**（accumulation しない）。これが保存/復元バグを防ぐ。

### バグ耐性の作り込み（チェックリスト）

- **定義整合テスト**（headless `node:test`）:
  - すべての `Tool` に `ToolDef` が存在する
  - すべての `ToolDef.params` が `PARAM_DEFS` に存在する
  - すべての `ParamDef.default` が `[min,max]` 内（range の場合）
  - `shortcut` の重複なし
- **`ToolSettingsStore` テスト**: 既定値生成 / set→get / クランプ / ツール間で値が混ざらない / 保存→切替→復元で一致
- **網羅分岐**: コントロール描画・apply で `switch(kind)` に `default: assertNever(kind)` を置く
- **冪等性テスト**: 同じ settings を2回 apply しても結果が同じ（簡易: apply 呼び出し回数や set 値で検証）
- **ID後方互換**: `verify-*.mjs` が参照する既存ID（`tool-brush`, `bucket-tolerance`, `select-mode-*` 等）を
  定義から**同じ命名規則で生成**して維持。変える場合は verify スクリプトも同時更新
- 各ステップで `npx tsc --noEmit` / `npm test` / `npm run build` を必須ゲートにする

### 段階的移行（各ステップが単体で動作・ロールバック可能）

| Step | 内容 | リスク | 検証 |
|---|---|---|---|
| 0 | **EngineCtx 抽出**: 既存ハンドラの `updateBrushConfig` 等を facade 経由に置換（UI変更なし・Lit不要） | 低 | 既存 verify が回帰なし |
| 1 | `tool-config.ts` / `tool-settings.ts` 追加（データのみ・未配線）＋**整合/ストアのユニットテスト** | なし | `npm test` |
| 2 | **Lit 導入**（importmap 追記・tsconfig確認）＋ `<pm-tool-bar>`（左縦）をマウントし既存ボタンと差替え（Light DOM・ID互換維持） | 中 | クリックでツール切替・既存 verify |
| 3 | `<pm-tool-options>`＋`<pm-param>` で `params` を動的描画（無関係項目を出さない） | 中 | 表示出し分け |
| 4 | `store-controller` で `ToolSettingsStore` を配線（保存/復元の反応的反映） | 中 | ツール別保持 |
| 5 | カラー/レイヤー/ファイルをコンポーネント化・エリア分離・折りたたみ・CSSトークン | 低 | 見た目 |

- Step 0/1 は**振る舞いを変えない土台づくり**（Lit 非依存・純粋）なので安全に先行できる。
- **Lit は Step 2 で初めて導入**。Step 0/1 で土台とテストを固めてから UI を載せ替える。
- 各 Step はコミット単位。途中で止めても動作する。

### 拡張シナリオ（この仕組みでどれだけ簡単か）

- **新ツール追加**（例: グラデーション）: `TOOLS` に1エントリ（`category`・`icon`・`params`・`shortcut`）。
  → ツールバー配置・オプション表示・個別状態・ショートカットが自動で付く。
- **新パラメータ追加**（例: 「硬さ」）: `PARAM_DEFS` に1エントリ（範囲・既定・`apply`）＋使うツールの `params` に追加。
  → コントロール描画・クランプ・保存復元・反映が自動。整合テストが抜けを検出。

## 影響ファイル

- `index.html` — パネル枠の再編（コンポーネントのマウント先）＋ **importmap に `lit` 追記**
- `package.json` — 依存に `lit` を追加（`tsc` のまま・バンドラ不要）
- `tsconfig.json` — デコレータ運用時のみ確認（無デコレータなら変更不要見込み）
- `src/main.ts` — `setupControls`→配線（store→apply）へ縮小、`setTool` に保存/復元、ショートカット一元化、コンポーネントのマウント
- 新規 `src/ui/tool-config.ts` — `CATEGORIES`/`TOOLS`/`PARAM_DEFS`（真実・純粋データ＋apply）※Lit非依存
- 新規 `src/ui/tool-settings.ts` — `ToolSettingsStore`（個別状態・保存/復元・クランプ・純粋）※Lit非依存
- 新規 `src/ui/engine-ctx.ts` — `EngineCtx`（エンジン反映窓口の facade）
- 新規 `src/ui/components/*.ts` — Lit コンポーネント（tool-bar / tool-options / param-control / store-controller）
- 新規 `tests/tool-config.test.ts` / `tests/tool-settings.test.ts` — 定義整合・ストアのユニットテスト
- CSS（`index.html` 内 or 新規） — トークン・共通コンポーネント（Light DOM なので従来CSSがそのまま効く）

## 受け入れ条件

- [ ] ツール切替で各ツールのサイズ/不透明度/にじみ等が保持される（色は共通）
- [ ] アクティブツールに関係するパラメータのみ表示される
- [ ] ツール追加が定義1エントリで完結する（バー・オプション・ショートカット自動反映）
- [ ] ボタン/数値入力が押しやすい（サイズ・ステッパー・キーボード操作）
- [ ] 既存機能（描画・混色・選択・移動・変形・レイヤー・保存/書き出し）に回帰がない
- [ ] `npx tsc --noEmit` / `npm run build` が通る
