"use client";

import { useState } from "react";

// "Just this repo, $4.99 once": its Deep Inspection and PDF manuals, kept on the account (app/api/pro/report).
// Signed out, it signs in with GitHub first and comes back to `back`, where the button is offered again.
export const REPO_PRICE = "$4.99";

export function BuyRepo({ repo, back, signedIn, className = "btn pro-btn" }: { repo: string; back: string; signedIn: boolean; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function buy() {
    if (!signedIn) return void (window.location.href = `/api/github/connect?signin=1&back=${encodeURIComponent(back)}`);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/pro/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo, back }) });
      const j = (await res.json().catch(() => ({}))) as { url?: string; error?: string; signIn?: boolean; bought?: boolean; pro?: boolean };
      if (j.url) return void (window.location.href = j.url);
      if (j.signIn) return void (window.location.href = `/api/github/connect?signin=1&back=${encodeURIComponent(back)}`);
      if (j.bought || j.pro) return void window.location.reload(); // already theirs: show it
      setError(j.error ?? "Something went wrong. Try again.");
    } catch {
      setError("Couldn't reach gitmanual. Check your connection and try again.");
    }
    setBusy(false);
  }
  return (
    <>
      <button type="button" className={className} onClick={buy} disabled={busy} aria-busy={busy}>
        {busy ? "Opening checkout…" : `Just this repo: ${REPO_PRICE}`}
      </button>
      {error && (
        <p className="key-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
