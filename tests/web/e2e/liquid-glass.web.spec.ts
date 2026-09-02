import { expect } from "@playwright/test";
import { test } from "../../fixtures/e2e.js";

test("material gallery exposes named chrome and matte content surfaces", async ({ launchApp }) => {
  const { page } = await launchApp({
    launchWithoutWorkspace: true,
    startPath: "/__yaade/glass-gallery",
  });

  await expect(page.locator('[data-yaade-glass-gallery=""]')).toBeVisible();

  const materials = page.locator("[data-yaade-glass-gallery-material]");
  await expect(materials).toHaveCount(4);
  await expect(page.locator('[data-yaade-glass-gallery-material="shell"]')).toHaveCount(1);
  await expect(page.locator('[data-yaade-glass-gallery-material="chrome"]')).toHaveCount(1);
  await expect(page.locator('[data-yaade-glass-gallery-material="content"]')).toHaveCount(1);
  await expect(page.locator('[data-yaade-glass-gallery-material="floating"]')).toHaveCount(1);

  const computed = await page
    .locator('[data-yaade-glass-gallery-material="floating"]')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backdropFilter: style.backdropFilter,
        borderRadius: style.borderRadius,
      };
    });
  expect(computed.backdropFilter).toMatch(/blur\(([3-9]\d)px\)/);
  expect(computed.backdropFilter).toMatch(/saturate\(/);
  expect(computed.backdropFilter).toMatch(/brightness\(/);
  expect(computed.borderRadius).not.toBe("0px");

  const fill = await page
    .locator('[data-yaade-glass-gallery-material="floating"]')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const color = style.backgroundColor;
      const match = color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
      const oklchAlpha = color.match(/\/\s*([\d.]+)\s*\)/)?.[1];
      return {
        color,
        alpha:
          match?.[4] == null ? (oklchAlpha == null ? 1 : Number(oklchAlpha)) : Number(match[4]),
        boxShadow: style.boxShadow,
        prefersReducedTransparency: window.matchMedia("(prefers-reduced-transparency: reduce)")
          .matches,
      };
    });
  expect(fill.alpha).toBeGreaterThan(0);
  if (fill.prefersReducedTransparency) expect(fill.alpha).toBe(1);
  else expect(fill.alpha).toBeLessThan(0.4);
  expect(fill.boxShadow).toMatch(/inset/);

  const contentComputed = await page
    .locator('[data-yaade-glass-gallery-material="content"]')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backdropFilter: style.backdropFilter,
        background: style.backgroundColor,
      };
    });
  expect(contentComputed.backdropFilter).toContain("0px");
  expect(contentComputed.background).not.toBe("rgba(0, 0, 0, 0)");

  const classicComputed = await page.evaluate(() => {
    document.documentElement.dataset.yaadeInterfaceMaterial = "classic";
    const element = document.querySelector<HTMLElement>(
      '[data-yaade-glass-gallery-material="floating"]',
    );
    if (!element) throw new Error("floating gallery surface missing");
    const style = getComputedStyle(element);
    return { backdropFilter: style.backdropFilter, background: style.backgroundColor };
  });
  expect(classicComputed.backdropFilter).toContain("0px");
  expect(classicComputed.background).not.toBe("rgba(0, 0, 0, 0)");

  await page.locator('[data-yaade-glass-gallery-busy-toggle=""]').click();
  await expect(page.locator('[data-yaade-glass-gallery=""]')).toHaveClass(
    /yaade-glass-gallery-busy/,
  );
});

