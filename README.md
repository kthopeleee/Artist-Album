# Artist Album

A personal, Pinterest-style image board that lives entirely on GitHub. GitHub Pages hosts the site, and this repository stores the photos.

**Live site:** https://kthopeleee.github.io/Artist-Album/

- Drag images anywhere onto the page (or paste them, or click **Add photos**).
- Make folders, then drag photos onto a folder in the sidebar to move them. Drag a photo onto another photo to reorder.
- Click a photo to open it large. The side panel has the title, folder, download link and comments.
- Search finds text in titles, comments and file names.
- Works on phones: use **Select** or the folder menu inside a photo to move things, since phones can't drag.

## Who can do what

| | Needs |
|---|---|
| Look at the album | Just the link |
| Add, move, rename, delete, comment | A GitHub key, saved once per browser under **Edit access** |

### Getting a key (about 1 minute)
1. Go to https://github.com/settings/personal-access-tokens/new
2. Name it `Artist Album` and pick an expiration.
3. **Repository access** → *Only select repositories* → `Artist-Album`.
4. **Permissions** → *Repository permissions* → **Contents: Read and write**.
5. Generate it, then paste it into the site under **Edit access**.

### Letting friends edit
- **Quick way:** go to **Edit access** → *Let someone else edit* → **Copy invite link**. The link has your key built in, so anyone holding it can edit. To cancel every invite at once, delete the token on GitHub.
- **Safer way:** add them as a collaborator (repo **Settings → Collaborators**), so they make their own key.

## How big files are handled

GitHub has file and repository size limits, so images are shrunk in the browser **before** upload:

| | Size |
|---|---|
| Display copy | Longest side at most 2400 px, WebP (JPEG on Safari). A 15 MB phone photo usually becomes 0.3–1.5 MB. |
| Thumbnail | 600 px wide, around 30–80 KB. The grid only loads these, a batch at a time as you scroll. |
| Small JPG/PNG/WebP | Under 2 MB and already small enough: stored untouched, so pixel art stays crisp. |
| GIFs | Kept as-is so they still animate (up to 15 MB). |
| iPhone HEIC | Converted automatically. |

Other notes:
- Big batches are paced to stay under GitHub's write limits. If GitHub asks the site to slow down, it waits and carries on by itself.
- The sidebar shows storage used. GitHub recommends keeping a repo under about 1 GB, which is roughly 1,000–3,000 photos.
- Deleted photos leave the album, but they stay in the git history, so deleting does not free space.

Sizes are adjustable in [js/config.js](js/config.js).

## How it works

- **No server and no build step:** plain HTML, CSS and JavaScript ([index.html](index.html), [js/](js/)).
- **Data:**
  - [album/album.json](album/album.json) holds folders, titles and comments.
  - `album/images/` holds the display copies.
  - `album/thumbs/` holds the thumbnails.
- **Saving:** every change is a single git commit made straight from the browser with the GitHub API. Uploading 20 photos is one commit.
- **Several editors at once:** if two people save at the same moment, the second save is replayed on top of the first, so nothing is lost.
- **New photos:** they appear instantly for the uploader. Everyone else sees them about a minute later, once GitHub Pages redeploys. Until then they load from raw.githubusercontent.com.

## Running locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```
Locally, the site still reads and writes the real GitHub repo set in `js/config.js`.
