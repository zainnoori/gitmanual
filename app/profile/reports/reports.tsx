"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { GitHubMark } from "../../github-mark";

type Report = { repo: string; paidAt: number; amount: number; currency: string };
type Data = { reports?: Report[]; error?: string; signIn?: boolean };

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const pdf = (repo: string, os: string) => `/api/download?repo=${encodeURIComponent(repo)}&os=${os}&format=pdf`;

export function ReportsList() {
  const [data, setData] = useState<Data | null>(null);
  useEffect(() => {
    fetch("/api/pro/report", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: Data) => setData(d))
      .catch(() => setData({ error: "Couldn't reach gitmanual. Check your connection and try again." }));
  }, []);

  if (!data) return <p className="note saved-loading">Loading your reports…</p>;
  if (data.signIn)
    return (
      <div className="panel saved-empty">
        <h2>Sign in to see your reports</h2>
        <p className="note">Reports you buy are kept on your GitHub account.</p>
        <a className="btn btn-go" href={`/api/github/connect?signin=1&back=${encodeURIComponent("/profile/reports")}`}>
          <GitHubMark /> Sign in with GitHub
        </a>
      </div>
    );
  if (data.error) return <p className="panel">{data.error}</p>;
  const reports = data.reports ?? [];
  if (!reports.length)
    return (
      <div className="panel saved-empty">
        <h2>No reports yet</h2>
        <p className="note">
          On any repo&apos;s Deep Inspection, choose &ldquo;Just this repo&rdquo; to buy its report and PDF manuals once. Pro members see every repo&apos;s
          report without buying.
        </p>
        <Link className="btn btn-go" href="/shelf">
          Browse the shelf
        </Link>
      </div>
    );

  return (
    <div className="saved-table-wrap">
      <table className="saved-table">
        <thead>
          <tr>
            <th scope="col">Repo</th>
            <th scope="col">Deep Inspection</th>
            <th scope="col">PDF manual</th>
            <th scope="col">Bought</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.repo}>
              <td>
                <Link href={`/${r.repo}`}>{r.repo}</Link>
              </td>
              <td>
                <Link href={`/${r.repo}/inspection`}>Open the report →</Link>
              </td>
              <td className="reports-pdfs">
                <a href={pdf(r.repo, "mac")}>macOS</a> · <a href={pdf(r.repo, "windows")}>Windows</a> · <a href={pdf(r.repo, "linux")}>Linux</a>
              </td>
              <td>
                {day(r.paidAt)} · {money(r.amount, r.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
