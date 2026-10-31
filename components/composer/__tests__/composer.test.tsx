import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";

// Server-renders the muse box outside Next. The router and the camera check are stand-ins: the camera check is false
// on the server, so `camera` turns it on for the "+" menu.
let camera = false;
mock.module("next/navigation", {
  namedExports: { useRouter: () => ({ push() {}, refresh() {} }) },
});
mock.module("@/components/camera/CameraCapture", {
  namedExports: { CameraCapture: () => null, useCameraSupported: () => camera },
});

let render: (props: object) => string;

before(async () => {
  const { renderToString } = await import("react-dom/server");
  const { Composer } = await import("@/components/composer/Composer");
  // React separates adjacent text with <!-- -->; drop it so assertions read like the page.
  render = (props) => renderToString(createElement(Composer as ComponentType<never>, props as never)).replace(/<!-- -->/g, "");
});

describe("composer", () => {
  it("keeps its labels and states in the Muse app's card", () => {
    camera = false;
    const html = render({ mode: "new", signedIn: true, layout: "playground" });
    assert.match(html, /<form class="composer" aria-label="Your muse">/);
    assert.match(html, /<label for="([^"]+)" class="sr-only">Describe it, or drop in your inspo<\/label><textarea id="\1" class="composer-input" data-voice="inline" rows="1"/);
    assert.match(html, /placeholder="Describe it, or drop in your inspo\.\.\." aria-describedby="([^"]+)"[\s\S]*<p id="\1" class="sr-only">/);
    assert.match(html, /<button type="button" class="composer-tool" aria-label="Attach inspo files" title="Attach photos, video, a voice memo or a PDF"><svg width="20"/);
    assert.match(html, /<input type="file" multiple="" accept="[^"]+" class="sr-only" tabindex="-1" aria-hidden="true"\/>/);
    assert.match(html, /<div class="composer-actions"><span class="voice-input is-idle composer-voice"><button type="button" class="voice-input-btn" aria-label="Voice input"[\s\S]*<button type="submit" class="send-btn" aria-label="Make it" disabled="" aria-disabled="true"><svg width="24"/);
    assert.doesNotMatch(html, /Thinking/, "no switch that does nothing");
  });

  it("lets a signed-out reader press send to sign in, and says so in the row", () => {
    camera = false;
    const html = render({ mode: "new", signedIn: false, layout: "playground" });
    assert.match(html, /<button type="submit" class="send-btn" aria-label="Make it" aria-disabled="true">/);
    assert.match(html, /<p id="[^"]+" class="composer-hint">Sign in to build\. Your note is kept, files need adding again\.<\/p>/);
  });

  it("asks for a change in the build room's floating box", () => {
    camera = false;
    const html = render({ mode: "refine", buildId: "b1", signedIn: true, floating: true });
    assert.match(html, /^<div class="composer-wrap composer-floating"><form class="composer" aria-label="Ask for a change">/);
    assert.match(html, /placeholder="Ask for a change, like add a dark mode"/);
    assert.match(html, /class="composer-hint">Muse Code picks up where it left off\. Add inspo if it helps\.<\/p>/);
    assert.match(html, /aria-label="Send change"/);
  });

  it("puts files and the camera behind + where there's a camera", () => {
    camera = true;
    const html = render({ mode: "new", signedIn: true, layout: "playground" });
    camera = false;
    assert.match(html, /<div class="menu-wrap"><button type="button" class="composer-tool" aria-expanded="false" aria-controls="([^"]+)" aria-label="Attach inspo files" title="Attach inspo files"><svg width="20"[\s\S]*<div id="\1" class="menu menu-start" hidden="">/);
    assert.match(html, /<button type="button" class="menu-item"><svg[^>]*>[\s\S]*?<\/svg><span class="menu-item-text"><span>Photos and files<\/span><span class="muted small">Photos, video, a voice memo or a PDF<\/span><\/span><\/button>/);
    assert.match(html, /<button type="button" class="menu-item"><svg[^>]*>[\s\S]*?<\/svg>Take a photo<\/button>/);
    assert.equal(html.match(/class="composer-tool"/g)?.length, 1, "one + button");
  });

  it("shows no target pill with no target on, and none on a change", () => {
    camera = false;
    assert.doesNotMatch(render({ mode: "new", signedIn: true, layout: "playground" }), /target-pill|Where it runs/);
    assert.doesNotMatch(render({ mode: "new", signedIn: true, layout: "playground", targetOptions: [] }), /target-pill|Where it runs/);
    assert.doesNotMatch(render({ mode: "refine", buildId: "b1", signedIn: true, targetOptions: ["phone"] }), /target-pill/);
  });

  it("puts the target pill left of the mic, on Auto, with Web checked and locked", () => {
    camera = false;
    const html = render({ mode: "new", signedIn: true, layout: "playground", targetOptions: ["phone", "vr"] });
    assert.match(html, /<div class="composer-actions"><div class="menu-wrap"><button type="button" class="composer-pill target-pill"[^>]*aria-label="Where it runs: Auto"[^>]*><span>Auto<\/span>[\s\S]*voice-input/);
    assert.match(html, /<input type="checkbox" disabled="" checked=""\/><span class="menu-item-text"><span>Web<\/span>/);
    assert.match(html, /<input type="checkbox"\/><span class="menu-item-text"><span>Phone<\/span>/);
    assert.match(html, /<span>VR<\/span>/);
    assert.doesNotMatch(html, /<span>Desktop<\/span>|<span>Glasses<\/span>|<span>Agent<\/span>/, "only what is on");
  });
});

describe("the target pill's text", () => {
  it("reads Auto, then the names, then a count", async () => {
    const { targetPillText } = await import("@/components/composer/TargetPill");
    assert.equal(targetPillText([]), "Auto");
    assert.equal(targetPillText(["phone"]), "Web + Phone");
    assert.equal(targetPillText(["phone", "vr"]), "Web + Phone + VR");
    assert.equal(targetPillText(["phone", "desktop", "vr"]), "Web + 3 more");
  });
});
