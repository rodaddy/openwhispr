const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const {
  OMNIVOICE_CPP_COMMIT,
  acquireBuildLock,
  buildCommands,
  cmakeConfigureArgs,
  installBinary,
  isCurrentBuild,
  isUsableBinary,
  outputNameFor,
  releaseBuildLock,
  stampPathFor,
} = require("../../scripts/build-omnivoice-cpp");
const {
  HF_REVISION,
  QUANTS,
  argValue,
  downloadOne,
  fileUrl,
  planDownloads,
  planEntries,
} = require("../../scripts/download-omnivoice-gguf");
const { downloadFile } = require("../../scripts/lib/download-utils");

function withTempDir(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnivoice-sidecar-test-"));
  const finish = () => fs.rmSync(tempDir, { recursive: true, force: true });
  let result;
  try {
    result = fn(tempDir);
  } catch (error) {
    finish();
    throw error;
  }
  if (result && typeof result.then === "function") {
    return result.finally(finish);
  }
  finish();
  return result;
}

function fixtureEntry(name, bytes) {
  return {
    name,
    size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

test("outputNameFor names the sidecar per platform and arch", () => {
  assert.equal(outputNameFor("darwin", "arm64"), "omnivoice-tts-darwin-arm64");
  assert.equal(outputNameFor("linux", "x64"), "omnivoice-tts-linux-x64");
  assert.equal(outputNameFor("win32", "x64"), "omnivoice-tts-win32-x64.exe");
});

test("cmakeConfigureArgs enables Metal only on darwin", () => {
  assert.ok(cmakeConfigureArgs("darwin").includes("-DGGML_METAL=ON"));
  assert.ok(!cmakeConfigureArgs("linux").includes("-DGGML_METAL=ON"));
});

// Regression: the default shared build links libggml*.dylib through an rpath
// into the build tree, so the copied sidecar dies at load once the source dir
// is removed. Every platform must link ggml statically.
test("cmakeConfigureArgs links ggml statically on every platform", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const args = cmakeConfigureArgs(platform);
    assert.ok(args.includes("-DBUILD_SHARED_LIBS=OFF"), platform);
    assert.ok(args.includes("-DCMAKE_BUILD_TYPE=Release"), platform);
  }
});

test("isUsableBinary accepts only non-empty files with an executable magic", () =>
  withTempDir((tempDir) => {
    const write = (name, bytes) => {
      const filePath = path.join(tempDir, name);
      fs.writeFileSync(filePath, bytes);
      return filePath;
    };
    const padding = Buffer.alloc(16);

    assert.equal(isUsableBinary(path.join(tempDir, "missing")), false);
    assert.equal(isUsableBinary(write("empty", Buffer.alloc(0))), false);
    assert.equal(isUsableBinary(write("text", "#!/bin/sh\necho not a binary\n")), false);
    assert.equal(
      isUsableBinary(write("macho", Buffer.concat([Buffer.from("cffaedfe", "hex"), padding]))),
      true
    );
    assert.equal(
      isUsableBinary(write("elf", Buffer.concat([Buffer.from("7f454c46", "hex"), padding]))),
      true
    );
    assert.equal(
      isUsableBinary(write("pe", Buffer.concat([Buffer.from("4d5a", "hex"), padding]))),
      true
    );
  }));

test("source commit, weights revision and checksums are fully pinned", () => {
  assert.match(OMNIVOICE_CPP_COMMIT, /^[0-9a-f]{40}$/);
  assert.match(HF_REVISION, /^[0-9a-f]{40}$/);

  const entries = Object.values(QUANTS).flat();
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, entry.name);
    assert.ok(Number.isInteger(entry.size) && entry.size > 0, entry.name);
  }
});

test("fileUrl pins the Hugging Face revision", () => {
  const url = fileUrl("omnivoice-base-Q8_0.gguf");
  assert.ok(url.includes(`/resolve/${HF_REVISION}/`));
  assert.ok(url.endsWith("/omnivoice-base-Q8_0.gguf"));
});

test("planDownloads marks missing files as needed and rejects an unknown quant", () =>
  withTempDir(async (tempDir) => {
    const plan = await planDownloads(tempDir, "Q8_0");
    assert.deepEqual(
      plan.map((entry) => entry.name),
      QUANTS.Q8_0.map((entry) => entry.name)
    );
    for (const entry of plan) {
      assert.equal(entry.needed, true);
      assert.equal(entry.dest, path.join(tempDir, entry.name));
    }

    await assert.rejects(planDownloads(tempDir, "Q2_NOPE"), /Unknown quant/);
  }));

