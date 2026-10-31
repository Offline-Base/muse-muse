import type { MetadataRoute } from "next";
import product from "../musemuse.json";

/** Adding the product to a phone's home screen opens it full screen. The name comes from musemuse.json, so keep that filled in. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: product.name,
    short_name: product.name.length > 12 ? product.name.split(/\s+/)[0]!.slice(0, 12) : product.name,
    description: product.tagline,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f0f2f5",
    theme_color: "#0866ff",
    icons: [
      { src: "/icon/192", sizes: "192x192", type: "image/png" },
      { src: "/icon/512", sizes: "512x512", type: "image/png" },
      { src: "/icon/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
