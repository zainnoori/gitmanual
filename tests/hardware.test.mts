import assert from "node:assert/strict";
import { test } from "node:test";
import { hardwareNeeds, hasHardware } from "../lib/hardware.ts";

const readme = (text: string, extra: Record<string, string> = {}) => hardwareNeeds({ "README.md": text, ...extra });

test("an NVIDIA GPU, required or optional, with the line it came from", () => {
  const req = readme("# Tool\n\nThis requires an NVIDIA GPU with CUDA 12.");
  assert.equal(req.gpu[0].vendor, "nvidia");
  assert.equal(req.gpu[0].required, true);
  assert.equal(req.gpu[0].quote, "This requires an NVIDIA GPU with CUDA 12.");
  assert.equal(req.gpu[0].source, "README.md");
  const opt = readme("- CUDA acceleration support for Nvidia GPUs\n- Runs on CPU-only machines too.");
  assert.equal(opt.gpu[0].required, false);
  assert.ok(opt.cpuOnly);
});

test("memory, graphics memory and disk, with minimum and recommended", () => {
  const h = readme("## System requirements\n\nRAM: 8 GB minimum, 16 GB recommended.\n\nYou need at least 6 GB of VRAM.\n\nThe first run downloads about 4 GB of models.");
  assert.deepEqual(h.memory.map((m) => [m.gb, m.level]), [[8, "minimum"]]);
  assert.deepEqual(h.vram.map((m) => [m.gb, m.level]), [[6, "minimum"]]);
  assert.deepEqual(h.disk.map((m) => m.gb), [4]);
  const both = readme("Runs on as low as 4GB vram + 8GB ram.");
  assert.equal(both.vram[0].gb, 4);
  assert.equal(both.memory[0].gb, 8);
});

test("not a need: chips in a download list, company names, terminals, changelogs, tested-on specs, commands", () => {
  const h = readme(`# App
- macOS (Apple Silicon): app-arm64.dmg
- Now supports NVIDIA NIM endpoints.
A GPU-accelerated terminal emulator.
[2026.5.9] v1.3.9 — CUDA 12 support
Tested on Windows 11, 32-core AMD, 62 GB RAM.
It has 16 GB of storage in the cloud plan for photos.
\`\`\`
docker run --gpus all -e MEM=16GB app
\`\`\``);
  assert.equal(hasHardware(h), false, JSON.stringify(h));
});

test("project files: a CUDA base image or a GPU-only package, when the README says nothing", () => {
  assert.equal(readme("# Tool", { Dockerfile: "FROM nvidia/cuda:12.2.0-runtime-ubuntu22.04\nRUN pip install x" }).gpu[0].source, "Dockerfile");
  assert.equal(readme("# Tool", { "requirements.txt": "numpy\nonnxruntime-gpu==1.17\n" }).gpu[0].vendor, "nvidia");
  assert.equal(readme("# Tool", { Dockerfile: "FROM python:3.12\nFROM cuda-deps AS build" }).gpu.length, 0);
});

test("a line listing several kinds of card means most cards will do", () => {
  const h = readme("Works on most GPUs: NVIDIA, AMD ROCm on Linux and Windows, Intel Arc, Apple Silicon.");
  assert.equal(h.gpu.length, 1);
  assert.equal(h.gpu[0].vendor, "any");
  assert.equal(h.gpu[0].required, false);
  assert.deepEqual(h.gpu[0].kinds, ["nvidia", "amd", "apple"]);
});

test("a feature that reads several kinds of card isn't a need", () => {
  assert.equal(readme("- GPU usage / power draw - Nvidia, AMD, and Intel.").gpu.length, 0);
});

