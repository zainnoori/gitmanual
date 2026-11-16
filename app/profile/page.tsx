import { redirect } from "next/navigation";

// The profile area: only "Saved" so far (app/profile/saved). Settings and billing can join it later.
export default function ProfilePage() {
  redirect("/profile/saved");
}
