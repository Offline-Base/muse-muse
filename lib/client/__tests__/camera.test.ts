import assert from "node:assert/strict";
import { test } from "node:test";
import { cameraError, cameraFileName, fitPhoto } from "@/lib/client/camera";

test("a photo scales down to fit, keeping its shape, and never up", () => {
  assert.deepEqual(fitPhoto(4000, 3000, 2048), { width: 2048, height: 1536 });
  assert.deepEqual(fitPhoto(1080, 1920, 960), { width: 540, height: 960 });
  assert.deepEqual(fitPhoto(640, 480, 2048), { width: 640, height: 480 });
});

test("each photo gets a name of its own that uploads accept", () => {
  assert.equal(cameraFileName(new Date(2026, 9, 30, 17, 2, 5)), "camera-20261030-170205.jpg");
});

test("camera errors say what to do", () => {
  const named = (name: string) => Object.assign(new Error("x"), { name });
  assert.match(cameraError(named("NotAllowedError")), /Allow the camera/);
  assert.match(cameraError(named("NotFoundError")), /No camera/);
  assert.match(cameraError(named("NotReadableError")), /Another app/);
  assert.match(cameraError(new Error("?")), /choose a file/);
});
