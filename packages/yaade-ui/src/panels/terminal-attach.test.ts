import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { shouldWaitForExistingPty } from "./terminal-attach.js"

describe("shouldWaitForExistingPty", () => {
  it("waits when attach-only and the host has not bound a PTY yet", () => {
    assert.equal(
      shouldWaitForExistingPty({
        attachOnly: true,
        status: "starting",
      }),
      true,
    )
    assert.equal(
      shouldWaitForExistingPty({
        attachOnly: true,
        status: "created",
      }),
      true,
    )
  })

  it("does not wait once a PTY id exists", () => {
    assert.equal(
      shouldWaitForExistingPty({
        attachOnly: true,
        existingPtyId: "pty-1",
        status: "starting",
      }),
      false,
    )
  })

  it("does not wait for a finished or failed session", () => {
    assert.equal(
      shouldWaitForExistingPty({
        attachOnly: true,
        status: "exited",
      }),
      false,
    )
    assert.equal(
      shouldWaitForExistingPty({
        attachOnly: true,
        status: "failed",
      }),
      false,
    )
  })

  it("does not wait when the panel may create its own PTY", () => {
    assert.equal(
      shouldWaitForExistingPty({
        attachOnly: false,
        status: "starting",
      }),
      false,
    )
  })
})
