/** Preserve a usable reading surface on browsers without native modal dialogs. */
export function openReaderDialog(dialog: HTMLDialogElement, body: HTMLElement): () => void {
  const previousOverflow = body.style.overflow;
  body.style.overflow = "hidden";
  try {
    if (typeof dialog.showModal !== "function") throw new Error("Native dialog unavailable");
    dialog.showModal();
  } catch {
    dialog.setAttribute("open", "");
    dialog.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }
  return () => {
    try {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
    } catch {
      // Removing the attribute below also closes a dialog with a broken polyfill.
    } finally {
      dialog.removeAttribute("open");
      body.style.overflow = previousOverflow;
    }
  };
}
