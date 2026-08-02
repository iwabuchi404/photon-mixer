# UI再設計 v2 + レイヤーモデル再設計 実装計画

作成: 2026-08-01

## 出発点

- ideas ドキュメント「UI再設計 v2」「レイヤーモデル再設計」（2026-08-01 検討）をベースに再検討
- decisions ドキュメント「UIコンセプト（絵は光の下に在る）」に従う
- ユーザー指示: モデル優先（データモデル → レンダラー → UI の順で移行）

## 現状の課題

### レイヤーモデル
- ペイントレイヤーと効果レイヤーが同じ `layers: LayerTex[]` 配列に混在
- 効果レイヤーは位置で入力ソースが暗黙に決まる（`source: 'below'` or ペイントレイヤーID）
- フォルダ概念なし（階層整理不可）
- Pass Through 問題が潜在（フォルダがないので今は表面化していないが、追加すると立即出現）

### UI
- 視覚的階層がゼロ（開発モニタ・スライダー群・4パネル・キャンバスが同強さ）
- 緑（#0f0）がアクセントカラーだが、光量・HDRのコーンセプトと合わない
- レイヤー行に合成モードが埋まっている（行が太る）
- 5パネル縦スクロールでキャンバスが狭い

## 設計: 3オブジェクト構造

### データモデル

```typescript
// レイヤーツリーのノード（フォルダ or セル）
type LayerNode = FolderNode | CellNode;

interface FolderNode {
  id: string;
  name: string;
  kind: 'folder';
  collapsed: boolean;       // UIの畳み状態のみ。合成には影響しない
  visible: boolean;         // 子を一括制御（Photoshop型）。ただし opacity/blendMode は持たない
  children: LayerNode[];
}

interface CellNode {
  id: string;
  name: string;
  kind: 'cell';
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
  alphaLock: boolean;
  effects: EffectChainItem[];   // 素材に付属する効果チェーン
}

interface EffectChainItem {
  id: string;
  name: string;
  filterType: FilterType;
  params: FilterParams;
  curvePoints?: CurvePoint[];
  visible: boolean;
  opacity: number;
}

// 文書全体
interface DocumentModel {
  rootNodes: LayerNode[];            // レイヤーツリー
  rootEffects: EffectChainItem[];    // 撮影スタック（ルート効果チェーン）
  activeCellId: string | null;       // アクティブなセル（描画先）
}
```

### 撮影スタック = ルート効果チェーン

ideasドキュメントの「文書全体もひとつの素材。したがって撮影スタック = ルート素材の効果チェーン」に従う。

- すべてのセル合成結果 → rootEffects を順に適用 → 最終表示
- 現行の「効果レイヤーが source='below' でスタックに挿入」は rootEffects に集約
- 現行の「効果レイヤーが source=ペイントレイヤーID で特定レイヤーに適用」は セルの effects に移行

### 合成パイプライン（新）

```
1. rootNodes を下から順に走査
   - フォルダ: スキップ（合成に参加しない）
   - セル: committed テクスチャを blend
2. 全セル合成後、rootEffects を順に適用
3. 表示変換（OCIO）→ 画面
```

セルの効果チェーン（cell.effects）はセルの committed に適用されてから合成に参加する。
つまり、セルの合成イメージ = セルの committed → effects 順に適用 → 合成用テクスチャ。

## 実装フェーズ

### Phase 1: データモデル修正

**対象ファイル**:
- `src/render/pipeline.ts` — LayerInfo/LayerTex → FolderNode/CellNode/EffectChainItem
- `src/pmx.ts` — PmxLayer/PmxEffectLayer → 新モデル対応

**作業内容**:
1. 新しい型定義を追加（FolderNode, CellNode, EffectChainItem, DocumentModel）
2. `layers: LayerTex[]` → `rootNodes: LayerNode[]` + `rootEffects: EffectChainItem[]`
3. レイヤー操作メソッド（addLayer, addFolder, removeLayer, moveLayer等）を新モデル対応
4. 効果レイヤー操作を addEffectToCell / addEffectToRoot に分離
5. .pmx 保存・読込を新モデル対応（manifest.json の構造変更）
6. 旧形式.pmxのマイグレーションツール（別途、必要時）

**移行互換性**:
- 旧形式（layers + effectLayers + stackOrder）は手動マイグレーション
- 新バージョンでは新形式のみ読込対応

### Phase 2: レンダラー修正

**対象ファイル**:
- `src/render/pipeline.ts` — compositeLayers の書き換え
- `src/render/filter.ts` — 変更不要（FilterRenderer.apply はそのまま使える）

**作業内容**:
1. `compositeLayers` を新モデル対応:
   - rootNodes の走査（フォルダスキップ、セル合成）
   - セルの effects 適用（committed → effects → 合成用テクスチャ）
   - rootEffects の適用（全セル合成後）
2. アクティブセルのライブストローク処理を新モデル対応
3. ズーム/パン/回転の表示パスは変更不要（最終結果テクスチャを使う）

### Phase 3: UIコンポーネント整理

**対象ファイル**:
- `index.html` — レイアウト変更、状態色変更
- `src/main.ts` — レイヤーパネル再構築、効果チェーンパネル
- `src/ui/engine-ctx.ts` — 新モデル対応のメソッド追加

**作業内容**:
1. **左右分割レイアウト**:
   - 左: ツールバー + ツール設定（ツールバーのすぐ横）
   - 右: カラー / 表示 / レイヤー / 効果チェーン / ファイル
2. **レイヤーパネル**:
   - フォルダ/セルのツリー表示（インデント＋畳み展开）
   - レイヤー行26px固定
   - 合成モードを行から外し、選択セルの共有ストリップへ集約
   - 不透明度は行背景の帯で表現
   - 効果はレイヤーリストに表示しない
3. **効果チェーン専用パネル**:
   - 選択中セルの effects を表示・編集
   - ルート効果チェーン（撮影スタック）の表示・編集
   - セル/ルートの切り替えタブ
4. **状態色変更**:
   - 緑（#0f0）廃止
   - グレースケール（基本UI）＋オレンジ（光量/HDR関連）＋赤（破壊的操作）
   - 選択状態: 明度＋左端バー
5. **キャンバス地色**: 低彩度・固定明度（カラーマネジメント上の決定）
6. **パフォーマンスモニタ**: 開発用→折りたたみ可能 or 非表示デフォルト

### Phase 4: ビルド + テスト検証

1. `npm run build` 成功
2. `npm test` 全テスト合格
3. レイヤー操作のテスト追加（フォルダ/セル/効果チェーン）
4. .pmx 往復テスト（新形式 + 旧形式読込）
5. `scripts/verify-*.mjs` で動作確認

## 設計判断の確認事項

### フォルダの表示制御
フォルダは visible を持ち、子を一括制御できる（Photoshop型）。
opacity/blendMode は持たない（合成上の意味を持たせない原則は維持）。

### セルの効果チェーン適用タイミング
セルの effects は committed に適用されてから合成に参加する。
つまり、セルの合成イメージ = committed → effects → 合成用テクスチャ。
これは「セルが常にisolated」という原則に合致。

### Undo/Redo
現状はレイヤーID単位の履歴。新モデルでもセルID単位の履歴を維持。
フォルダの構造変更（移動・追加・削除）もUndo対象にする必要がある。

### 既存.pmxファイルの互換性
旧形式（layers + effectLayers + stackOrder）は手動マイグレーション。
新バージョンでは新形式のみ読込対応。旧ファイルは別途マイグレーションツールで変換。
