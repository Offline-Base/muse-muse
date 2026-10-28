// Unit tests for components/Segmented.tsx and components/Footer.tsx, rendered to HTML. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The repo root's tsconfig leaves template/ out, so tsx compiles the components' JSX to React.createElement calls.
globalThis.React = React;
const { Segmented, segmentedLayout } = await import("../../components/Segmented");
const { Footer } = await import("../../components/Footer");
const createElement = React.createElement;

test("options whose labels fit their share of a phone's row share one row", () => {
  assert.equal(segmentedLayout(["Simple lines", "Detailed lines"]), "row");
  assert.equal(segmentedLayout(["Indoors", "Outdoors"]), "row");
  assert.equal(segmentedLayout(["Square", "Tall", "Wide"]), "row");
  assert.equal(segmentedLayout(["Work", "Break"]), "row");
  assert.equal(segmentedLayout(["S", "M", "L", "XL"]), "row");
  assert.equal(segmentedLayout(["1", "2", "3", "4", "5"]), "row");
});

test("four options that don't fit one row go two by two, so none wraps or stands alone", () => {
  // The round-2 builds whose pills wrapped ("Backend / devs") or left one stretched across a row ("Everyone", "Sore").
  assert.equal(segmentedLayout(["Backend devs", "Frontend devs", "Writers", "Everyone"]), "grid");
  assert.equal(segmentedLayout(["Practical", "Friendly", "Formal", "Playful"]), "grid");
  assert.equal(segmentedLayout(["Cozy cafe", "Bright studio", "Garden", "Evening glow"]), "grid");
  assert.equal(segmentedLayout(["Fresh", "Good", "Tired", "Sore"]), "grid");
  assert.equal(segmentedLayout(["Mon", "Tue", "Wed", "Thu"]), "grid");
});

test("other options that don't fit one row stack, one full-width row each", () => {
  assert.equal(segmentedLayout(["Beginner", "Intermediate", "Advanced"]), "stack");
  assert.equal(segmentedLayout(["A quick weekday dinner", "A slow weekend project"]), "stack");
  assert.equal(segmentedLayout(["Thumbnails and full pages", "Only the pages with charts", "Every page", "Only page 1"]), "stack");
  assert.equal(segmentedLayout(["Morning", "Afternoon", "Evening", "Night", "Any time"]), "stack");
  assert.equal(segmentedLayout(["XS", "S", "M", "L", "XL", "XXL"]), "stack");
});

test("in the 720 px column's 640 px, options go back to one row when their labels fit it", () => {
  // The kit's desktop sheet showed these as a 2 by 2 grid and three full-width rows, 44 and 88 px of extra form.
  assert.equal(segmentedLayout(["Fresh", "Good", "Tired", "Sore"], 640), "row");
  assert.equal(segmentedLayout(["Beginner", "Intermediate", "Advanced"], 640), "row");
  assert.equal(segmentedLayout(["Cozy cafe", "Bright studio", "Garden", "Evening glow"], 640), "row");
  assert.equal(segmentedLayout(["Morning", "Afternoon", "Evening", "Night", "Any time"], 640), "row");
  // Too long for a quarter of the row: they keep the phone's layout (globals.css only reads data-wide="row").
  assert.equal(segmentedLayout(["Backend devs", "Frontend devs", "Writers", "Everyone"], 640), "grid");
  assert.equal(segmentedLayout(["XS", "S", "M", "L", "XL", "XXL"], 640), "stack");
});

test("Segmented renders a radio group with its layout", () => {
  const html = renderToStaticMarkup(
    createElement(Segmented, {
      label: "Audience",
      value: "backend",
      onChange() {},
      options: [
        { value: "backend", label: "Backend devs" },
        { value: "frontend", label: "Frontend devs" },
        { value: "writers", label: "Writers" },
        { value: "everyone", label: "Everyone" },
      ],
    }),
  );
  assert.match(html, /<div class="segmented" role="radiogroup" aria-labelledby="[^"]+" data-layout="grid" data-wide="grid">/);
  assert.equal(html.match(/type="radio"/g)?.length, 4);
  assert.match(html, /<input type="radio" name="[^"]+" checked="" value="backend"\/>Backend devs<\/label>/);
});

test("the footer keeps its words, and a credit adds one line linking to the video", () => {
  assert.match(renderToStaticMarkup(createElement(Footer)), /^<footer style="[^"]+">Built with Muse Muse\. Not an official Meta product\.<\/footer>$/);
  const html = renderToStaticMarkup(createElement(Footer, { credit: "https://www.youtube.com/watch?v=abc" }));
  assert.match(html, /<p style="margin:0 0 8px">Idea from <a href="https:\/\/www\.youtube\.com\/watch\?v=abc" target="_blank" rel="noreferrer">a Meta developer video<\/a>\.<\/p>Built with Muse Muse\. Not an official Meta product\.<\/footer>$/);
});
