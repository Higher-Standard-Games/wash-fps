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

Deploy timers follow engine `main` by default (`"mode":"main"`, also the
default when omitted). Each run selects the game gitlink recorded by that
engine commit and verifies it is published on game `main` before atomically
updating the pair file. Publish game `main` first, then engine `main` with its
matching pin. A game-only push does not select an unrelated game revision.
Use `"mode":"pinned"` with exact revisions to hold a release or roll back.
Fetches use each repository's own origin; `git submodule update` and `git clean`
are not part of deployment. Connected lobbies and matches do not defer updates;
successful publication restarts the backend and disconnects existing sessions.
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
| `activate-eu.sh` | `/usr/local/sbin/washoi-activate` on EU |
| `auto-activate.conf` | `/etc/systemd/system/washoi-deploy.service.d/30-auto-activate.conf` |

Both deploy services install a `30-auto-activate.conf` drop-in:

```ini
[Service]
ExecStartPost=+/usr/local/sbin/washoi-activate
```

The `+` runs activation as root after the unprivileged build succeeds. EU tracks
the restarted backend fingerprint in `.deploy-state/backend.sha`; US activates
its pending artifacts. Failed builds do not run activation. The existing US
activation timer also retries pending activation.

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
3. Normal deployment follows engine `main` automatically. Current backends use
   bundles; successful builds replace them and restart lobby and bots even when
   players are connected. Allow for the deploy timer interval and build time.
4. Write both full commit IDs to a temporary JSON file on the target host,
   validate it with `jq`, then atomically rename it to `release-pair.json`.
   Set `"mode":"pinned"` when manually holding a pair. Do not independently
   select the latest engine and game main tips.
5. Let the deploy timer run, or start `washoi-deploy.service` to build and run
   its activation hook. Invoking `/srv/washoi/deploy.sh` directly builds without
   the systemd post-hook; run `/usr/local/sbin/washoi-activate` afterward.
6. US builds client and server artifacts in `.pending/<pair fingerprint>/`,
   records the actual revisions in `revisions.json` and activates through the
   activation hook. EU publishes static surfaces and builds server bundles;
   its activation hook restarts lobby and bots when the published fingerprint
   differs from the running backend.
7. Verify game HTTP, lobby upgrade, representative media, account continuity
   and a real match before considering the application release deployed.

The surface/staging fingerprint hashes both revision IDs. A game-only or
engine-only revision change therefore invalidates the relevant build state.
`checkout-pair.json` records the fetched pair under `.deploy-state`.

Publication protects the existing `data/` directory from `rsync --delete`.
Media is copied separately without deletion; demos and the legacy shared
texture archive are excluded from that copy. The canonical assets and live
demos under `assets/data` remain in place. US retains its maintenance handshake
gate during activation. Old staged builds are retained for rollback.

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
