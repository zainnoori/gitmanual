import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze } from "../lib/detect";
import { fitCheck } from "../lib/fit";
import type { InstallOptions } from "../lib/install";

// jean-voila/FeurStagram's shape: an Android app shipped as .apk files in its releases, plus a Dockerfile that is
// only a build environment (JDK + Android SDK, no start command).

const DOCKERFILE = [
  "# Build environment: JDK 21 + Android SDK, nothing else.",
  "FROM eclipse-temurin:21-jdk-noble",
  "RUN apt-get update && apt-get install -y curl unzip git",
  "WORKDIR /work",
].join("\n");

const a = analyze(
  { owner: "jean-voila", repo: "FeurStagram" },
  { "README.md": "# FeurStagram\n\nGrab the latest APK from the Releases page and install it.", Dockerfile: DOCKERFILE },
  new Set(),
  ["README.md", "Dockerfile"],
);

test("a Dockerfile with no start command is a build environment, not a way to run the app", () => {
  assert.ok(!a.stacks.includes("Docker"));
  assert.ok(!a.tools.includes("Docker"));
  assert.ok(!a.steps.mac.some((s) => s.commands.some((c) => c.startsWith("docker run"))));
  assert.match(a.hints.join(" "), /build environment/);
});

test("a server base image or a start command still makes it a Docker app", () => {
  for (const Dockerfile of ["FROM nginx:alpine\nCOPY . /usr/share/nginx/html", "FROM node:22\nCMD [\"node\", \"server.js\"]"]) {
    const b = analyze({ owner: "x", repo: "site" }, { "README.md": "# Site", Dockerfile }, new Set(), ["README.md", "Dockerfile"]);
    assert.deepEqual(b.stacks, ["Docker"]);
  }
});

test("an .apk in the release answers the will-it-work question for the phone", () => {
  const install = {
    release: {
      tag: "v1",
      name: "v1",
      url: "https://github.com/jean-voila/FeurStagram/releases/tag/v1",
      publishedAt: "2026-11-15T00:00:00Z",
      prerelease: false,
      assets: [],
      deviceAssets: [{ name: "feurstagram.apk", url: "https://example.invalid/f.apk", size: 1, downloads: 1, kind: "apk", commands: [] }],
    },
    platforms: [],
    commands: [],
    declared: null,
    only: null,
    downloadPage: null,
  } as unknown as InstallOptions;
  const fit = fitCheck(a, install, "mac", "arm64", false);
  assert.equal(fit.status, "yes");
  assert.equal(fit.headline, "Yes, on your Android device");
  assert.match(fit.reasons[0], /Android app/);
});
