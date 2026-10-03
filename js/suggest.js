// Turns image embeddings (from the on-device AI model) into suggestions.
// Pure functions, no DOM, so they can be tested in Node.
//
// Two kinds of evidence are combined:
//  - "learned": photos that look like ones you already sorted or tagged
//    (image-to-image similarity), which adapts to your own folders and tags.
//  - "looks like": zero-shot matching against the built-in tag list and folder
//    ideas in vocab.js (image-to-text similarity).
import { TAGS, IDEAS, TAG_VECTORS, IDEA_VECTORS } from './vocab.js';

// Tuned on sample art (sketches, manga, comics, paintings, photos, screenshots):
// photos of the same kind score ~0.35-0.50 against each other, different kinds ~0.13-0.28.
const NEIGHBOR_MIN = 0.45;     // how alike two photos must be to share tags
const NEIGHBOR_TAG_SCORE = 0.8;
const FOLDER_MIN = 0.45;       // how alike a photo must be to a folder's photos
const FOLDER_MARGIN = 0.05;    // ...and how clearly it beats the runner-up folder
const FOLDER_SURE = 0.6;       // alike enough to overrule the "looks like" guess
const IDEA_MIN = 0.6;          // confidence for "looks like Sketches/Manga/…"
const TAG_TOP = 0.35;          // confidence for an AI tag (best in its facet)
const TAG_SECOND = 0.3;

export const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

function softmax(xs) {
  const m = Math.max(...xs);
  const e = xs.map(x => Math.exp(x - m));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map(x => x / sum);
}

function decode(b64, n) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const all = new Float32Array(bytes.buffer);
  const dim = all.length / n;
  return Array.from({ length: n }, (_, i) => all.subarray(i * dim, (i + 1) * dim));
}

let vectors;
const vocab = () => (vectors ??= { tags: decode(TAG_VECTORS, TAGS.length), ideas: decode(IDEA_VECTORS, IDEAS.length) });

const live = album => album.images.filter(i => !i.trashedAt);
const topMean = (sims, k) => {
  const top = [...sims].sort((a, b) => b - a).slice(0, k);
  return top.reduce((a, b) => a + b, 0) / (top.length || 1);
};

// ---- tags -------------------------------------------------------------------

// Best built-in tags, one or two per facet (kind / subject / look).
export function aiTags(vec) {
  const { tags } = vocab();
  const out = [];
  for (const facet of ['kind', 'subject', 'look']) {
    const idx = TAGS.map((t, i) => (t.facet === facet ? i : -1)).filter(i => i >= 0);
    const p = softmax(idx.map(i => 100 * dot(vec, tags[i])));
    const ranked = idx.map((i, j) => ({ tag: TAGS[i].tag, score: p[j] })).sort((a, b) => b.score - a.score);
    if (ranked[0].tag && ranked[0].score >= TAG_TOP) out.push({ ...ranked[0], source: 'ai' });
    if (ranked[1].tag && ranked[1].score >= TAG_SECOND) out.push({ ...ranked[1], source: 'ai' });
  }
  return out;
}

// Tags used on the most similar photos you've already tagged.
export function similarTags(img, vec, album, emb) {
  const neighbors = live(album)
    .filter(o => o.id !== img.id && o.tags?.length && emb.has(o.id))
    .map(o => ({ o, sim: dot(vec, emb.get(o.id)) }))
    .filter(n => n.sim >= NEIGHBOR_MIN)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 8);
  const score = new Map();
  for (const { o, sim } of neighbors) for (const t of o.tags) score.set(t, (score.get(t) || 0) + sim);
  return [...score]
    .filter(([, s]) => s >= NEIGHBOR_TAG_SCORE)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, s]) => ({ tag, score: s, source: 'similar' }));
}

export function suggestTags(img, album, emb, max = 8) {
  const vec = emb.get(img.id);
  if (!vec) return [];
  const have = new Set(img.tags || []);
  const seen = new Set();
  const out = [];
  for (const s of [...similarTags(img, vec, album, emb), ...aiTags(vec)]) {
    if (have.has(s.tag) || seen.has(s.tag)) continue;
    seen.add(s.tag);
    out.push(s);
  }
  return out.slice(0, max);
}

// ---- similar & duplicates -----------------------------------------------------

// Tuned on resized / recompressed / cropped copies of sample art: copies score
// 0.93+, while the most alike *different* pictures scored 0.83.
export const DUPLICATE = 0.92;      // same picture (resized, re-saved, lightly cropped)
export const NEAR_DUPLICATE = 0.86; // probably the same picture, heavily cropped or edited
const SIMILAR_MIN = 0.45;

