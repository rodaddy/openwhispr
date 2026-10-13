const { execFile } = require("child_process");
const { resolveBundledBinary, forgetBundledBinary } = require("./binaryResolver");
const debugLogger = require("./debugLogger");

// The idle tray tick asks every 2 s; a 1 s TTL spawned the helper on every
// tick. Callers that need a fresh answer (device change, recording) pass
// { refresh: true }.
const CACHE_TTL_MS = 30000;
const HELPER = "macos-mic-listener";
const UNSPAWNABLE = new Set(["ENOENT", "EACCES"]);
const COMMAND_TIMEOUT_MS = 4000;
const MAX_OUTPUT_BYTES = 4096;
const UNKNOWN_STATUS = Object.freeze({ status: "unknown", receiverPresent: null });

function runFile(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function parseLarkM2Status(output) {
  const text = String(output || "");
  if (!text || Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) return null;

  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length !== 1 || lines[0].trim() !== lines[0]) return null;

  let value;
  try {
    value = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  if (value.status === "unknown") {
    const receiverPresent = value.receiverPresent;
    if (receiverPresent !== null && typeof receiverPresent !== "boolean") return null;
    return { status: "unknown", receiverPresent };
  }

  if (value.receiverPresent === false && value.status === "disconnected") {
    return { status: "disconnected", receiverPresent: false };
  }
  if (value.receiverPresent !== true) return null;
  if (typeof value.tx1Connected !== "boolean" || typeof value.tx2Connected !== "boolean") {
    return null;
  }

  const status = value.tx1Connected || value.tx2Connected ? "connected" : "disconnected";
  if (value.status !== status) return null;
  return {
    status,
    receiverPresent: true,
    tx1Connected: value.tx1Connected,
    tx2Connected: value.tx2Connected,
  };
}

function createLarkM2StatusGetter({
  platform = process.platform,
  run = runFile,
  resolveBinary = resolveBundledBinary,
  forgetBinary = forgetBundledBinary,
  logger = debugLogger,
  now = Date.now,
} = {}) {
  let cache = null;
  let cachedAt = 0;
  let pending = null;

  const query = async () => {
    if (platform !== "darwin") return UNKNOWN_STATUS;
    const binary = resolveBinary(HELPER, "audio");
    if (!binary) return UNKNOWN_STATUS;

    try {
      const result = parseLarkM2Status(await run(binary, ["--print-lark-status"]));
      if (result) return result;
      logger.debug("Lark M2 status helper returned invalid output", { platform }, "audio");
    } catch (error) {
      if (UNSPAWNABLE.has(error?.code)) forgetBinary(HELPER);
      logger.debug(
        "Lark M2 status helper failed",
        {
          platform,
          code: error?.code,
          signal: error?.signal,
          timedOut: Boolean(error?.killed),
        },
        "audio"
      );
    }
    return UNKNOWN_STATUS;
  };

  return async ({ refresh = false } = {}) => {
    if (!refresh && cache && now() - cachedAt < CACHE_TTL_MS) return cache;
    if (pending) return pending;

    pending = query()
      .then((result) => {
        cache = result;
        cachedAt = now();
        return result;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

module.exports = {
  createLarkM2StatusGetter,
  getLarkM2Status: createLarkM2StatusGetter(),
  parseLarkM2Status,
};
