// The in-app update check against GitHub releases, shared by UpdateBanner and Settings.
import { version as currentVersion } from "../../package.json";

export { currentVersion };
export const RELEASES_PAGE = "https://github.com/varneridge/study-library/releases/latest";
// GitHub redirects this to the newest release's installer, so a link to it starts the download at once.
export const INSTALLER_FILE_NAME = "StudyLibrarySetup.exe";
export const INSTALLER_DOWNLOAD_URL = `https://github.com/varneridge/study-library/releases/latest/download/${INSTALLER_FILE_NAME}`;
const LATEST_API = "https://api.github.com/repos/varneridge/study-library/releases/latest";
const DISMISSED_KEY = "studyLibrary.updateDismissed";

export type Release = { version: string };
type SessionStore = Pick<Storage, "getItem" | "setItem">;

export function parts(text: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? match.slice(1).map(Number) : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parts(candidate);
  const b = parts(current);
  if (!a || !b) return false;
  const i = a.findIndex((n, k) => n !== b[k]);
  return i >= 0 && a[i] > b[i];
}

/** Resolves to the newer release, or to null when this version is current or no releases exist yet, and rejects when GitHub cannot answer. */
export async function availableUpdate(fetcher: typeof fetch = fetch, current: string = currentVersion): Promise<Release | null> {
  const response = await fetcher(LATEST_API, { headers: { Accept: "application/vnd.github+json" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const data = (await response.json()) as { tag_name?: unknown };
  const tag = data?.tag_name;
  const found = typeof tag === "string" ? parts(tag) : null;
  const version = found ? found.join(".") : "";
  return found && isNewer(version, current) ? { version } : null;
}

export function isDismissed(version: string, store?: SessionStore): boolean {
  try {
    return (store ?? globalThis.sessionStorage)?.getItem(DISMISSED_KEY) === version;
  } catch {
    return false;
  }
}

export function dismiss(version: string, store?: SessionStore): void {
  try {
    (store ?? globalThis.sessionStorage)?.setItem(DISMISSED_KEY, version);
  } catch {
    // blocked or unavailable storage is ignored
  }
}

/** Whether Update now hands over to the Windows app, which installs in place and reopens itself. */
export function updatesInPlace(userAgent: string = globalThis.navigator?.userAgent ?? ""): boolean {
  return /Windows/.test(userAgent);
}

/** How long the banner waits for the app to close before offering Update now again, since a refused update leaves the app running. */
export const UPDATE_RETRY_MS = 120_000;

export function updateStartingText(version: string): string {
  return `Study Library is downloading ${version}, after which it will close, install the update and reopen by itself. ` +
    "If it is still open in two minutes, the Windows notification will explain what went wrong.";
}

/** The Windows app handles studylibrary://update, and everywhere else the release page offers the download. */
export function updateHref(release: Release, userAgent: string = globalThis.navigator?.userAgent ?? ""): string {
  return updatesInPlace(userAgent)
    ? `studylibrary://update?version=${encodeURIComponent(release.version)}`
    : RELEASES_PAGE;
}

/** The Windows app handles studylibrary://open, so a page in the browser can hand its own address to the desktop window. */
export function openInDesktopHref(path: string): string {
  return `studylibrary://open?path=${encodeURIComponent(path)}`;
}
