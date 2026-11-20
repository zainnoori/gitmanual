import assert from "node:assert/strict";
import { test } from "node:test";
import { buildScript } from "../lib/script";

// Bodila51/gtavi-claudecode on Windows (2026-11-19): Python 3.12 was installed but not on PATH, so the script ran
// winget, which answered "No available upgrade found" with exit code -1978335189, and the script stopped there.
const steps = [
  { title: "Clone the repository", commands: ["git clone https://github.com/o/app.git", "cd app"] },
  { title: "Install the required runtimes", note: "Python 3.x (no version pinned)", commands: ["winget install Python.Python.3.12"] },
  { title: "Install dependencies", commands: ["python -m venv .venv", ".venv\\Scripts\\Activate.ps1", "pip install -r requirements.txt"] },
];

test("winget's 'already installed' doesn't stop a Windows script", () => {
  const { text } = buildScript(steps, "windows", "o/app", "https://gitmanual.com");
  assert.match(text, /function Skip-Installed \{ if \(\$LASTEXITCODE -in -1978335135, -1978335189\) \{ \$global:LASTEXITCODE = 0 \} \}/);
  assert.match(text, /Invoke-Step \{ winget install Python\.Python\.3\.12 -e --accept-source-agreements --accept-package-agreements; Skip-Installed \}/);
});

test("a Python reachable only through the py launcher is used", () => {
  const { text } = buildScript(steps, "windows", "o/app", "https://gitmanual.com");
  const lines = text.split("\n");
  const fallback = lines.findIndex((l) => l === "if (-not (Have 'python') -and (Have 'py')) { function python { py @args } }");
  assert.ok(fallback > lines.findIndex((l) => l.includes("winget install Python")));
  assert.ok(fallback < lines.findIndex((l) => l.includes("python -m venv")));
});

test("bash scripts are unchanged", () => {
  const { text } = buildScript(steps.map((s) => ({ ...s, commands: s.commands.map((c) => c.replace("winget install Python.Python.3.12", "brew install python")) })), "mac", "o/app", "https://gitmanual.com");
  assert.doesNotMatch(text, /Skip-Installed|function python/);
});
