import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { buildAppMenu } from './menu.js';

// ESM環境で__dirnameを再現
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;

/**
 * Electronアプリケーションのライフサイクル管理
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    webPreferences: {
      sandbox: false, // 開発用: ESM preloadを有効にする
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    backgroundColor: '#1a1a1a',
    show: false, // ロード完了まで非表示
  });

  // 開発者ツールを開く（デバッグ時のみ）
  if (process.env.PM_DEV) mainWindow.webContents.openDevTools();

  // アプリケーションメニューを構築（IPC でレンダラーへアクション送信）
  buildAppMenu(mainWindow);

  // index.html をロード
  mainWindow.loadFile('index.html');

  // ウィンドウが準備できたら表示
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // ウィンドウが閉じられたときのクリーンアップ
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// アプリケーションの準備ができたらウィンドウを作成
app.whenReady().then(() => {
  createWindow();

  // macOS でドックアイコンをクリックしたときの挙動
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// すべてのウィンドウが閉じられたらアプリを終了（macOS以外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
