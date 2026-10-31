"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { CAMERA_MAX_SIDE, cameraError, cameraFileName, fitPhoto } from "@/lib/client/camera";

type Facing = "environment" | "user";

/** True where the browser can open a camera: a secure page with getUserMedia. False until mounted, so it's safe to SSR. */
export function useCameraSupported(): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => setSupported(Boolean(navigator.mediaDevices?.getUserMedia)), []);
  return supported;
}

/**
 * Takes a photo with the device's camera: a live preview, then the shot to keep or retake. Nothing leaves the page
 * until the reader presses "Use this photo", and the camera is released as soon as the dialog closes.
 */
export function CameraCapture({ open, onClose, onCapture }: { open: boolean; onClose(): void; onCapture(file: File): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<Facing>("environment");
  const [canSwitch, setCanSwitch] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<{ file: File; url: string } | null>(null);

  const release = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setReady(false);
  }, []);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  // The live preview, while the dialog is open and no shot is waiting.
  useEffect(() => {
    if (!open || shot) return;
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) {
          media.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = media;
        const el = video.current;
        if (el) {
          el.srcObject = media;
          await el.play().catch(() => {});
        }
        setReady(true);
        // Device labels and counts are only known once permission is granted.
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) setCanSwitch(devices.filter((d) => d.kind === "videoinput").length > 1);
      } catch (err) {
        if (!cancelled) setError(cameraError(err));
      }
    })();
    return () => {
      cancelled = true;
      release();
    };
  }, [open, shot, facing, release]);

  const clearShot = useCallback(() => {
    setShot((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!open) clearShot();
  }, [open, clearShot]);

  const capture = () => {
    const el = video.current;
    if (!el || !el.videoWidth) return;
    const { width, height } = fitPhoto(el.videoWidth, el.videoHeight, CAMERA_MAX_SIDE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(el, 0, 0, width, height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setError("Couldn't take that photo. Try again.");
          return;
        }
        const file = new File([blob], cameraFileName(new Date()), { type: "image/jpeg" });
        setShot({ file, url: URL.createObjectURL(blob) });
      },
      "image/jpeg",
      0.92,
    );
  };

  return (
    <dialog
      ref={dialog}
      className="camera"
      aria-label="Take a photo"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
    >
      {open ? (
        <div className="camera-body">
          <div className="camera-head">
            <h2>Take a photo</h2>
            <button type="button" className="icon-btn icon-btn-plain" aria-label="Close the camera" onClick={onClose}>
              <Icon name="close" size={18} />
            </button>
          </div>
          <div className="camera-stage">
            {shot ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={shot.url} alt="The photo you took" />
            ) : (
              <video ref={video} muted playsInline aria-label="Camera preview" />
            )}
            {error ? (
              <p className="camera-error" role="alert">
                {error}
              </p>
            ) : !shot && !ready ? (
              <p className="camera-wait">Opening the camera...</p>
            ) : null}
          </div>
          <div className="camera-actions">
            {shot ? (
              <>
                <button type="button" className="btn btn-outline" onClick={clearShot}>
                  Retake
                </button>
                <button type="button" className="btn btn-primary" onClick={() => onCapture(shot.file)}>
                  Use this photo
                </button>
              </>
            ) : (
              <>
                {canSwitch ? (
                  <button type="button" className="btn btn-outline" onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}>
                    Switch camera
                  </button>
                ) : null}
                <button type="button" className="btn btn-primary" onClick={capture} disabled={!ready}>
                  <Icon name="camera" size={16} />
                  <span>Take photo</span>
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

/** A button that opens the camera and hands over the photo. Renders nothing where the browser has no camera access. */
export function CameraButton({ onCapture, disabled, className = "btn btn-sm btn-outline", label = "Take a photo" }: { onCapture(file: File): void; disabled?: boolean; className?: string; label?: string }) {
  const supported = useCameraSupported();
  const [open, setOpen] = useState(false);
  if (!supported) return null;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} disabled={disabled}>
        <Icon name="camera" size={16} />
        <span>{label}</span>
      </button>
      <CameraCapture
        open={open}
        onClose={() => setOpen(false)}
        onCapture={(file) => {
          setOpen(false);
          onCapture(file);
        }}
      />
    </>
  );
}
