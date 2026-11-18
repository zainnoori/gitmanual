import type { Metadata } from "next";
import { REPO_URL } from "@/lib/site";
import { DocPage } from "../doc";
import { ProblemForm } from "../report-problem";

export const metadata: Metadata = {
  title: "Contact",
  description: "Questions, feedback, a wrong setup, or advertising on gitmanual.",
  alternates: { canonical: "/contact" },
};

// The contact form (app/report-problem.tsx), kept on gitmanual and read on /admin/problems.
export default function Contact() {
  return (
    <DocPage eyebrow="Contact" title="Get in touch" lead="Questions, feedback or advertising: send a message and we'll reply by email.">
      <div className="doc-form">
        <ProblemForm mode="contact" />
      </div>

      {REPO_URL && (
        <>
          <h2>Found a wrong step?</h2>
          <p>
            Use &ldquo;Something wrong with this manual?&rdquo; under the steps of any manual: it sends the step and your system with it.
            Or, to discuss it in public,{" "}
            <a href={`${REPO_URL}/issues/new/choose`} target="_blank" rel="noreferrer">
              open a GitHub issue
            </a>
            .
          </p>
          <h2>Maintainers</h2>
          <p>If you maintain a project and want something on its manual changed or removed, pick &ldquo;My repo&apos;s manual&rdquo; above.</p>
        </>
      )}
    </DocPage>
  );
}
