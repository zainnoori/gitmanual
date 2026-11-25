import { NextResponse } from "next/server";
import { deleteSponsor, listSponsors, saveSponsor, sponsorOverlap } from "@/lib/db";
import { checkSponsor, SPONSOR_IMAGE_TYPES, SPONSOR_LIMITS } from "@/lib/sponsor";
import { isAdmin, viewer } from "@/lib/viewer";

// For site admins (ADMIN_GITHUB_LOGINS): the sponsor bookings on /admin/sponsors.
//   GET → {sponsors}    POST {id?, name, text, url, package, startsOn, endsOn, image?} → {ok, id}    DELETE ?id=
// image: a data: URL (PNG, JPEG or WebP) to set it, null to remove it, left out to keep it.
const NO_STORE = { "Cache-Control": "private, no-store" };
const fail = (error: string, status = 400) => NextResponse.json({ error }, { status, headers: NO_STORE });

async function admin() {
  const { user } = await viewer();
  return user && isAdmin(user.login) ? user : null;
}

// The picture from a data: URL, checked: an allowed type, small enough, and really that kind of file.
function parseImage(v: unknown): { data: string; type: string } | null | undefined | string {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const m = typeof v === "string" ? /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(v) : null;
  if (!m || !SPONSOR_IMAGE_TYPES.includes(m[1])) return "The picture has to be a PNG, JPEG or WebP file.";
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > SPONSOR_LIMITS.imageBytes) return `The picture is too big: keep it under ${Math.round(SPONSOR_LIMITS.imageBytes / 1000)} KB.`;
  const head = bytes.subarray(0, 12).toString("latin1");
  const real = m[1] === "image/png" ? head.startsWith("\x89PNG") : m[1] === "image/jpeg" ? head.startsWith("\xff\xd8\xff") : head.startsWith("RIFF") && head.slice(8) === "WEBP";
  if (!real) return "That file isn't the picture it says it is.";
  return { data: m[2], type: m[1] };
}

export async function GET() {
  if (!(await admin())) return fail("Admins only.", 403);
  return NextResponse.json({ sponsors: await listSponsors() }, { headers: NO_STORE });
}

export async function POST(req: Request) {
  if (!(await admin())) return fail("Admins only.", 403);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const s = checkSponsor(body);
  if (typeof s === "string") return fail(s);
  const image = parseImage(body.image);
  if (typeof image === "string") return fail(image);
  const id = typeof body.id === "number" && Number.isInteger(body.id) ? body.id : null;
  if (id == null && !image) return fail("Add a picture: the logo or an image for the ad.");
  const clash = await sponsorOverlap(s.startsOn, s.endsOn, id);
  if (clash) return fail(`Those dates overlap ${clash.name} (${clash.startsOn} to ${clash.endsOn}). One booking runs at a time.`);
  return NextResponse.json({ ok: true, id: await saveSponsor(id, { ...s, image }) }, { headers: NO_STORE });
}

export async function DELETE(req: Request) {
  if (!(await admin())) return fail("Admins only.", 403);
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id)) return fail("Send the booking's id.");
  await deleteSponsor(id);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
