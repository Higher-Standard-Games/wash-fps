/**
 * HUDState — Client-side HUD data aggregator
 *
 * Collects all HUD-relevant data from GameState events each frame.
 * UI components read from this singleton (pull model).
 *
 * Aggregates:
 * - combat_state  → health, armor, dead
 * - weapon_state  → handled by Game directly
 * - match_state   → handled by MatchStateManager
 * - damage events → recent damage numbers (for floating numbers)
 * - death events  → kill feed entries
 * - players map   → scoreboard data
 */

import type { GameState } from "../../../engine/network/core/GameState";
import { clientKeyDisplayId } from "../ClientEntityKey";
import { MatchStateManager } from "./MatchStateManager";

// ============================================================================
// Data Shapes
// ============================================================================

export interface DamageNumber {
  entityId: string;
  attackerId: string;
  damage: number;
  weaponId: string;
  timestamp: number;
}

export interface KillFeedEntry {
  victimId: string;
  killerId: string;
  weaponId: string;
  timestamp: number;
}

export interface ScoreboardEntry {
  playerId: string;
  entityId: string;
  name: string;
  score: number;
  deaths: number;
  ping: number;
  teamId?: string;
}

export interface WeaponAmmoState {
  clip: number;
  reserve: number;
}

export type HUDWeaponAmmo = number | WeaponAmmoState;

// ============================================================================
// HUDState Singleton
// ============================================================================

export class HUDState {
  private static instance: HUDState | null = null;

  // === Combat (describes whoever the camera is behind) ===
  health: number = 100;
  armor: number = 0;
  /**
   * The SUBJECT's dead flag — the spectated player's while watching one, ours
   * otherwise. Widgets that describe what is on screen want this one.
   */
  dead: boolean = false;
  /**
   * Our own dead flag, whoever the camera is following.
   *
   * Separate from `dead` because the two answer different questions once
   * spectating exists: "is the player on screen down" and "am I out of this
   * round". The death panel needs the second — reading the first would take it
   * down while we watch a living teammate and put it straight back up the
   * moment they die or the round ends.
   */
  localDead: boolean = false;

  // === Weapon state (private to local player) ===
  currentWeapon: string = "blade";
  weapons: string[] = ["blade"];
  ammo: Record<string, HUDWeaponAmmo> = {};

  // === Damage numbers (recent, for floating display) ===
  damageNumbers: DamageNumber[] = [];
  private static readonly DAMAGE_EXPIRE_MS = 2000;

  // === Kill feed (recent kills) ===
  killFeed: KillFeedEntry[] = [];
  private static readonly KILL_FEED_EXPIRE_MS = 5000;
  private static readonly KILL_FEED_MAX = 5;

  // === Scoreboard & Match State ===
  scoreboard: ScoreboardEntry[] = [];
  localPlayerId: string = "";
  /**
   * Player currently being watched while dead, or "" when playing.
   *
   * The bomb's progress bar belongs to whoever has their hands on it — and to
   * anyone spectating them, which is how a dead defender still sees the defuse
   * they can no longer help with.
   */
  spectating: string = "";
  gametypeName: string = "";
  teamScores: Record<string, number> = {};
  teamNames: Record<string, string> = {};

  // === Debug overlay ===
  private debugElement: HTMLDivElement | null = null;
  private debugEnabled: boolean = false;

  static getInstance(): HUDState {
    if (!HUDState.instance) {
      HUDState.instance = new HUDState();
    }
    return HUDState.instance;
  }

  // ========================================================================
  // Event Processing
  // ========================================================================

  /**
   * Process a combat_state event (health/armor for local player).
   */
  processCombatState(event: any): void {
    this.health = event.health ?? 100;
    this.armor = event.armor ?? 0;
    this.dead = event.dead ?? false;
  }

  /**
   * Process a weapon_state event (current weapon, inventory, ammo for local player).
   */
  processWeaponState(event: { currentWeapon: string; weapons: string[]; ammo: Record<string, HUDWeaponAmmo> }): void {
    this.currentWeapon = event.currentWeapon;
    this.weapons = [...event.weapons];
    this.ammo = { ...event.ammo };
  }

  getAmmoDisplay(weaponId: string): string {
    const ammo = this.ammo[weaponId];
    if (typeof ammo === "object" && ammo !== null) return `${ammo.clip} / ${ammo.reserve}`;
    return String(ammo ?? 0);
  }

  /**
   * Process a damage event (for floating damage numbers).
   */
  processDamage(event: any): void {
    this.damageNumbers.push({
      entityId: event.entityId ?? "",
      attackerId: event.attackerId ?? "",
      damage: event.damage ?? 0,
      weaponId: event.weaponId ?? "",
      timestamp: performance.now(),
    });
  }

  /**
   * Process a death event (kill feed).
   */
  processDeath(event: any): void {
    this.killFeed.push({
      victimId: event.entityId ?? "",
      killerId: event.killerId ?? "",
      weaponId: event.weaponId ?? "",
      timestamp: performance.now(),
    });

    // Cap kill feed length
    if (this.killFeed.length > HUDState.KILL_FEED_MAX) {
      this.killFeed.shift();
    }
  }

