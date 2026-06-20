// Tiny IndexedDB store for the FileSystemFileHandle, which cannot be sent
// through extension messages. Written by the UI (after the save picker) and
// read by the offscreen recording engine. Shared as an ES module.

const DB_NAME = 'tab-recorder';
const STORE   = 'handles';
const KEY     = 'fileHandle';

// Separate slot for the optional M4A destination, chosen at Stop & Save time.
export const M4A_KEY = 'm4aFileHandle';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess       = () => resolve(req.result);
    req.onerror         = () => reject(req.error);
  });
}

export async function storeHandle(handle, key = KEY) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export async function getHandle(key = KEY) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const get = tx.objectStore(STORE).get(key);
    get.onsuccess = () => resolve(get.result || null);
    get.onerror   = () => reject(get.error);
  });
}
