#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { findBinaryInDir, parseArgs, setExecutable } = require("./lib/download-utils");

// omnivoice.cpp publishes no release binaries, so the sidecar is built from a pinned commit.
const OMNIVOICE_CPP_REPO = "https://github.com/ServeurpersoCom/omnivoice.cpp.git";
const OMNIVOICE_CPP_COMMIT = "b549668434fbe0a8592ae26adc08c1aa4e329805";
const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

const BUILD_LOCK_PATH = path.join(BIN_DIR, ".omnivoice-cpp-build.lock");

const BUILD_TARGET = "omnivoice-tts";
const EXECUTABLE_MAGICS = [
  "feedface", // Mach-O 32-bit
  "feedfacf", // Mach-O 64-bit
  "cefaedfe", // Mach-O 32-bit, byte-swapped
  "cffaedfe", // Mach-O 64-bit, byte-swapped
  "cafebabe", // Mach-O universal
  "bebafeca", // Mach-O universal, byte-swapped
  "7f454c46", // ELF
];
const PE_MAGIC = "4d5a";

function outputNameFor(platform, arch) {
  const name = `${BUILD_TARGET}-${platform}-${arch}`;
  return platform === "win32" ? `${name}.exe` : name;
}

// Static ggml: the default shared build links libggml*.dylib through an rpath
// that points into the build tree, so the copied binary would not start once
// the source dir is removed. Static leaves only system frameworks.
function cmakeConfigureArgs(platform) {
  const args = ["-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF"];
  if (platform === "darwin") {
    args.push("-DGGML_METAL=ON");
  }
  return args;
}

