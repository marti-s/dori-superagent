/**
 * The Slack token without putting it on a command line (#200). hc passes a session's env as argv (`env K=V ...`), which
 * `ps`, `hc get` and logs show, so a lane gets the path of an owner-only token file instead of the token itself.
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { configPath } from "./config.ts";

/** The token file a launcher finds next to its config when DORI_SLACK_TOKEN_FILE is not set. */
export const TOKEN_FILE_NAME = "slack-token";
/** Set to 1 to let a launcher hand its lanes a DORI_SLACK_TOKEN_FILE outside its own home (its config's directory). */
export const OUTSIDE_HOME_FLAG = "DORI_SLACK_TOKEN_FILE_OUTSIDE_HOME";
/** What boot prints next to a token file it read on Windows, where the file's NTFS ACL is not checked. */
export const WIN32_ACL_NOTICE = "the token file's NTFS ACL is not checked on Windows; keep it readable by you only";

export class TokenFileError extends Error {}

type Env = Readonly<Record<string, string | undefined>>;
/** The reading process's uid; undefined where there is none (Windows). Injectable for tests. */
type Uid = number | undefined;

/**
 * Reads the token file through ONE open file: the mode, the owner and the type are checked on that descriptor and the
 * token is read from it, so a file swapped in between a check and the read is never used. It must be a regular file
 * (a FIFO would block the read forever; it is opened non-blocking so the check is reached), owned by the reading user,
 * and owner-only (no group or other bits). The mode and owner are POSIX checks: on Windows stat reports 0666 or 0444 and
 * no uid, so there the NTFS ACL is the owner's job and boot says so (WIN32_ACL_NOTICE).
 */
const readTokenFile = (path: string, platform: string, uid: Uid): string => {
  // `path` is already resolved (see tokenFileToRead). POSIX opens it as-is with O_NOFOLLOW, so a link put at that name
  // after it was resolved is refused, never followed.
  const posix = platform !== "win32";
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (posix ? constants.O_NONBLOCK | constants.O_NOFOLLOW : 0));
  } catch {
    throw new TokenFileError(`DORI_SLACK_TOKEN_FILE ${path} cannot be read`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new TokenFileError(`DORI_SLACK_TOKEN_FILE ${path} is not a regular file`);
    if (platform !== "win32") {
      if (uid !== undefined && st.uid !== uid)
        throw new TokenFileError(`DORI_SLACK_TOKEN_FILE ${path} is owned by uid ${st.uid}, not by this user (${uid})`);
      if ((st.mode & 0o077) !== 0)
        throw new TokenFileError(
          `DORI_SLACK_TOKEN_FILE ${path} is open to group or others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`,
        );
    }
    let value: string;
    try {
      value = readFileSync(fd, "utf8").trim();
    } catch {
      throw new TokenFileError(`DORI_SLACK_TOKEN_FILE ${path} cannot be read`);
    }
    if (!value) throw new TokenFileError(`DORI_SLACK_TOKEN_FILE ${path} is empty`);
    return value;
  } finally {
    closeSync(fd);
  }
};

/**
 * DORI_SLACK_TOKEN when set and not empty, else the trimmed contents of the file DORI_SLACK_TOKEN_FILE names (checked as
 * readTokenFile says), else undefined. A bad file is a TokenFileError naming the path, never read as no token.
 */
export const slackToken = (
  env: Env = process.env,
  platform: string = process.platform,
  uid: Uid = process.getuid?.(),
  configFile: string = configPath(),
): string | undefined => {
  const token = env["DORI_SLACK_TOKEN"];
  if (token) return token;
  const path = tokenFileToRead(env, configFile);
  return path ? readTokenFile(path, platform, uid) : undefined;
};

/** Set by launch beside DORI_SLACK_TOKEN_FILE to the same string: the path a lane gets is already resolved. */
export const RESOLVED_MARK = "DORI_SLACK_TOKEN_FILE_RESOLVED";
/** Set by launch to the (resolved) home whose check that path passed; the mark holds only in that same home. */
export const RESOLVED_HOME = "DORI_SLACK_TOKEN_FILE_HOME";

