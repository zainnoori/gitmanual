import type { EmailRef } from "./db";
import { SITE_URL } from "./site";

// Thank-you emails after a payment, sent through Resend (https://resend.com) from the Stripe webhook.
// Off unless RESEND_API_KEY is set. EMAIL_FROM overrides the sender; replies go to EMAIL_REPLY_TO (default hello@).
// EMAIL_FROM_PERSONAL (e.g. "Jen from gitmanual <jen@gitmanual.com>") adds a personal sender to /admin/email; replies
// to those go to that address. Both must be on the domain verified in Resend.
// Each email has an idempotency key, so Stripe sending the same event twice sends one email (Resend keeps keys 24 hours).
// Mostly a thank-you, with one short "also on gitmanual" part; no mailing list, nothing sent again later.

const FROM = () => process.env.EMAIL_FROM || "gitmanual <hello@gitmanual.com>";
const REPLY_TO = () => process.env.EMAIL_REPLY_TO || "hello@gitmanual.com";
export const EMAIL_ENABLED = () => Boolean(process.env.RESEND_API_KEY);

export type Mail = { to: string; subject: string; text: string; html: string; key: string; from?: Sender };

// "Name <address>" → its parts; null when the setting isn't one address on its own.
export type Sender = { name: string; address: string; value: string };
const sender = (v: string | undefined): Sender | null => {
  const m = /^\s*(?:"?([^"<>]*?)"?\s*<([^\s<>@]+@[^\s<>@]+\.[A-Za-z]{2,})>|([^\s<>@]+@[^\s<>@]+\.[A-Za-z]{2,}))\s*$/.exec(v ?? "");
  if (!m) return null;
  const address = m[2] ?? m[3];
  const name = (m[1] ?? "").trim();
  return { name, address, value: name ? `${name} <${address}>` : address };
};
export const brandSender = (): Sender => sender(FROM()) ?? { name: "gitmanual", address: "hello@gitmanual.com", value: "gitmanual <hello@gitmanual.com>" };
export const personalSender = (): Sender | null => sender(process.env.EMAIL_FROM_PERSONAL);

