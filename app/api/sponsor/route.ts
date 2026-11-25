import { NextResponse } from "next/server";
import { activeSponsor } from "@/lib/db";
import { today, type PublicSponsor } from "@/lib/sponsor";

// The sponsor running today, for the ad slot (app/carbon.tsx): {sponsor: … | null}. Cached at the edge for a few
// minutes, so a new booking or its end shows within ~5 minutes and the database is asked rarely.
export async function GET() {
  const s = await activeSponsor(today());
  const sponsor: PublicSponsor | null = s && {
    id: s.id,
    name: s.name,
    text: s.text,
    image: s.hasImage ? `/api/sponsor/image/${s.id}?v=${s.updatedAt}` : null,
    href: `/api/sponsor/click/${s.id}`,
    package: s.package,
  };
  return NextResponse.json({ sponsor }, { headers: { "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600" } });
}
