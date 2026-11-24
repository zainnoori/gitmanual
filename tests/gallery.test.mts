import assert from "node:assert/strict";
import { test } from "node:test";
import { gallery } from "../lib/gallery.ts";

const H = "https://github.com/acme/tool";

test("keeps README screenshots and resolves relative paths into the repo", () => {
  const md = `# Tool
![Main window](docs/screen.png)
<img src="./assets/demo.gif" alt="Demo" width="600">
![Upload](https://github.com/user-attachments/assets/2b0f1c4e-1234-4abc-9def-0123456789ab)
![Blob link](https://github.com/acme/tool/blob/main/shots/two.jpg)`;
  assert.deepEqual(gallery(md, H, "main"), [
    { src: "https://raw.githubusercontent.com/acme/tool/main/docs/screen.png", alt: "Main window", gif: false },
    { src: "https://raw.githubusercontent.com/acme/tool/main/assets/demo.gif", alt: "Demo", gif: true },
    { src: "https://github.com/user-attachments/assets/2b0f1c4e-1234-4abc-9def-0123456789ab", alt: "Upload", gif: false },
    { src: "https://github.com/acme/tool/raw/main/shots/two.jpg", alt: "Blob link", gif: false },
  ]);
});

test("leaves out badges, logos, svg, small images, other hosts and code examples", () => {
  const md = `[![Build](https://img.shields.io/badge/x-y-green.svg)](x)
<img src="assets/logo.png" width="120">
![chart](https://api.star-history.com/svg?repos=acme/tool)
![arch](docs/architecture.svg)
<img src="docs/small.png" width="64">
![elsewhere](https://example.com/shot.png)
\`\`\`md
![example](docs/in-code.png)
\`\`\`
![Brand](docs/brand-logo.png)
![Nuxt](.github/assets/banner.avif)
![site](public/og.jpg)
![ok](docs/ok.webp)`;
  assert.deepEqual(gallery(md, H, "main").map((s) => s.src), ["https://raw.githubusercontent.com/acme/tool/main/docs/ok.webp"]);
});

test("reference-style images, duplicates once, at most 8", () => {
  const many = Array.from({ length: 12 }, (_, i) => `![s${i}](s/${i}.png)`).join("\n");
  assert.equal(gallery(`${many}\n![again](s/0.png)`, H, "main").length, 8);
  assert.deepEqual(gallery("![shot][a]\n\n[a]: img/a.png", H, "dev").map((s) => s.src), ["https://raw.githubusercontent.com/acme/tool/dev/img/a.png"]);
  assert.deepEqual(gallery(undefined, H, "main"), []);
});
