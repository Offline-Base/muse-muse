import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { PasskeySignIn } from "@/components/signin/PasskeySignIn";
import { productForSignIn } from "@/lib/caps/data/users";
import { env } from "@/lib/env";
import { safeReturnPath } from "@/lib/tools/principal";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Where a product's "Sign in" goes (DATA_SIGN_IN, docs/CAPABILITIES.md, section 9): a passkey through Muse Muse, then
 * back to the product's own live link with a one-time code. 404 while the data cap or sign-in is off.
 */
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ product?: string; returnTo?: string }> }) {
  await connection();
  if (!env.servedCaps.includes("data") || !env.dataSignIn) notFound();
  const { product, returnTo } = await searchParams;
  if (!product || !/^[a-z0-9-]{1,60}$/.test(product)) notFound();
  const found = await productForSignIn(product).catch(() => null);
  if (!found) notFound();
  return (
    <div className="page page-narrow">
      <section className="card signin">
        <h1>Sign in to {found.name}</h1>
        <PasskeySignIn product={product} productName={found.name} returnTo={safeReturnPath(returnTo) ?? "/"} />
      </section>
    </div>
  );
}
