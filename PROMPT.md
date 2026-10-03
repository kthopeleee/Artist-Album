# Prompt: build a GitHub-hosted personal image board

Paste everything below the line into an AI coding assistant to rebuild this site, or to build a similar one. Replace `<OWNER>` and `<REPO>` with your GitHub username and repository name.

---

Build a personal, Pinterest-style image board as a **static site on GitHub Pages** that uses **the same GitHub repository as its database and file storage**. There is no backend server, no database service, and no build step: only plain HTML, CSS and vanilla JavaScript ES modules that GitHub Pages serves as-is. Add a `.nojekyll` file. The repo is `<OWNER>/<REPO>`, branch `main`, and Pages deploys from the `main` branch root.

## What the user can do
1. **Upload.**
   - Drag image files anywhere onto the page; show a full-page drop overlay that names the target folder.
   - Paste images with Cmd/Ctrl+V when not typing in a field.
   - Click an "Add photos" button that opens a multi-file picker.
   - Dropping files onto a folder in the sidebar uploads them into that folder.
   - Otherwise new photos go into the folder currently open, or "Unsorted".
2. **Folders.**
   - Create, rename and delete named folders.
   - Deleting a folder moves its photos to Unsorted, after a confirmation.
   - Reorder folders by dragging them in the sidebar.
   - The sidebar shows "All photos", "Unsorted", then each folder with a cover thumbnail and a count.
3. **Move and reorder photos.**
   - Drag a photo card onto a sidebar folder to move it.
   - Drag a card onto another card to reorder: the left half of the target means "before", the right half means "after". Show an accent bar on that side while dragging.
   - A "Select" mode and modifier-clicks select several cards. A floating bar offers "Move to…" (which includes "+ New folder…"), "Tag", "Delete" and "Done".
   - Phones can't drag, so moving must also work through the "Move to" menus.
4. **Masonry board.**
   - Pinterest-like columns: 2 on phones, up to 6 on wide screens.
   - Place each card with JavaScript into the currently shortest column, using the stored width and height so there is no layout shift.
   - Rounded cards; the title and a comment-count badge sit under the image when present.
   - Render 50 cards at a time and load more as the user scrolls (IntersectionObserver on a sentinel).
   - Re-flow on resize.
5. **Lightbox.**
   - Clicking a card opens a full-screen view: a large image on the left and a side panel on the right. On phones the panel stacks below the image.
   - The panel holds:
     - An editable title.
     - "Added <date> by <name> · W×H · size" and the original file name.
     - A folder dropdown.
     - Tag chips. Clicking a tag's name closes the lightbox and filters the board to that tag; its × removes the tag. A "+ Add a tag" input autocompletes existing tags from a `<datalist>`, and Enter or a comma adds the tag.
     - Smart suggestions (see below): a "Suggested folder" chip for Unsorted photos and "Suggested tags" chips.
     - Download, Copy link (deep link `#img=<id>`) and Delete buttons.
     - A **comment thread**: avatar initial, author, relative time, "edited" marker. Every comment has Edit and Delete for anyone with edit access.
     - An "Add a comment" box; Cmd/Ctrl+Enter posts it.
   - Arrow keys and swipe go to the previous or next photo. Esc closes. Clicking the backdrop closes.
   - The browser Back button closes the lightbox: push a history entry on open.
   - Show the blurred thumbnail first, then swap in the full image when it loads. Preload the next photo.
6. **Search** box that filters by title, tags, comment text, comment author and original file name.
7. **Tags.**
   - Stored lowercase, trimmed, with no commas or `#`, and at most 40 characters.
   - A tag bar above the board shows every tag with its count. Clicking chips filters the board; several tags combine with AND.
   - Tag filters apply in every view except the Trash.
8. **Trash.** See "Trash and freeing space" below.
9. **Deep links:** the URL hash keeps the current view (`#view=<folderId|unsorted|trash>`), tag filters (`tags=a,b`) and the open photo (`img=<id>`). Handle `popstate` for Back and for pasted links.

