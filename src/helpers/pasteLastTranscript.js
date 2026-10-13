// The paste-last hotkey (#634): paste the most recent dictation again at the
// caret, for a paste that was lost. The text goes to `pasteText` as it was
// spoken and with no options at all, so this path cannot press Return, cannot
// format for an app and cannot bring another app forward. The text is never
// logged.
const { parseHotkeyList } = require("./hotkeyList");

// This slot is in no native dispatch table, so a key that only a native
// listener can fire (Globe/Fn, a mouse button, a right-side modifier, a
// modifier-only combination) would be saved and never fire. The predicates
// are hotkeyManager's, passed in so this file stays free of Electron.
function isPasteLastHotkeyDispatchable(
  hotkeyInput,
  { isGlobeLikeHotkey, isMouseButtonHotkey, isRightSideModifier, isModifierOnlyHotkey }
) {
  return !parseHotkeyList(hotkeyInput).some(
    (hotkey) =>
      isGlobeLikeHotkey(hotkey) ||
      isMouseButtonHotkey(hotkey) ||
      isRightSideModifier(hotkey) ||
      isModifierOnlyHotkey(hotkey)
  );
}

function createPasteLastCallback({ isBusy, getText, pasteText, log }) {
  return async function pasteLastTranscript() {
    try {
      if (isBusy()) return;
      const text = getText();
      if (!text) {
        log("Paste-last hotkey pressed with no dictation to paste");
        return;
      }
      await pasteText(text, {});
    } catch (error) {
      // Not the message: a paste error can quote the text it failed to paste.
      log("Paste-last hotkey failed", { error: error?.name || "Error", code: error?.code });
    }
  };
}

module.exports = { createPasteLastCallback, isPasteLastHotkeyDispatchable };
