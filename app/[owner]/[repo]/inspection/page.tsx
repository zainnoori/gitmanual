import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { repoHidden, repoKey } from "@/lib/db";
import { PRO_ENABLED } from "@/lib/stripe";
import { InspectionView } from "../../../inspection";

// Deep Inspection of one repo (Pro): its own page, beside the manual. The report itself is loaded in the browser
// (app/api/inspection) for Pro members only, so this page has nothing for search engines to index.
type Props = { params: Promise<{ owner: string; repo: string }> };

const GITHUB_OWNER = /^[a-z\d][a-z\d-]{0,38}$/i;
const GITHUB_REPO = /^[\w.-]{1,100}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { owner, repo } = await params;
  return {
    title: `Deep Inspection of ${owner}/${repo}`,
    description: `Requirements, maintenance, risks and gaps to review before adopting ${owner}/${repo}: setup, license, who controls it, security, data and costs.`,
    robots: { index: false, follow: true },
    alternates: { canonical: `/${owner}/${repo}/inspection` },
  };
}

export default async function InspectionPage({ params }: Props) {
  const { owner, repo } = await params;
  if (!PRO_ENABLED() || !GITHUB_OWNER.test(owner) || !GITHUB_REPO.test(repo)) notFound();
  if (await repoHidden(repoKey(owner, repo))) notFound(); // taken down by an admin (/admin/repos)
  return <InspectionView repo={`${owner}/${repo}`} />;
}
