import type { Metadata } from "next";
import { DocPage } from "../../doc";
import { AdminNav } from "../nav";
import { SponsorsAdmin } from "./view";

export const metadata: Metadata = { title: "Sponsors (admin)", robots: { index: false, follow: false } };

// Direct-sold ads: book a sponsor for dates, see its clicks. Only for ADMIN_GITHUB_LOGINS (checked by the API).
export default function AdminSponsors() {
  return (
    <DocPage eyebrow="Admin" title="Sponsors" wide>
      <AdminNav current="sponsors" />
      <SponsorsAdmin />
    </DocPage>
  );
}
