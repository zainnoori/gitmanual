"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AD_FREE_COOKIE, REPO_URL } from "@/lib/site";
import Link from "next/link";
import type { PublicSponsor } from "@/lib/sponsor";
import { Logo } from "./ui";

// One Carbon ad (cover format) where it's placed: manual pages of public repos, the shelf, lists and /developers.
// While a sponsor booked on /admin/sponsors runs, it shows instead: always for Exclusive, on about half the page
// views for Shared (Carbon gets the rest).
// Live only in production with NEXT_PUBLIC_CARBON_SERVE and NEXT_PUBLIC_CARBON_PLACEMENT set (so self-hosted copies
// don't serve gitmanual's ads); `next dev` shows a placeholder of the same size instead, so local views never count
// (add ?ad=blocked to the address to see the fallback on every page this tab opens, ?ad=sponsor to see a sample sponsor's ad, ?ad=on to go back). Carbon's tag goes inside a sized box so the ad doesn't shift
// the page, and is loaded again on each new page, since moving between pages here doesn't reload the browser.
// When the ad can't show (an ad blocker stopped the script, or no ad came back), the box asks for a sponsor instead.
// Pro accounts see no ad at all: lib/adfree.ts sets a cookie, the layout marks the page before it paints (the CSS
// hides .ad), and the script isn't loaded. Once a day the browser asks /api/pro again, which renews the cookie
// after a renewal or removes it once Pro ends; a browser that had Pro before asks too, to pick it back up.

const valid = (v: string | undefined) => (v && /^[\w-]+$/.test(v) ? v : null);
const SERVE = valid(process.env.NEXT_PUBLIC_CARBON_SERVE);
const PLACEMENT = valid(process.env.NEXT_PUBLIC_CARBON_PLACEMENT);
const DEV = process.env.NODE_ENV === "development";
const LIVE = !DEV && SERVE && PLACEMENT;
const OWNER = REPO_URL?.match(/github\.com\/([\w-]+)\//)?.[1] ?? null;
const WAIT = 4000; // ms for the ad to appear once the script has loaded
const PREVIEW_KEY = "gitmanual-ad-preview";
const CHECKED_KEY = "gitmanual-pro-checked"; // when /api/pro was last asked, and whether it said Pro
const DAY = 24 * 60 * 60 * 1000;

const adFree = () => {
  try {
    return new RegExp(`(^|; )${AD_FREE_COOKIE}=`).test(document.cookie);
  } catch {
    return false;
  }
};

// For someone who has (or had) Pro in this browser: ask again at most once a day. Everyone else never asks.
function recheckPro() {
  let last: { at: number; pro: boolean } | null = null;
  try {
    last = JSON.parse(localStorage.getItem(CHECKED_KEY) ?? "null");
  } catch {}
  if (!adFree() && !last?.pro) return;
  if (last && Date.now() - last.at < DAY) return;
  fetch("/api/pro", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { pro?: boolean } | null) => {
      if (!j) return;
      try {
        localStorage.setItem(CHECKED_KEY, JSON.stringify({ at: Date.now(), pro: Boolean(j.pro) }));
      } catch {}
      if (j.pro) document.documentElement.setAttribute("data-noads", "");
    })
    .catch(() => {});
}

// Read when this file first loads, before a page (the manual) can tidy the address; kept for the tab's later pages.
if (DEV && typeof window !== "undefined") {
  const ad = new URLSearchParams(location.search).get("ad");
  try {
    if (ad === "blocked" || ad === "sponsor") sessionStorage.setItem(PREVIEW_KEY, ad);
    if (ad === "on") sessionStorage.removeItem(PREVIEW_KEY);
  } catch {}
}

const preview = () => {
  try {
    return sessionStorage.getItem(PREVIEW_KEY);
  } catch {
    return null;
  }
};

