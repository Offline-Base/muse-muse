import { qrMatrix, qrPath } from "@/lib/qr";

/**
 * A QR code, black on white with its quiet zone whatever the page's theme, because scanners need both. `label` says what
 * it opens, for screen readers. Renders on the server.
 */
export function QrCode({ value, label, size = 160 }: { value: string; label: string; size?: number }) {
  const margin = 4;
  const matrix = qrMatrix(value);
  const side = matrix.size + margin * 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${side} ${side}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={side} height={side} fill="#fff" />
      <path fill="#000" d={qrPath(matrix, margin)} />
    </svg>
  );
}
