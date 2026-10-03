import { CONFIG, resolveRepo } from './config.js';
import {
  emptyAlbum, uid, imagePaths, ops, visibleImages, folderCounts, totalBytes, trashBytes, allTags, normTag, layoutColumns,
} from './album.js';
import { GitHubStore } from './github.js';
import { processFile, isImageFile, formatBytes } from './images.js';
import { SmartAI } from './smart.js';
import { Vault } from './vault.js';
import { Moodboard } from './moodboard.js';

// Must match <meta name="app-version"> in index.html (tools/bump-version.mjs updates both).
const APP_VERSION = '20261003-153449';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const copies = n => `${n} ${n === 1 ? 'copy' : 'copies'}`;
const icon = name => `<svg class="ic"><use href="#i-${name}"/></svg>`;

const IMG_DRAG = 'application/x-album-images';
const FOLDER_DRAG = 'application/x-album-folder';
const UNSORTED = '~unsorted';
const NEW_FOLDER = '~new';

// ---- settings kept in this browser only -------------------------------------

const KEYS = {
  token: 'artist-album.token', name: 'artist-album.name', login: 'artist-album.login',
  dismissed: 'artist-album.ai-dismissed', promo: 'artist-album.ai-promo', collapsed: 'artist-album.ai-collapsed',
};
const prefs = {
  raw: k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  get: k => { try { return localStorage.getItem(KEYS[k]) || ''; } catch { return ''; } },
  set: (k, v) => { try { v ? localStorage.setItem(KEYS[k], v) : localStorage.removeItem(KEYS[k]); } catch {} },
};
const myName = () => prefs.get('name') || prefs.get('login');

const repo = resolveRepo();
const gh = new GitHubStore(repo, prefs.get('token'));
gh.onWait = ms => toast(`GitHub asked us to slow down. Continuing by itself in ${ms >= 90_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`}… Keep this tab open.`, '', null, { duration: Math.min(ms, 15_000) });

// ---- state ------------------------------------------------------------------

const state = {
  server: emptyAlbum(), // last version confirmed by GitHub
  album: emptyAlbum(),  // server version + edits that are still saving
  loaded: false,
  view: 'all',          // 'all' | 'unsorted' | 'trash' | folder id
  query: '',
  tags: [],             // active tag filters (all must match)
  limit: CONFIG.pageSize,
  selected: new Set(),
  selecting: false,
  lightbox: null,       // open image id
  repoBytes: null,
  mode: 'grid',         // folders: 'grid' | 'board' (moodboard)
};

const pending = [];          // edits not yet confirmed by GitHub, applied on top of state.server
let chain = Promise.resolve();
let saveGeneration = 0;      // bumps when a save lands, so older background refreshes are dropped
let lastLoad = 0;
const localUrls = new Map(); // image id -> { full, thumb } object URLs for photos uploaded in this tab

// Suggestions the user said no to, as "imageId>target" (kept in this browser).
const dismissed = new Set((() => { try { return JSON.parse(prefs.get('dismissed') || '[]'); } catch { return []; } })());
const saveDismissed = () => prefs.set('dismissed', JSON.stringify([...dismissed].slice(-3000)));

const smart = new SmartAI({
  getThumb: img => fetchImageBlob(img, 'thumb'),
  onChange: () => safely(renderSuggestions, renderLightboxSmart, renderLightboxSimilar, renderSettingsAI, renderDupes),
});

const vault = new Vault({
  owner: repo.owner, token: () => gh.token, myName,
  toast: (...a) => toast(...a), ask: o => ask(o), uploadPanel: (...a) => uploadPanel(...a), saveBlob: (...a) => saveBlob(...a),
});

const canEdit = () => !!gh.token;
const isFolderView = v => !['all', 'unsorted', 'trash', 'vault', 'dupes'].includes(v);
const boardMode = () => isFolderView(state.view) && state.mode === 'board';
const modeKey = folder => `artist-album.mode.${folder}`;

const moodboard = new Moodboard($('#moodboard'), {
  images: () => currentList(),
  layout: () => state.album.boards?.[state.view],
  canEdit,
  setImgSrc: (...a) => setImgSrc(...a),
  loadImage: (...a) => loadImage(...a),
  open: id => openLightbox(id),
  save: (boardId, patch) => save('Arrange moodboard', ops.setBoardItems(boardId, patch)),
  trash: ids => trashImages(ids),
  confirmTidy: () => ask({
    title: 'Tidy up this moodboard?', input: false, ok: 'Tidy up',
    text: 'Every photo is lined up in neat columns. Your current arrangement is replaced.',
  }),
});
const folderName = id => state.album.folders.find(f => f.id === id)?.name;
const findImage = id => state.album.images.find(i => i.id === id);
const currentList = () => visibleImages(state.album, state.view, state.query, state.view === 'trash' ? [] : state.tags);
const trashedIds = () => state.album.images.filter(i => i.trashedAt).map(i => i.id);

// ---- syncing with GitHub ----------------------------------------------------

// Runs GitHub writes one at a time, in order.
function exclusive(fn) {
  const result = chain.then(fn);
  chain = result.catch(() => {});
  return result;
}

function rebase() {
  const album = structuredClone(state.server);
  for (const p of pending) p.op(album, { remove: [] });
  state.album = album;
  smart.sync(album);
  renderAll();
}

// Applies the change on screen immediately, then commits it to GitHub.
// Each save re-applies its op to the latest album.json, so edits never clash.
function save(message, op, { files = [], onProgress } = {}) {
  if (!requireKey()) return Promise.resolve(false);
  const entry = { op };
  pending.push(entry);
  setStatus('saving');
  rebase();
  return exclusive(async () => {
    setStatus('saving');
    let ok = false;
    try {
      state.server = await gh.commitChange({ op, files, message, onProgress, onConflict: () => setStatus('retrying') });
      ok = true;
    } catch (e) {
      toast(e.message, 'error');
      try { state.server = await gh.getAlbum(); } catch {}
    }
    saveGeneration++;
    pending.splice(pending.indexOf(entry), 1);
    rebase();
    setStatus(pending.length ? 'saving' : ok ? 'saved' : 'error');
    return ok;
  });
}

async function load() {
  try {
    state.server = await gh.getAlbumAnyway();
  } catch (e) {
    toast(`Could not load the album. ${e.message}`, 'error');
  }
  lastLoad = Date.now();
  state.loaded = true;
  rebase();
  loadRepoSize();
}

async function loadRepoSize() {
  try {
    state.repoBytes = await gh.repoSizeBytes();
  } catch {
    state.repoBytes ??= 0; // unknown (e.g. rate limited): the meter falls back to the photos' size
  }
  renderSidebar();
}

async function refresh() {
  if (!state.loaded || pending.length) return;
  if (Date.now() - lastLoad < (canEdit() ? 10_000 : 120_000)) return;
  const gen = saveGeneration;
  lastLoad = Date.now();
  try {
    const album = await gh.getAlbumAnyway();
    if (gen === saveGeneration && !pending.length) {
      state.server = album;
      rebase();
    }
  } catch {}
}

function requireKey() {
  if (canEdit()) return true;
  openSettings('Add a GitHub key to make changes.');
  return false;
}

async function fetchImageBlob(img, kind) {
  const path = imagePaths(img)[kind];
  for (const url of [localUrls.get(img.id)?.[kind], path, gh.rawUrl(path)].filter(Boolean)) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.blob();
    } catch {}
  }
  throw new Error('Image not found.');
}

// ---- rendering ----------------------------------------------------------------

// Each part renders on its own, so a glitch in one never stops the album from
// loading or a save from going through.
function safely(...parts) {
  for (const part of parts) {
    try { part(); } catch (e) { reportError(e); }
  }
}

function renderAll() {
  if (state.loaded && isFolderView(state.view) && !folderName(state.view)) {
    state.view = 'all';
    history.replaceState(history.state, '', hashUrl());
  }
  for (const id of state.selected) if (!currentList().some(i => i.id === id)) state.selected.delete(id);
  document.body.classList.toggle('can-edit', canEdit());
  document.body.classList.toggle('selecting', canEdit() && (state.selecting || state.selected.size > 0));
  document.body.classList.toggle('in-vault', state.view === 'vault');
  document.body.classList.toggle('in-dupes', state.view === 'dupes');
  document.body.classList.toggle('mb-mode', boardMode());
  $('#vaultView').hidden = state.view !== 'vault';
  $('#dupesView').hidden = state.view !== 'dupes';
  safely(renderSidebar, renderHeader, renderTagBar, renderNotice, renderSuggestions, renderGrid, renderSelection, renderLightbox,
    () => state.view === 'vault' && vault.render(), renderDupes,
    () => (boardMode() ? moodboard.show(state.view) : moodboard.hide()));
}

let errorShown = false;
function reportError(err) {
  console.error(err);
  if (errorShown) return;
  errorShown = true;
  toast('Something on this page went wrong. If it keeps happening, refresh with Cmd+Shift+R (Ctrl+Shift+R on Windows).', 'error');
}

// Image sources in order of preference: the local copy (just uploaded), the
// GitHub Pages copy (fast CDN), then raw.githubusercontent.com (available
// instantly after a commit, before Pages has redeployed).
function setImgSrc(el, img, kind, onFail) {
  const path = imagePaths(img)[kind];
  const sources = [localUrls.get(img.id)?.[kind], path, gh.rawUrl(path)].filter(Boolean);
  let i = 0;
  el.onerror = () => {
    if (++i < sources.length) { el.src = sources[i]; return; }
    el.onerror = null;
    if (onFail) onFail();
    else el.closest('.card')?.classList.add('broken');
  };
  el.src = sources[0];
}

function loadImage(img, kind) {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.onload = () => resolve(probe.src);
    setImgSrc(probe, img, kind, reject);
  });
}

function setMeter(meter, fill, label, used, limit, text) {
  const ratio = used / limit;
  $(fill).style.width = `${Math.min(100, ratio * 100).toFixed(1)}%`;
  $(meter).classList.toggle('warn', ratio >= CONFIG.warnAt);
  $(label).textContent = text;
}

const folderEls = new Map();
function renderSidebar() {
  const counts = folderCounts(state.album);
  for (const btn of document.querySelectorAll('.nav > .nav-item')) {
    btn.classList.toggle('active', btn.dataset.view === state.view);
    const view = btn.dataset.view;
    btn.querySelector('.count').textContent = view === 'vault' ? (vault.doc ? vault.doc.items.length : '') : view === 'dupes' ? ''
      : state.loaded ? counts[view] || (view === 'trash' ? '' : 0) : '';
  }
  $('#trashNav').hidden = !canEdit() && !counts.trash;

  const items = state.album.folders.map(f => {
    let li = folderEls.get(f.id);
    if (!li) {
      li = document.createElement('li');
      li.innerHTML = `<button class="nav-item folder" data-view="${esc(f.id)}"><span class="cover"></span><span class="name"></span><span class="count"></span></button>`;
      folderEls.set(f.id, li);
    }
    const btn = li.firstElementChild;
    btn.draggable = canEdit();
    btn.classList.toggle('active', state.view === f.id);
    btn.querySelector('.name').textContent = f.name;
    btn.title = f.name;
    btn.querySelector('.count').textContent = counts[f.id] || 0;
    const cover = state.album.images.find(i => i.folder === f.id && !i.trashedAt);
    const coverEl = btn.querySelector('.cover');
    const key = cover ? cover.id : '-';
    if (coverEl.dataset.key !== key) {
      coverEl.dataset.key = key;
      if (cover) {
        const im = document.createElement('img');
        im.alt = '';
        im.draggable = false;
        setImgSrc(im, cover, 'thumb', () => {});
        coverEl.replaceChildren(im);
      } else {
        coverEl.innerHTML = icon('folder');
      }
    }
    return li;
  });
  const list = $('#folderList');
  if (items.length !== list.children.length || items.some((li, i) => list.children[i] !== li)) list.replaceChildren(...items);
  for (const id of folderEls.keys()) if (!state.album.folders.some(f => f.id === id)) folderEls.delete(id);
  $('#folderHint').hidden = !(state.loaded && canEdit() && !state.album.folders.length);

  const site = totalBytes(state.album);
  const trash = trashBytes(state.album);
  setMeter('#siteMeter', '#siteFill', '#siteLabel', site, CONFIG.siteLimitBytes, `${formatBytes(site)} / 1 GB`);
  // GitHub's number lags behind; the repo is never smaller than the photos in it now.
  const repoBytes = Math.max(state.repoBytes ?? 0, site);
  setMeter('#repoMeter', '#repoFill', '#repoLabel', repoBytes, CONFIG.repoLimitBytes,
    state.repoBytes === null ? '…' : `${formatBytes(repoBytes)} / 5 GB`);
  $('#storageNote').textContent = trash ? `${formatBytes(trash)} is in the Trash. Empty it to free the space.` : '';
  $('#accessState').textContent = canEdit() ? `Editing as ${myName() || 'you'}` : 'View only. Click to unlock';
}

function renderHeader() {
  const title = { all: 'All photos', unsorted: 'Unsorted', trash: 'Trash', vault: 'Drawings', dupes: 'Duplicates' }[state.view] || folderName(state.view) || '';
  const toggle = $('#modeToggle');
  toggle.hidden = !isFolderView(state.view);
  for (const b of toggle.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === (boardMode() ? 'board' : 'grid')));
  $('#addBtn span').textContent = state.view === 'vault' ? 'Upload files' : 'Add photos';
  $('#viewTitle').textContent = title;
  document.title = state.view === 'all' ? 'Artist Album' : `${title} · Artist Album`;
  $('#viewCount').textContent = state.loaded ? plural(currentList().length, 'photo') : '';
  const folderTools = isFolderView(state.view) && canEdit();
  $('#renameFolderBtn').hidden = !folderTools;
  $('#deleteFolderBtn').hidden = !folderTools;
  $('#emptyTrashBtn').hidden = !(state.view === 'trash' && canEdit() && trashedIds().length);
  $('#selectBtn').hidden = !canEdit();
  $('#selectBtn').classList.toggle('on', state.selecting);
}

function renderTagBar() {
  const bar = $('#tagBar');
  const tags = allTags(state.album);
  const show = state.loaded && state.view !== 'trash' && (tags.length || state.tags.length);
  bar.hidden = !show;
  if (!show) return;
  const rest = tags.filter(([t]) => !state.tags.includes(t)).slice(0, 40);
  const key = JSON.stringify([state.tags, rest]);
  if (bar.dataset.key === key) return;
  bar.dataset.key = key;
  $('#tagChips').innerHTML =
    state.tags.map(t => `<button class="chip active" data-tag="${esc(t)}" title="Stop filtering by ${esc(t)}">#${esc(t)}${icon('close')}</button>`).join('') +
    (state.tags.length ? '<button class="chip link-chip" data-clear-tags>Clear</button>' : '') +
    rest.map(([t, n]) => `<button class="chip" data-tag="${esc(t)}" title="Show photos tagged ${esc(t)}">#${esc(t)} <small>${n}</small></button>`).join('');
}

