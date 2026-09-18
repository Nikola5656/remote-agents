import assert from "node:assert/strict";
import test from "node:test";
import { openReaderDialog } from "./reader-dialog.js";

function fixture(mode: "native" | "unsupported" | "broken") {
  const body = { style: { overflow: "auto" } } as HTMLElement;
  let focused = false;
  const attributes = new Set<string>();
  const dialog = {
    open: false,
    showModal: mode === "unsupported" ? undefined : function (this: { open: boolean }) {
      if (mode === "broken") throw new Error("Dialog implementation failed");
      this.open = true;
    },
    close(this: { open: boolean }) { if (mode === "broken") throw new Error("Close failed"); this.open = false; },
    setAttribute(this: { open: boolean }, name: string) { attributes.add(name); this.open = name === "open"; },
    removeAttribute(this: { open: boolean }, name: string) { attributes.delete(name); this.open = false; },
    querySelector() { return { focus() { focused = true; } }; },
  } as unknown as HTMLDialogElement;
  return { body, dialog, attributes, focused: () => focused };
}

for (const mode of ["native", "unsupported", "broken"] as const) {
  test(`reader stays usable and restores body scrolling with ${mode} dialog support`, () => {
    const state = fixture(mode);
    const close = openReaderDialog(state.dialog, state.body);
    assert.equal(state.dialog.open, true);
    assert.equal(state.body.style.overflow, "hidden");
    if (mode !== "native") assert.equal(state.focused(), true);
    close();
    assert.equal(state.dialog.open, false);
    assert.equal(state.body.style.overflow, "auto");
    assert.equal(state.attributes.has("open"), false);
  });
}
