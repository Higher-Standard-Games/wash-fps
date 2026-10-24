# Regional production deployment

These scripts are the Washoi operator configuration for `/srv/washoi` on EU
(`washoi.net`, game origin `eu.washoi.net`) and US (`us.washoi.net`). They belong
to the game, not SHAG. Installing them does not publish an application release.

## Repository and media layout

- Engine worktree: `/srv/washoi/repos/shag`.
- Independent game worktree: `/srv/washoi/repos/shag/src/games/fps`, with its own
  `.git` directory. Existing repository URLs and read-only deployment keys stay
  in their respective Git configurations.
- Persistent media: `/srv/washoi/assets/data`, linked from the engine's
  `public/data`. A missing or changed link blocks deployment.
- Dependencies are installed once at the engine root.
- `/srv/washoi/release-pair.json` selects exact 40-character engine and game
  commit IDs: `{"engine":"<engine SHA>","game":"<game SHA>"}`.

The deploy timers read that file. Pushing either repository alone does not
select a new production pair. Fetches use each repository's own origin;
`git submodule update` and `git clean` are not part of deployment. The helper
defers a code checkout while lobby connections or match processes remain.
The root repository may still contain an old gitlink until its source cutover;
the production game metadata and fetch process are already independent of it.

## Installed files

| Source | Installed location |
| --- | --- |
| `workspace.sh` | `/srv/washoi/workspace.sh` |
| `run-server.sh` | `/srv/washoi/run-server.sh` |
| `deploy-eu.sh` or `deploy-us.sh` | `/srv/washoi/deploy.sh` |
| `validate-us.sh` | `/srv/washoi/validate.sh` on US |
| `activate-us.sh` | `/usr/local/sbin/washoi-activate` on US |

The lobby and bot systemd units retain their existing user, environment files,
working directory, resource limits and sandbox settings. The
`20-independent-checkout.conf` drop-ins override only `ExecStart`, using:

```ini
# washoi-lobby.service.d/20-independent-checkout.conf
[Service]
ExecStart=
ExecStart=/srv/washoi/run-server.sh lobby --port 9000 --data-dir /srv/washoi/server-data
```

The bot unit uses `bot --port 9100 --data-dir /srv/washoi/server-data` instead.
The wrapper prefers built server bundles; without them it resolves the source
entry in the new game directory or the alpha.2 engine directory. `--check lobby`
or `--check bot` prints the selected command without starting a server.

Game commands use the game package when present. The alpha.2 fallback uses its
existing root scripts, including `docs:fps:build`; a new game checkout uses
`npm --prefix ... run docs:build`. This allows the operator update before the
new application release is published.

## Selecting a release

1. Publish and validate the matching engine/game commits first. Keep the prior
   pair, deploy-state files and built artifacts for rollback.
2. Back up the actual persistent data, database, configuration and links. Never
   replace the checkout with an empty directory or delete ignored media.
3. On EU, wait until the region is idle, then stop its lobby and bots before
   changing code: it still runs source until its first bundled-server restart.
   This prevents a new connection arriving during the checkout/build window.
   On US, keep the existing staged-build and idle-activation procedure.
4. Write both full commit IDs to a temporary JSON file on the target host,
   validate it with `jq`, then atomically rename it to `release-pair.json`.
   Do not independently select the latest engine and game main tips.
5. Let the deploy timer run, or invoke `/srv/washoi/deploy.sh` (EU can select
   `game engine-docs fps-docs`). An active lobby connection or match defers a
   changed-pair checkout. Do not force a restart of an occupied region.
6. US builds client and server artifacts in `.pending/<pair fingerprint>/`,
   records the actual revisions in `revisions.json` and activates through the
   existing idle-activation timer. EU publishes static surfaces and builds
   server bundles; restart its lobby and bots explicitly when idle to use the
   new bundles. A static publish alone does not restart EU's backend.
7. Verify game HTTP, lobby upgrade, representative media, account continuity
   and a real match before considering the application release deployed.

The surface/staging fingerprint hashes both revision IDs. A game-only or
engine-only revision change therefore invalidates the relevant build state.
`checkout-pair.json` records the fetched pair under `.deploy-state`.

Publication protects the existing `data/` directory from `rsync --delete`.
Media is copied separately without deletion; demos and the legacy shared
texture archive are excluded from that copy. The canonical assets and live
demos under `assets/data` remain in place. US retains its idle guard and
maintenance handshake gate. Old staged builds are retained for rollback.

## 2026-10-24 operator cutover

Both regions retained engine `c47cfc5c8926096402d7f1e2b27a8e1d00ac0ffe` and
game `d1c1689e8923d57ba46ac41e8e852c502debe593` (alpha.2). No application code
was published or service restarted. Script, Git metadata, deploy-state and
media backups are in `/srv/washoi/backups/git-split-20261024-eu` and the
corresponding `-us` directory on each host. The original submodule metadata
store is also preserved; only the game worktree's Git pointer was converted
to a local `.git` directory.

To roll back operator configuration, restore backed-up scripts and unit
configuration with deployment timers paused and no build/activation running.
Keep the independent repository metadata unless restoring it is necessary;
preserve any newer Git refs before changing it. Restore a prior release by
selecting its exact pair and retained artifacts when idle. Never delete or
overwrite persistent data as part of operator or application rollback.
