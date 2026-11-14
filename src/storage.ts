// Хранилище проектов в IndexedDB (работает и в браузере планшета, и в будущем APK).
// Метаданные (имя, дата, миниатюра) и сами данные лежат в разных хранилищах,
// чтобы список проектов открывался быстро, не читая тяжёлую геометрию.

export interface ProjectMeta {
  id: string;
  name: string;
  updated: number;
  /** PNG data-URL миниатюры */
  thumb?: string;
}

const DB_NAME = "tabcad";
const META = "meta";
const DATA = "data";

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(META, { keyPath: "id" });
      req.result.createObjectStore(DATA);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

function request<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const db = await open();
  const all = await request(db.transaction(META).objectStore(META).getAll() as IDBRequest<ProjectMeta[]>);
  return all.sort((a, b) => b.updated - a.updated);
}

export async function getMeta(id: string): Promise<ProjectMeta | undefined> {
  const db = await open();
  return request(db.transaction(META).objectStore(META).get(id) as IDBRequest<ProjectMeta | undefined>);
}

export async function loadData(id: string): Promise<string | undefined> {
  const db = await open();
  return request(db.transaction(DATA).objectStore(DATA).get(id) as IDBRequest<string | undefined>);
}

/** Сохранить метаданные и (если передано) данные одной транзакцией */
export async function saveProject(meta: ProjectMeta, data?: string) {
  const db = await open();
  const tx = db.transaction([META, DATA], "readwrite");
  tx.objectStore(META).put(meta);
  if (data !== undefined) tx.objectStore(DATA).put(data, meta.id);
  await done(tx);
}

export async function deleteProject(id: string) {
  const db = await open();
  const tx = db.transaction([META, DATA], "readwrite");
  tx.objectStore(META).delete(id);
  tx.objectStore(DATA).delete(id);
  await done(tx);
}

/** Попросить браузер не вычищать данные при нехватке места (Android это поддерживает) */
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}

export const newProjectId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