function isUsableBinary(filePath) {
  let fd;
  try {
    if (fs.statSync(filePath).size <= 0) return false;
    fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, header, 0, 4, 0);
    const magic = header.subarray(0, bytesRead).toString("hex");
    return EXECUTABLE_MAGICS.includes(magic) || magic.startsWith(PE_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function sha256Of(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function stampPathFor(outputPath) {
  return `${outputPath}.stamp.json`;
}

// The stamp ties the installed binary to the commit it was built from and to
// its exact bytes. A binary without a matching stamp is rebuilt: it is from
// another pin, or it is a copy that was cut short.
function isCurrentBuild(outputPath, commit) {
  if (!isUsableBinary(outputPath)) return false;
  try {
    const stamp = JSON.parse(fs.readFileSync(stampPathFor(outputPath), "utf8"));
    return stamp.commit === commit && stamp.sha256 === sha256Of(outputPath);
  } catch {
    return false;
  }
}

// Copy lands in <output>.part and is renamed into place, so the final name
// never holds a partial file. The old stamp is dropped first and the new one
// is written last: any interruption leaves no stamp, which forces a rebuild.
function installBinary(builtPath, outputPath, commit) {
  const stampPath = stampPathFor(outputPath);
  const partPath = `${outputPath}.part`;
  fs.rmSync(stampPath, { force: true });
  fs.rmSync(partPath, { force: true });

  fs.copyFileSync(builtPath, partPath);
  setExecutable(partPath);
  fs.renameSync(partPath, outputPath);

  const sha256 = sha256Of(outputPath);
  const stampPart = `${stampPath}.part`;
  fs.writeFileSync(stampPart, `${JSON.stringify({ commit, sha256 }, null, 2)}\n`);
  fs.renameSync(stampPart, stampPath);
  return sha256;
}

// Every command of the build, in order, as [tool, args]. Pure so the flags
// that reach cmake are testable without running a build.
function buildCommands({ cmake, srcDir, buildDir, platform, jobs }) {
  return [
    ["git", ["init", srcDir]],
    ["git", ["-C", srcDir, "remote", "add", "origin", OMNIVOICE_CPP_REPO]],
    ["git", ["-C", srcDir, "fetch", "--depth", "1", "origin", OMNIVOICE_CPP_COMMIT]],
    ["git", ["-C", srcDir, "checkout", "--detach", "FETCH_HEAD"]],
    ["git", ["-C", srcDir, "submodule", "update", "--init", "--recursive", "--depth", "1"]],
    [cmake, ["-S", srcDir, "-B", buildDir, ...cmakeConfigureArgs(platform)]],
    [
      cmake,
      ["--build", buildDir, "--config", "Release", "--target", BUILD_TARGET, "-j", String(jobs)],
    ],
  ];
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readLockPid(lockPath) {
  try {
    const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Two runs share one source dir and one output name, so the second would
// delete the tree the first is compiling. The lock is taken only by an atomic
// exclusive create and an existing lock is never replaced: plain files cannot
// compare-and-swap, so every way of replacing a stale lock left an
// interleaving in which two runs held it. A lock whose pid is dead,
// unreadable, or this process's own (a recycled pid after a crash) is stale,
// and is reported for the developer to remove.
function acquireBuildLock(lockPath, { pid = process.pid, isAlive = isProcessAlive } = {}) {
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const holder = readLockPid(lockPath);
    if (holder !== null && holder !== pid && isAlive(holder)) {
      throw new Error(`Another omnivoice.cpp build is running (pid ${holder})`);
    }
    throw new Error(
      `A stale omnivoice.cpp build lock remains at ${lockPath}. No build is running; remove that file and run again.`
    );
  }
  try {
    fs.writeSync(fd, String(pid));
  } catch (error) {
    // The file is this run's own and holds no pid yet: take it away again, or
    // every later run would be refused by an empty lock.
    fs.rmSync(lockPath, { force: true });
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

// Removes the lock only when this process holds it, so a run that was refused
// never removes the live holder's lock.
function releaseBuildLock(lockPath, { pid = process.pid } = {}) {
  if (readLockPid(lockPath) === pid) fs.rmSync(lockPath, { force: true });
}

function isRunnable(tool) {
  try {
    execFileSync(tool, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function installHint(tool) {
  if (process.platform === "darwin") return `brew install ${tool}`;
  return `install ${tool} with your package manager`;
}

function printUsage() {
  console.log(`Usage: node scripts/build-omnivoice-cpp.js [options]

Builds the omnivoice.cpp TTS sidecar from pinned commit ${OMNIVOICE_CPP_COMMIT}
for the current platform (${process.platform}-${process.arch}) into resources/bin.

Options:
  --force      Rebuild even if a usable binary already exists
  --keep-src   Keep the cloned source tree after building
  --help       Show this help

Environment:
  CMAKE        Path to the cmake executable (default: cmake)`);
}

function run(tool, args) {
  execFileSync(tool, args, { stdio: "inherit" });
}

function main() {
  if (process.argv.includes("--help")) {
    printUsage();
    return 0;
  }

  const { isForce } = parseArgs();
  const keepSrc = process.argv.includes("--keep-src");
  const platform = process.platform;
  const arch = process.arch;
  const outputName = outputNameFor(platform, arch);
  const outputPath = path.join(BIN_DIR, outputName);

  console.log(`\n[omnivoice-cpp] Building ${outputName} from ${OMNIVOICE_CPP_COMMIT}\n`);

  if (!isForce && isCurrentBuild(outputPath, OMNIVOICE_CPP_COMMIT)) {
    console.log(`  ${outputName}: already built from this commit (use --force to rebuild)`);
    return 0;
  }

  const cmake = process.env.CMAKE || "cmake";
  if (!isRunnable("git")) {
    console.error(
      `  git is required to build omnivoice.cpp but is not runnable: ${installHint("git")}`
    );
    return 1;
  }
  if (!isRunnable(cmake)) {
    console.error(
      `  cmake is required to build omnivoice.cpp but "${cmake}" is not runnable: ${installHint("cmake")}`
    );
    return 1;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  // Ctrl-C reaches the build child too; execFileSync then throws, the finally
  // releases the lock, and the script exits. Without a handler Node dies at
  // once on SIGINT and the lock is left behind. No SIGTERM handler: a plain
  // kill must still stop the script at once, and leaves a stale lock that the
  // refusal message explains.
  process.once("SIGINT", () => process.exit(130));
  try {
    acquireBuildLock(BUILD_LOCK_PATH);
  } catch (error) {
    console.error(`  ${error.message}`);
    return 1;
  }

  const srcDir = path.join(BIN_DIR, ".omnivoice-cpp-src");
  const buildDir = path.join(srcDir, "build");

  try {
    fs.rmSync(srcDir, { recursive: true, force: true });
    const commands = buildCommands({
      cmake,
      srcDir,
      buildDir,
      platform,
      jobs: os.cpus().length,
    });
    for (const [tool, args] of commands) {
      run(tool, args);
    }

    const builtName = platform === "win32" ? `${BUILD_TARGET}.exe` : BUILD_TARGET;
    const builtPath = findBinaryInDir(buildDir, builtName);
    if (!builtPath) {
      console.error(`  ${builtName} not found under ${buildDir}`);
      return 1;
    }
    if (!isUsableBinary(builtPath)) {
      console.error(`  ${builtPath} is not a usable executable`);
      return 1;
    }

    const sha256 = installBinary(builtPath, outputPath, OMNIVOICE_CPP_COMMIT);

    const sizeMb = Math.round(fs.statSync(outputPath).size / 1024 / 1024);
    console.log(`\n  ${outputName}: built (${sizeMb}MB, sha256 ${sha256})`);
    return 0;
  } catch (error) {
    console.error(`  ${outputName}: build failed: ${error.message}`);
    return 1;
  } finally {
    try {
      if (!keepSrc) {
        fs.rmSync(srcDir, { recursive: true, force: true });
      }
    } finally {
      releaseBuildLock(BUILD_LOCK_PATH);
    }
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  BIN_DIR,
  OMNIVOICE_CPP_COMMIT,
  OMNIVOICE_CPP_REPO,
  acquireBuildLock,
  buildCommands,
  cmakeConfigureArgs,
  installBinary,
  isCurrentBuild,
  isUsableBinary,
  outputNameFor,
  releaseBuildLock,
  stampPathFor,
};
