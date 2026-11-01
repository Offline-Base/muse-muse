// Platform file (Muse Muse trust). Don't edit: the platform puts it back before every check, and it runs with the
// smoke test in `npm run verify`.
//
// Checks what the platform promises this product's users: its Privacy and Terms pages answer, its footer says it was
// built with Muse Muse and links them and the Report page, and its age page answers. The age gate itself is off while
// tests run (MUSEMUSE_BUILD=1), so the smoke test reaches the product as it always has.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

const trust = JSON.parse(readFileSync(path.join(process.cwd(), "musemuse.trust.json"), "utf8")) as {
  legalPages: boolean;
  ageGate: boolean;
  reportUrl: string | null;
};

test.describe("Muse Muse trust", () => {
  test("privacy, terms and the age page answer, and the footer links them", async ({ page, request }) => {
    if (trust.legalPages) {
      for (const p of ["/privacy", "/terms"]) {
        const res = await request.get(p);
        expect(res.status(), `${p} answers`).toBe(200);
        expect(await res.text()).toContain("Muse Muse");
      }
    }
    if (trust.ageGate) expect((await request.get("/age")).status(), "/age answers").toBe(200);

    await page.goto("/");
    const footer = page.locator("footer").last();
    await expect(footer).toContainText("Built with Muse Muse. Not an official Meta product.");
    if (trust.legalPages) {
      await expect(footer.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
      await expect(footer.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    }
    if (trust.reportUrl) await expect(footer.getByRole("link", { name: "Report" })).toHaveAttribute("href", trust.reportUrl);
  });
});
