import { expect } from "@playwright/test"
import type { ShellDriver, ShellLocator } from "./driver.js"

type AssertionOptions = { timeout?: number }

export async function expectLocatorVisible(
  loc: ShellLocator,
  options?: AssertionOptions,
): Promise<void> {
  await expect(loc).toBeVisible(options)
}

export async function expectLocatorHidden(
  loc: ShellLocator,
  options?: AssertionOptions,
): Promise<void> {
  await expect(loc).toBeHidden(options)
}

export async function expectLocatorCount(
  loc: ShellLocator,
  count: number,
  options?: AssertionOptions,
): Promise<void> {
  await expect(loc).toHaveCount(count, options)
}

export async function expectLocatorAttached(
  loc: ShellLocator,
  options?: AssertionOptions,
): Promise<void> {
  await expect(loc).toBeAttached(options)
}

export async function expectSelectorVisible(
  page: ShellDriver,
  selector: string,
  options?: AssertionOptions,
): Promise<void> {
  await expectLocatorVisible(page.locator(selector), options)
}

export async function expectSelectorHidden(
  page: ShellDriver,
  selector: string,
  options?: AssertionOptions,
): Promise<void> {
  await expectLocatorHidden(page.locator(selector), options)
}

export async function expectContainsText(
  page: ShellDriver,
  selector: string,
  text: string | RegExp,
  options?: AssertionOptions,
): Promise<void> {
  await expect(page.locator(selector).first()).toContainText(text, options)
}

export async function expectNotContainsText(
  page: ShellDriver,
  selector: string,
  text: string,
  options?: AssertionOptions,
): Promise<void> {
  await expect(page.locator(selector).first()).not.toContainText(text, options)
}

export async function expectLocatorContainsText(
  loc: ShellLocator,
  text: string | RegExp,
  options?: AssertionOptions,
): Promise<void> {
  await expect(loc).toContainText(text, options)
}

export async function expectLocatorFocused(
  loc: ShellLocator,
  options?: AssertionOptions,
): Promise<void> {
  await expect(loc).toBeFocused(options)
}

export async function expectLocatorAttribute(
  loc: ShellLocator,
  name: string,
  value: string | RegExp,
  options?: AssertionOptions,
): Promise<void> {
  await expect(loc).toHaveAttribute(name, value, options)
}

export async function expectRoleCount(
  page: ShellDriver,
  role: string,
  count: number,
  options?: AssertionOptions,
): Promise<void> {
  await expectLocatorCount(page.getByRole(role), count, options)
}

export async function expectRoleVisible(
  page: ShellDriver,
  role: string,
  options?: AssertionOptions,
): Promise<void> {
  await expectLocatorVisible(page.getByRole(role), options)
}

export async function expectDialogCount(
  page: ShellDriver,
  count: number,
  options?: AssertionOptions,
): Promise<void> {
  await expectRoleCount(page, "dialog", count, options)
}
