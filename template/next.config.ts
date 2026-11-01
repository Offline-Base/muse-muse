import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Products run behind their own Vercel deployment. Keep this file small so Muse Code rarely needs to touch it.
  // Sandbox previews open from *.vercel.run. Without this, next dev refuses its dev socket there and buttons stay dead.
  allowedDevOrigins: ["*.vercel.run"],
};

export default nextConfig;
