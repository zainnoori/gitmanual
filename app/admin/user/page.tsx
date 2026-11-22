import type { Metadata } from "next";
import { DocPage } from "../../doc";
import { AdminNav } from "../nav";
import { UserAdmin } from "./view";

export const metadata: Metadata = { title: "User (admin)", robots: { index: false, follow: false } };

// One person (?login=octocat or ?id=123): before replying or sending a code. Only for ADMIN_GITHUB_LOGINS (checked by the API).
export default async function AdminUser({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
  return (
    <DocPage eyebrow="Admin" title="User" wide>
      <AdminNav current="user" />
      <UserAdmin login={one(q.login)} id={one(q.id)} />
    </DocPage>
  );
}
