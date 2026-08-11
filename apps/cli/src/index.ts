import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectDaemon,
  restartDaemon,
  resolveDaemonConfig,
  resolveDaemonConfigForTest,
  startDetachedDaemon,
  stopDaemon,
} from "@planview/daemon";
import { Data, Effect } from "effect";

export const VERSION = "0.1.0";

export const HELP = `Usage: planview <command>

Commands:
  start       Start the local daemon, or reuse the running daemon
  status      Show daemon status without starting it
  stop        Gracefully stop the local daemon
  restart     Restart the local daemon

Options:
  -h, --help     Show this help message
  -v, --version  Show the version
`;

export const formatHelp = () => HELP;

export const formatVersion = () => `planview ${VERSION}\n`;

const writeStdout = (message: string) => {
  process.stdout.write(message);
};

const writeStderr = (message: string) => {
  process.stderr.write(message);
};

export class UnknownOptionError extends Data.TaggedError("UnknownOptionError")<{
  readonly option: string;
  readonly message: string;
}> {}

export class UnknownCommandError extends Data.TaggedError("UnknownCommandError")<{
  readonly command: string;
  readonly message: string;
}> {}

export class UnexpectedArgumentsError extends Data.TaggedError("UnexpectedArgumentsError")<{
  readonly arguments: readonly string[];
  readonly message: string;
}> {}

export class DaemonCommandError extends Data.TaggedError("DaemonCommandError")<{
  readonly command: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export type CliError =
  | UnknownOptionError
  | UnknownCommandError
  | UnexpectedArgumentsError
  | DaemonCommandError;

const COMMANDS = ["start", "status", "stop", "restart"] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (value: string | undefined): value is Command =>
  value !== undefined && (COMMANDS as readonly string[]).includes(value);

const isOption = (value: string) =>
  value === "--help" || value === "-h" || value === "--version" || value === "-v";

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const daemonScriptPath = () => fileURLToPath(new URL("./daemon.js", import.meta.url));

const resolveCliDaemonConfig = () => {
  const { NODE_ENV, PLANVIEW_TEST_DAEMON_PORT: configuredTestPort } = process.env;
  const testPort = NODE_ENV === "test" ? configuredTestPort : undefined;
  return testPort === undefined
    ? resolveDaemonConfig()
    : resolveDaemonConfigForTest({ port: Number(testPort) });
};

const formatRunning = (status: {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
}) => `Planview daemon is running at http://${status.host}:${status.port}/ (pid ${status.pid}).\n`;

const runDaemonCommand = (command: Command, stdout: (message: string) => void) =>
  Effect.tryPromise({
    try: async () => {
      const config = resolveCliDaemonConfig();
      if (command === "status") {
        const result = await inspectDaemon(config);
        stdout(
          result.state === "running"
            ? formatRunning(result.status)
            : "Planview daemon is not running.\n"
        );
        return 0;
      }

      if (command === "stop") {
        await stopDaemon(config);
        stdout("Planview daemon stopped.\n");
        return 0;
      }

      if (command === "restart") {
        const result = await restartDaemon(config, { daemonScriptPath: daemonScriptPath() });
        stdout(
          `Planview daemon restarted at http://${result.descriptor.host}:${result.descriptor.port}/.\n`
        );
        return 0;
      }

      const result = await startDetachedDaemon(config, { daemonScriptPath: daemonScriptPath() });
      stdout(
        result.reused
          ? `Planview daemon is already running at http://${result.descriptor.host}:${result.descriptor.port}/.\n`
          : `Planview daemon started at http://${result.descriptor.host}:${result.descriptor.port}/.\n`
      );
      return 0;
    },
    catch: (cause) =>
      new DaemonCommandError({
        command,
        cause,
        message: `Could not ${command} the Planview daemon: ${describe(cause)}`,
      }),
  });

const command = (
  args: readonly string[],
  stdout: (message: string) => void
): Effect.Effect<number, CliError> => {
  const [argument, ...trailing] = args;

  if (argument === undefined) {
    const output = formatHelp();
    return Effect.sync(() => {
      stdout(output);
      return 0;
    });
  }

  if (isOption(argument)) {
    if (trailing.length > 0) {
      const label = trailing.length === 1 ? "Unexpected argument" : "Unexpected arguments";
      return Effect.fail(
        new UnexpectedArgumentsError({
          arguments: trailing,
          message: `${label}: ${trailing.join(" ")}\n\n${formatHelp()}`,
        })
      );
    }

    const output = argument === "--version" || argument === "-v" ? formatVersion() : formatHelp();
    return Effect.sync(() => {
      stdout(output);
      return 0;
    });
  }

  if (!isCommand(argument)) {
    if (argument.startsWith("-")) {
      return Effect.fail(
        new UnknownOptionError({
          option: argument,
          message: `Unknown option: ${argument}\n\n${formatHelp()}`,
        })
      );
    }
    return Effect.fail(
      new UnknownCommandError({
        command: argument,
        message: `Unknown command: ${argument}\n\n${formatHelp()}`,
      })
    );
  }

  if (trailing.length > 0) {
    const label = trailing.length === 1 ? "Unexpected argument" : "Unexpected arguments";
    return Effect.fail(
      new UnexpectedArgumentsError({
        arguments: trailing,
        message: `${label}: ${trailing.join(" ")}\n\n${formatHelp()}`,
      })
    );
  }

  return runDaemonCommand(argument, stdout);
};

export const run = (args: readonly string[], stdout = writeStdout, stderr = writeStderr) =>
  command(args, stdout).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => stderr(error.message.endsWith("\n") ? error.message : `${error.message}\n`))
    )
  );

const boundary = (program: Effect.Effect<number, CliError>) =>
  program.pipe(
    Effect.catchTag(
      [
        "UnknownOptionError",
        "UnknownCommandError",
        "UnexpectedArgumentsError",
        "DaemonCommandError",
      ],
      () => Effect.succeed(1)
    )
  );

export const main = (args = process.argv.slice(2), stdout = writeStdout, stderr = writeStderr) => {
  const program = boundary(run(args, stdout, stderr));
  return isCommand(args[0]) ? Effect.runPromise(program) : Effect.runSync(program);
};

const isMain = (() => {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    return false;
  }

  try {
    return realpathSync(resolve(entrypoint)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const result = main();
  if (result instanceof Promise) {
    result.then((code) => {
      process.exitCode = code;
    });
  } else {
    process.exitCode = result;
  }
}