  /**
   * Update scoreboard from GameState players map.
   */
  updateScoreboard(state: GameState): void {
    this.scoreboard = [];

    // Extract match snapshot data
    const matchState = MatchStateManager.getInstance();
    this.gametypeName = matchState.gametypeName || "";
    this.teamScores = matchState.teamScores || {};
    this.teamNames = matchState.teamNames || {};

    for (const [playerId, player] of state.players) {
      const rawPlayerId = clientKeyDisplayId(playerId);
      const teamId = matchState.playerTeams?.[rawPlayerId];
      this.scoreboard.push({
        playerId,
        entityId: player.entityId,
        name: player.name,
        score: player.score,
        deaths: player.deaths,
        ping: player.ping,
        teamId,
      });
    }
    // Sort by score descending
    this.scoreboard.sort((a, b) => b.score - a.score);

    // Append spectators (no sim entity, so absent from state.players) — the
    // server sends their roster on the match_state event. teamId "spectator"
    // routes them into the scoreboard's SPECTATORS block.
    const seen = new Set(this.scoreboard.map((e) => e.playerId));
    for (const spec of matchState.spectators) {
      if (seen.has(spec.playerId)) continue;
      this.scoreboard.push({
        playerId: spec.playerId,
        entityId: "",
        name: spec.name,
        score: 0,
        deaths: 0,
        ping: spec.ping,
        teamId: "spectator",
      });
    }
  }

  /**
   * Expire old transients (call once per frame).
   */
  expireTransients(): void {
    const now = performance.now();

    // Expire damage numbers
    this.damageNumbers = this.damageNumbers.filter((d) => now - d.timestamp < HUDState.DAMAGE_EXPIRE_MS);

    // Expire kill feed
    this.killFeed = this.killFeed.filter((k) => now - k.timestamp < HUDState.KILL_FEED_EXPIRE_MS);
  }

  // ========================================================================
  // Debug Overlay
  // ========================================================================

  /**
   * Toggle debug overlay visibility.
   */
  toggleDebug(): void {
    this.debugEnabled = !this.debugEnabled;
    if (this.debugEnabled) {
      this.createDebugElement();
    } else {
      this.destroyDebugElement();
    }
  }

  /**
   * Enable/disable debug overlay.
   */
  setDebug(enabled: boolean): void {
    this.debugEnabled = enabled;
    if (enabled) {
      this.createDebugElement();
    } else {
      this.destroyDebugElement();
    }
  }

  /**
   * Update debug overlay (call once per frame if enabled).
   */
  updateDebugOverlay(): void {
    if (!this.debugEnabled || !this.debugElement) return;

    // Weapon inventory with ammo
    const wpnList = this.weapons
      .map((w) => {
        const active = w === this.currentWeapon ? "▸" : " ";
        return `  ${active} ${w}: ${this.getAmmoDisplay(w)}`;
      })
      .join("\n");

    const sb = this.scoreboard.map((p) => `  ${p.name}: ${p.score}/${p.deaths} (${p.ping}ms)`).join("\n");

    const feed = this.killFeed.map((k) => `  ${k.killerId} → ${k.victimId} [${k.weaponId}]`).join("\n");

    const dmg = this.damageNumbers
      .map((d) => `  ${d.attackerId} → ${d.entityId}: ${d.damage} [${d.weaponId}]`)
      .join("\n");

    this.debugElement.textContent =
      `━━━ HUD DATA ━━━\n` +
      `HP: ${this.health}  Armor: ${this.armor}  Dead: ${this.dead}\n` +
      `\n━━━ WEAPONS ━━━\n${wpnList || "  (none)"}\n` +
      `\n━━━ SCOREBOARD ━━━\n${sb || "  (empty)"}\n` +
      `\n━━━ KILL FEED ━━━\n${feed || "  (empty)"}\n` +
      `\n━━━ DAMAGE ━━━\n${dmg || "  (empty)"}`;
  }

  private createDebugElement(): void {
    if (this.debugElement) return;

    this.debugElement = document.createElement("div");
    this.debugElement.id = "hud-debug-overlay";
    Object.assign(this.debugElement.style, {
      position: "fixed",
      top: "10px",
      right: "10px",
      backgroundColor: "rgba(0, 0, 0, 0.75)",
      color: "#00ff88",
      fontFamily: '"Consolas", "Courier New", monospace',
      fontSize: "12px",
      padding: "12px 16px",
      borderRadius: "6px",
      border: "1px solid rgba(0, 255, 136, 0.3)",
      zIndex: "10000",
      whiteSpace: "pre",
      lineHeight: "1.5",
      pointerEvents: "none",
      minWidth: "280px",
      maxHeight: "400px",
      overflow: "hidden",
    });
    document.body.appendChild(this.debugElement);
  }

  private destroyDebugElement(): void {
    if (this.debugElement) {
      this.debugElement.remove();
      this.debugElement = null;
    }
  }

  // ========================================================================
  // Cleanup
  // ========================================================================

  reset(): void {
    this.health = 100;
    this.armor = 0;
    this.dead = false;
    this.damageNumbers = [];
    this.killFeed = [];
    this.scoreboard = [];
    this.destroyDebugElement();
  }

  static destroy(): void {
    HUDState.instance?.reset();
    HUDState.instance = null;
  }
}
