/**
 * Preloadスクリプト
 * レンダラーへ安全に公開するAPI（IPCブリッジ）
 * CommonJSで記述
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  /**
   * アプリメニューのアクション通知を受信する。
   * @param {(msg: { action: string; payload?: string }) => void} listener
   * @returns {() => void} リスナー解除関数
   */
  onMenuAction(listener) {
    const handler = (_event, msg) => listener(msg);
    ipcRenderer.on('menu:action', handler);
    return () => ipcRenderer.removeListener('menu:action', handler);
  },
});
