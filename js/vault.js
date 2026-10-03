// "Drawings": a private place for your own drawing files (Procreate, PSD, Clip
// Studio, PNG, anything). They live in a separate PRIVATE repository, never on
// the photo site, and can be locked with a password (encrypted in the browser)
// plus Touch ID on each device.
//
// Repo layout:  vault.json (the file list, encrypted when locked)
//               files/<id>/part-<n>   the file, in 16 MB parts (GitHub allows 100 MB per file)
//               files/<id>/preview    a small preview picture, when there is one
import { CONFIG } from './config.js';
import { uid } from './album.js';
import { GitHubStore } from './github.js';
import { makeThumb, formatBytes } from './images.js';
import { readZipEntry } from './zip.js';
import * as vc from './vault-crypto.js';

const PART = 16 * 1024 * 1024;
const INDEX = 'vault.json';
const AUTO_LOCK_MS = 15 * 60_000; // lock again after 15 minutes away from the tab
const enc = new TextEncoder();
const dec = new TextDecoder();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<svg class="ic"><use href="#i-${name}"/></svg>`;
const ext = name => (/\.([a-z0-9]{1,12})$/i.exec(name || '')?.[1] || 'file').toLowerCase();

const parseWith = key => async text => {
  if (text === null) return null;
  const stored = JSON.parse(text);
  if (!stored.lock) return { version: 1, keyId: stored.keyId || null, lock: null, items: stored.items || [] };
  if (!key) throw new Error('The Drawings vault is locked.');
  const items = JSON.parse(dec.decode(await vc.open(key, vc.fromB64(stored.data), 'index')));
  return { version: 1, keyId: stored.keyId, lock: stored.lock, items };
};

const serializeWith = key => async doc => {
  if (!doc.lock) return JSON.stringify({ version: 1, keyId: doc.keyId, lock: null, items: doc.items }, null, 1) + '\n';
  const data = vc.toB64(await vc.seal(key, enc.encode(JSON.stringify(doc.items)), 'index'));
  return JSON.stringify({ version: 1, keyId: doc.keyId, lock: doc.lock, data }, null, 1) + '\n';
};

async function makePreview(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.procreate')) {
    const png = await readZipEntry(file, 'QuickLook/Thumbnail.png');
    return png ? makeThumb(png) : null;
  }
  if (file.type.startsWith('image/') && file.type !== 'image/svg+xml' && file.size < 80 * 1024 * 1024) return makeThumb(file);
  return null;
}

export class Vault {
  // ui: { owner, token(), myName(), toast, ask, uploadPanel, saveBlob, onChange() }
  constructor(ui) {
    this.ui = ui;
    this.status = 'idle'; // idle | loading | no-access | error | setup | locked | ready
    this.doc = null;      // { keyId, lock, items } once readable
    this.stored = null;   // vault.json as stored (to unlock)
    this.key = null;      // vault key while unlocked
    this.previews = new Map();
    this.chain = Promise.resolve();
    this.busy = '';
    this.settingsOpen = false;
    this.touchId = false;
    vc.touchIdAvailable().then(ok => { this.touchId = ok; this.render(); });
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (this.key && hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_MS) this.lockNow();
    });
  }

  get repoName() { return `${this.ui.owner}/${CONFIG.vaultRepo}`; }
  store() { return new GitHubStore({ owner: this.ui.owner, repo: CONFIG.vaultRepo, branch: 'main' }, this.ui.token()); }

  // One vault save at a time.
  run(fn) {
    const result = this.chain.then(fn);
    this.chain = result.catch(() => {});
    return result;
  }

  commit(message, op, { files = [], onProgress, parseKey = this.key, serializeKey = this.key } = {}) {
    return this.run(async () => {
      this.doc = await this.store().commitJson({
        path: INDEX, parse: parseWith(parseKey), serialize: serializeWith(serializeKey), op, files, message, onProgress,
      });
      return this.doc;
    });
  }

  // ---- loading, setup, locking ------------------------------------------------

  async open() {
    if (this.status === 'idle' || this.status === 'error' || this.status === 'no-access') await this.load();
    else this.render();
  }

  async load() {
    if (!this.ui.token()) { this.status = 'no-access'; return this.render(); }
    this.status = 'loading';
    this.render();
    try {
      const store = this.store();
      await store.request('GET', store.base); // 404 = this key can't see the private repo
      const text = await store.getText(INDEX);
      if (text === null) {
        this.status = 'setup';
      } else {
        this.stored = JSON.parse(text);
        if (this.stored.lock && !this.key) {
          this.status = 'locked';
        } else {
          this.doc = await parseWith(this.key)(text);
          this.status = 'ready';
          this.loadPreviews();
        }
      }
    } catch (e) {
      this.status = e.status === 404 || e.status === 403 ? 'no-access' : 'error';
      this.error = e.message;
    }
    this.render();
  }

  async create(password) {
    const key = password ? await vc.newVaultKey() : null;
    const doc = { version: 1, keyId: uid('k'), lock: password ? await vc.makeLock(password, key) : null, items: [] };
    this.key = key;
    try {
      await this.commit('Set up the drawings vault', existing => existing || doc, { parseKey: key, serializeKey: key });
      this.stored = { lock: this.doc.lock };
      this.status = 'ready';
      this.ui.toast(password ? 'Drawings is ready and locked with your password.' : 'Drawings is ready.');
    } catch (e) {
      this.key = null;
      this.ui.toast(e.message, 'error');
      await this.load();
    }
    this.render();
  }

  async unlock(password) {
    const key = await vc.unlockWithPassword(this.stored.lock, password);
    await this.useKey(key);
  }

  async unlockTouchId() {
    const key = await vc.unlockWithTouchId();
    try {
      await this.useKey(key);
    } catch {
      await vc.disableTouchId();
      throw new Error('Touch ID is out of date for this vault. Unlock with your password, then turn Touch ID on again.');
    }
  }

  async useKey(key) {
    const text = await this.store().getText(INDEX);
    this.stored = JSON.parse(text);
    this.doc = await parseWith(key)(text); // throws if the key doesn't fit
    this.key = key;
    this.status = 'ready';
    this.render();
    this.loadPreviews();
  }

  lockNow() {
    this.key = null;
    this.doc = null;
    for (const url of this.previews.values()) URL.revokeObjectURL(url);
    this.previews.clear();
    this.status = this.stored?.lock ? 'locked' : 'idle';
    this.render();
  }

  // ---- files ---------------------------------------------------------------------

  sealed(blob, aad, key = this.key) {
    return async () => (key ? new Blob([await vc.seal(key, await blob.arrayBuffer(), aad)]) : blob);
  }

  async readPart(path, aad, key = this.key) {
    const buf = await this.store().getBytes(path);
    return key ? vc.open(key, buf, aad) : buf;
  }

  async upload(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    if (this.status !== 'ready') {
      this.ui.toast(this.status === 'locked' ? 'Unlock Drawings first.' : 'Open Drawings first.', 'error');
      return;
    }
    const panel = this.ui.uploadPanel(files.map(f => f.name || 'Untitled'), 'file');
    for (const [i, file] of files.entries()) await this.uploadOne(file, i, panel);
    panel.finish();
  }

  async uploadOne(file, row, panel) {
    const id = uid('d');
    const key = this.doc?.lock ? this.key : null;
    panel.update(row, 'Preparing…');
    let preview = null;
    try { preview = await makePreview(file); } catch {}
    const parts = Math.max(1, Math.ceil(file.size / PART));
    const files = Array.from({ length: parts }, (_, n) => ({
      path: `files/${id}/part-${n}`,
      getBlob: this.sealed(file.slice(n * PART, (n + 1) * PART), `${id}:${n}`, key),
    }));
    if (preview) files.push({ path: `files/${id}/preview`, getBlob: this.sealed(preview, `${id}:preview`, key) });
    const item = {
      id, name: file.name || 'Untitled', size: file.size, type: file.type || '',
      addedAt: new Date().toISOString(), addedBy: this.ui.myName(), parts, preview: !!preview,
    };
    panel.update(row, `Uploading ${formatBytes(file.size)}…`);
    try {
      await this.commit(key ? 'Add a drawing' : `Add ${item.name}`, doc => {
        if (!doc.items.some(x => x.id === id)) doc.items.unshift(item);
      }, { files, onProgress: (done, total) => panel.partial([row], done / Math.max(1, total)) });
      if (preview) this.previews.set(id, URL.createObjectURL(preview));
      panel.done(row, `${formatBytes(file.size)} · saved`);
    } catch (e) {
      panel.fail(row, e.message, () => this.uploadOne(file, row, panel));
    }
    this.render();
  }

  async download(item) {
    const note = this.ui.toast(`Downloading ${item.name}…`, '', null, { sticky: true });
    try {
      const chunks = [];
      for (let n = 0; n < item.parts; n++) {
        chunks.push(await this.readPart(`files/${item.id}/part-${n}`, `${item.id}:${n}`, this.doc.lock ? this.key : null));
        if (item.parts > 1) note.textContent = `Downloading ${item.name}… ${Math.round(((n + 1) / item.parts) * 100)}%`;
      }
      this.ui.saveBlob(new Blob(chunks, { type: item.type || 'application/octet-stream' }), item.name);
    } catch (e) {
      this.ui.toast(`Download failed: ${e.message}`, 'error');
    } finally {
      note.remove();
    }
  }

  async loadPreviews() {
    const key = this.doc?.lock ? this.key : null;
    for (const item of this.doc?.items || []) {
      if (!item.preview || this.previews.has(item.id)) continue;
      try {
        const buf = await this.readPart(`files/${item.id}/preview`, `${item.id}:preview`, key);
        if (!this.doc) return; // locked meanwhile
        this.previews.set(item.id, URL.createObjectURL(new Blob([buf])));
        this.render();
      } catch {}
    }
  }

  async rename(item) {
    const name = await this.ui.ask({ title: 'Rename file', value: item.name, ok: 'Rename' });
    if (!name || name === item.name) return;
    await this.commit(this.doc.lock ? 'Rename a drawing' : `Rename ${item.name} to ${name}`, doc => {
      const it = doc.items.find(x => x.id === item.id);
      if (it) it.name = name;
    }).catch(e => this.ui.toast(e.message, 'error'));
    this.render();
  }

  // Deleting also clears the private repo's history, so the space is really freed.
  async remove(item) {
    const ok = await this.ui.ask({
      title: `Delete “${item.name}” forever?`,
      text: `${formatBytes(item.size)} will be deleted from your private Drawings repo and the space freed. This can’t be undone.`,
      input: false, ok: 'Delete forever', danger: true,
    });
    if (!ok) return;
    this.busy = 'Deleting…';
    this.render();
    try {
      await this.commit(this.doc.lock ? 'Delete a drawing' : `Delete ${item.name}`, (doc, ctx) => {
        const it = doc.items.find(x => x.id === item.id);
        if (!it) return;
        for (let n = 0; n < it.parts; n++) ctx.remove.push(`files/${it.id}/part-${n}`);
        if (it.preview) ctx.remove.push(`files/${it.id}/preview`);
        doc.items = doc.items.filter(x => x.id !== item.id);
      });
      await this.run(() => this.store().compactHistory('Drawings snapshot: cleared old history to free up space'));
      this.ui.toast(`Deleted ${item.name}.`);
    } catch (e) {
      this.ui.toast(e.message, 'error');
    }
    this.busy = '';
    this.render();
  }

  // Turn the password lock on (with a new password) or off (password = null).
  // Every file is re-written, then old copies are cleared from history.
  async setLock(password) {
    const oldKey = this.doc.lock ? this.key : null;
    const newKey = password ? await vc.newVaultKey() : null;
    const lock = password ? await vc.makeLock(password, newKey) : null;
    const keyId = uid('k');
    const files = [];
    for (const item of this.doc.items) {
      const names = [...Array.from({ length: item.parts }, (_, n) => [`part-${n}`, `${item.id}:${n}`]), ...(item.preview ? [['preview', `${item.id}:preview`]] : [])];
      for (const [name, aad] of names) {
        const path = `files/${item.id}/${name}`;
        files.push({ path, getBlob: async () => this.sealed(new Blob([await this.readPart(path, aad, oldKey)]), aad, newKey)() });
      }
    }
    this.busy = password ? 'Locking every file…' : 'Unlocking every file…';
    this.render();
    try {
      await this.commit(password ? 'Lock the drawings vault' : 'Remove the drawings vault lock', doc => {
        doc.lock = lock;
        doc.keyId = keyId;
      }, {
        files, parseKey: oldKey, serializeKey: newKey,
        onProgress: (done, total) => { this.busy = `${password ? 'Locking' : 'Unlocking'} files… ${done} of ${total}`; this.render(); },
      });
      this.key = newKey;
      this.stored = { lock };
      await vc.disableTouchId();
      await this.run(() => this.store().compactHistory('Drawings snapshot: cleared old history'));
      this.ui.toast(password ? 'Drawings is now locked with your password.' : 'The password lock is off.');
    } catch (e) {
      this.ui.toast(e.message, 'error');
    }
    this.busy = '';
    this.render();
  }

  async changePassword(current, next) {
    const key = await vc.unlockWithPassword(this.doc.lock, current); // checks the current password
    const lock = await vc.makeLock(next, key);
    await this.commit('Change the drawings vault password', doc => { doc.lock = lock; });
    this.stored = { lock };
    this.ui.toast('Password changed.');
  }

  // ---- screen ----------------------------------------------------------------------

  render() {
    const box = document.querySelector('#vaultView');
    if (!box || box.hidden) return;
    const html = this.html();
    if (box.dataset.html === html) return;
    box.dataset.html = html;
    box.innerHTML = html;
  }

  html() {
    const repoLink = `<a href="https://github.com/${esc(this.repoName)}" target="_blank" rel="noopener">${esc(this.repoName)}</a>`;
    switch (this.status) {
      case 'idle':
      case 'loading':
        return '<div class="vault-card"><p class="muted">Opening Drawings…</p></div>';
      case 'error':
        return `<div class="vault-card"><h2>Couldn’t open Drawings</h2><p class="muted">${esc(this.error)}</p><button class="btn primary" data-v="reload">Try again</button></div>`;
      case 'no-access':
        return `<div class="vault-card">
          <div class="vault-icon">${icon('lock')}</div>
          <h2>Connect your private Drawings</h2>
          <p class="muted">Your drawing files are kept in a separate <b>private</b> repository, ${repoLink}, so they never appear on the photo site. Your GitHub key just needs access to it (one time):</p>
          <ol class="steps">
            <li>Open <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener">GitHub → Fine-grained tokens</a>.</li>
            <li>Click your <b>Artist Album</b> key, then <b>Edit</b>.</li>
            <li>Under <b>Repository access</b>, also select <b>${esc(CONFIG.vaultRepo)}</b>.</li>
            <li>Make sure <b>Contents</b> is <b>Read and write</b>, then click <b>Update</b>.</li>
          </ol>
          ${this.ui.token() ? '' : '<p class="muted">You also need to add your key under <b>Edit access</b> first.</p>'}
          <button class="btn primary" data-v="reload">I’ve done it, check again</button>
        </div>`;
      case 'setup':
        return `<form class="vault-card" data-v-form="setup">
          <div class="vault-icon">${icon('lock')}</div>
          <h2>Set up Drawings</h2>
          <p class="muted">A private place for your drawing files: Procreate, PSD, Clip Studio, PNG, anything. Files are stored in ${repoLink} and never shown on the photo site. Big files are fine; they’re stored in parts.</p>
          <label class="check"><input type="checkbox" name="lock" checked> Lock with a password <small>(recommended; files are encrypted before they leave this device)</small></label>
          <div class="pw-fields">
            <input class="text-input" type="password" name="pw" placeholder="Password" autocomplete="new-password">
            <input class="text-input" type="password" name="pw2" placeholder="Type it again" autocomplete="new-password">
            <p class="muted small">The password is never stored anywhere. If you forget it, locked files can’t be recovered, so keep it somewhere safe. A longer password is much harder to guess.</p>
          </div>
          <p class="form-msg error" data-v-msg></p>
          <button class="btn primary" type="submit">Create Drawings</button>
        </form>`;
      case 'locked': {
        const touch = this.touchId && vc.touchIdSetup();
        return `<form class="vault-card" data-v-form="unlock">
          <div class="vault-icon">${icon('lock')}</div>
          <h2>Drawings is locked</h2>
          ${touch ? `<button type="button" class="btn primary wide" data-v="touchid">${icon('fingerprint')}Unlock with Touch ID</button><p class="muted small center">or use your password</p>` : ''}
          <div class="pw-row">
            <input class="text-input" type="password" name="pw" placeholder="Password" autocomplete="current-password" ${touch ? '' : 'autofocus'}>
            <button class="btn ${touch ? 'ghost' : 'primary'}" type="submit">Unlock</button>
          </div>
          <p class="form-msg error" data-v-msg></p>
        </form>`;
      }
      case 'ready':
        return this.readyHtml(repoLink);
    }
    return '';
  }

  readyHtml(repoLink) {
    const items = this.doc.items;
    const total = items.reduce((s, i) => s + i.size, 0);
    const locked = !!this.doc.lock;
    const touch = vc.touchIdSetup();
    const cards = items.map(item => {
      const prev = this.previews.get(item.id);
      return `<article class="vfile" data-id="${esc(item.id)}">
        <button class="vfile-preview" data-v="download" title="Download ${esc(item.name)}">
          ${prev ? `<img src="${prev}" alt="">` : `<span class="vfile-ext">${esc(ext(item.name))}</span>`}
          <span class="vfile-dl">${icon('download')}</span>
        </button>
        <div class="vfile-info">
          <strong title="${esc(item.name)}">${esc(item.name)}</strong>
          <span class="muted small">${esc(formatBytes(item.size))} · ${esc(new Date(item.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))}</span>
        </div>
        <div class="vfile-actions">
          <button class="icon-btn sm" data-v="download" title="Download" aria-label="Download">${icon('download')}</button>
          <button class="icon-btn sm" data-v="rename" title="Rename" aria-label="Rename">${icon('edit')}</button>
          <button class="icon-btn sm" data-v="delete" title="Delete" aria-label="Delete">${icon('trash')}</button>
        </div>
      </article>`;
    }).join('');
    return `<div class="vault-bar">
        <span class="vault-status ${locked ? 'on' : ''}">${icon('lock')}${locked ? 'Locked with a password · encrypted' : 'Not password-locked'}</span>
        <span class="muted small">${items.length} ${items.length === 1 ? 'file' : 'files'} · ${esc(formatBytes(total))} · private repo ${repoLink}</span>
        ${this.busy ? `<span class="save-status" data-state="saving">${esc(this.busy)}</span>` : ''}
        ${locked ? '<button class="btn ghost sm" data-v="lock">Lock now</button>' : ''}
      </div>
      ${items.length ? `<div class="vfiles">${cards}</div>` : `<div class="empty vault-empty">${icon('upload').replace('class="ic"', 'class="ic xl"')}<h2>Drop your drawing files here</h2><p>Procreate, PSD, Clip Studio, Krita, PNG… any file. They stay private and never appear on the photo site.</p><button class="btn primary" data-v="pick">${icon('plus')}Upload files</button></div>`}
      <details class="vault-settings"${this.settingsOpen ? ' open' : ''}>
        <summary>Drawings settings</summary>
        ${locked && this.touchId ? `<div class="vs-row"><div><strong>Touch ID on this device</strong><p class="muted small">${touch ? (touch.mode === 'fingerprint' ? 'On. Your fingerprint protects the key on this device.' : 'On. This browser can’t tie the key to your fingerprint, so the key is kept in this browser and Touch ID guards it. Your password still protects the files on GitHub.') : 'Unlock with your fingerprint instead of typing the password.'}</p></div>
          <button class="btn ghost sm" data-v="${touch ? 'touchid-off' : 'touchid-on'}">${touch ? 'Turn off' : 'Turn on'}</button></div>` : ''}
        ${locked ? `<form class="vs-row" data-v-form="change"><div><strong>Change password</strong>
          <div class="pw-fields"><input class="text-input" type="password" name="cur" placeholder="Current password" autocomplete="current-password"><input class="text-input" type="password" name="pw" placeholder="New password" autocomplete="new-password"><input class="text-input" type="password" name="pw2" placeholder="New password again" autocomplete="new-password"></div>
          <p class="form-msg error" data-v-msg></p></div><button class="btn ghost sm" type="submit">Change</button></form>` : ''}
        ${locked
          ? '<div class="vs-row"><div><strong>Password lock</strong><p class="muted small">Turning it off stores your files unencrypted (still private: only your GitHub key can see them).</p></div><button class="btn danger-ghost sm" data-v="lock-off">Turn off</button></div>'
          : `<form class="vs-row" data-v-form="lock-on"><div><strong>Lock with a password</strong><p class="muted small">Encrypts every file before it’s stored. Your password is never stored, so if you forget it, locked files can’t be recovered.</p>
              <div class="pw-fields"><input class="text-input" type="password" name="pw" placeholder="Password" autocomplete="new-password"><input class="text-input" type="password" name="pw2" placeholder="Type it again" autocomplete="new-password"></div><p class="form-msg error" data-v-msg></p></div>
              <button class="btn primary sm" type="submit">Lock</button></form>`}
      </details>`;
  }

  // Click/submit handling for everything inside #vaultView.
  bind(box, pickFiles) {
    box.addEventListener('click', async e => {
      const btn = e.target.closest('[data-v]');
      if (!btn) return;
      const action = btn.dataset.v;
      const item = this.doc?.items.find(i => i.id === btn.closest('.vfile')?.dataset.id);
      try {
        if (action === 'reload') await this.load();
        else if (action === 'pick') pickFiles();
        else if (action === 'download' && item) await this.download(item);
        else if (action === 'rename' && item) await this.rename(item);
        else if (action === 'delete' && item) await this.remove(item);
        else if (action === 'lock') this.lockNow();
        else if (action === 'touchid') await this.unlockTouchId();
        else if (action === 'touchid-on') {
          const mode = await vc.enableTouchId(this.key, this.doc.keyId);
          this.ui.toast(mode === 'fingerprint' ? 'Touch ID is on for this device.' : 'Touch ID is on for this browser.');
          this.render();
        } else if (action === 'touchid-off') {
          await vc.disableTouchId();
          this.render();
        } else if (action === 'lock-off') {
          const ok = await this.ui.ask({
            title: 'Turn off the password lock?', input: false, ok: 'Turn off', danger: true,
            text: 'Every file will be stored unencrypted. They stay in your private repo, so only your GitHub key can see them.',
          });
          if (ok) await this.setLock(null);
        }
      } catch (err) {
        if (err?.name === 'NotAllowedError') return; // Touch ID prompt dismissed
        this.ui.toast(err.message || String(err), 'error');
      }
    });

    box.addEventListener('submit', async e => {
      const form = e.target.closest('[data-v-form]');
      if (!form) return;
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const msg = text => { const el = form.querySelector('[data-v-msg]'); if (el) el.textContent = text; };
      const submit = form.querySelector('[type=submit]');
      const newPassword = () => {
        if (!f.pw) return msg('Choose a password.'), null;
        if (f.pw !== f.pw2) return msg('The two passwords don’t match.'), null;
        return f.pw;
      };
      submit.disabled = true;
      try {
        if (form.dataset.vForm === 'setup') {
          const pw = f.lock ? newPassword() : null;
          if (f.lock && !pw) return;
          msg('');
          submit.textContent = 'Setting up…';
          await this.create(pw);
        } else if (form.dataset.vForm === 'unlock') {
          msg('');
          submit.textContent = 'Unlocking…';
          await this.unlock(f.pw || '');
          if (this.touchId && !vc.touchIdSetup()) this.ui.toast('Tip: turn on Touch ID under “Drawings settings” to unlock with your fingerprint.');
        } else if (form.dataset.vForm === 'change') {
          const pw = newPassword();
          if (!pw) return;
          await this.changePassword(f.cur || '', pw);
          form.reset();
          msg('');
        } else if (form.dataset.vForm === 'lock-on') {
          const pw = newPassword();
          if (!pw) return;
          await this.setLock(pw);
        }
      } catch (err) {
        msg(err.message || String(err));
      } finally {
        submit.disabled = false;
        if (submit.textContent.endsWith('…')) submit.textContent = form.dataset.vForm === 'unlock' ? 'Unlock' : 'Create Drawings';
      }
    });

    // Keep "Drawings settings" open when the screen redraws ("toggle" doesn't bubble).
    box.addEventListener('toggle', e => {
      if (e.target.matches?.('.vault-settings')) this.settingsOpen = e.target.open;
    }, true);

    // Setup form: show the password fields only when "lock" is ticked.
    box.addEventListener('change', e => {
      if (e.target.name === 'lock') e.target.form.querySelector('.pw-fields').hidden = !e.target.checked;
    });
  }
}
