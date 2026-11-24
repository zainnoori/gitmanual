// Screenshots for a manual's gallery, picked from its README: the pictures the README itself shows, never copied or
// stored. Only images GitHub hosts for the repo are used, so a visitor's browser only talks to GitHub (as it would on
// the README) and nobody else's server learns who opened the manual. Badges, logos, charts and tiny icons are left out.

export type Shot = { src: string; alt: string; gif: boolean };

const MAX = 8;
// Image hosts that belong to GitHub. user-attachments and user-images are what GitHub's editor uploads to; raw
// files come from the repo itself. Signed private-user-images links expire, so they're left out.
const GITHUB_HOSTS = /^https:\/\/(raw\.githubusercontent\.com|user-images\.githubusercontent\.com|github\.com)\//i;
const NOT_SHOTS =
  /shields\.io|badge|badgen|codecov|coveralls|travis-ci|circleci|star-history|starchart|contrib\.rocks|opencollective|buymeacoffee|ko-fi|paypal|sponsor|patreon|discord|twitter|logo|icon|favicon|avatar|emoji|readme-stats|github-readme|wakatime|visitor|hits\.|repobeats|skillicons|trendshift|producthunt|qr[-_]?code|banner|\/og\.\w+$|social[-_]?(preview|card)/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)$/i;

// A README address as an absolute GitHub one: relative paths point into the repo's files at that branch.
function resolve(url: string, htmlUrl: string, branch: string): string | null {
  const u = url.trim().replace(/^<|>$/g, "");
  if (/^https?:\/\//i.test(u)) {
    // github.com/owner/repo/blob/branch/x.png shows a page, not the picture; /raw/ is the picture.
    return u.replace(/^http:/i, "https:").replace(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/blob\//i, "$1/raw/");
  }
  if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u)) return null;
  const path = u.replace(/^\.?\//, "").split(/[?#]/)[0];
  if (!path || path.startsWith("../")) return null;
  return `${htmlUrl.replace("https://github.com", "https://raw.githubusercontent.com")}/${encodeURI(branch)}/${path}`;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
}

export function gallery(readme: string | undefined, htmlUrl: string, branch: string): Shot[] {
  if (!readme) return [];
  // Code blocks show examples, not the README's own pictures.
  const text = readme.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "");
  const found: { at: number; url: string; alt: string; width: number | null }[] = [];
  for (const m of text.matchAll(/!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^)]*["'])?\s*\)/g)) found.push({ at: m.index, url: m[2], alt: m[1], width: null });
  for (const m of text.matchAll(/<img\b[^>]*>/gi)) {
    const src = attr(m[0], "src");
    if (!src) continue;
    const w = Number(attr(m[0], "width")?.replace(/px$/i, ""));
    found.push({ at: m.index, url: src, alt: attr(m[0], "alt") ?? "", width: Number.isFinite(w) && w > 0 ? w : null });
  }
  // Reference-style images: ![alt][ref] with [ref]: url further down.
  const refs = new Map<string, string>();
  for (const m of text.matchAll(/^\s*\[([^\]]+)\]:\s*(\S+)/gm)) refs.set(m[1].toLowerCase(), m[2]);
  for (const m of text.matchAll(/!\[([^\]]*)\]\[([^\]]*)\]/g)) {
    const url = refs.get((m[2] || m[1]).toLowerCase());
    if (url) found.push({ at: m.index, url, alt: m[1], width: null });
  }

  const seen = new Set<string>();
  const shots: Shot[] = [];
  for (const f of found.sort((a, b) => a.at - b.at)) {
    const src = resolve(f.url, htmlUrl, branch);
    if (!src || !GITHUB_HOSTS.test(src) || seen.has(src)) continue;
    const path = src.split(/[?#]/)[0];
    const uploaded = /^https:\/\/github\.com\/user-attachments\/assets\/[\w-]+$/i.test(path);
    // A picture from the repo or an upload; svg is nearly always a badge, logo or diagram.
    if (!uploaded && !IMAGE_EXT.test(path)) continue;
    if (/^https:\/\/github\.com\//i.test(src) && !uploaded && !/\/raw\//.test(path)) continue;
    if (NOT_SHOTS.test(path) || NOT_SHOTS.test(f.alt)) continue;
    if (f.width !== null && f.width < 240) continue; // sized small in the README: an icon or a thumbnail
    seen.add(src);
    shots.push({ src, alt: f.alt.replace(/\s+/g, " ").trim().slice(0, 140), gif: /\.gif$/i.test(path) });
    if (shots.length >= MAX) break;
  }
  return shots;
}
