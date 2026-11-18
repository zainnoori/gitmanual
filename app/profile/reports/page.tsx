import type { Metadata } from "next";
import { ReportsList } from "./reports";

export const metadata: Metadata = { title: "Your reports", robots: { index: false, follow: false } };

// Repos whose report was bought once (app/api/pro/report): Deep Inspection and PDF manuals, kept here.
// Read in the browser: the GitHub sign-in cookie is only sent to /api.
export default function ReportsPage() {
  return (
    <div className="wrap saved-page">
      <h1 className="display-md">Your reports</h1>
      <p className="lead">Repos you bought a report for. Each one keeps its Deep Inspection and PDF manuals. Only you can see this list.</p>
      <ReportsList />
    </div>
  );
}
