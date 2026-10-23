import type { GameServerApplication } from "../../../lobby/ServerRuntime";

/** Dedicated-server entries relative to the assembled SHAG/Washoi project root. */
export const FPS_SERVER_APPLICATION: GameServerApplication = {
  sourceEntry: "src/cli/headless-netserver-v2.ts",
  bundledEntry: "dist-server/headless-netserver-v2.mjs",
};
