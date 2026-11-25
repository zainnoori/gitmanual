import { AD_DEFAULTS, AD_LIMITS, type AdNumber, type AdStats } from "./advertise";
import { getSetting, setSetting } from "./db";

// The /advertise numbers in site_settings: read by the page, saved from /admin/advertise.
const KEY = "advertise";

// Only in `next dev`, while nothing is saved for the site: sample numbers to see the layout with. Never saved.
const DEV_SAMPLE: AdNumber[] = [
  { value: "48K+", label: "visitors in the last 30 days" },
  { value: "150K+", label: "page views in the last 30 days" },
  { value: "500K+", label: "visitors since launch" },
  { value: "291", label: "GitHub stars" },
];

export async function adStats(): Promise<AdStats> {
  const saved = await getSetting<Partial<AdStats>>(KEY);
  const stats = { ...AD_DEFAULTS, ...(saved ?? {}) };
  if (process.env.NODE_ENV === "development" && !stats.site.length) stats.site = DEV_SAMPLE;
  return stats;
}

// For /admin/advertise: what's really saved, without the sample.
export async function savedAdStats(): Promise<AdStats> {
  return { ...AD_DEFAULTS, ...((await getSetting<Partial<AdStats>>(KEY)) ?? {}) };
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const numbers = (v: unknown): AdNumber[] =>
  (Array.isArray(v) ? v : [])
    .map((n) => ({ value: text(n?.value, AD_LIMITS.value), label: text(n?.label, AD_LIMITS.label) }))
    .filter((n) => n.value && n.label)
    .slice(0, AD_LIMITS.numbers);

// Checks what /admin/advertise sent and saves it.
export async function saveAdStats(body: unknown): Promise<AdStats> {
  const b = (body ?? {}) as Record<string, unknown>;
  const stats: AdStats = {
    site: numbers(b.site),
    social: numbers(b.social),
    updated: text(b.updated, AD_LIMITS.text) || null,
    nextOpen: text(b.nextOpen, AD_LIMITS.text) || null,
  };
  await setSetting(KEY, stats);
  return stats;
}
