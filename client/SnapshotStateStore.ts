/**
 * The lasting state a snapshot carries, stored before anything else looks at the snapshot.
 *
 * The engine acks a snapshot before the game runs it (NetworkGameHost.handleSnapshot), so anything
 * that throws on the way through a snapshot would leave the server believing we hold state we never
 * stored. The match state and every player's weapon state are therefore stored here first, in a
 * step of their own that cannot be cut short by the rest of the frame's work. The server can then
 * send them only until we have them (docs/research/v0.9.25-network-improvements.md).
 */

import { log } from "../../../engine/core/Log";
import type { GameState } from "../../../engine/network/core/GameState";
import type { WeaponStateEvent } from "../../../engine/network/core/SnapshotEvent";
import { canonicalWeaponId } from "../shared/entities/definitions/weapons/WeaponsTable";
import { MatchStateManager } from "./MatchStateManager";

/** The last weapon_state seen for each player, by entity id. Lives as long as the connection. */
export class PlayerWeaponStates {
  private readonly states = new Map<string, WeaponStateEvent>();

  get(entityId: string): WeaponStateEvent | undefined {
    return this.states.get(entityId);
  }

  set(event: WeaponStateEvent): void {
    this.states.set(event.entityId, event);
  }

  clear(): void {
    this.states.clear();
  }
}

export interface SnapshotStateTargets {
  weapons: PlayerWeaponStates;
  /** Other players' weapon in hand, read by their third-person model, the kill feed and spectating. */
  enemyWeapons: Map<string, string>;
  /** Our own entity, whose weapon is not an enemy's. Unknown in the first snapshots after joining. */
  localEntityId: string | undefined;
}

/** Store a snapshot's match state and weapon states. Never throws. */
export function storeSnapshotState(state: GameState, targets: SnapshotStateTargets): void {
  for (const event of state.events) {
    try {
      if (event.type === "match_state") {
        MatchStateManager.getInstance().processEvent(event);
      } else if (event.type === "weapon_state") {
        const weaponState = event as WeaponStateEvent;
        targets.weapons.set(weaponState);
        if (weaponState.entityId !== targets.localEntityId && weaponState.currentWeapon) {
          targets.enemyWeapons.set(weaponState.entityId, canonicalWeaponId(weaponState.currentWeapon));
        }
      }
    } catch (err) {
      log.errorRateLimited("SnapshotStateStore", `could not store ${event.type}:`, err);
    }
  }
}
