// Apple Reminders bridge for brain-dump to-dos. Main process only.
// All user text reaches AppleScript through `on run argv`; nothing is ever
// spliced into the script, and "--" stops osascript reading any of it as a flag.
const { execFile } = require("child_process");

const PERMISSION_MESSAGE =
  "Allow rTech Whisper to control Reminders in System Settings > Privacy & Security > Automation.";

class RemindersPermissionError extends Error {
  constructor(cause) {
    super(PERMISSION_MESSAGE);
    this.name = "RemindersPermissionError";
    this.cause = cause;
  }
}

const ADD_SCRIPT = `on run argv
  set theTitle to item 1 of argv
  set theNotes to item 2 of argv
  set theListName to item 3 of argv
  tell application "Reminders"
    if not (exists list theListName) then make new list with properties {name:theListName}
    set theReminder to make new reminder at end of reminders of list theListName with properties {name:theTitle, body:theNotes}
    return id of theReminder
  end tell
end run`;

const REMOVE_SCRIPT = `on run argv
  set theId to item 1 of argv
  tell application "Reminders"
    if exists reminder id theId then delete reminder id theId
  end tell
end run`;

// "--" ends osascript's option parsing, so a user arg such as "-e", "-l"
// or "- buy milk" is passed to `on run argv` instead of read as a flag.
function osascriptArgv(script, args) {
  return ["-e", script, "--", ...args];
}

function runOsascript(script, args) {
  return new Promise((resolve, reject) => {
    execFile("osascript", osascriptArgv(script, args), (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

function isPermissionError(error) {
  const text = `${error?.message ?? ""} ${error?.stderr ?? ""}`;
  return text.includes("-1743") || /not allowed/i.test(text);
}

function createRemindersBridge({ runner = runOsascript, platform = process.platform } = {}) {
  async function run(script, args) {
    if (platform !== "darwin") throw new Error("Reminders is macOS only");
    try {
      return String(await runner(script, args));
    } catch (error) {
      if (isPermissionError(error)) throw new RemindersPermissionError(error);
      throw error;
    }
  }

  async function addReminder({ title, notes = "", list = "Brain dumps" }) {
    const output = await run(ADD_SCRIPT, [String(title), String(notes), String(list)]);
    return { id: output.trim() };
  }

  async function removeReminder(id) {
    await run(REMOVE_SCRIPT, [String(id)]);
  }

  return { addReminder, removeReminder };
}

const defaultBridge = createRemindersBridge();

module.exports = {
  createRemindersBridge,
  RemindersPermissionError,
  osascriptArgv,
  addReminder: defaultBridge.addReminder,
  removeReminder: defaultBridge.removeReminder,
};
