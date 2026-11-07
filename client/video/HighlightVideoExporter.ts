import { Game } from "../../Game";
import { DemoService } from "../DemoService";
import type { ExportSource } from "./ExportSource";
import "./ExportVideo.css";

let active: HTMLDialogElement | null = null;

/** Opens an isolated document; the source viewer retains its scene and bytes. */
export function openHighlightVideoExporter(selected?: ExportSource): void {
  if (!import.meta.env.DEV) throw new Error("Video export is available in the development client");
  if (Game.getInstance().isConnectedToServer()) throw new Error("Leave the live match before exporting a demo");
  const service = DemoService.getInstance();
  const bytes = service.loadedDemoData;
  const reader = service.loadedDemoReader;
  if (!selected && (!bytes || !reader)) throw new Error("Load a saved demo first");
  const source: ExportSource = selected ?? {
    bytes: bytes!.slice(),
    label: `${reader!.readHeader().map} · ${reader!.readHeader().gametype}`,
    durationMs: reader!.readIndex().durationMs,
    filename: "washoi-highlights.shagdemo",
  };
  if (active) {
    active.focus();
    return;
  }
  const restoreFocus = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "video-export-dialog";
  dialog.dataset.videoExport = "";
  active = dialog;
  dialog.setAttribute("aria-label", "Export video");
  const close = document.createElement("button");
  close.textContent = "×";
  close.setAttribute("aria-label", "Close export");
  close.className = "video-export-dialog__close";
  const hint = document.createElement("span");
  hint.setAttribute("role", "status");
  hint.className = "video-export-dialog__hint";
  hint.textContent = "Opening export…";
  const frame = document.createElement("iframe");
  frame.title = "Video export session";
  const jobId = crypto.randomUUID();
  frame.src = `/?videoexport=1&job=${encodeURIComponent(jobId)}`;
  const channel = new MessageChannel();
  let canClose = true;
  const timeout = setTimeout(() => {
    hint.textContent = "The export window did not load. Close it and try again.";
    hint.classList.add("is-error");
  }, 30_000);
  const received = (event: MessageEvent) => {
    if (
      event.origin !== location.origin ||
      event.source !== frame.contentWindow ||
      event.data?.type !== "videoexport:ready" ||
      event.data.jobId !== jobId
    )
      return;
    window.removeEventListener("message", received);
    clearTimeout(timeout);
    hint.textContent = "";
    hint.classList.remove("is-error");
    frame.contentWindow?.postMessage({ type: "videoexport:init", jobId, source }, location.origin, [
      channel.port2,
      ...(source.bytes ? [source.bytes.buffer as ArrayBuffer] : []),
    ]);
  };
  channel.port1.onmessage = (event) => {
    if (event.data?.type !== "state" || typeof event.data.canClose !== "boolean") return;
    canClose = event.data.canClose;
    close.disabled = !canClose;
    hint.textContent = canClose ? "" : "Cancel the job, or download/discard its finished video, before closing.";
  };
  window.addEventListener("message", received);
  dialog.addEventListener("cancel", (event) => {
    if (!canClose) event.preventDefault();
  });
  close.addEventListener("click", () => {
    if (canClose) dialog.close();
  });
  dialog.addEventListener(
    "close",
    () => {
      window.removeEventListener("message", received);
      clearTimeout(timeout);
      channel.port1.close();
      channel.port2.close();
      dialog.remove();
      active = null;
      if (restoreFocus instanceof HTMLElement) restoreFocus.focus();
    },
    { once: true },
  );
  dialog.append(close, hint, frame);
  document.body.append(dialog);
  dialog.showModal();
}
