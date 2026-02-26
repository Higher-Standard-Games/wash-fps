// Extracted from FPSHud.ts
import { HUDState } from '../../HUDState';


// =============================================================================
// Phase 3: Scoreboard
// =============================================================================

/**
 * FPSScoreboard - Tab-toggle scoreboard overlay
 *
 * Not a regular HudWidget Ã¢â‚¬â€ it's a full-screen overlay managed by FPSHud.
 * Call toggle() or show/hide to control visibility.
 */
export class FPSScoreboard {
    private overlay: HTMLElement;
    private bodyEl: HTMLElement;
    private titleEl: HTMLElement;
    private visible: boolean = false;
    private localPlayerId: string = '';
    private board: HTMLElement;

    constructor() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'fps-scoreboard-overlay';
        this.overlay.style.display = 'none';

        this.board = document.createElement('div');
        this.board.className = 'fps-scoreboard manga-panel';

        const corners = document.createElement('div');
        corners.className = 'manga-panel-corners';
        this.board.appendChild(corners);

        this.titleEl = document.createElement('div');
        this.titleEl.className = 'fps-scoreboard-title';
        this.titleEl.textContent = 'SCOREBOARD';
        this.board.appendChild(this.titleEl);

        // Header and layout generated dynamically in refresh()
        this.bodyEl = document.createElement('div');
        this.bodyEl.className = 'fps-scoreboard-body';
        this.board.appendChild(this.bodyEl);

        this.overlay.appendChild(this.board);
        document.body.appendChild(this.overlay);
    }

    public setLocalPlayerId(id: string): void {
        this.localPlayerId = id;
    }

    public setTitle(title: string): void {
        this.titleEl.textContent = title;
    }

    public toggle(): void {
        if (this.visible) {
            this.hide();
        } else {
            this.show();
        }
    }

    public show(): void {
        this.visible = true;
        this.overlay.style.display = '';
        this.refresh();
    }

    public hide(): void {
        this.visible = false;
        this.overlay.style.display = 'none';
    }

    public isVisible(): boolean {
        return this.visible;
    }

    /**
     * Refresh the scoreboard rows from HUDState
     */
    public refresh(): void {
        if (!this.visible) return;

        const state = HUDState.getInstance();
        const hasTeams = Object.keys(state.teamScores).length > 0;

        // Clear existing layout
        this.board.innerHTML = '';

        // Add corners
        const corners = document.createElement('div');
        corners.className = 'manga-panel-corners';
        this.board.appendChild(corners);

        // Add title
        this.board.appendChild(this.titleEl);

        if (hasTeams) {
            const teamsContainer = document.createElement('div');
            teamsContainer.className = 'fps-scoreboard-teams';

            const createTeamScoreboard = (teamId: string, cssClass: string) => {
                const teamEl = document.createElement('div');
                teamEl.className = `fps-scoreboard-team ${cssClass}`;

                const teamName = state.teamNames[teamId] || `Team ${teamId}`;

                // Hide score from header since it's redundant with the columns below
                const title = document.createElement('div');
                title.className = 'fps-scoreboard-team-title';
                title.textContent = teamName;
                teamEl.appendChild(title);

                const header = document.createElement('div');
                header.className = 'fps-scoreboard-header';
                header.innerHTML = `
                    <span class="fps-scoreboard-col-name">Player</span>
                    <span class="fps-scoreboard-col-score">Score</span>
                    <span class="fps-scoreboard-col-ping">Ping</span>
                `;
                teamEl.appendChild(header);

                const body = document.createElement('div');
                body.className = 'fps-scoreboard-body';
                teamEl.appendChild(body);

                return { container: teamEl, body };
            };

            const udon = createTeamScoreboard('udon', 'fps-scoreboard-team--udon');
            const soba = createTeamScoreboard('soba', 'fps-scoreboard-team--soba');
            const specs: any[] = []; // Collect spectators to show later if needed

            for (const entry of state.scoreboard) {
                const row = document.createElement('div');
                row.className = 'fps-scoreboard-row';
                if (entry.playerId === this.localPlayerId) {
                    row.classList.add('fps-scoreboard-row--self');
                }
                row.innerHTML = `
                    <span class="fps-scoreboard-col-name">${this.escapeHtml(entry.name)}</span>
                    <span class="fps-scoreboard-col-score">${entry.score}</span>
                    <span class="fps-scoreboard-col-ping">${entry.ping}ms</span>
                `;

                if (entry.teamId === 'udon') udon.body.appendChild(row);
                else if (entry.teamId === 'soba') soba.body.appendChild(row);
                else specs.push(entry);
            }

            teamsContainer.appendChild(udon.container);
            teamsContainer.appendChild(soba.container);
            this.board.appendChild(teamsContainer);

            // Add spectators row if any
            if (specs.length > 0) {
                const specsContainer = document.createElement('div');
                specsContainer.className = 'fps-scoreboard-spectators';

                const title = document.createElement('div');
                title.className = 'fps-scoreboard-spectators-title';
                title.textContent = `SPECTATORS (${specs.length})`;
                specsContainer.appendChild(title);

                const body = document.createElement('div');
                body.className = 'fps-scoreboard-spectators-body';

                for (const entry of specs) {
                    const row = document.createElement('div');
                    row.className = 'fps-scoreboard-spectator-row';
                    if (entry.playerId === this.localPlayerId) {
                        row.classList.add('fps-scoreboard-row--self');
                    }
                    row.innerHTML = `<span class="fps-scoreboard-col-name">${this.escapeHtml(entry.name)}</span>`;
                    body.appendChild(row);
                }

                specsContainer.appendChild(body);
                this.board.appendChild(specsContainer);
            }

            // Keep reference for standard destroy/updates
            this.bodyEl = udon.body; // Just as a fallback for the instance property
        } else {
            // Standard FFA
            const header = document.createElement('div');
            header.className = 'fps-scoreboard-header';
            header.innerHTML = `
                <span class="fps-scoreboard-col-name">Player</span>
                <span class="fps-scoreboard-col-score">Score</span>
                <span class="fps-scoreboard-col-deaths">Deaths</span>
                <span class="fps-scoreboard-col-ping">Ping</span>
            `;
            this.board.appendChild(header);

            this.bodyEl = document.createElement('div');
            this.bodyEl.className = 'fps-scoreboard-body';
            this.board.appendChild(this.bodyEl);

            for (const entry of state.scoreboard) {
                const row = document.createElement('div');
                row.className = 'fps-scoreboard-row';
                if (entry.playerId === this.localPlayerId) {
                    row.classList.add('fps-scoreboard-row--self');
                }

                row.innerHTML = `
                    <span class="fps-scoreboard-col-name">${this.escapeHtml(entry.name)}</span>
                    <span class="fps-scoreboard-col-score">${entry.score}</span>
                    <span class="fps-scoreboard-col-deaths">${entry.deaths}</span>
                    <span class="fps-scoreboard-col-ping">${entry.ping}ms</span>
                `;
                this.bodyEl.appendChild(row);
            }
        }
    }

    private escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    public destroy(): void {
        this.overlay.remove();
    }
}
