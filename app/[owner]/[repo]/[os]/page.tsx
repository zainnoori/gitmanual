import { RepoManual, generateMetadata, type Props } from "../manual";

// The same manual for one system (/owner/repo/macos, /windows, /linux), with its own title for search.
// Any other value shows the not-found page (noindex).
export { generateMetadata };
// A new repo is read in seconds; a stuck one fails here instead of holding the request for 5 minutes.
export const maxDuration = 60;

export default function RepoOsPage(props: Props) {
  return <RepoManual {...props} />;
}
