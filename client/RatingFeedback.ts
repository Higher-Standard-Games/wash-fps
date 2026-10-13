/** Player wording for stored decisions; unknown/new exclusions stay honest. */
export function ratingFeedback(status: string, reason: string): string {
  if (status === "pending") return "Rating pending: this bot configuration has not been calibrated for this match.";
  if (status === "applied") return "Rated";
  const labels: Record<string, string> = {
    aborted: "The match ended before a valid result.",
    public_roster_ineligible: "The public roster did not qualify.",
    too_few_accounts: "There were too few verified players.",
    late_join: "A player joined after the match started.",
    team_changed: "A player changed sides during the match.",
    participation_interrupted: "A player's participation was interrupted.",
    bot_reference_changed: "The bot configuration changed or its control connection was lost.",
    bot_custom: "A bot with a custom difficulty has no rating to play against.",
    bot_reference_missing: "A bot's difficulty could not be verified.",
    starting_roster_unavailable: "The original roster could not be verified.",
    invalid_starting_roster: "The original roster did not qualify.",
    incomplete_roster: "The played roster did not match the original roster.",
    participation_unknown: "Full-match participation could not be verified.",
    invalid_standings: "Final standings could not be verified.",
    unsupported_forfeit: "This departure did not qualify as a rated forfeit.",
    missing_winner_or_draw: "The match had no valid winner or draw.",
  };
  return `Not rated: ${labels[reason] ?? "This match did not meet the rating rules."}`;
}
