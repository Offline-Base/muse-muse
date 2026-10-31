import { ImageResponse } from "next/og";
import product from "../../musemuse.json";

/** The product name's first letter, or M. Only A to Z: the image's built-in font has no others, and the build has no network. */
function initial(name: string): string {
  return name.match(/[A-Za-z]/)?.[0]?.toUpperCase() ?? "M";
}

/** The home screen icon: the name's first letter on Meta blue, away from the edges so a phone's mask can't cut it. */
export function appIcon(size: number): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0866ff",
        color: "#ffffff",
        fontSize: Math.round(size * 0.5),
        fontWeight: 700,
      }}
    >
      {initial(product.name)}
    </div>,
    { width: size, height: size },
  );
}
