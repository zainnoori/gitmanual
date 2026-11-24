"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { OS_LABEL, type OS } from "@/lib/os";
import { CONTACT_KINDS, PROBLEM_KINDS, PROBLEM_LIMITS, SITE_KINDS, type ProblemKind } from "@/lib/problems";

// One form, three places, one inbox (app/api/problems → /admin/problems):
//   manual  "Something wrong with this manual?": the repo, system, step and manual version filled in
//   site    the footer's "Report a problem": payments, signing in, a broken page
//   contact "Contact" (the footer, /contact, "Advertise here"): questions, feedback, advertising
export type FormMode = "manual" | "site" | "contact";
type Manual = { repo: string; os: OS; steps: string[]; version: number };

// Other parts of the page open the contact form, with a topic picked: "Advertise here" in the ad box, Pro's team card.
export const OPEN_CONTACT = "gitmanual:contact";
export const openContact = (kind?: ProblemKind) => window.dispatchEvent(new CustomEvent(OPEN_CONTACT, { detail: { kind } }));

const KINDS = { manual: PROBLEM_KINDS, site: SITE_KINDS, contact: CONTACT_KINDS };
const FIRST: Record<FormMode, ProblemKind> = { manual: "step", site: "site", contact: "question" };

export function ProblemForm({ mode, manual, kind: startKind, onDone }: { mode: FormMode; manual?: Manual; kind?: ProblemKind; onDone?: () => void }) {
  const id = useId();
  const [kind, setKind] = useState<ProblemKind>(startKind ?? FIRST[mode]);
  const [name, setName] = useState(""); // contact: how to address them
  const [about, setAbout] = useState(""); // site and contact: the repo they mean, if any
  const [step, setStep] = useState(0); // manual: 0 = not about one step
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState(""); // never shown: only bots fill it in
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (startKind) setKind(startKind);
  }, [startKind]);

  const steps = manual?.steps ?? [];
  const withSteps = mode === "manual" && steps.length > 1 && (kind === "step" || kind === "system" || kind === "question");
  const withError = mode !== "contact" && kind !== "question" && kind !== "missing" && kind !== "payment";
  const withRepo = (mode === "site" && kind === "manual") || (mode === "contact" && kind === "maintainer");

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    setProblem(null);
    try {
      const res = await fetch("/api/problems", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          repo: manual?.repo ?? (withRepo ? about : ""),
          os: manual?.os ?? "",
          page: window.location.pathname,
          kind,
          step: withSteps && step ? step : null,
          stepTitle: withSteps && step ? steps[step - 1] : null,
          name,
          message,
          error: withError ? error : "",
          email,
          version: manual?.version ?? 0,
          website,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (j.ok) return setState("sent");
      setProblem(j.error ?? "Couldn't send it just now. Try again in a minute.");
    } catch {
      setProblem("Couldn't reach gitmanual. Check your connection and try again.");
    }
    setState("idle");
  }

  if (state === "sent")
    return (
      <div className="rp-body">
        <p>
          <strong>Thanks, we&apos;ve got it.</strong>{" "}
          {mode === "manual" ? "We read every report and use it to fix this manual and others like it." : "We read every message."}
          {" We'll reply by email."}
        </p>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setState("idle");
            setMessage("");
            setError("");
            setStep(0);
            setAbout("");
            onDone?.();
          }}
        >
          {onDone ? (mode === "manual" ? "Back to the manual" : "Close") : "Send another"}
        </button>
      </div>
    );

  return (
    <form className="rp-body" onSubmit={send}>
      <fieldset className="rp-kinds">
        <legend>{mode === "contact" ? "What's it about?" : "What happened?"}</legend>
        {KINDS[mode].map((k) => (
          <label key={k.id} className={kind === k.id ? "on" : ""}>
            <input type="radio" name={`${id}-kind`} value={k.id} checked={kind === k.id} onChange={() => setKind(k.id)} />
            {k.label}
          </label>
        ))}
      </fieldset>

      {withSteps && (
        <label className="rp-field">
          <span>Which step?</span>
          <select value={step} onChange={(e) => setStep(Number(e.target.value))}>
            <option value={0}>Not sure, or more than one</option>
            {steps.map((s, i) => (
              <option key={i} value={i + 1}>
                {i + 1}. {s}
              </option>
            ))}
          </select>
        </label>
      )}

      {withRepo && (
        <label className="rp-field">
          <span>
            Which repo? <small>{mode === "contact" ? "owner/name" : "optional"}</small>
          </span>
          <input type="text" maxLength={200} value={about} onChange={(e) => setAbout(e.target.value)} placeholder="owner/name" spellCheck={false} />
        </label>
      )}

      <label className="rp-field">
        <span>{mode === "contact" || kind === "question" ? (kind === "question" ? "Your question" : "Your message") : "What went wrong?"}</span>
        <textarea
          required
          minLength={5}
          maxLength={PROBLEM_LIMITS.message}
          rows={mode === "contact" ? 5 : 3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={
            kind === "missing"
              ? "What did you have to do that the manual doesn't say?"
              : kind === "payment"
                ? "What happened, and roughly when? Which repo, if it was a one-time purchase."
                : kind === "advertising"
                  ? "What you'd like to advertise, and when."
                  : kind === "maintainer"
                    ? "What should change on its manual, or should it come down?"
                    : mode === "contact"
                      ? ""
                      : "What did you try, and what did you expect?"
          }
        />
      </label>

      {withError && (
        <label className="rp-field">
          <span>
            The error, if there was one <small>optional</small>
          </span>
          <textarea
            className="rp-code"
            maxLength={PROBLEM_LIMITS.error}
            rows={3}
            value={error}
            onChange={(e) => setError(e.target.value)}
            placeholder={mode === "site" ? "Paste the error message you saw. Leave out keys and passwords." : "Paste what the terminal printed. Leave out keys and passwords."}
            spellCheck={false}
          />
        </label>
      )}

      <div className={mode === "contact" ? "rp-pair" : undefined}>
        {mode === "contact" && (
          <label className="rp-field">
            <span>
              Your name <small>optional</small>
            </span>
            <input type="text" maxLength={PROBLEM_LIMITS.name} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
        )}
        <label className="rp-field">
          <span>
            Your email{" "}
            <small>
              {kind === "payment" ? "the one you paid with, so we can reply" : "so we can reply, never shared"}
            </small>
          </span>
          <input type="email" required maxLength={PROBLEM_LIMITS.email} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </label>
      </div>

      <label className="rp-trap" aria-hidden="true">
        Website
        <input type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </label>

      {problem && (
        <p className="key-error" role="alert">
          {problem}
        </p>
      )}
      <div className="rp-foot">
        <button type="submit" className="btn btn-go" disabled={state === "sending"} aria-busy={state === "sending"}>
          {state === "sending" ? "Sending…" : mode === "contact" ? "Send message" : "Send report"}
        </button>
        <small>
          {mode === "manual"
            ? "Sent with the repo, your system and this manual's version."
            : mode === "site"
              ? "Sent with the page you're on. Don't include card details."
              : "Goes straight to the people who run gitmanual."}
        </small>
      </div>
    </form>
  );
}

