import { appIcon } from "@/lib/native/app-icon";

const SIZES = [192, 512];

export function generateImageMetadata() {
  return SIZES.map((size) => ({ id: String(size), contentType: "image/png", size: { width: size, height: size } }));
}

export default async function Icon({ id }: { id: Promise<string | number> }) {
  return appIcon(Number(await id));
}
