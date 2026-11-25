import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze } from "../lib/detect.ts";
import { fitCheck } from "../lib/fit.ts";
import { cpuNeed } from "../lib/hardware.ts";

const readme = (text: string) => ({ "README.md": text });
const noInstall = { release: null, commands: [], declared: null, platforms: [], downloadPage: null } as never;

test("cpu: an explicit arm64 requirement, with its system", () => {
  const n = cpuNeed(readme("## Requirements\n\n- An arm64 Linux host with PAC, 4K pages and at least 16 GB of RAM."));
  assert.deepEqual([n?.arch, n?.os], ["arm64", "linux"]);
  assert.equal(cpuNeed(readme("This tool is x86-64 only."))?.arch, "x64");
});

test("cpu: not a requirement", () => {
  for (const text of [
    "Requires Ubuntu 22.04 or 24.04 desktop (x86_64 or arm64).", // both kinds
    "- macOS: app-arm64.dmg\n- Linux: app-x86_64.AppImage", // downloads
    "Linux ARM64 now ships only the standard AppImage and tarball.", // packaging
    "You need a Mac with Xcode and an arm64 build of Python 3.12.", // not the machine
    "The game's own ARM64 code runs directly on Apple chips.", // describes the code
    "## Requirements\n\n- Linux x86-64 hosts\n- Linux ARM64 (aarch64) devices", // a list of supported ones
    "Tested on an arm64 Linux server.", // tested on
    "## API\n\n- [x86_64 only] Stop the microVM.", // a label on one command
    "## Linux\n\nThe AUR package is x86_64 only for now.\n\n## macOS\n\nApple Silicon and Intel builds.", // the other kind elsewhere
  ])
    assert.equal(cpuNeed(readme(text)), null, text);
  // A contributor guide's machine, outside its requirements, isn't the user's.
  assert.equal(cpuNeed({ "README.md": "# T", "CONTRIBUTING.md": "## Releasing\n\nThe remote machine must be arm64 host." }, { setupDoc: "CONTRIBUTING.md" }), null);
});

const linuxOnly = (extra = "") =>
  analyze(
    { owner: "a", repo: "b" },
    readme(`# Tool\n\nA kernel module for Linux desktops (Wayland).${extra}\n\n## Building and running\n\n1. \`scripts/build.sh\` (on the Linux host): builds it.\n2. \`scripts/run.sh\` (on the Linux host): runs it.`),
    new Set(["README.md", "scripts/build.sh"]),
    ["README.md", "scripts/build.sh", "scripts/run.sh"],
    null,
    "Runs on Linux desktops (Wayland)",
  );

test("fit: made for this system: yes when its code shows it, probably when only its description says so", () => {
  const a = linuxOnly();
  const sure = { ...(noInstall as object), only: { os: "linux", sure: true, signals: ["its C code uses Linux system headers"] } } as never;
  assert.deepEqual([fitCheck(a, sure, "linux", null, false).status, fitCheck(a, sure, "linux", null, false).headline], ["yes", "Yes, it's made for Linux"]);
  const said = { ...(noInstall as object), only: { os: "linux", sure: false, signals: ["it describes itself as made for Linux"] } } as never;
  assert.deepEqual([fitCheck(a, said, "linux", null, false).status, fitCheck(a, said, "linux", null, false).headline], ["maybe", "Probably made for Linux: follow its README"]);
  assert.equal(fitCheck(a, said, "mac", null, false).headline, "Probably Linux only");
});

test("fit: an arm64 requirement says no to x86, yes to arm64, maybe when the chip isn't known", () => {
  const a = linuxOnly("\n\n## Requirements\n\n- An arm64 Linux host with 16 GB of RAM.");
  assert.equal(a.cpu?.arch, "arm64");
  const install = { ...(noInstall as object), only: { os: "linux", sure: true, signals: ["its C code uses Linux system headers"] } } as never;
  const x86 = fitCheck(a, install, "linux", "x64", false);
  assert.deepEqual([x86.status, x86.headline], ["no", "Needs an arm64 (ARM) processor"]);
  assert.match(x86.reasons[0], /An arm64 Linux host/);
  assert.equal(fitCheck(a, install, "linux", "arm64", false).status, "yes");
  const unknown = fitCheck(a, install, "linux", null, false);
  assert.deepEqual([unknown.status, unknown.headline], ["maybe", "Only on arm64 (ARM) computers"]);
  // The requirement is for Linux: the Mac answer stays what it was (made for Linux only).
  assert.equal(fitCheck(a, install, "mac", "x64", false).headline, "Made for Linux only");
});
