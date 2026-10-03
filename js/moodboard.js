// Moodboard: a free-form canvas per folder, like PureRef. Photos can be moved,
// resized, layered and flipped; the canvas pans and zooms. The layout is saved
// in album.json (boards[folderId]) so it looks the same on every device.
//
// Mouse:  drag a photo to move it · drag its corner to resize · Shift-click or
//         Shift-drag on empty space to select several · drag empty space (or
//         scroll) to pan · Ctrl/⌘+scroll or pinch to zoom · double-click opens.
// Touch:  one finger moves photos / pans · two fingers pinch-zoom · tap a
//         selected photo to open it.

const DEFAULT_W = 260;
const GAP = 24;
const MIN_W = 40;
const SAVE_DELAY = 1200;
const THUMB_W = 600; // grid thumbnails are 600 px wide; beyond that, load the full image
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const viewKey = id => `artist-album.board-view.${id}`;

export class Moodboard {
  // host: { images(), layout(), canEdit(), setImgSrc(el, img, kind, onFail), loadImage(img, kind),
  //         open(id), save(boardId, patch) -> Promise<bool>, trash(ids) }
  constructor(el, host) {
    this.el = el;
    this.host = host;
    this.world = el.querySelector('.mb-world');
    this.zoomLabel = el.querySelector('[data-mb="zoom-reset"]');
    this.selBar = el.querySelector('.mb-sel');
    this.boardId = null;
    this.view = { x: 0, y: 0, zoom: 1 };
    this.els = new Map();
    this.pos = new Map();
    this.local = new Map();   // unsaved changes: id -> { x, y, w, z, flip }
    this.selected = new Set();
    this.full = new Set();    // photos already showing the full-size image
    this.pointers = new Map();
    this.gesture = null;
    this.bind();
  }

  get visible() { return !this.el.hidden; }

