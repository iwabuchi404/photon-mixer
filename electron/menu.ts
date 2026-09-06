import { Menu, type MenuItemConstructorOptions, shell } from 'electron';
import type { BrowserWindow } from 'electron';

/**
 * アプリケーションメニューのアクション種別。
 * レンダラーへは `menu:action` チャンネルで `{ action, payload? }` を送信する。
 */
export type MenuActionName =
  // ファイル
  | 'file:new'
  | 'file:open'
  | 'file:save-pmx'
  | 'file:export-png'
  // 編集
  | 'edit:undo'
  | 'edit:redo'
  | 'edit:clear-canvas'
  // 選択
  | 'select:all'
  | 'select:invert'
  | 'select:deselect'
  // レイヤー
  | 'layer:add'
  | 'layer:add-folder'
  | 'layer:delete'
  | 'layer:move-up'
  | 'layer:move-down'
  // エフェクト
  | 'effect:freeze'
  // 表示
  | 'view:zoom-in'
  | 'view:zoom-out'
  | 'view:zoom-reset'
  | 'view:reset-rotation'
  | 'view:toggle-flip'
  | 'view:toggle-ui'
  | 'view:ev-up'
  | 'view:ev-down'
  | 'view:ev-reset'
  // ヘルプ
  | 'help:about';

/** ペイロード付きアクション（effect:add / tool:set / view:tonemap / view:mode） */
export interface MenuMessage {
  action: MenuActionName | 'effect:add' | 'tool:set' | 'view:tonemap' | 'view:mode';
  payload?: string;
}

const PROJECT_URL = 'https://github.com/iwabuchi404/photon-mixer';
const DOCS_URL = 'https://frog404.work/projects/photon-mixer/';

/**
 * アプリケーションメニューを構築して適用する。
 * メニュー項目のクリックで `menu:action` IPC をレンダラーへ送信する。
 * 単キーショートカット（B/E/I 等）はレンダラー側の keydown で処理するため、
 * メニューではアクセラレーターを登録せずクリックのみとする。
 */
