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
| `client-release.sh` | read from the game checkout on EU (`/srv/washoi/client-release.sh` only as a fallback) |
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

## Bots

The lobby seats bots itself and plays each match's bots in a match runner
(`dist-server/bot-runner.mjs`): a child process of the lobby that loads the
map, plays the match and exits with it. Like match servers, runners count
against `washoi-lobby`'s resource limits, about 175 MB per match with bots
beside the match server's 120 MB, and their output goes to the lobby's
journal. The lobby writes the bots' match reports to `bot-intel.db` in its
`--data-dir`. Runners keep bot navigation caches in `.cache/bots/maps` under
the working directory; a cache they cannot write is rebuilt at the start of
each match. Bots, match servers and the browser trace collision with
`WorldTrace.wasm`, which `build:server` copies beside the bundles.
`washoi-bots` serves only a lobby started with `--bot-server`. Activation
restarts it while it is enabled. Once it is disabled, activation leaves it
alone and refuses to restart a lobby that has no `bot-runner.mjs`.

Game commands use the game package when present. The alpha.2 fallback uses its
existing root scripts, including `docs:fps:build`; a new game checkout uses
`npm --prefix ... run docs:build`. This allows the operator update before the
new application release is published.

## Native game downloads

EU's `client` surface publishes the newest *published* release of
`Higher-Standard-Games/wash-fps-rust` under `releases/site/client/`, served as
`https://washoi.net/client/`: one folder per version holding the
`washoi-<version>-<os>-<arch>` packages, and `latest.json`, which the game reads
at start to offer an update. The release workflow creates drafts; publishing
a draft on GitHub is what ships it, at the next deploy run. The newest three
versions are kept; the site's own publication leaves `client/` alone.

The server reads the release with a fine-grained token that has only
**Contents: read** on that one repository, in
`/srv/washoi/env/client-release.token` (owner `washoi`, mode `0600`). Without
the token the surface is skipped and
everything else deploys as before. A failed download keeps the previous release
served and does not fail the deploy. `latest.json` should not be cached for
long: in the `washoi.net` site block, `header /client/latest.json
Cache-Control "no-cache"`.

`deploy_client` sources `client-release.sh` from the pinned game checkout
(`/srv/washoi/repos/shag/src/games/fps/scripts/deployment/`), after
`deploy_game` has updated it, so a change to the script ships when it is
merged and the pinned game reaches the server; nothing has to be installed by
hand. An installed `/srv/washoi/client-release.sh` is used only when the
checkout has none. `deploy-eu.sh` itself is still installed as
`/srv/washoi/deploy.sh`, so this change needs that copy updated once.

`tests/client-release.test.sh` runs the script against a fake API on disk.

## Selecting a release

1. Publish and validate the matching engine/game commits first. Keep the prior
   pair, deploy-state files and built artifacts for rollback.
2. Back up the actual persistent data, database, configuration and links. Never
   replace the checkout with an empty directory or delete ignored media.
3. Normal deployment follows engine `main` automatically. Current backends use
   bundles; successful builds replace them and restart the lobby (and the bot
   server, while enabled) even when
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
   activation hook. After a successful activation it removes older stages,
   keeping the activated one and the newest earlier complete stage for
   rollback. EU publishes static surfaces and builds server bundles;
   its activation hook restarts the backend when the published fingerprint
   differs from the running backend.
7. Verify game HTTP, lobby upgrade, representative media, account continuity
   and a real match before considering the application release deployed.

Dependencies of the engine checkout are installed with
`npm ci --ignore-scripts`, then the repository's own `postinstall` (it copies
the Havok physics wasm). No package's install script runs on a host that holds
the player database and keys; none is needed for the server and client builds
(esbuild and sharp load their prebuilt platform packages; Electron is for
desktop builds only). The site and studio checkouts on EU still install with
scripts. The hosts run an installed copy of `deploy-eu.sh` / `deploy-us.sh`:
reinstall it after this changes.

The surface/staging fingerprint hashes both revision IDs. A game-only or
engine-only revision change therefore invalidates the relevant build state.
`checkout-pair.json` records the fetched pair under `.deploy-state`.

Publication protects the existing `data/` directory from `rsync --delete`.
Media is copied separately without deletion; demos and the legacy shared
texture archive are excluded from that copy. The canonical assets and live
demos under `assets/data` remain in place. US retains its maintenance handshake
gate during activation. Old staged builds are retained for rollback.

## v1.0.0-beta.13 operator steps

Bots move from `washoi-bots` into the lobby (see [Bots](#bots)). The release
works with the installed scripts and units unchanged: activation still
restarts both services, and the bot server starts and stays idle. On each
host:

1. **Before publishing**, check that `washoi-lobby` has room for runners:
   `systemctl show washoi-lobby -p MemoryMax -p MemoryHigh -p TasksMax`
   should allow a runner (about 175 MB) per bot match on top of its match
   servers. If the units are sandboxed, give the lobby unit the write paths
   the bot unit had, so runners can keep the navigation caches.
2. **Publish** engine and game `main` as usual and let activation run.
3. **Verify** in `journalctl -u washoi-lobby`: the lobby prints
   `Bots: seated by the lobby, matches in match runners` at start, and a bot
   match logs `[HeadlessBSPCollisionWorld] World trace: compiled (WebAssembly)`
   from its runner. `pgrep -af bot-runner` lists a runner while the match
   plays and none after it ends. Play a campaign mission and a quick play
   with bots.
4. **Install** this release's `activate-eu.sh` or `activate-us.sh` as
   `/usr/local/sbin/washoi-activate`. Without it, activation keeps
   restarting `washoi-bots` and fails once that is disabled.
5. **Retire the bot server**: `systemctl disable --now washoi-bots`.
6. **Fair play.** The lobby creates `fairplay.db` in its data directory at
   first start (match counters, player reports, sanctions and address bans).
   Back it up with `players.db`. To review reports or ban, run as the lobby's
   user from an engine checkout with its dependencies installed:
   `npm run fair-play -- reports --data-dir /srv/washoi/server-data`
   (`--help` lists the commands). The running lobby applies a ban within a
   minute. For the admin panel, add a login with
   `npm run fair-play -- add-admin <name> --data-dir /srv/washoi/server-data`
   and have the proxy forward `/admin` to the lobby's port, as it forwards the
   lobby WebSocket. The lobby logs `Admin panel:` at start when it is on.

To roll back to beta.12, run `systemctl enable --now washoi-bots` first:
the older lobby asks the bot server for bots, and with the bot server enabled
activation does not look for a runner. Without rolling back, a lobby whose
bot seats misbehave can go back to the bot server: add `--bot-server` to its
`ExecStart` and enable `washoi-bots`.

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