## Access model
- **Anyone with the link can view.**
- **Editing needs a GitHub fine-grained personal access token**, with *Contents: Read and write* on only this repo.
  - The user pastes it into an "Edit access" dialog. It is stored in `localStorage` only and never committed.
  - The dialog also holds a display name, used as the comment author.
  - It includes step-by-step instructions to create the token, and a link to `https://github.com/settings/personal-access-tokens/new`.
  - Check the token with `GET /repos/<OWNER>/<REPO>` (`permissions.push`) and `GET /user` (the login) before saving it.
- **Invite link:** `<site>#key=<token>`. On load, save the key to `localStorage`, then remove it from the address bar with `history.replaceState`. Warn clearly that anyone with the link can edit.
- **Never embed a token in the site's source.** GitHub's secret scanning revokes it, and anyone could vandalise the repo.
- Without a token:
  - Every edit control is hidden or disabled.
  - Trying to edit opens the Edit access dialog.
  - The lightbox shows "Viewing only. Unlock editing to comment."

## Storage layout and data model
- `album/album.json` holds all metadata.
- `album/images/<id>.<ext>` holds the display copies.
- `album/thumbs/<id>.<ext>` holds the thumbnails.

```json
{ "version": 1,
  "folders": [{ "id": "f_…", "name": "Sketches", "createdAt": "ISO" }],
  "images": [{ "id": "i_…", "folder": "f_… or null", "title": "", "w": 2400, "h": 1600,
               "bytes": 412345, "thumbBytes": 52000, "ext": "webp", "thumbExt": "webp",
               "originalName": "IMG_1.HEIC", "addedAt": "ISO", "addedBy": "Katie",
               "tags": ["manga", "ink"], "trashedAt": null,
               "comments": [{ "id": "c_…", "author": "Katie", "text": "…", "at": "ISO", "editedAt": null }] }] }
```
- The order of `images` is the display order; new uploads go to the front.
- The order of `folders` is the sidebar order.
- An image whose folder no longer exists counts as Unsorted.

## Writing to GitHub (the important part)
Use the **Git Data API** from the browser; api.github.com supports CORS. That way every change, even "upload 20 photos", is **one atomic commit**:

1. Upload each new file with `POST /git/blobs` (base64).
   - Use up to 3 at a time.
   - For batches over 60 files, go one at a time with a 0.8 s pause, to stay under GitHub's limit of about 80 content-creating requests per minute.
2. `GET /git/ref/heads/main` gives the head commit. `GET /git/commits/<head>` gives the base tree.
3. Read `album.json` **at that exact commit**: `GET /contents/album/album.json?ref=<sha>` with `Accept: application/vnd.github.raw+json`.
4. Apply the change, then upload the new album.json as a blob.
5. `POST /git/trees` with `base_tree` and the entries.
   - A deleted file is an entry with `sha: null`.
   - If that fails with 422 because a file is already gone, list the tree recursively, drop the missing paths and retry.
6. `POST /git/commits`, then `PATCH /git/refs/heads/main` with `force: false`.
7. **If the PATCH returns 422 or 409, someone else committed first.** Go back to step 2 and re-apply the change to their newer album, reusing the blobs already uploaded. Use exponential backoff, up to 6 attempts.
8. On 429, or 403 with "secondary rate limit": wait `Retry-After` seconds (default 60), tell the user with a toast, and continue.

To make step 7 work, **write every change as a pure "op" function** `(album, ctx) => void`:
- It mutates the album in place.
- It is safe to re-apply: look things up by id, skip anything missing, and never add a duplicate id.
- Ops that delete images push their file paths onto `ctx.remove`.

