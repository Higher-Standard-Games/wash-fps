/** Command-line options of run.ts, in a module of their own so tests can import them without running anything. */

export interface Options {
  only?: string;
  runs: number;
  out?: string;
  list: boolean;
  compare?: [string, string];
}

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = { runs: 3, list: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--only":
        options.only = argv[++i];
        break;
      case "--runs":
        options.runs = Math.max(1, Number.parseInt(argv[++i], 10) || 1);
        break;
      case "--out":
        options.out = argv[++i];
        break;
      case "--list":
        options.list = true;
        break;
      case "--compare":
        options.compare = [argv[++i], argv[++i]];
        break;
    }
  }
  return options;
}
