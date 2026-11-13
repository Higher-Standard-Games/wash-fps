import { Command, type CommandDef, type CommandOutput, fail } from "../../../../engine/console/Command";

export default class VideoExportCommand extends Command {
  readonly definition: CommandDef = {
    name: "videoexport",
    description: "Export a loaded demo to MP4: a highlight reel, or the full match with the game HUD",
    usage: "videoexport",
  };

  async execute(args: string[]): Promise<CommandOutput> {
    if (args.length) return fail(this.definition.usage!);
    try {
      const { openHighlightVideoExporter } = await import("../../client/video/HighlightVideoExporter");
      openHighlightVideoExporter();
      return "Video export dialog opened";
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
}