test("planEntries needs a file unless its size and sha256 both match", () =>
  withTempDir(async (tempDir) => {
    const bytes = Buffer.from("omnivoice fixture weights");
    const good = fixtureEntry("good.gguf", bytes);
    const wrongSize = { ...fixtureEntry("wrong-size.gguf", bytes), size: bytes.length + 1 };
    const wrongHash = { ...fixtureEntry("wrong-hash.gguf", bytes), sha256: "0".repeat(64) };
    for (const entry of [good, wrongSize, wrongHash]) {
      fs.writeFileSync(path.join(tempDir, entry.name), bytes);
    }

    const plan = await planEntries([good, wrongSize, wrongHash], tempDir);
    assert.deepEqual(
      plan.map((entry) => [entry.name, entry.needed]),
      [
        ["good.gguf", false],
        ["wrong-size.gguf", true],
        ["wrong-hash.gguf", true],
      ]
    );
  }));

test("downloadOne refuses bytes whose checksum does not match", () =>
  withTempDir(async (tempDir) => {
    const entry = fixtureEntry("refused.gguf", Buffer.from("expected bytes"));
    const dest = path.join(tempDir, entry.name);
    const downloadFileImpl = async (_url, partPath) => {
      fs.writeFileSync(partPath, "tampered bytes");
    };

    await assert.rejects(downloadOne(entry, tempDir, { downloadFileImpl }), (error) => {
      assert.match(error.message, /Checksum mismatch/);
      assert.ok(error.message.includes(entry.sha256));
      return true;
    });
    assert.equal(fs.existsSync(`${dest}.part`), false);
    assert.equal(fs.existsSync(dest), false);
  }));

test("downloadOne promotes verified bytes to the final name", () =>
  withTempDir(async (tempDir) => {
    const bytes = Buffer.from("expected bytes");
    const entry = fixtureEntry("accepted.gguf", bytes);
    const dest = path.join(tempDir, entry.name);
    const calls = [];
    const downloadFileImpl = async (url, partPath) => {
      calls.push([url, partPath]);
      fs.writeFileSync(partPath, bytes);
    };

    assert.equal(await downloadOne(entry, tempDir, { downloadFileImpl }), dest);
    assert.deepEqual(calls, [[fileUrl(entry.name), `${dest}.part`]]);
    assert.deepEqual(fs.readFileSync(dest), bytes);
    assert.equal(fs.existsSync(`${dest}.part`), false);
  }));

const FIXTURE = crypto.randomBytes(4096);

