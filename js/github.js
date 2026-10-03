// GitHub as a database. Reads album.json via the REST API, and writes every
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
    return 'Your GitHub key is not allowed to change this album. Give it "Contents: Read and write" access to this repository.';
  if (status === 403 && /rate limit/i.test(msg)) return 'GitHub rate limit reached. Please wait a little and try again.';
  if (status === 404) return 'Album repository not found, or your key cannot see it.';
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

export class GitHubStore {
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

  async request(method, path, { body, accept, text } = {}) {
    for (let attempt = 0; ; attempt++) {
      const headers = { Accept: accept || 'application/vnd.github+json' };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      if (body) headers['Content-Type'] = 'application/json';
      const res = await fetch(API + path, {
        method, headers, cache: 'no-store',
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return text ? res.text() : res.status === 204 ? null : res.json();

      const msg = await res.text();
      const slowDown = res.status === 429 || (res.status === 403 && /secondary rate limit/i.test(msg));
      if (slowDown && attempt < 3) {
        const wait = (Number(res.headers.get('retry-after')) || 60) * 1000;
        this.onWait?.(wait);
        await sleep(wait);
        continue;
      }
      throw new GitHubError(res.status, explain(res.status, msg));
    }
  }

  async getAlbum(ref = this.branch) {
    try {
      const json = await this.request('GET', `${this.base}/contents/${CONFIG.albumPath}?ref=${encodeURIComponent(ref)}`,
        { accept: 'application/vnd.github.raw+json', text: true });
      return normalize(JSON.parse(json));
    } catch (e) {
      if (e.status === 404) return emptyAlbum();
      throw e;
    }
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

  // Frees the space used by deleted photos. Git keeps every old version, so
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
    throw new GitHubError(409, 'The album kept changing while freeing up space. Please try again in a moment.');
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

  // op: (album, ctx) => void, applied to the latest album.json.
  // files: [{ path, blob }] new files to add in the same commit.
  async commitChange({ op, files = [], message, onProgress, onConflict }) {
    // Big batches are paced to stay under GitHub's ~80 writes/minute limit.
    const pace = files.length > 60 ? 800 : 0;
    let done = 0;
    onProgress?.(0, files.length);
    const uploaded = await pool(files, pace ? 1 : 3, async f => {
      const sha = await this.createBlob(f.blob);
      onProgress?.(++done, files.length);
      if (pace) await sleep(pace);
      return { path: f.path, sha };
    });

    for (let attempt = 0; attempt < 6; attempt++) {
      const ref = await this.request('GET', `${this.base}/git/ref/heads/${this.branch}`);
      const head = ref.object.sha;
      const commit = await this.request('GET', `${this.base}/git/commits/${head}`);
      const album = await this.getAlbum(head);
      const ctx = { remove: [] };
      op(album, ctx);
      album.updatedAt = new Date().toISOString();

      const { sha: albumSha } = await this.request('POST', `${this.base}/git/blobs`,
        { body: { content: JSON.stringify(album, null, 1) + '\n', encoding: 'utf-8' } });
      const entries = [
        ...uploaded.map(u => ({ path: u.path, mode: '100644', type: 'blob', sha: u.sha })),
        { path: CONFIG.albumPath, mode: '100644', type: 'blob', sha: albumSha },
      ];
      let remove = [...new Set(ctx.remove)];
      const makeTree = () => this.request('POST', `${this.base}/git/trees`, {
        body: {
          base_tree: commit.tree.sha,
          tree: [...entries, ...remove.map(path => ({ path, mode: '100644', type: 'blob', sha: null }))],
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
        return album;
      } catch (e) {
        if (e.status !== 422 && e.status !== 409) throw e;
        onConflict?.(attempt + 1);
        await sleep(400 * 2 ** attempt + Math.random() * 300);
      }
    }
    throw new GitHubError(409, 'Too many people were saving at the same time. Please try again.');
  }
}