function renderNotice() {
  const box = $('#notice');
  const n = trashedIds().length;
  const show = state.loaded && state.view === 'trash' && n > 0;
  box.hidden = !show;
  if (show) {
    box.innerHTML = `Photos in the Trash still take up space (${esc(formatBytes(trashBytes(state.album)))}). ` +
      '<b>Empty trash</b> deletes them for good and clears GitHub’s old version history, so the space is really freed. ' +
      'Your other photos, folders, tags and comments are not affected.';
  }
}

const cards = new Map();
function cardFor(img) {
  let el = cards.get(img.id);
  if (!el) {
    el = document.createElement('article');
    el.className = 'card';
    el.tabIndex = 0;
    el.dataset.id = img.id;
    el.innerHTML = `<div class="card-media"><img alt="" loading="lazy" decoding="async" draggable="false"><button class="card-check" type="button" tabindex="-1" aria-label="Select photo">${icon('check')}</button><button class="card-dl" type="button" tabindex="-1" aria-label="Download photo" title="Download">${icon('download')}</button></div><div class="card-caption"><span class="card-title"></span><span class="card-comments">${icon('comment')}<b></b></span></div>`;
    const im = el.querySelector('img');
    im.addEventListener('load', () => im.classList.add('loaded'));
    setImgSrc(im, img, 'thumb');
    cards.set(img.id, el);
  }
  el.querySelector('.card-media').style.aspectRatio = `${img.w} / ${img.h}`;
  el.querySelector('.card-caption').hidden = !(img.title || img.comments.length);
  el.querySelector('.card-title').textContent = img.title || '';
  const cc = el.querySelector('.card-comments');
  cc.hidden = !img.comments.length;
  cc.title = plural(img.comments.length, 'comment');
  cc.querySelector('b').textContent = img.comments.length;
  const selected = state.selected.has(img.id);
  el.classList.toggle('selected', selected);
  el.querySelector('.card-check').setAttribute('aria-pressed', selected);
  el.draggable = canEdit();
  el.setAttribute('aria-label', img.title || img.originalName || 'Photo');
  return el;
}

function columnCount() {
  const w = $('#grid').clientWidth || window.innerWidth;
  return Math.max(2, Math.min(6, Math.floor((w + 16) / 236)));
}

function renderGrid() {
  const grid = $('#grid');
  const list = currentList();
  const shown = list.slice(0, state.limit);
  const n = columnCount();
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 16;
  const colW = ((grid.clientWidth || 1000) - gap * (n - 1)) / n;
  const heights = shown.map(img => colW * (img.h / img.w) + (img.title || img.comments.length ? 30 : 0) + gap);
  const layout = layoutColumns(heights, n);

  if (grid.children.length !== n)
    grid.replaceChildren(...Array.from({ length: n }, () => Object.assign(document.createElement('div'), { className: 'col' })));
  layout.forEach((idxs, c) => {
    const col = grid.children[c];
    const els = idxs.map(i => cardFor(shown[i]));
    if (els.length !== col.children.length || els.some((el, k) => col.children[k] !== el)) col.replaceChildren(...els);
  });
  const live = new Set(state.album.images.map(i => i.id));
  for (const id of cards.keys()) if (!live.has(id)) cards.delete(id);

  renderEmpty(list);
  requestAnimationFrame(maybeLoadMore);
}

function maybeLoadMore() {
  if (state.limit >= currentList().length) return;
  if ($('#sentinel').getBoundingClientRect().top < window.innerHeight + 1200) {
    state.limit += CONFIG.pageSize;
    renderGrid();
  }
}

function renderEmpty(list) {
  let html = '';
  if (!state.loaded) {
    html = '<p>Loading album…</p>';
  } else if (!list.length) {
    const addBtn = canEdit() ? `<button class="btn primary" data-action="add">${icon('plus')}Add photos</button>` : '';
    const live = state.album.images.filter(i => !i.trashedAt).length;
    if (state.view === 'trash') {
      html = `${icon('trash').replace('class="ic"', 'class="ic xl"')}<h2>The Trash is empty</h2><p>Deleted photos wait here, so you can restore them, until you empty the Trash.</p>`;
    } else if (state.query || state.tags.length) {
      const what = [state.query && `“${esc(state.query)}”`, ...state.tags.map(t => `#${esc(t)}`)].filter(Boolean).join(' + ');
      html = `<h2>No matches</h2><p>Nothing here matches ${what}.</p>`;
    } else if (!live) {
      html = `${icon('image').replace('class="ic"', 'class="ic xl"')}<h2>${canEdit() ? 'Start your board' : 'No photos yet'}</h2>` +
        (canEdit()
          ? `<p>Drag images anywhere onto this page, paste them, or pick them from your computer. Big files are shrunk automatically.</p>${addBtn}`
          : '<p>Nothing has been added yet.</p>');
    } else if (isFolderView(state.view)) {
      html = `${icon('folder').replace('class="ic"', 'class="ic xl"')}<h2>This folder is empty</h2>` +
        (canEdit() ? `<p>Drag photos onto it in the sidebar, or add new ones while it is open.</p>${addBtn}` : '<p>Nothing here yet.</p>');
    } else {
      html = '<h2>Nothing unsorted</h2><p>Every photo is in a folder.</p>';
    }
  }
  const box = $('#empty');
  box.hidden = !html;
  if (box.dataset.html !== html) {
    box.dataset.html = html;
    box.innerHTML = html;
  }
}

