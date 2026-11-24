"use client";

import { useEffect, useState } from "react";
import type { GpuNeed, GpuVendor, Hardware, Need, SizeNeed } from "@/lib/hardware";
import type { OS } from "@/lib/os";
import { OS_LABEL } from "@/lib/os";

// The Hardware tab on a manual: what the repo needs from the computer (graphics card, memory, disk), each with the
// line it came from. Asked for (app/api/hardware) only when the tab is opened, and kept for the visit. On the
// visitor's own system it also names their graphics chip, read in the browser and never sent anywhere.

type Answer = { hardware: Hardware; found: boolean };
const answers = new Map<string, Promise<Answer>>();
function load(repo: string): Promise<Answer> {
  if (!answers.has(repo)) {
    const p = fetch(`/api/hardware?repo=${encodeURIComponent(repo)}`).then(async (r) => {
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't read it.");
      return (await r.json()) as Answer;
    });
    answers.set(repo, p);
    p.catch(() => answers.delete(repo)); // try again next time
  }
  return answers.get(repo)!;
}

const VENDOR: Record<GpuVendor, string> = { nvidia: "NVIDIA (CUDA)", amd: "AMD (ROCm)", apple: "Apple Silicon (Metal / MLX)", any: "A graphics card" };
const SHORT: Record<GpuVendor, string> = { nvidia: "NVIDIA", amd: "AMD", apple: "Apple Silicon", any: "any" };
const label = (g: GpuNeed) => (g.kinds?.length ? `Most graphics cards (${g.kinds.map((k) => SHORT[k]).join(", ")}…)` : VENDOR[g.vendor]);
type Mine = { vendor: GpuVendor | "intel" | null; name: string };

