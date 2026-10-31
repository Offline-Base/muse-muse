import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";
import { nextTab } from "@/components/chat/SegmentedTabs";
import { escapeCloses, focusAfterClose } from "@/components/chat/StepsPanel";
import type { StepItem } from "@/components/chat/types";

// Server-renders the chat kit outside Next: Link is a stand-in.
mock.module("next/link", {
  defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
});

let render: (c: ComponentType<never>, props: object) => string;
let kit: typeof import("@/components/chat");

before(async () => {
  const { renderToString } = await import("react-dom/server");
  // React separates adjacent text with <!-- -->; drop it so assertions read like the page.
  render = (c, props) => renderToString(createElement(c, props as never)).replace(/<!-- -->/g, "");
  kit = await import("@/components/chat");
});

const C = (c: unknown) => c as ComponentType<never>;

/** One list row's markup, from its <li> to its title: its classes and its marker. */
function row(html: string, title: string): string {
  const at = html.indexOf(`${title}`);
  assert.ok(at > 0, `a row titled ${title}`);
  return html.slice(html.lastIndexOf("<li", at), at);
}

describe("WorkingIcon", () => {
  it("draws eight dots from purple at the top to blue-violet at the bottom, turning only while working", () => {
    const working = render(C(kit.WorkingIcon), { state: "working" });
    assert.equal(working.match(/<ellipse /g)?.length, 8);
    assert.match(working, /^<svg class="chat-working-icon is-working" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"/);
    assert.match(working, /cx="12" cy="3\.6"[^>]*style="fill:color-mix\(in oklab, var\(--work-from\) 0%, var\(--work-to\)\)"/);
    assert.match(working, /cx="12" cy="20\.4"[^>]*style="fill:color-mix\(in oklab, var\(--work-from\) 100%, var\(--work-to\)\)"/);
    assert.match(render(C(kit.WorkingIcon), { state: "still" }), /^<svg class="chat-working-icon" width="18"/);
    assert.match(render(C(kit.WorkingIcon), { state: "still", variant: "subagent" }), /^<svg class="chat-working-icon is-subagent" width="16" height="16"/);
  });
});

describe("WorkingStep", () => {
  it("runs with the turning icon, its title, and a thread beside the description", () => {
    const html = render(C(kit.WorkingStep), {
      title: "Generating mascot data center video",
      description: "A 10-second video from the input image.",
      state: "running",
    });
    assert.match(html, /^<div class="chat-step is-running"><span class="chat-step-icon"><svg class="chat-working-icon is-working"/);
    assert.match(html, /<p class="chat-step-title">Generating mascot data center video<\/p>/);
    assert.match(html, /<span class="chat-step-thread" aria-hidden="true"><\/span><div class="chat-step-body"><p class="chat-step-desc">A 10-second video from the input image\.<\/p><\/div>/);
  });

  it("shows a check once done, and no thread when there's nothing under the title", () => {
    const html = render(C(kit.WorkingStep), { title: "Searched the docs", state: "done" });
    assert.match(html, /^<div class="chat-step is-done">/);
    assert.match(html, /<svg[^>]*role="img"[^>]*><title>Done<\/title><path d="M5 12\.5l4\.5 4\.5L19 7\.5"/);
    assert.doesNotMatch(html, /chat-working-icon|chat-step-thread|chat-step-body/);
  });

  it("shows an alert and the reason when it failed", () => {
    const html = render(C(kit.WorkingStep), { title: "Ran the demo", description: "Stopped.", state: "failed" });
    assert.match(html, /^<div class="chat-step is-failed">/);
    assert.match(html, /<title>Failed<\/title><path d="M12 8v5/);
    assert.match(html, /<p class="chat-step-desc">Stopped\.<\/p>/);
  });

  it("nests sub-steps on its thread with the subagent icon", () => {
    const child = createElement(kit.WorkingStep, { title: "Subagent: write the tests", state: "running", nested: true });
    const html = render(C(kit.WorkingStep), { title: "Muse Code is building", state: "running", children: child });
    assert.match(html, /<div class="chat-step-body"><div class="chat-step is-running is-nested"><span class="chat-step-icon"><svg class="chat-working-icon is-working is-subagent" width="16"/);
    assert.doesNotMatch(html, /chat-step-desc/);
  });
});

describe("ShowThinking", () => {
  it("opens the steps panel as a plain button with the still icon", () => {
    const html = render(C(kit.ShowThinking), { onClick() {} });
    assert.match(html, /^<button type="button" class="chat-thinking"><svg class="chat-working-icon" width="18"/);
    assert.match(html, /<span class="chat-thinking-label">Show thinking<svg[^>]*class="chat-thinking-chevron"/);
    assert.doesNotMatch(html, /aria-expanded/);
  });

  it("unfolds steps inline as a disclosure", () => {
    const closed = render(C(kit.ShowThinking), { onClick() {}, expanded: false, controls: "steps-1" });
    assert.match(closed, /^<button type="button" class="chat-thinking" aria-expanded="false" aria-controls="steps-1">/);
    assert.match(render(C(kit.ShowThinking), { onClick() {}, expanded: true, controls: "steps-1" }), /aria-expanded="true" aria-controls="steps-1"/);
  });
});

describe("SegmentedTabs", () => {
  const tabs = [
    { id: "steps", label: "Steps" },
    { id: "sources", label: "Sources" },
  ];

  it("is a tablist with tab and panel ids, the chosen tab and a roving tabindex", () => {
    const html = render(C(kit.SegmentedTabs), { label: "Steps and sources", tabs, value: "sources", onChange() {}, idBase: "p" });
    assert.match(html, /^<div class="chat-tabs" role="tablist" aria-label="Steps and sources">/);
    assert.match(html, /<button type="button" role="tab" id="p-tab-steps" aria-selected="false" aria-controls="p-panel-steps" tabindex="-1" class="chat-tab">Steps<\/button>/);
    assert.match(html, /<button type="button" role="tab" id="p-tab-sources" aria-selected="true" aria-controls="p-panel-sources" tabindex="0" class="chat-tab">Sources<\/button>/);
    assert.equal(html.match(/tabindex="0"/g)?.length, 1, "one tab in the tab order");
  });

  it("names each panel by its tab and renders only the chosen one", () => {
    const on = render(C(kit.SegmentedTabPanel), { idBase: "p", id: "steps", active: true, children: "The list" });
    assert.equal(on, '<div role="tabpanel" id="p-panel-steps" aria-labelledby="p-tab-steps" tabindex="0">The list</div>');
    const off = render(C(kit.SegmentedTabPanel), { idBase: "p", id: "sources", active: false, children: "Not yet" });
    assert.match(off, /aria-labelledby="p-tab-sources" hidden=""/);
    assert.doesNotMatch(off, /Not yet/);
  });

  it("moves with the arrows, wrapping around, and to the ends with Home and End", () => {
    assert.equal(nextTab("ArrowRight", 0, 2), 1);
    assert.equal(nextTab("ArrowRight", 1, 2), 0);
    assert.equal(nextTab("ArrowLeft", 0, 2), 1);
    assert.equal(nextTab("ArrowLeft", 2, 3), 1);
    assert.equal(nextTab("Home", 2, 3), 0);
    assert.equal(nextTab("End", 0, 3), 2);
    for (const key of ["ArrowUp", "ArrowDown", "Enter", " ", "Tab"]) assert.equal(nextTab(key, 1, 3), -1, key);
  });
});

describe("StepsPanel", () => {
  const props = { onClose() {}, steps: "STEP LIST", sources: "SOURCE LIST", id: "steps-panel" };
  const chosen = (html: string) => /role="tab"[^>]*aria-selected="true"[^>]*>(\w+)</.exec(html)?.[1];

  it("has the close button, both tabs and the steps when open", () => {
    const html = render(C(kit.StepsPanel), { ...props, open: true });
    assert.match(html, /^<aside id="steps-panel" class="chat-panel" aria-label="Steps and sources">/);
    assert.match(html, /<button type="button" class="chat-panel-close" aria-label="Close steps">/);
    assert.match(html, /role="tablist"[\s\S]*>Steps<\/button>[\s\S]*>Sources<\/button>/);
    assert.equal(chosen(html), "Steps");
    assert.match(html, /STEP LIST/);
    assert.doesNotMatch(html, /SOURCE LIST/);
  });

  it("is hidden and empty when closed", () => {
    const html = render(C(kit.StepsPanel), { ...props, open: false });
    assert.equal(html, '<aside id="steps-panel" class="chat-panel" aria-label="Steps and sources" hidden=""></aside>');
  });

  it("shows Sources when the parent or the default picks it, the parent's choice first", () => {
    for (const pick of [{ tab: "sources" }, { defaultTab: "sources" }]) {
      const html = render(C(kit.StepsPanel), { ...props, open: true, ...pick });
      assert.equal(chosen(html), "Sources");
      assert.match(html, /SOURCE LIST/);
      assert.doesNotMatch(html, /STEP LIST/);
    }
    assert.equal(chosen(render(C(kit.StepsPanel), { ...props, open: true, tab: "steps", defaultTab: "sources" })), "Steps");
  });

  it("closes on Escape over the conversation, beside it only from inside, and never under another dialog", () => {
    assert.equal(escapeCloses({ overlay: true, inPanel: false, inOtherDialog: false }), true, "over it, from the composer");
    assert.equal(escapeCloses({ overlay: false, inPanel: true, inOtherDialog: false }), true, "beside it, from inside");
    assert.equal(escapeCloses({ overlay: false, inPanel: false, inOtherDialog: false }), false, "beside it, from the composer");
    assert.equal(escapeCloses({ overlay: true, inPanel: false, inOtherDialog: true }), false, "the camera on top");
  });

  it("gives focus back to the opener only when closing dropped it on the body", () => {
    const body = {};
    const opener = { isConnected: true };
    assert.equal(focusAfterClose(opener, body, body), opener, "the close button went away with the panel");
    assert.equal(focusAfterClose(opener, null, body), opener);
    assert.equal(focusAfterClose(opener, { id: "composer" }, body), null, "the reader moved on");
    assert.equal(focusAfterClose({ isConnected: false }, body, body), null, "the opener is gone");
    assert.equal(focusAfterClose(null, body, body), null);
  });
});

describe("StepList", () => {
  const steps: StepItem[] = [
    { id: "a", title: "Animating mascot cutout", description: "Preparing the cutout.", state: "done" },
    {
      id: "b",
      title: "Animating mascot walkthrough",
      state: "done",
      media: { kind: "video", src: "/poster.jpg", alt: "The walkthrough", href: "https://cdn.example/walk.mp4" },
    },
    { id: "c", title: "Checked the home screen", state: "failed", media: { kind: "image", src: "/shot.png", alt: "The home screen" } },
  ];

  it("draws each step on the thread with its dot, title and description", () => {
    const html = render(C(kit.StepList), { steps });
    assert.match(html, /^<ol class="chat-steplist" aria-label="Steps">/);
    assert.equal(
      row(html, "Animating mascot cutout"),
      '<li data-step="a" class="chat-steplist-row is-done"><span class="chat-steplist-marker"><span class="chat-steplist-dot"></span></span><div class="chat-steplist-text"><p class="chat-steplist-title">',
    );
    assert.match(html, /<p class="chat-steplist-desc">Preparing the cutout\.<\/p>/);
    assert.match(html, /Checked the home screen<span class="sr-only"> \(failed\)<\/span>/);
  });

  it("ends in Done, Stopped or Didn't finish with a fitting icon, and in nothing while it runs", () => {
    const end = (e?: string) => render(C(kit.StepList), { steps, end: e });
    assert.match(end("done"), /<li class="chat-steplist-end is-done"><span class="chat-steplist-marker"><svg[^>]*><path d="[^"]*M8\.5 12\.5l2\.5 2\.5 4\.5-5"><\/path><\/svg><\/span><p class="chat-steplist-title">Done<\/p><\/li><\/ol>$/);
    assert.match(end("stopped"), /<li class="chat-steplist-end is-stopped">[\s\S]*M9\.75 9\.75h4\.5v4\.5h-4\.5z[\s\S]*>Stopped<\/p>/);
    assert.match(end("unfinished"), /<li class="chat-steplist-end is-unfinished">[\s\S]*M12 7\.5v5\.5[\s\S]*>Didn&#x27;t finish<\/p>/);
    assert.doesNotMatch(end(), /chat-steplist-end/);
  });

  it("puts a play badge on video thumbnails only, and links a thumbnail only when it has somewhere to go", () => {
    const html = render(C(kit.StepList), { steps });
    assert.match(
      html,
      /<a href="https:\/\/cdn\.example\/walk\.mp4" target="_blank" rel="noopener noreferrer" class="chat-steplist-media"><img src="\/poster\.jpg" alt="The walkthrough" title="The walkthrough" width="72" height="72" loading="lazy"\/><span class="chat-steplist-play"><svg[^>]*role="img"[^>]*><title>Video<\/title>/,
    );
    assert.match(html, /<span class="chat-steplist-media"><img src="\/shot\.png" alt="The home screen" title="The home screen" width="72" height="72" loading="lazy"\/><\/span>/);
    assert.equal(html.match(/chat-steplist-play/g)?.length, 1);
  });

  it("takes a row of thumbnails, a body, a row with no title, and children folded behind the title", () => {
    const html = render(C(kit.StepList), {
      steps: [
        {
          id: "shots",
          title: "Checks passed",
          state: "done",
          media: [
            { kind: "image", src: "/a.png", alt: "One" },
            { kind: "image", src: "/b.png", alt: "Two" },
          ],
          body: createElement("em", null, "What ran"),
        },
        { id: "say", title: "", state: "done", body: createElement("em", null, "A message") },
        { id: "many", title: "12 steps", state: "done", folded: true, children: [{ id: "one", title: "A step", state: "done" }] },
      ],
    });
    assert.match(html, /<div class="chat-steplist-gallery"><span class="chat-steplist-media"><img src="\/a\.png".*?<span class="chat-steplist-media"><img src="\/b\.png"/);
    assert.match(html, /<div class="chat-steplist-body"><em>What ran<\/em><\/div>/);
    assert.match(html, /<div class="chat-steplist-text"><div class="chat-steplist-body"><em>A message<\/em><\/div><\/div>/);
    // A closed fold leaves its children out, so a long log stays cheap to render.
    assert.match(html, /<details class="chat-steplist-fold"><summary class="chat-steplist-title">12 steps<\/summary><\/details>/);
    assert.doesNotMatch(html, /data-step="one"/);
  });

  it("nests sub-steps, with the subagent icon for subagents, workflows and what a workflow runs", () => {
    const tree: StepItem[] = [
      {
        id: "round",
        title: "Muse Code round 1",
        state: "running",
        children: [
          { id: "agent", title: "Subagent: write the tests", state: "done", kind: "subagent" },
          { id: "tool", title: "Read package.json", state: "done", kind: "tool" },
          {
            id: "flow",
            title: "Workflow: review the screens",
            state: "done",
            kind: "workflow",
            children: [{ id: "flow-1", title: "Reviewer for the home screen", state: "running" }],
          },
        ],
      },
    ];
    const html = render(C(kit.StepList), { steps: tree, end: undefined });
    assert.match(row(html, "Muse Code round 1"), /^<li data-step="[^"]*" class="chat-steplist-row is-running"><span class="chat-steplist-marker"><svg class="chat-working-icon is-working is-subagent"/);
    assert.match(html, /Muse Code round 1<span class="sr-only"> \(working\)<\/span>/);
    assert.match(row(html, "Subagent: write the tests"), /^<li data-step="[^"]*" class="chat-steplist-row is-done is-nested"><span class="chat-steplist-marker"><svg class="chat-working-icon is-subagent" width="16"/);
    assert.match(row(html, "Read package.json"), /^<li data-step="[^"]*" class="chat-steplist-row is-done is-nested"><span class="chat-steplist-marker"><span class="chat-steplist-dot">/);
    assert.match(row(html, "Workflow: review the screens"), /<svg class="chat-working-icon is-subagent"/);
    assert.match(row(html, "Reviewer for the home screen"), /^<li data-step="[^"]*" class="chat-steplist-row is-running is-nested"><span class="chat-steplist-marker"><svg class="chat-working-icon is-working is-subagent"/);
    assert.match(html, /<ol class="chat-steplist-children">[\s\S]*<ol class="chat-steplist-children">/, "two levels deep");
  });
});

describe("SourceList", () => {
  it("opens other sites in a new tab and says so, keeps this site's pages in place, and drops unsafe links", () => {
    const html = render(C(kit.SourceList), {
      sources: [
        { id: "1", title: "Image generation", detail: "/docs/image-generation", href: "/docs/image-generation", kind: "docs" },
        { id: "2", title: "aria-controls", detail: "developer.mozilla.org", href: "https://developer.mozilla.org/x", icon: "https://developer.mozilla.org/favicon.ico" },
        { id: "3", title: "A log line", href: "javascript:alert(1)" },
        { id: "4", title: "Somewhere else", href: "//elsewhere.example/x" },
      ],
    });
    assert.match(html, /^<ul class="chat-sources" aria-label="Sources">/);
    assert.match(
      html,
      /<a href="https:\/\/developer\.mozilla\.org\/x" target="_blank" rel="noopener noreferrer" class="chat-source-title">aria-controls<span class="sr-only"> \(opens in a new tab\)<\/span><\/a><span class="chat-source-detail">developer\.mozilla\.org<\/span>/,
    );
    assert.match(html, /<img src="https:\/\/developer\.mozilla\.org\/favicon\.ico" alt="" width="16" height="16" loading="lazy"\/>/);
    assert.match(html, /<a href="\/docs\/image-generation" class="chat-source-title">Image generation<\/a>/);
    assert.doesNotMatch(html.match(/<a href="\/docs[^>]*>/)?.[0] ?? "", /target=/, "this site's pages open in place");
    assert.match(html, /<span class="chat-source-title">A log line<\/span>/);
    assert.match(html, /<span class="chat-source-title">Somewhere else<\/span>/);
    assert.doesNotMatch(html, /javascript:|elsewhere\.example/);
  });

  it("says so when there are none", () => {
    assert.equal(render(C(kit.SourceList), { sources: [] }), '<p class="chat-sources-empty">Nothing here yet.</p>');
  });

  it("only links paths on this site and http or https addresses", () => {
    assert.deepEqual(kit.chatHref("/docs/models"), { href: "/docs/models", external: false });
    assert.deepEqual(kit.chatHref(" https://example.com/a "), { href: "https://example.com/a", external: true });
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "//example.com", "/\\example.com", "mailto:a@b.c", "", null]) {
      assert.equal(kit.chatHref(bad), null, String(bad));
    }
    // Browsers drop tabs and line breaks before reading a URL, so these are other sites too.
    for (const bad of ["/\t/example.com", "/\n/example.com", "/\r\\example.com", "/docs/\u0000x"]) {
      assert.equal(kit.chatHref(bad), null, JSON.stringify(bad));
    }
    assert.deepEqual(kit.chatHref("/docs/\nmodels"), { href: "/docs/models", external: false });
  });
});

describe("UserBubble", () => {
  it("holds the attachments as 40 px thumbnails after the text", () => {
    const html = render(C(kit.UserBubble), {
      text: "it looks too much like a bear",
      attachments: [
        { src: "blob:mascot", alt: "mascot.png" },
        { alt: "brief.pdf", icon: "file", href: "https://store.example/brief.pdf" },
      ],
    });
    assert.match(html, /^<div class="chat-bubble has-files"><p class="chat-bubble-text">it looks too much like a bear<\/p><ul class="chat-bubble-files" aria-label="Attached files">/);
    assert.match(html, /<li><span class="chat-bubble-file"><img src="blob:mascot" alt="mascot\.png" width="40" height="40" loading="lazy"\/><\/span><\/li>/);
    assert.match(
      html,
      /<a href="https:\/\/store\.example\/brief\.pdf" target="_blank" rel="noopener noreferrer" class="chat-bubble-file"><svg[^>]*role="img"[^>]*><title>brief\.pdf<\/title>[\s\S]*?<span class="sr-only"> \(opens in a new tab\)<\/span><\/a>/,
    );
  });

  it("is only the text without attachments", () => {
    assert.equal(render(C(kit.UserBubble), { text: "yes" }), '<div class="chat-bubble"><p class="chat-bubble-text">yes</p></div>');
  });
});

describe("Output, title chip and floating buttons", () => {
  it("frames output with an optional ratio and a hover label", () => {
    const html = render(C(kit.MediaCard), { label: "Add to favorites", ratio: "16 / 10", children: createElement("iframe", { title: "Live preview" }) });
    assert.equal(
      html,
      '<figure class="chat-media"><div class="chat-media-frame has-ratio" style="aspect-ratio:16 / 10"><iframe title="Live preview"></iframe></div><figcaption class="chat-media-label">Add to favorites</figcaption></figure>',
    );
    assert.doesNotMatch(render(C(kit.MediaCard), { children: "x" }), /figcaption|has-ratio|style=/);
  });

  it("names the conversation in the title chip, as a heading when asked", () => {
    assert.equal(render(C(kit.TitleChip), { children: "Receipt splitter" }), '<p class="chat-title-chip">Receipt splitter</p>');
    assert.equal(render(C(kit.TitleChip), { children: "Receipt splitter", as: "h1" }), '<h1 class="chat-title-chip">Receipt splitter</h1>');
  });

  it("labels the icon-only buttons", () => {
    const share = render(C(kit.FloatButton), { icon: "share", label: "Copy the link" });
    assert.match(share, /^<button type="button" class="chat-float" aria-label="Copy the link" title="Copy the link"><svg width="20" height="20"[^>]*stroke-width="1\.75"/);
    assert.match(render(C(kit.FloatButton), { icon: "more", label: "Build details" }), /stroke-width="3"/, "the dots read at this size");
    assert.match(render(C(kit.FloatButton), { icon: "more", label: "Build details", className: "x" }), /class="chat-float x"/);
    assert.match(render(C(kit.ScrollButton), {}), /^<button type="button" class="chat-scroll" aria-label="Jump to the newest message" title="Jump to the newest message"><svg width="16"/);
  });
});