/**
 * The token file a reader opens, resolved exactly once. A lane's path was resolved and home-checked by its launcher,
 * which marks it (RESOLVED_MARK equal to the path, RESOLVED_HOME the home it was checked for), so a reader in that same
 * home opens the string as it is: resolving it again would follow a link put there since. The mark holds only in that
 * home: an env inherited into another home (#200) carries home A's mark, which home B ignores, so B resolves and
 * home-checks the path itself and refuses A's file. Any unmarked path (the lead's own setting, `dori boot`, `dori send`)
 * is resolved once here and home-checked (homeTokenFile), and that same string is the one read.
 */
export const tokenFileToRead = (env: Env, configFile: string): string | undefined => {
  const named = env["DORI_SLACK_TOKEN_FILE"];
  if (!named) return undefined;
  const marked = env[RESOLVED_MARK] === named && env[RESOLVED_HOME] === homeOf(configFile);
  return marked ? named : homeTokenFile(env, configFile);
};

/** Boot's note about a token taken from a file on Windows, whose ACL nothing checks; undefined everywhere else. */
export const tokenFileNotice = (env: Env = process.env, platform: string = process.platform): string | undefined =>
  platform === "win32" && !env["DORI_SLACK_TOKEN"] && env["DORI_SLACK_TOKEN_FILE"] ? WIN32_ACL_NOTICE : undefined;

/**
 * A path's real location: links resolved where they exist, so a link inside the home to another home's file is outside.
 * A missing path resolves through its parent. A link whose target does not exist is refused: the lane would follow it
 * wherever it later points.
 */
const real = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    let link = false;
    try {
      link = lstatSync(path).isSymbolicLink();
    } catch {}
    if (link) {
      let loop = false;
      try {
        realpathSync.native(path);
      } catch (e) {
        loop = (e as NodeJS.ErrnoException).code === "ELOOP";
      }
      throw new TokenFileError(loop ? `${path} is a link loop` : `${path} is a link whose target does not exist`);
    }
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), relative(parent, path));
  }
};
/**
 * The home a config file belongs to: the directory of the file the OS actually opens (links and `..` resolved
 * physically), so a `link/../config.json` that opens `far/config.json` has `far` as its home. A config file that does
 * not exist yet falls back to its directory, resolved the same way (never `resolve()` first, which drops `..` on paper). `realpathSync.native` (the OS's realpath): the JS one collapses `..`
 * on paper first and so misses the link.
 */
const homeOf = (configFile: string): string =>
  existsSync(configFile)
    ? dirname(realpathSync.native(configFile))
    : real(isAbsolute(configFile) ? dirname(configFile) : `${process.cwd()}${sep}${dirname(configFile)}`);