export function buildAppMenu(mainWindow: BrowserWindow): void {
  const send = (msg: MenuMessage) => {
    mainWindow.webContents.send('menu:action', msg);
  };

  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    // ---- ファイル ----
    {
      label: 'ファイル(&F)',
      submenu: [
        { label: '新規キャンバス...', accelerator: 'CmdOrCtrl+N', click: () => send({ action: 'file:new' }) },
        { label: '.pmx を開く...', accelerator: 'CmdOrCtrl+O', click: () => send({ action: 'file:open' }) },
        { type: 'separator' },
        { label: '.pmx を保存', accelerator: 'CmdOrCtrl+S', click: () => send({ action: 'file:save-pmx' }) },
        { label: 'PNG でエクスポート', accelerator: 'CmdOrCtrl+Shift+S', click: () => send({ action: 'file:export-png' }) },
        { type: 'separator' },
        isMac
          ? { label: 'PhotonMixer を終了', accelerator: 'Cmd+Q', role: 'quit' }
          : { label: '終了', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    // ---- 編集 ----
    {
      label: '編集(&E)',
      submenu: [
        { label: '元に戻す', accelerator: 'CmdOrCtrl+Z', click: () => send({ action: 'edit:undo' }) },
        { label: 'やり直し', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send({ action: 'edit:redo' }) },
        { type: 'separator' },
        { label: '全選択', accelerator: 'CmdOrCtrl+A', click: () => send({ action: 'select:all' }) },
        { label: '選択を反転', accelerator: 'CmdOrCtrl+Shift+I', click: () => send({ action: 'select:invert' }) },
        { label: '選択を解除', accelerator: 'CmdOrCtrl+D', click: () => send({ action: 'select:deselect' }) },
        { type: 'separator' },
        { label: 'キャンバスをクリア', click: () => send({ action: 'edit:clear-canvas' }) },
      ],
    },
    // ---- レイヤー ----
    {
      label: 'レイヤー(&L)',
      submenu: [
        { label: '新規レイヤー', accelerator: 'CmdOrCtrl+Shift+N', click: () => send({ action: 'layer:add' }) },
        { label: '新規フォルダー', accelerator: 'CmdOrCtrl+Shift+G', click: () => send({ action: 'layer:add-folder' }) },
        { type: 'separator' },
        { label: 'レイヤーを上へ', accelerator: 'CmdOrCtrl+]', click: () => send({ action: 'layer:move-up' }) },
        { label: 'レイヤーを下へ', accelerator: 'CmdOrCtrl+[', click: () => send({ action: 'layer:move-down' }) },
        { type: 'separator' },
        { label: 'レイヤーを削除', click: () => send({ action: 'layer:delete' }) },
      ],
    },
    // ---- エフェクト ----
    {
      label: 'エフェクト(&X)',
      submenu: [
        { label: 'ぼかし', click: () => send({ action: 'effect:add', payload: 'blur' }) },
        { label: 'グロー', click: () => send({ action: 'effect:add', payload: 'glow' }) },
        { label: 'シャープ', click: () => send({ action: 'effect:add', payload: 'sharpen' }) },
        { label: '露出', click: () => send({ action: 'effect:add', payload: 'exposure' }) },
        { label: 'レベル補正', click: () => send({ action: 'effect:add', payload: 'levels' }) },
        { label: 'トーンカーブ', click: () => send({ action: 'effect:add', payload: 'curve' }) },
        { type: 'separator' },
        { label: 'エフェクトを焼き込み', click: () => send({ action: 'effect:freeze' }) },
      ],
    },
    // ---- 表示 ----
    {
      label: '表示(&V)',
      submenu: [
        { label: 'ズームイン', accelerator: 'CmdOrCtrl+=', click: () => send({ action: 'view:zoom-in' }) },
        { label: 'ズームアウト', accelerator: 'CmdOrCtrl+-', click: () => send({ action: 'view:zoom-out' }) },
        { label: '実サイズ (100%)', accelerator: 'CmdOrCtrl+0', click: () => send({ action: 'view:zoom-reset' }) },
        { type: 'separator' },
        { label: '回転リセット', click: () => send({ action: 'view:reset-rotation' }) },
        { label: '左右反転', click: () => send({ action: 'view:toggle-flip' }) },
        { type: 'separator' },
        { label: 'UIパネル表示切替', click: () => send({ action: 'view:toggle-ui' }) },
        { type: 'separator' },
        { label: '露出EV +', accelerator: 'CmdOrCtrl+Shift+=', click: () => send({ action: 'view:ev-up' }) },
        { label: '露出EV -', accelerator: 'CmdOrCtrl+Shift+-', click: () => send({ action: 'view:ev-down' }) },
        { label: '露出EV リセット', click: () => send({ action: 'view:ev-reset' }) },
        { type: 'separator' },
        {
          label: 'トーンマップ',
          submenu: [
            { label: 'PBR Neutral', type: 'radio', click: () => send({ action: 'view:tonemap', payload: 'pbrNeutral' }) },
            { label: 'AgX', type: 'radio', click: () => send({ action: 'view:tonemap', payload: 'agx' }) },
            { label: 'Reinhard', type: 'radio', click: () => send({ action: 'view:tonemap', payload: 'reinhard' }) },
            { label: 'なし', type: 'radio', click: () => send({ action: 'view:tonemap', payload: 'none' }) },
          ],
        },
        {
          label: '表示モード',
          submenu: [
            { label: 'トーンマップ後', type: 'radio', click: () => send({ action: 'view:mode', payload: 'transform' }) },
            { label: 'Raw', type: 'radio', click: () => send({ action: 'view:mode', payload: 'raw' }) },
            { label: 'クリップ', type: 'radio', click: () => send({ action: 'view:mode', payload: 'clip' }) },
          ],
        },
      ],
    },
    // ---- ツール ----
    {
      label: 'ツール(&T)',
      submenu: [
        { label: 'ブラシ', click: () => send({ action: 'tool:set', payload: 'ribbon' }) },
        { label: 'テクスチャブラシ', click: () => send({ action: 'tool:set', payload: 'brush' }) },
        { label: '消しゴム', click: () => send({ action: 'tool:set', payload: 'eraser' }) },
        { label: 'ぼかし', click: () => send({ action: 'tool:set', payload: 'blur' }) },
        { label: '直線', click: () => send({ action: 'tool:set', payload: 'line' }) },
        { label: 'スポイト', click: () => send({ action: 'tool:set', payload: 'spoit' }) },
        { label: 'バケツ塗り', click: () => send({ action: 'tool:set', payload: 'bucket' }) },
        { label: '選択', click: () => send({ action: 'tool:set', payload: 'select' }) },
        { label: '移動', click: () => send({ action: 'tool:set', payload: 'move' }) },
        { label: '変形', click: () => send({ action: 'tool:set', payload: 'transform' }) },
      ],
    },
    // ---- ヘルプ ----
    {
      label: 'ヘルプ(&H)',
      submenu: [
        { label: 'PhotonMixer について', click: () => send({ action: 'help:about' }) },
        { label: 'GitHub を開く', click: () => shell.openExternal(PROJECT_URL) },
        { label: 'ドキュメントを開く', click: () => shell.openExternal(DOCS_URL) },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
