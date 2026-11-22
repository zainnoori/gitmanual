import type { Metadata } from "next";
import { DocPage } from "../../doc";
import { AdminNav } from "../nav";
import { EmailAdmin } from "./compose";

export const metadata: Metadata = { title: "Email (admin)", robots: { index: false, follow: false } };

// Write to one person: about a problem (?kind=problem&id=12), a purchase (?kind=purchase&id=cs_…), a Pro subscription
// (?kind=subscription&id=sub_…), or to any address (no query). Only for ADMIN_GITHUB_LOGINS (checked by the API).
export default async function AdminEmail({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
  return (
    <DocPage eyebrow="Admin" title="Email" wide>
      <AdminNav current="email" />
      <EmailAdmin kind={one(q.kind) || "custom"} id={one(q.id)} />
    </DocPage>
  );
}
