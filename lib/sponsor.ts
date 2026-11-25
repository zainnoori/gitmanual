// Direct-sold ads (sponsors), shown in the ad slot instead of Carbon while a booking runs (app/carbon.tsx).
// Safe in the browser; the database side is in lib/db.ts.

export const SPONSOR_LIMITS = { name: 60, text: 110, url: 500, imageBytes: 300_000 };
export const SPONSOR_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

// What the site gets from /api/sponsor: enough to draw the ad, nothing else.
export type PublicSponsor = { id: number; name: string; text: string; image: string | null; href: string; package: "shared" | "exclusive" };

// Today as YYYY-MM-DD in UTC: bookings start and end on whole UTC days.
export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Checks a booking from /admin/sponsors. Returns the clean booking, or what's wrong.
export function checkSponsor(b: Record<string, unknown>):
  | { name: string; text: string; url: string; package: "shared" | "exclusive"; startsOn: string; endsOn: string }
  | string {
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const name = str(b.name, SPONSOR_LIMITS.name);
  const text = str(b.text, SPONSOR_LIMITS.text);
  const url = str(b.url, SPONSOR_LIMITS.url);
  const startsOn = str(b.startsOn, 10);
  const endsOn = str(b.endsOn, 10);
  if (!name) return "Add the sponsor's name.";
  if (!text) return "Add the line of text.";
  try {
    if (new URL(url).protocol !== "https:") return "The link has to start with https://.";
  } catch {
    return "The link isn't a web address.";
  }
  if (!DAY.test(startsOn) || !DAY.test(endsOn) || isNaN(Date.parse(startsOn)) || isNaN(Date.parse(endsOn))) return "Pick a start and an end date.";
  if (endsOn < startsOn) return "The end date is before the start date.";
  return { name, text, url, package: b.package === "exclusive" ? "exclusive" : "shared", startsOn, endsOn };
}
