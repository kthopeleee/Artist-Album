# Artist Album

A personal, Pinterest-style image board that lives entirely on GitHub. GitHub Pages hosts the site, and this repository stores the photos.

**Live site:** https://kthopeleee.github.io/Artist-Album/

- **Add photos:** drag images anywhere onto the page, paste them, or click **Add photos**.
- **Folders:** make folders, then drag photos onto a folder in the sidebar to move them. Drag a photo onto another photo to reorder.
- **Photo view:** click a photo to open it large. The side panel has the title, folder, tags, download link and comments.
- **Tags:** type them on a photo, or pick suggested ones. Click a tag on a photo, or in the tag bar above the board, to show only photos with that tag. Search covers titles, tags, comments and file names.
- **Smart suggestions:** an AI that runs on your own device suggests tags for each photo and a folder for each Unsorted photo, for example "these look like Sketches" or "these look like Manga, make a new folder?".
- **Trash:** deleting moves a photo to the Trash, where it can be restored. Emptying the Trash deletes the photos for good and actually frees the space.
- **Phones:** use **Select**, or the folder menu inside a photo, to move things, since phones can't drag.

## Who can do what

| | Needs |
|---|---|
| Look at the album | Just the link |
| Add, move, tag, rename, delete, comment | A GitHub key, saved once per browser under **Edit access** |

### Getting a key (about 1 minute)
1. Go to https://github.com/settings/personal-access-tokens/new
2. Name it `Artist Album` and pick an expiration.
3. **Repository access** → *Only select repositories* → `Artist-Album`.
4. **Permissions** → *Repository permissions* → **Contents: Read and write**.
5. Generate it, then paste it into the site under **Edit access**.

### Letting friends edit
- **Quick way:** go to **Edit access** → *Let someone else edit* → **Copy invite link**. The link has your key built in, so anyone holding it can edit. To cancel every invite at once, delete the token on GitHub.
- **Safer way:** add them as a collaborator (repo **Settings → Collaborators**), so they make their own key.

## Storage: the two limits

The sidebar shows two meters:

| Meter | Limit | What counts |
|---|---|---|
| **Photos on the site** | **1 GB** | The photos in the album right now, including ones in the Trash. This is a hard GitHub Pages rule: Pages won't publish a site bigger than 1 GB. It's roughly 1,000–3,000 photos. |
| **Repo incl. history** | **about 5 GB** | Everything above, plus every old version git has kept. GitHub asks repos to stay under about 5 GB. GitHub updates this number on its own schedule, so it lags behind. |

**Why the Trash exists:** git keeps every old version of every file. Simply deleting a photo, or deleting a folder on GitHub's website, does not free any space. **Empty trash** fixes that:
1. It deletes the trashed photos.
2. It replaces the repo's history with a single snapshot of the album as it is now.

Your current photos, folders, tags and comments are all kept; only the record of past edits goes. The space is released when GitHub runs its regular cleanup, so the repo meter can take a while to drop. The next photo you delete starts a fresh Trash, and the cycle repeats.

> If you have this repo cloned on a computer, run `git fetch && git reset --hard origin/main` after emptying the Trash. The history on GitHub was replaced, so an old clone can't simply pull.

## How big files are handled

Images are shrunk in the browser **before** upload:

| | Size |
|---|---|
| Display copy | Longest side at most 2400 px, WebP (JPEG on Safari). A 15 MB phone photo usually becomes 0.3–1.5 MB. |
| Thumbnail | 600 px wide, around 30–80 KB. The grid only loads these, a batch at a time as you scroll. |
| Small JPG/PNG/WebP | Under 2 MB and already small enough: stored untouched, so pixel art stays crisp. |
| GIFs | Kept as-is so they still animate (up to 15 MB). |
| iPhone HEIC | Converted automatically. |

Big batches are paced to stay under GitHub's write limits. If GitHub asks the site to slow down, it waits and carries on by itself. Sizes are adjustable in [js/config.js](js/config.js).

## Smart suggestions (on-device AI)

Turn them on under **Edit access**, or from the banner in **Unsorted**.

**The model:** a small image-recognition model (Apple's MobileCLIP S0, run with Transformers.js).
- The first time, it downloads 23 MB, which the browser then keeps.
- It runs entirely on your device. No photo is ever sent anywhere.
- Each browser remembers what it has already looked at, so every photo is only analyzed once per device.

**Folder suggestions** appear at the top of **Unsorted**. They come from two places:
- **Your own folders:** "Looks like your *Drawings* photos." This gets better as you sort more.
- **Built-in ideas:** Sketches, Manga, Comics, Paintings, Digital art, Photos and Screenshots. If you already have a matching folder, for example "Drawings" for sketches, that folder is used. Otherwise it offers to create one.

**Using the panel:**
- Click a thumbnail's **×** to leave that photo out.
- Click a row's **×** to dismiss the whole suggestion.
- Click the button to move everything in the row in one go.

**Tag suggestions** appear inside each photo. They come from:
- tags you used on similar photos, so your own tags get suggested back to you, and
- a built-in list of about 40 art tags, such as *sketch, ink, watercolor, manga, comic, portrait, landscape, character design* and *black and white*.

To change the built-in tags or folder ideas, edit [tools/build-vocab.mjs](tools/build-vocab.mjs), then run:

```sh
cd tools && npm i @huggingface/transformers@4.3.0 && node build-vocab.mjs
```

That regenerates [js/vocab.js](js/vocab.js).

## How it works

- **No server and no build step:** plain HTML, CSS and JavaScript ([index.html](index.html), [js/](js/)).
- **Data:**
  - [album/album.json](album/album.json) holds folders, titles, tags, comments and Trash state.
  - `album/images/` holds the display copies.
  - `album/thumbs/` holds the thumbnails.
- **Saving:** every change is a single git commit made straight from the browser with the GitHub API. Uploading 20 photos is one commit.
- **Several editors at once:** if two people save at the same moment, the second save is replayed on top of the first, so nothing is lost. This includes saves that land while the Trash is being emptied.
- **New photos:** they appear instantly for the uploader. Everyone else sees them about a minute later, once GitHub Pages redeploys. Until then they load from raw.githubusercontent.com.

## Updating the site's code

GitHub Pages lets browsers keep files for 10 minutes. If a browser mixed an old cached file with a new page, the site could break. To prevent that, every CSS and JS file is loaded with a version tag (`?v=…`). The site also checks that the page and its code match, and refreshes itself once if they don't.

**After changing anything in `css/` or `js/`, run:**

```sh
node tools/bump-version.mjs
```

**If the site ever looks broken right after an update,** press **Cmd+Shift+R** (Ctrl+Shift+R on Windows).

## Running locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```
Locally, the site still reads and writes the real GitHub repo set in `js/config.js`.
