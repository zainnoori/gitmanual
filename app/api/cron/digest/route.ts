import { NextResponse } from "next/server";
import { adminOverview, markHealth, sinceNumbers } from "@/lib/db";
import { notifyAdmins } from "@/lib/notify";
import { SITE_URL } from "@/lib/site";

// Daily (vercel.json): one email to ADMIN_EMAIL with the last 24 hours and what still needs an answer.
// Skipped on a day with nothing new and nothing waiting.
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/digest
const money = (cents: number, currency: string) => {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
};

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const now = Date.now();
    const [day, o] = await Promise.all([sinceNumbers(now - 864e5), adminOverview(now)]);
    if (!day.problems && !day.purchases && !day.newUsers && !o.unanswered) {
      await markHealth("cron-digest", true, "nothing to send");
      return NextResponse.json({ sent: false });
    }
    const totals = day.totals.map((t) => money(t.cents, t.currency)).join(" + ");
    const lines = [
      "**Last 24 hours**",
      [
        `- ${day.purchases} ${day.purchases === 1 ? "report" : "reports"} bought${totals ? ` (${totals})` : ""}`,
        `- ${day.problems} new ${day.problems === 1 ? "problem or message" : "problems and messages"}`,
        `- ${day.newUsers} new ${day.newUsers === 1 ? "user" : "users"}`,
        `- ${o.proRunning} Pro ${o.proRunning === 1 ? "member" : "members"} now`,
      ].join("\n"),
    ];
    if (o.unanswered) {
      lines.push(`**Waiting for an answer: ${o.unanswered}**`);
      lines.push(
        o.attention
          .slice(0, 8)
          .map((p) => `- [#${p.id}${p.repo ? ` ${p.repo}` : ""}](${SITE_URL}/admin/email?kind=problem&id=${p.id}): ${p.message.replace(/\s+/g, " ").slice(0, 90)}`)
          .join("\n"),
      );
    }
    lines.push(`[Open the admin](${SITE_URL}/admin)`);
    const date = new Date(now).toISOString().slice(0, 10);
    await notifyAdmins(`Daily summary, ${date}`, lines.join("\n\n"), `digest/${date}`, { summary: true });
    await markHealth("cron-digest", true, "sent");
    return NextResponse.json({ sent: true });
  } catch (e) {
    await markHealth("cron-digest", false, e instanceof Error ? e.message : String(e));
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