// For ?ad=sponsor in `next dev` only: a made-up sponsor, never saved anywhere, so the look can be checked locally.
const SAMPLE_PICTURE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b8def"/><stop offset="1" stop-color="#2d5bd8"/></linearGradient></defs><rect width="600" height="400" fill="url(#g)"/><rect x="60" y="120" width="96" height="96" rx="22" fill="#fff"/><path d="M84 190l24-46 24 46z" fill="#2d5bd8"/><text x="180" y="188" font-family="Helvetica,Arial,sans-serif" font-size="58" font-weight="800" fill="#fff">Acme Cloud</text><text x="62" y="290" font-family="Helvetica,Arial,sans-serif" font-size="28" fill="#dbe6ff">Deploy any repo in one click</text></svg>',
)}`;
const SAMPLE_SPONSOR: PublicSponsor = {
  id: 0,
  name: "Acme Cloud",
  text: "Deploy any repo in one click. Free for open source.",
  image: SAMPLE_PICTURE,
  href: "/advertise",
  package: "exclusive",
};

// The sponsor running today, if any (lib/sponsor.ts), asked once per tab and again after 5 minutes.
let sponsorAsk: { at: number; p: Promise<PublicSponsor | null> } | null = null;
function currentSponsor(): Promise<PublicSponsor | null> {
  if (DEV && preview() === "sponsor") return Promise.resolve(SAMPLE_SPONSOR);
  if (!sponsorAsk || Date.now() - sponsorAsk.at > 5 * 60 * 1000)
    sponsorAsk = {
      at: Date.now(),
      p: fetch("/api/sponsor")
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { sponsor?: PublicSponsor | null } | null) => j?.sponsor ?? null)
        .catch(() => null),
    };
  return sponsorAsk.p;
}

export function CarbonAd({ className }: { className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const page = usePathname();
  const [blocked, setBlocked] = useState(false);
  // undefined while deciding; a sponsor when this page shows one (Exclusive always, Shared about half the time).
  const [sponsor, setSponsor] = useState<PublicSponsor | null | undefined>(undefined);
  useEffect(() => {
    setBlocked(false);
    setSponsor(undefined);
    recheckPro();
    if (adFree()) return;
    let gone = false;
    let stop: (() => void) | undefined;
    currentSponsor().then((s) => {
      if (gone) return;
      const show = s && (s.package === "exclusive" || Math.random() < 0.5) ? s : null;
      setSponsor(show);
      if (show) return;
      if (DEV) {
        try {
          if (preview() === "blocked") setBlocked(true);
        } catch {}
        return;
      }
      const el = box.current;
      if (!LIVE || !el) return;
      let timer: number | undefined;
      // Shown means something besides the tag landed in the box and takes up room (blockers can also hide it).
      const shown = () => [...el.children].some((c) => c.tagName !== "SCRIPT" && (c as HTMLElement).offsetHeight > 0);
      const tag = document.createElement("script");
      tag.async = true;
      tag.id = "_carbonads_js";
      tag.src = `https://cdn.carbonads.com/carbon.js?serve=${SERVE}&placement=${PLACEMENT}&format=cover`;
      tag.onerror = () => setBlocked(true);
      tag.onload = () => {
        timer = window.setTimeout(() => !shown() && setBlocked(true), WAIT);
      };
      el.appendChild(tag);
      stop = () => {
        window.clearTimeout(timer);
        el.innerHTML = "";
      };
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, [page]);

  const cls = `ad${className ? ` ${className}` : ""}`;
  if (sponsor) return <SponsorAd sponsor={sponsor} className={cls} />;
  if (DEV)
    return blocked ? (
      <AdFallback className={cls} />
    ) : (
      <div className={`${cls} ad-placeholder`} aria-hidden="true">
        <span>Carbon ad</span>
        <small>Placeholder, only in local dev</small>
      </div>
    );
  if (!LIVE) return null;
  // The box stays in the page while the fallback shows, so the next page has somewhere to load its ad.
  return (
    <>
      {blocked && <AdFallback className={cls} />}
      <div ref={box} className={cls} hidden={blocked} />
    </>
  );
}

// A sponsor booked on /admin/sponsors, drawn in the site's own style: its picture (served by gitmanual, so nothing
// loads from the sponsor), one line, and a link that counts the click (/api/sponsor/click) and goes on to them.
function SponsorAd({ sponsor: s, className }: { sponsor: PublicSponsor; className: string }) {
  return (
    <aside className={`${className} ad-sponsor`} aria-label={`Ad: ${s.name}`}>
      <a className="ad-sp-link" href={s.href} target="_blank" rel="sponsored noopener">
        {s.image && <img className="ad-sp-img" src={s.image} alt={s.name} width={600} height={400} />}
        <span className="ad-sp-text">
          <b>{s.name}</b> {s.text}
        </span>
      </a>
      <span className="ad-sp-foot">
        <span className="ad-sp-tag">Ad</span>
        <Link href="/advertise">Advertise on gitmanual</Link>
      </span>
    </aside>
  );
}

// In-house, text links only (Carbon allows that), and only while no Carbon ad is showing. The box hops in once.
function AdFallback({ className }: { className: string }) {
  // "Advertise here" opens the site's contact form, so it shows only where that form is set up.
  const [contact, setContact] = useState(false);
  useEffect(() => setContact(Boolean(document.querySelector(".contact-open"))), []);
  return (
    <aside className={`${className} ad-fallback`} aria-label="Support gitmanual">
      <span className="ad-fallback-tag">No ad today</span>
      <span className="ad-fallback-box">
        <Logo size={44} />
      </span>
      <p className="ad-fallback-h">gitmanual is free and open source</p>
      <p>No account, no paywall. If it saved you an evening, you can help keep it running.</p>
      <div className="ad-fallback-links">
        {OWNER && (
          <a className="btn btn-go btn-sm ad-sponsor" href={`https://github.com/sponsors/${OWNER}`} target="_blank" rel="noreferrer">
            Sponsor on GitHub <span className="ad-heart" aria-hidden="true">♥</span>
          </a>
        )}
        {REPO_URL && (
          <a className="btn btn-sm" href={REPO_URL} target="_blank" rel="noreferrer">
            <span aria-hidden="true">★</span> Star the repo
          </a>
        )}
      </div>
      {contact && (
        <Link className="ad-advertise" href="/advertise">
          Want to advertise here?
        </Link>
      )}
    </aside>
  );
}