export function similarTo(img, album, emb, limit = 12) {
  const vec = emb.get(img.id);
  if (!vec) return [];
  return live(album)
    .filter(o => o.id !== img.id && emb.has(o.id))
    .map(o => ({ img: o, score: dot(vec, emb.get(o.id)) }))
    .filter(s => s.score >= SIMILAR_MIN)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Which copy to keep: one that's sorted, tagged or commented, then the larger, then the older.
function keeperOf(imgs, album) {
  const folders = new Set(album.folders.map(f => f.id));
  const worth = i => (i.folder && folders.has(i.folder) ? 4 : 0) + (i.tags?.length || 0) + 2 * (i.comments?.length || 0) + (i.title ? 1 : 0);
  return [...imgs].sort((a, b) => worth(b) - worth(a) || b.w * b.h - a.w * a.h || String(a.addedAt).localeCompare(String(b.addedAt)))[0];
}

// Groups of copies: [{ keep, others: [{ img, score, duplicate }] }], biggest first.
export function duplicateGroups(album, emb) {
  const photos = live(album).filter(i => emb.has(i.id));
  const parent = photos.map((_, i) => i);
  const root = i => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < photos.length; i++) {
    const a = emb.get(photos[i].id);
    for (let j = i + 1; j < photos.length; j++) {
      if (dot(a, emb.get(photos[j].id)) >= NEAR_DUPLICATE) parent[root(i)] = root(j);
    }
  }
  const sets = new Map();
  photos.forEach((p, i) => { const r = root(i); if (!sets.has(r)) sets.set(r, []); sets.get(r).push(p); });
  return [...sets.values()]
    .filter(g => g.length > 1)
    .map(g => {
      const keep = keeperOf(g, album);
      const kv = emb.get(keep.id);
      const others = g.filter(i => i !== keep)
        .map(img => { const score = dot(kv, emb.get(img.id)); return { img, score, duplicate: score >= DUPLICATE }; })
        .sort((a, b) => b.score - a.score);
      return { keep, others };
    })
    .sort((a, b) => b.others.length - a.others.length);
}

// ---- folders ----------------------------------------------------------------

const norm = s => s.trim().toLowerCase();

export function ideaFor(vec) {
  const { ideas } = vocab();
  const p = softmax(ideas.map(v => 100 * dot(vec, v)));
  const best = p.indexOf(Math.max(...p));
  return { idea: IDEAS[best], score: p[best] };
}

function folderForIdea(album, idea) {
  return album.folders.find(f => norm(f.name) === norm(idea.name) || idea.match.includes(norm(f.name)));
}

// Where should each Unsorted photo go? Returns groups, largest first:
//   { key, folderId | newName, reason: 'similar' | 'looks-like' | 'new', ids }
// `dismissed` holds "imageId>key" pairs the user said no to.
export function folderSuggestions(album, emb, dismissed = new Set()) {
  const photos = live(album);
  const folderIds = new Set(album.folders.map(f => f.id));
  const members = new Map();
  for (const img of photos) {
    if (img.folder && folderIds.has(img.folder) && emb.has(img.id)) {
      if (!members.has(img.folder)) members.set(img.folder, []);
      members.get(img.folder).push(emb.get(img.id));
    }
  }
  // A folder of very alike photos needs a closer match than a mixed one.
  const threshold = new Map();
  for (const [fid, vecs] of members) {
    if (vecs.length < 3) { threshold.set(fid, 0.5); continue; } // too few photos to judge
    const k = Math.min(3, vecs.length - 1);
    const cohesion = vecs.reduce((sum, v, i) => sum + topMean(vecs.filter((_, j) => j !== i).map(w => dot(v, w)), k), 0) / vecs.length;
    threshold.set(fid, Math.max(FOLDER_MIN, cohesion - 0.08));
  }

  const groups = new Map();
  const add = (key, base, id) => {
    if (dismissed.has(`${id}>${key}`)) return;
    if (!groups.has(key)) groups.set(key, { key, ...base, ids: [] });
    groups.get(key).ids.push(id);
  };

  for (const img of photos) {
    if ((img.folder && folderIds.has(img.folder)) || !emb.has(img.id)) continue;
    const vec = emb.get(img.id);
    const scored = [...members]
      .map(([fid, vecs]) => ({ fid, s: topMean(vecs.map(w => dot(vec, w)), Math.min(3, vecs.length)) }))
      .sort((a, b) => b.s - a.s);
    const [best, second] = scored;
    const learned = best && best.s >= threshold.get(best.fid) && (!second || best.s - second.s >= FOLDER_MARGIN) ? best : null;

    const { idea, score } = ideaFor(vec);
    const guess = score >= IDEA_MIN ? idea : null;
    const guessFolder = guess && folderForIdea(album, guess);

    // Prefer what you taught it (your folders) when it's sure or the guess agrees.
    if (learned && (learned.s >= FOLDER_SURE || !guess || guessFolder?.id === learned.fid)) {
      add(`f:${learned.fid}`, { folderId: learned.fid, reason: 'similar' }, img.id);
    } else if (guessFolder) {
      add(`f:${guessFolder.id}`, { folderId: guessFolder.id, reason: 'looks-like' }, img.id);
    } else if (guess) {
      add(`n:${guess.name}`, { newName: guess.name, reason: 'new' }, img.id);
    } else if (learned) {
      add(`f:${learned.fid}`, { folderId: learned.fid, reason: 'similar' }, img.id);
    }
  }

  return [...groups.values()]
    .filter(g => g.folderId || g.ids.length >= 2) // don't propose a new folder for a single photo
    .sort((a, b) => b.ids.length - a.ids.length);
}
