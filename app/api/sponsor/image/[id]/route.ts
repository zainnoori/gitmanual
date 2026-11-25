import { sponsorImage } from "@/lib/db";
import { SPONSOR_IMAGE_TYPES } from "@/lib/sponsor";

// A sponsor's picture, stored with the booking, so the ad loads nothing from the advertiser's servers.
// The address carries ?v=<last change>, so it can be cached for good.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const img = Number.isInteger(id) ? await sponsorImage(id) : null;
  if (!img || !SPONSOR_IMAGE_TYPES.includes(img.type)) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(img.data, "base64"), {
    headers: { "Content-Type": img.type, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
  });
}
