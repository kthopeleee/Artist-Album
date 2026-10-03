// Pure album data helpers (no DOM), shared by the UI and the GitHub sync layer.
//
// Every change to the album is an "op": a function (album, ctx) => void that
// mutates the album in place. Ops must be safe to re-apply to a newer copy of
// the album (that is how concurrent edits are merged), so they look things up
// by id and quietly skip anything that no longer exists. Ops that delete
// images push the files to remove onto ctx.remove.
import { CONFIG } from './config.js';

export const emptyAlbum = () => ({ version: 1, folders: [], images: [] });

export function normalize(a) {
  const album = a && typeof a === 'object' ? a : emptyAlbum();
  album.version ??= 1;
  album.folders = Array.isArray(album.folders) ? album.folders : [];
  album.images = Array.isArray(album.images) ? album.images : [];
  for (const img of album.images) {
    img.comments = Array.isArray(img.comments) ? img.comments : [];
    img.folder ??= null;
    img.title ??= '';
  }
  return album;
}

export function uid(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function imagePaths(img) {
  return {
    full: `${CONFIG.imageDir}/${img.id}.${img.ext}`,
    thumb: `${CONFIG.thumbDir}/${img.id}.${img.thumbExt}`,
  };
}

function moveBefore(list, movingIds, beforeId) {
  const moving = list.filter(x => movingIds.includes(x.id));
  if (!moving.length) return list;
  const rest = list.filter(x => !movingIds.includes(x.id));
  let at = beforeId ? rest.findIndex(x => x.id === beforeId) : -1;
  if (at < 0) at = rest.length;
  rest.splice(at, 0, ...moving);
  return rest;
}

const findImg = (a, id) => a.images.find(i => i.id === id);
const now = () => new Date().toISOString();

export const ops = {
  addFolder: (id, name) => a => {
    if (!a.folders.some(f => f.id === id)) a.folders.push({ id, name, createdAt: now() });
  },
  renameFolder: (id, name) => a => {
    const f = a.folders.find(f => f.id === id);
    if (f) f.name = name;
  },
  deleteFolder: id => a => {
    a.folders = a.folders.filter(f => f.id !== id);
    for (const img of a.images) if (img.folder === id) img.folder = null;
  },
  moveFolder: (id, beforeId) => a => {
    a.folders = moveBefore(a.folders, [id], beforeId);
  },

  addImages: records => a => {
    const fresh = records.filter(r => !findImg(a, r.id));
    a.images.unshift(...fresh);
  },
  moveImages: (ids, folder) => a => {
    if (folder && !a.folders.some(f => f.id === folder)) return;
    for (const img of a.images) if (ids.includes(img.id)) img.folder = folder;
  },
  reorderImages: (ids, beforeId) => a => {
    a.images = moveBefore(a.images, ids, beforeId);
  },
  deleteImages: ids => (a, ctx) => {
    for (const img of a.images) {
      if (!ids.includes(img.id)) continue;
      const p = imagePaths(img);
      ctx?.remove.push(p.full, p.thumb);
    }
    a.images = a.images.filter(i => !ids.includes(i.id));
  },
  setTitle: (id, title) => a => {
    const img = findImg(a, id);
    if (img) img.title = title;
  },

  addComment: (imgId, comment) => a => {
    const img = findImg(a, imgId);
    if (img && !img.comments.some(c => c.id === comment.id)) img.comments.push(comment);
  },
  editComment: (imgId, commentId, text) => a => {
    const c = findImg(a, imgId)?.comments.find(c => c.id === commentId);
    if (c) { c.text = text; c.editedAt = now(); }
  },
  deleteComment: (imgId, commentId) => a => {
    const img = findImg(a, imgId);
    if (img) img.comments = img.comments.filter(c => c.id !== commentId);
  },
};

// ---- queries ---------------------------------------------------------------

export function visibleImages(album, view, query = '') {
  let list = album.images;
  if (view === 'unsorted') list = list.filter(i => !i.folder || !album.folders.some(f => f.id === i.folder));
  else if (view !== 'all') list = list.filter(i => i.folder === view);
  const q = query.trim().toLowerCase();
  if (q) {
    list = list.filter(i =>
      (i.title || '').toLowerCase().includes(q) ||
      (i.originalName || '').toLowerCase().includes(q) ||
      i.comments.some(c => c.text.toLowerCase().includes(q) || (c.author || '').toLowerCase().includes(q)));
  }
  return list;
}

export function folderCounts(album) {
  const counts = { all: album.images.length, unsorted: 0 };
  const ids = new Set(album.folders.map(f => f.id));
  for (const img of album.images) {
    if (img.folder && ids.has(img.folder)) counts[img.folder] = (counts[img.folder] || 0) + 1;
    else counts.unsorted++;
  }
  return counts;
}

export const totalBytes = album =>
  album.images.reduce((sum, i) => sum + (i.bytes || 0) + (i.thumbBytes || 0), 0);

// Masonry: put each card in the currently shortest column.
// heights: estimated card heights in order. Returns an array of index lists.
export function layoutColumns(heights, n) {
  const cols = Array.from({ length: n }, () => ({ h: 0, items: [] }));
  heights.forEach((h, i) => {
    let best = cols[0];
    for (const c of cols) if (c.h < best.h) best = c;
    best.items.push(i);
    best.h += h;
  });
  return cols.map(c => c.items);
}
