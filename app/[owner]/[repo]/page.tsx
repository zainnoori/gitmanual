import { RepoManual, generateMetadata, type Props } from "./manual";

// gitmanual.com/owner/repo mirrors github.com/owner/repo, so swapping "hub" for "manual" in a URL just works.
export { generateMetadata };
// A new repo is read in seconds; a stuck one fails here instead of holding the request for 5 minutes.
export const maxDuration = 60;

export default function RepoPage(props: Props) {
  return <RepoManual {...props} />;
}
