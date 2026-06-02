/**
 * 自動保存（IndexedDB）
 * Electron の contextIsolation 環境でも IPC なしで動く。
 * .pmx の Blob を1スロットに退避し、起動時に復元提案する。
 */

const DB_NAME = 'photonmixer-autosave';
const STORE = 'slots';
const KEY = 'latest';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveAutosave(blob: Blob): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ blob, savedAt: Date.now() }, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadAutosave(): Promise<{ blob: Blob; savedAt: number } | null> {
  const db = await openDb();
  const result = await new Promise<{ blob: Blob; savedAt: number } | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

export async function clearAutosave(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
  });
  db.close();
}