// Serves FIXTURE with Range support and records each request's range header.
// handler(req, res, ranges) may answer first by returning true.
async function withFixtureServer(handler, fn) {
  const ranges = [];
  const server = http.createServer((req, res) => {
    ranges.push(req.headers.range ?? null);
    if (handler && handler(req, res, ranges)) return;
    const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const start = match ? Number(match[1]) : 0;
    if (start >= FIXTURE.length) {
      res.writeHead(416).end();
      return;
    }
    const body = FIXTURE.subarray(start);
    const headers = { "Content-Length": body.length };
    if (match) headers["Content-Range"] = `bytes ${start}-${FIXTURE.length - 1}/${FIXTURE.length}`;
    res.writeHead(match ? 206 : 200, headers);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/weights.gguf`, ranges);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("downloadFile resumes from the bytes on disk", () =>
  withTempDir((tempDir) =>
    withFixtureServer(null, async (url, ranges) => {
      const dest = path.join(tempDir, "weights.gguf.part");
      fs.writeFileSync(dest, FIXTURE.subarray(0, 1000));

      await downloadFile(url, dest, 0, { resume: true });

      assert.deepEqual(ranges, ["bytes=1000-"]);
      assert.deepEqual(fs.readFileSync(dest), FIXTURE);
    })
  ));

test("downloadFile starts over when the server ignores the range", () =>
  withTempDir((tempDir) =>
    withFixtureServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Length": FIXTURE.length });
        res.end(FIXTURE);
        return true;
      },
      async (url, ranges) => {
        const dest = path.join(tempDir, "weights.gguf.part");
        fs.writeFileSync(dest, FIXTURE.subarray(0, 1000));

        await downloadFile(url, dest, 0, { resume: true });

        assert.deepEqual(ranges, ["bytes=1000-"]);
        assert.deepEqual(fs.readFileSync(dest), FIXTURE);
      }
    )
  ));

test("downloadFile takes a 416 on a resume as complete and writes nothing", () =>
  withTempDir((tempDir) =>
    withFixtureServer(null, async (url, ranges) => {
      const dest = path.join(tempDir, "weights.gguf.part");
      fs.writeFileSync(dest, FIXTURE);

      await downloadFile(url, dest, 0, { resume: true });

      assert.deepEqual(ranges, [`bytes=${FIXTURE.length}-`]);
      assert.deepEqual(fs.readFileSync(dest), FIXTURE);
    })
  ));

// Regression: the partial body used to be written from the start as if it
// were the whole file, so the checksum failed and the saved bytes were lost.
test("downloadFile asks again without a Range when a 206 starts at another offset", () =>
  withTempDir((tempDir) =>
    withFixtureServer(
      (req, res) => {
        if (!req.headers.range) return false;
        const body = FIXTURE.subarray(500);
        res.writeHead(206, {
          "Content-Length": body.length,
          "Content-Range": `bytes 500-${FIXTURE.length - 1}/${FIXTURE.length}`,
        });
        res.end(body);
        return true;
      },
      async (url, ranges) => {
        const dest = path.join(tempDir, "weights.gguf.part");
        fs.writeFileSync(dest, FIXTURE.subarray(0, 1000));

        await downloadFile(url, dest, 0, { resume: true });

        assert.deepEqual(ranges, ["bytes=1000-", null]);
        assert.deepEqual(fs.readFileSync(dest), FIXTURE);
      }
    )
  ));

test("downloadFile stops at maxBytes and does not retry", () =>
  withTempDir((tempDir) =>
    withFixtureServer(null, async (url, ranges) => {
      const dest = path.join(tempDir, "weights.gguf.part");

      await assert.rejects(downloadFile(url, dest, 0, { maxBytes: 1000 }), {
        message: "Download exceeded 1000 bytes",
      });

      assert.equal(ranges.length, 1);
    })
  ));

test("downloadFile with maxBytes 0 rejects a non-empty body", () =>
  withTempDir((tempDir) =>
    withFixtureServer(null, async (url) => {
      const dest = path.join(tempDir, "weights.gguf.part");

      await assert.rejects(downloadFile(url, dest, 0, { maxBytes: 0 }), {
        message: "Download exceeded 0 bytes",
      });
    })
  ));

test("downloadOne caps the download at the pinned size and removes .part when it trips", () =>
  withTempDir(async (tempDir) => {
    const entry = fixtureEntry("capped.gguf", FIXTURE);
    const partPath = path.join(tempDir, `${entry.name}.part`);
    let seenOptions = null;
    const downloadFileImpl = async (_url, part, _retry, options) => {
      seenOptions = options;
      fs.writeFileSync(part, Buffer.concat([FIXTURE, Buffer.from("extra")]));
      throw new Error(`Download exceeded ${entry.size} bytes`);
    };

    await assert.rejects(downloadOne(entry, tempDir, { downloadFileImpl }), /Download exceeded/);

    assert.equal(seenOptions.maxBytes, entry.size);
    assert.equal(fs.existsSync(partPath), false);
  }));

test("downloadFile keeps the Range across a redirect", () =>
  withTempDir((tempDir) =>
    withFixtureServer(
      (req, res) => {
        if (req.url !== "/weights.gguf") return false;
        res.writeHead(302, { Location: "/moved.gguf" }).end();
        return true;
      },
      async (url, ranges) => {
        const dest = path.join(tempDir, "weights.gguf.part");
        fs.writeFileSync(dest, FIXTURE.subarray(0, 1000));

        await downloadFile(url, dest, 0, { resume: true });

        assert.deepEqual(ranges, ["bytes=1000-", "bytes=1000-"]);
        assert.deepEqual(fs.readFileSync(dest), FIXTURE);
      }
    )
  ));

test("downloadFile without resume removes a stale destination when the attempt fails", () =>
  withTempDir((tempDir) =>
    withFixtureServer(
      (_req, res) => {
        res.writeHead(404).end();
        return true;
      },
      async (url) => {
        const dest = path.join(tempDir, "binary.zip");
        fs.writeFileSync(dest, "stale bytes");

        await assert.rejects(downloadFile(url, dest), /HTTP 404/);

        assert.equal(fs.existsSync(dest), false);
      }
    )
  ));

// Takes RETRY_DELAY (2 s) once: the helper's real retry path is the behaviour.
test("a connection cut mid-way is resumed on the retry", () =>
  withTempDir((tempDir) =>
    withFixtureServer(
      (_req, res, ranges) => {
        if (ranges.length > 1) return false;
        res.writeHead(200, { "Content-Length": FIXTURE.length });
        res.write(FIXTURE.subarray(0, 500), () => setTimeout(() => res.socket.destroy(), 50));
        return true;
      },
      async (url, ranges) => {
        const dest = path.join(tempDir, "weights.gguf.part");

        await downloadFile(url, dest, 0, { resume: true });

        assert.deepEqual(ranges, [null, "bytes=500-"]);
        assert.deepEqual(fs.readFileSync(dest), FIXTURE);
      }
    )
  ));

test("downloadOne keeps the .part file on a network failure and removes it on a checksum mismatch", () =>
  withTempDir(async (tempDir) => {
    const entry = fixtureEntry("partial.gguf", FIXTURE);
    const partPath = path.join(tempDir, `${entry.name}.part`);

    const cutOff = async (_url, part) => {
      fs.writeFileSync(part, FIXTURE.subarray(0, 100));
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    };
    await assert.rejects(downloadOne(entry, tempDir, { downloadFileImpl: cutOff }), {
      code: "ECONNRESET",
    });
    assert.deepEqual(fs.readFileSync(partPath), FIXTURE.subarray(0, 100));

    const wrongBytes = async (_url, part) => {
      fs.writeFileSync(part, "tampered bytes");
    };
    await assert.rejects(
      downloadOne(entry, tempDir, { downloadFileImpl: wrongBytes }),
      /Checksum mismatch/
    );
    assert.equal(fs.existsSync(partPath), false);
  }));

test("downloadOne removes a .part larger than the entry before downloading", () =>
  withTempDir(async (tempDir) => {
    const entry = fixtureEntry("oversize.gguf", FIXTURE);
    const partPath = path.join(tempDir, `${entry.name}.part`);
    fs.writeFileSync(partPath, Buffer.concat([FIXTURE, Buffer.from("extra")]));
    let seen = null;
    const downloadFileImpl = async (_url, part) => {
      seen = fs.existsSync(part) ? fs.statSync(part).size : 0;
      fs.writeFileSync(part, FIXTURE);
    };

    await downloadOne(entry, tempDir, { downloadFileImpl });

    assert.equal(seen, 0);
  }));

const MACHO = Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.from("sidecar bytes")]);

// The flags are only worth pinning if they reach cmake: assert the configure
// command main() runs, not just the helper that produces the flags.
test("buildCommands configures cmake with the static-link flags and builds one target", () => {
  const commands = buildCommands({
    cmake: "/opt/cmake",
    srcDir: "/src",
    buildDir: "/src/build",
    platform: "darwin",
    jobs: 4,
  });
  const configure = commands.find(([tool, args]) => tool === "/opt/cmake" && args[0] === "-S");
  assert.ok(configure, "configure command present");
  for (const flag of cmakeConfigureArgs("darwin")) {
    assert.ok(configure[1].includes(flag), flag);
  }
  const build = commands.find(([tool, args]) => tool === "/opt/cmake" && args[0] === "--build");
  assert.deepEqual(build[1].slice(build[1].indexOf("--target"), build[1].indexOf("--target") + 2), [
    "--target",
    "omnivoice-tts",
  ]);
  const fetch = commands.find(([, args]) => args.includes("fetch"));
  assert.ok(fetch[1].includes(OMNIVOICE_CPP_COMMIT), "clone is pinned to the commit");
});

test("installBinary leaves a verified binary, a stamp and no .part files", () =>
  withTempDir((tempDir) => {
    const built = path.join(tempDir, "built");
    const output = path.join(tempDir, "omnivoice-tts-darwin-arm64");
    fs.writeFileSync(built, MACHO);

    const sha256 = installBinary(built, output, "a".repeat(40));

    assert.deepEqual(fs.readFileSync(output), MACHO);
    assert.deepEqual(JSON.parse(fs.readFileSync(stampPathFor(output), "utf8")), {
      commit: "a".repeat(40),
      sha256,
    });
    assert.equal(sha256, crypto.createHash("sha256").update(MACHO).digest("hex"));
    assert.deepEqual(
      fs.readdirSync(tempDir).filter((name) => name.endsWith(".part")),
      []
    );
    assert.equal(isCurrentBuild(output, "a".repeat(40)), true);
  }));

// Regression: the skip used to trust any file with an executable magic, so a
// bumped pin kept the old binary and a copy cut short was never repaired.
test("isCurrentBuild rejects another commit, a truncated binary and a missing stamp", () =>
  withTempDir((tempDir) => {
    const built = path.join(tempDir, "built");
    const output = path.join(tempDir, "omnivoice-tts-darwin-arm64");
    fs.writeFileSync(built, MACHO);
    installBinary(built, output, "a".repeat(40));

    assert.equal(isCurrentBuild(output, "b".repeat(40)), false, "pin moved");

    fs.writeFileSync(output, MACHO.subarray(0, 8));
    assert.equal(isUsableBinary(output), true, "truncated file still has the magic");
    assert.equal(isCurrentBuild(output, "a".repeat(40)), false, "truncated binary");

    fs.writeFileSync(output, MACHO);
    assert.equal(isCurrentBuild(output, "a".repeat(40)), true);
    fs.rmSync(stampPathFor(output));
    assert.equal(isCurrentBuild(output, "a".repeat(40)), false, "no stamp");

    fs.writeFileSync(stampPathFor(output), "not json");
    assert.equal(isCurrentBuild(output, "a".repeat(40)), false, "corrupt stamp");
  }));

test("installBinary drops the old stamp before it touches the binary", () =>
  withTempDir((tempDir) => {
    const built = path.join(tempDir, "built");
    const output = path.join(tempDir, "omnivoice-tts-darwin-arm64");
    fs.writeFileSync(built, MACHO);
    installBinary(built, output, "a".repeat(40));

    // A reinstall that fails at the copy must not leave the previous stamp
    // vouching for whatever is under the final name.
    assert.throws(() => installBinary(path.join(tempDir, "missing"), output, "b".repeat(40)));
    assert.equal(fs.existsSync(stampPathFor(output)), false);
    assert.equal(isCurrentBuild(output, "a".repeat(40)), false);
  }));

const lockPathIn = (tempDir) => path.join(tempDir, ".omnivoice-cpp-build.lock");

const staleMessage = (lockPath) =>
  `A stale omnivoice.cpp build lock remains at ${lockPath}. No build is running; remove that file and run again.`;

test("a free build lock path is taken and holds the pid", () =>
  withTempDir((tempDir) => {
    const lockPath = lockPathIn(tempDir);

    acquireBuildLock(lockPath, { pid: 111, isAlive: () => true });

    assert.equal(fs.readFileSync(lockPath, "utf8"), "111");
  }));

test("a build lock whose pid lives refuses the run and is left unchanged", () =>
  withTempDir((tempDir) => {
    const lockPath = lockPathIn(tempDir);
    fs.writeFileSync(lockPath, "111");

    assert.throws(() => acquireBuildLock(lockPath, { pid: 222, isAlive: () => true }), {
      message: "Another omnivoice.cpp build is running (pid 111)",
    });

    assert.equal(fs.readFileSync(lockPath, "utf8"), "111");
  }));

test("a build lock whose pid is dead is reported as stale, by path, and not replaced", () =>
  withTempDir((tempDir) => {
    const lockPath = lockPathIn(tempDir);
    fs.writeFileSync(lockPath, "999");

    assert.throws(() => acquireBuildLock(lockPath, { pid: 222, isAlive: () => false }), {
      message: staleMessage(lockPath),
    });

    assert.equal(fs.readFileSync(lockPath, "utf8"), "999");
    assert.deepEqual(fs.readdirSync(tempDir), [".omnivoice-cpp-build.lock"]);
  }));

test("a build lock holding this run's own pid, or nothing, is reported as stale", () =>
  withTempDir((tempDir) => {
    const lockPath = lockPathIn(tempDir);

    // Every pid is alive here, so only the own-pid and empty rules make these stale.
    for (const content of ["222", ""]) {
      fs.writeFileSync(lockPath, content);
      assert.throws(() => acquireBuildLock(lockPath, { pid: 222, isAlive: () => true }), {
        message: staleMessage(lockPath),
      });
      assert.equal(fs.readFileSync(lockPath, "utf8"), content);
    }
  }));

test("releaseBuildLock removes the holder's lock and leaves another pid's in place", () =>
  withTempDir((tempDir) => {
    const lockPath = lockPathIn(tempDir);
    fs.writeFileSync(lockPath, "111");

    releaseBuildLock(lockPath, { pid: 222 });
    assert.equal(fs.readFileSync(lockPath, "utf8"), "111");

    releaseBuildLock(lockPath, { pid: 111 });
    assert.equal(fs.existsSync(lockPath), false);
  }));

test("argValue refuses a flag with no value instead of swallowing the next flag", () => {
  assert.equal(argValue(["node", "x"], "--quant", "Q8_0"), "Q8_0");
  assert.equal(argValue(["node", "x", "--quant", "Q4_K_M"], "--quant", "Q8_0"), "Q4_K_M");
  assert.throws(
    () => argValue(["node", "x", "--output-dir", "--quant", "Q4_K_M"], "--output-dir", "d"),
    {
      message: "--output-dir needs a value",
    }
  );
  assert.throws(() => argValue(["node", "x", "--output-dir"], "--output-dir", "d"), {
    message: "--output-dir needs a value",
  });
});