  show(boardId) {
    if (this.boardId !== boardId) {
      this.flush();
      this.boardId = boardId;
      this.world.replaceChildren();
      this.els.clear();
      this.local.clear();
      this.selected.clear();
      this.full.clear();
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(viewKey(boardId)) || 'null'); } catch {}
      this.view = saved || { x: 0, y: 0, zoom: 1 };
      this.el.hidden = false;
      this.render();
      if (!saved) requestAnimationFrame(() => this.fit());
      return;
    }
    this.el.hidden = false;
    this.render();
  }

  hide() {
    if (!this.visible) return;
    this.flush();
    this.el.hidden = true;
  }

  // ---- layout ---------------------------------------------------------------------

  height(img, w) { return (w * img.h) / img.w; }

  positions() {
    const imgs = this.host.images();
    const saved = this.host.layout()?.items || {};
    const out = new Map();
    for (const img of imgs) {
      const p = { ...saved[img.id], ...this.local.get(img.id) };
      if (Number.isFinite(p.x) && Number.isFinite(p.y) && p.w > 0) out.set(img.id, p);
    }
    // Photos without a place yet go in neat columns below the others.
    const unplaced = imgs.filter(i => !out.has(i.id));
    if (unplaced.length) {
      let left = 0, top = 0, width = (this.el.clientWidth && this.el.clientWidth < 600 ? 2 : 5) * (DEFAULT_W + GAP);
      let z = 0;
      if (out.size) {
        const byId = new Map(imgs.map(i => [i.id, i]));
        let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [id, p] of out) {
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x + p.w);
          maxY = Math.max(maxY, p.y + this.height(byId.get(id), p.w));
          z = Math.max(z, p.z || 0);
        }
        left = minX;
        top = maxY + GAP * 3;
        width = Math.max(width, maxX - minX);
      }
      const cols = Math.max(1, Math.floor((width + GAP) / (DEFAULT_W + GAP)));
      const heights = new Array(cols).fill(top);
      for (const img of unplaced) {
        const c = heights.indexOf(Math.min(...heights));
        out.set(img.id, { x: left + c * (DEFAULT_W + GAP), y: heights[c], w: DEFAULT_W, z: ++z, auto: true });
        heights[c] += this.height(img, DEFAULT_W) + GAP;
      }
    }
    return out;
  }

  render() {
    if (!this.boardId || !this.visible) return;
    const imgs = this.host.images();
    const byId = new Map(imgs.map(i => [i.id, i]));
    this.byId = byId;
    this.pos = this.positions();
    for (const [id, el] of this.els) {
      if (!byId.has(id)) { el.remove(); this.els.delete(id); this.selected.delete(id); }
    }
    for (const img of imgs) {
      let el = this.els.get(img.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'mb-item';
        el.dataset.id = img.id;
        el.innerHTML = '<img alt="" draggable="false"><span class="mb-handle" aria-hidden="true"></span>';
        this.host.setImgSrc(el.firstChild, img, 'thumb', () => el.classList.add('broken'));
        this.world.append(el);
        this.els.set(img.id, el);
      }
      this.place(img.id);
    }
    this.el.classList.toggle('can-edit', this.host.canEdit());
    this.el.querySelector('.mb-empty').hidden = imgs.length > 0;
    this.applyView();
    this.renderSelection();
  }

  place(id) {
    const el = this.els.get(id), p = this.pos.get(id), img = this.byId?.get(id);
    if (!el || !p || !img) return;
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.style.width = `${p.w}px`;
    el.style.height = `${this.height(img, p.w)}px`;
    el.style.zIndex = String(p.z || 1);
    el.classList.toggle('flipped', !!p.flip);
  }

  renderSelection() {
    for (const [id, el] of this.els) el.classList.toggle('selected', this.selected.has(id));
    this.selBar.hidden = !this.selected.size || !this.host.canEdit();
  }

  // ---- view (pan & zoom) -------------------------------------------------------

  applyView() {
    const { x, y, zoom } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    this.world.style.setProperty('--iz', String(1 / zoom)); // keeps outlines and handles the same size at any zoom
    this.el.style.backgroundPosition = `${x}px ${y}px`;
    this.el.style.backgroundSize = `${24 * zoom}px ${24 * zoom}px`;
    this.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    clearTimeout(this.sharpenTimer);
    this.sharpenTimer = setTimeout(() => this.sharpen(), 250);
  }

  saveView() {
    try { localStorage.setItem(viewKey(this.boardId), JSON.stringify(this.view)); } catch {}
  }

  zoomAt(factor, cx, cy) {
    const zoom = clamp(this.view.zoom * factor, 0.05, 8);
    const k = zoom / this.view.zoom;
    this.view = { x: cx - (cx - this.view.x) * k, y: cy - (cy - this.view.y) * k, zoom };
    this.applyView();
    this.saveView();
  }

  zoomCenter(factor) {
    const r = this.el.getBoundingClientRect();
    this.zoomAt(factor, r.width / 2, r.height / 2);
  }

  fit() {
    if (!this.pos.size) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [id, p] of this.pos) {
      const img = this.byId.get(id);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + this.height(img, p.w));
    }
    const r = this.el.getBoundingClientRect();
    const zoom = clamp(Math.min((r.width - 80) / (maxX - minX), (r.height - 120) / (maxY - minY)), 0.05, 1.5);
    this.view = {
      zoom,
      x: (r.width - (maxX - minX) * zoom) / 2 - minX * zoom,
      y: (r.height - 40 - (maxY - minY) * zoom) / 2 - minY * zoom,
    };
    this.applyView();
    this.saveView();
  }

  // Zoomed in past the thumbnail's resolution: swap in the full-size image.
  sharpen() {
    const r = this.el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    for (const [id, p] of this.pos) {
      if (this.full.has(id) || p.w * this.view.zoom * dpr <= THUMB_W * 1.05) continue;
      const img = this.byId.get(id);
      const sx = p.x * this.view.zoom + this.view.x, sy = p.y * this.view.zoom + this.view.y;
      const sw = p.w * this.view.zoom, sh = this.height(img, p.w) * this.view.zoom;
      if (sx > r.width || sy > r.height || sx + sw < 0 || sy + sh < 0) continue; // off screen
      this.full.add(id);
      this.host.loadImage(img, 'full').then(src => {
        const el = this.els.get(id);
        if (el) el.firstChild.src = src;
      }).catch(() => {});
    }
  }

  // ---- editing --------------------------------------------------------------------

  change(id, patch) {
    // The first edit pins photos that were placed automatically, so they stay put.
    for (const [pid, p] of this.pos) {
      if (p.auto && !this.local.has(pid)) this.local.set(pid, { x: p.x, y: p.y, w: p.w, z: p.z });
    }
    const { auto, ...base } = this.pos.get(id) || {};
    const next = { ...base, ...this.local.get(id), ...patch };
    this.local.set(id, next);
    this.pos.set(id, next);
    this.place(id);
  }

  maxZ() { return Math.max(0, ...[...this.pos.values()].map(p => p.z || 0)); }
  minZ() { return Math.min(0, ...[...this.pos.values()].map(p => p.z || 0)); }

  bringToFront(ids) {
    let z = this.maxZ();
    const order = [...ids].sort((a, b) => (this.pos.get(a)?.z || 0) - (this.pos.get(b)?.z || 0));
    if (order.every((id, i) => (this.pos.get(id)?.z || 0) === z - order.length + 1 + i)) return false; // already on top
    for (const id of order) this.change(id, { z: ++z });
    return true;
  }

  sendToBack(ids) {
    let z = this.minZ() - ids.length;
    for (const id of ids) this.change(id, { z: z++ });
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    if (!this.local.size || !this.boardId) return;
    const sent = new Map(this.local);
    const patch = {};
    for (const [id, p] of sent) patch[id] = { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w), z: p.z || 1, flip: !!p.flip };
    const ok = await this.host.save(this.boardId, patch);
    for (const [id, p] of sent) if (this.local.get(id) === p) this.local.delete(id); // saved (and not changed again since)
    if (!ok) this.local.clear(); // GitHub's version wins
    this.render();
  }

  // Put photos at a spot (e.g. where files were dropped), in rows of four.
  // `start` continues the rows when a big drop arrives in several batches.
  placeAt(records, point, start = 0) {
    if (!this.host.canEdit()) return;
    let z = this.maxZ();
    records.forEach((rec, j) => {
      const i = start + j;
      const col = i % 4, row = Math.floor(i / 4);
      const p = { x: point.x + col * (DEFAULT_W + GAP), y: point.y + row * (DEFAULT_W + GAP), w: DEFAULT_W, z: ++z };
      this.local.set(rec.id, p);
    });
    this.render();
    this.scheduleSave();
  }

  toWorld(clientX, clientY) {
    const r = this.el.getBoundingClientRect();
    return { x: (clientX - r.left - this.view.x) / this.view.zoom, y: (clientY - r.top - this.view.y) / this.view.zoom };
  }

  tidy() {
    const imgs = this.host.images();
    // Columns to suit this screen's shape: ~2 on a phone, more on a wide screen.
    const shape = (this.el.clientWidth || 1200) / (this.el.clientHeight || 800);
    const cols = clamp(Math.round(Math.sqrt(imgs.length * shape * 1.3)), 1, 8);
    const heights = new Array(cols).fill(0);
    let z = 0;
    for (const img of imgs) {
      const c = heights.indexOf(Math.min(...heights));
      this.local.set(img.id, { x: c * (DEFAULT_W + GAP), y: heights[c], w: DEFAULT_W, z: ++z, flip: !!this.pos.get(img.id)?.flip });
      heights[c] += this.height(img, DEFAULT_W) + GAP;
    }
    this.render();
    this.fit();
    this.scheduleSave();
  }

  // ---- input ---------------------------------------------------------------------

  bind() {
    const el = this.el;
    el.addEventListener('pointerdown', e => this.down(e));
    el.addEventListener('pointermove', e => this.move(e));
    el.addEventListener('pointerup', e => this.up(e));
    el.addEventListener('pointercancel', e => this.up(e, true));
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // Trackpad pinches send small steps; a mouse wheel sends big ones, so cap each step.
      if (e.ctrlKey || e.metaKey) this.zoomAt(Math.exp(-clamp(e.deltaY, -40, 40) * 0.01), e.clientX - r.left, e.clientY - r.top);
      else {
        this.view.x -= e.deltaX;
        this.view.y -= e.deltaY;
        this.applyView();
        clearTimeout(this.viewTimer);
        this.viewTimer = setTimeout(() => this.saveView(), 300);
      }
    }, { passive: false });
    el.addEventListener('dblclick', e => {
      const item = e.target.closest('.mb-item');
      if (item) this.host.open(item.dataset.id);
    });
    el.querySelector('.mb-toolbar').addEventListener('click', e => {
      const btn = e.target.closest('[data-mb]');
      if (btn) this.command(btn.dataset.mb);
    });
  }

  command(cmd) {
    const ids = [...this.selected];
    if (cmd === 'zoom-in') this.zoomCenter(1.25);
    else if (cmd === 'zoom-out') this.zoomCenter(0.8);
    else if (cmd === 'zoom-reset') this.zoomCenter(1 / this.view.zoom);
    else if (cmd === 'fit') this.fit();
    else if (cmd === 'tidy') this.host.confirmTidy().then(ok => ok && this.tidy());
    else if (!ids.length) return;
    else if (cmd === 'front') { if (this.bringToFront(ids)) this.scheduleSave(); }
    else if (cmd === 'back') { this.sendToBack(ids); this.scheduleSave(); }
    else if (cmd === 'flip') { for (const id of ids) this.change(id, { flip: !this.pos.get(id)?.flip }); this.scheduleSave(); }
    else if (cmd === 'open') this.host.open(ids[0]);
    else if (cmd === 'trash') { this.host.trash(ids); this.selected.clear(); this.renderSelection(); }
  }

  // Keyboard shortcuts while the moodboard is showing. Returns true if handled.
  key(e) {
    const edit = this.host.canEdit();
    const step = e.shiftKey ? 10 : 1;
    const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (nudge && edit && this.selected.size) {
      for (const id of this.selected) { const p = this.pos.get(id); this.change(id, { x: p.x + nudge[0], y: p.y + nudge[1] }); }
      this.scheduleSave();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && edit && this.selected.size) this.command('trash');
    else if (e.key === 'Escape' && this.selected.size) { this.selected.clear(); this.renderSelection(); }
    else if (e.key === 'f' || e.key === 'F') this.fit();
    else if (e.key === '0') this.command('zoom-reset');
    else if (e.key === '+' || e.key === '=') this.zoomCenter(1.25);
    else if (e.key === '-') this.zoomCenter(0.8);
    else if ((e.metaKey || e.ctrlKey) && e.key === 'a' && edit) { this.selected = new Set(this.pos.keys()); this.renderSelection(); }
    else return false;
    e.preventDefault();
    return true;
  }

  down(e) {
    if (e.target.closest('.mb-toolbar')) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    this.el.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = this.el.getBoundingClientRect();

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.gesture = {
        type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top }, view: { ...this.view },
      };
      return;
    }

    const item = e.target.closest('.mb-item');
    const id = item?.dataset.id;
    const edit = this.host.canEdit();
    const start = { startX: e.clientX, startY: e.clientY };

    if (e.button === 1 || !item && !e.shiftKey || !edit && !item) {
      if (!e.shiftKey && !item) { this.selected.clear(); this.renderSelection(); }
      this.gesture = { type: 'pan', ...start, view: { ...this.view } };
      return;
    }
    if (!edit) {
      this.gesture = { type: 'tap', id, ...start, view: { ...this.view } };
      return;
    }
    if (!item) {
      const box = Object.assign(document.createElement('div'), { className: 'mb-marquee' });
      this.el.append(box);
      this.gesture = { type: 'marquee', ...start, box, before: new Set(this.selected) };
      return;
    }
    if (e.target.closest('.mb-handle')) {
      this.gesture = { type: 'resize', id, ...start, w: this.pos.get(id).w };
      return;
    }
    const wasSelected = this.selected.has(id);
    if (e.shiftKey || e.metaKey || e.ctrlKey) wasSelected ? this.selected.delete(id) : this.selected.add(id);
    else if (!wasSelected) this.selected = new Set([id]);
    this.renderSelection();
    const ids = [...this.selected].filter(s => this.pos.has(s));
    this.gesture = {
      type: 'move', id, ids, ...start, wasSelected, moved: false, raised: false,
      origin: new Map(ids.map(s => [s, { x: this.pos.get(s).x, y: this.pos.get(s).y }])),
    };
  }

  move(e) {
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) return;
    ptr.x = e.clientX;
    ptr.y = e.clientY;
    const g = this.gesture;
    if (!g) return;
    const r = this.el.getBoundingClientRect();
    if (g.type === 'pinch') {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const zoom = clamp(g.view.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / g.dist), 0.05, 8);
      const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      const wx = (g.mid.x - g.view.x) / g.view.zoom, wy = (g.mid.y - g.view.y) / g.view.zoom;
      this.view = { zoom, x: mid.x - wx * zoom, y: mid.y - wy * zoom };
      this.applyView();
      return;
    }
    const dx = e.clientX - g.startX, dy = e.clientY - g.startY;
    const far = Math.hypot(dx, dy) > 4;
    if (g.type === 'pan' || (g.type === 'tap' && far)) {
      g.type = 'pan';
      this.view = { ...this.view, x: g.view.x + dx, y: g.view.y + dy };
      this.applyView();
    } else if (g.type === 'move') {
      if (!g.moved && !far) return;
      if (!g.moved) { g.moved = true; g.raised = this.bringToFront(g.ids); }
      for (const [id, o] of g.origin) this.change(id, { x: o.x + dx / this.view.zoom, y: o.y + dy / this.view.zoom });
    } else if (g.type === 'resize') {
      this.change(g.id, { w: Math.max(MIN_W, g.w + dx / this.view.zoom) });
    } else if (g.type === 'marquee') {
      const x1 = Math.min(g.startX, e.clientX) - r.left, y1 = Math.min(g.startY, e.clientY) - r.top;
      const x2 = Math.max(g.startX, e.clientX) - r.left, y2 = Math.max(g.startY, e.clientY) - r.top;
      Object.assign(g.box.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
      const a = { x: (x1 - this.view.x) / this.view.zoom, y: (y1 - this.view.y) / this.view.zoom };
      const b = { x: (x2 - this.view.x) / this.view.zoom, y: (y2 - this.view.y) / this.view.zoom };
      this.selected = new Set(g.before);
      for (const [id, p] of this.pos) {
        const h = this.height(this.byId.get(id), p.w);
        if (p.x < b.x && p.x + p.w > a.x && p.y < b.y && p.y + h > a.y) this.selected.add(id);
      }
      this.renderSelection();
    }
  }

  up(e, cancelled = false) {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.type === 'pinch') {
      if (this.pointers.size < 2) { this.gesture = null; this.saveView(); }
      return;
    }
    this.gesture = null;
    if (cancelled) return;
    if (g.type === 'tap') this.host.open(g.id);
    else if (g.type === 'pan') this.saveView();
    else if (g.type === 'marquee') g.box.remove();
    else if (g.type === 'resize') this.scheduleSave();
    else if (g.type === 'move') {
      if (g.moved || g.raised) this.scheduleSave();
      else if (e.pointerType !== 'mouse' && g.wasSelected) this.host.open(g.id); // tap a selected photo to open it
    }
  }
}
