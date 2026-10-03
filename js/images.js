// Shrinks images in the browser before they go to GitHub, and makes a small
// thumbnail for the grid. This is what keeps the repo far below GitHub's
// limits: a 15 MB phone photo typically becomes a ~0.5 MB display copy plus a
// ~50 KB thumbnail.
import { CONFIG } from './config.js';

const HEIC_LIB = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';

const isHeic = f => /image\/hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name || '');
export const isImageFile = f => (f.type.startsWith('image/') && f.type !== 'image/svg+xml') || isHeic(f);

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

let webpSupport;
function canEncodeWebp() {
  if (webpSupport === undefined) {
    const c = makeCanvas(1, 1);
    webpSupport = c.toDataURL('image/webp').startsWith('data:image/webp');
  }
  return webpSupport;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

async function decode(blob) {
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  } catch {}
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('unreadable');
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
}

let heicLib;
function loadHeicConverter() {
  heicLib ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = HEIC_LIB;
    s.onload = () => resolve(window.heic2any);
    s.onerror = () => { heicLib = null; reject(new Error('Could not load the iPhone (HEIC) photo converter.')); };
    document.head.append(s);
  });
  return heicLib;
}

// Halve repeatedly before the final resize: much sharper than one big jump.
function drawScaled(source, sw, sh, w, h, opaque) {
  let cur = source, cw = sw, ch = sh;
  while (cw / 2 >= w && ch / 2 >= h) {
    const step = makeCanvas(Math.round(cw / 2), Math.round(ch / 2));
    const sctx = step.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(cur, 0, 0, step.width, step.height);
    cur = step; cw = step.width; ch = step.height;
  }
  const out = makeCanvas(w, h);
  const ctx = out.getContext('2d');
  if (opaque) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  return out;
}

async function encode(source, sw, sh, w, h, quality) {
  const webp = canEncodeWebp(); // Safari can't write WebP; fall back to JPEG there
  const canvas = drawScaled(source, sw, sh, w, h, !webp);
  const type = webp ? 'image/webp' : 'image/jpeg';
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not compress this image.'))), type, quality));
  return { blob, ext: webp ? 'webp' : 'jpg' };
}

const KEEPABLE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Returns { full, ext, thumb, thumbExt, w, h } where full/thumb are Blobs.
export async function processFile(file) {
  let decoded;
  try {
    decoded = await decode(file);
  } catch {
    if (!isHeic(file)) throw new Error('Your browser cannot read this file type. Try JPG, PNG, WebP or GIF.');
    const heic2any = await loadHeicConverter();
    const jpeg = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
    decoded = await decode(Array.isArray(jpeg) ? jpeg[0] : jpeg);
  }

  try {
    const { source, width: w0, height: h0 } = decoded;
    const tw = Math.min(CONFIG.thumbWidth, w0);
    const th = Math.max(1, Math.round((h0 * tw) / w0));
    const thumb = await encode(source, w0, h0, tw, th, CONFIG.thumbQuality);
    const base = { thumb: thumb.blob, thumbExt: thumb.ext };

    if (file.type === 'image/gif') {
      if (file.size > CONFIG.gifMaxBytes)
        throw new Error(`GIF is ${formatBytes(file.size)}; the limit for animated GIFs is ${formatBytes(CONFIG.gifMaxBytes)}.`);
      return { ...base, full: file, ext: 'gif', w: w0, h: h0 };
    }

    const keepExt = KEEPABLE[file.type];
    const fitsAlready = Math.max(w0, h0) <= CONFIG.fullMaxSide;
    if (keepExt && fitsAlready && file.size <= CONFIG.keepOriginalBelow)
      return { ...base, full: file, ext: keepExt, w: w0, h: h0 };

    const scale = Math.min(1, CONFIG.fullMaxSide / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const full = await encode(source, w0, h0, w, h, CONFIG.fullQuality);

    if (keepExt && fitsAlready && full.blob.size >= file.size)
      return { ...base, full: file, ext: keepExt, w: w0, h: h0 };
    if (full.blob.size > CONFIG.hardMaxBytes)
      throw new Error(`Still ${formatBytes(full.blob.size)} after shrinking, which is too big for GitHub.`);
    return { ...base, full: full.blob, ext: full.ext, w, h };
  } finally {
    decoded.close();
  }
}
