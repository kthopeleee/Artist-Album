// GitHub as a database. Reads JSON files via the REST API, and writes every
// change as a single commit using the Git Data API (blobs -> tree -> commit ->
// move the branch). If someone else committed in between, the branch update is
// rejected and the change is re-applied on top of their version.
import { CONFIG } from './config.js';
import { emptyAlbum, normalize } from './album.js';

const API = 'https://api.github.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function explain(status, body) {
  let msg = body;
  try { msg = JSON.parse(body).message || body; } catch {}
  if (status === 401) return 'Your GitHub key is not valid (it may have expired). Update it under "Edit access".';
  if (status === 403 && /not accessible/i.test(msg))
    return 'Your GitHub key is not allowed to change this. Give it "Contents: Read and write" access to the repository.';
  if (status === 403 && /rate limit/i.test(msg))
    return 'GitHub limits how much can be uploaded per hour. Please wait a while, then use "Retry".';
  if (status === 404) return 'Repository not found, or your key cannot see it.';
  return `GitHub said: ${msg} (${status})`;
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// GitHub allows roughly 80 "content-creating" requests a minute. Every write
// from this tab goes through this sliding window, so big uploads pace
// themselves instead of being cut off.
const recentWrites = [];
async function throttleWrite() {
  for (;;) {
    const now = Date.now();
    while (recentWrites.length && now - recentWrites[0] > 60_000) recentWrites.shift();
    if (recentWrites.length < GitHubStore.writesPerMinute) { recentWrites.push(now); return; }
    await sleep(60_000 - (now - recentWrites[0]) + 50);
  }
}

const encodePath = path => path.split('/').map(encodeURIComponent).join('/');

export class GitHubStore {
  static writesPerMinute = 70;

  constructor({ owner, repo, branch }, token = '') {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.token = token;
    this.onWait = null; // called with ms when GitHub asks us to slow down
  }

  get base() { return `/repos/${this.owner}/${this.repo}`; }

  rawUrl(path) {
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${path}`;
  }

  // Retries by itself on network hiccups and GitHub server errors, and waits
  // when GitHub says "slow down".
  async request(method, path, { body, accept, text, binary } = {}) {
    let hiccups = 0, slowDowns = 0;
    for (;;) {
      if (method !== 'GET') await throttleWrite();
      const headers = { Accept: accept || 'application/vnd.github+json' };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      if (body) headers['Content-Type'] = 'application/json';
      let res;
      try {
        res = await fetch(API + path, { method, headers, cache: 'no-store', body: body ? JSON.stringify(body) : undefined });
      } catch {
        if (++hiccups <= 4) { await sleep(1000 * 2 ** hiccups); continue; }
        throw new GitHubError(0, 'Could not reach GitHub. Check your internet connection and try again.');
      }
      if (res.ok) return binary ? res.arrayBuffer() : text ? res.text() : res.status === 204 ? null : res.json();

      const msg = await res.text();
      if (res.status >= 500 && ++hiccups <= 4) { await sleep(1000 * 2 ** hiccups); continue; }
      const limited = res.status === 429 || (res.status === 403 && /rate limit/i.test(msg));
      if (limited && ++slowDowns <= 6) {
        let wait = Number(res.headers.get('retry-after')) * 1000;
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        if (!wait && res.headers.get('x-ratelimit-remaining') === '0' && reset) wait = reset * 1000 - Date.now() + 1000;
        if (!wait) wait = 60_000 * slowDowns;
        if (wait <= 20 * 60_000) {
          this.onWait?.(wait);
          await sleep(wait);
          continue;
        }
      }
      throw new GitHubError(res.status, explain(res.status, msg));
    }
  }

  // Text of a file at a branch/commit, or null if it doesn't exist.
  async getText(path, ref = this.branch) {
    try {
      return await this.request('GET', `${this.base}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
        { accept: 'application/vnd.github.raw+json', text: true });
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  // Raw bytes of a file (up to 100 MB), for private repos too.
  getBytes(path, ref = this.branch) {
    return this.request('GET', `${this.base}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      { accept: 'application/vnd.github.raw+json', binary: true });
  }

  async getAlbum(ref = this.branch) {
    const json = await this.getText(CONFIG.albumPath, ref);
    return json === null ? emptyAlbum() : normalize(JSON.parse(json));
  }

  // Viewers without a key share GitHub's 60 requests/hour limit, so fall back
  // to the copy GitHub Pages serves (may be a minute or two behind).
  async getAlbumAnyway() {
    try {
      return await this.getAlbum();
    } catch (e) {
      if (this.token && e.status === 401) throw e;
      const res = await fetch(`${CONFIG.albumPath}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw e;
      return normalize(await res.json());
    }
  }

  async verify() {
    const repo = await this.request('GET', this.base);
    let login = null;
    try { login = (await this.request('GET', '/user')).login; } catch {}
    return { canPush: !!repo.permissions?.push, login };
  }

