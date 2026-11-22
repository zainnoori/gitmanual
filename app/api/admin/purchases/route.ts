import { NextResponse } from "next/server";
import { listPayments } from "@/lib/db";
import { isAdmin, viewer } from "@/lib/viewer";

// For site admins (ADMIN_GITHUB_LOGINS): every one-time repo purchase and every Pro subscription.
const NO_STORE = { "Cache-Control": "private, no-store" };

// ?format=csv: the one-time purchases as a spreadsheet, for bookkeeping (amounts before tax, in each currency).
const cell = (v: string | number | null) => {
  const s = v == null ? "" : String(v);
  // Quoted when needed; a leading = + - @ is prefixed so a spreadsheet doesn't run it as a formula.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export async function GET(req: Request) {
  const { user } = await viewer();
  if (!user || !isAdmin(user.login)) return NextResponse.json({ error: "Admins only." }, { status: 403, headers: NO_STORE });
  try {
    const data = await listPayments(100_000);
    if (new URL(req.url).searchParams.get("format") === "csv") {
      const rows = [
        ["paid_at_utc", "repo", "buyer", "github_id", "amount", "currency", "test", "stripe_session"],
        ...data.purchases.map((p) => [
          new Date(p.paidAt).toISOString(),
          p.fullName,
          p.login ?? "",
          p.githubId,
          (p.amount / 100).toFixed(2),
          p.currency.toUpperCase(),
          p.session.startsWith("cs_test_") ? "yes" : "no",
          p.session,
        ]),
      ];
      const csv = rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
      return new NextResponse(csv, {
        headers: { ...NO_STORE, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="gitmanual-purchases-${new Date().toISOString().slice(0, 10)}.csv"` },
      });
    }
    return NextResponse.json(data, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "The database didn't answer. Try again in a minute." }, { status: 503, headers: NO_STORE });
  }
}
