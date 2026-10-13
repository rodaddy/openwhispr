/**
 * Dictation formatting target lookup.
 *
 * Decides what the app a dictation is about to land in looks like to the
 * formatting-profile policy (`dictationFormattingProfile.js`): its bundle
 * name and its executable name. All I/O is injected, so this stays
 * Electron-free and unit-testable.
 *
 * It deliberately sets no `isTerminal` flag: the formatting policy has its
 * own app table that names the terminals. The paste path's terminal
 * classifier (`clipboardManager.isTerminalSignature`) answers a different
 * question, how to paste into the app, not how to format for it.
 *
 * Windows and Linux return `{}` on purpose in this slice: an empty target
 * resolves to the default profile, so untested platforms get no behaviour
 * change.
 */
async function resolveDictationFormattingTarget({ platform, targetPid, readExecutablePath } = {}) {
  try {
    if (platform !== "darwin" || !targetPid || typeof readExecutablePath !== "function") {
      return {};
    }
    const executablePath = await readExecutablePath(targetPid);
    if (!executablePath || typeof executablePath !== "string") return {};

    // Bundle and executable names only, never the whole path: a directory
    // segment such as "/Applications/Utilities/" is not the app's identity.
    const appName = executablePath.match(/\/([^/]+)\.app\//)?.[1] || null;
    const exeName = executablePath.split("/").pop() || null;
    return { appName, exeName };
  } catch {
    return {};
  }
}

module.exports = { resolveDictationFormattingTarget };