// The graphics chip as the browser reports it ("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 …)"), or null when it won't say
// or it's a software stand-in.
function myGpu(): Mine | null {
  try {
    const gl = document.createElement("canvas").getContext("webgl") as WebGLRenderingContext | null;
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const raw = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    if (!raw || /swiftshader|llvmpipe|software|microsoft basic/i.test(raw)) return null;
    const vendor = /nvidia|geforce|quadro|\brtx\b/i.test(raw) ? "nvidia" : /\bamd\b|radeon/i.test(raw) ? "amd" : /apple/i.test(raw) ? "apple" : /intel/i.test(raw) ? "intel" : null;
    const name =
      /(GeForce [^(,]+|Quadro [^(,]+|RTX [^(,]+|Radeon[^(,]*|Apple M\d[^,)]*|Apple GPU|Intel\(R\) [^(,]+|Intel [^(,]+)/i.exec(raw)?.[1].trim() ?? raw.slice(0, 60);
    return { vendor, name: name.replace(/\s+/g, " ") };
  } catch {
    return null;
  }
}

const gb = (n: number) => (n < 1 ? `${Math.round(n * 1024)} MB` : `${Number.isInteger(n) ? n : n.toFixed(1)} GB`);
const levelText = (l: SizeNeed["level"]) => (l === "minimum" ? "minimum" : l === "recommended" ? "recommended" : "");

function Quote({ need, link }: { need: Need; link: (path: string) => string }) {
  return (
    <blockquote className="hw-quote">
      “{need.quote}”{" "}
      <a href={link(need.source)} target="_blank" rel="noreferrer">
        {need.source.split("/").pop()} ↗
      </a>
    </blockquote>
  );
}

function Sizes({ title, list, link }: { title: string; list: SizeNeed[]; link: (path: string) => string }) {
  if (!list.length) return null;
  return (
    <div className="hw-row">
      <h3>{title}</h3>
      {list.map((m) => (
        <div key={m.quote + m.gb}>
          <p className="hw-value">
            {gb(m.gb)} {levelText(m.level) && <span className="hw-level">{levelText(m.level)}</span>}
          </p>
          <Quote need={m} link={link} />
        </div>
      ))}
    </div>
  );
}

// How the visitor's graphics chip compares with what the repo asks for.
function verdict(gpu: GpuNeed[], cpuOk: boolean, mine: Mine | null): { tone: "yes" | "maybe" | "no"; text: string } | null {
  if (!gpu.length || !mine) return null;
  if (gpu.some((g) => g.kinds && mine.vendor && (g.kinds as string[]).includes(mine.vendor))) return { tone: "yes", text: `Yours: ${mine.name}, one of the kinds it supports.` };
  const named = gpu.filter((g) => g.vendor !== "any");
  if (!named.length) return { tone: "yes", text: `Yours: ${mine.name}.` };
  if (named.some((g) => g.vendor === mine.vendor)) return { tone: "yes", text: `Yours: ${mine.name}, the kind it uses.` };
  const required = named.some((g) => g.required === true) && !named.some((g) => g.required === false) && !cpuOk;
  const kinds = named.map((g) => SHORT[g.vendor]).join(" or ");
  return required
    ? { tone: "no", text: `Yours: ${mine.name}. It asks for ${kinds}, so it may not run here.` }
    : { tone: "maybe", text: `Yours: ${mine.name}. It uses ${kinds} when there is one; without it, it runs slower or with fewer features.` };
}

export function HardwarePanel({ repo, os, here, link }: { repo: string; os: OS; here: boolean; link: (path: string) => string }) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<Mine | null>(null);
  const [memory, setMemory] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    load(repo)
      .then((a) => live && setAnswer(a))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [repo]);
  useEffect(() => {
    if (!here) return;
    setMine(myGpu());
    const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    setMemory(typeof dm === "number" ? dm : null);
  }, [here]);

  const name = repo.split("/")[1];
  if (error) return <p className="panel hw-empty" role="alert">{error}</p>;
  if (!answer)
    return (
      <p className="hw-loading" role="status">
        Reading {name}&apos;s README, setup guide and project files…
      </p>
    );
  const h = answer.hardware;
  const gpuVerdict = here ? verdict(h.gpu, Boolean(h.cpuOnly), mine) : null;
  const minRam = Math.max(0, ...h.memory.filter((m) => m.level !== "recommended").map((m) => m.gb));
  const lowMemory = here && memory !== null && minRam > 0 && memory < 8 && memory < minRam;

  return (
    <div className="hw">
      <p className="hw-intro">
        What {name} needs from your computer, from its README, setup guide and project files. Not tested by gitmanual: each line links to where it&apos;s said.
      </p>
      {!answer.found ? (
        <p className="panel hw-empty">
          <b>No special hardware listed.</b> Its README, setup guide and project files don&apos;t mention a graphics card, memory or disk space it needs, so an
          ordinary {OS_LABEL[os]} computer should do.
        </p>
      ) : (
        <div className="hw-list">
          {h.gpu.length > 0 && (
            <div className="hw-row">
              <h3>Graphics card</h3>
              {h.gpu.map((g) => (
                <div key={g.vendor}>
                  <p className="hw-value">
                    {label(g)}{" "}
                    <span className={`hw-level${g.required === true ? " hw-req" : ""}`}>
                      {g.required === true ? "required" : g.required === false ? "optional" : "not stated"}
                    </span>
                  </p>
                  <Quote need={g} link={link} />
                </div>
              ))}
              {h.cpuOnly && (
                <div>
                  <p className="hw-value">Also runs without one, on the processor (slower)</p>
                  <Quote need={h.cpuOnly} link={link} />
                </div>
              )}
              {gpuVerdict && (
                <p className={`hw-mine hw-${gpuVerdict.tone}`}>
                  <span aria-hidden="true">{gpuVerdict.tone === "yes" ? "✓" : gpuVerdict.tone === "no" ? "✕" : "!"}</span> {gpuVerdict.text}
                </p>
              )}
            </div>
          )}
          <Sizes title="Graphics memory (VRAM)" list={h.vram} link={link} />
          <Sizes title="Memory (RAM)" list={h.memory} link={link} />
          {lowMemory && (
            <p className="hw-mine hw-maybe">
              <span aria-hidden="true">!</span> Your browser reports about {memory} GB of memory, less than the {gb(minRam)} it asks for.
            </p>
          )}
          <Sizes title="Disk space" list={h.disk} link={link} />
        </div>
      )}
      {(gpuVerdict || lowMemory) && <p className="hw-note">Your computer was checked in this browser. Nothing about it is sent to gitmanual.</p>}
    </div>
  );
}
