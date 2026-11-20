import type { Metadata } from "next";
import { DocPage } from "../../doc";
import { PurchasesAdmin } from "./list";

export const metadata: Metadata = { title: "Purchases (admin)", robots: { index: false, follow: false } };

// One-time repo purchases ($4.99 a repo) and Pro subscriptions. Only for ADMIN_GITHUB_LOGINS (checked by the API).
export default function AdminPurchases() {
  return (
    <DocPage eyebrow="Admin" title="Purchases" wide>
      <PurchasesAdmin />
    </DocPage>
  );
}