function fillFolderSelect(sel, placeholder = '') {
  const key = JSON.stringify([placeholder, canEdit(), state.album.folders.map(f => [f.id, f.name])]);
  if (sel.dataset.key === key) return;
  sel.dataset.key = key;
  sel.innerHTML =
    (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') +
    `<option value="${UNSORTED}">Unsorted</option>` +
    state.album.folders.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('') +
    (canEdit() ? `<option value="${NEW_FOLDER}">+ New folder…</option>` : '');
}

function renderSelection() {
  const n = state.selected.size;
  const inTrash = state.view === 'trash';
  $('#selectionBar').hidden = !canEdit() || !(n || state.selecting);
  $('#selCount').textContent = n ? `${n} selected` : 'Tap photos to select';
  fillFolderSelect($('#selMove'), 'Move to…');
  $('#selMove').value = '';
  $('#selMove').hidden = inTrash;
  $('#selTag').hidden = inTrash;
  $('#selRestore').hidden = !inTrash;
  $('#selDelete span').textContent = inTrash ? 'Delete forever' : 'Delete';
  for (const b of ['#selMove', '#selTag', '#selRestore', '#selDelete', '#selDownload']) $(b).disabled = !n;
  $('#selAll').hidden = n > 0 && n === currentList().length;
}

// ---- smart suggestions ----------------------------------------------------------

let lastGroups = new Map();
function suggestionGroups() {
  const groups = smart.folderSuggestions(state.album, dismissed)
    .map(g => ({ ...g, ids: g.ids.filter(id => { const i = findImage(id); return i && !i.trashedAt && (!i.folder || !folderName(i.folder)); }) }))
    .filter(g => g.ids.length && (!g.folderId || folderName(g.folderId)));
  lastGroups = new Map(groups.map(g => [g.key, g]));
  return groups;
}

function aiStatusText() {
  if (smart.state === 'loading') return `Downloading the AI model… ${Math.round(smart.downloadProgress * 100)}% (one time, 23 MB)`;
  if (smart.state === 'analyzing') return `Looking at your photos… ${smart.done} of ${smart.total}`;
  if (smart.state === 'error') return smart.error;
  return '';
}

function renderSuggestions() {
  const panel = $('#suggestPanel');
  const unsorted = folderCounts(state.album).unsorted;
  const show = state.loaded && canEdit() && state.view === 'unsorted' && !state.query && !state.tags.length && unsorted > 0 &&
    (smart.enabled || prefs.get('promo') !== 'hidden');
  panel.hidden = !show;
  if (!show) return;
  panel.classList.toggle('collapsed', smart.enabled && prefs.get('collapsed') === '1');
  $('#suggestStatus').textContent = aiStatusText();

  let html;
  if (!smart.enabled) {
    html = `<div class="ai-promo"><span>Let AI suggest where your Unsorted photos belong, like “these look like Sketches” or “these look like manga pages”, plus tags for each photo. It runs privately on this device. The first time, it downloads a 23 MB model.</span>
      <button class="btn primary sm" data-ai-on>Turn on</button><button class="btn ghost sm" data-ai-hide>Not now</button></div>`;
  } else if (smart.state === 'loading') {
    html = `<div class="ai-progress"><span style="width:${Math.round(smart.downloadProgress * 100)}%"></span></div>`;
  } else if (smart.state === 'error') {
    html = `<p>${esc(smart.error)} <button class="link" data-ai-retry>Try again</button></p>`;
  } else if (smart.state === 'off') {
    html = '';
  } else {
    const groups = suggestionGroups();
    html = groups.map(g => {
      const name = g.folderId ? folderName(g.folderId) : g.newName;
      const text = g.reason === 'similar' ? `Looks like your <strong>${esc(name)}</strong> photos`
        : g.reason === 'looks-like' ? `Looks like <strong>${esc(name)}</strong>`
        : `These look like <strong>${esc(name)}</strong>. Make a new folder?`;
      const action = g.folderId ? `Move ${g.ids.length} to ${esc(name)}` : `Create “${esc(name)}” and move ${g.ids.length}`;
      const thumbs = g.ids.slice(0, 8).map(id => `<span class="sg-thumb" data-id="${esc(id)}"><img alt=""><button class="sg-x" data-exclude aria-label="Not this one" title="Not this one">${icon('close')}</button></span>`).join('');
      const more = g.ids.length > 8 ? `<span class="sg-more">+${g.ids.length - 8}</span>` : '';
      return `<div class="sg" data-key="${esc(g.key)}">
        <div class="sg-text">${text} <span class="muted">· ${plural(g.ids.length, 'photo')}</span></div>
        <div class="sg-thumbs">${thumbs}${more}</div>
        <div class="sg-actions"><button class="btn primary sm" data-accept>${action}</button><button class="icon-btn sm" data-dismiss aria-label="Dismiss" title="Dismiss">${icon('close')}</button></div>
      </div>`;
    }).join('') || (smart.state === 'analyzing' ? '' : '<p>No suggestions right now. Sort a few photos into folders and the suggestions learn from what you do.</p>');
  }
  const body = $('#suggestBody');
  if (body.dataset.html === html) return;
  body.dataset.html = html;
  body.innerHTML = html;
  for (const t of body.querySelectorAll('.sg-thumb')) {
    const img = findImage(t.dataset.id);
    if (img) setImgSrc(t.querySelector('img'), img, 'thumb', () => {});
  }
}

async function acceptSuggestion(group, ids = group.ids) {
  if (group.folderId) return save(`Move ${plural(ids.length, 'photo')} to ${folderName(group.folderId)} (suggested)`, ops.moveImages(ids, group.folderId));
  const existing = state.album.folders.find(f => f.name.toLowerCase() === group.newName.toLowerCase());
  if (existing) return save(`Move ${plural(ids.length, 'photo')} to ${existing.name} (suggested)`, ops.moveImages(ids, existing.id));
  const id = uid('f');
  return save(`Create folder "${group.newName}" and move ${plural(ids.length, 'photo')} (suggested)`, a => {
    ops.addFolder(id, group.newName)(a);
    ops.moveImages(ids, id)(a);
  });
}

function dismiss(key, ids) {
  for (const id of ids) dismissed.add(`${id}>${key}`);
  saveDismissed();
  renderSuggestions();
  renderLightboxSmart();
}

function renderSettingsAI() {
  $('#aiToggle').textContent = smart.enabled ? 'Turn off' : 'Turn on';
  $('#aiStatus').textContent = smart.enabled
    ? aiStatusText() || (smart.active ? `On. ${plural(smart.emb.size, 'photo')} analyzed on this device.` : '')
    : 'Off in this browser.';
}

// ---- lightbox ---------------------------------------------------------------

let lbShown = null;
let editingComment = null;
let commentsKey = '';

function renderLightbox() {
  const box = $('#lightbox');
  const img = state.lightbox && findImage(state.lightbox);
  if (!img) {
    if (!box.hidden) {
      box.hidden = true;
      document.body.classList.remove('no-scroll');
      lbShown = null;
    }
    return;
  }
  box.hidden = false;
  document.body.classList.add('no-scroll');
  if (lbShown !== img.id) {
    lbShown = img.id;
    editingComment = null;
    commentsKey = '';
    $('#commentText').value = '';
    $('#tagInput').value = '';
    $('#lbPanel').scrollTop = 0;
    showLightboxImage(img);
  }
  const trashed = !!img.trashedAt;
  box.classList.toggle('trashed', trashed);
  $('#lbTrashed').hidden = !trashed;
  $('#lbDelete span').textContent = trashed ? 'Delete forever' : 'Delete';

  const list = currentList();
  const idx = list.findIndex(i => i.id === img.id);
  $('#lbPrev').hidden = idx <= 0;
  $('#lbNext').hidden = idx < 0 || idx >= list.length - 1;
  $('#lbPosition').textContent = idx >= 0 ? `${idx + 1} of ${list.length}` : '';

  const title = $('#lbTitle');
  title.disabled = !canEdit() || trashed;
  title.placeholder = canEdit() ? 'Add a title' : 'Untitled';
  if (document.activeElement !== title) title.value = img.title || '';

  const added = new Date(img.addedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const meta = [`Added ${added}${img.addedBy ? ` by ${img.addedBy}` : ''}`, `${img.w}×${img.h}`, formatBytes(img.bytes || 0)];
  $('#lbMeta').innerHTML = `${esc(meta.join(' · '))}${img.originalName ? `<br>${esc(img.originalName)}` : ''}`;

  const folderSel = $('#lbFolder');
  fillFolderSelect(folderSel);
  folderSel.value = img.folder && folderName(img.folder) ? img.folder : UNSORTED;
  folderSel.disabled = !canEdit();

  renderLightboxTags(img);
  renderLightboxSmart();
  renderLightboxSimilar();
  renderComments(img);
  $('#commentAs').textContent = myName() ? `Commenting as ${myName()}` : '';
}

function renderLightboxTags(img) {
  const editable = canEdit() && !img.trashedAt;
  const key = JSON.stringify([img.id, img.tags, editable]);
  const box = $('#lbTags');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = img.tags.map(t =>
      `<span class="chip"><button class="chip-main" data-filter-tag="${esc(t)}" title="Show all photos tagged ${esc(t)}">#${esc(t)}</button>` +
      (editable ? `<button class="chip-x" data-untag="${esc(t)}" aria-label="Remove tag ${esc(t)}" title="Remove tag">${icon('close')}</button>` : '') +
      '</span>').join('') || (editable ? '' : '<span class="muted small">No tags</span>');
  }
  $('#tagInput').hidden = !editable;
  const options = allTags(state.album).map(([t]) => t).filter(t => !img.tags.includes(t));
  const listKey = options.join('|');
  if ($('#tagList').dataset.key !== listKey) {
    $('#tagList').dataset.key = listKey;
    $('#tagList').innerHTML = options.map(t => `<option value="${esc(t)}">`).join('');
  }
}

function renderLightboxSmart() {
  const box = $('#lbSuggest');
  const img = state.lightbox && findImage(state.lightbox);
  let html = '';
  if (img && !img.trashedAt && canEdit()) {
    if (!smart.enabled) {
      html = `<div class="sugg-row"><button class="link" data-ai-on>${icon('sparkle')} Suggest tags and folders with AI</button></div>`;
    } else if (!smart.active) {
      html = `<div class="sugg-row muted">${icon('sparkle')} ${esc(aiStatusText() || 'Starting the AI…')}</div>`;
      if (smart.state === 'error') html += '<div class="sugg-row"><button class="link" data-ai-retry>Try again</button></div>';
    } else if (!smart.emb.has(img.id)) {
      html = `<div class="sugg-row muted">${icon('sparkle')} Looking at this photo…</div>`;
    } else {
      const unsorted = !img.folder || !folderName(img.folder);
      const group = unsorted ? suggestionGroups().find(g => g.ids.includes(img.id)) : null;
      if (group) {
        const name = group.folderId ? folderName(group.folderId) : group.newName;
        html += `<div class="sugg-row"><span class="sugg-label">${icon('sparkle')}Suggested folder</span>` +
          `<button class="chip sugg from-similar" data-sfolder="${esc(group.key)}">${icon('folder')}${esc(name)}${group.folderId ? '' : ' (new)'}</button></div>`;
      }
      const tags = smart.tagSuggestions(img, state.album);
      if (tags.length) {
        html += `<div class="sugg-row"><span class="sugg-label">${icon('sparkle')}Suggested tags</span>` +
          tags.map(t => `<button class="chip sugg${t.source === 'similar' ? ' from-similar' : ''}" data-stag="${esc(t.tag)}" title="${t.source === 'similar' ? 'You used this on similar photos' : 'AI guess'}">+ ${esc(t.tag)}</button>`).join('') +
          '</div>';
      }
    }
  }
  if (box.dataset.html === html) return;
  box.dataset.html = html;
  box.innerHTML = html;
}

// "Similar photos": the closest matches by the on-device AI; copies are marked
// and can be removed (their tags and comments move to this photo).
function renderLightboxSimilar() {
  const box = $('#lbSimilar');
  const img = state.lightbox && findImage(state.lightbox);
  let html = '';
  if (img && !img.trashedAt && canEdit()) {
    if (!smart.enabled) {
      html = `<button class="link" data-sim="ai-on">${icon('copy')} Find similar photos and duplicates</button>`;
    } else if (smart.active && smart.emb.has(img.id)) {
      const { DUPLICATE, NEAR_DUPLICATE } = smart.lib;
      const list = smart.similar(img, state.album) || [];
      const dups = list.filter(s => s.score >= DUPLICATE);
      html = `<h2 class="lb-h">Similar photos <span>${list.length ? `(${list.length})` : ''}</span></h2>`;
      if (!list.length) html += '<p class="muted small">Nothing similar yet.</p>';
      else {
        if (dups.length) {
          html += `<div class="dup-note">${dups.length === 1 ? 'One photo looks like a copy' : `${dups.length} photos look like copies`} of this one.
            <button class="btn primary sm" data-sim="merge">Remove ${dups.length === 1 ? 'it' : 'them'}</button></div>`;
        }
        html += `<div class="sim-strip">${list.map(s => {
          const label = s.score >= DUPLICATE ? 'Duplicate' : s.score >= NEAR_DUPLICATE ? 'Near-duplicate' : `${Math.round(s.score * 100)}% alike`;
          return `<div class="sim" data-id="${esc(s.img.id)}"><img alt="" title="${esc(s.img.title || s.img.originalName || '')}">
            <span class="sim-score${s.score >= NEAR_DUPLICATE ? ' dup' : ''}">${label}</span>
            <button class="sim-x" data-sim="trash" title="Move to Trash" aria-label="Move to Trash">${icon('trash')}</button></div>`;
        }).join('')}</div>`;
      }
    }
  }
  if (box.dataset.html === html) return;
  box.dataset.html = html;
  box.innerHTML = html;
  for (const el of box.querySelectorAll('.sim')) {
    const other = findImage(el.dataset.id);
    if (other) setImgSrc(el.querySelector('img'), other, 'thumb', () => {});
  }
}

function removeCopies(keepId, ids) {
  if (!ids.length) return;
  save(`Remove ${plural(ids.length, 'duplicate photo')}`, ops.mergeAndTrash(keepId, ids));
  toast(`Moved ${copies(ids.length)} to the Trash. Tags and comments were kept.`, '', {
    label: 'Undo', fn: () => save(`Restore ${plural(ids.length, 'photo')}`, ops.restoreImages(ids)),
  });
}

// ---- Duplicates page ----------------------------------------------------------------

const dupeKeep = new Map();  // group key -> chosen keeper id
const dupeChoice = new Map(); // image id -> true (remove) / false (keep)

function dupeGroups() {
  const groups = smart.duplicates(state.album) || [];
  return groups.map(g => {
    const members = [g.keep, ...g.others.map(o => o.img)];
    const key = members.map(m => m.id).sort().join(',');
    const keep = members.find(m => m.id === dupeKeep.get(key)) || g.keep;
    const kv = smart.emb.get(keep.id);
    const others = members.filter(m => m !== keep).map(img => {
      const score = smart.lib.dot(kv, smart.emb.get(img.id));
      const duplicate = score >= smart.lib.DUPLICATE;
      return { img, score, duplicate, remove: dupeChoice.has(img.id) ? dupeChoice.get(img.id) : duplicate };
    });
    return { key, keep, others };
  });
}

function renderDupes() {
  const box = $('#dupesView');
  if (box.hidden) return;
  let html;
  const card = inner => `<div class="vault-card"><div class="vault-icon">${icon('copy')}</div>${inner}</div>`;
  if (!canEdit()) {
    html = card('<h2>Duplicates</h2><p class="muted">Add your GitHub key under <b>Edit access</b> to find and remove duplicate photos.</p>');
  } else if (!smart.enabled) {
    html = card(`<h2>Find duplicate photos</h2><p class="muted">The on-device AI compares your photos and finds copies, even resized, re-saved or cropped ones, so you can remove the extras. It runs privately on this device. The first time, it downloads a 23 MB model.</p><button class="btn primary" data-d="ai-on">Turn on and look for duplicates</button>`);
  } else if (!smart.active || smart.state === 'analyzing') {
    const pct = smart.state === 'analyzing' ? smart.done / Math.max(1, smart.total) : smart.downloadProgress;
    html = card(`<h2>Looking for duplicates…</h2><p class="muted">${esc(aiStatusText() || 'Starting the AI…')}</p><div class="ai-progress"><span style="width:${Math.round(pct * 100)}%"></span></div>${smart.state === 'error' ? '<button class="btn primary" data-d="ai-retry">Try again</button>' : ''}`);
  } else {
    const groups = dupeGroups();
    const selected = groups.reduce((n, g) => n + g.others.filter(o => o.remove).length, 0);
    if (!groups.length) {
      html = card(`<h2>No duplicates found</h2><p class="muted">None of your ${plural(state.album.images.filter(i => !i.trashedAt).length, 'photo')} look like copies of each other.</p>`);
    } else {
      html = `<div class="dup-head"><p>${plural(groups.length, 'group')} of look-alike photos. Copies are ticked; near-duplicates (heavier crops or edits) are left for you to decide. Removed copies go to the Trash, and their tags and comments move to the photo you keep.</p>
        <button class="btn primary" data-d="remove-all" ${selected ? '' : 'disabled'}>Remove ${selected} ticked ${selected === 1 ? 'copy' : 'copies'}</button></div>` +
        groups.map(g => {
          const n = g.others.filter(o => o.remove).length;
          const tile = (img, extra) => {
            const meta = [`${img.w}×${img.h}`, formatBytes(img.bytes || 0)].join(' · ');
            const counts = [img.tags?.length && plural(img.tags.length, 'tag'), img.comments?.length && plural(img.comments.length, 'comment')].filter(Boolean).join(' · ');
            return `<div class="dup-tile ${extra.cls}" data-id="${esc(img.id)}">
              <button class="dup-img" data-d="open" title="Open"><img alt=""></button>
              <div class="dup-meta"><b>${esc(img.title || img.originalName || 'Untitled')}</b><span>${esc(img.folder && folderName(img.folder) ? folderName(img.folder) : 'Unsorted')}</span><span>${esc(meta)}</span>${counts ? `<span>${esc(counts)}</span>` : ''}</div>
              ${extra.html}</div>`;
          };
          return `<section class="dup-group" data-key="${esc(g.key)}"><div class="dup-tiles">
            ${tile(g.keep, { cls: 'keep', html: '<span class="dup-badge">Keep</span>' })}
            ${g.others.map(o => tile(o.img, {
              cls: o.remove ? 'checked' : '',
              html: `<span class="dup-score${o.duplicate ? ' dup' : ''}">${o.duplicate ? 'Copy' : 'Near-duplicate'} · ${Math.round(o.score * 100)}%</span>
                <label class="dup-check"><input type="checkbox" data-d="toggle" ${o.remove ? 'checked' : ''}> Remove</label>
                <button class="link small" data-d="keep">Keep this one instead</button>`,
            })).join('')}
          </div><div class="dup-foot"><button class="btn ghost sm" data-d="remove" ${n ? '' : 'disabled'}>Remove ${copies(n)} from this group</button></div></section>`;
        }).join('');
    }
  }
  if (box.dataset.html === html) return;
  box.dataset.html = html;
  box.innerHTML = html;
  for (const el of box.querySelectorAll('.dup-tile')) {
    const img = findImage(el.dataset.id);
    if (img) setImgSrc(el.querySelector('img'), img, 'thumb', () => {});
  }
}

function bindDupes() {
  const box = $('#dupesView');
  box.addEventListener('click', e => {
    const btn = e.target.closest('[data-d]');
    if (!btn) return;
    const action = btn.dataset.d;
    if (action === 'ai-on') return smart.enable(state.album);
    if (action === 'ai-retry') return smart.start(state.album);
    const groups = dupeGroups();
    const group = groups.find(g => g.key === btn.closest('.dup-group')?.dataset.key);
    const id = btn.closest('.dup-tile')?.dataset.id;
    if (action === 'open' && id) openLightbox(id);
    else if (action === 'keep' && group && id) { dupeKeep.set(group.key, id); dupeChoice.delete(id); renderDupes(); }
    else if (action === 'remove' && group) {
      const ids = group.others.filter(o => o.remove).map(o => o.img.id);
      removeCopies(group.keep.id, ids);
    } else if (action === 'remove-all') {
      const plan = groups.map(g => [g.keep.id, g.others.filter(o => o.remove).map(o => o.img.id)]).filter(([, ids]) => ids.length);
      const ids = plan.flatMap(([, x]) => x);
      if (!ids.length) return;
      save(`Remove ${plural(ids.length, 'duplicate photo')}`, a => { for (const [keep, x] of plan) ops.mergeAndTrash(keep, x)(a); });
      toast(`Moved ${copies(ids.length)} to the Trash. Tags and comments were kept.`, '', {
        label: 'Undo', fn: () => save(`Restore ${plural(ids.length, 'photo')}`, ops.restoreImages(ids)),
      });
    }
  });
  box.addEventListener('change', e => {
    if (e.target.dataset.d !== 'toggle') return;
    dupeChoice.set(e.target.closest('.dup-tile').dataset.id, e.target.checked);
    renderDupes();
  });
}

function showLightboxImage(img) {
  const el = $('#lbImg');
  el.classList.add('loading');
  el.alt = img.title || img.originalName || '';
  setImgSrc(el, img, 'thumb', () => {});
  loadImage(img, 'full')
    .then(src => {
      if (lbShown !== img.id) return;
      el.onerror = null;
      el.src = src;
      el.classList.remove('loading');
    })
    .catch(() => { if (lbShown === img.id) el.classList.remove('loading'); });
  // Warm up the next photo so arrowing through is instant.
  const list = currentList();
  const next = list[list.findIndex(i => i.id === img.id) + 1];
  if (next) loadImage(next, 'full').catch(() => {});
}

const colorFor = s => `hsl(${[...(s || '?')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)} 52% 46%)`;
const initial = s => (s || '?').trim().charAt(0).toUpperCase() || '?';

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderComments(img) {
  const editable = canEdit() && !img.trashedAt;
  const key = JSON.stringify([img.comments, editingComment, editable]);
  if (key === commentsKey) return;
  commentsKey = key;
  $('#lbCount').textContent = img.comments.length ? `(${img.comments.length})` : '';
  const ul = $('#lbComments');
  const draft = ul.querySelector('.comment-edit textarea')?.value;

  if (!img.comments.length) {
    ul.innerHTML = `<li class="none">${editable ? 'No comments yet. Write the first one below.' : 'No comments yet.'}</li>`;
    return;
  }
  ul.innerHTML = img.comments.map(c => {
    const editing = editingComment === c.id;
    const tools = editable && !editing
      ? '<span class="comment-tools"><button type="button" data-act="edit">Edit</button><button type="button" data-act="delete">Delete</button></span>'
      : '';
    const body = editing
      ? `<div class="comment-edit"><textarea rows="3" aria-label="Edit comment">${esc(c.text)}</textarea><div><button type="button" class="btn ghost sm" data-act="cancel">Cancel</button><button type="button" class="btn primary sm" data-act="save">Save</button></div></div>`
      : `<p class="comment-text">${esc(c.text)}</p>`;
    return `<li class="comment" data-id="${esc(c.id)}">
      <div class="comment-head">
        <span class="avatar" style="background:${colorFor(c.author)}">${esc(initial(c.author))}</span>
        <strong>${esc(c.author || 'Someone')}</strong>
        <time datetime="${esc(c.at)}" title="${esc(new Date(c.at).toLocaleString())}">${esc(timeAgo(c.at))}${c.editedAt ? ' · edited' : ''}</time>
        ${tools}
      </div>${body}</li>`;
  }).join('');

  const ta = ul.querySelector('.comment-edit textarea');
  if (ta) {
    if (draft !== undefined) ta.value = draft;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
}

// ---- navigation (URL hash keeps the folder, tag filters and open photo) -------

function hashUrl() {
  const p = new URLSearchParams();
  if (state.view !== 'all') p.set('view', state.view);
  if (boardMode()) p.set('mode', 'board');
  if (state.tags.length) p.set('tags', state.tags.join(','));
  if (state.lightbox) p.set('img', state.lightbox);
  const s = p.toString();
  return location.pathname + location.search + (s ? `#${s}` : '');
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return {
    view: p.get('view') || 'all',
    mode: p.get('mode') === 'board' ? 'board' : null,
    img: p.get('img'),
    key: p.get('key'),
    tags: (p.get('tags') || '').split(',').map(normTag).filter(Boolean),
  };
}

function openLightbox(id) {
  state.lightbox = id;
  history.pushState({ lb: true }, '', hashUrl());
  renderLightbox();
}

function closeLightbox() {
  if (history.state?.lb) { history.back(); return; } // popstate re-renders
  state.lightbox = null;
  history.replaceState(null, '', hashUrl());
  renderLightbox();
}

function step(dir) {
  const list = currentList();
  const next = list[list.findIndex(i => i.id === state.lightbox) + dir];
  if (!next) return;
  state.lightbox = next.id;
  history.replaceState(history.state, '', hashUrl());
  renderLightbox();
}

function setView(view) {
  if (state.view !== view) {
    state.view = view;
    state.limit = CONFIG.pageSize;
    state.selected.clear();
    state.mode = isFolderView(view) ? prefs.raw(modeKey(view)) || 'grid' : 'grid';
    window.scrollTo(0, 0);
  }
  history.replaceState(history.state, '', hashUrl());
  $('#app').classList.remove('nav-open');
  renderAll();
  if (view === 'vault') vault.open();
}

function setTags(tags) {
  state.tags = [...new Set(tags)];
  state.limit = CONFIG.pageSize;
  history.replaceState(history.state, '', hashUrl());
  window.scrollTo(0, 0);
  renderAll();
}

// Clicking a tag on a photo shows every photo with that tag.
let afterBack = null;
function filterByTag(tag) {
  const apply = () => {
    state.view = 'all';
    state.tags = [tag];
    state.limit = CONFIG.pageSize;
    state.selected.clear();
    history.replaceState(history.state, '', hashUrl());
    window.scrollTo(0, 0);
    renderAll();
  };
  if (history.state?.lb) {
    afterBack = apply; // close the lightbox via Back first, then filter
    history.back();
  } else {
    state.lightbox = null;
    apply();
  }
}

function siteUrl() {
  if (location.hostname.endsWith('.github.io')) return location.origin + location.pathname.replace(/index\.html$/, '');
  return `https://${repo.owner.toLowerCase()}.github.io/${repo.repo}/`;
}

// ---- actions ------------------------------------------------------------------

// Big uploads go in small batches: each batch of photos is its own commit, so
// photos appear (and are safe) as they go, and one hiccup can't lose the rest.
const BATCH = 8;

async function prepareImage(file, folder) {
  const out = await processFile(file);
  const rec = {
    id: uid('i'), folder, title: '', w: out.w, h: out.h,
    bytes: out.full.size, thumbBytes: out.thumb.size, ext: out.ext, thumbExt: out.thumbExt,
    originalName: file.name || 'Pasted image', addedAt: new Date().toISOString(), addedBy: myName(),
    tags: [], comments: [], trashedAt: null,
  };
  const paths = imagePaths(rec);
  localUrls.set(rec.id, { full: URL.createObjectURL(out.full), thumb: URL.createObjectURL(out.thumb) });
  return {
    rec, thumb: out.thumb,
    files: [{ path: paths.full, blob: out.full }, { path: paths.thumb, blob: out.thumb }],
    note: out.full === file ? formatBytes(file.size) : `${formatBytes(file.size)} → ${formatBytes(out.full.size)}`,
  };
}

async function addFiles(fileList, folderOverride, { onAdded } = {}) {
  const all = [...fileList];
  const files = all.filter(isImageFile);
  if (!files.length) {
    if (all.length) toast('Only image files can be added. (Procreate and other drawing files go in Drawings.)', 'error');
    return;
  }
  if (!requireKey()) return;
  const folder = folderOverride !== undefined ? folderOverride : isFolderView(state.view) ? state.view : null;
  const panel = uploadPanel(files.map(f => f.name || 'Pasted image'), 'photo');
  const inflight = [];

  for (let start = 0; start < files.length; start += BATCH) {
    const batch = [];
    for (let i = start; i < Math.min(start + BATCH, files.length); i++) {
      panel.update(i, 'Shrinking…');
      try {
        const item = await prepareImage(files[i], folder);
        batch.push({ ...item, row: i });
        panel.update(i, `${item.note} · waiting`);
      } catch (e) {
        panel.fail(i, e.message || 'Could not read this image.');
      }
    }
    if (!batch.length) continue;
    // Keep at most two batches waiting, so memory stays low on huge uploads.
    if (inflight.length >= 2) await inflight.shift();
    inflight.push(uploadBatch(batch, panel).then(ok => { if (ok) onAdded?.(batch.map(b => b.rec)); }));
    for (const b of batch) smart.add(b.rec.id, b.thumb); // suggestions are ready by the time it's uploaded
  }
  await Promise.all(inflight);
  panel.finish();
}

async function uploadBatch(batch, panel) {
  for (const b of batch) panel.update(b.row, 'Uploading…');
  const ok = await save(`Add ${plural(batch.length, 'photo')}`, ops.addImages(batch.map(b => b.rec)), {
    files: batch.flatMap(b => b.files),
    onProgress: (done, total) => panel.partial(batch.map(b => b.row), done / Math.max(1, total)),
  });
  for (const b of batch) {
    if (ok) panel.done(b.row, `${b.note} · saved`);
    else panel.fail(b.row, 'Not saved', () => uploadBatch([b], panel));
  }
  return ok;
}

// The progress panel for uploads (photos and drawings). Rows that fail get a
// "Retry failed" button instead of making you start over.
let activeUploads = 0;
function uploadPanel(names, noun) {
  const panel = $('#uploadPanel');
  const list = $('#uploadList');
  clearTimeout(panel.hideTimer);
  if (!activeUploads) list.replaceChildren();
  activeUploads++;
  panel.hidden = false;
  const total = names.length;
  const saved = new Set();
  const failed = new Map(); // row -> retry fn
  const partial = new Map();
  const rows = names.map(name => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="fname"></span><span class="fstate">Waiting</span>';
    li.firstChild.textContent = name;
    return li;
  });
  list.append(...rows);
  const retryBtn = $('#uploadRetry');
  const refresh = () => {
    const p = (saved.size + [...partial.values()].reduce((a, b) => a + b, 0)) / total;
    $('#uploadBar').style.width = `${Math.round(Math.min(1, p) * 100)}%`;
    $('#uploadTitle').textContent = finished
      ? (failed.size ? `Saved ${saved.size} of ${plural(total, noun)}. ${failed.size} failed` : `Added ${plural(saved.size, noun)}`)
      : `Uploading… ${saved.size} of ${plural(total, noun)} saved`;
    retryBtn.hidden = !finished || !failed.size;
  };
  let finished = false;
  const set = (i, text, cls = '') => {
    rows[i].className = cls;
    rows[i].lastChild.textContent = text;
    rows[i].lastChild.title = text;
  };
  retryBtn.onclick = async () => {
    const jobs = [...failed.values()];
    failed.clear();
    finished = false;
    refresh();
    for (const job of jobs) await job?.();
    finished = true;
    refresh();
  };
  refresh();
  return {
    update(i, text) { set(i, text); },
    partial(idx, p) { for (const i of idx) partial.set(i, p); refresh(); },
    done(i, text) { partial.delete(i); failed.delete(i); saved.add(i); set(i, text, 'ok'); refresh(); },
    fail(i, text, retry) { partial.delete(i); if (retry) failed.set(i, retry); set(i, text, 'error'); refresh(); },
    finish() {
      activeUploads--;
      finished = true;
      refresh();
      if (!failed.size && !activeUploads && !rows.some(r => r.className === 'error')) panel.hideTimer = setTimeout(() => { panel.hidden = true; }, 4000);
    },
  };
}

async function moveTo(ids, value) {
  if (!ids.length || !value) return;
  if (value === NEW_FOLDER) {
    const name = await askFolderName('New folder');
    if (!name) { renderAll(); return; }
    const id = uid('f');
    return save(`Create folder "${name}" and move ${plural(ids.length, 'photo')}`, a => {
      ops.addFolder(id, name)(a);
      ops.moveImages(ids, id)(a);
    });
  }
  const folder = value === UNSORTED ? null : value;
  return save(`Move ${plural(ids.length, 'photo')} to ${folder ? folderName(folder) : 'Unsorted'}`, ops.moveImages(ids, folder));
}

// Delete = move to the Trash (can be undone).
function trashImages(ids) {
  if (!ids.length) return;
  save(`Move ${plural(ids.length, 'photo')} to the Trash`, ops.trashImages(ids));
  toast(`Moved ${plural(ids.length, 'photo')} to the Trash`, '', {
    label: 'Undo',
    fn: () => save(`Restore ${plural(ids.length, 'photo')}`, ops.restoreImages(ids)),
  });
}

function restoreImages(ids) {
  if (!ids.length) return;
  save(`Restore ${plural(ids.length, 'photo')} from the Trash`, ops.restoreImages(ids));
  toast(`Restored ${plural(ids.length, 'photo')}`);
}

// Delete for good AND free the space: remove the files, then replace GitHub's
// history with a single snapshot so the old copies stop counting.
async function purge(ids) {
  const imgs = ids.map(findImage).filter(Boolean);
  if (!imgs.length || !requireKey()) return false;
  const bytes = imgs.reduce((s, i) => s + (i.bytes || 0) + (i.thumbBytes || 0), 0);
  const all = imgs.length === trashedIds().length;
  const ok = await ask({
    title: all ? 'Empty the Trash?' : `Delete ${plural(imgs.length, 'photo')} forever?`,
    text: `${plural(imgs.length, 'photo')} (${formatBytes(bytes)}) will be deleted for good. To actually free the space, GitHub’s old version history is cleared too. Your other photos, folders, tags and comments all stay. This can’t be undone.`,
    input: false, ok: 'Delete and free space', danger: true,
  });
  if (!ok) return false;
  const deleted = await save(`Delete ${plural(imgs.length, 'photo')} from the Trash`, ops.deleteImages(imgs.map(i => i.id)));
  if (!deleted) return false;
  await exclusive(async () => {
    setStatus('saving', 'Freeing up space…');
    try {
      await gh.compactHistory('Album snapshot: cleared old history to free up space');
      setStatus('saved');
      toast('Deleted for good. GitHub releases the space during its regular cleanup, so the repo meter can take a while to go down.');
    } catch (e) {
      setStatus('error');
      toast(`The photos were deleted, but clearing the old history failed: ${e.message}`, 'error');
    }
  });
  loadRepoSize();
  return true;
}

async function deleteSelected() {
  const ids = currentList().filter(i => state.selected.has(i.id)).map(i => i.id);
  if (!ids.length) return;
  if (state.view === 'trash') {
    if (!(await purge(ids))) return;
  } else {
    trashImages(ids);
  }
  state.selected.clear();
  state.selecting = false;
  renderAll();
}

function askFolderName(title, value = '') {
  return ask({ title, value, placeholder: 'Folder name', ok: value ? 'Rename' : 'Create' });
}

async function newFolder() {
  if (!requireKey()) return;
  const name = await askFolderName('New folder');
  if (!name) return;
  const id = uid('f');
  save(`Create folder "${name}"`, ops.addFolder(id, name));
  setView(id);
}

function addTags(ids, raw) {
  const tags = String(raw).split(',').map(normTag).filter(Boolean);
  if (!tags.length || !ids.length) return;
  save(`Tag ${plural(ids.length, 'photo')}: ${tags.join(', ')}`, ops.addTags(ids, tags));
}

function fileNameFor(img) {
  const base = (img.title || (img.originalName || '').replace(/\.[^.]+$/, '') || img.id).replace(/[\\/:*?"<>|]+/g, '_').trim();
  return `${base || img.id}.${img.ext}`;
}

function saveBlob(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

async function download(img) {
  if (!img) return;
  try {
    saveBlob(await fetchImageBlob(img, 'full'), fileNameFor(img));
  } catch {
    toast('Download failed. Check your connection and try again.', 'error');
  }
}

// Several photos at once: bundled into one .zip file.
async function downloadMany(ids) {
  const imgs = ids.map(findImage).filter(Boolean);
  if (imgs.length < 2) return download(imgs[0]);
  const { makeZip, uniqueNames } = await import('./zip.js');
  const names = uniqueNames(imgs.map(fileNameFor));
  const note = toast(`Preparing download… 0 of ${imgs.length}`, '', null, { sticky: true });
  const blobs = new Array(imgs.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < imgs.length) {
      const i = next++;
      try { blobs[i] = await fetchImageBlob(imgs[i], 'full'); } catch {}
      note.textContent = `Preparing download… ${++done} of ${imgs.length}`;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const files = imgs.map((_, i) => ({ name: names[i], blob: blobs[i] })).filter(f => f.blob);
  note.remove();
  if (!files.length) return toast('Download failed. Check your connection and try again.', 'error');
  const label = { all: 'Artist Album', unsorted: 'Unsorted', trash: 'Trash' }[state.view] || folderName(state.view) || 'Artist Album';
  saveBlob(await makeZip(files), `${label.replace(/[\\/:*?"<>|]+/g, '_')} (${plural(files.length, 'photo')}).zip`);
  const missed = imgs.length - files.length;
  toast(missed ? `Downloaded ${plural(files.length, 'photo')}; ${missed} could not be fetched.` : `Downloaded ${plural(files.length, 'photo')} as a ZIP file.`, missed ? 'error' : '');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

// ---- small UI helpers ---------------------------------------------------------

function toast(msg, type = '', action, { sticky = false, duration } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  if (action) {
    const btn = Object.assign(document.createElement('button'), { className: 'toast-action', textContent: action.label });
    btn.onclick = () => { el.remove(); action.fn(); };
    el.append(btn);
  }
  $('#toasts').append(el);
  if (!sticky) setTimeout(() => el.remove(), duration || (type === 'error' ? 8000 : action ? 7000 : 3500));
  return el;
}

let statusTimer;
function setStatus(s, text) {
  const el = $('#saveStatus');
  clearTimeout(statusTimer);
  el.dataset.state = s;
  el.textContent = text || { saving: 'Saving…', retrying: 'Merging with another edit…', saved: 'Saved', error: 'Not saved' }[s] || '';
  if (s === 'saved') statusTimer = setTimeout(() => { el.textContent = ''; el.dataset.state = ''; }, 2500);
}

function ask({ title, text = '', value = '', placeholder = '', ok = 'OK', input = true, danger = false }) {
  const d = $('#askDialog');
  const field = $('#askInput');
  const okBtn = $('#askOk');
  $('#askTitle').textContent = title;
  $('#askText').textContent = text;
  $('#askText').hidden = !text;
  field.hidden = !input;
  field.value = value;
  field.placeholder = placeholder;
  okBtn.textContent = ok;
  okBtn.className = `btn ${danger ? 'danger' : 'primary'}`;
  d.returnValue = '';
  d.showModal();
  if (input) { field.focus(); field.select(); } else okBtn.focus();
  return new Promise(resolve => {
    d.addEventListener('close', () => {
      if (d.returnValue !== 'ok') return resolve(null);
      resolve(input ? field.value.trim() || null : true);
    }, { once: true });
  });
}

function setSettingsMsg(text, type = '') {
  const el = $('#settingsMsg');
  el.textContent = text;
  el.className = `form-msg ${type}`;
}

function openSettings(msg = '') {
  const d = $('#settings');
  $('#setName').value = prefs.get('name');
  $('#setToken').value = '';
  $('#setToken').placeholder = canEdit() ? 'Key saved. Paste a new one to replace it' : 'github_pat_…';
  const ks = $('#keyState');
  ks.classList.toggle('on', canEdit());
  ks.textContent = canEdit()
    ? `Editing is unlocked in this browser${prefs.get('login') ? ` (GitHub account: ${prefs.get('login')})` : ''}.`
    : 'This browser can only view the album.';
  $('#forgetKey').hidden = !canEdit();
  $('#copyInvite').disabled = !canEdit();
  renderSettingsAI();
  setSettingsMsg(msg);
  if (!d.open) d.showModal();
}

// ---- events -------------------------------------------------------------------

let dragIds = [];
let dragFolder = null;
const dragHas = (e, type) => [...(e.dataTransfer?.types || [])].includes(type);

function clearDragMarks() {
  for (const el of document.querySelectorAll('.dragging, .drop-before, .drop-after, .drop-target, .drop-end'))
    el.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-target', 'drop-end');
  dragIds = [];
  dragFolder = null;
}

function markOnly(el, cls) {
  for (const other of document.querySelectorAll(`.${cls}`)) if (other !== el) other.classList.remove(cls);
  el?.classList.add(cls);
}

// Index-based "drop before" target: dropping on the right half of a card means after it.
function dropBeforeId(card, e) {
  const after = e.clientX > card.getBoundingClientRect().left + card.offsetWidth / 2;
  if (!after) return card.dataset.id;
  const imgs = state.album.images.filter(i => !dragIds.includes(i.id));
  return imgs[imgs.findIndex(i => i.id === card.dataset.id) + 1]?.id ?? null;
}

function bindGrid() {
  const grid = $('#grid');

  grid.addEventListener('click', e => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.closest('.card-dl')) return download(findImage(id));
    const selecting = e.target.closest('.card-check') || state.selecting || state.selected.size || e.shiftKey || e.metaKey || e.ctrlKey;
    if (selecting && canEdit()) {
      state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
      renderAll();
    } else {
      openLightbox(id);
    }
  });
  grid.addEventListener('keydown', e => {
    const card = e.target.closest('.card');
    if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openLightbox(card.dataset.id); }
  });

  grid.addEventListener('dragstart', e => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    dragIds = state.selected.has(id) ? state.album.images.filter(i => state.selected.has(i.id)).map(i => i.id) : [id];
    e.dataTransfer.setData(IMG_DRAG, dragIds.join(','));
    e.dataTransfer.effectAllowed = 'move';
    for (const i of dragIds) cards.get(i)?.classList.add('dragging');
  });
  grid.addEventListener('dragend', clearDragMarks);
  grid.addEventListener('dragover', e => {
    if (!dragHas(e, IMG_DRAG) || state.view === 'trash') return;
    const card = e.target.closest('.card');
    if (!card || dragIds.includes(card.dataset.id)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const before = dropBeforeId(card, e) === card.dataset.id;
    markOnly(before ? card : null, 'drop-before');
    markOnly(before ? null : card, 'drop-after');
  });
  grid.addEventListener('drop', e => {
    if (!dragHas(e, IMG_DRAG) || state.view === 'trash') return;
    const card = e.target.closest('.card');
    if (!card || dragIds.includes(card.dataset.id)) return;
    e.preventDefault();
    const ids = dragIds;
    const beforeId = dropBeforeId(card, e);
    clearDragMarks();
    save(`Reorder ${plural(ids.length, 'photo')}`, ops.reorderImages(ids, beforeId));
  });
}

function bindSidebar() {
  const sidebar = $('#sidebar');

  sidebar.addEventListener('click', e => {
    const item = e.target.closest('.nav-item');
    if (item) setView(item.dataset.view);
  });

  sidebar.addEventListener('dragstart', e => {
    const btn = e.target.closest('.nav-item.folder');
    if (!btn) return;
    dragFolder = btn.dataset.view;
    e.dataTransfer.setData(FOLDER_DRAG, dragFolder);
    e.dataTransfer.effectAllowed = 'move';
    btn.classList.add('dragging');
  });
  sidebar.addEventListener('dragend', clearDragMarks);
  sidebar.addEventListener('dragover', e => {
    const item = e.target.closest('.nav-item');
    if (dragHas(e, IMG_DRAG)) {
      if (!item || item.dataset.view === 'all' || item.dataset.view === 'vault') return markOnly(null, 'drop-target');
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      markOnly(item, 'drop-target');
    } else if (dragHas(e, FOLDER_DRAG) && e.target.closest('#folderList')) {
      e.preventDefault();
      const onFolder = item?.classList.contains('folder') && item.dataset.view !== dragFolder;
      markOnly(onFolder ? item : null, 'drop-target');
      markOnly(item ? null : $('#folderList'), 'drop-end');
    }
  });
  sidebar.addEventListener('dragleave', e => {
    if (!sidebar.contains(e.relatedTarget)) { markOnly(null, 'drop-target'); markOnly(null, 'drop-end'); }
  });
  sidebar.addEventListener('drop', e => {
    const item = e.target.closest('.nav-item');
    if (dragHas(e, IMG_DRAG)) {
      if (!item || item.dataset.view === 'all' || item.dataset.view === 'vault') return;
      e.preventDefault();
      const ids = dragIds;
      const target = item.dataset.view;
      clearDragMarks();
      state.selected.clear();
      if (target === 'trash') trashImages(ids);
      else {
        if (state.view === 'trash') save(`Restore ${plural(ids.length, 'photo')}`, ops.restoreImages(ids));
        moveTo(ids, target === 'unsorted' ? UNSORTED : target);
      }
    } else if (dragHas(e, FOLDER_DRAG) && e.target.closest('#folderList')) {
      e.preventDefault();
      const id = dragFolder;
      const before = item?.classList.contains('folder') ? item.dataset.view : null;
      clearDragMarks();
      if (id && before !== id) save('Reorder folders', ops.moveFolder(id, before));
    }
  });

  $('#newFolderBtn').addEventListener('click', e => { e.stopPropagation(); newFolder(); });
  $('#accessBtn').addEventListener('click', () => openSettings());
  $('#menuBtn').addEventListener('click', () => $('#app').classList.toggle('nav-open'));
  $('#scrim').addEventListener('click', () => $('#app').classList.remove('nav-open'));
}

// Files dragged in from the computer. Dropping on a sidebar folder adds them there.
function bindFileDrop() {
  let depth = 0;
  const hasFiles = e => dragHas(e, 'Files');
  const overlay = $('#dropOverlay');
  const toVault = e => {
    const item = e.target.closest?.('.nav-item');
    return item ? item.dataset.view === 'vault' : state.view === 'vault';
  };
  const targetFolder = e => {
    const item = e.target.closest?.('.nav-item');
    if (!item || ['all', 'trash', 'vault'].includes(item.dataset.view)) return undefined;
    return item.dataset.view === 'unsorted' ? null : item.dataset.view;
  };
  const hide = () => { depth = 0; overlay.hidden = true; markOnly(null, 'drop-target'); };

  window.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const t = targetFolder(e);
    const folder = t !== undefined ? t : isFolderView(state.view) ? state.view : null;
    $('#dropTarget').textContent = toVault(e) ? 'Drawings (private)' : folder ? folderName(folder) : 'Unsorted';
    markOnly(t !== undefined || e.target.closest?.('.nav-item')?.dataset.view === 'vault' ? e.target.closest('.nav-item') : null, 'drop-target');
  });
  window.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    if (--depth <= 0 || !e.relatedTarget) hide();
  });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const folder = targetFolder(e);
    const vaultDrop = toVault(e);
    hide();
    if (!vaultDrop) {
      if (folder === undefined && boardMode()) {
        const point = moodboard.toWorld(e.clientX, e.clientY);
        let placed = 0;
        return addFiles(e.dataTransfer.files, undefined, {
          onAdded: recs => { moodboard.placeAt(recs, point, placed); placed += recs.length; },
        });
      }
      return addFiles(e.dataTransfer.files, folder);
    }
    if (!requireKey()) return;
    if (state.view !== 'vault') setView('vault');
    vault.open().then(() => vault.upload(e.dataTransfer.files));
  });

  document.addEventListener('paste', e => {
    if (e.target.closest?.('input, textarea') || state.view === 'vault') return;
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });
}

