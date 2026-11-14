import type { Bucket } from "@/lib/inspection/labels";
import type { Level } from "@/lib/inspection/types";

// One shape per bucket, so severity never rests on colour alone: a stop sign for blockers, a warning triangle for
// important concerns, a circle for improvements, a tick for passes, a dashed ring for what wasn't checked.
type IconKind = Bucket | Level;
export function SevIcon({ kind, size = 16 }: { kind: IconKind; size?: number }) {
  const k = kind === "good" ? "pass" : kind === "neutral" ? "info" : kind;
  return (
    <svg className={`sev sev-${k}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {k === "blocker" && (
        <>
          <path d="M5.2 1h5.6L15 5.2v5.6L10.8 15H5.2L1 10.8V5.2z" fill="var(--no)" stroke="var(--ink)" strokeWidth="1.2" />
          <path d="M8 4.2v4.6" stroke="var(--ink)" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="8" cy="11.4" r="1.1" fill="var(--ink)" />
        </>
      )}
      {(k === "important" || k === "note" || k === "risk") && (
        <>
          <path d="M8 1.3 15.1 14H.9z" fill={k === "risk" ? "var(--no)" : "var(--maybe)"} stroke="var(--ink)" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M8 5.6v4" stroke="var(--ink)" strokeWidth="1.7" strokeLinecap="round" />
          <circle cx="8" cy="11.8" r="1" fill="var(--ink)" />
        </>
      )}
      {k === "improvement" && (
        <>
          <circle cx="8" cy="8" r="6.4" fill="var(--steel-soft)" stroke="var(--ink)" strokeWidth="1.2" />
          <path d="M8 11V5.4M5.6 7.6 8 5.2l2.4 2.4" fill="none" stroke="var(--ink)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {k === "pass" && (
        <>
          <circle cx="8" cy="8" r="6.4" fill="var(--yes)" stroke="var(--ink)" strokeWidth="1.2" />
          <path d="m5 8.2 2 2 4-4.2" fill="none" stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {k === "unchecked" && <circle cx="8" cy="8" r="6.2" fill="none" stroke="var(--pencil)" strokeWidth="1.4" strokeDasharray="2.4 2" />}
      {k === "info" && (
        <>
          <circle cx="8" cy="8" r="6.4" fill="var(--sheet)" stroke="var(--pencil)" strokeWidth="1.2" />
          <path d="M8 7.2v4" stroke="var(--pencil)" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="4.9" r="0.95" fill="var(--pencil)" />
        </>
      )}
    </svg>
  );
}