  // Repository size including all history, as GitHub reports it (updated by
  // GitHub periodically, so it lags a little behind).
  async repoSizeBytes() {
    const repo = await this.request('GET', this.base);
    return (repo.size || 0) * 1024;
  }

  // Frees the space used by deleted files. Git keeps every old version, so
  // deleting a file alone never shrinks a repo. This replaces the branch with
  // a single snapshot commit of what's there now (no history), which leaves the
  // old versions unreferenced so GitHub's cleanup can remove them.
  async compactHistory(message) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const head = (await this.request('GET', `${this.base}/git/ref/heads/${this.branch}`)).object.sha;
      const { tree } = await this.request('GET', `${this.base}/git/commits/${head}`);
      const snapshot = await this.request('POST', `${this.base}/git/commits`, { body: { message, tree: tree.sha, parents: [] } });
      // Someone saved in the meantime: start over from their version so it isn't lost.
      const now = (await this.request('GET', `${this.base}/git/ref/heads/${this.branch}`)).object.sha;
      if (now !== head) { await sleep(500 * (attempt + 1)); continue; }
      await this.request('PATCH', `${this.base}/git/refs/heads/${this.branch}`, { body: { sha: snapshot.sha, force: true } });
      return snapshot.sha;
    }
    throw new GitHubError(409, 'Things kept changing while freeing up space. Please try again in a moment.');
  }

  async createBlob(blob) {
    const content = await toBase64(blob);
    const { sha } = await this.request('POST', `${this.base}/git/blobs`, { body: { content, encoding: 'base64' } });
    return sha;
  }

  async existingPaths(treeSha, paths) {
    const { tree } = await this.request('GET', `${this.base}/git/trees/${treeSha}?recursive=1`);
    const have = new Set(tree.map(t => t.path));
    return paths.filter(p => have.has(p));
  }

  // The general save: apply `op` to the latest copy of a JSON file and commit
  // it together with new files, as one commit.
  //   path:      the JSON file (e.g. album/album.json)
  //   parse:     async (text | null) => object
  //   serialize: async (object) => text
  //   op:        (object, ctx) => void | replacement object; may push paths to delete onto ctx.remove
  //   files:     [{ path, blob } | { path, getBlob: async () => Blob }]
  async commitJson({ path, parse, serialize, op, files = [], message, onProgress, onConflict }) {
    let done = 0;
    onProgress?.(0, files.length);
    const uploaded = await pool(files, 3, async f => {
      const sha = await this.createBlob(f.blob || (await f.getBlob()));
      onProgress?.(++done, files.length);
      return { path: f.path, sha };
    });

    for (let attempt = 0; attempt < 6; attempt++) {
      const ref = await this.request('GET', `${this.base}/git/ref/heads/${this.branch}`);
      const head = ref.object.sha;
      const commit = await this.request('GET', `${this.base}/git/commits/${head}`);
      const current = await parse(await this.getText(path, head));
      const ctx = { remove: [] };
      const doc = op(current, ctx) ?? current;

      const { sha: docSha } = await this.request('POST', `${this.base}/git/blobs`,
        { body: { content: await serialize(doc), encoding: 'utf-8' } });
      const entries = [
        ...uploaded.map(u => ({ path: u.path, mode: '100644', type: 'blob', sha: u.sha })),
        { path, mode: '100644', type: 'blob', sha: docSha },
      ];
      let remove = [...new Set(ctx.remove)];
      const makeTree = () => this.request('POST', `${this.base}/git/trees`, {
        body: {
          base_tree: commit.tree.sha,
          tree: [...entries, ...remove.map(p => ({ path: p, mode: '100644', type: 'blob', sha: null }))],
        },
      });
      let tree;
      try {
        tree = await makeTree();
      } catch (e) {
        // Deleting a file that is already gone fails; drop those and retry.
        if (e.status !== 422 || !remove.length) throw e;
        remove = await this.existingPaths(commit.tree.sha, remove);
        tree = await makeTree();
      }
      const created = await this.request('POST', `${this.base}/git/commits`,
        { body: { message, tree: tree.sha, parents: [head] } });

      try {
        await this.request('PATCH', `${this.base}/git/refs/heads/${this.branch}`,
          { body: { sha: created.sha, force: false } });
        return doc;
      } catch (e) {
        if (e.status !== 422 && e.status !== 409) throw e;
        onConflict?.(attempt + 1);
        await sleep(400 * 2 ** attempt + Math.random() * 300);
      }
    }
    throw new GitHubError(409, 'Too many people were saving at the same time. Please try again.');
  }

  // Album changes: op is applied to the latest album.json.
  commitChange({ op, ...rest }) {
    return this.commitJson({
      ...rest,
      path: CONFIG.albumPath,
      parse: async text => (text === null ? emptyAlbum() : normalize(JSON.parse(text))),
      serialize: async album => JSON.stringify(album, null, 1) + '\n',
      op: (album, ctx) => {
        op(album, ctx);
        album.updatedAt = new Date().toISOString();
      },
    });
  }
}
