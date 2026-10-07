# Engine patches

Changes this game needs in the **engine repo** (`Higher-Standard-Games/shag`), which cannot be edited from here. Each patch was developed and tested in a local clone of the engine with this repo copied into `src/games/fps/`, and checked to apply cleanly to the engine's `main` at the time (`ce550d6`).

Apply from the engine's root:

```bash
git apply --check docs/research/patches/engine-damage-hit-location.patch   # from this repo's path
git apply path/to/engine-damage-hit-location.patch
```

## engine-damage-hit-location.patch

Puts the hit location on the wire so the client can show a head hit differently. QA item 5 (`../v0.9.25-QA.md`).

| File | Change |
|------|--------|
| `src/shared/net/BinaryProtocol.ts` | A new event code, **23**, for a `damage` event that carries a head or leg hit. It is the same layout as code 10 plus one byte. A body hit keeps code 10 and its exact bytes |
| `src/engine/network/core/SnapshotEvent.ts` | `DamageEvent.hitLocation?: "head" \| "legs" \| "body"` |
| `src/engine/__tests__/DamageHitLocation.test.ts` | Seven tests: round trips, body hits unchanged, one extra byte, a golden byte string from the old encoder, and decoding in step with the events around it |

**Compatibility**

- **Demos recorded before the patch** still decode: code 10 is untouched, and a test pins its bytes to what the old encoder produced.
- **A client older than the server** cannot read code 23 and would misread the rest of the snapshot, the same as for any new event type. Ship the game and the engine together. `PROTOCOL_VERSION` is not bumped, as with earlier appended event types.
- **A game without the patch** is unaffected: the server sets `hitLocation` on its damage events, the old encoder ignores the field, and the client treats an event without it as a body hit. Head hits still do the extra damage; only the orange number and the longer crosshair flash wait for the patch.

**Verification**

- `npx vitest run` on the engine with this game copied in: 3,691 tests pass and 6 fail, in 4 files. Five of them (bot weights and snapshot rate: `FrameSpacing`, `HybridBrainOutputs`, `HybridBrain`) fail identically with the patch removed. The sixth, `MapCommand`, passes on its own (twice) and on a run without the patch, so it is flaky under the full parallel run.
- `npx tsc --noEmit` is clean.

## engine-binary-encoder-speed.patch

Makes snapshot encoding about 6 times faster with identical output. QA item 8 (`../v0.9.25-QA.md`). **Apply after `engine-damage-hit-location.patch`**: it is diffed against `BinaryProtocol.ts` with that patch in place (it touches different lines, so it normally applies on its own too; check with `git apply --check`).

| File | Change |
|------|--------|
| `src/shared/net/BinaryProtocol.ts` | `BinaryEncoder.writeString` encodes straight into the buffer with `encodeInto` instead of allocating an array per string; `getData` copies with `Uint8Array.slice` instead of `ArrayBuffer.slice` |
| `src/shared/net/__tests__/Utf8Encoder.test.ts` | Pins the bytes against `TextEncoder` for empty, ASCII, accented, CJK, astral, lone-surrogate and very long strings |

No wire or demo format change, so nothing to ship in step: the server alone benefits. Measured with this repo's `bench/` (16 clients, one snapshot): 2,437 µs → 398 µs.
