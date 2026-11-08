/**
 * Washoi's browser entry: picks the page to boot before anything heavy loads.
 *
 * Inside the native client's webview (`window.__washoiNative`, injected
 * before the page runs) and at `/client`, only the lobby boots
 * (`native/main.ts`); everywhere else the whole game (`main.ts`). See
 * wash-fps-rust docs/research/WEBVIEW_LOBBY.md, section 4.
 */

import { logRejection } from "../../../engine/core/AsyncErrors";
import { lobbyOnly } from "./native/NativeBridge";

if (new URLSearchParams(location.search).get("videoexport") === "1") {
  import("./video/ExportPage").catch(logRejection("Opening video export"));
} else if (lobbyOnly(window)) {
  void import("./native/main");
} else {
  void import("./main");
}
