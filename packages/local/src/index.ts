import { Data, Effect } from "effect";
import {
  cleanDaemon,
  inspectDaemon,
  publishDocument,
  resolveDaemonConfig,
  resolveDaemonConfigForTest,
  restartDaemon,
  retrieveDocument,
  startDetachedDaemon,
  stopDaemon,
  type DaemonConfig,
} from "@planview/daemon";
import type { DocumentId } from "@planview/core";
import type { DocumentCleanupResult } from "@planview/storage";
import { preparePublishSource } from "./publish-source.js";
import { parseDocumentReference } from "./reference.js";

export type LocalOperation = "publish" | "get" | "start" | "stop" | "restart" | "inspect" | "clean";

export class LocalApplicationError extends Data.TaggedError("LocalApplicationError")<{
  readonly operation: LocalOperation;
  readonly cause: unknown;
  readonly message: string;
}> {}

export type LocalApplicationOptions = Readonly<{
  readonly daemonScriptPath: string;
  readonly config?: DaemonConfig;
}>;

export type LocalPublishedDocument = Readonly<{
  readonly id: DocumentId;
  readonly url: string;
}>;

export type LocalDaemonRunningStatus = Readonly<{
  readonly state: "running";
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: number;
}>;

export type LocalDaemonStatus = Readonly<{ readonly state: "stopped" }> | LocalDaemonRunningStatus;

export type LocalDaemonStartResult = Readonly<{
  readonly status: LocalDaemonRunningStatus;
  readonly reused: boolean;
}>;

export type LocalGetOptions = Readonly<{
  readonly reference: string;
  readonly onChunk: (chunk: Uint8Array) => void | Promise<void>;
}>;

export type LocalApplication = Readonly<{
  readonly publish: (
    sourcePath: string
  ) => Effect.Effect<LocalPublishedDocument, LocalApplicationError>;
  readonly get: (options: LocalGetOptions) => Effect.Effect<void, LocalApplicationError>;
  readonly start: () => Effect.Effect<LocalDaemonStartResult, LocalApplicationError>;
  readonly stop: () => Effect.Effect<void, LocalApplicationError>;
  readonly restart: () => Effect.Effect<LocalDaemonRunningStatus, LocalApplicationError>;
  readonly inspect: () => Effect.Effect<LocalDaemonStatus, LocalApplicationError>;
  readonly clean: () => Effect.Effect<DocumentCleanupResult, LocalApplicationError>;
}>;

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const localFailure = (operation: LocalOperation, cause: unknown) =>
  new LocalApplicationError({
    operation,
    cause,
    message: `Local ${operation} failed: ${describe(cause)}`,
  });

const statusFromDescriptor = (descriptor: {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: number;
}): LocalDaemonRunningStatus => ({
  state: "running",
  pid: descriptor.pid,
  host: descriptor.host,
  port: descriptor.port,
  startedAt: descriptor.startedAt,
});

const withConfig = <A>(
  operation: LocalOperation,
  resolveConfig: () => DaemonConfig,
  run: (config: DaemonConfig) => Effect.Effect<A, unknown>
): Effect.Effect<A, LocalApplicationError> =>
  Effect.tryPromise({
    try: () => Promise.resolve(resolveConfig()),
    catch: (cause) => localFailure(operation, cause),
  }).pipe(
    Effect.flatMap((config) =>
      run(config).pipe(Effect.mapError((cause) => localFailure(operation, cause)))
    )
  );

export const createLocalApplication = (options: LocalApplicationOptions): LocalApplication => {
  const resolveConfig = () => {
    if (options.config !== undefined) {
      return options.config;
    }
    const { NODE_ENV, PLANVIEW_TEST_DAEMON_PORT: configuredTestPort } = process.env;
    return NODE_ENV === "test" && configuredTestPort !== undefined
      ? resolveDaemonConfigForTest({ port: Number(configuredTestPort) })
      : resolveDaemonConfig();
  };
  const daemonOptions = { daemonScriptPath: options.daemonScriptPath };

  const publish = (sourcePath: string) =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => preparePublishSource(sourcePath),
        catch: (cause) => localFailure("publish", cause),
      }),
      (prepared) =>
        withConfig("publish", resolveConfig, (config) =>
          publishDocument(config, {
            ...daemonOptions,
            sourcePath: prepared.sourcePath,
            sourceSizeBytes: prepared.sourceSizeBytes,
          }).pipe(
            Effect.map((published) => ({
              id: published.id,
              url: `http://localhost:${published.descriptor.port}/${published.id}`,
            }))
          )
        ),
      (prepared) =>
        Effect.tryPromise({
          try: () => prepared.cleanup(),
          catch: (cause) => localFailure("publish", cause),
        })
    );

  const get = ({ reference, onChunk }: LocalGetOptions) =>
    withConfig("get", resolveConfig, (config) =>
      Effect.tryPromise({
        try: () => Promise.resolve().then(() => parseDocumentReference(reference, config.port)),
        catch: (cause) => cause,
      }).pipe(
        Effect.flatMap((documentId) =>
          retrieveDocument(config, {
            ...daemonOptions,
            documentId,
            onChunk,
          })
        ),
        Effect.map(() => undefined)
      )
    );

  const start = (): Effect.Effect<LocalDaemonStartResult, LocalApplicationError> =>
    withConfig("start", resolveConfig, (config) =>
      startDetachedDaemon(config, daemonOptions).pipe(
        Effect.map(({ descriptor, reused }) => ({
          status: statusFromDescriptor(descriptor),
          reused,
        }))
      )
    );

  const stop = () =>
    withConfig("stop", resolveConfig, (config) =>
      stopDaemon(config).pipe(Effect.map(() => undefined))
    );

  const restart = (): Effect.Effect<LocalDaemonRunningStatus, LocalApplicationError> =>
    withConfig("restart", resolveConfig, (config) =>
      restartDaemon(config, daemonOptions).pipe(
        Effect.map(({ descriptor }) => statusFromDescriptor(descriptor))
      )
    );

  const inspect = () =>
    withConfig("inspect", resolveConfig, (config) =>
      inspectDaemon(config).pipe(
        Effect.map((status) =>
          status.state === "running" ? statusFromDescriptor(status.status) : status
        )
      )
    );

  const clean = () =>
    withConfig("clean", resolveConfig, (config) =>
      cleanDaemon(config, daemonOptions).pipe(Effect.map(({ result }) => result))
    );

  return { publish, get, start, stop, restart, inspect, clean };
};

export { parseDocumentReference, preparePublishSource };
