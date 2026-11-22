"use client";

import { useEffect, useMemo, useState } from "react";
import type { EmailSent } from "@/lib/db";
import type { EmailContext } from "@/lib/email";

const date = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
const newKey = () => crypto.randomUUID();

type Vars = { name: string; repo: string; manual: string; site: string; details: string; sign: string };
// "Jen from gitmanual <jen@…>" signs "— Jen"; the brand address signs "— gitmanual".
const signOf = (from: string) => (/^\s*([^<\s]+)[^<]*</.exec(from)?.[1] ?? "gitmanual").replace(/^"/, "");
const quote = (s: string) =>
  s
    .trim()
    .split("\n")
    .slice(0, 6)
    .map((l) => `> ${l}`)
    .join("\n");

// Starting points; everything stays editable. {CODE} and the like are left for you to fill in.
const TEMPLATES: { id: string; label: string; subject: (v: Vars) => string; body: (v: Vars) => string }[] = [
  { id: "blank", label: "Blank", subject: () => "", body: (v) => `Hi ${v.name},\n\n\n\n— ${v.sign}` },
  {
    id: "fixed",
    label: "Fixed it",
    subject: (v) => (v.repo ? `Fixed: the setup for ${v.repo}` : "Fixed: the problem you reported"),
    body: (v) =>
      `Hi ${v.name},\n\nThanks for reporting this${v.repo ? ` on the ${v.repo} manual` : ""}. It's fixed now${v.manual ? `: ${v.manual}` : "."}\n\n` +
      `If it still doesn't work for you, just reply to this email with what you see and I'll take another look.\n\n— ${v.sign}`,
  },
  {
    id: "details",
    label: "Need details",
    subject: (v) => (v.repo ? `About the problem with ${v.repo}` : "About the problem you reported"),
    body: (v) =>
      `Hi ${v.name},\n\nThanks for reporting this${v.repo ? ` on the ${v.repo} manual` : ""}.${v.details ? `\n\n${quote(v.details)}` : ""}\n\n` +
      `To find out what went wrong, could you reply with:\n\n- Your system (macOS, Windows or Linux, and its version)\n- The step it stopped at\n- Everything the terminal printed, copied in full\n\n— ${v.sign}`,
  },
  {
    id: "promo",
    label: "Promo code",
    subject: () => "A code for gitmanual",
    body: (v) =>
      `Hi ${v.name},\n\nThanks for using gitmanual. Here's a code for {WHAT IT GIVES, e.g. 50% off your first month of Pro}:\n\n**{CODE}**\n\n` +
      `Enter it at checkout under "Add promotion code": ${v.site}/pro\n\nIt works once and ends on {DATE}.\n\n— ${v.sign}`,
  },
  {
    id: "sorry",
    label: "Refund / sorry",
    subject: (v) => (v.repo ? `Your report for ${v.repo}` : "Your gitmanual purchase"),
    body: (v) =>
      `Hi ${v.name},\n\nSorry the report${v.repo ? ` for ${v.repo}` : ""} didn't work out as it should. {WHAT YOU DID: refunded it, fixed it, …}\n\n` +
      `If anything else isn't right, just reply to this email.\n\n— ${v.sign}`,
  },
];

export function EmailAdmin({ kind, id }: { kind: string; id: string }) {
  const [ctx, setCtx] = useState<EmailContext | null>(null);
  const [sent, setSent] = useState<EmailSent[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [senders, setSenders] = useState<{ brand: string; personal: string | null }>({ brand: "gitmanual <hello@gitmanual.com>", personal: null });
  const [from, setFrom] = useState<"brand" | "personal">("brand");
  const [error, setError] = useState<"denied" | string | null>(null);

  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [format, setFormat] = useState<"markdown" | "html">("markdown");
  const [template, setTemplate] = useState("blank");
  const [undo, setUndo] = useState<{ subject: string; body: string } | null>(null);

  const [preview, setPreview] = useState<{ to: string; from: string; html: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [key, setKey] = useState(newKey);

  const vars = useMemo<Vars>(() => {
    const site = typeof window === "undefined" ? "" : window.location.origin;
    const repo = ctx?.repo ?? "";
    const sign = from === "personal" && senders.personal ? signOf(senders.personal) : "gitmanual";
    return { name: ctx?.name ?? "there", repo, manual: repo ? `${site}/${repo}` : "", site, details: ctx?.details ?? "", sign };
  }, [ctx, from, senders]);

  const load = () => {
    const q = kind === "custom" ? "" : `?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`;
    return fetch(`/api/admin/email${q}`, { cache: "no-store" }).then(async (r) => {
      if (r.status === 403) return setError("denied");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return setError(j.error ?? "Couldn't load it.");
      setEnabled(j.enabled);
      if (j.senders) setSenders(j.senders);
      setSent(j.sent ?? []);
      return j.context as EmailContext | undefined;
    });
  };

  useEffect(() => {
    load().then((c) => {
      const context: EmailContext = c ?? { ref: { kind: "custom", id: "" }, title: "A new email", repo: null, name: null, to: null, toNote: "Type the address.", details: null };
      setCtx(context);
      setTo(context.to ?? "");
      const first = context.ref.kind === "problem" ? (context.to ? "fixed" : "details") : "blank";
      const v: Vars = { ...vars, name: context.name ?? "there", repo: context.repo ?? "", manual: context.repo ? `${window.location.origin}/${context.repo}` : "", details: context.details ?? "", sign: "gitmanual" };
      const t = TEMPLATES.find((x) => x.id === first)!;
      setTemplate(first);
      setSubject(t.subject(v));
      setBody(t.body(v));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id]);

  // Anything edited makes the preview out of date.
  useEffect(() => setPreview(null), [to, subject, body, format, from]);

  // Switching who it's from swaps the sign-off, when the message still ends with the old one.
  const pickFrom = (f: "brand" | "personal") => {
    const sign = (x: "brand" | "personal") => (x === "personal" && senders.personal ? signOf(senders.personal) : "gitmanual");
    const old = `— ${sign(from)}`;
    setBody((b) => (b.trimEnd().endsWith(old) ? b.trimEnd().slice(0, -old.length) + `— ${sign(f)}` : b));
    setFrom(f);
  };

  const pick = (tid: string) => {
    const t = TEMPLATES.find((x) => x.id === tid)!;
    setUndo({ subject, body });
    setTemplate(tid);
    setFormat("markdown");
    setSubject(t.subject(vars));
    setBody(t.body(vars));
  };

  const openFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 100_000) return setNote({ ok: false, text: "That file is over 100 KB." });
    setUndo({ subject, body });
    setFormat(/\.html?$/i.test(f.name) ? "html" : "markdown");
    setBody(await f.text());
    setTemplate("");
  };

  const post = async (extra: Record<string, unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch("/api/admin/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: ctx?.ref.kind, id: ctx?.ref.id, to: to.trim() !== (ctx?.to ?? "") ? to.trim() : "", from, subject, body, format, key, ...extra }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNote({ ok: false, text: j.error ?? "Something went wrong." });
        return null;
      }
      return j;
    } catch {
      setNote({ ok: false, text: "Couldn't reach the site. Check your connection." });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const showPreview = async () => {
    const j = await post({ preview: true });
    if (j) setPreview({ to: j.to, from: j.from, html: j.html });
  };

  const send = async () => {
    const j = await post({});
    if (!j) return;
    setNote({ ok: true, text: `Sent to ${j.toHint}.` });
    setPreview(null);
    setKey(newKey());
    load();
  };

  if (error === "denied")
    return (
      <p>
        Admins only. <a href="/api/github/connect?signin=1&back=/admin/email">Sign in with GitHub</a> with an account listed in <code>ADMIN_GITHUB_LOGINS</code>.
      </p>
    );
  if (error) return <p role="alert">{error}</p>;
  if (!ctx) return <p>Loading…</p>;

  return (
    <>
      {ctx.ref.kind !== "custom" && (
        <p>
          <a href="/admin/email">Write a new email instead</a>
        </p>
      )}
      {!enabled && (
        <p role="alert">
          Sending is off on this server: <code>RESEND_API_KEY</code> isn&apos;t set. You can still write and preview.
        </p>
      )}

      <h2>{ctx.title}</h2>
      {ctx.details && (
        <details className="em-details">
          <summary>What they wrote</summary>
          <pre>{ctx.details}</pre>
        </details>
      )}

      <div className="em-form">
        <fieldset className="rp-kinds">
          <legend>From</legend>
          <label className={from === "brand" ? "on" : ""}>
            <input type="radio" name="from" checked={from === "brand"} onChange={() => pickFrom("brand")} />
            {senders.brand}
          </label>
          {senders.personal ? (
            <label className={from === "personal" ? "on" : ""}>
              <input type="radio" name="from" checked={from === "personal"} onChange={() => pickFrom("personal")} />
              {senders.personal}
            </label>
          ) : (
            <small className="em-hint">
              Add a personal sender with <code>EMAIL_FROM_PERSONAL</code> in Vercel, e.g. <code>Jen from gitmanual &lt;jen@gitmanual.com&gt;</code>.
            </small>
          )}
        </fieldset>
        <label className="rp-field">
          <span>
            To <small>{to.trim() && to.trim() !== ctx.to ? "Your own address for them" : ctx.toNote}</small>
          </span>
          <input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" autoComplete="off" spellCheck={false} />
        </label>
        {ctx.to && to.trim() !== ctx.to && (
          <button type="button" className="link em-reset" onClick={() => setTo(ctx.to ?? "")}>
            Use {ctx.to} again
          </button>
        )}

        <fieldset className="rp-kinds">
          <legend>Start from</legend>
          {TEMPLATES.map((t) => (
            <label key={t.id} className={template === t.id ? "on" : ""}>
              <input type="radio" name="template" checked={template === t.id} onChange={() => pick(t.id)} />
              {t.label}
            </label>
          ))}
          <label className={template === "" ? "on" : ""}>
            <input type="file" accept=".md,.markdown,.txt,.html,.htm" onChange={(e) => {
                openFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            Open a .md or .html file…
          </label>
        </fieldset>
        {undo && (
          <button
            type="button"
            className="link em-reset"
            onClick={() => {
              setSubject(undo.subject);
              setBody(undo.body);
              setUndo(null);
              setTemplate("");
            }}
          >
            Undo: bring back what you had
          </button>
        )}

        <label className="rp-field">
          <span>Subject</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
        </label>

        <fieldset className="rp-kinds">
          <legend>Written in</legend>
          {(["markdown", "html"] as const).map((f) => (
            <label key={f} className={format === f ? "on" : ""}>
              <input type="radio" name="format" checked={format === f} onChange={() => setFormat(f)} />
              {f === "markdown" ? "Markdown" : "HTML"}
            </label>
          ))}
        </fieldset>
        <label className="rp-field">
          <span>
            Message{" "}
            <small>
              {format === "markdown"
                ? "Blank line between paragraphs. **bold**, *italic*, [text](https://…), lists with -, links work as they are."
                : "A fragment gets the gitmanual layout; a whole <html> document is sent as it is."}
            </small>
          </span>
          <textarea className={format === "html" ? "rp-code" : ""} value={body} onChange={(e) => setBody(e.target.value)} rows={16} spellCheck={format === "markdown"} />
        </label>
        {/\{[A-Z][A-Z ,.:…'%()0-9-]*\}/.test(body + subject) && <p className="em-warn">There&apos;s still a {"{PLACEHOLDER}"} to fill in.</p>}

        <div className="rp-foot">
          <button type="button" className="btn" disabled={busy || !subject.trim() || !body.trim() || !to.trim()} onClick={showPreview}>
            Preview
          </button>
          {note && (
            <small role="status" className={note.ok ? "em-ok" : "em-bad"}>
              {note.text}
            </small>
          )}
        </div>
      </div>

      {preview && (
        <section className="em-preview" aria-label="Preview">
          <p>
            <strong>To:</strong> {preview.to}
            <br />
            <strong>From:</strong> {preview.from}
            <br />
            <strong>Subject:</strong> {subject}
          </p>
          <iframe title="Email preview" sandbox="" srcDoc={preview.html} />
          <div className="rp-foot">
            <button type="button" className="btn btn-go" disabled={busy || !enabled} onClick={send}>
              Send to {preview.to}
            </button>
            <button type="button" className="link" onClick={() => setPreview(null)}>
              Keep editing
            </button>
          </div>
        </section>
      )}

      <h2>{ctx.ref.kind === "custom" ? "Recent emails" : "Sent about this"}</h2>
      {sent.length ? (
        <div className="doc-table-wrap">
          <table className="doc-table">
            <thead>
              <tr>
                <th scope="col">Sent</th>
                <th scope="col">To</th>
                <th scope="col">Subject</th>
                <th scope="col">About</th>
                <th scope="col">From</th>
                <th scope="col">By</th>
              </tr>
            </thead>
            <tbody>
              {sent.map((e) => (
                <tr key={e.id}>
                  <td>{date(e.sentAt)}</td>
                  <td>{e.toHint}</td>
                  <th scope="row">{e.subject}</th>
                  <td>
                    {e.ref.kind === "custom" ? (
                      "—"
                    ) : (
                      <a href={`/admin/email?kind=${e.ref.kind}&id=${encodeURIComponent(e.ref.id)}`}>
                        {e.ref.kind === "problem" ? `Problem #${e.ref.id}` : e.ref.kind === "purchase" ? "Purchase" : "Pro"}
                      </a>
                    )}
                  </td>
                  <td>{e.fromAddress ?? "—"}</td>
                  <td>@{e.admin}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>None yet.</p>
      )}
    </>
  );
}
