import { homedir } from "node:os";
import { posix as posixPath, win32 as win32Path } from "node:path";

export type AppDataPlatform = NodeJS.Platform;

export type AppDataPathDependencies = {
  readonly platform: AppDataPlatform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
};

export type AppDataPaths = {
  readonly appDataDir: string;
  readonly databasePath: string;
  readonly documentsDir: string;
};

const APP_DIRECTORY = "planview";
const WINDOWS_APP_DIRECTORY = "Planview";
const LOCAL_APP_DATA_KEY = "LOCALAPPDATA";
const XDG_DATA_HOME_KEY = "XDG_DATA_HOME";

const pathFor = (platform: AppDataPlatform) => (platform === "win32" ? win32Path : posixPath);

const requireAbsoluteHome = (homeDir: string, pathApi: typeof posixPath | typeof win32Path) => {
  if (!pathApi.isAbsolute(homeDir)) {
    throw new Error("The home directory must be an absolute path.");
  }

  return homeDir;
};

const absoluteEnvironmentPath = (
  value: string | undefined,
  pathApi: typeof posixPath | typeof win32Path
) => (value !== undefined && value !== "" && pathApi.isAbsolute(value) ? value : undefined);

const resolveAppDataRoot = ({ platform, env, homeDir }: AppDataPathDependencies) => {
  const pathApi = pathFor(platform);
  const absoluteHomeDir = requireAbsoluteHome(homeDir, pathApi);

  if (platform === "win32") {
    const localAppData = absoluteEnvironmentPath(env[LOCAL_APP_DATA_KEY], pathApi);
    return pathApi.join(
      localAppData ?? pathApi.join(absoluteHomeDir, "AppData", "Local"),
      WINDOWS_APP_DIRECTORY
    );
  }

  if (platform === "darwin") {
    return pathApi.join(absoluteHomeDir, "Library", "Application Support", WINDOWS_APP_DIRECTORY);
  }

  const xdgDataHome = absoluteEnvironmentPath(env[XDG_DATA_HOME_KEY], pathApi);
  return pathApi.join(
    xdgDataHome ?? pathApi.join(absoluteHomeDir, ".local", "share"),
    APP_DIRECTORY
  );
};

export const resolveAppDataPaths = (dependencies: Partial<AppDataPathDependencies> = {}) => {
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const homeDir = dependencies.homeDir ?? homedir();
  const pathApi = pathFor(platform);
  const appDataDir = resolveAppDataRoot({ platform, env, homeDir });

  return {
    appDataDir,
    databasePath: pathApi.join(appDataDir, "metadata.sqlite"),
    documentsDir: pathApi.join(appDataDir, "documents"),
  };
};
