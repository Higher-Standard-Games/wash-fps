import type { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { PK3Index } from "../../../../engine/loader/pk3/PK3Index";
import { PK3Loader } from "../../../../engine/loader/pk3/PK3Loader";
import { PK3TextureLoader } from "../../../../engine/loader/pk3/PK3TextureLoader";

/** Load the indexed ammo artwork before resolving textures from loaded packages. */
export async function loadAmmoIconTexture(iconPath: string): Promise<Texture | null> {
  const index = PK3Index.getInstance();
  await index.ensureIndex();
  const owner = index.findFile(`${iconPath}.tga`);
  if (owner) await PK3Loader.getInstance().ensurePK3(owner);
  const loader = PK3TextureLoader.getInstance();
  return (await loader.resolveAndLoadTexture(iconPath)) ?? loader.loadTexture(`${iconPath}.tga`);
}
