"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RepoSummary } from "@/lib/db";
import type { Shot } from "@/lib/gallery";
import { ReportProblem } from "./report-problem";
import type { OS } from "@/lib/os";

// The manual's subtitle and tags, with the README's own pictures beside them as a small stack (lib/gallery.ts, shown
// from GitHub with a link back): hovering fans it out, a click or tap opens the viewer. With an AI summary of the
// README (lib/summary.ts) the subtitle is that summary instead of GitHub's one-line description: one line (two beside
// the pictures), then "Read more" opens the rest of it (what it can do, who it's for). That part is a <details>, so it's all in the page for
// search engines and works without JavaScript. children: the tags.
export function About({
  description,
  summary,
  shots,
  repo,
  readmeUrl,
  manual,
  children,
}: {
  description: string | null;
  summary: RepoSummary | null | undefined;
  shots: Shot[];
  repo: string;
  readmeUrl: string;
  manual: { repo: string; os: OS; steps: string[]; version: number } | null;
  children?: ReactNode;
}) {
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const shown = shots.filter((s) => !broken.has(s.src));
  const drop = (src: string) => setBroken((b) => new Set(b).add(src));
  const name = repo.split("/")[1];

  return (
    <div className={`intro${shown.length ? " intro-shots" : ""}`}>
      <div className="intro-text">
        {summary ? (
          <details className="about">
            <summary className="lead about-lead">
              <span className="about-text-line">{summary.what}</span>
              <span className="about-more">
                <span className="about-more-closed">Read more</span>
                <span className="about-more-open">Show less</span>
              </span>
            </summary>
            <div className="about-body">
              {summary.features.length > 0 && (
                <div>
                  <h3 className="about-label" id="about-can-h">
                    What it can do
                  </h3>
                  <ul className="about-features" aria-labelledby="about-can-h">
                    {summary.features.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
              )}
              {(summary.goodFor.length > 0 || summary.notFor.length > 0) && (
                <dl className="about-fit">
                  {summary.goodFor.length > 0 && (
                    <div className="fit-good">
                      <dt>Good for</dt>
                      {summary.goodFor.map((g) => (
                        <dd key={g}>{g}</dd>
                      ))}
                    </div>
                  )}
                  {summary.notFor.length > 0 && (
                    <div className="fit-not">
                      <dt>Not for</dt>
                      {summary.notFor.map((g) => (
                        <dd key={g}>{g}</dd>
                      ))}
                    </div>
                  )}
                </dl>
              )}
              <p className="about-note">
                Written by AI from the README.{" "}
                {manual && (
                  <ReportProblem mode="manual" manual={manual} kind="other" className="link">
                    Report a mistake
                  </ReportProblem>
                )}
              </p>
            </div>
          </details>
        ) : (
          description && <p className="lead">{description}</p>
        )}
        {children}
      </div>
      {shown.length > 0 && (
        <button
          type="button"
          className="shot-stack"
          onClick={() => setOpen(0)}
          aria-label={`Open ${shown.length === 1 ? "the picture" : `the ${shown.length} pictures`} from ${name}'s README`}
        >
          {shown
            .slice(0, 3)
            .reverse()
            .map((s) => (
              <span key={s.src} className="stack-sheet">
                <ShotImg shot={s} onError={drop} />
              </span>
            ))}
          {shown.length > 1 && <span className="stack-count">{shown.length}</span>}
        </button>
      )}
      {open !== null && shown.length > 0 && <Lightbox shots={shown} at={Math.min(open, shown.length - 1)} onAt={setOpen} readmeUrl={readmeUrl} />}
    </div>
  );
}

function ShotImg({ shot, onError }: { shot: Shot; onError: (src: string) => void }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- shown from GitHub as the README does, never copied or resized here
    <img src={shot.src} alt={shot.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => onError(shot.src)} />
  );
}

function Lightbox({ shots, at, onAt, readmeUrl }: { shots: Shot[]; at: number; onAt: (i: number | null) => void; readmeUrl: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const go = (step: number) => onAt((at + step + shots.length) % shots.length);
  const s = shots[at];
  return (
    <dialog
      ref={ref}
      className="shot-box"
      aria-label="Pictures from the README"
      onClose={() => onAt(null)}
      onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") go(1);
        if (e.key === "ArrowLeft") go(-1);
      }}
    >
      <figure>
        {/* eslint-disable-next-line @next/next/no-img-element -- see ShotImg */}
        <img src={s.src} alt={s.alt} referrerPolicy="no-referrer" />
        <figcaption>
          <span>{s.alt || "Picture from the README"}</span>
          <span className="shot-count">
            {at + 1} of {shots.length} ·{" "}
            <a href={readmeUrl} target="_blank" rel="noreferrer">
              On GitHub ↗
            </a>
          </span>
        </figcaption>
      </figure>
      {shots.length > 1 && (
        <>
          <button type="button" className="shot-nav shot-prev" onClick={() => go(-1)} aria-label="Previous picture">
            ‹
          </button>
          <button type="button" className="shot-nav shot-next" onClick={() => go(1)} aria-label="Next picture">
            ›
          </button>
        </>
      )}
      <button type="button" className="contact-close shot-close" onClick={() => ref.current?.close()} aria-label="Close">
        ×
      </button>
    </dialog>
  );
}
