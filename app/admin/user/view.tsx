"use client";

import { useEffect, useState } from "react";
import type { ApiKey, EmailSent, Problem, Purchase, SubscriptionRow } from "@/lib/db";
import { KIND_LABEL } from "@/lib/problems";
import { stripeCustomerUrl, stripePurchaseUrl, stripeSubscriptionUrl } from "@/lib/stripe-links";

type Data = {
  user: { githubId: number; login: string | null; firstSeen?: number | null; lastSeen?: number | null; signIns?: number };
  purchases: Purchase[];
  subscription: SubscriptionRow | null;
  chat: { answers: number; spent: number; repos: { repo: string; answers: number }[] };
  key: ApiKey | null;
  problems: Problem[];
  emails: EmailSent[];
};

const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const money = (cents: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
};
const RUNNING = new Set(["active", "trialing", "past_due"]);

export function UserAdmin({ login, id }: { login: string; id: string }) {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<"denied" | string | null>(null);
  const [find, setFind] = useState(login);

  useEffect(() => {
    if (!login && !id) return;
    const q = id ? `id=${encodeURIComponent(id)}` : `login=${encodeURIComponent(login)}`;
    fetch(`/api/admin/user?${q}`, { cache: "no-store" }).then(async (r) => {
      if (r.status === 403) return setError("denied");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return setError(j.error ?? "Couldn't load them.");
      setD(j);
    });
  }, [login, id]);

  const search = (
    <form className="admin-find" action="/admin/user">
      <label>
        <span className="sr-only">GitHub username</span>
        <input name="login" value={find} onChange={(e) => setFind(e.target.value)} placeholder="GitHub username" autoComplete="off" spellCheck={false} />
      </label>
      <button className="btn btn-sm">Look up</button>
    </form>
  );

  if (error === "denied")
    return (
      <p>
        Admins only. <a href="/api/github/connect?signin=1&back=/admin/user">Sign in with GitHub</a> with an account listed in <code>ADMIN_GITHUB_LOGINS</code>.
      </p>
    );
  if (!login && !id) return search;
  if (error)
    return (
      <>
        {search}
        <p role="alert">{error}</p>
      </>
    );
  if (!d) return <p>Loading…</p>;

  const { user, purchases, subscription: sub, chat, key, problems, emails } = d;
  const running = sub && RUNNING.has(sub.status) && sub.periodEnd > Date.now();

  return (
    <>
      {search}
      <h2>
        {user.login ? (
          <a href={`https://github.com/${user.login}`} target="_blank" rel="noreferrer">
            @{user.login}
          </a>
        ) : (
          `GitHub #${user.githubId}`
        )}
      </h2>
      <p>
        {user.firstSeen ? (
          <>
            First seen {date(user.firstSeen)}, last seen {date(user.lastSeen!)}, {user.signIns} {user.signIns === 1 ? "sign-in" : "sign-ins"}.
          </>
        ) : (
          "Never signed in here (only paid)."
        )}{" "}
        GitHub id {user.githubId}.
      </p>

      <h3>Pro</h3>
      {sub ? (
        <p>
          {sub.plan === "year" ? "Yearly" : sub.plan === "month" ? "Monthly" : "Plan unknown"}, {sub.status}
          {sub.cancelAtPeriodEnd && running ? ", ends then" : ""}; paid until {date(sub.periodEnd)}. {running ? "Has Pro now." : "No Pro now."}{" "}
          <a href={stripeSubscriptionUrl(sub.subscription)} target="_blank" rel="noreferrer">
            Subscription in Stripe
          </a>{" "}
          ·{" "}
          <a href={stripeCustomerUrl(sub.customer)} target="_blank" rel="noreferrer">
            Customer in Stripe
          </a>{" "}
          · <a href={`/admin/email?kind=subscription&id=${encodeURIComponent(sub.subscription)}`}>Email</a>
        </p>
      ) : (
        <p>Never subscribed.</p>
      )}

      <h3>Reports bought</h3>
      {purchases.length ? (
        <ul>
          {purchases.map((p) => (
            <li key={p.session}>
              <a href={`/${p.fullName}/inspection`}>{p.fullName}</a>, {money(p.amount, p.currency)} on {date(p.paidAt)}
              {p.session.startsWith("cs_test_") ? " (test)" : ""} ·{" "}
              <a href={stripePurchaseUrl(p.session)} target="_blank" rel="noreferrer">
                Stripe
              </a>{" "}
              · <a href={`/admin/email?kind=purchase&id=${encodeURIComponent(p.session)}`}>Email</a>
            </li>
          ))}
        </ul>
      ) : (
        <p>None.</p>
      )}

      <h3>Chat, last 14 days</h3>
      <p>
        {chat.answers} {chat.answers === 1 ? "answer" : "answers"}, ${chat.spent.toFixed(2)} spent
        {chat.repos.length ? ": " : "."}
        {chat.repos.map((r, i) => (
          <span key={r.repo}>
            {i > 0 && ", "}
            <a href={`/${r.repo}`}>{r.repo}</a> ({r.answers})
          </span>
        ))}
      </p>

      <h3>API key</h3>
      <p>
        {key ? (
          <>
            <code>{key.prefix}…</code>, made {date(key.createdAt)}, used {key.uses.toLocaleString()} times
            {key.lastUsed ? `, last on ${date(key.lastUsed)}` : ""}
            {key.blocked ? ". Blocked." : "."} <a href="/admin/keys">API keys</a>
          </>
        ) : (
          "None."
        )}
      </p>

      <h3>Problems they reported</h3>
      {problems.length ? (
        <ul>
          {problems.map((p) => (
            <li key={p.id}>
              #{p.id} {p.repo || (p.mode === "contact" ? "Message" : "Site")}: {KIND_LABEL[p.kind] ?? p.kind}, {date(p.createdAt)}, {p.status}
              {p.repliedAt ? `, replied ${date(p.repliedAt)}` : ""} · <a href={`/admin/email?kind=problem&id=${p.id}`}>{p.email ? "Reply" : "Email"}</a>
            </li>
          ))}
        </ul>
      ) : (
        <p>None while signed in.</p>
      )}

      <h3>Emails sent to them</h3>
      {emails.length ? (
        <ul>
          {emails.map((e) => (
            <li key={e.id}>
              {date(e.sentAt)}: “{e.subject}” to {e.toHint}
              {e.fromAddress ? ` from ${e.fromAddress}` : ""}, by @{e.admin}
            </li>
          ))}
        </ul>
      ) : (
        <p>None yet.</p>
      )}
    </>
  );
}
