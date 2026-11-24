"use client";

import { About } from "./about";
import type { RepoSummary } from "@/lib/db";
import { gallery } from "@/lib/gallery";
import Link from "next/link";
import { Suspense, use, useEffect, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import type { Analysis } from "@/lib/detect";
import type { Guides } from "@/lib/guides";
import type { Alternative } from "@/lib/db";
import type { Contributor } from "@/lib/github";
import { beforeYouStart, type Fact } from "@/lib/facts";
import type { Pick } from "@/lib/picks";
import { fitCheck, freshness, setupTime } from "@/lib/fit";
import { compactCount } from "@/lib/format";
import { hasDownload } from "@/lib/facets";
// import { setupFlow } from "@/lib/flow"; — for the route diagram, see `flow` in Report
import { addonLinks, installChoices, venvFolder, withVenv, type Arch, type Asset, type InstallKind, type InstallOptions } from "@/lib/install";
import { OS_LABEL, OS_LIST, OS_SLUG, type OS } from "@/lib/os";
import { buildScript } from "@/lib/script";
import { proUrl, SIGNED_IN_COOKIE } from "@/lib/site";
// import { FlowMap } from "./flow"; — the route diagram, off the page for now
import { disconnect, fetchPrivate, PrivateAccess } from "./private";
import { CarbonAd } from "./carbon";
import { ArchitectureDiagram } from "./inspection-charts";
import { PaymentPending, REPO_PRICE, UnlockChoice } from "./buy-repo";
import { InspectDialog } from "./inspect-dialog";
import { ReportProblem } from "./report-problem";
import { SevIcon } from "./sev-icon";
import { GitHubMark } from "./github-mark";
import type { Inspection } from "@/lib/inspection/types";
import { BUCKETS, bucketOf, fixFirst, triage, verdict, type Teaser } from "@/lib/inspection/labels";
import { Chat } from "./chat";
import { CodeBlock, CopyButton, RepoForm, Wrenches, detectArch, detectOS, isPhone } from "./ui";

type Result = {
  meta: {
    fullName: string;
    description: string | null;
    branch: string;
    language: string | null;
    stars: number;
    license: string | null;
    htmlUrl: string;
    pushedAt: string;
    openIssues: number;
    topics: string[];
    archived: boolean;
    homepage: string | null;
    private?: boolean;
    createdAt?: string;
    ownerType?: "User" | "Organization";
    fileCount: number;
    treeTruncated: boolean;
  };
  analysis: Analysis;
  install: InstallOptions;
  guides: Guides;
  files: Record<string, string>;
  analyzedAt: number;
  cached: boolean;
  stale?: boolean;
  gone?: number; // when a re-read found the repo gone from GitHub (lib/pipeline.ts)
  summary?: RepoSummary | null; // the AI summary of the README, shown as the subtitle (lib/summary.ts)
  votes: Votes;
  version?: number; // the analysis version (lib/pipeline.ts)
};

type Votes = { worked: number; stuck: number; byOs: Record<string, { worked: number; stuck: number }>; saves?: number };

export type Mode = "install" | "source";

function archLabel(arch: Arch | null, os: OS): string | null {
  if (!arch) return null;
  if (arch === "universal") return "Universal";
  if (arch === "arm64") return os === "mac" ? "Apple Silicon" : "ARM64";
  if (arch === "x64") return os === "mac" ? "Intel" : "x64";
  if (arch === "x86") return "32-bit";
  return "ARMv7";
}

// README links are relative to the repo; point them at GitHub so they work here.
function repoUrl(url: string, key: string, htmlUrl: string, branch: string): string {
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url)) return defaultUrlTransform(url);
  const path = url.replace(/^\.?\//, "");
  const base = key === "src" ? `${htmlUrl.replace("github.com", "raw.githubusercontent.com")}/${branch}` : `${htmlUrl}/blob/${branch}`;
  return defaultUrlTransform(`${base}/${path}`);
}

function formatSize(bytes: number): string {
  return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

const inline = { p: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
// README code blocks: code-highlighting browser extensions (Prism) add a class and tabindex to <pre> before React
// loads, which React reports as a hydration mismatch. Only the <pre>'s own attributes are let through.
const blocks = { pre: ({ node: _node, ...props }: React.ComponentProps<"pre"> & { node?: unknown }) => <pre suppressHydrationWarning {...props} /> };

const LOADING_LINES = ["Opening the box…", "Reading the README…", "Counting the parts…", "Checking your device…", "Writing the steps…"];

export type { Result as ReportData };

export function defaultMode(r: Result): Mode {
  // Device-only downloads (.apk) are usually extras; the computer-side setup is the main path then. Unless our
  // steps are only "clone it": then the .apk is the way in.
  const apkOnly = !!r.install.release?.deviceAssets.length && Object.values(r.analysis.steps).every((s) => s.length <= 1);
  return r.install.platforms.length || r.install.commands.length || apkOnly ? "install" : "source";
}

// Without a server key, "Still stuck?" hands the manual to the visitor's own AI chat: the prompt goes in the link,
// and nothing is sent anywhere until they open it. Commands are trimmed so the link stays a sensible length.
function askPrompt(result: Result, os: OS, arch: Arch | null): string {
  const { meta, analysis: a } = result;
  const site = (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "");
  const shell = os === "windows" ? "PowerShell" : os === "mac" ? "zsh" : "bash";
  const chip = archLabel(arch, os);
  const needs = [...a.runtimes.map((r) => (r.detail ? `${r.name} ${r.detail}` : r.name)), ...a.tools, ...a.packageManagers.map((p) => p.name), ...a.services.map((s) => s.name)];
  const steps = a.steps[os].slice(0, 6).map((s, i) => {
    const cmds = s.commands.slice(0, 3).map((c) => (c.length > 120 ? `${c.slice(0, 117)}...` : c));
    return `${i + 1}. ${s.title}${cmds.length ? `: ${cmds.join(" ; ")}` : ""}`;
  });
  return [
    `I'm trying to set up ${meta.fullName} (${meta.htmlUrl}) on ${OS_LABEL[os]}${chip ? ` (${chip})` : ""} and I'm stuck.`,
    `Its setup manual on gitmanual: ${site}/${meta.fullName}/${OS_SLUG[os]}`,
    needs.length ? `It needs: ${needs.join(", ")}.` : "",
    steps.length ? `Suggested steps:\n${steps.join("\n")}` : "",
    `Walk me through the setup one step at a time, with ${shell} commands for ${OS_LABEL[os]}. Check the repo's README if you can. Before each step, tell me how to check it worked, and ask me for the exact error message if something fails.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function AskAi({ prompt, os }: { prompt: string; os: OS }) {
  const q = encodeURIComponent(prompt);
  return (
    <div className="panel ai">
      <div className="panel-head">
        <div>
          <h3>Still stuck? Ask an AI</h3>
          <p className="note">Opens a chat with this manual already filled in, for {OS_LABEL[os]}. It uses your own account; gitmanual sends nothing.</p>
        </div>
      </div>
      <div className="ask-ai">
        <a className="btn btn-sm btn-go" href={`https://claude.ai/new?q=${q}`} target="_blank" rel="noreferrer">
          Ask Claude
        </a>
        <a className="btn btn-sm" href={`https://chatgpt.com/?q=${q}`} target="_blank" rel="noreferrer">
          Ask ChatGPT
        </a>
        <CopyButton text={prompt} className="btn btn-sm" label="Copy the prompt" />
      </div>
    </div>
  );
}

// The page server-renders the manual (initial / initialError) so search engines and first paint get the real steps;
// the browser then switches to the visitor's own system. Fetching here only happens on "Re-read the repo".
export function ReportView({
  owner,
  repo,
  gitRef,
  initial = null,
  initialError = null,
  initialStatus = null,
  githubApp = false,
  initialOs = "mac",
  initialMode,
  picks = [],
  curator = "",
  aiGuide = false,
  chat = false,
  inspection = false,
  osPage = null,
  suggestions,
}: {
  // The "Deep Inspection" card (Pro) only shows when Pro is on for this site.
  inspection?: boolean;
  // Similar repos (see manual.tsx), streamed in after the manual. None for private repos.
  suggestions?: Promise<Suggestions>;
  // Set on /owner/repo/windows etc.: that system is the page's subject, so it isn't swapped for the visitor's.
  osPage?: OS | null;
  picks?: Pick[];
  curator?: string;
  // "Write my guide" only shows when the server has an Anthropic key.
  aiGuide?: boolean;
  // "Ask about this repo" only shows when chat is on for this site (app/chat.tsx).
  chat?: boolean;
  owner: string;
  repo: string;
  gitRef?: string;
  initial?: Result | null;
  initialError?: string | null;
  // 404 may mean private: the page then offers to open it with the visitor's own GitHub access (app/private.tsx).
  initialStatus?: number | null;
  githubApp?: boolean;
  initialOs?: OS;
  initialMode?: Mode;
}) {
  const [result, setResult] = useState<Result | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [line, setLine] = useState(0);
  const [guide, setGuide] = useState("");
  const [guideLoading, setGuideLoading] = useState(false);
  // Whether this repo and system already has a saved guide, and whether this visitor may write a new one.
  const [guideStatus, setGuideStatus] = useState<GuideStatus | null>(null);
  const [os, setOs] = useState<OS>(initialOs);
  const [detectedOs, setDetectedOs] = useState<OS | null>(null);
  // On a phone or tablet: there's no computer to detect (an iPhone isn't macOS), so nothing is marked "you".
  const [phone, setPhone] = useState(false);
  const [arch, setArch] = useState<Arch | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode ?? (initial ? defaultMode(initial) : "source"));
  const [refresh, setRefresh] = useState(0);
  const [status, setStatus] = useState<number | null>(initialStatus);
  // Opened with the visitor's GitHub access: re-reads go the same way, and nothing about it is saved.
  const [isPrivate, setIsPrivate] = useState(false);

  useEffect(() => {
    const d = detectOS();
    const onPhone = isPhone();
    setPhone(onPhone);
    setDetectedOs(onPhone ? null : d);
    if (!onPhone) detectArch().then(setArch);
    const q = new URLSearchParams(window.location.search);
    const qOs = q.get("os") as OS | null;
    setOs(osPage ?? (qOs && OS_LIST.includes(qOs) ? qOs : onPhone ? initialOs : d));
    const qMode = q.get("mode");
    if (refresh === 0 && (initial || initialError)) return;

    let cancelled = false;
    setResult(null);
    setLine(0);
    const tick = setInterval(() => setLine((l) => Math.min(l + 1, LOADING_LINES.length - 1)), 900);
    const url = `${owner}/${repo}${gitRef ? `/tree/${gitRef}` : ""}`;
    (isPrivate
      ? fetchPrivate(url)
      : fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, fresh: refresh > 0 }),
        })
    )
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          setStatus(res.status);
          throw new Error(data.error ?? "Request failed");
        }
        if (cancelled) return;
        setResult(data);
        setMode(qMode === "install" || qMode === "source" ? qMode : defaultMode(data));
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => clearInterval(tick));
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
    // initial/initialError only matter for the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo, gitRef, refresh]);

  // Guides are written per OS.
  useEffect(() => setGuide(""), [os]);
  useEffect(() => {
    setGuideStatus(null);
    if (!aiGuide || !result || result.meta.private) return;
    const url = `${result.meta.fullName}${gitRef ? `/tree/${gitRef}` : ""}`;
    fetch(`/api/guide?${new URLSearchParams({ url, os })}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: GuideStatus | null) => setGuideStatus(s))
      .catch(() => {});
  }, [aiGuide, result, gitRef, os]);

  // Keep the chosen OS and tab in the URL so a setup can be shared or bookmarked.
  useEffect(() => {
    if (!result) return;
    const params = new URLSearchParams(window.location.search);
    params.set("mode", mode);
    // On a per-system page the system is in the path, so switching moves to that system's page.
    if (osPage) params.delete("os");
    else params.set("os", os);
    const path = osPage ? `/${result.meta.fullName}/${OS_SLUG[os]}` : window.location.pathname;
    // The hash stays: #ask and #pdf open the chat and the PDF dialog when the page arrives with them.
    window.history.replaceState(null, "", `${path}?${params}${window.location.hash}`);
  }, [result, os, mode, osPage]);

  async function generateGuide() {
    if (!result) return;
    setGuide("");
    setGuideLoading(true);
    try {
      const res = await fetch("/api/guide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `${result.meta.fullName}${gitRef ? `/tree/${gitRef}` : ""}`, os }),
      });
      if (!res.body) throw new Error("No response body");
      // A new guide was written (not a saved one): one fewer left today.
      if (!res.headers.get("X-Guide-Cached") && res.ok) setGuideStatus((g) => g && { ...g, saved: true, left: g.left === null ? null : Math.max(0, g.left - 1) });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        setGuide((g) => g + decoder.decode(value, { stream: true }));
      }
    } catch (e) {
      setGuide((g) => `${g}\n\n**Error:** ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGuideLoading(false);
    }
  }

  if (error && (status === 404 || isPrivate)) {
    return (
      <PrivateAccess<Result>
        owner={owner}
        repo={repo}
        gitRef={gitRef}
        appAvailable={githubApp}
        onLoaded={(r) => {
          setIsPrivate(true);
          setError(null);
          setResult(r);
          const qMode = new URLSearchParams(window.location.search).get("mode");
          setMode(qMode === "install" || qMode === "source" ? qMode : defaultMode(r));
        }}
      />
    );
  }

  if (error) {
    return (
      <div className="wrap report-state">
        <p className="eyebrow">Missing parts</p>
        <h1 className="display-md">We couldn&apos;t open {owner}/{repo}</h1>
        <p className="lead">{error}</p>
        <RepoForm initial={`${owner}/${repo}`} size="sm" />
      </div>
    );
  }

  if (!result) {
    return (
      <div className="wrap report-state" aria-busy="true">
        <div className="unbox" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="eyebrow" translate="no">
          {owner}/{repo}
        </p>
        <h1 className="display-md" aria-live="polite">
          {LOADING_LINES[line]}
        </h1>
      </div>
    );
  }

  return (
    <Report
      result={result}
      os={os}
      detectedOs={detectedOs}
      phone={phone}
      arch={arch}
      onOs={setOs}
      mode={mode}
      onMode={setMode}
      guide={guide}
      guideLoading={guideLoading}
      guideStatus={guideStatus}
      onGuide={generateGuide}
      picks={picks}
      curator={curator}
      inspection={inspection}
      aiGuide={aiGuide}
      // Chat always reads the default branch, so it isn't offered on a branch's page.
      chat={chat && !gitRef}
      osPage={Boolean(osPage)}
      suggestions={suggestions}
      onRefresh={() => setRefresh((n) => n + 1)}
      onDisconnect={async () => {
        await disconnect();
        setResult(null);
        setStatus(404);
        setError("disconnected");
      }}
      onVotes={(votes) => setResult((r) => r && { ...r, votes })}
    />
  );
}

