"use client";

import { useEffect, useState } from "react";
import type { AdminPurchase, AdminSubscription } from "@/lib/db";

const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const money = (cents: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
};
// "$9.98 + €4.99": totals kept per currency, never added across currencies.
const totals = (list: AdminPurchase[]) => {
  const by = new Map<string, number>();
  for (const p of list) by.set(p.currency, (by.get(p.currency) ?? 0) + p.amount);
  return by.size ? [...by].map(([cur, cents]) => money(cents, cur)).join(" + ") : money(0, "usd");
};

const Buyer = ({ login, githubId }: { login: string | null; githubId: number }) =>
  login ? (
    <a href={`https://github.com/${login}`} target="_blank" rel="noreferrer">
      @{login}
    </a>
  ) : (
    <span title="Not in the users table">GitHub #{githubId}</span>
  );

const RUNNING = new Set(["active", "trialing", "past_due"]);
// Stripe test mode (test keys) makes cs_test_ sessions: shown, tagged, and left out of the totals.
const isTest = (p: AdminPurchase) => p.session.startsWith("cs_test_");

export function PurchasesAdmin() {
  const [data, setData] = useState<{ purchases: AdminPurchase[]; subscriptions: AdminSubscription[] } | null>(null);
  const [error, setError] = useState<"denied" | string | null>(null);

  useEffect(() => {
    fetch("/api/admin/purchases", { cache: "no-store" }).then(async (r) => {
      if (r.status === 403) return setError("denied");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return setError(j.error ?? "Couldn't load the purchases.");
      setData(j);
    });
  }, []);

  if (error === "denied")
    return (
      <p>
        Admins only. <a href="/api/github/connect?signin=1&back=/admin/purchases">Sign in with GitHub</a> with an account listed in{" "}
        <code>ADMIN_GITHUB_LOGINS</code>.
      </p>
    );
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p>Loading…</p>;

  const { purchases, subscriptions } = data;
  const monthAgo = Date.now() - 30 * 864e5;
  const real = purchases.filter((p) => !isTest(p));
  const recent = real.filter((p) => p.paidAt >= monthAgo);
  const tests = purchases.length - real.length;
  const running = subscriptions.filter((s) => RUNNING.has(s.status) && s.periodEnd > Date.now());
  const plans = (plan: string) => running.filter((s) => s.plan === plan).length;

  return (
    <>
      <p>
        One-time repo purchases: <strong>{recent.length}</strong> in the last 30 days ({totals(recent)}), <strong>{real.length}</strong> in all (
        {totals(real)}){tests ? `, not counting ${tests} in test mode` : ""}. Amounts are before tax. Pro: <strong>{running.length}</strong> running ({plans("month")} monthly, {plans("year")} yearly).{" "}
        <a href="/admin/users">Users</a> · <a href="/admin/chat">Chat stats</a>
      </p>

      <h2>One-time purchases</h2>
      {purchases.length ? (
        <div className="doc-table-wrap">
          <table className="doc-table">
            <thead>
              <tr>
                <th scope="col">Paid</th>
                <th scope="col">Repo</th>
                <th scope="col">Buyer</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {purchases.map((p) => (
                <tr key={p.session}>
                  <td>{date(p.paidAt)}</td>
                  <th scope="row">
                    <a href={`/${p.fullName}`}>{p.fullName}</a>
                  </th>
                  <td>
                    <Buyer login={p.login} githubId={p.githubId} />
                  </td>
                  <td className="num">
                    {money(p.amount, p.currency)}
                    {isTest(p) ? " (test)" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>No one-time purchases yet.</p>
      )}

      <h2>Pro subscriptions</h2>
      {subscriptions.length ? (
        <div className="doc-table-wrap">
          <table className="doc-table">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Plan</th>
                <th scope="col">Status</th>
                <th scope="col">Paid until</th>
                <th scope="col">Last change</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((s) => (
                <tr key={s.subscription}>
                  <th scope="row">
                    <Buyer login={s.login} githubId={s.githubId} />
                  </th>
                  <td>{s.plan === "year" ? "Yearly" : s.plan === "month" ? "Monthly" : "–"}</td>
                  <td>
                    {s.status}
                    {s.cancelAtPeriodEnd && RUNNING.has(s.status) ? ", ends then" : ""}
                  </td>
                  <td>{date(s.periodEnd)}</td>
                  <td>{date(s.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>No Pro subscriptions yet.</p>
      )}
    </>
  );
}
