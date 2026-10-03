// Settings for the album. Owner/repo are detected automatically on
// <owner>.github.io/<repo>; the values here are used when running locally.
export const CONFIG = {
  owner: 'kthopeleee',
  repo: 'Artist-Album',
  branch: 'main',

  albumPath: 'album/album.json',
  imageDir: 'album/images',
  thumbDir: 'album/thumbs',

  // Images are shrunk in the browser before upload so the repo stays small.
  fullMaxSide: 2400,      // longest side of the stored image, in px
  fullQuality: 0.85,
  thumbWidth: 600,        // grid thumbnails
  thumbQuality: 0.75,
  keepOriginalBelow: 2 * 1024 * 1024, // small JPG/PNG/WebP files are stored untouched
  gifMaxBytes: 15 * 1024 * 1024,      // GIFs are kept as-is (to stay animated) up to this size
  hardMaxBytes: 25 * 1024 * 1024,     // anything bigger after shrinking is refused

  // GitHub Pages won't publish a site whose current files exceed 1 GB.
  siteLimitBytes: 1024 * 1024 * 1024,
  // The whole repo including history: GitHub asks to stay under ~5 GB.
  repoLimitBytes: 5 * 1024 * 1024 * 1024,
  warnAt: 0.85,

  pageSize: 50, // cards rendered per scroll batch

  // Drawings vault: a separate PRIVATE repo (same owner) for drawing files.
  vaultRepo: 'Artist-Album-Drawings',
};

export function resolveRepo() {
  const host = location.hostname;
  if (host.endsWith('.github.io')) {
    const owner = host.slice(0, -'.github.io'.length);
    const first = location.pathname.split('/').filter(Boolean)[0];
    const repo = first && !first.includes('.') ? first : host;
    return { owner, repo, branch: CONFIG.branch };
  }
  return { owner: CONFIG.owner, repo: CONFIG.repo, branch: CONFIG.branch };
}