function Report({
  result,
  os,
  detectedOs,
  phone,
  arch,
  onOs,
  mode,
  onMode,
  guide,
  guideLoading,
  guideStatus,
  onGuide,
  onRefresh,
  onDisconnect,
  onVotes,
  picks,
  curator,
  aiGuide,
  chat,
  inspection,
  osPage,
  suggestions,
}: {
  inspection: boolean;
  suggestions?: Promise<Suggestions>;
  picks: Pick[];
  curator: string;
  aiGuide: boolean;
  chat: boolean;
  osPage: boolean;
  result: Result;
  os: OS;
  detectedOs: OS | null;
  phone: boolean;
  arch: Arch | null;
  onOs: (os: OS) => void;
  mode: Mode;
  onMode: (m: Mode) => void;
  guide: string;
  guideLoading: boolean;
  guideStatus: GuideStatus | null;
  onGuide: () => void;
  onRefresh: () => void;
  onDisconnect: () => void;
  onVotes: (v: Votes) => void;
}) {
  const { meta, analysis: a, install, guides, files } = result;
  // Private manuals are for the visitor alone: no votes, sharing, badge or saved AI guide, and the script is made here.
  const priv = Boolean(meta.private);
  const steps = a.steps[os];
  const myArch = os === detectedOs ? arch : null;
  const fit = fitCheck(a, install, os, myArch, meta.archived);
  // Made for another system (lib/platform.ts): the page points there instead of at a build that can't work here.
  const madeFor = install.only?.sure && install.only.os !== os ? install.only.os : null;
  // The route diagram ("How it fits together", app/flow.tsx) is off the page for now: it made the page heavier
  // than the three answers people come for. Its Mermaid still goes out with the API, Markdown and MCP.
  // const flow = setupFlow(a, install, os);
  const fresh = freshness(meta.pushedAt);
  const level = { Easy: 1, Moderate: 2, Involved: 3 }[a.difficulty.label];
  const setup = buildScript(steps, os, meta.fullName, process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000");
  // The README's own pictures, picked from the README already read (nothing stored): lib/gallery.ts.
  const shots = gallery(Object.entries(files).find(([p]) => /^readme(\.\w+)?$/i.test(p))?.[1], meta.htmlUrl, meta.branch);
  const setupFile = `/${meta.fullName}/setup/${os === "windows" ? "windows.ps1" : `${os}.sh`}`;
  const md = (text: string) => (
    <ReactMarkdown components={blocks} urlTransform={(url, key) => repoUrl(url, key, meta.htmlUrl, meta.branch)}>
      {text}
    </ReactMarkdown>
  );

  const parts = [
    ...(a.needsDevice ? [{ name: "Your device", detail: undefined, kind: "phone, tablet or TV with ADB" }] : []),
    ...a.runtimes.map((r) => ({ name: r.name, detail: r.detail, kind: "runtime" })),
    ...a.tools.map((t) => ({ name: t, detail: undefined, kind: "tool" })),
    ...a.packageManagers.map((p) => ({ name: p.name, detail: p.detail, kind: "package manager" })),
    ...a.services.map((s) => ({ name: s.name, detail: undefined, kind: "service" })),
  ];

  return (
    <div className="wrap report">
      <header className="sheet-head">
        <div>
          {/* Per-system pages say which system they're for; the main manual starts with the repo's name. */}
          {osPage && <p className="eyebrow">How to install on {OS_LABEL[os]}</p>}
          {/* The title, with Save (a bookmark) at its end: saving is about the repo, the PDF below is about the manual. */}
          <div className="title-row">
            <h1 className="display-md repo-title" translate="no">
              <a href={meta.htmlUrl} target="_blank" rel="noreferrer">
                <span className="owner">{meta.fullName.split("/")[0]}/</span>
                <wbr />
                {meta.fullName.split("/")[1]}
              </a>
            </h1>
            {!priv && <SaveButton repo={meta.fullName} os={os} />}
          </div>
          {/* Private manuals: GitHub's description only (no summary or pictures are made for them). */}
          <About
            description={meta.description}
            summary={priv ? null : result.summary}
            shots={priv ? [] : shots}
            repo={meta.fullName}
            readmeUrl={`${meta.htmlUrl}#readme`}
            manual={priv ? null : { repo: meta.fullName, os, steps: steps.map((s) => s.title), version: result.version ?? 0 }}
          >
          <div className="chips">
            {/* The language and the GitHub topics open the shelf filtered to the other manuals that share them. */}
            {(a.stacks.length ? a.stacks : [meta.language ?? "Unknown stack"]).map((s) =>
              s === meta.language ? (
                <Link className="chip" key={s} href={`/shelf?lang=${encodeURIComponent(s)}`} title={`More ${s} repos`}>
                  {s}
                </Link>
              ) : (
                <span className="chip" key={s}>
                  {s}
                </span>
              ),
            )}
            {meta.topics.slice(0, 4).map((t) =>
              /^[a-z0-9-]{1,50}$/i.test(t) ? (
                <Link className="chip ghost" key={t} href={`/shelf?topic=${t.toLowerCase()}`} title={`More repos tagged #${t}`}>
                  #{t}
                </Link>
              ) : (
                <span className="chip ghost" key={t}>
                  #{t}
                </span>
              ),
            )}
          </div>
          </About>
          {!priv && <Community votes={result.votes} />}
          <BeforeYouStart facts={beforeYouStart(result)} />
          {!priv && <DownloadManual repo={meta.fullName} os={os} steps={steps.length} />}
        </div>
        <div className="head-side">
          <dl className="spec">
            <div>
              <dt>Difficulty</dt>
              <dd>
                <Wrenches n={level} /> {a.difficulty.label}
              </dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd>{setupTime(a.difficulty.score)}</dd>
            </div>
            <div>
              <dt>Stars</dt>
              <dd className="num">★ {meta.stars.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Activity</dt>
              <dd>
                <span className={`dot ${fresh.tone}`} />
                {fresh.label}
              </dd>
            </div>
            {/* "Got it running" is in the header's community line (Community), from 5 votes up. */}
          </dl>
          {!priv && <CarbonAd className="ad-head" />}
        </div>
      </header>

      {priv ? (
        <p className="stamp-line private-line">
          <span className="private-tag">Private</span> Built just for you {timeAgo(result.analyzedAt)}, and not saved anywhere. Cloning it
          needs your own GitHub sign-in on this computer (<code>gh auth login</code> or an SSH key).
          <button className="link" onClick={onRefresh}>
            Re-read the repo
          </button>
          <button className="link" onClick={onDisconnect}>
            Disconnect
          </button>
        </p>
      ) : (
      <>
      {result.gone && (
        <p className="gone-line" role="note">
          <b>This repo is no longer on GitHub.</b> We found it gone {timeAgo(result.gone)}: it was deleted, made private, or its
          owner&apos;s account was removed. This is the last copy we read, so its links and downloads may not work. Don&apos;t
          install files from copies of it you find elsewhere unless you trust who made them.
        </p>
      )}
      <p className="stamp-line">
        {result.stale ? "GitHub didn't answer, so this is the saved copy from " : result.cached ? "Saved setup from " : "Fresh setup, read "}
        {timeAgo(result.analyzedAt)}
        {result.cached && (
          <button className="link" onClick={onRefresh}>
            Re-read the repo
          </button>
        )}
      </p>
      </>
      )}

      <section className={`fit fit-${fit.status}`} aria-labelledby="fit-h">
        <div className="fit-stamp" aria-hidden="true">
          {fit.status === "yes" ? "✓" : fit.status === "maybe" ? "?" : "✕"}
        </div>
        <div className="fit-body">
          <p className="eyebrow">Will it work on {OS_LABEL[os]}?</p>
          <h2 id="fit-h">{fit.headline}</h2>
          <ul>
            {fit.reasons.map((r) => (
              <li key={r}>
                <ReactMarkdown components={inline}>{r}</ReactMarkdown>
              </li>
            ))}
          </ul>
          {a.compatibility && (
            <details className="fit-list">
              <summary>Supported devices from the README: {a.compatibility.heading}</summary>
              <div className="prose">{md(a.compatibility.markdown)}</div>
            </details>
          )}
        </div>
        <div className="fit-device">
          <span className="eyebrow">{phone ? "Pick your computer" : "Your system"}</span>
          <div className="seg" role="radiogroup" aria-label="Operating system">
            {OS_LIST.map((o) => (
              // Real links, so search engines find each system's page; clicking just switches in place.
              <a
                key={o}
                href={`/${meta.fullName}/${OS_SLUG[o]}`}
                role="radio"
                aria-checked={o === os}
                className={o === os ? "on" : ""}
                onClick={(e) => {
                  e.preventDefault();
                  onOs(o);
                }}
              >
                {OS_LABEL[o]}
                {o === detectedOs && <span className="you">you</span>}
              </a>
            ))}
          </div>
          {phone ? <span className="note">On a phone: choose the computer you&apos;ll install it on.</span> : myArch && <span className="note">Your chip: {archLabel(myArch, os)}</span>}
        </div>
      </section>

      {fit.status !== "yes" && suggestions && (
        <Suspense fallback={null}>
          <Alts suggestions={suggestions} os={os} sure={fit.status !== "no"} />
        </Suspense>
      )}

      <StartHere
        meta={meta}
        guides={guides}
        os={os}
        way={installWay(install, os)}
        steps={steps.length}
        analysis={a}
        madeFor={madeFor}
        onOs={onOs}
        onGo={(id, m) => {
          if (m) onMode(m);
          requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
        }}
      />
      {/* <FlowMap flow={flow} onJump={...} /> — the route diagram, see the note on `flow` above. */}

      <div className={`sheet sheet-${mode}`}>
        <div className="sheet-main">
          <div className="tabs" role="tablist" aria-label="How to set it up" id="main-tabs">
            <button role="tab" aria-selected={mode === "install"} className={mode === "install" ? "on" : ""} onClick={() => onMode("install")}>
              Install it
              {install.platforms.length > 0 && <span className="count">{install.platforms.length}</span>}
            </button>
            <button role="tab" aria-selected={mode === "source"} className={mode === "source" ? "on" : ""} onClick={() => onMode("source")}>
              Build from source
              <span className="count">{steps.length}</span>
            </button>
          </div>

          {mode === "install" ? (
            <InstallPanel
              install={install}
              os={os}
              madeFor={madeFor}
              onOs={onOs}
              onSource={() => onMode("source")}
              repoName={meta.fullName.split("/")[1]}
              python={a.pythonPackage}
              addons={addonLinks(a.otherManifests, meta.htmlUrl, meta.branch)}
            />
          ) : (
            <>
              {madeFor && (
                <p className="panel made-for">
                  <b>Made for {OS_LABEL[madeFor]} only.</b> These steps build it, but the result only runs on {OS_LABEL[madeFor]}.{" "}
                  <button className="link" onClick={() => onOs(madeFor)}>
                    See the {OS_LABEL[madeFor]} setup
                  </button>
                </p>
              )}
              <RepoScript meta={meta} guides={guides} os={os} />
              {guides.doc && (
                <details className="panel guide-doc" id="maintainer-guide" open={steps.length <= 3}>
                  <summary>
                    <span className="eyebrow">From the maintainers</span>
                    <h3>
                      {guides.doc.label}: <code>{guides.doc.path}</code>
                    </h3>
                  </summary>
                  <div className="prose">{md(guides.doc.markdown)}</div>
                  <a className="release" href={`${meta.htmlUrl}/blob/${meta.branch}/${guides.doc.path}`} target="_blank" rel="noreferrer">
                    Open {guides.doc.path} on GitHub ↗
                  </a>
                </details>
              )}
              {a.readmeFirst && a.readme && (
                <div className="panel">
                  <h3>Before you start: {a.readme.heading}</h3>
                  <div className="prose">{md(a.readme.markdown)}</div>
                </div>
              )}
              <div className="steps-head" id="our-steps">
                <h2>
                  {steps.length} steps on {OS_LABEL[os]}
                </h2>
                {setup.steps.length > 1 && (
                  <div className="setup-btns">
                    <CopyButton text={setup.text} className="btn btn-sm" label="Copy as one script" />
                    {priv ? (
                      <button className="btn btn-sm" onClick={() => saveText(setup.filename, os === "windows" ? `\uFEFF${setup.text}` : setup.text)}>
                        Download {setup.filename}
                      </button>
                    ) : (
                      <a className="btn btn-sm" href={`${setupFile}?download=1`} download>
                        Download {setup.filename}
                      </a>
                    )}
                  </div>
                )}
              </div>
              {setup.steps.length > 1 && (
                <p className="setup-how">
                  Then run <code>{os === "windows" ? "powershell -ExecutionPolicy Bypass -File .\\setup.ps1" : "bash setup.sh"}</code>. It stops at
                  the first error and is safe to run again. Servers and tests aren&apos;t started; it lists them at the end.
                  {!priv && (
                    <>
                      {" "}
                      <a href={setupFile} target="_blank" rel="noreferrer">
                        Read it first
                      </a>
                      .
                    </>
                  )}
                </p>
              )}
              <ol className="steps">
                {steps.map((s, i) => (
                  <li key={s.title} className="step">
                    <span className="step-n" aria-hidden="true">
                      {i + 1}
                    </span>
                    <div className="step-body">
                      <h3>{s.title}</h3>
                      {s.note && (
                        <p className="note">
                          <ReactMarkdown components={inline}>{s.note}</ReactMarkdown>
                        </p>
                      )}
                      {s.commands.length > 0 && <CodeBlock text={s.commands.join("\n")} />}
                      {s.tips?.map((t) => (
                        <div className="tip" key={t}>
                          <ReactMarkdown components={inline}>{t}</ReactMarkdown>
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
              {inspection && !priv && steps.length > 1 && <InspectionNudge repo={meta.fullName} />}
              {a.osNotes[os].map((n) => (
                <p className="tip" key={n}>
                  <ReactMarkdown components={inline}>{n}</ReactMarkdown>
                </p>
              ))}
              {steps.length <= 1 && (
                <p className="empty">
                  We couldn&apos;t spot a known stack.{" "}
                  {aiGuide && !priv ? "The AI guide below can read the code for you." : "Start with the README, or ask an AI below to go through it with you."}
                </p>
              )}
              {!a.readmeFirst && a.readme && (
                <details className="panel">
                  <summary>
                    <h3>From the README: {a.readme.heading}</h3>
                  </summary>
                  <div className="prose">{md(a.readme.markdown)}</div>
                </details>
              )}
            </>
          )}

          {!priv && <DidItWork repo={meta.fullName} os={os} votes={result.votes} onVotes={onVotes} steps={steps.map((s) => s.title)} version={result.version ?? 0} />}

          {chat && !priv && <Chat repo={meta.fullName} os={os} />}

          {inspection && !priv && <ManualArchitecture repo={meta.fullName} />}

          {aiGuide && !priv && (
            <div className="panel ai">
              <div className="panel-head">
                <div>
                  <h3>Still stuck? Get a written guide</h3>
                  <p className="note">
                    GitManual AI Agent reads the {Object.keys(files).length} key files and writes a step-by-step guide for {OS_LABEL[os]}. Once written, it&apos;s saved for everyone.
                  </p>
                </div>
                <GuideButton status={guideStatus} loading={guideLoading} written={Boolean(guide)} onGuide={onGuide} page={`/${meta.fullName}/${OS_SLUG[os]}`} />
              </div>
              {guideStatus && !guideStatus.saved && !guide && (
                <p className="note guide-allowance">
                  {!guideStatus.signedIn
                    ? `New guides: 1 a day with GitHub sign-in${guideStatus.proOffer ? ", up to 20 with Pro" : ""}. Saved guides are free to read.`
                    : guideStatus.left === 0
                      ? guideStatus.pro
                        ? "You've written 20 new guides today, the fair-use limit. It resets at midnight UTC."
                        : `You've written today's free guide. More tomorrow${guideStatus.proOffer ? ", or up to 20 a day with Pro" : ""}.`
                      : `${guideStatus.left} new ${guideStatus.left === 1 ? "guide" : "guides"} left today${guideStatus.pro ? " (Pro)" : ""}.`}
                </p>
              )}
              {guide && <div className="prose">{md(guide)}</div>}
            </div>
          )}
          {(!aiGuide || priv) && <AskAi prompt={askPrompt(result, os, myArch)} os={os} />}

          {suggestions && (
            <Suspense fallback={null}>
              <Related suggestions={suggestions} name={meta.fullName.split("/")[1]} os={os} hideAlts={fit.status !== "yes"} />
            </Suspense>
          )}
        </div>

        <aside className="sheet-side">
          {/* Hidden when there's nothing to list: no parts to install and no settings. */}
          {(parts.length > 0 || a.envVars.length > 0) && (
          <div className="parts" id="parts">
            <h2 className="parts-h">Parts list</h2>
            {/* A ready-made app needs none of this: say so, rather than list Rust for someone downloading a .dmg. */}
            {mode === "install" && hasDownload(install, os) && parts.length > 0 && (
              <p className="parts-only">
                Only for{" "}
                <button className="link" onClick={() => onMode("source")}>
                  building from source
                </button>
                . The download above needs none of it.
              </p>
            )}
            {parts.length > 0 && (
              <ul>
                {parts.map((p) => (
                  <li key={`${p.kind}-${p.name}`}>
                    <span className="qty">1×</span>
                    <span>
                      <b>{p.name}</b> {p.detail && <code>{p.detail}</code>}
                      <span className="kind">{p.kind}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {a.envVars.length > 0 && (
              <details className="env">
                <summary>
                  <span className="qty">{a.envVars.length}×</span> settings in <code>.env</code>
                </summary>
                <ul>
                  {a.envVars.slice(0, 60).map((e) => (
                    <li key={e.name}>
                      <code>{e.name}</code>
                      {e.secret && <span className="secret">secret</span>}
                      {e.optional && <span className="optional">optional</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          )}

          {/* Deep Inspection after the parts: Pro's report, the free preview of a saved one, or what it would show. */}
          {inspection && !priv && <InspectionCard repo={meta.fullName} />}

          {!priv && <Contributors fullName={meta.fullName} htmlUrl={meta.htmlUrl} />}

          {!priv && (
            <div className="side-card">
              <h3>Share this manual</h3>
              <div className="share-btns">
                <CopyButton text={typeof window === "undefined" ? `/${meta.fullName}` : `${window.location.origin}/${meta.fullName}`} className="btn btn-sm" label="Copy the link" />
                <a className="btn btn-sm" href={`/${meta.fullName}/poster?download=1`} download>
                  Download a 1080×1080 poster
                </a>
              </div>
              {picks.length > 0 && (
                <div className="side-sub">
                  <h4>Featured in {curator}</h4>
                  {picks.slice(0, 2).map((p) => (
                    <a className="featured" key={p.url} href={p.url} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element -- small thumbnail of an already-sized poster */}
                      <img src={p.image} alt="" width={76} height={76} loading="lazy" />
                      <span>
                        <b>{p.kind === "reel" ? "▶ Watch the Reel" : "See the poster"} ↗</b>
                        {p.caption ? p.caption.split(/\r?\n/)[0].slice(0, 90) : "On Facebook"}
                      </span>
                    </a>
                  ))}
                </div>
              )}
              <BadgeCard fullName={meta.fullName} phone={phone} />
            </div>
          )}

          {(a.hints.length > 0 || (a.otherManifests.length > 0 && !phone && !hasDownload(install, os))) && (
            <div className="side-card">
              <h3>Good to know</h3>
              <ul className="hints">
                {a.hints.map((h) => (
                  <li key={h}>
                    <ReactMarkdown components={inline}>{h}</ReactMarkdown>
                  </li>
                ))}
                {/* Build files only matter to someone building it: not shown with a ready-made download, or on a phone. */}
                {a.otherManifests.length > 0 && !phone && !hasDownload(install, os) && (
                  <li>
                    Nested projects: <code>{a.otherManifests.slice(0, 4).join(", ")}</code>
                    {a.otherManifests.length > 4 ? ` and ${a.otherManifests.length - 4} more` : ""}
                  </li>
                )}
              </ul>
            </div>
          )}

          <details className="side-card">
            <summary>
              <h3>Details</h3>
            </summary>
            <dl className="side-facts">
              <div>
                <dt>License</dt>
                <dd>{meta.license && meta.license !== "NOASSERTION" ? meta.license : "Not detected"}</dd>
              </div>
              <div>
                <dt>Open issues</dt>
                <dd className="num">{meta.openIssues.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd>
                  <code>{meta.branch}</code>
                </dd>
              </div>
            </dl>
            {a.scripts.length > 0 && (
              <div className="side-sub">
                <h4>package.json scripts ({a.scripts.length})</h4>
                <ul className="scripts">
                  {a.scripts.slice(0, 25).map((s) => (
                    <li key={s.name}>
                      <code>{s.name}</code>
                      <span>{s.command}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="side-sub">
              <h4>Files we read ({Object.keys(files).length})</h4>
              <div className="files">
                {Object.keys(files)
                  .sort()
                  .map((f) => (
                    <div key={f}>{f}</div>
                  ))}
              </div>
              <p className="note">
                {meta.fileCount.toLocaleString()} files in the repo
                {meta.treeTruncated ? " (large repo, list truncated)" : ""}
              </p>
            </div>
          </details>
        </aside>
      </div>
    </div>
  );
}

function InstallPanel({
  install,
  os,
  madeFor,
  onOs,
  onSource,
  repoName,
  python,
  addons,
}: {
  install: InstallOptions;
  os: OS;
  madeFor?: OS | null;
  onOs?: (os: OS) => void;
  onSource: () => void;
  repoName: string;
  python?: Analysis["pythonPackage"];
  addons: Record<string, string>;
}) {
  const { release } = install;
  const assets = release?.assets.filter((a) => a.os === os) ?? [];
  const recommended = assets.find((a) => a.recommended);
  const others = assets.filter((a) => a !== recommended);
  const commands = install.commands.filter((c) => c.os.includes(os));
  const choices = installChoices(commands, { name: repoName }, python, { download: Boolean(recommended), addons });
  const folder = venvFolder(repoName);
  const otherOs = OS_LIST.filter((o) => o !== os && install.platforms.includes(o));
  // Apps the project publishes on its own site rather than in GitHub releases.
  const page = !assets.length && install.downloadPage?.platforms.includes(os) ? install.downloadPage : null;
  const pageCard = page && (
    <div className="panel">
      <div className="panel-head">
        <h3>Download for {OS_LABEL[os]}</h3>
        <a className="btn btn-sm btn-go" href={page.urls[os]} target="_blank" rel="noreferrer">
          Open {page.host} ↗
        </a>
      </div>
      <p className="note">The project publishes its {OS_LABEL[os]} app on its own website, not in GitHub releases. The README links to this page.</p>
    </div>
  );

  const devices = release?.deviceAssets ?? [];
  const deviceList = devices.map((d) => (
    <div className="asset primary" key={d.name}>
      <div className="asset-head">
        <div>
          <div className="asset-name">{d.name}</div>
          <div className="note">
            Android app · {formatSize(d.size)}
            {d.downloads ? ` · ${d.downloads.toLocaleString()} downloads` : ""}
          </div>
        </div>
        <a className="btn btn-go btn-sm" href={d.url}>
          Download
        </a>
      </div>
      <CodeBlock text={d.commands.join("\n")} />
    </div>
  ));
  // With an app for this computer too, the Android files are extra: one closed line after it, not a long card first.
  const deviceExtra = devices.length > 0 && (
    <details className="panel more device-more">
      <summary>
        Android / TV app ({devices.length} {devices.length === 1 ? "file" : "files"})
      </summary>
      <p className="note">Runs on the device. Download it, then install it from this computer with adb (turn on ADB debugging in the device&apos;s Developer Options first).</p>
      {deviceList}
    </details>
  );
  const deviceCard = devices.length > 0 && release && (
    <div className="panel">
      <div className="panel-head">
        <h3>Install on your Android / TV device</h3>
        <a className="release" href={release.url} target="_blank" rel="noreferrer">
          {release.name} · {new Date(release.publishedAt).toLocaleDateString()} ↗
        </a>
      </div>
      <p className="note">
        This app runs on the device, not on your {OS_LABEL[os]} computer. Download it, then install it from the computer with adb (turn on ADB
        debugging in the device&apos;s Developer Options first).
      </p>
      {deviceList}
    </div>
  );

  if (madeFor && !assets.length && !commands.length && !page)
    return (
      <div className="panel">
        <h3>Made for {OS_LABEL[madeFor]} only</h3>
        <p className="empty">
          There&apos;s no {OS_LABEL[os]} version, and building it yourself won&apos;t change that: its code uses {OS_LABEL[madeFor]}
          {OS_LABEL[madeFor].endsWith("s") ? "\u2019" : "\u2019s"} own system features.
        </p>
        <button className="btn btn-sm" onClick={() => onOs?.(madeFor)}>
          See the {OS_LABEL[madeFor]} setup →
        </button>
      </div>
    );
  if (!assets.length && !commands.length && !page) {
    return (
      <>
        {deviceCard}
        <div className="panel">
          <h3>No {OS_LABEL[os]} app in the box</h3>
          <p className="empty">
            {deviceCard
              ? `Your ${OS_LABEL[os]} computer only needs the tools from the source setup.`
              : `No ready-made ${OS_LABEL[os]} app or install command${release ? ` in ${release.tag}` : " (no GitHub releases)"}.`}
            {otherOs.length > 0 && <> There are apps for {otherOs.map((o) => OS_LABEL[o]).join(" and ")}.</>}
          </p>
          <button className="btn btn-sm" onClick={onSource}>
            Build it from source instead →
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {pageCard}
      {recommended && release && (
        <div className="panel">
          <div className="panel-head">
            <h3>Download for {OS_LABEL[os]}</h3>
            <a className="release" href={release.url} target="_blank" rel="noreferrer">
              {release.name}
              {release.prerelease ? " (pre-release)" : ""} · {new Date(release.publishedAt).toLocaleDateString()} ↗
            </a>
          </div>
          <AssetRow asset={recommended} os={os} primary />
          {others.length > 0 && (
            <details className="more">
              <summary>
                Other {OS_LABEL[os]} downloads ({others.length})
              </summary>
              {others.map((a) => (
                <AssetRow key={a.name} asset={a} os={os} />
              ))}
            </details>
          )}
        </div>
      )}

      {COMMAND_GROUPS.map((g) => {
        // Sorted and labelled (lib/install.ts installChoices): the one to use first, then smaller installs, optional
        // add-ons. The commands themselves stay exactly as the README has them.
        const list = choices.filter((c) => c.kind === g.kind);
        if (!list.length) return null;
        const venv = list.some((c) => c.venv);
        return (
          <div className="panel" key={g.kind}>
            <h3>{g.title}</h3>
            {g.note && <p className="note">{g.note}</p>}
            {list.filter((c) => c.role !== "library").length > 1 && (
              <p className="note">Choose one way. Most people should use the recommended one; the rest are other options.</p>
            )}
            {venv && (
              <div className="pm-cmd">
                <span className="method method-step">First: a virtual environment</span>
                <p className="note">
                  Python&apos;s own advice: install into a fresh environment, in its own folder (<code>~/{folder}</code>), so it can&apos;t
                  clash with other tools.
                </p>
                <CodeBlock text={withVenv("", os, folder).replace(/\n$/, "")} />
              </div>
            )}
            {list.map((c) => (
              <div className="pm-cmd" key={c.command}>
                <span className={`method method-${c.role}`}>{list.length > 1 || c.role !== "recommended" ? c.label : c.method}</span>
                {c.needs.length > 0 && <span className="pm-needs">Needs {c.needs.join(", ")}</span>}
                {c.note && (
                  <p className="note">
                    {c.note}
                    {c.link && (
                      <>
                        {" "}
                        <a href={c.link} target="_blank" rel="noreferrer">
                          Its setup ↗
                        </a>
                      </>
                    )}
                  </p>
                )}
                <CodeBlock text={c.command} />
                {c.script && <div className="warn">Pipes a remote script into your shell. Read it before running.</div>}
              </div>
            ))}
            <p className="note">From the README, exactly as the maintainers wrote it.</p>
          </div>
        );
      })}
      {deviceExtra}
    </>
  );
}

const COMMAND_GROUPS: { kind: InstallKind; title: string; note?: string }[] = [
  { kind: "app", title: "Install with a package manager" },
  { kind: "docker", title: "Run it with Docker", note: "A self-hosted app: Docker runs it on your computer and you open it in the browser. Needs Docker Desktop (or Docker Engine on Linux). Run docker compose commands inside the cloned repo folder." },
  { kind: "scaffold", title: "Start a new project with it", note: "Creates a fresh project folder set up with this framework. Run it where you keep your code, not inside this repo." },
  { kind: "library", title: "Use it in your own project", note: "This is a library: you add it to your code rather than opening an app." },
];

type InstallWay = { tag: string; title: string; sub: string };

// The easiest way to get it, for the "Start here" door. Null when the only way is from source.
function installWay(install: InstallOptions, os: OS): InstallWay | null {
  const label = OS_LABEL[os];
  const cmds = install.commands.filter((c) => c.os.includes(os));
  const app = cmds.find((c) => c.kind === "app");
  if (install.release?.assets.some((a) => a.os === os)) return { tag: "Download", title: "Get the ready-made app", sub: `Built for ${label}. No code needed.` };
  if (install.downloadPage?.platforms.includes(os))
    return { tag: "Download", title: "Get the ready-made app", sub: `From ${install.downloadPage.host}, for ${label}. No code needed.` };
  if (app)
    return {
      tag: "Install",
      title: /script/i.test(app.method) ? "Run the install script" : app.method === "Claude Code plugin" ? "Install it in Claude Code" : `Install it with ${app.method}`,
      sub: app.method === "Claude Code plugin" ? `${app.command.includes("\n") ? "Two lines" : "One line"}, typed inside Claude Code.` : `One command on ${label}.`,
    };
  if (install.release?.deviceAssets.length)
    return { tag: "Device app", title: "Install it on your device", sub: "An Android / TV app (.apk), installed from this computer." };
  if (cmds.some((c) => c.kind === "docker")) return { tag: "Docker", title: "Run it with Docker", sub: "Self-hosted: it opens in your browser." };
  const scaffold = cmds.find((c) => c.kind === "scaffold");
  if (scaffold) return { tag: "New project", title: "Start a project with it", sub: scaffold.command };
  const lib = cmds.find((c) => c.kind === "library");
  if (lib) return { tag: "Library", title: "Add it to your project", sub: lib.command };
  return null;
}

function AssetRow({ asset, os, primary }: { asset: Asset; os: OS; primary?: boolean }) {
  const arch = archLabel(asset.arch, os);
  return (
    <div className={`asset${primary ? " primary" : ""}`}>
      <div className="asset-head">
        <div>
          <div className="asset-name">{asset.name}</div>
          <div className="note">
            {asset.kind}
            {arch ? ` · ${arch}` : ""} · {formatSize(asset.size)}
            {asset.downloads ? ` · ${asset.downloads.toLocaleString()} downloads` : ""}
            {primary ? " · best match" : ""}
          </div>
        </div>
        <a className={`btn btn-sm${primary ? " btn-go" : ""}`} href={asset.url}>
          Download
        </a>
      </div>
      {asset.note && <div className="note">{asset.note}</div>}
      <CodeBlock text={asset.commands.join("\n")} />
    </div>
  );
}

// "Write my guide" (app/api/guide): reading a saved guide is free; writing a new one needs sign-in and an allowance.
type GuideStatus = { saved: boolean; signedIn: boolean; pro: boolean; left: number | null; proOffer: boolean };

function GuideButton({ status, loading, written, onGuide, page }: { status: GuideStatus | null; loading: boolean; written: boolean; onGuide: () => void; page: string }) {
  if (loading)
    return (
      <button className="btn btn-sm btn-go" disabled>
        <span className="spinner" />
        Writing…
      </button>
    );
  if (written)
    return (
      <button className="btn btn-sm btn-go" disabled>
        Written
      </button>
    );
  if (status && !status.saved && !status.signedIn)
    return (
      <a className="btn btn-sm btn-go" href={`/api/github/connect?signin=1&back=${encodeURIComponent(page)}`}>
        Sign in to write a guide
      </a>
    );
  if (status && !status.saved && status.left === 0)
    return status.proOffer && !status.pro ? (
      <a className="btn btn-sm btn-go" href={proUrl(page)}>
        Get Pro for more guides
      </a>
    ) : (
      <button className="btn btn-sm" disabled>
        Back tomorrow
      </button>
    );
  return (
    <button className="btn btn-sm btn-go" onClick={onGuide}>
      {status?.saved ? "Read the guide" : "Write my guide"}
    </button>
  );
}

// "Download the step-by-step guide" (the PDF manual): a dialog that shows what the PDF holds and who it's for, lets you pick a system (and
// remember it in this browser), then gives the right next step: the PDF or Markdown for Pro, sign in or Get Pro for
// everyone else. While Pro is off on the site, the PDF says "coming soon". Every PDF press
// by someone without Pro is counted (app/api/interest) for the demand numbers on /admin/chat. #pdf in the URL opens
// it, which is how it comes back open after signing in.
type ProStatus = { enabled: boolean; login?: string | null; pro?: boolean; bought?: boolean; prices?: { month: number; year: number; currency: string } | null };
// The PDF design is a private package (next.config.mjs); copies of gitmanual without it offer Markdown only.
const PDF_DESIGN = process.env.NEXT_PUBLIC_PDF_DESIGN === "on";
const SAVED_SYSTEM = "gitmanual-pdf-os";

const PDF_INSIDE: { icon: string; title: string }[] = [
  { icon: "M3 12h18M3 6h18M3 18h12", title: "The repo at a glance" },
  { icon: "M20 6 9 17l-5-5", title: "The recommended install, start to finish" },
  { icon: "M4 17l6-6-6-6M12 19h8", title: "Every other way, with what each needs" },
  { icon: "M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4", title: "Settings, links and a version stamp" },
];
const PDF_FOR = ["Offline setup", "Onboarding", "Client handover", "Workshops"];

function DownloadManual({ repo, os, steps }: { repo: string; os: OS; steps: number }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [system, setSystem] = useState<OS>(os);
  const [remember, setRemember] = useState(false);
  const [saved, setSaved] = useState<OS | null>(null);
  const [changing, setChanging] = useState(false);
  const [pro, setPro] = useState<ProStatus | null>(null);
  const [soon, setSoon] = useState(false);
  const [pending, setPending] = useState(false); // back from paying, not confirmed yet (?bought=pending)

  const open = () => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    if (!pro)
      fetch(`/api/pro?repo=${encodeURIComponent(repo)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j: ProStatus) => setPro(j))
        .catch(() => setPro({ enabled: false }));
  };

  useEffect(() => {
    let stored: OS | null = null;
    try {
      stored = localStorage.getItem(SAVED_SYSTEM) as OS | null;
    } catch {}
    if (stored && OS_LIST.includes(stored)) {
      setSaved(stored);
      setSystem(stored);
      setRemember(true);
    } else setSystem(os);
  }, [os]);

  // Back from signing in or paying (both return to #pdf): open again where they left off.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.has("bought")) {
      setPending(q.get("bought") === "pending");
      q.delete("bought");
      history.replaceState(null, "", `${window.location.pathname}${q.size ? `?${q}` : ""}${window.location.hash}`);
    }
    if (window.location.hash === "#pdf") open();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);

  const pick = (o: OS) => {
    setSystem(o);
    if (remember) save(true, o);
  };
  const save = (on: boolean, o = system) => {
    setRemember(on);
    try {
      if (on) localStorage.setItem(SAVED_SYSTEM, o);
      else localStorage.removeItem(SAVED_SYSTEM);
    } catch {}
    setSaved(on ? o : null);
  };

  const url = (format: "pdf" | "md") => `/api/download?${new URLSearchParams({ repo, os: system, format })}`;
  const back = `/${repo}/${OS_SLUG[os]}#pdf`;
  const countPdf = () =>
    fetch("/api/interest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feature: "pdf", repo }), keepalive: true }).catch(() => {});
  const name = repo.split("/")[1];
  const has = Boolean(pro?.pro || pro?.bought); // Pro, or this repo bought once
  const choose = Boolean(pro?.enabled && !has && pro.login && PDF_DESIGN); // signed in, neither: the two ways in

  return (
    <>
      <button type="button" className="btn dl-toggle" onClick={open} aria-haspopup="dialog">
        <PdfIcon /> Download the step-by-step guide
      </button>
      <small className="dl-sub">
        PDF for {OS_LABEL[os]}
        {steps > 1 && <> · {steps} steps</>} · works offline
      </small>
      <dialog
        ref={dialog}
        className="contact pdf-dialog"
        aria-labelledby="pdf-h"
        onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
        onClose={() => window.location.hash === "#pdf" && history.replaceState(null, "", window.location.pathname + window.location.search)}
      >
        <div className="contact-box">
          <div className="contact-head">
            <div>
              <h2 id="pdf-h">Take {name}&apos;s setup offline</h2>
              <p>A printable PDF of this page, made for one system. Also as Markdown.</p>
            </div>
            <button type="button" className="contact-close" onClick={() => dialog.current?.close()} aria-label="Close">
              ×
            </button>
          </div>

          <div className="pdf-body">
            <div className="pdf-preview" aria-hidden="true">
              <div className="pdf-sheet pdf-sheet-3">
                <span>3</span>
                <i />
                <i />
                <i className="pdf-code" />
              </div>
              <div className="pdf-sheet pdf-sheet-2">
                <span>2</span>
                <b>Install it</b>
                <i className="pdf-tag" />
                <i className="pdf-code" />
                <i />
                <i className="pdf-code" />
              </div>
              <div className="pdf-sheet pdf-sheet-1">
                <span>1</span>
                <em>
                  <small>{repo.split("/")[0]}/</small>
                  {name}
                </em>
                <i />
                <i className="pdf-short" />
                <div className="pdf-grid">
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
                <div className="pdf-qr" />
              </div>
            </div>

            <div className="pdf-side">
              <h3 className="pdf-label">What&apos;s inside</h3>
              <ul className="pdf-inside">
                {PDF_INSIDE.map((x) => (
                  <li key={x.title}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d={x.icon} />
                    </svg>
                    <span>{x.title}</span>
                  </li>
                ))}
              </ul>
              <h3 className="pdf-label pdf-for-label">Handy for</h3>
              <ul className="pdf-for">
                {PDF_FOR.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="pdf-foot">
            <div className="pdf-system">
              {saved && !changing ? (
                <p>
                  For <strong>{OS_LABEL[system]}</strong>, your saved system.{" "}
                  <button type="button" className="link" onClick={() => setChanging(true)}>
                    Change
                  </button>
                </p>
              ) : (
                <>
                  <div className="dl-systems" role="radiogroup" aria-label="System">
                    {OS_LIST.map((o) => (
                      <button key={o} type="button" role="radio" aria-checked={system === o} className={system === o ? "on" : ""} onClick={() => pick(o)}>
                        {OS_LABEL[o]}
                      </button>
                    ))}
                  </div>
                  <label className="pdf-remember">
                    <input type="checkbox" checked={remember} onChange={(e) => save(e.target.checked)} /> Remember my system
                  </label>
                </>
              )}
            </div>
            <div className="pdf-actions">
              {!pro ? (
                <button type="button" className="btn btn-go" disabled>
                  <span className="spinner" />
                </button>
              ) : !pro.enabled ? (
                <button
                  type="button"
                  className="btn btn-go"
                  disabled={soon}
                  onClick={() => {
                    setSoon(true);
                    countPdf();
                  }}
                >
                  <DownloadIcon /> {soon ? "Coming soon. Thank you!" : "Download PDF"}
                </button>
              ) : has && !PDF_DESIGN ? null : has ? (
                <a className="btn btn-go" href={url("pdf")}>
                  <DownloadIcon /> Download PDF
                </a>
              ) : pro.login ? (
                PDF_DESIGN ? null : (
                  <a className="btn btn-go" href={proUrl(`${back}`)} onClick={() => countPdf()}>
                    Get Pro to download <span className="dl-pro">Pro</span>
                  </a>
                )
              ) : (
                <a className="btn btn-go" href={`/api/github/connect?signin=1&back=${encodeURIComponent(back)}`} onClick={() => countPdf()}>
                  <GitHubMark /> Sign in to download
                </a>
              )}
              {pro?.enabled && has && (
                <a className="btn" href={url("md")} download>
                  <DownloadIcon /> Markdown
                </a>
              )}
            </div>
            {choose && pending && <PaymentPending />}
            {choose && <UnlockChoice repo={repo} back={back} prices={pro?.prices ?? null} onChoose={countPdf} />}
            <p className="pdf-note">
              {pro?.enabled && !has
                ? pro.login
                  ? choose
                    ? `Signed in as @${pro.login}.`
                    : `Signed in as @${pro.login}. Unlock ${name}'s PDF manuals and Deep Inspection for ${REPO_PRICE} once, or every repo's with Pro.`
                  : `Sign in with GitHub, then unlock ${name}'s PDF manuals and Deep Inspection for ${REPO_PRICE} once, or every repo's with Pro.`
                : has
                  ? "PDF to print or share; Markdown to keep with your notes or project. Made from the repo's own files, not tested by gitmanual."
                  : "Made from the repo's own files. Not tested by gitmanual: read every command before you run it."}
            </p>
          </div>
        </div>
      </dialog>
    </>
  );
}

// "How it fits together" on the manual (Pro): the diagram from the saved Deep Inspection, never a new one, so the free
// manual adds no Claude cost. Pro members without a report get a way to make one; everyone else a locked preview.
// The saved Deep Inspection for this repo, fetched once for the card and the diagram together. Reading it is free
// and never starts a new inspection.
type Saved = { signedIn: boolean; pro: boolean; bought?: boolean; inspection: Inspection | null; teaser: Teaser | null };
const savedCache = new Map<string, Promise<Saved | null>>();
function useSavedInspection(repo: string): Saved | null {
  const [state, setState] = useState<Saved | null>(null);
  useEffect(() => {
    let live = true;
    if (!savedCache.has(repo))
      savedCache.set(
        repo,
        fetch(`/api/inspection?repo=${encodeURIComponent(repo)}`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => (j ? { signedIn: Boolean(j.signedIn), pro: Boolean(j.pro), bought: Boolean(j.bought), inspection: j.inspection ?? null, teaser: j.teaser ?? null } : null))
          .catch(() => null),
      );
    savedCache.get(repo)!.then((v) => live && setState(v));
    return () => {
      live = false;
    };
  }, [repo]);
  return state;
}

// The Deep Inspection card beside the manual. With a saved report (Pro): the verdict, every check counted by how
// much it matters, and what to look at first, with the full report a click away. Otherwise: what it is, and the way in.
function InspectionCard({ repo }: { repo: string }) {
  const state = useSavedInspection(repo);
  const has = Boolean(state?.pro || state?.bought); // Pro, or this repo's report bought once
  const r = has ? state!.inspection : null;
  if (!has && state?.teaser) return <InspectionFree repo={repo} t={state.teaser} signedIn={state.signedIn} />;
  if (!r) return <InspectionTeaser repo={repo} pro={has} signedIn={Boolean(state?.signedIn)} />;
  return <InspectionPreview repo={repo} r={r} />;
}

// The free preview, for people without Pro on a repo that has a saved report: the real verdict and counts, the first
// thing to look at in full, the next ones locked (only their kind is known here).
function InspectionFree({ repo, t, signedIn }: { repo: string; t: Teaser; signedIn: boolean }) {
  const segs = (["blocker", "important", "improvement", "pass"] as const).filter((b) => t.counts[b] > 0);
  const label = (b: (typeof segs)[number]) => BUCKETS.find((x) => x.id === b)!.short.toLowerCase();
  const locked = t.locked.length + t.more;
  const found = t.counts.blocker + t.counts.important + t.counts.improvement;
  return (
    <section className="side-card insp-preview insp-free" aria-labelledby="insp-strip-h">
      <p className="insp-preview-top">
        <span className="insp-pro">Pro</span> Deep Inspection
      </p>
      <h2 id="insp-strip-h" className={`insp-preview-call v-${t.tone}`}>
        <SevIcon kind={t.tone === "no" ? "blocker" : t.tone === "maybe" ? "important" : "pass"} size={18} />
        {found > 0 ? (
          <span>
            We found <strong>{found} {found === 1 ? "thing" : "things"}</strong> to know before you install
          </span>
        ) : (
          t.title
        )}
      </h2>
      {found > 0 && <p className="insp-preview-counts">Verdict: {t.title}</p>}
      <div className="insp-strip-bar">
        <div className="insp-sevbar small" role="img" aria-label={segs.map((b) => `${t.counts[b]} ${label(b)}`).join(", ")}>
          {segs.map((b) => (
            <span key={b} className={`sb-seg b-${b}`} style={{ flexGrow: t.counts[b] }} />
          ))}
        </div>
        <span className="insp-preview-counts">{segs.map((b) => `${t.counts[b]} ${label(b)}`).join(" · ")}</span>
      </div>
      {t.first && (
        <ul className="insp-strip-list">
          <li>
            <SevIcon kind={t.first.bucket} />
            <span>
              <b>{t.first.title}</b> {t.first.text}
            </span>
          </li>
          {t.locked.map((b, i) => (
            <li key={i} className="insp-strip-locked" aria-hidden="true">
              <SevIcon kind={b} />
              <i style={{ width: i ? "48%" : "66%" }} />
            </li>
          ))}
        </ul>
      )}
      <div className="insp-strip-foot">
        <InspectDialog repo={repo} signedIn={signedIn} teaser={t} className="btn insp-preview-go">
          {locked > 0 ? `See the other ${locked} finding${locked === 1 ? "" : "s"} →` : `See all ${t.checks} checks →`}
        </InspectDialog>
        <span className="note">
          With Pro, or {REPO_PRICE} once for this repo · {t.checks} checks · {timeAgo(t.scannedAt)}
          {t.commit && <> · commit {t.commit.slice(0, 7)}</>}
        </span>
      </div>
    </section>
  );
}

// What the empty card asks, as a checklist nobody has ticked yet (the full list: INSPECTION_CHECKS).
const TEASER_CHECKS = ["Missing setup steps", "Hidden settings", "Version conflicts", "Exposed keys", "License risk"];

// Under the steps, on a repo with a saved report the visitor hasn't unlocked: the report's own numbers, never made up.
// Nothing when it found no concerns, or for Pro and buyers (their card shows the report).
function InspectionNudge({ repo }: { repo: string }) {
  const state = useSavedInspection(repo);
  const t = state?.teaser;
  if (!t || state.pro || state.bought) return null;
  const { blocker, important } = t.counts;
  if (!blocker && !important) return null;
  return (
    <p className="insp-nudge">
      <SevIcon kind={blocker ? "blocker" : "important"} />
      <span>
        That&apos;s the setup the README gives. Deep Inspection ran <strong>{t.checks} more checks</strong> on this repo:{" "}
        {blocker ? `${blocker} could stop your install.` : `${important} worth knowing first.`}{" "}
        <Link href={`/${repo}/inspection`}>See what →</Link>
      </span>
    </p>
  );
}

// The same card, greyed out, for anyone without a report to show: a sketch of what the preview holds (no real
// findings, those are Pro). Pro or bought: the whole card leads to the inspection page; otherwise its button opens
// the Deep Inspection dialog (app/inspect-dialog.tsx).
function InspectionTeaser({ repo, pro, signedIn }: { repo: string; pro: boolean; signedIn: boolean }) {
  const body = (
    <>
      <p className="insp-preview-top">
        <span className="insp-pro">Pro</span> Deep Inspection
      </p>
      <strong className="insp-teaser-title">Before you install: {TEASER_CHECKS.length} things the README won&apos;t tell you</strong>
      <span className="insp-checklist" role="list">
        {TEASER_CHECKS.map((c) => (
          <span role="listitem" key={c}>
            <span className="insp-q" aria-label="Not checked yet">
              ?
            </span>
            {c}
          </span>
        ))}
      </span>
      <span className="insp-teaser-pitch">Find out before you spend an hour setting it up.</span>
    </>
  );
  if (pro)
    return (
      <Link className="side-card insp-preview insp-teaser" href={`/${repo}/inspection`} aria-label="Inspect this repo with Deep Inspection">
        {body}
        <span className="btn insp-preview-go">Run the {TEASER_CHECKS.length} checks →</span>
      </Link>
    );
  return (
    <section className="side-card insp-preview insp-teaser">
      {body}
      <InspectDialog repo={repo} signedIn={signedIn} teaser={null} className="btn insp-preview-go">
        Run the {TEASER_CHECKS.length} checks · {REPO_PRICE}
      </InspectDialog>
      <span className="insp-preview-counts">Once for this repo, PDF guides included. Or every repo with Pro.</span>
    </section>
  );
}

export function InspectionPreview({ repo, r }: { repo: string; r: Inspection }) {
  const v = verdict(r);
  const t = triage(r);
  const first = fixFirst(r, 3);
  const urgent = t.blocker + t.important;
  const segs = BUCKETS.filter((b) => b.id !== "info" && t[b.id] > 0);
  return (
    <section className="side-card insp-preview" aria-labelledby="insp-prev-h">
      <p className="insp-preview-top">
        <span className="insp-pro">Pro</span> Deep Inspection
      </p>
      <h2 id="insp-prev-h" className={`insp-preview-call v-${v.tone}`}>
        <SevIcon kind={v.tone === "no" ? "blocker" : v.tone === "maybe" ? "important" : "pass"} size={18} />
        {v.title}
      </h2>
      <div className="insp-sevbar small" role="img" aria-label={segs.map((b) => `${t[b.id]} ${b.label.toLowerCase()}`).join(", ")}>
        {segs.map((b) => (
          <span key={b.id} className={`sb-seg b-${b.id}`} style={{ flexGrow: t[b.id] }} />
        ))}
      </div>
      <p className="insp-preview-counts">
        {segs.map((b) => `${t[b.id]} ${b.short.toLowerCase()}`).join(" · ")}
      </p>
      {first.length > 0 && (
        <>
          <h3>{urgent ? "Look at these first" : "Worth a look"}</h3>
          <ul>
            {first.map((x) => (
              <li key={x.id}>
                <SevIcon kind={bucketOf(x)} size={14} />
                <span>{x.title}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <Link className="btn btn-go insp-preview-go" href={`/${repo}/inspection`}>
        Open the full report →
      </Link>
    </section>
  );
}

function ManualArchitecture({ repo }: { repo: string }) {
  const state = useSavedInspection(repo);
  if (!state) return null;
  const name = repo.split("/")[1];
  const arch = state.inspection?.architecture;
  const has = state.pro || Boolean(state.bought);
  if (has && arch && arch.parts.length >= 2)
    return (
      <section className="man-arch" aria-labelledby="man-arch-h">
        <div className="man-arch-head">
          <h2 id="man-arch-h">How it fits together</h2>
          <Link href={`/${repo}/inspection`} className="man-arch-link">
            Full Deep Inspection →
          </Link>
        </div>
        <p className="note">{arch.summary}</p>
        <ArchitectureDiagram report={state.inspection!} />
      </section>
    );
  return (
    <section className="man-arch locked" aria-labelledby="man-arch-h">
      <div className="man-arch-sketch" aria-hidden="true">
        <svg viewBox="0 0 640 170" width="100%">
          {[[20, 60], [240, 20], [240, 100], [460, 60]].map(([x, y]) => (
            <rect key={`${x}-${y}`} x={x} y={y} width={160} height={52} rx={12} />
          ))}
          <path d="M180 86 C210 86 210 46 240 46 M180 86 C210 86 210 126 240 126 M400 46 C430 46 430 86 460 86 M400 126 C430 126 430 86 460 86" />
        </svg>
      </div>
      <div className="man-arch-lock">
        <h2 id="man-arch-h">See how {name} fits together</h2>
        <p>A diagram of its parts (app, server, database, outside services) and how they talk to each other, from its own files.</p>
        {/* Signed out: sign in first (it comes back here), then this repo once or Pro, as on the PDF and Deep Inspection. */}
        {has ? (
          <Link className="btn" href={`/${repo}/inspection`}>
            Inspect this repo
          </Link>
        ) : state.signedIn ? (
          <UnlockChoice repo={repo} back={`/${repo}/inspection`} prices={null} compact />
        ) : (
          <a className="btn" href={`/api/github/connect?signin=1&back=${encodeURIComponent(`/${repo}#man-arch-h`)}`}>
            <GitHubMark /> Sign in to see it
          </a>
        )}
      </div>
    </section>
  );
}

// Save to /profile/saved. Signed out, it signs in with GitHub and comes back with ?save=1, which saves it.
type SaveState = { login: string | null; save: { status: string } | null };

function SaveButton({ repo, os }: { repo: string; os: OS }) {
  const [state, setState] = useState<SaveState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (tipTimer.current && clearTimeout(tipTimer.current)), []);

  const send = async (method: "POST" | "DELETE", body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const r = await fetch("/api/saved", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo, ...body }) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (!r?.ok) return setError(j.error ?? "Couldn't save that right now.");
    setState({ login: j.login, save: j.save });
    // Just saved: a note under the bookmark for a few seconds, with the way to the list.
    if (tipTimer.current) clearTimeout(tipTimer.current);
    setJustSaved(method === "POST" && !body.status && Boolean(j.save));
    tipTimer.current = setTimeout(() => setJustSaved(false), 6000);
  };

  useEffect(() => {
    let live = true;
    // Never signed in here: no need to ask the server, the button is "sign in to save".
    if (!new RegExp(`(^|; )${SIGNED_IN_COOKIE}=`).test(document.cookie)) {
      setState({ login: null, save: null });
      return;
    }
    setState(null);
    fetch(`/api/saved?repo=${encodeURIComponent(repo)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then(async (j: SaveState) => {
        if (!live) return;
        setState({ login: j.login ?? null, save: j.save ?? null });
        // Back from signing in to save it.
        const q = new URLSearchParams(window.location.search);
        if (q.get("save") === "1") {
          q.delete("save");
          history.replaceState(null, "", `${window.location.pathname}${q.size ? `?${q}` : ""}${window.location.hash}`);
          if (j.login && !j.save) await send("POST", { os });
        }
      })
      .catch(() => live && setState({ login: null, save: null }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per repo
  }, [repo]);

  // "It works" on a saved repo: it's installed now.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ repo: string; os: OS }>).detail;
      if (d.repo === repo && state?.save && state.save.status !== "installed") send("POST", { os: d.os, status: "installed" });
    };
    window.addEventListener("gitmanual:worked", on);
    return () => window.removeEventListener("gitmanual:worked", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send only reads repo
  }, [repo, state]);

  if (!state)
    return (
      <span className="save-wrap">
        <button type="button" className="save-btn" disabled aria-busy="true" aria-label="Save">
          <BookmarkIcon />
        </button>
      </span>
    );
  if (!state.login) {
    const back = typeof window === "undefined" ? `/${repo}` : `${window.location.pathname}?save=1`;
    return (
      <span className="save-wrap">
        <a className="save-btn" href={`/api/github/connect?signin=1&back=${encodeURIComponent(back)}`} aria-label="Save (sign in with GitHub)" title="Save it: sign in with GitHub">
          <BookmarkIcon />
        </a>
      </span>
    );
  }
  const saved = Boolean(state.save);
  return (
    <span className="save-wrap">
      <button
        type="button"
        className={`save-btn${saved ? " on" : ""}`}
        aria-pressed={saved}
        aria-label={saved ? "Saved" : "Save"}
        disabled={busy}
        onClick={() => (saved ? send("DELETE", {}) : send("POST", { os }))}
        title={saved ? "Saved. Press to remove it from your saved repos" : "Save to your saved repos"}
      >
        <BookmarkIcon filled={saved} />
      </button>
      {error ? (
        <span className="save-tip error" role="alert">
          {error}
        </span>
      ) : (
        justSaved &&
        saved && (
          <span className="save-tip" role="status">
            Saved ✓ · <Link href="/profile/saved">Your saved repos →</Link>
          </span>
        )
      )}
    </span>
  );
}

function BookmarkIcon({ filled }: { filled?: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
    </svg>
  );
}

// The PDF button's icon: a page in wrench orange with its corner folded and an arrow down, so it reads as "a document
// to take with you" rather than a plain download.
function PdfIcon() {
  return (
    <svg className="pdf-icon" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
      <path d="M5 1.75h7.25L16 5.5v11.75a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1z" fill="var(--wrench)" />
      <path d="M12.25 1.75V5.5H16" fill="var(--sheet)" />
      <path d="M10 8.5v6M7.5 12l2.5 2.5 2.5-2.5" stroke="var(--ink)" strokeWidth="1.7" />
    </svg>
  );
}

// Saves text made in the browser as a file (private manuals have no server copy to download).
function saveText(filename: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function timeAgo(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// The ways in, best first: the maintainers' own website, guide and installer beat our generated steps.
// Is it free, does it use paid AI, is it maintained, can I trust it: what people ask before trying a project.
function BeforeYouStart({ facts }: { facts: Fact[] }) {
  return (
    <section className="facts" aria-labelledby="facts-h">
      <h2 id="facts-h" className="facts-h">
        Before you start
      </h2>
      <dl className="facts-grid">
        {facts.map((f) => (
          <div key={f.q} className={`fact fact-${f.tone}`}>
            <dt>{f.q}</dt>
            <dd>
              <b>{f.a}</b>
              <span title={f.why}>{f.why}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

type Door = { id: string; tag: string; title: string; sub: string; go?: () => void; href?: string };

// Similar repos as small cards, each opening its manual on the same system.
function AltCards({ list, os }: { list: Alternative[]; os: OS }) {
  return (
    <ul>
      {list.map((r) => (
        <li key={r.fullName}>
          <a href={`/${r.fullName}/${OS_SLUG[os]}`}>
            <span className="alt-name" translate="no">
              {r.fullName.split("/")[1]}
              <span className="num">★ {compactCount(r.stars)}</span>
            </span>
            {r.description && <span className="alt-desc">{r.description.replace(/:[a-z0-9_+-]+:\s*/g, "")}</span>}
          </a>
        </li>
      ))}
    </ul>
  );
}

// Similar repos for each system, from the server (manual.tsx): ones that run where this repo doesn't, and "More like this".
export type Suggestions = { alternatives: Partial<Record<OS, Alternative[]>>; related: Partial<Record<OS, Alternative[]>> };

// Under the system picker when this repo doesn't clearly run on the chosen system.
function Alts({ suggestions, os, sure }: { suggestions: Promise<Suggestions>; os: OS; sure: boolean }) {
  const list = use(suggestions).alternatives[os] ?? [];
  if (!list.length) return null;
  return (
    <aside className="alts" aria-labelledby="alts-h">
      <h3 id="alts-h">{sure ? `Prefer one that's sure to run on ${OS_LABEL[os]}? These similar projects do.` : `Doesn't run on ${OS_LABEL[os]}? These similar projects do.`}</h3>
      <AltCards list={list} os={os} />
    </aside>
  );
}

// "More like ollama that run on macOS": the end of every manual, so there's always somewhere to go next.
// It leaves out what the alternatives box above already shows.
function Related({ suggestions, name, os, hideAlts }: { suggestions: Promise<Suggestions>; name: string; os: OS; hideAlts: boolean }) {
  const s = use(suggestions);
  const shown = hideAlts ? (s.alternatives[os] ?? []).map((r) => r.fullName) : [];
  const list = (s.related[os] ?? []).filter((r) => !shown.includes(r.fullName));
  if (!list.length) return null;
  return (
    <section className="alts related" aria-labelledby="related-h">
      <h2 id="related-h">
        More like <span translate="no">{name}</span> that run on {OS_LABEL[os]}
      </h2>
      <AltCards list={list} os={os} />
    </section>
  );
}

function StartHere({
  meta,
  guides,
  os,
  way,
  steps,
  analysis: a,
  onGo,
  madeFor,
  onOs,
}: {
  meta: Result["meta"];
  guides: Guides;
  os: OS;
  way: InstallWay | null;
  steps: number;
  analysis: Analysis;
  onGo: (id: string, mode?: Mode) => void;
  madeFor?: OS | null;
  onOs?: (os: OS) => void;
}) {
  // Our steps are thin when we found little more than "clone it"; the project's own site is the better start then.
  // The maintainers' own guide or docs site beats our generated steps when there's no one-step install.
  const best = madeFor ? "switch" : way ? "install" : guides.doc ? "guide" : guides.docs ? "docs" : guides.website && (steps <= 2 || /^https?:\/\/docs\./.test(guides.website)) ? "website" : "steps";
  const all: Door[] = madeFor
    ? [
        // Made for another system: the only useful start is that system's page, and the project's site.
        { id: "switch", tag: `Made for ${OS_LABEL[madeFor]}`, title: `See the ${OS_LABEL[madeFor]} setup`, sub: `It doesn't run on ${OS_LABEL[os]}.`, go: () => onOs?.(madeFor) },
        ...(guides.website ? [{ id: "website", tag: "Website ↗", title: host(guides.website), sub: "The project's own site.", href: guides.website }] : []),
      ]
    : [
    ...(way ? [{ id: "install", ...way, go: () => onGo("main-tabs", "install") }] : []),
    ...(guides.doc
      ? [{ id: "guide", tag: "Setup guide", title: `Read the maintainers' ${guides.doc.label.toLowerCase()}`, sub: guides.doc.path, go: () => onGo("maintainer-guide", "source") }]
      : []),
    // One step is only "clone it": not worth a door when there's a better way in.
    ...(steps > 1 || (!way && !guides.doc)
      ? [{ id: "steps", tag: "Steps", title: `Follow our ${steps} ${steps === 1 ? "step" : "steps"}`, sub: `Copy-paste commands for ${OS_LABEL[os]}.`, go: () => onGo("our-steps", "source") }]
      : []),
    ...(guides.website ? [{ id: "website", tag: "Website ↗", title: host(guides.website), sub: "The project's own site.", href: guides.website }] : []),
    ...(guides.docs ? [{ id: "docs", tag: "Docs ↗", title: host(guides.docs), sub: "Linked from the README.", href: guides.docs }] : []),
    ...(guides.devcontainer
      ? [{ id: "codespaces", tag: "In the browser ↗", title: "Open in GitHub Codespaces", sub: "Nothing to install.", href: `https://codespaces.new/${meta.fullName}` }]
      : []),
  ];
  // One quick choice: the best start first, then up to two more, and the project's website always (as on the live
  // site); docs and Codespaces beyond that as plain links.
  const ordered = [...all.filter((d) => d.id === best), ...all.filter((d) => d.id !== best)];
  const doors = ordered.filter((d, i) => i < 3 || d.id === "website");
  const more = ordered.filter((d) => !doors.includes(d));
  // The one thing the doors can't show: what else has to be running or filled in before it works.
  const secrets = a.envVars.filter((e) => e.secret && !e.optional).length;
  const extras = [
    ...a.services.map((x) => x.name),
    ...(a.envVars.length ? [`${a.envVars.length} ${a.envVars.length === 1 ? "setting" : "settings"} in .env${secrets ? ` (${secrets} secret)` : ""}`] : []),
  ];
  // A single door ("Follow our steps") is no choice at all; the steps right below say the same.
  if (doors.length <= 1 && !extras.length) return null;
  return (
    <section className="start" aria-labelledby="start-h">
      <h2 id="start-h" className="start-h">
        Start here
      </h2>
      <div className="start-grid">
        {doors.map((d) => {
          const body = (
            <>
              <span className="door-tag">{d.tag}</span>
              <b translate={d.href ? "no" : undefined}>{d.title}</b>
              <span className="door-sub" translate={d.id === "guide" ? "no" : undefined}>
                {d.sub}
              </span>
            </>
          );
          const cls = `door${d.id === best ? " best" : ""}`;
          return d.href ? (
            <a key={d.id} className={cls} href={d.href} target="_blank" rel="noreferrer">
              {body}
            </a>
          ) : (
            <button key={d.id} className={cls} onClick={d.go}>
              {body}
            </button>
          );
        })}
      </div>
      {more.length > 0 && (
        <p className="start-more">
          Also:{" "}
          {more.map((d, i) => (
            <span key={d.id}>
              {i > 0 && " · "}
              {d.href ? (
                <a href={d.href} target="_blank" rel="noreferrer">
                  {d.tag.replace(" ↗", "")} ↗
                </a>
              ) : (
                <button className="link" onClick={d.go}>
                  {d.title}
                </button>
              )}
            </span>
          ))}
        </p>
      )}
      {extras.length > 0 && (
        <p className="start-heads">
          <span className="start-heads-tag">Heads-up</span>
          {way || guides.doc ? "Building it yourself? It also needs " : "It also needs "}
          {extras.map((x, i) => (
            <span key={x}>
              {i > 0 && (i === extras.length - 1 ? " and " : ", ")}
              <b>{x}</b>
            </span>
          ))}
          .{" "}
          <button className="link" onClick={() => onGo("parts")}>
            See the parts
          </button>
        </p>
      )}
    </section>
  );
}

// The setup or launch script the maintainers ship, at the top of "Build from source", where it gets used.
function RepoScript({ meta, guides, os }: { meta: Result["meta"]; guides: Guides; os: OS }) {
  const scripts = guides.scripts.filter((s) => s.windows === (os === "windows")).concat(guides.scripts.filter((s) => s.windows !== (os === "windows")));
  if (!scripts.length) return null;
  return (
    <div className="start-script">
      <span className="door-tag">{/^(start|run|launch|webui)/i.test(scripts[0].path.split("/").pop()!) ? "Launch script in the repo" : "Setup script in the repo"}</span>
      <p className="note">
        The maintainers included <code>{scripts[0].path}</code>.{" "}
        {scripts[0].run ? "Run it from the cloned folder after " : "Open it to see how it's meant to be run: "}
        <a href={`${meta.htmlUrl}/blob/${meta.branch}/${scripts[0].path}`} target="_blank" rel="noreferrer">
          {scripts[0].run ? "reading it" : `${scripts[0].path} on GitHub`}
        </a>
        .
      </p>
      {scripts[0].run && <CodeBlock text={scripts[0].run} />}
      {scripts.length > 1 && <p className="note">Also: {scripts.slice(1).map((s) => s.path).join(", ")}</p>}
    </div>
  );
}

// "Did you get it running?", and a way to say what went wrong (app/report-problem.tsx): offered to everyone, and
// first thing after "I got stuck".
function DidItWork({ repo, os, votes, onVotes, steps, version }: { repo: string; os: OS; votes: Votes; onVotes: (v: Votes) => void; steps: string[]; version: number }) {
  const storeKey = `gitmanual-vote:${repo.toLowerCase()}`;
  const [voted, setVoted] = useState<string | null>(null);
  useEffect(() => setVoted(localStorage.getItem(storeKey)), [storeKey]);
  const here = votes.byOs[os];

  async function vote(worked: boolean) {
    const res = await fetch("/api/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, os, worked }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const v = worked ? "worked" : "stuck";
    // A saved repo that works moves to "Installed" (SaveButton listens).
    if (worked) window.dispatchEvent(new CustomEvent("gitmanual:worked", { detail: { repo, os } }));
    localStorage.setItem(storeKey, v);
    setVoted(v);
    onVotes(data.votes);
  }

  return (
    <div className="panel vote" id="did-it-work">
      <div>
        <h3>{voted ? (voted === "worked" ? "Nice, it's running 🎉" : "Thanks, that helps others") : "Did you get it running?"}</h3>
        <p className="note">
          {here ? `On ${OS_LABEL[os]}: ${here.worked} got it running, ${here.stuck} got stuck.` : `No reports for ${OS_LABEL[os]} yet.`}
          {voted === "stuck" && " Tell us which step failed and we'll fix the manual, or ask the AI below."}
        </p>
        {voted !== "stuck" && (
          <ReportProblem mode="manual" manual={{ repo, os, steps, version }} kind="other" className="link vote-report">
            Something wrong with this manual?
          </ReportProblem>
        )}
      </div>
      {!voted ? (
        <div className="vote-btns">
          <button className="btn btn-sm vote-yes" onClick={() => vote(true)}>
            ✓ It works
          </button>
          <button className="btn btn-sm" onClick={() => vote(false)}>
            I got stuck
          </button>
        </div>
      ) : (
        voted === "stuck" && (
          <div className="vote-btns">
            <ReportProblem mode="manual" manual={{ repo, os, steps, version }} kind="step" className="btn btn-sm">
              Tell us what failed
            </ReportProblem>
          </div>
        )
      )}
    </div>
  );
}

// Under the tags: what other people did with this repo here. A number only shows from SHOWN_FROM up: "1 got it running"
// says less than nothing. Until then, a link to the vote below the steps, so the first votes come in.
const SHOWN_FROM = 5;
function Community({ votes }: { votes: Votes }) {
  const worked = votes.worked >= SHOWN_FROM ? votes.worked : 0;
  const saved = (votes.saves ?? 0) >= SHOWN_FROM ? votes.saves! : 0;
  const go = (e: React.MouseEvent) => {
    const el = document.getElementById("did-it-work");
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  };
  return (
    <p className="community">
      {worked > 0 && (
        <span>
          <span className="community-ok" aria-hidden="true">
            ✓
          </span>{" "}
          <b>{worked.toLocaleString("en-US")}</b> got it running
        </span>
      )}
      {saved > 0 && (
        <span>
          Saved by <b>{saved.toLocaleString("en-US")}</b>
        </span>
      )}
      <a href="#did-it-work" onClick={go}>
        {worked ? "Did it work for you?" : "Got it running? Tell others"}
      </a>
    </p>
  );
}

// For maintainers: a README badge that links newcomers to this manual.
function BadgeCard({ fullName, phone }: { fullName: string; phone?: boolean }) {
  // Open for the repo's owner (signed in as them); one folded line for everyone else, and always on a phone.
  const [mine, setMine] = useState(false);
  useEffect(() => {
    if (phone) return;
    let live = true;
    fetch("/api/pro", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: ProStatus) => live && setMine(Boolean(j.login) && j.login!.toLowerCase() === fullName.split("/")[0].toLowerCase()))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [fullName, phone]);
  const collapsed = phone || !mine;
  // The same address on the server and in the browser, so the Markdown never differs between the two.
  const site = (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "");
  const markdown = `[![Setup manual](${site}/${fullName}/badge.svg)](${site}/${fullName})`;
  const body = (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- a tiny SVG badge */}
      <img className="badge-preview" src={`/${fullName}/badge.svg`} alt="Setup manual badge" height={20} />
      <code className="badge-code">{markdown}</code>
      <CopyButton text={markdown} className="btn btn-sm" label="Copy the badge Markdown" />
    </>
  );
  if (collapsed)
    return (
      <details className="side-sub badge-more">
        <summary>Is this your repo? Add a badge to your README</summary>
        {body}
      </details>
    );
  return (
    <div className="side-sub">
      <h4>Is this your repo?</h4>
      <p className="badge-note">Add a badge to your README so newcomers find these steps.</p>
      {body}
    </div>
  );
}

// The people behind the repo: who has committed the most (app/api/contributors, kept for a day). Loaded after the
// page, since it's extra; the card stays out when GitHub has no list (empty repos, or ones too big for it to count).
function Contributors({ fullName, htmlUrl }: { fullName: string; htmlUrl: string }) {
  const [people, setPeople] = useState<Contributor[] | null>(null);
  useEffect(() => {
    let live = true;
    setPeople(null);
    fetch(`/api/contributors?repo=${encodeURIComponent(fullName)}`)
      .then((r) => (r.ok ? r.json() : { contributors: [] }))
      .then((j: { contributors?: Contributor[] }) => live && setPeople(j.contributors ?? []))
      .catch(() => live && setPeople([]));
    return () => {
      live = false;
    };
  }, [fullName]);
  if (!people?.length) return null;
  const top = people.slice(0, 3).map((p) => `@${p.login}`);
  const names = top.length > 1 ? `${top.slice(0, -1).join(", ")} and ${top[top.length - 1]}` : top[0];
  return (
    <div className="side-card contributors">
      <h3>Top contributors</h3>
      <ul className="contrib-strip">
        {people.map((p) => (
          <li key={p.login}>
            <a href={p.url} target="_blank" rel="noreferrer" title={`@${p.login} · ${p.commits.toLocaleString()} commit${p.commits === 1 ? "" : "s"}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- GitHub's own avatar, already the right size */}
              <img src={`${p.avatar}${p.avatar.includes("?") ? "&" : "?"}s=64`} alt={`@${p.login}`} width={32} height={32} loading="lazy" />
            </a>
          </li>
        ))}
      </ul>
      <p className="note">
        Most commits: {names}.{" "}
        <a href={`${htmlUrl}/graphs/contributors`} target="_blank" rel="noreferrer">
          See everyone&nbsp;↗
        </a>
      </p>
    </div>
  );
}
