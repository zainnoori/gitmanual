"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Teaser } from "@/lib/inspection/labels";
import { REPO_PRICE, UnlockChoice } from "./buy-repo";
import { GitHubMark } from "./github-mark";

// What Deep Inspection checks, short: shared by this dialog and the locked inspection page (app/inspection.tsx).
export const INSPECTION_CHECKS = [
  "Steps, scripts and files the README skips",
  "Settings, services and accounts the code needs",
  "Version conflicts and known vulnerable dependencies",
  "Exposed keys and license concerns",
  "Tests, CI and how alive the project is",
];

const COUNT_LABEL = { blocker: "blocker", important: "important", improvement: "to improve" } as const;

// The real numbers from a saved report, when there is one: "Found 2 blockers · 5 important" (the free preview shows
// as much already).
export function FoundLine({ t }: { t: Teaser }) {
  const parts = (["blocker", "important", "improvement"] as const)
    .filter((b) => t.counts[b] > 0)
    .map((b) => `${t.counts[b]} ${COUNT_LABEL[b]}${b === "blocker" && t.counts[b] > 1 ? "s" : ""}`);
  return (
    <p className="insp-found">
      {parts.length ? (
        <>
          Found in this repo: <strong>{parts.join(" · ")}</strong>
        </>
      ) : (
        <>
          <strong>No concerns found</strong> across {t.checks} checks
        </>
      )}
    </p>
  );
}

// "Unlock Deep Inspection" on a manual: what it is, in short, and the two ways in (this repo once, or Pro), the
// same as the PDF dialog. Signed out, sign in first; it comes back to #inspect and opens again.
export function InspectDialog({
  repo,
  signedIn,
  teaser,
  children,
  className,
}: {
  repo: string;
  signedIn: boolean;
  teaser: Teaser | null;
  children: ReactNode;
  className: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [back, setBack] = useState(`/${repo}#inspect`);
  const name = repo.split("/")[1];
  const open = () => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  };
  useEffect(() => {
    setBack(`${window.location.pathname}#inspect`);
    if (window.location.hash === "#inspect") open();
  }, []);
  const report = `/${repo}/inspection`; // after paying: straight to the report

  return (
    <>
      <button type="button" className={className} onClick={open} aria-haspopup="dialog">
        {children}
      </button>
      <dialog
        ref={dialog}
        className="contact pdf-dialog"
        aria-labelledby="inspect-h"
        onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
        onClose={() => window.location.hash === "#inspect" && history.replaceState(null, "", window.location.pathname + window.location.search)}
      >
        <div className="contact-box">
          <div className="contact-head">
            <div>
              <h2 id="inspect-h">Deep Inspection for {name}</h2>
              <p>Reads the whole repo and checks its setup against its own files, before you spend time on it.</p>
            </div>
            <button type="button" className="contact-close" onClick={() => dialog.current?.close()} aria-label="Close">
              ×
            </button>
          </div>

          <div className="pdf-body">
            <div className="inspect-sketch" aria-hidden="true">
              {["A", "B", "C"].map((g) => (
                <div key={g} className="inspect-sketch-grade">
                  <b>{g}</b>
                  <i />
                </div>
              ))}
              <span className="insp-sevbar small">
                <span className="sb-seg b-blocker" style={{ flexGrow: 1 }} />
                <span className="sb-seg b-important" style={{ flexGrow: 3 }} />
                <span className="sb-seg b-pass" style={{ flexGrow: 8 }} />
              </span>
              <span className="insp-teaser-lines">
                <i style={{ width: "86%" }} />
                <i style={{ width: "64%" }} />
                <i style={{ width: "74%" }} />
              </span>
            </div>
            <div className="pdf-side">
              {teaser && <FoundLine t={teaser} />}
              <h3 className="pdf-label">What it checks</h3>
              <ul className="inspect-checks">
                {INSPECTION_CHECKS.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <p className="inspect-also">Each finding links to the lines behind it.</p>
            </div>
          </div>

          <div className="pdf-foot">
            {signedIn ? (
              <UnlockChoice repo={repo} back={report} />
            ) : (
              <>
                <a className="btn btn-go pro-btn" href={`/api/github/connect?signin=1&back=${encodeURIComponent(back)}`}>
                  <GitHubMark /> Sign in with GitHub to continue
                </a>
                <p className="pdf-note">Free to sign in. Then unlock {name}&apos;s Deep Inspection and PDF manuals for {REPO_PRICE} once, or every repo&apos;s with Pro.</p>
              </>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
