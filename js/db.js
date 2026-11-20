// 极简 IndexedDB 封装：kv / words / posts 三个仓库
const DB = 'xjp', VER = 1;
let dbp;
function open() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('kv');
      d.createObjectStore('words', { keyPath: 'k' });
      d.createObjectStore('posts', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? req.result : undefined);
    t.onerror = () => rej(t.error);
  });
}
export const db = {
  get: (s, k) => tx(s, 'readonly', st => st.get(k)),
  put: (s, v, k) => tx(s, 'readwrite', st => (k === undefined ? st.put(v) : st.put(v, k))),
  all: s => tx(s, 'readonly', st => st.getAll()),
  del: (s, k) => tx(s, 'readwrite', st => st.delete(k)),
  putMany: (s, arr) => tx(s, 'readwrite', st => { arr.forEach(v => st.put(v)); }),
  clear: s => tx(s, 'readwrite', st => st.clear()),
};
