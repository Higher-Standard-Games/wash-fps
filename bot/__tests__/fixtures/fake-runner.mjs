// A stand-in for cli/bot-runner.ts, speaking its protocol: adds every bot but
// one named "Refused", sends a reference, and when its last bot goes says it
// is closing, refuses bots for a moment (as the runner does while its bots
// disconnect), then exits.
const bots = new Set();
let closing = false;
process.on("message", (message) => {
  if (message.type === "add" && closing) {
    process.send({ type: "failed", id: message.id, error: "Match runner closing" });
  } else if (message.type === "add") {
    if (message.options.name === "Refused") {
      process.send({ type: "failed", id: message.id, error: "refused" });
      return;
    }
    bots.add(message.id);
    process.send({ type: "reference", id: message.id, reference: { preset: "medium" } });
    process.send({ type: "added", id: message.id, playerId: `player_${bots.size}` });
  } else if (message.type === "remove") {
    bots.delete(message.id);
    if (bots.size === 0) {
      closing = true;
      process.send({ type: "closing" });
      setTimeout(() => process.exit(0), 150);
    }
  }
});
process.on("disconnect", () => process.exit(0));