Ops needed: `addFolder`, `renameFolder`, `deleteFolder`, `moveFolder`, `addImages`, `moveImages`, `reorderImages`, `trashImages`, `restoreImages`, `deleteImages`, `setTitle`, `addTags`, `removeTag`, `addComment`, `editComment`, `deleteComment`.

**UI state:**
- Keep `server` (the last album confirmed by GitHub) and a `pending` list of ops.
- The screen shows `server` with all pending ops applied, so edits appear instantly.
- Run saves one at a time through a promise chain.
- When a save succeeds, replace `server` with the album that was committed.
- When it fails, show a plain-English toast and reload `server` from GitHub. This undoes the edit.
- Show a "Saving… / Merging with another edit… / Saved / Not saved" indicator.
- Warn in `beforeunload` while saves are pending.

**Reading:**
- With a token, read album.json from the contents API with `cache: 'no-store'`.
- Without a token, try the API anyway. GitHub allows 60 unauthenticated requests per hour, so fall back to the copy GitHub Pages serves (`album/album.json?t=<now>`).
- Refresh when the tab becomes visible, and every 90 s while editing, but not while saves are pending. Discard a refresh result if a save landed while it was in flight.

**Plain-English errors:**

| Response | Message |
|---|---|
| 401 | The key is invalid or expired. |
| 403 "not accessible" | The key needs Contents: Read and write. |
| 403 rate limit | Wait a little and try again. |
| 404 | The repo was not found. |

## Trash and freeing space
Git keeps every old version of every file, so deleting a file, or a whole folder on GitHub's website, **never shrinks a repo**. Handle this with a Trash and a real "free up space" step.

- **Delete moves photos to the Trash:** it sets `trashedAt`, and the files stay where they are.
  - There is no confirmation; instead, show a toast with **Undo**.
  - Trashed photos are hidden from every view, count and tag list, except the **Trash** view, which sits in the sidebar under the folders.
  - Dropping cards on the Trash in the sidebar trashes them.
  - Inside the Trash, a photo shows a "Restore" button and "Delete forever".
