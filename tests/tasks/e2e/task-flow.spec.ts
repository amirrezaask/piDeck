import { expect, test } from "@playwright/test";

test("creates and completes a persisted task", async ({ page }) => {
  const errors: Array<string> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/tasks");
  await expect(page.getByText("Dispatch").first()).toBeVisible();

  await page.getByRole("button", { name: "Add projects" }).click();
  await page.getByLabel("Name").fill("Home");
  await page.getByLabel("Key").fill("HOM");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByRole("button", { name: "Home" })).toBeVisible();

  await page.getByRole("button", { name: "Add labels" }).click();
  await page.getByLabel("Name").fill("Focus");
  await page.getByRole("button", { name: "Save label" }).click();

  await page.getByRole("button", { name: /New task/ }).click();
  const taskDialog = page.getByRole("dialog", { name: "Create task" });
  await taskDialog.getByRole("button", { name: "Dispatch" }).click();
  await taskDialog.getByRole("menuitemradio", { name: "HOM · Home" }).click();
  const composer = page.getByRole("textbox", { name: "Task", exact: true });
  await composer.fill("Plan the weekend /priority");
  await composer.press("Enter");
  await page.getByRole("menuitemradio", { name: "High" }).click();
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(page.getByText("HOM-1", { exact: true }).first()).toBeVisible();

  await page.getByLabel("Task status").click();
  await page.getByRole("option", { name: "In progress" }).click();
  await expect(page.getByLabel("Task status")).toContainText("In progress");
  await page.getByLabel("Toggle Focus label").click();
  await page.getByLabel("Task status").click();
  await page.getByRole("option", { name: "Done", exact: true }).click();
  await expect(page.getByLabel("Task status")).toContainText("Done");

  await page.reload();
  await expect(page.getByLabel("Task status")).toContainText("Done");
  await expect(page.getByLabel("Toggle Focus label")).toHaveAttribute("aria-pressed", "true");
  expect(errors).toEqual([]);
});
