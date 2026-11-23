import type { Metadata } from "next";
import { DocPage } from "../../doc";
import { AdminNav } from "../nav";
import { ReposAdmin } from "./view";

export const metadata: Metadata = { title: "Repos (admin)", robots: { index: false, follow: false } };

// Take a manual down, and see the repos a re-read found gone from GitHub. Only for ADMIN_GITHUB_LOGINS (checked by the API).
export default async function AdminRepos({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { repo } = await searchParams;
  return (
    <DocPage eyebrow="Admin" title="Repos" wide>
      <AdminNav current="repos" />
      <ReposAdmin initial={typeof repo === "string" ? repo : ""} />
    </DocPage>
  );
}
