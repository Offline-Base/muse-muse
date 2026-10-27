import { test, expect } from "@playwright/test";

// Muse Code replaces this with the brief's primary flow. See .agents/skills/verify/SKILL.md.
// Step titles become captions in the recorded demo video, so write them for a viewer.
test("home page renders the required footer", async ({ page }) => {
  await test.step("Open the product", async () => {
    await page.goto("/");
  });
  await test.step("Built with Muse Muse", async () => {
    await expect(page.getByText("Built with Muse Muse. Not an official Meta product.")).toBeVisible();
  });
});
