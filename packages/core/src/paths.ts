import { homedir } from "node:os";
import { posix as posixPath, win32 as win32Path } from "node:path";

export type AppDataPlatform = NodeJS.Platform;

export type AppDataPathDependencies = {
  readonly platform: AppDataPlatform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly profile?: string;
};

export type AppDataPaths = {
  readonly appDataDir: string;
  readonly databasePath: string;
  readonly documentsDir: string;
  readonly stagingDir: string;
};

const APP_DIRECTORY = "planview";
const WINDOWS_APP_DIRECTORY = "Planview";
const LOCAL_APP_DATA_KEY = "LOCALAPPDATA";
const XDG_DATA_HOME_KEY = "XDG_DATA_HOME";
export const DEFAULT_PROFILE_NAME = "default";
const PROFILE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,31})$/;
const MACOS_SYSTEM_PATH_ALIASES = [
  ["/etc", "/private/etc"],
  ["/tmp", "/private/tmp"],
  ["/var", "/private/var"],
] as const;

export const normalizeMacosSystemPath = (
  path: string,
  platform: AppDataPlatform = process.platform
) => {
  if (platform !== "darwin") {
    return path;
  }
  for (const [alias, target] of MACOS_SYSTEM_PATH_ALIASES) {
    if (path === alias || path.startsWith(`${alias}/`)) {
      return `${target}${path.slice(alias.length)}`;
    }
  }
  return path;
};

export const isValidProfileName = (value: string) => PROFILE_NAME_PATTERN.test(value);

export const validateProfileName = (value: string) => {
  if (!isValidProfileName(value)) {
    throw new Error(
      "The Planview profile name must start with a lowercase letter or number and contain only lowercase letters, numbers, hyphens, and underscores (up to 32 characters)."
    );
  }
  return value;
};

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
  const profile = validateProfileName(dependencies.profile ?? DEFAULT_PROFILE_NAME);
  const appDataRoot = resolveAppDataRoot({ platform, env, homeDir });
  const appDataDir =
    profile === DEFAULT_PROFILE_NAME ? appDataRoot : pathApi.join(appDataRoot, "profiles", profile);

  return {
    appDataDir,
    databasePath: pathApi.join(appDataDir, "metadata.sqlite"),
    documentsDir: pathApi.join(appDataDir, "documents"),
    stagingDir: pathApi.join(appDataDir, "staging"),
  };
};