function bindBoard() {
  const pick = () => { if (requireKey()) $(state.view === 'vault' ? '#vaultInput' : '#fileInput').click(); };
  $('#vaultInput').addEventListener('change', e => {
    vault.upload(e.target.files);
    e.target.value = '';
  });
  vault.bind($('#vaultView'), () => $('#vaultInput').click());
  $('#addBtn').addEventListener('click', pick);
  $('#empty').addEventListener('click', e => { if (e.target.closest('[data-action="add"]')) pick(); });
  $('#fileInput').addEventListener('change', e => {
    addFiles(e.target.files);
    e.target.value = '';
  });
  $('#search').addEventListener('input', e => {
    state.query = e.target.value;
    state.limit = CONFIG.pageSize;
    renderAll();
  });
  $('#selectBtn').addEventListener('click', () => {
    state.selecting = !state.selecting;
    if (!state.selecting) state.selected.clear();
    renderAll();
  });
  $('#renameFolderBtn').addEventListener('click', async () => {
    const id = state.view;
    const name = await askFolderName('Rename folder', folderName(id));
    if (name && name !== folderName(id)) save(`Rename folder to "${name}"`, ops.renameFolder(id, name));
  });
  $('#deleteFolderBtn').addEventListener('click', async () => {
    const id = state.view;
    const n = folderCounts(state.album)[id] || 0;
    const ok = await ask({
      title: `Delete “${folderName(id)}”?`,
      text: n ? `Its ${plural(n, 'photo')} will move to Unsorted. No photos are deleted.` : 'The folder is empty.',
      input: false, ok: 'Delete folder', danger: true,
    });
    if (!ok) return;
    save(`Delete folder "${folderName(id)}"`, ops.deleteFolder(id));
    setView('all');
  });
  $('#emptyTrashBtn').addEventListener('click', () => purge(trashedIds()));
  $('#modeToggle').addEventListener('click', e => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    state.mode = b.dataset.mode;
    try { localStorage.setItem(modeKey(state.view), state.mode); } catch {}
    history.replaceState(history.state, '', hashUrl());
    renderAll();
  });
  bindDupes();
  $('#uploadClose').addEventListener('click', () => { $('#uploadPanel').hidden = true; });

  $('#tagChips').addEventListener('click', e => {
    if (e.target.closest('[data-clear-tags]')) return setTags([]);
    const chip = e.target.closest('[data-tag]');
    if (!chip) return;
    const t = chip.dataset.tag;
    setTags(state.tags.includes(t) ? state.tags.filter(x => x !== t) : [...state.tags, t]);
  });

  $('#suggestPanel').addEventListener('click', e => {
    if (e.target.closest('[data-ai-on]')) return smart.enable(state.album);
    if (e.target.closest('[data-ai-retry]')) return smart.start(state.album);
    if (e.target.closest('[data-ai-hide]')) { prefs.set('promo', 'hidden'); return renderSuggestions(); }
    if (e.target.closest('[data-ai-collapse]')) {
      if (!smart.enabled) { prefs.set('promo', 'hidden'); return renderSuggestions(); }
      prefs.set('collapsed', prefs.get('collapsed') === '1' ? '' : '1');
      return renderSuggestions();
    }
    if (e.target.closest('.suggest-head')) {
      if (prefs.get('collapsed') === '1') { prefs.set('collapsed', ''); renderSuggestions(); }
      return;
    }
    const row = e.target.closest('.sg');
    const group = row && lastGroups.get(row.dataset.key);
    if (!group) return;
    const thumb = e.target.closest('.sg-thumb');
    if (e.target.closest('[data-exclude]')) dismiss(group.key, [thumb.dataset.id]);
    else if (thumb) openLightbox(thumb.dataset.id);
    else if (e.target.closest('[data-accept]')) acceptSuggestion(group);
    else if (e.target.closest('[data-dismiss]')) dismiss(group.key, group.ids);
  });

  $('#selMove').addEventListener('change', async e => {
    const value = e.target.value;
    e.target.value = '';
    const ids = currentList().filter(i => state.selected.has(i.id)).map(i => i.id);
    state.selected.clear();
    state.selecting = false;
    await moveTo(ids, value);
    renderAll();
  });
  $('#selTag').addEventListener('click', async () => {
    const ids = currentList().filter(i => state.selected.has(i.id)).map(i => i.id);
    const tag = await ask({ title: `Tag ${plural(ids.length, 'photo')}`, text: 'Separate several tags with commas.', placeholder: 'e.g. sketch, character', ok: 'Add tag' });
    if (tag) addTags(ids, tag);
  });
  $('#selRestore').addEventListener('click', () => {
    restoreImages(currentList().filter(i => state.selected.has(i.id)).map(i => i.id));
    state.selected.clear();
    state.selecting = false;
    renderAll();
  });
  $('#selDelete').addEventListener('click', deleteSelected);
  $('#selAll').addEventListener('click', () => {
    for (const img of currentList()) state.selected.add(img.id);
    state.selecting = true;
    renderAll();
  });
  $('#selDownload').addEventListener('click', () => downloadMany(currentList().filter(i => state.selected.has(i.id)).map(i => i.id)));
  $('#selClear').addEventListener('click', () => {
    state.selected.clear();
    state.selecting = false;
    renderAll();
  });
}

