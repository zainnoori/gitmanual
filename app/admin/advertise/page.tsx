import type { Metadata } from "next";
import { DocPage } from "../../doc";
import { AdminNav } from "../nav";
import { AdvertiseAdmin } from "./view";

export const metadata: Metadata = { title: "Advertise (admin)", robots: { index: false, follow: false } };

// The numbers on /advertise. Only for ADMIN_GITHUB_LOGINS (checked by the API).
export default function AdminAdvertise() {
  return (
    <DocPage eyebrow="Admin" title="Advertise page" wide>
      <AdminNav current="advertise" />
      <AdvertiseAdmin />
    </DocPage>
  );
}
