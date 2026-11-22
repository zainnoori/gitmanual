"use client";

import { useEffect, useState } from "react";
import type { AdminOverview } from "@/lib/db";
import { KIND_LABEL } from "@/lib/problems";

const money = (cents: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
};
const ago = (ms: number) => {
  const h = Math.round((Date.now() - ms) / 36e5);
  return h < 1 ? "just now" : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

export function AdminHome() {
  const [o, setO] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<"denied" | string | null>(null);

  useEffect(() => {
    fetch("/api/admin/overview", { cache: "no-store" }).then(async (r) => {
      if (r.status === 403) return setError("denied");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return setError(j.error ?? "Couldn't load the overview.");
      setO(j);
    });
  }, []);

  if (error === "denied")
    return (
      <p>
        Admins only. <a href="/api/github/connect?signin=1&back=/admin">Sign in with GitHub</a> with an account listed in <code>ADMIN_GITHUB_LOGINS</code>.
      </p>
    );
  if (error) return <p role="alert">{error}</p>;
  if (!o) return <p>Loading…</p>;

  const revenue = o.purchases7d.totals.map((t) => money(t.cents, t.currency)).join(" + ") || money(0, "usd");
  const tiles: { label: string; value: string; sub?: string; href: string; hot?: boolean }[] = [
    { label: "Waiting for an answer", value: String(o.unanswered), sub: `${o.openProblems} open in all`, href: "/admin/problems", hot: o.unanswered > 0 },
    { label: "Reports bought, 7 days", value: String(o.purchases7d.count), sub: `${revenue} before tax`, href: "/admin/purchases" },
    { label: "Pro members", value: String(o.proRunning), href: "/admin/purchases" },
    { label: "Users", value: o.users.toLocaleString(), sub: `${o.newUsers7d} new in 7 days`, href: "/admin/users" },
    { label: "Emails sent, 7 days", value: String(o.emails7d), href: "/admin/email" },
    { label: "Chat spend today", value: `$${o.chatSpendToday.toFixed(2)}`, sub: "UTC day", href: "/admin/chat" },
  ];

  return (
    <>
      <ul className="admin-tiles">
        {tiles.map((t) => (
          <li key={t.label}>
            <a href={t.href} className={t.hot ? "hot" : ""}>
              <span className="admin-tile-value">{t.value}</span>
              <span className="admin-tile-label">{t.label}</span>
              {t.sub && <small>{t.sub}</small>}
            </a>
          </li>
        ))}
      </ul>

      <h2>Waiting for an answer</h2>
      {o.attention.length ? (
        <>
          <p>Open, and nobody has written back yet. Oldest first.</p>
          <ul className="admin-waiting">
            {o.attention.map((p) => (
              <li key={p.id}>
                <div>
                  <strong>
                    #{p.id} {p.mode === "contact" ? "Message" : p.repo || "Site"}
                  </strong>{" "}
                  <small>
                    {KIND_LABEL[p.kind as keyof typeof KIND_LABEL] ?? p.kind} · {ago(p.createdAt)}
                    {p.login ? ` · @${p.login}` : ""}
                  </small>
                  <p>{p.message}</p>
                </div>
                <a className="btn btn-sm" href={`/admin/email?kind=problem&id=${p.id}`}>
                  {p.hasEmail ? "Reply" : "Email…"}
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>Nothing waiting. Every open problem has had an answer.</p>
      )}
    </>
  );
}