/** Whether an already-resolved path is inside an already-resolved directory. */
const inside = (dir: string, path: string): boolean => {
  const rel = relative(dir, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Refuses a DORI_SLACK_TOKEN_FILE outside this home (the config's directory, links resolved) unless
 * DORI_SLACK_TOKEN_FILE_OUTSIDE_HOME=1 says it is meant: it is most likely inherited from another home's core (#200, one
 * variable over). Launch checks it before handing the path to a lane, and boot before it authenticates with it.
 */
export const homeTokenFile = (env: Env, configFile: string): string | undefined => {
  const named = env["DORI_SLACK_TOKEN_FILE"];
  if (!named) return undefined;
  const home = homeOf(configFile);
  // Resolved once: the string checked is the string the lane gets, so a link swapped later is never followed.
  // Never resolve() first: it collapses `..` on paper, and the OS may open the file through a link instead.
  const file = real(isAbsolute(named) ? named : `${process.cwd()}${sep}${named}`);
  // A missing file is passed only at the home's own slack-token, which the owner sets up; any other name that does not
  // exist yet is refused, since a link later put at that name is what the lane would follow.
  if (!existsSync(file) && file !== join(home, TOKEN_FILE_NAME))
    throw new TokenFileError(
      `DORI_SLACK_TOKEN_FILE ${file} does not exist; only this home's own ${TOKEN_FILE_NAME} may be named before it exists`,
    );
  if (inside(home, file) || env[OUTSIDE_HOME_FLAG] === "1") return file;
  throw new TokenFileError(
    `DORI_SLACK_TOKEN_FILE ${file} is outside this home (${home}), so it may be another home's; set ${OUTSIDE_HOME_FLAG}=1 if it is meant`,
  );
};

/**
 * The env a lane needs to find this home's token: the token file's path, never the token, made absolute because the
 * lane runs in another directory. The home is the launcher's config directory. Its own `slack-token` there is used
 * when DORI_SLACK_TOKEN_FILE is unset. A DORI_SLACK_TOKEN_FILE inside the home is passed even when missing, so the lane
 * refuses with the path-only error. One outside the home is most likely inherited from another home's core (#200, one
 * variable over), so it is refused unless DORI_SLACK_TOKEN_FILE_OUTSIDE_HOME=1 says it was meant. With no token file at
 * all nothing is added, as before. DORI_SLACK_TOKEN is passed empty: an hc lane inherits the core's env, which may hold
 * another home's token, and a set DORI_SLACK_TOKEN is read before the file. The allow flag is passed empty too, so a
 * lane never carries this home's permission into a home it starts.
 */
export const laneTokenEnv = (env: Env, configFile: string): Record<string, string> => {
  const pass = (file: string): Record<string, string> => ({
    DORI_SLACK_TOKEN_FILE: file,
    [RESOLVED_MARK]: file,
    [RESOLVED_HOME]: homeOf(configFile),
    DORI_SLACK_TOKEN: "",
    [OUTSIDE_HOME_FLAG]: "",
  });
  const file = homeTokenFile(env, configFile);
  if (file) return pass(file);
  const home = homeOf(configFile);
  const own = join(home, TOKEN_FILE_NAME);
  if (existsSync(own)) {
    // The home's own file gets the same check as a named one, on the one resolved string the lane also gets.
    const resolved = real(own);
    if (!inside(home, resolved))
      throw new TokenFileError(`${own} links outside this home (${home}), so it may be another home's token file`);
    return pass(resolved);
  }
  // No token file: nothing is added, except that an inherited allow flag is emptied so no lane carries it onward.
  return env[OUTSIDE_HOME_FLAG] ? { [OUTSIDE_HOME_FLAG]: "" } : {};
};

/**
 * The env launch gives a lane for its token: laneTokenEnv, plus DORI_CONFIG made absolute when the launcher's was relative,
 * since the lane runs in another directory and must find the same home (the token-file mark is checked against it). A DORI_CONFIG whose home moves when normalized (empty, `.`, `..`) names no config file and is
 * refused, rather than letting the home check move up a directory.
 */
export const laneLaunchEnv = (env: Env, rawConfig: string): Record<string, string> => {
  const config = resolve(rawConfig);
  if (dirname(config) !== resolve(dirname(rawConfig)))
    throw new TokenFileError(
      `DORI_CONFIG "${rawConfig}" does not name a config file; set it to the config file's path`,
    );
  // Only a RELATIVE DORI_CONFIG is rewritten, and only by putting the launcher's cwd in front as text (never path.join,
  // which collapses `..` on paper): the OS then resolves it (links, `..`) exactly as the launcher's own config load did. An absolute one reaches the lane unchanged.
  const raw = env["DORI_CONFIG"];
  const relativeConfig = raw !== undefined && !isAbsolute(raw);
  const osPath = relativeConfig ? `${process.cwd()}${sep}${raw}` : (raw ?? config);
  return { ...laneTokenEnv(env, osPath), ...(relativeConfig ? { DORI_CONFIG: osPath } : {}) };
};
