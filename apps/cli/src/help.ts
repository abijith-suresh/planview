export const COMMANDS = [
  "publish",
  "upload",
  "login",
  "logout",
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

const ROOT_HELP = `Usage: planview [global-options] <command> [options]

Commands:
  publish <file|folder>  Publish a snapshot and print its URL
  upload <file>          Upload an HTML page to your cloud workspace
  login                  Sign in to your cloud workspace
  logout                 Remove this computer's saved cloud sign-in
  get <id|url>           Write a stored snapshot to standard output
  start                  Start or reuse the daemon for the selected profile
  status                 Show daemon status without starting it
  stop                   Gracefully stop the local daemon
  restart                Restart the local daemon
  clean                  Remove expired snapshots and reconcile storage
  skills                 Manage bundled Agent Skills
  help [command]         Show help for a command

Global options:
  -h, --help             Show this help message
  -v, --version          Show the version
  --profile <name>       Use isolated state for this command (default: default)

Profile names use lowercase letters, numbers, hyphens, and underscores.
Use planview <command> --help for command options.
`;

const COMMAND_HELP: Record<HelpTopic, string> = {
  publish: `Usage: planview publish [options] <file|folder>

Publish one immutable HTML snapshot and print its localhost URL.
The input may be an HTML file or a page folder containing index.html.
The selected profile owns its documents and local daemon.

Options:
  -h, --help             Show this help message
  --open                 Open the published URL in the default browser
  --json                 Print the snapshot id and URL as one JSON object
`,
  upload: `Usage: planview upload [options] <file.html>

Upload one standalone HTML file to your cloud workspace and print its link.
Run planview login first. The cloud upload limit is 8 MiB.

Options:
  -h, --help             Show this help message
  --open                 Open the returned link in the default browser
  --json                 Print the document id and URL as one JSON object
`,
  login: `Usage: planview login [options]

Open GitHub sign-in in your browser and authorize this computer for cloud uploads.
Credentials are saved in the selected Planview profile's private data directory.

Options:
  -h, --help             Show this help message
  --cloud-url <url>      Sign in to a specific cloud app origin

The default cloud app is the current alpha staging site. Set PLANVIEW_CLOUD_URL
or use --cloud-url to select another app origin.
`,
  logout: `Usage: planview logout

Remove the saved cloud sign-in from the selected Planview profile on this computer.
`,
  get: `Usage: planview get [options] <id|url>

Write the stored snapshot's exact bytes to standard output.
The reference may be a document id or an exact local Planview URL.
The URL must use the selected profile's current port.

Options:
  -h, --help             Show this help message
`,
  start: `Usage: planview start [options]

Start the selected profile's daemon, or reuse its authenticated daemon.
If the preferred port is occupied, Planview uses the next available port.

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
