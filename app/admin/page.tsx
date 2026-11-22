import type { Metadata } from "next";
import { DocPage } from "../doc";
import { AdminHome } from "./home";
import { AdminNav } from "./nav";

export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

// The admin's start page: this week in numbers, and what's waiting for an answer. Only for ADMIN_GITHUB_LOGINS
// (checked by the API).
export default function Admin() {
  return (
    <DocPage eyebrow="Admin" title="Overview" wide>
      <AdminNav current="home" />
      <AdminHome />
    </DocPage>
  );
}