function bindLightbox() {
  const stage = $('#lbStage');
  stage.addEventListener('click', e => { if (e.target === stage) closeLightbox(); });
  $('#lbClose').addEventListener('click', closeLightbox);
  $('#lbPrev').addEventListener('click', () => step(-1));
  $('#lbNext').addEventListener('click', () => step(1));

  let touchX = null;
  stage.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', e => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
  });

  const title = $('#lbTitle');
  title.addEventListener('change', () => {
    const img = findImage(state.lightbox);
    if (!img || !canEdit()) return;
    const value = title.value.trim();
    if (value !== (img.title || '')) save('Rename a photo', ops.setTitle(img.id, value));
  });
  title.addEventListener('keydown', e => {
    if (e.key === 'Enter') title.blur();
    if (e.key === 'Escape') title.value = findImage(state.lightbox)?.title || '';
  });

  $('#lbFolder').addEventListener('change', e => moveTo([state.lightbox], e.target.value));
  $('#lbDownload').addEventListener('click', () => { const img = findImage(state.lightbox); if (img) download(img); });
  $('#lbLink').addEventListener('click', async () => {
    await copyText(`${siteUrl()}#img=${encodeURIComponent(state.lightbox)}`);
    toast('Link to this photo copied.');
  });
  $('#lbRestore').addEventListener('click', () => restoreImages([state.lightbox]));
  $('#lbDelete').addEventListener('click', async () => {
    const id = state.lightbox;
    const img = findImage(id);
    if (!img) return;
    if (img.trashedAt) {
      if (await purge([id])) closeLightbox();
      return;
    }
    const list = currentList();
    const idx = list.findIndex(i => i.id === id);
    const neighbour = list[idx + 1] || list[idx - 1];
    if (neighbour) {
      state.lightbox = neighbour.id;
      history.replaceState(history.state, '', hashUrl());
    } else {
      closeLightbox();
    }
    trashImages([id]);
  });

  // Tags
  const tagInput = $('#tagInput');
  const commitTagInput = () => {
    if (tagInput.value.trim() && state.lightbox) addTags([state.lightbox], tagInput.value);
    tagInput.value = '';
  };
  tagInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitTagInput(); }
  });
  tagInput.addEventListener('change', commitTagInput);
  $('#lbTags').addEventListener('click', e => {
    const untag = e.target.closest('[data-untag]');
    if (untag) return save(`Remove tag "${untag.dataset.untag}"`, ops.removeTag([state.lightbox], untag.dataset.untag));
    const filter = e.target.closest('[data-filter-tag]');
    if (filter) filterByTag(filter.dataset.filterTag);
  });
  $('#lbSimilar').addEventListener('click', e => {
    const img = findImage(state.lightbox);
    if (!img) return;
    if (e.target.closest('[data-sim="ai-on"]')) return smart.enable(state.album);
    if (e.target.closest('[data-sim="merge"]')) {
      const ids = (smart.similar(img, state.album) || []).filter(s => s.score >= smart.lib.DUPLICATE).map(s => s.img.id);
      return removeCopies(img.id, ids);
    }
    const tile = e.target.closest('.sim');
    if (!tile) return;
    if (e.target.closest('[data-sim="trash"]')) return trashImages([tile.dataset.id]);
    state.lightbox = tile.dataset.id;
    history.replaceState(history.state, '', hashUrl());
    renderLightbox();
  });
  $('#lbSuggest').addEventListener('click', e => {
    if (e.target.closest('[data-ai-on]')) return smart.enable(state.album);
    if (e.target.closest('[data-ai-retry]')) return smart.start(state.album);
    const stag = e.target.closest('[data-stag]');
    if (stag) return addTags([state.lightbox], stag.dataset.stag);
    const sfolder = e.target.closest('[data-sfolder]');
    const group = sfolder && lastGroups.get(sfolder.dataset.sfolder);
    if (group) acceptSuggestion(group, [state.lightbox]);
  });

  // Comments
  $('#commentForm').addEventListener('submit', async e => {
    e.preventDefault();
    const text = $('#commentText').value.trim();
    const imgId = state.lightbox;
    if (!text || !imgId) return;
    if (!myName()) {
      const name = await ask({ title: 'What is your name?', text: 'It is shown next to your comments.', placeholder: 'Your name', ok: 'Continue' });
      if (!name) return;
      prefs.set('name', name);
    }
    $('#commentText').value = '';
    save('Comment on a photo', ops.addComment(imgId, { id: uid('c'), author: myName(), text, at: new Date().toISOString(), editedAt: null }));
  });
  $('#commentText').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#commentForm').requestSubmit();
  });

  $('#lbComments').addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const li = btn.closest('.comment');
    const imgId = state.lightbox;
    const cid = li.dataset.id;
    const act = btn.dataset.act;
    if (act === 'edit' || act === 'cancel') {
      editingComment = act === 'edit' ? cid : null;
      commentsKey = '';
      if (act === 'cancel') li.querySelector('textarea').value = findImage(imgId)?.comments.find(c => c.id === cid)?.text ?? '';
      renderLightbox();
    } else if (act === 'save') {
      const text = li.querySelector('textarea').value.trim();
      if (!text) return;
      editingComment = null;
      li.querySelector('textarea').value = text;
      save('Edit a comment', ops.editComment(imgId, cid, text));
    } else if (act === 'delete') {
      const ok = await ask({ title: 'Delete this comment?', input: false, ok: 'Delete', danger: true });
      if (ok) save('Delete a comment', ops.deleteComment(imgId, cid));
    }
  });
  $('#lbComments').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.matches('.comment-edit textarea'))
      e.target.closest('.comment').querySelector('[data-act="save"]').click();
  });

  document.addEventListener('click', e => {
    if (e.target.closest('[data-open-settings]')) openSettings();
  });
}

