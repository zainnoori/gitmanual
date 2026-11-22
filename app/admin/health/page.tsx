import type { Metadata } from "next";
import { DocPage } from "../../doc";
import { AdminNav } from "../nav";
import { HealthAdmin } from "./view";

export const metadata: Metadata = { title: "Health (admin)", robots: { index: false, follow: false } };

// Is each part of the site set up, and did the background jobs run. Only for ADMIN_GITHUB_LOGINS (checked by the API).
export default function AdminHealth() {
  return (
    <DocPage eyebrow="Admin" title="Health" wide>
      <AdminNav current="health" />
      <HealthAdmin />
    </DocPage>
  );
}
