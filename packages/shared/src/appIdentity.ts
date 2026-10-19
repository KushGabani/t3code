/**
 * The names this build claims on a machine: its data directory, desktop app
 * id, URL schemes, Electron profile, service labels and default port.
 *
 * Every entry is a place where two installs would otherwise collide, so a
 * build with its own identity runs beside an installed T3 Code (stable or
 * nightly) instead of sharing its state, server lock, deep links or updates.
 */
export const APP_IDENTITY = {
  /** Shown in window titles, the About panel and the OS app name. */
  baseName: "WorkLayer",
  /** Default data directory under the user's home (`~/.worklayer`). */
  homeDirName: ".worklayer",
  /** Lowercase token for the Electron profile, WM class, executable and services. */
  slug: "worklayer",
  /** macOS bundle id, Windows AppUserModelID and Linux AppStream id. */
  appId: "com.worklayer.desktop",
  /** Reverse-DNS prefix for Linux .desktop entries. */
  desktopEntryPrefix: "com.worklayer.WorkLayer",
  scheme: "worklayer",
  devScheme: "worklayer-dev",
  /** First port the desktop backend tries; it scans upward when taken. */
  defaultPort: 4773,
} as const;

export function appScheme(development: boolean): string {
  return development ? APP_IDENTITY.devScheme : APP_IDENTITY.scheme;
}