function bindSettings() {
  $('#tokenLink').href = 'https://github.com/settings/personal-access-tokens/new?' + new URLSearchParams({
    name: 'Artist Album', description: `Edit access for ${repo.owner}/${repo.repo}`,
    target_name: repo.owner, expires_in: '365', contents: 'write',
  });
  $('#repoName').textContent = `${repo.owner}/${repo.repo}`;

  $('#saveKey').addEventListener('click', async () => {
    const name = $('#setName').value.trim();
    const token = $('#setToken').value.trim();
    prefs.set('name', name);
    if (!token) {
      commentsKey = '';
      renderAll();
      $('#settings').close();
      return;
    }
    setSettingsMsg('Checking the key with GitHub…');
    try {
      const { canPush, login } = await new GitHubStore(repo, token).verify();
      if (!canPush) throw new Error('This key works, but its GitHub account cannot edit this album.');
      gh.token = token;
      prefs.set('token', token);
      prefs.set('login', login);
      setSettingsMsg('Key saved. Editing is unlocked.', 'ok');
      vault.status = 'idle';
      if (state.view === 'vault') vault.open();
      commentsKey = '';
      if (smart.enabled) smart.start(state.album);
      renderAll();
      setTimeout(() => $('#settings').close(), 800);
    } catch (e) {
      setSettingsMsg(e.message, 'error');
    }
  });
  $('#forgetKey').addEventListener('click', () => {
    gh.token = '';
    prefs.set('token', '');
    prefs.set('login', '');
    vault.lockNow();
    vault.status = 'idle';
    state.selecting = false;
    state.selected.clear();
    commentsKey = '';
    renderAll();
    openSettings('Key removed. This browser can now only view the album.');
  });
  $('#copyInvite').addEventListener('click', async () => {
    await copyText(`${siteUrl()}#key=${encodeURIComponent(gh.token)}`);
    setSettingsMsg('Invite link copied. Anyone who opens it can edit, so share it carefully.', 'ok');
  });
  $('#aiToggle').addEventListener('click', () => {
    if (smart.enabled) smart.disable();
    else smart.enable(state.album);
    renderAll();
  });
  $('#askCancel').addEventListener('click', () => $('#askDialog').close());
}

