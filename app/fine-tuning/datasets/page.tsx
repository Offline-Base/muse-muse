import { redirect } from "next/navigation";

/** The datasets are listed on /fine-tuning. Without this, /fine-tuning/datasets would read as a job id. */
export default function DatasetsIndex(): never {
  redirect("/fine-tuning#datasets");
}
