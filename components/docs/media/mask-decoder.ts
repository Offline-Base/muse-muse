import { decodeMaskToRaster } from "@meta-sam/parser";
import { setMaskRasterDecoder } from "@/lib/docs/media/sam-mask";

/**
 * Turns on mask pixels for every SAM overlay. The docs describe a mask payload's envelope but not the arithmetic coder
 * inside it, so the pixels come from Meta's own parser (@meta-sam/parser, the package Meta's SAM pages point to and the
 * product template already uses). MaskOverlay imports this module for its side effect.
 */
setMaskRasterDecoder((mask) => decodeMaskToRaster(mask));
