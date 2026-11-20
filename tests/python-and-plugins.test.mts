import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, presentPaths, readmePython } from "../lib/detect";
import { installChoices, readmeInstallCommands } from "../lib/install";
import { DEFAULT_PYTHON, pythonTarget, pythonVenv } from "../lib/os";
import { buildScript } from "../lib/script";

test("an unpinned Python gets a version with builds for the common packages, a pin stays", () => {
  assert.equal(pythonTarget(undefined), DEFAULT_PYTHON);
  assert.equal(pythonTarget("3.11.4"), "3.11"); // .python-version
  assert.equal(pythonTarget("==3.10.*"), "3.10");
  assert.equal(pythonTarget(">=3.8"), "3.13"); // not the minimum: Homebrew no longer has 3.8
  assert.equal(pythonTarget(">=3.14"), "3.14");
  assert.equal(pythonTarget(">=3.8,<3.12"), "3.11");
  assert.equal(pythonTarget(">=3.10,!=3.13.*"), "3.12");
  assert.equal(pythonTarget("~3.11"), "3.11");
});

test("the venv is made with the Python the manual installs", () => {
  assert.equal(pythonVenv("mac", { version: ">=3.10" }), "python3.13 -m venv .venv"); // not whatever python3 is (3.15)
  assert.equal(pythonVenv("linux", {}), "python3 -m venv .venv"); // Ubuntu has no plain python
  assert.equal(pythonVenv("linux", { version: "3.11", pinnedFile: true }), "python -m venv .venv"); // pyenv
  assert.equal(pythonVenv("windows", {}), "python -m venv .venv");
});

test("a README's minimum Python counts only when it's stated as one", () => {
  assert.equal(readmePython("Windows, macOS or Linux, Python 3.10+. An NVIDIA GPU makes it faster."), ">=3.10");
  assert.equal(readmePython("Requires Python >= 3.11"), ">=3.11");
  assert.equal(readmePython("Needs Python 3.9 or newer."), ">=3.9");
  assert.equal(readmePython("Tested on Python 3.8 and 3.12."), null);
});

// Bodila51/gtavi-claudecode (2026-11-19): Homebrew's Python 3.15 had no onnxruntime, ffmpeg was missing, and the
// README's install is a Claude Code plugin.
const README = [
  "```",
  "/plugin marketplace add Bodila51/gtavi-claudecode",
  "/plugin install gtavi-claudecode@gtavi-claudecode",
  "```",
  "| `setup` | Installs ffmpeg, yt-dlp and faster-whisper |",
  "Windows, macOS or Linux, Python 3.10+.",
].join("\n");
const paths = [".claude-plugin/marketplace.json", "README.md", "requirements.txt", "scripts/cut.py"];

test("the clip tool's manual: Python 3.13, FFmpeg, and the plugin install", () => {
  const files = { "README.md": README, "requirements.txt": "faster-whisper>=1.1\nyt-dlp[default]>=2026.10.26\n" };
  const a = analyze({ owner: "Bodila51", repo: "gtavi-claudecode" }, files, presentPaths(paths.map((path) => ({ path, type: "blob" as const }))), paths, "Python", null);
  assert.ok(a.tools.includes("FFmpeg"));
  const mac = a.steps.mac.flatMap((s) => s.commands);
  assert.ok(mac.includes("brew install python@3.13") && mac.includes("brew install ffmpeg") && mac.includes("python3.13 -m venv .venv"));
  assert.match(buildScript(a.steps.mac, "mac", "Bodila51/gtavi-claudecode", "https://gitmanual.com").text, /have python3\.13 \|\| brew install python@3\.13/);
  const [choice] = installChoices(readmeInstallCommands(README, { owner: "Bodila51", name: "gtavi-claudecode" }), { name: "gtavi-claudecode" });
  assert.equal(choice.label, "Recommended: Claude Code plugin");
  assert.equal(choice.command, "/plugin marketplace add Bodila51/gtavi-claudecode\n/plugin install gtavi-claudecode@gtavi-claudecode");
  assert.deepEqual(choice.needs, ["Claude Code"]);
});

test("a dependency that only sometimes calls FFmpeg is a hint, not a part", () => {
  const files = { "README.md": "# app\n", "requirements.txt": "gradio\npydub\n" };
  const a = analyze({ owner: "o", repo: "app" }, files, new Set(), ["README.md", "requirements.txt"], "Python", null);
  assert.ok(!a.tools.includes("FFmpeg"));
  assert.ok(a.hints.some((h) => /FFmpeg \(pydub uses it\)/.test(h)));
});

test("plugin installs pair with their own marketplace; local marketplaces aren't installs", () => {
  const two = "```\n/plugin install superpowers@claude-plugins-official\n```\n```\n/plugin marketplace add obra/superpowers-marketplace\n/plugin install superpowers@superpowers-marketplace\n```";
  assert.deepEqual(
    readmeInstallCommands(two, { owner: "obra", name: "superpowers" }).map((c) => c.command),
    ["/plugin install superpowers@claude-plugins-official", "/plugin marketplace add obra/superpowers-marketplace\n/plugin install superpowers@superpowers-marketplace"],
  );
  const local = '```\nclaude plugin marketplace add "$PWD/TokenEconomizer"\nclaude plugin install tokeneconomizer@tokeneconomizer\n```';
  assert.deepEqual(readmeInstallCommands(local, { owner: "microsoft", name: "TokenEconomizer" }), []);
});
