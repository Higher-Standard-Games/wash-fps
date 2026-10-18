# Maps

Which maps exist, which modes they play, and how the lobby decides what to offer.

## The lobby's map pool

A map appears in a mode's room vote only when **both** are true:

1. It is listed for that mode in `config/maps.json` (in the engine repo).
2. Its `map_<name>.pk3` is installed in `public/data/`.

Each room draws three maps at random from the pool for the vote, so a mode with fewer than three maps offers fewer. If `public/data/` has no map files at all (a development checkout without game data), the lobby skips the disk check and offers every listed map. Amphi is the exception: it is only offered when its own map PK3s are installed.

| Map | Name | Modes |
|-----|------|-------|
| `washoi_dm2` | Washoi DM2 | Duel, FFA |
| `washoi_dm5` | Washoi DM5 | Duel, FFA |
| `washoi_dm11` | Washoi DM11 | Duel, FFA |
| `wamphi1` | Amphitheatre | Amphi |
| `wbomb2` | Reactors | S&D |
| `wbomb6` | Depot | S&D |

The table shows the configured lobby pools, filtered against installed packages.
Existing demos recorded on `wdm2`, `wfdm5` or `wfdm11` load the corresponding
Washoi BSP without changing their recorded metadata or texture references.

## Playing any installed map

The lobby list is only what is offered by default. `map <name> <gametype>` in the console, or `--map` on a dedicated server, will load **any installed map** with any gametype, whether or not it is in `maps.json`. For instance `map wbomb1 snd` tries Search & Destroy on `wbomb1`, a bomb map the lobby does not currently list. It only works on maps that qualify as bomb maps (below). See [Selecting a Gametype](./index.md#selecting-a-gametype).

Bomb maps (`wbomb*`) qualify for Search & Destroy when they have bomb sites **and** team spawns. See [Search & Destroy → Maps](./search-and-destroy.md#maps).

## Adding a map

1. Put the map's `map_<name>.pk3` in `public/data/` in the engine repo, and rebuild the manifest (`npm run tools:manifest`).
2. Add an entry to `config/maps.json` with a `displayName` and the release `gametypes` it should be offered for (`duel`, `amphi`, `ffa`, `snd`).
3. Restart the lobby server. The map list is read once at startup.

Maps are made in the engine's map editor; see the engine's documentation for building and compiling them.

## Map entities this game uses

| Entity | Effect | Page |
|--------|--------|------|
| `trigger_teleport` and `misc_teleporter_dest` | Teleporter, momentum-carrying | [Movement](../player/movement.md#teleporters) |
| `trigger_push` and `target_position` | Jumppad | [Movement](../player/movement.md#jumppads) |
| `SURF_LADDER` brushes | Ladders | [Movement](../player/movement.md#ladders) |
| Water, slime and lava volumes | Swimming, drowning, damage | [Movement](../player/movement.md#water-and-other-liquids) |
| Moving brush models (doors, platforms) | Lifts, with crush damage | [Movement](../player/movement.md#lifts-doors-and-movers) |
| `weapon_*`, `ammo_*`, `item_health_*`, `item_armor_*`, `item_quad` | Pickups | [Pickups](../player/pickups-and-inventory.md) |
| Bomb site markers and team spawns | Search & Destroy | [Search & Destroy](./search-and-destroy.md) |
