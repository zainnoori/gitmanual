import type { Metadata } from "next";
import { SavedList } from "./saved";

export const metadata: Metadata = { title: "Saved repos", robots: { index: false, follow: false } };

// The person's saved repos. Read in the browser: the GitHub sign-in cookie is only sent to /api.
export default function SavedPage() {
  return (
    <div className="wrap saved-page">
      <h1 className="display-md">Saved repos</h1>
      <p className="lead">Repos you want to try, have installed or dropped. Only you can see this list.</p>
      <SavedList />
    </div>
  );
}
