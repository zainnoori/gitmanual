"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { proUrl } from "@/lib/site";

// "Just this repo, $4.99 once": its Deep Inspection and PDF manuals, kept on the account (app/api/pro/report).
// Signed out, it signs in with GitHub first and comes back to `back`, where the button is offered again.
export const REPO_PRICE = "$4.99";

export function BuyRepo({
  repo,
  back,
  signedIn,
  className = "btn pro-btn",
  label = `Just this repo: ${REPO_PRICE}`,
  onBuy,
}: {
  repo: string;
  back: string;
  signedIn: boolean;
  className?: string;
  label?: string;
  onBuy?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function buy() {
    onBuy?.();
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
        {busy ? "Opening checkout…" : label}
      </button>
      {error && (
        <p className="key-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export type ProPrices = { month: number; year: number; currency: string } | null | undefined;

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);

// Pro's monthly price, read from /api/pro when the caller doesn't already have it.
function useProPrice(prices: ProPrices) {
  const [fetched, setFetched] = useState<ProPrices>(undefined);
  useEffect(() => {
    if (prices !== undefined) return;
    let live = true;
    fetch("/api/pro", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { prices?: ProPrices }) => live && setFetched(j.prices ?? null))
      .catch(() => live && setFetched(null));
    return () => {
      live = false;
    };
  }, [prices]);
  const p = prices !== undefined ? prices : fetched;
  return p ? `${money(p.month, p.currency)}/mo` : null;
}

// The two ways in, side by side wherever a repo's paid part is locked: this repo once, or Pro for every repo.
// This repo comes first: whoever is here is thinking about one repo. For signed-in people without either.
export function UnlockChoice({
  repo,
  back,
  prices,
  onChoose,
  compact,
}: {
  repo: string;
  back: string;
  prices?: ProPrices;
  onChoose?: () => void;
  compact?: boolean;
}) {
  const pro = useProPrice(prices);
  if (compact)
    return (
      <div className="unlock-inline">
        <BuyRepo repo={repo} back={back} signedIn className="btn" label={`Unlock this repo · ${REPO_PRICE}`} onBuy={onChoose} />
        <span>
          or{" "}
          <a href={proUrl(back)} onClick={onChoose}>
            get Pro
          </a>{" "}
          for every repo
        </span>
      </div>
    );
  return (
    <div className="unlock">
      <div className="unlock-card unlock-once">
        <p className="unlock-for">This repo</p>
        <p className="unlock-price">
          {REPO_PRICE} <small>once, for both</small>
        </p>
        <ul className="unlock-list">
          <li>Deep Inspection report</li>
          <li>PDF manuals for every system</li>
        </ul>
        <p className="unlock-what">
          One payment for <strong>{repo}</strong>, kept in your profile.
        </p>
        <BuyRepo repo={repo} back={back} signedIn className="btn btn-go" label={`Unlock this repo · ${REPO_PRICE}`} onBuy={onChoose} />
      </div>
      <div className="unlock-card">
        <p className="unlock-for">Every repo</p>
        <p className="unlock-price">
          Pro {pro && <small>{pro}</small>}
        </p>
        <ul className="unlock-list">
          <li>Both, for every repo</li>
          <li>Unlimited AI answers, no ads</li>
        </ul>
        <p className="unlock-what">Cancel any time.</p>
        <a className="btn" href={proUrl(back)} onClick={onChoose}>
          Get Pro
        </a>
      </div>
      <small className="unlock-tax">Tax added where it applies.</small>
    </div>
  );
}

// Back from paying, but the payment isn't on the account yet (app/api/pro/report/done ?bought=pending): say so, so
// nobody pays twice. Stripe's webhook usually records it within a minute.
export function PaymentPending() {
  return (
    <p className="pro-thanks pro-pending" role="status">
      Thanks! We&apos;re still confirming your payment with Stripe. Please don&apos;t pay again: refresh in a minute.
      Still locked after that? <Link href="/contact">Contact us</Link> and we&apos;ll sort it out.
    </p>
  );
}