// Resend's id for the email, or null when it wasn't sent (the reason is logged).
export async function deliver(m: Mail): Promise<string | null> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": m.key },
    body: JSON.stringify({ from: m.from?.value ?? FROM(), to: [m.to], reply_to: m.from?.address ?? REPLY_TO(), subject: m.subject, text: m.text, html: m.html }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    // Resend's error says what's wrong (an unverified domain, a bad key) and never contains the key.
    console.error(`gitmanual email: Resend answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    return null;
  }
  const j = (await res.json().catch(() => ({}))) as { id?: string };
  return j.id ?? "";
}
const send = async (m: Mail) => (await deliver(m)) !== null;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// A paragraph is a string; [text, url] makes a link. Same words in the text and HTML versions.
type Part = string | [label: string, url: string];
type Para = Part[];

function render(paras: Para[]): { text: string; html: string } {
  const text = paras.map((p) => p.map((x) => (typeof x === "string" ? x : `${x[0]} (${x[1]})`)).join("")).join("\n\n");
  const body = paras
    .map(
      (p) =>
        `<p style="margin:0 0 16px">${p
          .map((x) => (typeof x === "string" ? esc(x) : `<a href="${esc(x[1])}" style="color:#c2410c">${esc(x[0])}</a>`))
          .join("")}</p>`,
    )
    .join("");
  return { text, html: layout(body) };
}

const layout = (body: string) =>
  `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff"><div style="max-width:560px;margin:0 auto;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#15161a">${body}</div></body></html>`;

const tag = (live: boolean) => (live ? "" : "[Test] ");
const footer = (why: string): Para[] => [
  ["Questions or something not working? Just reply to this email."],
  ["— gitmanual"],
  [`You're getting this one email because ${why}. We don't send newsletters.`],
];

export async function sendReportThanks(o: { to: string; fullName: string; session: string; live: boolean }): Promise<boolean> {
  const report = `${SITE_URL}/${o.fullName}/inspection`;
  const paras: Para[] = [
    ["Hi,"],
    [`Thanks for buying the gitmanual report for ${o.fullName}. It's yours to keep, on the account you signed in with.`],
    [["Open the Deep Inspection", report]],
    ["The PDF setup manuals are on the same page, and every report you buy is listed under ", ["Your reports", `${SITE_URL}/profile/reports`], "."],
    ["Also on gitmanual:"],
    ["• ", ["GitManual Pro", `${SITE_URL}/pro`], ": Deep Inspection and PDF manuals for every public repo, plus unlimited questions to the AI agent, monthly or yearly."],
    ["• ", ["Free setup manuals", SITE_URL], " for any public GitHub repo, with a setup script for macOS, Windows and Linux."],
    ["• ", ["The MCP server", `${SITE_URL}/mcp`], ", so your coding agent can look up setup steps itself."],
    ...footer(`you bought the report for ${o.fullName}`),
  ];
  return send({ to: o.to, subject: `${tag(o.live)}Your gitmanual report for ${o.fullName}`, key: `report-thanks/${o.session}`, ...render(paras) });
}

export async function sendProWelcome(o: { to: string; plan: "month" | "year" | null; session: string; live: boolean }): Promise<boolean> {
  const paras: Para[] = [
    ["Hi,"],
    [`Thanks for subscribing to GitManual Pro${o.plan === "year" ? " (yearly)" : o.plan === "month" ? " (monthly)" : ""}. It's on now, for the GitHub account you signed in with.`],
    ["What you get:"],
    ["• Unlimited questions to the AI agent about any public repo, on gitmanual.com and in the browser extension."],
    ["• Deep Inspection and PDF setup manuals for every public repo: open any repo's manual and find the Deep Inspection card."],
    ["You can change your plan, update your card or cancel any time on ", ["the Pro page", `${SITE_URL}/pro`], "."],
    ["If your coding agent should know setup steps too, try ", ["the MCP server", `${SITE_URL}/mcp`], "."],
    ...footer("you subscribed to GitManual Pro"),
  ];
  return send({ to: o.to, subject: `${tag(o.live)}Welcome to GitManual Pro`, key: `pro-welcome/${o.session}`, ...render(paras) });
}

// ---- Emails written by an admin on /admin/email: one person, one message (support, a promo code). ----

// One plain address, nothing that could add a second recipient or a header.
export const isEmail = (s: string) => s.length <= 254 && /^[^\s@<>,;"()]+@[^\s@<>,;"()]+\.[A-Za-z]{2,}$/.test(s);
// j***@gmail.com: enough to tell which address it went to, without keeping the address.
export const maskEmail = (s: string) => {
  const [user, domain] = s.split("@");
  return `${user.slice(0, 1)}***@${domain ?? ""}`;
};

// Markdown the admin writes: paragraphs, "- " lists, # headings, **bold**, *italic*, `code`, [links](https://…) and bare
// URLs. Everything else is text, escaped, so a pasted error message can't turn into HTML.
const inline = (s: string) => {
  const links: string[] = [];
  const keep = (html: string) => `\u0000${links.push(html) - 1}\u0000`;
  let out = s
    .replace(/`([^`]+)`/g, (_, c) => keep(`<code style="font:14px ui-monospace,Menlo,monospace;background:#f3f1ec;padding:1px 4px;border-radius:3px">${esc(c)}</code>`))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, t, u) => keep(`<a href="${esc(u)}" style="color:#c2410c">${esc(t)}</a>`))
    .replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => keep(`<a href="${esc(u)}" style="color:#c2410c">${esc(u)}</a>`));
  out = esc(out)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => links[Number(i)]);
};

export function markdownToHtml(md: string): string {
  const blocks = md.replace(/\r\n?/g, "\n").trim().split(/\n{2,}/);
  return blocks
    .map((b) => {
      const lines = b.split("\n");
      if (lines.every((l) => /^\s*[-*•] /.test(l)))
        return `<ul style="margin:0 0 16px;padding-left:22px">${lines.map((l) => `<li style="margin:0 0 6px">${inline(l.replace(/^\s*[-*•] /, ""))}</li>`).join("")}</ul>`;
      if (lines.every((l) => /^\s*\d+[.)] /.test(l)))
        return `<ol style="margin:0 0 16px;padding-left:22px">${lines.map((l) => `<li style="margin:0 0 6px">${inline(l.replace(/^\s*\d+[.)] /, ""))}</li>`).join("")}</ol>`;
      const h = /^(#{1,3}) (.+)$/.exec(b);
      if (h && lines.length === 1) return `<p style="margin:0 0 12px;font-size:${h[1].length === 1 ? 20 : 18}px;font-weight:700">${inline(h[2])}</p>`;
      return `<p style="margin:0 0 16px">${lines.map(inline).join("<br>")}</p>`;
    })
    .join("");
}

// HTML to a plain-text version for mail apps that don't show HTML.
const htmlToText = (html: string) =>
  html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, u, t) => (t.replace(/<[^>]+>/g, "").trim() === u ? u : `${t} (${u})`))
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<br\s*\/?>(?!\n)/gi, "\n")
    .replace(/<\/(p|li|ul|ol|h\d|div|tr)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export type Composed = { subject: string; body: string; format: "markdown" | "html" };

// Markdown gets the same look as the thank-you emails. HTML is the admin's own: a whole document is sent as it is,
// a fragment goes inside the same layout.
export function composeEmail(c: Composed): { html: string; text: string } {
  if (c.format === "html") {
    const html = /<html[\s>]/i.test(c.body) ? c.body : layout(c.body);
    return { html, text: htmlToText(c.body) };
  }
  const html = layout(markdownToHtml(c.body));
  return { html, text: c.body.replace(/\r\n?/g, "\n").trim() };
}

// key: one per press of Send (made by the browser), so a double click or a retry sends one email.
// from: the personal sender, or the brand one (replies to EMAIL_REPLY_TO) when left out.
export async function sendAdminEmail(to: string, c: Composed, key: string, from?: Sender): Promise<string | null> {
  return deliver({ to, subject: c.subject, key: `admin/${key}`, from, ...composeEmail(c) });
}

// What /admin/email is writing about (app/api/admin/email).
export type EmailContext = {
  ref: EmailRef;
  title: string; // "Problem #12: Bodila51/gtavi-claudecode", shown above the form
  repo: string | null; // owner/Name, for the templates
  name: string | null; // a name or @login to greet
  to: string | null; // where it goes unless the admin types another address
  toNote: string | null; // why there's no address, or where it came from
  details: string | null; // the problem's message, so the reply can quote it
};
