import { gallery, type Shot } from "./gallery";

// What a manual page sends to the browser. The saved files (README, package files, ~60 KB on average and up to
// 500 KB) were most of every page, but the page only shows their names and the README's pictures: the names stay
// (with empty contents), the pictures are picked here. Anything that needs the contents asks for it when it's
// opened (the Hardware tab: app/api/hardware).
type Page = { files: Record<string, string>; meta: { private?: boolean; htmlUrl: string; branch: string } };
export function forBrowser<T extends Page>(d: T): T & { shots: Shot[] } {
  const readme = Object.entries(d.files).find(([p]) => /^readme(\.\w+)?$/i.test(p))?.[1];
  return {
    ...d,
    files: Object.fromEntries(Object.keys(d.files).map((p) => [p, ""])),
    shots: d.meta.private ? [] : gallery(readme, d.meta.htmlUrl, d.meta.branch),
  };
}
