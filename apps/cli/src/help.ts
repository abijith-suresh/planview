export const COMMANDS = [
  "publish",
  "preview",
  "get",
  "start",
  "status",
  "stop",
  "restart",
  "clean",
  "skills",
  "help",
] as const;

export type Command = (typeof COMMANDS)[number];
export type HelpTopic = Command | "skills install";

const ROOT_HELP = `Usage: planview <command> [options]

Commands:
  publish <file|folder>  Publish an immutable HTML snapshot and print its URL
  preview <file|folder>  Publish a snapshot and open its URL in a browser
  get <id|url>           Write a stored snapshot to standard output
  start                  Start the local daemon, or reuse the running daemon
  status                 Show daemon status without starting it
  stop                   Gracefully stop the local daemon
  restart                Restart the local daemon
  clean                  Remove expired snapshots and reconcile storage
  skills                 Manage bundled Agent Skills
  help [command]         Show help for a command

Global options:
  -h, --help             Show this help message
  -v, --version          Show the version

Use planview <command> --help for command options.
`;

const COMMAND_HELP: Record<HelpTopic, string> = {
  publish: `Usage: planview publish [options] <file|folder>

Publish one immutable HTML snapshot and print its localhost URL.
The input may be an HTML file or a page folder containing index.html.

Options:
  -h, --help             Show this help message
  --json                 Print the snapshot id and URL as one JSON object
`,
  preview: `Usage: planview preview [options] <file|folder>

Publish an immutable HTML snapshot and open its URL in the default browser.
The input may be an HTML file or a page folder containing index.html.

Options:
  -h, --help             Show this help message
  --json                 Print the snapshot id and URL as one JSON object
`,
  get: `Usage: planview get [options] <id|url>

Write the stored snapshot's exact bytes to standard output.
The reference may be a document id or an exact local Planview URL.

Options:
  -h, --help             Show this help message
`,
  start: `Usage: planview start [options]

Start the local daemon, or reuse the authenticated daemon already running.

Options:
  -h, --help             Show this help message
  --json                 Print the daemon status as one JSON object
`,
  status: `Usage: planview status [options]

Show daemon status without starting a daemon.

Options:
  -h, --help             Show this help message
  --json                 Print the daemon status as one JSON object
`,
  stop: `Usage: planview stop [options]

Gracefully stop the local daemon.

Options:
  -h, --help             Show this help message
  --json                 Print the stopped state as one JSON object
`,
  restart: `Usage: planview restart [options]

Restart the local daemon.

Options:
  -h, --help             Show this help message
  --json                 Print the daemon status as one JSON object
`,
  clean: `Usage: planview clean [options]

Remove expired snapshots and reconcile incomplete storage operations.

Options:
  -h, --help             Show this help message
  --json                 Print the cleanup result as one JSON object
`,
  skills: `Usage: planview skills <command>

Commands:
  install [--force]      Install bundled Agent Skills into ~/.agents/skills

Use planview skills install --help for installation details.
`,
  "skills install": `Usage: planview skills install [options]

Install the bundled planview and create-html Agent Skills into ~/.agents/skills.
Existing skill directories are refused unless --force is supplied.

Options:
  -h, --help             Show this help message
  --force                Replace existing skill directories
`,
  help: `Usage: planview help [command]

Show help for the whole CLI or for one command.
`,
};

export const HELP = ROOT_HELP;

export const formatHelp = (topic?: HelpTopic) =>
  topic === undefined ? ROOT_HELP : COMMAND_HELP[topic];
