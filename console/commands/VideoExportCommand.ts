import { Command, type CommandDef, type CommandOutput, fail } from "../../../../engine/console/Command";

export default class VideoExportCommand extends Command {
  readonly definition: CommandDef = {
    name: "videoexport",
    description: "Export a loaded demo's highlights to MP4",
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
