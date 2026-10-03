// Smart suggestions: runs the on-device AI over each photo's thumbnail once,
// keeps the results in this browser (IndexedDB), and hands them to suggest.js.
// Nothing leaves the device; it's off until the user turns it on per browser.

const PREF = 'artist-album.ai';
const DB_NAME = 'artist-album-ai';
const STORE = 'embeddings';
const MODEL_KEY = 'mobileclip_s0'; // change if the model changes, so old results are ignored

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function loadCache() {
  const map = new Map();
  try {
    const store = (await db()).transaction(STORE).objectStore(STORE);
    await new Promise(resolve => {
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve();
        const key = String(cur.key);
        if (key.startsWith(`${MODEL_KEY}:`)) map.set(key.slice(MODEL_KEY.length + 1), new Float32Array(cur.value));
        cur.continue();
      };
      req.onerror = () => resolve();
    });
  } catch {}
  return map;
}

async function saveCache(id, vec) {
  try {
    (await db()).transaction(STORE, 'readwrite').objectStore(STORE).put(vec.buffer.slice(0), `${MODEL_KEY}:${id}`);
  } catch {}
}

export class SmartAI {
  // getThumb(img) -> Promise<Blob>; onChange() is called (throttled) whenever anything changes.
  constructor({ getThumb, onChange }) {
    this.getThumb = getThumb;
    this.onChange = onChange;
    this.state = 'off'; // off | loading | ready | analyzing | error
    this.error = '';
    this.emb = new Map();
    this.failed = new Set();
    this.queue = [];
    this.files = new Map();
    this.done = 0;
    this.total = 0;
    this.version = 0; // bumps when embeddings change, for memoizing suggestions
    this.lib = null;
    this.calls = new Map();
    this.nextCall = 1;
  }

  get enabled() {
    try { return localStorage.getItem(PREF) === 'on'; } catch { return false; }
  }

  get downloadProgress() {
    let loaded = 0, total = 0;
    for (const f of this.files.values()) { loaded += f.loaded || 0; total += f.total || 0; }
    return total ? loaded / total : 0;
  }

  get active() { return this.state === 'ready' || this.state === 'analyzing'; }

  enable(album) {
    try { localStorage.setItem(PREF, 'on'); } catch {}
    return this.start(album);
  }

  disable() {
    try { localStorage.removeItem(PREF); } catch {}
    this.worker?.terminate();
    this.worker = null;
    this.starting = null;
    this.queue = [];
    this.state = 'off';
    this.notify(true);
  }

  start(album) {
    this.album = album;
    this.starting ??= (async () => {
      this.state = 'loading';
      this.error = '';
      this.notify(true);
      this.lib = await import('./suggest.js');
      this.emb = await loadCache();
      this.worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => this.onMessage(data);
      this.worker.onerror = e => this.fail(e.message || 'The AI worker crashed.');
      await this.call({ type: 'init' });
      this.state = 'ready';
      this.version++;
      this.notify(true);
      this.sync(this.album);
    })().catch(e => this.fail(e.message));
    return this.starting;
  }

  fail(message) {
    this.worker?.terminate();
    this.worker = null;
    this.starting = null;
    this.state = 'error';
    this.error = /fetch|network|load/i.test(message) ? 'Could not download the AI model. Check your connection and try again.' : message;
    this.notify(true);
  }

  onMessage(data) {
    if (data.type === 'progress') {
      this.files.set(data.file, data);
      this.notify();
      return;
    }
    const call = this.calls.get(data.id);
    if (!call) return;
    this.calls.delete(data.id);
    data.error ? call.reject(new Error(data.error)) : call.resolve(data);
  }

  call(msg, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = this.nextCall++;
      this.calls.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  // Queue every photo we haven't analyzed yet (Unsorted first, since that's where suggestions show).
  sync(album) {
    this.album = album;
    if (!this.active) return;
    const queued = new Set(this.queue.map(q => q.id));
    const missing = album.images
      .filter(i => !i.trashedAt && !this.emb.has(i.id) && !this.failed.has(i.id) && !queued.has(i.id))
      .sort((a, b) => (a.folder ? 1 : 0) - (b.folder ? 1 : 0));
    for (const img of missing) this.queue.push({ id: img.id, img });
    this.run();
  }

  // A just-uploaded photo: analyze it right away using the thumbnail we already have.
  add(id, blob) {
    if (!this.active || this.emb.has(id)) return;
    this.queue.unshift({ id, blob });
    this.run();
  }

  async run() {
    if (this.running || !this.queue.length) return;
    this.running = true;
    this.state = 'analyzing';
    this.done = 0;
    this.total = this.queue.length;
    this.notify(true);
    while (this.queue.length && this.worker) {
      this.total = Math.max(this.total, this.done + this.queue.length);
      const item = this.queue.shift();
      if (!this.emb.has(item.id)) {
        try {
          const blob = item.blob || (await this.getThumb(item.img));
          const { vec } = await this.call({ type: 'embed', blob });
          this.emb.set(item.id, vec);
          this.version++;
          saveCache(item.id, vec);
        } catch {
          this.failed.add(item.id);
        }
      }
      this.done++;
      this.notify();
    }
    this.running = false;
    if (this.worker) this.state = 'ready';
    this.notify(true);
  }

  notify(now = false) {
    clearTimeout(this.timer);
    if (now) this.onChange();
    else this.timer = setTimeout(() => this.onChange(), 250);
  }

  tagSuggestions(img, album) {
    return this.active ? this.lib.suggestTags(img, album, this.emb) : [];
  }

  folderSuggestions(album, dismissed) {
    if (!this.active) return [];
    const key = `${this.version}|${dismissed.size}`;
    if (this.memo?.album === album && this.memo.key === key) return this.memo.groups;
    const groups = this.lib.folderSuggestions(album, this.emb, dismissed);
    this.memo = { album, key, groups };
    return groups;
  }
}
