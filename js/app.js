import { CONFIG, resolveRepo } from './config.js';
import { emptyAlbum, uid, imagePaths, ops, visibleImages, folderCounts, totalBytes, layoutColumns } from './album.js';
import { GitHubStore } from './github.js';
import { processFile, isImageFile, formatBytes } from './images.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const IMG_DRAG = 'application/x-album-images';
const FOLDER_DRAG = 'application/x-album-folder';
const UNSORTED = '~unsorted';
const NEW_FOLDER = '~new';

// ---- settings kept in this browser only -------------------------------------

const KEYS = { token: 'artist-album.token', name: 'artist-album.name', login: 'artist-album.login' };
const prefs = {
  get: k => { try { return localStorage.getItem(KEYS[k]) || ''; } catch { return ''; } },
  set: (k, v) => { try { v ? localStorage.setItem(KEYS[k], v) : localStorage.removeItem(KEYS[k]); } catch {} },
};
const myName = () => prefs.get('name') || prefs.get('login');

const repo = resolveRepo();
const gh = new GitHubStore(repo, prefs.get('token'));
gh.onWait = ms => toast(`GitHub asked us to slow down. Continuing in ${Math.round(ms / 1000)} seconds…`);

// ---- state ------------------------------------------------------------------

const state = {
  server: emptyAlbum(), // last version confirmed by GitHub
  album: emptyAlbum(),  // server version + edits that are still saving
  loaded: false,
  view: 'all',          // 'all' | 'unsorted' | folder id
  query: '',
  limit: CONFIG.pageSize,
  selected: new Set(),
  selecting: false,
  lightbox: null,       // open image id
};

const pending = [];          // edits not yet confirmed by GitHub, applied on top of state.server
let saveChain = Promise.resolve();
let saveGeneration = 0;      // bumps when a save lands, so older background refreshes are dropped
let lastLoad = 0;
const localUrls = new Map(); // image id -> { full, thumb } object URLs for photos uploaded in this tab

const canEdit = () => !!gh.token;
const isFolderView = v => v !== 'all' && v !== 'unsorted';
const folderName = id => state.album.folders.find(f => f.id === id)?.name;
const findImage = id => state.album.images.find(i => i.id === id);
const currentList = () => visibleImages(state.album, state.view, state.query);

// ---- syncing with GitHub ----------------------------------------------------

function rebase() {
  const album = structuredClone(state.server);
  for (const p of pending) p.op(album, { remove: [] });
  state.album = album;
  renderAll();
}

// Applies the change on screen immediately, then commits it to GitHub.
// Saves run one at a time; each re-applies its op to the latest album.json.
function save(message, op, { files = [], onProgress } = {}) {
  if (!requireKey()) return Promise.resolve(false);
  const entry = { op };
  pending.push(entry);
  setStatus('saving');
  rebase();
  const run = async () => {
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
  };
  const result = saveChain.then(run);
  saveChain = result.catch(() => {});
  return result;
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

// ---- rendering ----------------------------------------------------------------

function renderAll() {
  if (state.loaded && isFolderView(state.view) && !folderName(state.view)) {
    state.view = 'all';
    history.replaceState(history.state, '', hashUrl());
  }
  for (const id of state.selected) if (!findImage(id)) state.selected.delete(id);
  document.body.classList.toggle('can-edit', canEdit());
  document.body.classList.toggle('selecting', canEdit() && (state.selecting || state.selected.size > 0));
  renderSidebar();
  renderHeader();
  renderGrid();
  renderSelection();
  renderLightbox();
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

const folderEls = new Map();
function renderSidebar() {
  const counts = folderCounts(state.album);
  for (const btn of document.querySelectorAll('.nav > .nav-item')) {
    btn.classList.toggle('active', btn.dataset.view === state.view);
    btn.querySelector('.count').textContent = state.loaded ? counts[btn.dataset.view] : '';
  }

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
    const cover = state.album.images.find(i => i.folder === f.id);
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
        coverEl.innerHTML = '<svg class="ic"><use href="#i-folder"/></svg>';
      }
    }
    return li;
  });
  const list = $('#folderList');
  if (items.length !== list.children.length || items.some((li, i) => list.children[i] !== li)) list.replaceChildren(...items);
  for (const id of folderEls.keys()) if (!state.album.folders.some(f => f.id === id)) folderEls.delete(id);
  $('#folderHint').hidden = !(state.loaded && canEdit() && !state.album.folders.length);

  const used = totalBytes(state.album);
  const warn = used > CONFIG.storageWarnBytes;
  $('#storageFill').style.width = `${Math.min(100, (used / CONFIG.storageLimitBytes) * 100).toFixed(1)}%`;
  $('#storage').classList.toggle('warn', warn);
  $('#storageLabel').textContent = `${formatBytes(used)} of ~1 GB used${warn ? ' (getting full)' : ''}`;
  $('#accessState').textContent = canEdit() ? `Editing as ${myName() || 'you'}` : 'View only. Click to unlock';
}

