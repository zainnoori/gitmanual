import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, inFolder, mainSubfolder } from "../lib/detect";

const tree = (paths: string[]) => paths.map((path) => ({ path, type: "blob" as const }));

// jub0t/Concat's shape: nothing to build at the root, the Cargo workspace in src/, the app in src/crates/concat.
const CONCAT = tree([
  "README.md",
  "flake.nix",
  "android-native/uniffi-bindgen/Cargo.toml",
  "src/Cargo.toml",
  "src/rust-toolchain.toml",
  "src/crates/concat/Cargo.toml",
  "src/crates/concat/src/main.rs",
  "src/crates/concat-core/Cargo.toml",
  "src/crates/concat-core/src/lib.rs",
]);

test("a project kept whole in one folder is found", () => {
  assert.equal(mainSubfolder(CONCAT), "src");
  assert.deepEqual(
    inFolder(CONCAT, "src").map((e) => e.path),
    ["Cargo.toml", "rust-toolchain.toml", "crates/concat/Cargo.toml", "crates/concat/src/main.rs", "crates/concat-core/Cargo.toml", "crates/concat-core/src/lib.rs"],
  );
});

test("the root stays the project when it has one, or when two folders could be", () => {
  assert.equal(mainSubfolder(tree(["Cargo.toml", "src/Cargo.toml"])), null);
  assert.equal(mainSubfolder(tree(["Avalonia.slnx", "nukebuild/_build.csproj"])), null); // .NET solution at the root
  assert.equal(mainSubfolder(tree(["build.zig", "raycast/package.json"])), null); // a Zig app with a Raycast add-on
  assert.equal(mainSubfolder(tree(["Brewfile", "frontend-qt/requirements.txt"])), null);
  assert.equal(mainSubfolder(tree(["README.md", "frontend/package.json", "backend/pyproject.toml"])), null);
  assert.equal(mainSubfolder(tree(["README.md", "examples/package.json"])), null); // examples aren't the project
  assert.equal(mainSubfolder(tree(["README.md", "docs/package.json", "app/package.json"])), "app");
});

test("the steps start in that folder, and the app crate is run", () => {
  const sub = inFolder(CONCAT, "src");
  const files = {
    "README.md": "# Concat\n",
    "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
    "rust-toolchain.toml": '[toolchain]\nchannel = "1.93.1"\n',
  };
  const a = analyze({ owner: "jub0t", repo: "Concat" }, files, new Set(), ["README.md", "flake.nix", ...sub.map((e) => e.path)], "Rust", null, {
    workdir: "src",
    treePaths: CONCAT.map((e) => e.path),
  });
  const mac = a.steps.mac;
  assert.deepEqual(mac[0].commands, ["git clone https://github.com/jub0t/Concat.git", "cd Concat/src"]);
  assert.match(mac[0].note ?? "", /lives in its src\/ folder/);
  assert.ok(a.stacks.includes("Rust"));
  assert.deepEqual(mac.find((s) => s.title === "Run it")?.commands, ["cargo run -p concat"]);
  // src/Cargo.toml is the project itself now; the crates inside it and the Android helper are still listed.
  assert.ok(!a.otherManifests.includes("src/Cargo.toml"));
  assert.ok(a.otherManifests.includes("android-native/uniffi-bindgen/Cargo.toml"));
});

test("a workspace crate named after the repo runs only when it's a program", () => {
  const ws = { "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n' };
  const run = (paths: string[], repo: string) =>
    analyze({ owner: "o", repo }, ws, new Set(), ["Cargo.toml", ...paths], "Rust").steps.linux.find((s) => s.title === "Run it")?.commands;
  assert.deepEqual(run(["crates/zed/Cargo.toml", "crates/zed/src/main.rs"], "zed"), ["cargo run -p zed"]);
  assert.equal(run(["crates/tauri/Cargo.toml", "crates/tauri/src/lib.rs"], "tauri"), undefined); // a library
  assert.equal(run(["crates/goose/Cargo.toml", "crates/goose/src/bin/a.rs", "crates/goose/src/lib.rs"], "goose"), undefined); // several programs
});