- **Empty trash** (a button in the Trash view's header), or "Delete forever" on selected photos:
  1. Confirm, stating how many photos and bytes, and that GitHub's old version history is cleared too. The other photos, folders, tags and comments stay; it can't be undone.
  2. Commit `deleteImages` for those ids. This removes their files.
  3. Then **compact history**, inside the same one-at-a-time save chain:
     1. `GET` the head commit and its tree.
     2. `POST /git/commits` with that tree and `parents: []`, which makes a snapshot with no history.
     3. `GET` the head again; if it moved, someone saved meanwhile, so start over.
     4. `PATCH /git/refs/heads/main` with `force: true`.

  The old versions become unreferenced, and GitHub frees them during its regular cleanup.
- Show a notice at the top of the Trash: trashed photos still take space until emptied.
- **Two storage meters** in the sidebar, red at 85%:
  - **"Photos on the site"**: total bytes of all images, including the Trash, against **1 GB**. This is GitHub Pages' hard limit for a published site.
  - **"Repo incl. history"**: `size` from `GET /repos/<OWNER>/<REPO>` (in KB) against **5 GB**, GitHub's recommended repo maximum. That number lags behind, so show at least the site total.
  - A note under the meters says how much is in the Trash.

## Smart suggestions (on-device AI, opt-in per browser)
- **Model:** run `Xenova/mobileclip_s0` with Transformers.js (`@huggingface/transformers@4.3.0` from jsDelivr) **in a module Web Worker**.
  - Load only the vision model, with `dtype: 'fp16'`: a 23 MB download, cached by the browser.
  - **Do not use the `q8` / quantized vision model. It returns wrong embeddings.** Fall back to `fp32` if fp16 fails to load.
  - Set `env.allowLocalModels = false`.
- **Embeddings:**
  - Embed each photo's **thumbnail** blob into a normalized 512-dimensional vector.
  - Cache the vectors in IndexedDB keyed by `model:imageId`, so each photo is analyzed once per device.
  - Analyze Unsorted photos first. New uploads are analyzed right away from the thumbnail blob in memory.
- **Text side precomputed offline:**
  - A Node script, `tools/build-vocab.mjs`, embeds a built-in tag list and folder ideas with the fp32 text model.
  - It writes `js/vocab.js`, with base64 Float32 vectors.
  - The site therefore never downloads the text model.
  - **Tag list:** about 40 tags in three facets, each with a descriptive prompt:
    - *kind*: sketch, pencil, charcoal, ink, line art, watercolor, oil painting, digital art, pixel art, 3d render, manga, comic, storyboard, anime, photo, screenshot…
    - *subject*: portrait, figure, character design, landscape, cityscape, architecture, still life, animals, food, text, pattern, abstract…
    - *look*: black and white, colorful, color palette, plus a neutral "an image" anchor that is never suggested.
  - **Folder ideas:** Sketches, Manga, Comics, Paintings, Digital art, Photos, Screenshots. Each has a prompt and synonyms that match existing folder names (for example "drawings" for Sketches).
- **Suggestion math** lives in a pure module, `js/suggest.js`, so it can be tested in Node.
  - Zero-shot scores are `softmax(100 · cosine)`.
  - **Tags:**
    - Per facet, suggest the best tag if p ≥ 0.35 and the runner-up if p ≥ 0.3.
    - Before those, suggest tags from up to 8 similar photos (cosine ≥ 0.45) whose summed similarity is ≥ 0.8. This is how the user's own custom tags get suggested back.
    - Never suggest a tag the photo already has.
  - **Folders, for each Unsorted photo:**
    - Score each folder by the mean of the top 3 cosine similarities to its photos.
    - The folder's threshold is 0.5 when it has fewer than 3 photos; otherwise it is max(0.45, folder cohesion − 0.08).
    - A folder wins if it clears its threshold and beats the runner-up by 0.05.
    - Also take the folder-idea guess when p ≥ 0.6. Map it to an existing folder by name or synonym, or else propose a new folder.
    - Prefer the learned folder when its score is ≥ 0.6, or when it agrees with the guess.
    - Group photos by target. Only propose a *new* folder when at least 2 photos point to it.
- **UI:**
  - **"Sorting suggestions" panel at the top of Unsorted.** Each row reads "Looks like your **X** photos", "Looks like **X**" or "These look like **Manga**. Make a new folder?". It has:
    - up to 8 thumbnails, each with an × to leave it out,
    - a "Move N to X" or "Create 'X' and move N" button,
    - an × to dismiss the row.
  - Dismissals are kept in `localStorage` as `imageId>target`.
  - When the AI is off, the panel instead shows a one-line opt-in ("Turn on" / "Not now"), with download progress and an analysis counter.
  - A toggle under Edit access turns the AI on or off.

## Image size handling (GitHub limits)
GitHub refuses files over 100 MB and Pages sites are capped at 1 GB. Process every image **in the browser before upload**:
- Decode with `createImageBitmap(file, { imageOrientation: 'from-image' })`, falling back to an `<img>` element and `decode()`.
- **HEIC:** if decoding fails, lazy-load `heic2any` from jsDelivr and convert to JPEG first.
- **Display copy:** longest side at most 2400 px, WebP at quality 0.85. Feature-detect WebP encoding with `canvas.toDataURL('image/webp')`; Safari can't encode WebP, so use JPEG on a white background there.
- **Thumbnail:** 600 px wide, quality 0.75.
- **Downscaling:** halve repeatedly with `imageSmoothingQuality = 'high'` before the final resize, for sharp results.
- **Keep the original file untouched** if it is JPEG, PNG or WebP, at most 2 MB, and already within 2400 px; this keeps pixel art crisp. Also keep it if re-encoding makes it bigger.
- **GIFs:** keep the original so they stay animated, up to 15 MB. The thumbnail is the first frame.
- **Reject** anything still over 25 MB, with a clear message. Skip non-images; SVG is not accepted.
- **Upload panel:** show each file as "7.8 MB → 779 KB", then upload progress.

## Loading images fast
- The grid uses thumbnails only, with `loading="lazy"` and `decoding="async"`. The full image loads only in the lightbox.
- Image sources, tried in order:
  1. An in-memory object URL, for photos this tab just uploaded, so they appear instantly.
  2. The relative Pages path, served by GitHub's CDN.
  3. `https://raw.githubusercontent.com/<OWNER>/<REPO>/main/<path>`, for the minute or so before Pages redeploys after a commit.
- If all three fail, show an "Image missing" placeholder.

## Look and feel
- Warm off-white background and white surfaces; a serif display font for headings and system sans for body text.
- 16 px rounded cards with a subtle darkening on hover, and a round select check in the corner.
- An ink-black pill button for the main action, with a coral accent.
- Full dark mode through `prefers-color-scheme`, with all colours as CSS custom properties.
- **Phones:**
  - The sidebar becomes a slide-out drawer behind a hamburger button.
  - Search moves to its own row.
  - Button labels collapse to icons.
  - The lightbox panel stacks under the image.
  - No horizontal scrolling.
- Accessible: real buttons, aria-labels on icon buttons, keyboard-focusable cards, and `/` focuses search.
- Use one inline SVG `<symbol>` sprite for the icons.

## Files
- `index.html`
- `css/style.css`
- `js/config.js`: owner, repo and branch, auto-detected on `<owner>.github.io/<repo>`; size and quality settings.
- `js/album.js`: pure ops, queries (`visibleImages(album, view, query, tags)`, `folderCounts`, `allTags`, `totalBytes`, `trashBytes`) and the masonry function, with no DOM, so they can be unit-tested in Node.
- `js/github.js`: the GitHub wrapper, `commitChange`, `compactHistory` and `repoSizeBytes`.
- `js/images.js`: compression.
- `js/ai-worker.js`, `js/smart.js`, `js/suggest.js` and `js/vocab.js`: on-device AI, the IndexedDB cache, suggestion math, and the generated vocabulary.
- `tools/build-vocab.mjs`: regenerates `js/vocab.js`.
- `js/app.js`: the UI.
- `album/album.json`: starts as `{ "version": 1, "folders": [], "images": [] }`.
- `.nojekyll`
- `README.md`

## Verify before finishing
1. **Node unit tests** for every op, including re-applying them.
2. **The commit flow against an in-memory fake of the Git Data API.** Include:
   - A forced conflict that must retry and keep both editors' changes.
   - Two simultaneous editors.
   - Deleting a file that is already gone.
   - Compacting history: the result has `parents: []` and identical files, and an edit landing mid-compaction survives.
   - Trash, restore and tag ops; tag AND-filtering; trashed photos excluded from counts and tags.
   - Suggestions on real sample art (sketches, manga, comics, paintings, photos, screenshots): sketches go to an existing "Drawings" folder, manga gets a new "Manga" folder idea, dismissals stick, and the user's own tags are learned from similar photos.
3. **A headless-browser run with the GitHub API mocked by request interception:**
   - Unlock with a key.
   - Create a folder.
   - Upload a large generated PNG and check the stored file is smaller WebP.
   - Set the title, add a comment, edit it, move the photo, and delete it.
   - Drag a card onto a folder, drag-reorder, and drop files onto a sidebar folder.
   - Turn on the AI (real model), accept a folder suggestion, add a suggested tag, and filter by clicking a tag.
   - Trash a photo, Undo, trash again, then Empty trash: the files are gone and history is a single commit.
   - Check the phone width has no horizontal scroll, including the suggestion panel.
   - Check there are no console errors.
4. **Before relying on the quantized model, compare the browser's embeddings with Node's fp32 ones** (cosine ≈ 1). The quantized vision model fails this check.
