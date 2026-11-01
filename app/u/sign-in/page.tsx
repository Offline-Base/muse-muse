import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { PasskeySignIn } from "@/components/signin/PasskeySignIn";
import { isSignInBind } from "@/lib/caps/data/identity";
import { productForSignIn } from "@/lib/caps/data/users";
import { env } from "@/lib/env";
import { safeReturnPath } from "@/lib/tools/principal";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Where a product's "Sign in" goes (DATA_SIGN_IN, docs/CAPABILITIES.md, section 9): a passkey through Muse Muse, then
 * back to the product's own live link with a one-time code for the browser that started it. 404 while the data cap or
 * sign-in is off, and for a link without the product browser's sign-in value.
 */
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ product?: string; returnTo?: string; bind?: string }> }) {
  await connection();
  if (!env.servedCaps.includes("data") || !env.dataSignIn) notFound();
  const { product, returnTo, bind } = await searchParams;
  if (!product || !/^[a-z0-9-]{1,60}$/.test(product)) notFound();
  // The value the product put in its browser's sign-in cookie. A link without one didn't come from the product's Sign in.
  if (!isSignInBind(bind)) notFound();
  const found = await productForSignIn(product).catch(() => null);
  if (!found) notFound();
  return (
    <div className="page page-narrow">
      <section className="card signin">
        <h1>Sign in to {found.name}</h1>
        <PasskeySignIn product={product} productName={found.name} returnTo={safeReturnPath(returnTo) ?? "/"} bind={bind} />
      </section>
    </div>
  );
}
