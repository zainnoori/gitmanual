import type { Metadata } from "next";
import { DocPage } from "../../doc";
import { AdminNav } from "../nav";
import { ProblemsAdmin } from "./list";

export const metadata: Metadata = { title: "Inbox (admin)", robots: { index: false, follow: false } };

// Contact messages and problem reports (from the manuals and the footer), newest first, to mark done. Only for
// ADMIN_GITHUB_LOGINS (checked by the API).
export default function AdminProblems() {
  return (
    <DocPage eyebrow="Admin" title="Inbox" lead="Contact messages and problem reports, newest first." wide>
      <AdminNav current="problems" />
      <ProblemsAdmin />
    </DocPage>
  );
}
