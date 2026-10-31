"use client";

import { useEffect, useRef, useState } from "react";

/** The sizes the frame offers, in CSS px, so a page lays out as it would on that device. The frame itself is generic. */
export const DEVICE_SIZES = {
  phone: { label: "Phone", width: 390, height: 844 },
  tablet: { label: "Tablet", width: 768, height: 1024 },
  desktop: { label: "Desktop", width: 1280, height: 800 },
} as const;
export type DeviceSize = keyof typeof DEVICE_SIZES;

/** The tallest the frame gets on the page. A taller device is scaled down to fit, like one that's too wide. */
const MAX_HEIGHT = 720;
/** The frame's edge around the screen, in the device's own px. */
const BEZEL = 12;

/** How much a device has to shrink to fit the room it has. Never more than 1. */
export function deviceScale(size: DeviceSize, availableWidth: number, maxHeight = MAX_HEIGHT): number {
  const { width, height } = DEVICE_SIZES[size];
  return Math.min(1, availableWidth / (width + BEZEL * 2), maxHeight / (height + BEZEL * 2));
}

/**
 * The live product in a plain device frame, with a Phone, Tablet and Desktop switch (docs/NATIVE.md). The page lays out at
 * the device's real width and the whole frame is scaled to fit, so it's what that device would show, even on a small window.
 * The iframe waits until the frame has measured its room, and stays the same element across sizes, so a switch keeps the
 * person's place in the product.
 */
export function DeviceFrame({ src, title, allow, sandbox }: { src: string; title: string; allow: string; sandbox: string }) {
  const [size, setSize] = useState<DeviceSize>("phone");
  const [room, setRoom] = useState<number | null>(null);
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    setRoom(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setRoom(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const device = DEVICE_SIZES[size];
  const outerWidth = device.width + BEZEL * 2;
  const outerHeight = device.height + BEZEL * 2;
  const scale = room === null ? 1 : deviceScale(size, room);

  return (
    <div className="getit-device-wrap">
      <div className="getit-sizes" role="group" aria-label="Device size">
        {(Object.keys(DEVICE_SIZES) as DeviceSize[]).map((id) => (
          <button key={id} type="button" className="getit-size" aria-pressed={id === size} onClick={() => setSize(id)}>
            {DEVICE_SIZES[id].label}
          </button>
        ))}
      </div>
      <div ref={stage} className="getit-stage" style={{ height: Math.round(outerHeight * scale) }}>
        {room === null ? null : (
          <div
            className={`getit-device is-${size}`}
            style={{ width: outerWidth, height: outerHeight, padding: BEZEL, left: Math.max(0, (room - outerWidth * scale) / 2), transform: `scale(${scale})` }}
          >
            <iframe src={src} title={title} loading="lazy" allow={allow} sandbox={sandbox} referrerPolicy="no-referrer" />
          </div>
        )}
      </div>
    </div>
  );
}
