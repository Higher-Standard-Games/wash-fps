import { background } from "../../../engine/core/AsyncErrors";
import { PackageDownload } from "../../../engine/loader/pk3/PackageDownload";
import { PackageStore } from "../../../engine/loader/pk3/PackageStore";
import { PK3Index } from "../../../engine/loader/pk3/PK3Index";

/** Download-only lobby work. It outlives panels and never changes map scope. */
export class LobbyAssetPreparation {
  static readonly shared = new LobbyAssetPreparation();
  private generation = 0;
  private selectedMap: string | null = null;
  private started = false;
  private state: "preparing" | "ready" | "error" = "preparing";
  private error = "";
  private packages = new Map<string, "Queued" | "Ready">();
  private readonly common = [
    "washoi_weapons.pk3",
    "washoi_player_model.pk3",
    "washoi_sounds.pk3",
    "washoi_effects.pk3",
    "washoi_gfx.pk3",
  ];

  selectMap(map: string | null): void {
    if (this.started && map === this.selectedMap) return;
    this.started = true;
    if (this.generation === 0 && typeof navigator !== "undefined") {
      const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
      if (connection?.saveData) PackageStore.shared.setPaused(true);
    }
    this.selectedMap = map;
    this.state = "preparing";
    this.error = "";
    this.packages = new Map(this.common.map((filename) => [filename, "Queued"]));
    const generation = ++this.generation;
    PackageStore.shared.dropQueuedBackground();
    background(this.prepare(generation, map), "LobbyAssetPreparation");
  }

  retry(): void {
    this.started = false;
    this.selectMap(this.selectedMap);
  }

  private async prepare(generation: number, map: string | null): Promise<void> {
    try {
      const index = PK3Index.getInstance();
      await index.ensureIndex();
      if (generation !== this.generation) return;
      const wanted = [...this.common];
      if (map) {
        const owner = index.findMap(map);
        if (!owner) throw new Error(`Map is unavailable: ${map}`);
        wanted.push(owner, `tex_${map}.pk3`);
      }
      for (const filename of wanted) this.packages.set(filename, "Queued");
      const visited = new Set<string>();
      for (const filename of wanted) {
        if (generation !== this.generation) return;
        if (visited.has(filename)) continue;
        visited.add(filename);
        const url = index.getPK3Path(filename);
        if (!url) throw new Error(`Package is unavailable: ${filename}`);
        const zip = await PackageStore.shared.acquire(url, filename, "background");
        if (generation !== this.generation) return;
        this.packages.set(filename, "Ready");
        // Map banks declare shared dependencies; read them without mounting.
        const manifest = map && zip.file(`media-manifests/${map}.json`);
        if (manifest) {
          const metadata = JSON.parse(await manifest.async("string"));
          if (
            metadata.map !== map ||
            (metadata.sharedDependencies !== undefined && !Array.isArray(metadata.sharedDependencies))
          )
            throw new Error(`Invalid map media manifest: ${filename}`);
          for (const dependency of metadata.sharedDependencies ?? []) {
            if (typeof dependency?.package !== "string" || !/^[a-z0-9][a-z0-9_.-]*\.pk3$/i.test(dependency.package))
              throw new Error(`Invalid shared package: ${filename}`);
            wanted.push(dependency.package);
            if (!this.packages.has(dependency.package)) this.packages.set(dependency.package, "Queued");
          }
        }
      }
      if (generation === this.generation) this.state = "ready";
    } catch (error) {
      if (generation !== this.generation) return;
      this.state = "error";
      this.error = String(error);
    }
  }

  /** A small status and a plain-text detail view, shared by each panel instance. */
  status(): { label: string; detail: string; packages: { filename: string; state: string }[] } {
    const transfers = PackageDownload.getActive();
    const loaded = transfers.reduce((sum, transfer) => sum + transfer.loaded, 0) / 1_000_000;
    const detail = transfers
      .map(
        (transfer) =>
          `${transfer.filename}: ${transfer.phase}, ${(transfer.loaded / 1_000_000).toFixed(1)} MB` +
          (transfer.total === null ? " received" : ` / ${(transfer.total / 1_000_000).toFixed(1)} MB`) +
          `, ${(transfer.bytesPerSecond() / 1_000_000).toFixed(1)} MB/s`,
      )
      .join("\n");
    const label = transfers.length
      ? `↓ Assets · ${loaded.toFixed(1)} MB`
      : PackageStore.shared.paused && this.state === "preparing"
        ? "Downloads paused"
        : this.state === "error"
          ? "Download interrupted · Retry"
          : this.state === "ready"
            ? "✓ Downloads ready"
            : "Preparing downloads…";
    return {
      label,
      detail: detail || this.error || (this.selectedMap ? `Common assets and ${this.selectedMap}` : "Common assets"),
      packages: [...this.packages].map(([filename, state]) => ({
        filename,
        state: transfers.find((transfer) => transfer.filename === filename)?.phase ?? state,
      })),
    };
  }
}
