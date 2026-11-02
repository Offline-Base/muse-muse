import { redirect } from "next/navigation";

/** The old media page, which no link reaches any more. Its products are all in the gallery. */
export default function MediaPage() {
  redirect("/gallery");
}
