import { redirect } from "next/navigation";

// The profile area: "Saved" (app/profile/saved) and "Your reports" (app/profile/reports, bought repo reports).
export default function ProfilePage() {
  redirect("/profile/saved");
}