test("the maintainers' setup guide counts too, quoted from its own file; CONTRIBUTING doesn't", () => {
  const files = { "README.md": "# Tool\nA tool.", "docs/INSTALL.md": "## Requirements\n\n- 16 GB RAM\n- An NVIDIA GPU with CUDA 12 is required.", "CONTRIBUTING.md": "Building needs at least 32 GB of RAM." };
  const h = hardwareNeeds(files);
  assert.deepEqual(h.memory.map((m) => [m.gb, m.source]), [[16, "docs/INSTALL.md"]]);
  assert.equal(h.gpu[0].source, "docs/INSTALL.md");
  assert.equal(h.gpu[0].required, true);
  // The guide the manual picked wins over a name match.
  const picked = hardwareNeeds({ ...files, "docs/setup-linux.md": "You need at least 8 GB of RAM." }, { setupDoc: "docs/setup-linux.md" });
  assert.deepEqual(picked.memory.map((m) => m.source), ["docs/setup-linux.md"]);
});

test(".env.example settings that point at a card", () => {
  assert.equal(readme("# Tool", { ".env.example": "PORT=3000\nCUDA_VISIBLE_DEVICES=0\n" }).gpu[0].vendor, "nvidia");
  assert.equal(readme("# Tool", { ".env.example": "# cpu, cuda or mps\nDEVICE=mps\n" }).gpu[0].vendor, "apple");
  assert.equal(readme("# Tool", { ".env.example": "DEVICE=cpu\nGPU_COUNT_LABEL=x\n" }).gpu.length, 0);
});

test("a guide's build notes, workarounds and SDKs aren't needs; its download sizes are", () => {
  const h = hardwareNeeds({
    "README.md": "# Tool",
    "BUILD.md": "## Building\n\nVulkan SDK from LunarG is required to build.\n\nWhen the driver's shader compiler crashes on NVIDIA GPUs, set X.\n\nThe model download is about 3 GB.",
    "INSTALL.md": "If you're running Wayland with an Nvidia GPU, use EGL.",
  });
  assert.equal(h.gpu.length, 0, JSON.stringify(h.gpu));
  assert.deepEqual(h.disk.map((d) => [d.gb, d.source]), [[3, "BUILD.md"]]);
});

test("quotes read as plain text", () => {
  assert.equal(readme("## Requirements\n\n- 1 GB RAM minimum (with [swap][swap], see [the docs](https://x.y))").memory[0].quote, "1 GB RAM minimum (with swap, see the docs)");
});

test("wrapped paragraphs are quoted whole; 'requires' about something else isn't a GPU need", () => {
  const h = hardwareNeeds({
    "README.md": "# Tool",
    "docs/gpu.mdx": "## Nvidia\nOllama supports Nvidia GPUs with compute capability\n5.0+ and driver version 550 and newer.\n\n## Vulkan\nVulkan requires additional capabilities or\nrunning as root to expose available VRAM data.\n\nIf the GPU fails, it falls back to running on the CPU.",
  });
  assert.equal(h.gpu[0].quote, "Ollama supports Nvidia GPUs with compute capability 5.0+ and driver version 550 and newer.");
  assert.equal(h.gpu[0].source, "docs/gpu.mdx");
  assert.deepEqual(h.gpu.map((g) => g.vendor), ["nvidia"]);
  assert.equal(h.cpuOnly?.quote, "If the GPU fails, it falls back to running on the CPU.");
  assert.equal(readme("# T\n\nThis app requires a dedicated GPU.").gpu[0].required, true);
});

test("folder tables, licenses and image captions aren't needs", () => {
  const h = readme(`## Requirements
- An arm64 Linux host with at least 16 GB of RAM.

*The hosted desktop at the end of a stress run, rendered on the CPU (no GPU bridge).*

## Repository layout and licenses
| Path | License | What |
| kexts/ | APSL-2.0 | The hosted system's kexts (CPU, disk, keystore, Metal accelerator, DRM bridge) |`);
  assert.equal(h.memory[0].gb, 16);
  assert.equal(h.gpu.length, 0, JSON.stringify(h.gpu));
  assert.equal(h.cpuOnly, null);
});
