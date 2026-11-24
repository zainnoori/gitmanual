import { NextResponse } from "next/server";
import { getCached, repoKey } from "@/lib/db";
import { parseRepoUrl } from "@/lib/github";
import { hardwareNeeds, hasHardware } from "@/lib/hardware";
import type { RepoData } from "@/lib/pipeline";

// The Hardware tab on a manual: what the repo needs from the computer (lib/hardware.ts), read from the manual's saved
// README, setup guide and project files when the tab is opened, so the page itself doesn't carry them. GET ?repo=owner/name. Nothing is read from
// GitHub: no saved manual, nothing to say. The same for everyone, so the CDN keeps it for an hour.
const CACHE = { "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400" };

export async function GET(req: Request) {
  const ref = parseRepoUrl(new URL(req.url).searchParams.get("repo") ?? "");
  if (!ref) return NextResponse.json({ error: "Expected ?repo=owner/name" }, { status: 400 });
  const saved = await getCached(repoKey(ref.owner, ref.repo)); // null for a manual an admin took down
  if (!saved) return NextResponse.json({ error: "No manual for this repo yet." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const data = saved.data as RepoData;
  const hardware = hardwareNeeds(data.files ?? {}, { setupDoc: data.guides?.doc?.path });
  return NextResponse.json({ hardware, found: hasHardware(hardware) }, { headers: CACHE });
}
