import { Command, type CommandDef } from "../../../../engine/console/Command";

export default class TimedemoCommand extends Command {
  readonly definition: CommandDef = {
    name: "timedemo",
    description: "Run a local scripted benchmark, including seeded bot POV spectating",
    usage: "timedemo <list|fixture-id|abort|report|export> [--mode realtime] [--repeats 1-5]",
  };

  async execute(args: string[]): Promise<string> {
    if (!args.length) return this.definition.usage!;
    const { TimedemoService } = await import("../../client/TimedemoService");
    const service = TimedemoService.getInstance();
    try {
      switch (args[0]) {
        case "list":
          return (await service.list()).join("\n") || "No fixtures";
        case "abort":
          service.abort();
          return "Timedemo abort requested";
        case "report":
          return service.formatReport();
        case "export":
          return service.export();
      }
      let repeats = 3;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--mode") {
          if (args[++i] !== "realtime")
            return "Only realtime is implemented; fixed-work mode requires presentation-clock validation.";
        } else if (args[i] === "--repeats") repeats = Number(args[++i]);
        else return `Unknown timedemo option: ${args[i]}`;
      }
      return service.start(args[0], repeats);
    } catch (error) {
      return `timedemo: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
