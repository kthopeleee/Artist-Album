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
  // Moodboard layouts: boards[folderId].items[imageId] = { x, y, w, z, flip }
  album.boards = album.boards && typeof album.boards === 'object' ? album.boards : {};
  for (const img of album.images) {
    img.comments = Array.isArray(img.comments) ? img.comments : [];
    img.tags = Array.isArray(img.tags) ? img.tags : [];
    img.folder ??= null;
    img.title ??= '';
    img.trashedAt ??= null;
  }
  return album;
}

// Tags are stored lowercase so "Sketch" and "sketch" are the same tag.
export const normTag = s => String(s || '').toLowerCase().replace(/[,#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

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
    if (a.boards) delete a.boards[id];
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
    for (const img of a.images) {
      if (!ids.includes(img.id) || img.folder === folder) continue;
      if (img.folder) delete a.boards?.[img.folder]?.items?.[img.id]; // leaves that folder's moodboard
      img.folder = folder;
    }
  },
  reorderImages: (ids, beforeId) => a => {
    a.images = moveBefore(a.images, ids, beforeId);
  },
  // Trash keeps the files; only emptying the trash deletes them for good.
  trashImages: ids => a => {
    const at = now();
    for (const img of a.images) if (ids.includes(img.id) && !img.trashedAt) img.trashedAt = at;
  },
  restoreImages: ids => a => {
    for (const img of a.images) if (ids.includes(img.id)) img.trashedAt = null;
  },
  addTags: (ids, tags) => a => {
    const clean = tags.map(normTag).filter(Boolean);
    for (const img of a.images) {
      if (!ids.includes(img.id)) continue;
      img.tags ??= [];
      for (const t of clean) if (!img.tags.includes(t)) img.tags.push(t);
    }
  },
  removeTag: (ids, tag) => a => {
    for (const img of a.images) if (ids.includes(img.id)) img.tags = (img.tags || []).filter(t => t !== tag);
  },
  deleteImages: ids => (a, ctx) => {
    for (const img of a.images) {
      if (!ids.includes(img.id)) continue;
      const p = imagePaths(img);
      ctx?.remove.push(p.full, p.thumb);
    }
    a.images = a.images.filter(i => !ids.includes(i.id));
    for (const board of Object.values(a.boards || {})) for (const id of ids) delete board.items?.[id];
  },
  // Duplicates: the kept photo takes over the others' tags, comments, title and
  // folder (when it has none), then the others go to the Trash.
  mergeAndTrash: (keepId, ids) => a => {
    const keep = findImg(a, keepId);
    if (!keep) return;
    const at = now();
    for (const img of a.images) {
      if (!ids.includes(img.id) || img.id === keepId || img.trashedAt) continue;
      keep.tags ??= [];
      for (const t of img.tags || []) if (!keep.tags.includes(t)) keep.tags.push(t);
      for (const c of img.comments || []) if (!keep.comments.some(k => k.id === c.id)) keep.comments.push(c);
      if (!keep.title && img.title) keep.title = img.title;
      if (!keep.folder && img.folder && a.folders.some(f => f.id === img.folder)) keep.folder = img.folder;
      img.trashedAt = at;
    }
    keep.comments.sort((x, y) => String(x.at).localeCompare(String(y.at)));
  },
  // Moodboard: patch = { imageId: { x, y, w, z, flip } | null }
  setBoardItems: (boardId, patch) => a => {
    a.boards ??= {};
    const board = (a.boards[boardId] ??= { items: {} });
    board.items ??= {};
    for (const [id, p] of Object.entries(patch)) {
      if (p === null) delete board.items[id];
      else if (findImg(a, id)) board.items[id] = { ...board.items[id], ...p };
    }
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

// view: 'all' | 'unsorted' | 'trash' | folder id. tags: all must match.
export function visibleImages(album, view, query = '', tags = []) {
  let list = album.images.filter(i => (view === 'trash' ? !!i.trashedAt : !i.trashedAt));
  if (view === 'unsorted') list = list.filter(i => !i.folder || !album.folders.some(f => f.id === i.folder));
  else if (view !== 'all' && view !== 'trash') list = list.filter(i => i.folder === view);
  if (tags.length) list = list.filter(i => tags.every(t => i.tags?.includes(t)));
  const q = query.trim().toLowerCase();
  if (q) {
    list = list.filter(i =>
      (i.title || '').toLowerCase().includes(q) ||
      (i.originalName || '').toLowerCase().includes(q) ||
      i.tags?.some(t => t.includes(q)) ||
      i.comments.some(c => c.text.toLowerCase().includes(q) || (c.author || '').toLowerCase().includes(q)));
  }
  return list;
}

export function folderCounts(album) {
  const counts = { all: 0, unsorted: 0, trash: 0 };
  const ids = new Set(album.folders.map(f => f.id));
  for (const img of album.images) {
    if (img.trashedAt) { counts.trash++; continue; }
    counts.all++;
    if (img.folder && ids.has(img.folder)) counts[img.folder] = (counts[img.folder] || 0) + 1;
    else counts.unsorted++;
  }
  return counts;
}

// Every tag in use (outside the trash), most used first.
export function allTags(album) {
  const counts = new Map();
  for (const img of album.images) {
    if (img.trashedAt) continue;
    for (const t of img.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const imageBytes = i => (i.bytes || 0) + (i.thumbBytes || 0);
export const totalBytes = album => album.images.reduce((sum, i) => sum + imageBytes(i), 0);
export const trashBytes = album => album.images.reduce((sum, i) => sum + (i.trashedAt ? imageBytes(i) : 0), 0);

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