test("settings keep fixed material and typography while allowing font selection", async ({
  launchApp,
}) => {
  const { page } = await launchApp();
  await expect(page.locator('[data-yaade-shell="terminal-multiplexer"]')).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("[data-yaade-settings-overlay]")).toBeVisible();

  await expect(page.locator("[data-yaade-interface-material-option]")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute(
    "data-yaade-interface-material",
    "liquid-glass",
  );
  await expect(page.locator('[data-yaade-reduced-transparency-toggle=""]')).toHaveCount(0);
  await expect(page.locator("#yaade-ui-font-size")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-yaade-reduced-transparency");

  const fontInput = page.locator("#yaade-mono-font");
  const initialFont = await fontInput.inputValue();
  await fontInput.click();
  const fontOptions = page.locator("[data-yaade-mono-font-option]");
  await expect(fontOptions.first()).toBeVisible();
  const availableFonts = await fontOptions.evaluateAll((elements) =>
    elements
      .map((element) => element.getAttribute("data-yaade-mono-font-option"))
      .filter((font): font is string => Boolean(font)),
  );
  const nextFont = availableFonts.find((font) => font !== initialFont);
  if (!nextFont) throw new Error("The font picker did not expose another font.");
  await fontOptions.filter({ hasText: nextFont }).click();
  await expect(fontInput).toHaveValue(nextFont);
});

test("light mode uses macOS graphite materials and a distinct glass tab", async ({
  launchApp,
}) => {
  const { page } = await launchApp();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radio", { name: "Light color mode" }).click();
  await page.getByRole("button", { name: /Close settings/ }).click();

  await expect(page.locator("html")).not.toHaveClass(/dark/);
  const material = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const topBar = document.querySelector<HTMLElement>("[data-yaade-top-tabbar]");
    const pill = document.querySelector<HTMLElement>("[data-yaade-window-tab-pill]");
    if (!topBar || !pill) throw new Error("light title bar material is unavailable");
    const topBarStyle = getComputedStyle(topBar);
    const pillStyle = getComputedStyle(pill);
    return {
      backgroundToken: root.getPropertyValue("--background").trim(),
      topBarBackground: topBarStyle.backgroundColor,
      pillBackground: pillStyle.backgroundColor,
      pillBackdropFilter: pillStyle.backdropFilter,
      pillShadow: pillStyle.boxShadow,
    };
  });

  expect(material.backgroundToken).toContain("0.915");
  expect(material.topBarBackground).not.toBe(material.pillBackground);
  expect(material.pillBackdropFilter).toContain("blur(16px)");
  expect(material.pillShadow).not.toBe("none");
});

test("top Window tabs use compact separated pills with a raised active surface", async ({
  launchApp,
}) => {
  const { page } = await launchApp();
  const topBar = page.locator("[data-yaade-top-tabbar]");
  await expect(topBar).toBeVisible();
  const tabBarHeight = await topBar.evaluate((element) => element.getBoundingClientRect().height);
  expect(tabBarHeight).toBeGreaterThan(40);
  expect(tabBarHeight).toBeLessThanOrEqual(44);
  const pillHeight = await page
    .locator("[data-yaade-window-tabs] [data-yaade-session-tab]")
    .first()
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(pillHeight).toBeGreaterThan(24);
  expect(pillHeight).toBeLessThan(tabBarHeight - 8);
  await expect(topBar.getByRole("button", { name: "Switch terminal" })).toHaveCount(0);
  await expect(topBar.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(topBar.locator('[data-yaade-window-controls=""]')).toHaveCount(0);

  const newTab = page.locator('[data-yaade-new-session-tab=""]');
  await expect(newTab).toBeVisible();
  await newTab.click();

  const tabs = page.locator("[data-yaade-window-tabs] [data-yaade-session-tab]");
  await expect(tabs).toHaveCount(2);
  const tabBoxes = await tabs.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right };
    }),
  );
  const [firstTabBox, secondTabBox] = tabBoxes;
  if (!firstTabBox || !secondTabBox) {
    throw new Error("Window tab spacing geometry is unavailable");
  }
  expect(secondTabBox.left - firstTabBox.right).toBeLessThanOrEqual(4);
  const newTabBox = await newTab.boundingBox();
  if (!newTabBox) throw new Error("New Window button geometry is unavailable");
  expect(newTabBox.x - secondTabBox.right).toBeGreaterThan(24);
  const topBarBox = await topBar.boundingBox();
  if (!topBarBox) throw new Error("Title bar geometry is unavailable");
  expect(topBarBox.x + topBarBox.width - (newTabBox.x + newTabBox.width)).toBeLessThanOrEqual(24);

  const activeTab = page.locator(
    '[data-yaade-window-tabs] [data-yaade-session-tab][data-active="true"]',
  );
  const inactiveTab = page.locator(
    '[data-yaade-window-tabs] [data-yaade-session-tab]:not([data-active="true"])',
  );
  await expect(activeTab).toBeVisible();
  const activeClose = activeTab.getByRole("button", { name: "Close Window 2" });
  const [activeBox, closeBox] = await Promise.all([
    activeTab.boundingBox(),
    activeClose.boundingBox(),
  ]);
  expect(activeBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  if (!activeBox || !closeBox) throw new Error("Window tab geometry is unavailable");
  const closeWidth = await activeClose.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).width),
  );
  expect(closeWidth).toBeGreaterThanOrEqual(24);
  expect(closeBox.x).toBeGreaterThanOrEqual(activeBox.x);
  expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(activeBox.x + activeBox.width);

  const inactiveBackground = await inactiveTab.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(["transparent", "rgba(0, 0, 0, 0)"]).toContain(inactiveBackground);
  const activeTabFill = await activeTab.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(["transparent", "rgba(0, 0, 0, 0)"]).toContain(activeTabFill);

  const activePill = page.locator('[data-yaade-window-tab-pill=""]');
  await expect(activePill).toHaveCount(1);
  const pill = await activePill.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: Number.parseFloat(style.borderRadius),
      boxShadow: style.boxShadow,
    };
  });
  expect(["transparent", "rgba(0, 0, 0, 0)"]).not.toContain(pill.backgroundColor);
  expect(pill.borderRadius).toBeGreaterThan(8);
  expect(pill.boxShadow).not.toBe("none");

  const inactiveId = await inactiveTab.getAttribute("data-yaade-session-tab");
  expect(inactiveId).toBeTruthy();
  await inactiveTab.click();
  const switched = page.locator(
    `[data-yaade-window-tabs] [data-yaade-session-tab="${inactiveId}"]`,
  );
  await expect(switched).toHaveAttribute("data-active", "true");
  await expect(switched.locator('[data-yaade-window-tab-pill=""]')).toBeVisible();

  await expect(page.locator("[data-yaade-top-tabbar] > span")).toHaveCount(0);
});