const HEAD: Record<FormMode, [string, string]> = {
  manual: ["Something wrong with this manual?", ""],
  site: ["Report a problem", "Payments, your account, or anything on gitmanual that isn't working."],
  contact: ["Contact", "Questions, feedback, advertising, or your repo's manual."],
};

// The form in a dialog, behind a button. The contact one also opens from elsewhere on the page (openContact).
export function ReportProblem({
  mode,
  manual,
  kind,
  className,
  children,
}: {
  mode: FormMode;
  manual?: Manual;
  kind?: ProblemKind;
  className: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [picked, setPicked] = useState<ProblemKind | undefined>(kind);
  const [round, setRound] = useState(0); // a fresh form each time it opens after sending
  const open = (k?: ProblemKind) => {
    setPicked(k ?? kind);
    dialog.current?.showModal();
  };
  useEffect(() => {
    if (mode !== "contact") return;
    const on = (e: Event) => open((e as CustomEvent<{ kind?: ProblemKind }>).detail?.kind);
    window.addEventListener(OPEN_CONTACT, on);
    return () => window.removeEventListener(OPEN_CONTACT, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open only reads the ref
  }, [mode]);
  const [title, sub] = HEAD[mode];

  return (
    <>
      <button type="button" className={className} onClick={() => open()} aria-haspopup="dialog">
        {children}
      </button>
      <dialog ref={dialog} className="contact rp-dialog" aria-labelledby={`${id}-h`} onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}>
        <div className="contact-box">
          <div className="contact-head">
            <div>
              <h2 id={`${id}-h`}>{title}</h2>
              <p>{manual ? `${manual.repo.split("/")[1]} on ${OS_LABEL[manual.os]}` : sub}</p>
            </div>
            <button type="button" className="contact-close" onClick={() => dialog.current?.close()} aria-label="Close">
              ×
            </button>
          </div>
          <ProblemForm
            key={round}
            mode={mode}
            manual={manual}
            kind={picked}
            onDone={() => {
              dialog.current?.close();
              setRound((r) => r + 1);
            }}
          />
        </div>
      </dialog>
    </>
  );
}
