import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

/** The running app version (from tauri.conf.json). */
export async function currentVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "?";
  }
}

/** Command-palette entry point: check and, if found, confirm + install. */
export async function manualUpdateCheck(): Promise<void> {
  const u = await checkForUpdate();
  if (!u) {
    alert("Onyx is up to date.");
    return;
  }
  if (confirm(`Onyx ${u.version} is available. Install and restart now?`)) {
    await installUpdate(u);
  }
}

/** Check GitHub releases for a newer version. Returns null if none / on error. */
export async function checkForUpdate(): Promise<Update | null> {
  try {
    return await check();
  } catch (e) {
    console.warn("update check failed", e);
    return null;
  }
}

/**
 * Download + install an update (reporting 0–1 progress, or null when the total
 * size is unknown), then relaunch into the new version.
 */
export async function installUpdate(
  update: Update,
  onProgress?: (fraction: number | null) => void
): Promise<void> {
  let total = 0;
  let downloaded = 0;
  await update.downloadAndInstall((ev) => {
    switch (ev.event) {
      case "Started":
        total = ev.data.contentLength ?? 0;
        onProgress?.(total ? 0 : null);
        break;
      case "Progress":
        downloaded += ev.data.chunkLength;
        onProgress?.(total ? downloaded / total : null);
        break;
      case "Finished":
        onProgress?.(1);
        break;
    }
  });
  await relaunch();
}
