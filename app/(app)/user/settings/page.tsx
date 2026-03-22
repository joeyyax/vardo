import { redirect } from "next/navigation";

export default function UserSettingsIndex() {
  redirect("/user/settings/profile");
}
