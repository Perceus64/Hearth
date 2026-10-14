// Minimal IndexedDB wrapper. Stores: convs, docs, chunks (chunks indexed by docId).
const DB_NAME = 'hearth';
const VERSION = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('convs')) db.createObjectStore('convs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) {
        const s = db.createObjectStore('chunks', { keyPath: 'id' });
        s.createIndex('docId', 'docId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const db = {
  async all(name) { return wrap((await store(name)).getAll()); },
  async get(name, key) { return wrap((await store(name)).get(key)); },
  async put(name, value) { return wrap((await store(name, 'readwrite')).put(value)); },
  async del(name, key) { return wrap((await store(name, 'readwrite')).delete(key)); },
  async putMany(name, values) {
    const d = await open();
    const tx = d.transaction(name, 'readwrite');
    const s = tx.objectStore(name);
    for (const v of values) s.put(v);
    return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  },
  async byIndex(name, index, key) { return wrap((await store(name)).index(index).getAll(key)); },
  async delByIndex(name, index, key) {
    const d = await open();
    const tx = d.transaction(name, 'readwrite');
    const idx = tx.objectStore(name).index(index);
    const keys = await wrap(idx.getAllKeys(key));
    for (const k of keys) tx.objectStore(name).delete(k);
    return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  },
  async clear(name) { return wrap((await store(name, 'readwrite')).clear()); },
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
