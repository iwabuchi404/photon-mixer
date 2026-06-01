/**
 * Preloadスクリプト
 * Phase 1では最小限の実装
 * CommonJSで記述
 */
const { contextBridge } = require('electron');

// レンダラーへ安全に公開するAPI
contextBridge.exposeInMainWorld('electronAPI', {
  // 将来的に必要になるIPC用のプレースホルダー
  platform: process.platform,
});