function bindGlobal() {
  document.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]')) return;
    const typing = e.target.closest?.('input, textarea, select');
    if (!$('#lightbox').hidden) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (typing) e.target.blur();
        else closeLightbox();
      } else if (!typing && e.key === 'ArrowLeft') step(-1);
      else if (!typing && e.key === 'ArrowRight') step(1);
      return;
    }
    if (typing) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (boardMode() && moodboard.key(e)) return;
    if (e.key === 'Escape' && (state.selected.size || state.selecting)) {
      state.selected.clear();
      state.selecting = false;
      renderAll();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected.size && canEdit()) {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === '/') {
      e.preventDefault();
      $('#search').focus();
    }
  });

  // Back/forward, a closed lightbox, or a link pasted into the address bar.
  window.addEventListener('popstate', () => {
    const h = readHash();
    if (afterBack) {
      const apply = afterBack;
      afterBack = null;
      state.lightbox = null;
      return apply();
    }
    if (h.view !== state.view) { state.view = h.view; state.limit = CONFIG.pageSize; }
    state.mode = h.mode || 'grid';
    state.tags = h.tags;
    state.lightbox = h.img;
    renderAll();
  });

  let lastWidth = 0;
  new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (w !== lastWidth) { lastWidth = w; renderGrid(); }
  }).observe($('#grid'));
  new IntersectionObserver(entries => {
    if (entries.some(en => en.isIntersecting)) maybeLoadMore();
  }, { rootMargin: '1200px 0px' }).observe($('#sentinel'));

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden && canEdit()) refresh(); }, 90_000);
  window.addEventListener('beforeunload', e => {
    if (pending.length || activeUploads) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ---- start ------------------------------------------------------------------------

// If the browser served an older cached page with this newer code (or the other
// way round), reload once to get matching files instead of breaking.
function versionMismatch() {
  const page = document.querySelector('meta[name="app-version"]')?.content;
  if (page === APP_VERSION) return false;
  const key = 'artist-album.reloaded-for';
  let tried = '';
  try { tried = sessionStorage.getItem(key) || ''; } catch {}
  if (tried === APP_VERSION) {
    document.body.insertAdjacentHTML('afterbegin',
      '<p style="margin:0;padding:12px 16px;background:#c0392b;color:#fff;font:15px system-ui">The site was just updated. Please refresh with Cmd+Shift+R (Ctrl+Shift+R on Windows).</p>');
    return true;
  }
  try { sessionStorage.setItem(key, APP_VERSION); } catch {}
  fetch(location.pathname, { cache: 'reload' }).catch(() => {}).finally(() => location.reload());
  return true;
}

function init() {
  if (versionMismatch()) return;
  window.addEventListener('error', e => reportError(e.error || e.message));
  window.addEventListener('unhandledrejection', e => reportError(e.reason));
  const h = readHash();
  if (h.key) {
    gh.token = h.key;
    prefs.set('token', h.key);
  }
  state.view = h.view;
  state.mode = h.mode || (isFolderView(h.view) ? prefs.raw(modeKey(h.view)) || 'grid' : 'grid');
  state.tags = h.tags;
  state.lightbox = h.img;
  history.replaceState(null, '', hashUrl()); // also strips #key= from the address bar

  bindGrid();
  bindSidebar();
  bindFileDrop();
  bindBoard();
  bindLightbox();
  bindSettings();
  bindGlobal();
  renderAll();

  load().then(() => {
    if (state.lightbox && !findImage(state.lightbox)) {
      state.lightbox = null;
      history.replaceState(null, '', hashUrl());
    }
    if (smart.enabled && canEdit()) smart.start(state.album);
    if (state.view === 'vault') vault.open();
    if (h.key) {
      gh.verify()
        .then(({ login }) => {
          prefs.set('login', login);
          toast('Editing is unlocked in this browser.');
          if (!prefs.get('name')) openSettings('Welcome! Add your name so people know who wrote each comment.');
          renderAll();
        })
        .catch(e => toast(`That invite link did not work: ${e.message}`, 'error'));
    }
  });
}

init();
