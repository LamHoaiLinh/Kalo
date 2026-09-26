const DB_NAME = 'kalo-local-storage';
const STORE = 'settings';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function cleanName(name) {
  return String(name || 'Kalo-file')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'Kalo-file';
}

async function ensurePermission(handle, write = false) {
  if (!handle) return false;
  const opts = { mode: write ? 'readwrite' : 'read' };
  if ((await handle.queryPermission?.(opts)) === 'granted') return true;
  if ((await handle.requestPermission?.(opts)) === 'granted') return true;
  return false;
}

async function uniqueFileHandle(directory, wantedName) {
  const safe = cleanName(wantedName);
  const dot = safe.lastIndexOf('.');
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  for (let i = 0; i < 999; i += 1) {
    const name = i === 0 ? safe : `${base} (${i})${ext}`;
    let exists = false;
    try {
      await directory.getFileHandle(name);
      exists = true;
    } catch {}
    if (!exists) return directory.getFileHandle(name, { create: true });
  }
  return directory.getFileHandle(`${base}-${Date.now()}${ext}`, { create: true });
}

async function moveFilesBetweenDirectories(source, destination) {
  if (!source || !destination) return 0;
  if (source.isSameEntry && await source.isSameEntry(destination)) return 0;

  const sourceOk = await ensurePermission(source, true);
  if (!sourceOk) throw new Error('Kalo cần quyền truy cập thư mục lưu trữ cũ để chuyển dữ liệu tự động.');

  let moved = 0;
  for await (const [name, handle] of source.entries()) {
    if (handle.kind !== 'file') continue;
    const file = await handle.getFile();
    const target = await uniqueFileHandle(destination, name);
    const writable = await target.createWritable();
    await writable.write(file);
    await writable.close();
    await source.removeEntry(name);
    moved += 1;
  }
  return moved;
}

export class KaloDocuments {
  constructor(userId, callbacks = {}) {
    this.userId = userId || 'default';
    this.directoryKey = `documents-directory:${this.userId}`;
    this.timelineKey = `documents-timeline:${this.userId}`;
    this.callbacks = callbacks;
    this.directoryHandle = null;
    this.mode = 'opfs';
    this.label = 'Bộ nhớ Kalo trên thiết bị';
    this.ready = false;
  }

  changed() {
    this.callbacks.onChanged?.();
  }

  async init() {
    const saved = await dbGet(this.directoryKey);
    if (saved?.kind === 'directory') {
      this.directoryHandle = saved;
      this.mode = 'folder';
      this.label = saved.name || 'Thư mục Kalo';
    } else {
      await this.ensureOpfs();
    }
    this.ready = true;
    return this.status();
  }

  async ensureOpfs() {
    if (!navigator.storage?.getDirectory) {
      this.mode = 'download';
      this.label = 'Thư mục Tải xuống của trình duyệt';
      this.directoryHandle = null;
      return null;
    }
    const root = await navigator.storage.getDirectory();
    this.directoryHandle = await root.getDirectoryHandle('Kalo My Documents', { create: true });
    this.mode = 'opfs';
    this.label = 'Bộ nhớ Kalo trên thiết bị';
    return this.directoryHandle;
  }

  async chooseDirectory() {
    if (!window.showDirectoryPicker) {
      await this.ensureOpfs();
      this.changed();
      return { ...this.status(), moved: 0 };
    }

    const oldHandle = this.directoryHandle;
    const handle = await window.showDirectoryPicker({
      id: 'kalo-documents',
      mode: 'readwrite',
      startIn: 'documents',
    });
    const ok = await ensurePermission(handle, true);
    if (!ok) throw new Error('Kalo chưa được cấp quyền ghi vào thư mục này.');

    let moved = 0;
    if (oldHandle) moved = await moveFilesBetweenDirectories(oldHandle, handle);

    await dbPut(this.directoryKey, handle);
    this.directoryHandle = handle;
    this.mode = 'folder';
    this.label = handle.name || 'Thư mục Kalo';
    this.changed();
    return { ...this.status(), moved };
  }

  async requestAccess() {
    if (!this.directoryHandle) return false;
    const ok = await ensurePermission(this.directoryHandle, true);
    if (ok) this.changed();
    return ok;
  }

  status() {
    return {
      mode: this.mode,
      label: this.label,
      canChooseFolder: 'showDirectoryPicker' in window,
      canBrowse: !!this.directoryHandle,
    };
  }

  async storageEstimate() {
    try {
      const estimate = await navigator.storage?.estimate?.();
      return {
        usage: Number(estimate?.usage || 0),
        quota: Number(estimate?.quota || 0),
      };
    } catch {
      return { usage: 0, quota: 0 };
    }
  }

  async getWritableDirectory() {
    if (!this.directoryHandle) await this.ensureOpfs();
    if (!this.directoryHandle) return null;
    if (this.mode === 'folder') {
      const ok = await ensurePermission(this.directoryHandle, true);
      if (!ok) throw new Error('Hãy cấp lại quyền truy cập thư mục My Documents trong Cài đặt.');
    }
    return this.directoryHandle;
  }

  async createReceiveTarget(meta) {
    const directory = await this.getWritableDirectory();
    if (!directory) return null;
    const handle = await uniqueFileHandle(directory, meta.name || 'Kalo-file');
    const writable = await handle.createWritable();
    return {
      mode: 'stream',
      writable,
      meta,
      received: 0,
      kaloDocument: true,
      fileName: handle.name,
    };
  }

  async saveFile(file) {
    const directory = await this.getWritableDirectory();
    if (!directory) throw new Error('Thiết bị chưa hỗ trợ My Documents cục bộ.');
    const handle = await uniqueFileHandle(directory, file.name);
    const writable = await handle.createWritable();
    await writable.write(file);
    await writable.close();
    this.changed();
    return handle.name;
  }

  async list(query = '') {
    const directory = await this.getWritableDirectory();
    if (!directory) return [];
    const q = String(query || '').trim().toLowerCase();
    const items = [];
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind !== 'file') continue;
      if (q && !name.toLowerCase().includes(q)) continue;
      try {
        const file = await handle.getFile();
        items.push({
          name,
          size: file.size,
          type: file.type || '',
          modified: file.lastModified || 0,
          handle,
        });
      } catch {}
    }
    items.sort((a, b) => b.modified - a.modified);
    return items;
  }

  async getFile(name) {
    const directory = await this.getWritableDirectory();
    if (!directory) throw new Error('Không mở được My Documents.');
    const handle = await directory.getFileHandle(name);
    return handle.getFile();
  }

  async delete(name) {
    const directory = await this.getWritableDirectory();
    if (!directory) return;
    await directory.removeEntry(name);
    this.changed();
  }

  async loadTimeline() {
    const value = await dbGet(this.timelineKey);
    return Array.isArray(value) ? value : [];
  }

  async saveTimeline(items) {
    const safe = Array.isArray(items) ? items.slice(-10000) : [];
    await dbPut(this.timelineKey, safe);
    return safe;
  }

  async appendTimeline(item) {
    const items = await this.loadTimeline();
    items.push(item);
    await this.saveTimeline(items);
    return item;
  }

  async open(name) {
    const file = await this.getFile(name);
    const url = URL.createObjectURL(file);
    const w = window.open(url, '_blank', 'noopener');
    if (!w) {
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async download(name) {
    const file = await this.getFile(name);
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