test("pane controls stay quiet until the top-right area is hovered or keyboard-focused", async ({
  launchApp,
}) => {
  const { page } = await launchApp();
  const pane = page.locator("[data-yaade-panel-leaf]").first();
  const paneChrome = pane.locator('[data-yaade-mux-pane-chrome]');
  const controlZone = paneChrome.locator('[data-yaade-mux-pane-control-zone=""]');
  const paneControls = paneChrome.locator('[data-yaade-mux-pane-controls=""]');

  await expect(pane).toBeVisible();
  await page.locator("[data-ghostty-terminal-input]").first().focus();
  await page.mouse.move(0, 0);
  await expect(paneControls).toHaveCSS("opacity", "0");

  await pane.hover();
  await expect(paneControls).toHaveCSS("opacity", "0");
  await controlZone.hover();
  await expect(paneControls).toHaveCSS("opacity", "1");
  const splitRight = paneControls.getByRole("button", { name: "Split right" });
  await expect(splitRight).toBeVisible();
  await expect(paneControls.getByRole("button", { name: "Close pane" })).toBeVisible();

  await page.locator("[data-yaade-top-tabbar]").hover();
  await expect(paneControls).toHaveCSS("opacity", "0");
  await splitRight.focus();
  await expect(paneControls).toHaveCSS("opacity", "1");
});

test("window tabs close with the x button and have no overflow menu", async ({ launchApp }) => {
  const { page } = await launchApp();
  const tabBar = page.locator("[data-yaade-window-tabs]");
  const tabs = tabBar.locator("[data-yaade-session-tab]");
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toContainText("Window 1");
  await expect(tabs.first().getByRole("button", { name: "Close Window 1" })).toBeVisible();
  await expect(tabBar.getByRole("button", { name: /Window actions/ })).toHaveCount(0);
  await expect(page.locator("[data-yaade-window-tab-menu]")).toHaveCount(0);
  await expect(tabBar.locator('[data-slot="dropdown-menu-trigger"]')).toHaveCount(0);

  await page.locator('[data-yaade-new-session-tab=""]').click();
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toContainText("Window 2");
  await expect(tabs.nth(1).getByRole("button", { name: "Close Window 2" })).toBeVisible();
  await expect(tabs.nth(1)).toBeVisible();

  await tabs.nth(1).getByRole("button", { name: "Close Window 2" }).click();
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toContainText("Window 1");
  await expect(tabs.first()).toBeVisible();
});