function renderHeader() {
  const title = state.view === 'all' ? 'All photos' : state.view === 'unsorted' ? 'Unsorted' : folderName(state.view) || '';
  $('#viewTitle').textContent = title;
  document.title = state.view === 'all' ? 'Artist Album' : `${title} · Artist Album`;
  $('#viewCount').textContent = state.loaded ? plural(currentList().length, 'photo') : '';
  const folderTools = isFolderView(state.view) && canEdit();
  $('#renameFolderBtn').hidden = !folderTools;
  $('#deleteFolderBtn').hidden = !folderTools;
  $('#selectBtn').hidden = !canEdit();
  $('#selectBtn').classList.toggle('on', state.selecting);
}

const cards = new Map();
function cardFor(img) {
  let el = cards.get(img.id);
  if (!el) {
    el = document.createElement('article');
    el.className = 'card';
    el.tabIndex = 0;
    el.dataset.id = img.id;
    el.innerHTML = `<div class="card-media"><img alt="" loading="lazy" decoding="async" draggable="false"><button class="card-check" type="button" tabindex="-1" aria-label="Select photo"><svg class="ic"><use href="#i-check"/></svg></button></div><div class="card-caption"><span class="card-title"></span><span class="card-comments"><svg class="ic"><use href="#i-comment"/></svg><b></b></span></div>`;
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
    const addBtn = canEdit() ? '<button class="btn primary" data-action="add"><svg class="ic"><use href="#i-plus"/></svg>Add photos</button>' : '';
    if (state.query) {
      html = `<h2>No matches</h2><p>Nothing matches “${esc(state.query)}”.</p>`;
    } else if (!state.album.images.length) {
      html = `<svg class="ic xl"><use href="#i-image"/></svg><h2>${canEdit() ? 'Start your board' : 'No photos yet'}</h2>` +
        (canEdit()
          ? `<p>Drag images anywhere onto this page, paste them, or pick them from your computer. Big files are shrunk automatically.</p>${addBtn}`
          : '<p>Nothing has been added yet.</p>');
    } else if (isFolderView(state.view)) {
      html = `<svg class="ic xl"><use href="#i-folder"/></svg><h2>This folder is empty</h2>` +
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
  $('#selectionBar').hidden = !canEdit() || !(n || state.selecting);
  $('#selCount').textContent = n ? `${n} selected` : 'Tap photos to select';
  fillFolderSelect($('#selMove'), 'Move to…');
  $('#selMove').value = '';
  $('#selMove').disabled = !n;
  $('#selDelete').disabled = !n;
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
    $('#lbPanel').scrollTop = 0;
    showLightboxImage(img);
  }

  const list = currentList();
  const idx = list.findIndex(i => i.id === img.id);
  $('#lbPrev').hidden = idx <= 0;
  $('#lbNext').hidden = idx < 0 || idx >= list.length - 1;
  $('#lbPosition').textContent = idx >= 0 ? `${idx + 1} of ${list.length}` : '';

  const title = $('#lbTitle');
  title.disabled = !canEdit();
  title.placeholder = canEdit() ? 'Add a title' : 'Untitled';
  if (document.activeElement !== title) title.value = img.title || '';

  const added = new Date(img.addedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const meta = [`Added ${added}${img.addedBy ? ` by ${img.addedBy}` : ''}`, `${img.w}×${img.h}`, formatBytes(img.bytes || 0)];
  $('#lbMeta').innerHTML = `${esc(meta.join(' · '))}${img.originalName ? `<br>${esc(img.originalName)}` : ''}`;

  const folderSel = $('#lbFolder');
  fillFolderSelect(folderSel);
  folderSel.value = img.folder && folderName(img.folder) ? img.folder : UNSORTED;
  folderSel.disabled = !canEdit();

  renderComments(img);
  $('#commentAs').textContent = myName() ? `Commenting as ${myName()}` : '';
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
  const key = JSON.stringify([img.comments, editingComment, canEdit()]);
  if (key === commentsKey) return;
  commentsKey = key;
  $('#lbCount').textContent = img.comments.length ? `(${img.comments.length})` : '';
  const ul = $('#lbComments');
  const draft = ul.querySelector('.comment-edit textarea')?.value;

  if (!img.comments.length) {
    ul.innerHTML = `<li class="none">${canEdit() ? 'No comments yet. Write the first one below.' : 'No comments yet.'}</li>`;
    return;
  }
  ul.innerHTML = img.comments.map(c => {
    const editing = editingComment === c.id;
    const tools = canEdit() && !editing
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

function hashUrl() {
  const p = new URLSearchParams();
  if (state.view !== 'all') p.set('view', state.view);
  if (state.lightbox) p.set('img', state.lightbox);
  const s = p.toString();
  return location.pathname + location.search + (s ? `#${s}` : '');
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { view: p.get('view') || 'all', img: p.get('img'), key: p.get('key') };
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
    window.scrollTo(0, 0);
  }
  history.replaceState(history.state, '', hashUrl());
  $('#app').classList.remove('nav-open');
  renderAll();
}

function siteUrl() {
  if (location.hostname.endsWith('.github.io')) return location.origin + location.pathname.replace(/index\.html$/, '');
  return `https://${repo.owner.toLowerCase()}.github.io/${repo.repo}/`;
}

// ---- actions ------------------------------------------------------------------

async function addFiles(fileList, folderOverride) {
  const all = [...fileList];
  const files = all.filter(isImageFile);
  if (!files.length) {
    if (all.length) toast('Only image files can be added.', 'error');
    return;
  }
  if (!requireKey()) return;
  const folder = folderOverride !== undefined ? folderOverride : isFolderView(state.view) ? state.view : null;
  const panel = uploadPanel(files);
  const records = [];
  const blobs = [];

  for (const [i, file] of files.entries()) {
    panel.update(i, 'Shrinking…');
    try {
      const out = await processFile(file);
      const rec = {
        id: uid('i'), folder, title: '', w: out.w, h: out.h,
        bytes: out.full.size, thumbBytes: out.thumb.size, ext: out.ext, thumbExt: out.thumbExt,
        originalName: file.name || 'Pasted image', addedAt: new Date().toISOString(), addedBy: myName(),
        comments: [],
      };
      const paths = imagePaths(rec);
      blobs.push({ path: paths.full, blob: out.full }, { path: paths.thumb, blob: out.thumb });
      localUrls.set(rec.id, { full: URL.createObjectURL(out.full), thumb: URL.createObjectURL(out.thumb) });
      records.push(rec);
      panel.update(i, out.full === file ? formatBytes(file.size) : `${formatBytes(file.size)} → ${formatBytes(out.full.size)}`, 'ok');
    } catch (e) {
      panel.update(i, e.message || 'Could not read this image.', 'error');
    }
    panel.progress(((i + 1) / files.length) * 0.3);
  }
  if (!records.length) {
    panel.finish('Nothing was added', true);
    return;
  }

  panel.title(`Uploading ${plural(records.length, 'photo')}…`);
  const ok = await save(`Add ${plural(records.length, 'photo')}`, ops.addImages(records), {
    files: blobs,
    onProgress: (done, total) => {
      panel.progress(0.3 + (0.65 * done) / Math.max(1, total));
      panel.title(done < total ? `Uploading ${Math.min(records.length, Math.floor(done / 2) + 1)} of ${records.length}…` : 'Saving…');
    },
  });
  panel.finish(ok ? `Added ${plural(records.length, 'photo')}` : 'Upload failed', !ok || records.length < files.length);
}

let activeUploads = 0;
function uploadPanel(files) {
  const panel = $('#uploadPanel');
  const list = $('#uploadList');
  clearTimeout(panel.hideTimer);
  if (!activeUploads) list.replaceChildren();
  activeUploads++;
  panel.hidden = false;
  $('#uploadTitle').textContent = `Preparing ${plural(files.length, 'photo')}…`;
  $('#uploadBar').style.width = '0';
  const rows = files.map(f => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="fname"></span><span class="fstate">Waiting</span>';
    li.firstChild.textContent = f.name || 'Pasted image';
    return li;
  });
  list.append(...rows);
  return {
    update(i, text, cls = '') {
      rows[i].className = cls;
      rows[i].lastChild.textContent = text;
      rows[i].lastChild.title = text;
    },
    progress(p) { $('#uploadBar').style.width = `${Math.round(p * 100)}%`; },
    title(t) { $('#uploadTitle').textContent = t; },
    finish(t, keepOpen) {
      activeUploads--;
      this.title(t);
      this.progress(1);
      if (!keepOpen && !activeUploads) panel.hideTimer = setTimeout(() => { panel.hidden = true; }, 4000);
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

async function deleteImages(ids) {
  const ok = await ask({
    title: `Delete ${plural(ids.length, 'photo')}?`,
    text: 'They will be removed from the album for everyone.',
    input: false, ok: 'Delete', danger: true,
  });
  if (!ok) return false;
  save(`Delete ${plural(ids.length, 'photo')}`, ops.deleteImages(ids));
  return true;
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

async function download(img) {
  const base = (img.title || (img.originalName || '').replace(/\.[^.]+$/, '') || img.id).replace(/[\\/:*?"<>|]+/g, '_');
  const path = imagePaths(img).full;
  for (const url of [localUrls.get(img.id)?.full, path, gh.rawUrl(path)].filter(Boolean)) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = `${base}.${img.ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      return;
    } catch {}
  }
  toast('Download failed.', 'error');
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

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 8000 : 3500);
}

let statusTimer;
function setStatus(s) {
  const el = $('#saveStatus');
  clearTimeout(statusTimer);
  el.dataset.state = s;
  el.textContent = { saving: 'Saving…', retrying: 'Merging with another edit…', saved: 'Saved', error: 'Not saved' }[s] || '';
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
    if (!dragHas(e, IMG_DRAG)) return;
    const card = e.target.closest('.card');
    if (!card || dragIds.includes(card.dataset.id)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const before = dropBeforeId(card, e) === card.dataset.id;
    markOnly(before ? card : null, 'drop-before');
    markOnly(before ? null : card, 'drop-after');
  });
  grid.addEventListener('drop', e => {
    if (!dragHas(e, IMG_DRAG)) return;
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
      if (!item || item.dataset.view === 'all') return markOnly(null, 'drop-target');
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
      if (!item || item.dataset.view === 'all') return;
      e.preventDefault();
      const ids = dragIds;
      clearDragMarks();
      state.selected.clear();
      moveTo(ids, item.dataset.view === 'unsorted' ? UNSORTED : item.dataset.view);
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
  const targetFolder = e => {
    const item = e.target.closest?.('.nav-item');
    if (!item || item.dataset.view === 'all') return undefined;
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
    $('#dropTarget').textContent = folder ? folderName(folder) : 'Unsorted';
    markOnly(t !== undefined ? e.target.closest('.nav-item') : null, 'drop-target');
  });
  window.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    if (--depth <= 0 || !e.relatedTarget) hide();
  });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const folder = targetFolder(e);
    hide();
    addFiles(e.dataTransfer.files, folder);
  });

  document.addEventListener('paste', e => {
    if (e.target.closest?.('input, textarea')) return;
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });
}

function bindHeader() {
  const pick = () => { if (requireKey()) $('#fileInput').click(); };
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

  $('#selMove').addEventListener('change', async e => {
    const value = e.target.value;
    e.target.value = '';
    const ids = state.album.images.filter(i => state.selected.has(i.id)).map(i => i.id);
    state.selected.clear();
    state.selecting = false;
    await moveTo(ids, value);
    renderAll();
  });
  $('#selDelete').addEventListener('click', async () => {
    if (await deleteImages([...state.selected])) {
      state.selected.clear();
      state.selecting = false;
      renderAll();
    }
  });
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
  $('#lbDelete').addEventListener('click', async () => {
    const id = state.lightbox;
    const list = currentList();
    const idx = list.findIndex(i => i.id === id);
    const neighbour = list[idx + 1] || list[idx - 1];
    const ok = await ask({ title: 'Delete this photo?', text: 'It will be removed from the album for everyone.', input: false, ok: 'Delete', danger: true });
    if (!ok) return;
    if (neighbour) {
      state.lightbox = neighbour.id;
      history.replaceState(history.state, '', hashUrl());
    } else {
      closeLightbox();
    }
    save('Delete a photo', ops.deleteImages([id]));
  });

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
      commentsKey = '';
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
    if (e.key === 'Escape' && (state.selected.size || state.selecting)) {
      state.selected.clear();
      state.selecting = false;
      renderAll();
    } else if (e.key === '/') {
      e.preventDefault();
      $('#search').focus();
    }
  });

  window.addEventListener('popstate', () => {
    const h = readHash();
    if (h.view !== state.view) { state.view = h.view; state.limit = CONFIG.pageSize; }
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
    if (pending.length) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ---- start ------------------------------------------------------------------------

function init() {
  const h = readHash();
  if (h.key) {
    gh.token = h.key;
    prefs.set('token', h.key);
  }
  state.view = h.view;
  state.lightbox = h.img;
  history.replaceState(null, '', hashUrl()); // also strips #key= from the address bar

  bindGrid();
  bindSidebar();
  bindFileDrop();
  bindHeader();
  bindLightbox();
  bindSettings();
  bindGlobal();
  renderAll();

  load().then(() => {
    if (state.lightbox && !findImage(state.lightbox)) {
      state.lightbox = null;
      history.replaceState(null, '', hashUrl());
    }
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
