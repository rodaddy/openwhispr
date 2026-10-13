#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { downloadFile } = require("./lib/download-utils");

const HF_REPO = "Serveurperso/OmniVoice-GGUF";
const HF_REVISION = "017094167b5c9ed565a5076ac9b3b93c5ecf5c73";
const DEFAULT_QUANT = "Q8_0";
const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), ".cache", "openwhispr", "omnivoice-models");

const QUANTS = {
  Q8_0: [
    {
      name: "omnivoice-base-Q8_0.gguf",
      size: 656395008,
      sha256: "2882d887921798aea13d45236556bdf8012842ab6f8cd2690943eead6289f298",
    },
    {
      name: "omnivoice-tokenizer-Q8_0.gguf",
      size: 288889600,
      sha256: "75204fa566a8e30984e7a1066da6557184c9fd099c8f1bc0cb5b9415edfec255",
    },
  ],
  Q4_K_M: [
    {
      name: "omnivoice-base-Q4_K_M.gguf",
      size: 407485216,
      sha256: "4836ba5affcb83c04d08b3e96b6e48ac839947ee3864188739807b68e0e159c6",
    },
    {
      name: "omnivoice-tokenizer-Q4_K_M.gguf",
      size: 252474112,
      sha256: "988fc32bc699bce361c44e9af8383be9811960441f293eb5ab4ec6bf6386378d",
    },
  ],
};

function fileUrl(name) {
  return `https://huggingface.co/${HF_REPO}/resolve/${HF_REVISION}/${name}`;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(filePath)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function isVerified(entry, filePath) {
  if (!fs.existsSync(filePath)) return false;
  if (fs.statSync(filePath).size !== entry.size) return false;
  return (await sha256File(filePath)) === entry.sha256;
}

async function planEntries(entries, outputDir) {
  const plan = [];
  for (const entry of entries) {
    const dest = path.join(outputDir, entry.name);
    plan.push({ ...entry, dest, needed: !(await isVerified(entry, dest)) });
  }
  return plan;
}

async function planDownloads(outputDir, quant) {
  const entries = Object.hasOwn(QUANTS, quant) ? QUANTS[quant] : null;
  if (!entries) {
    throw new Error(
      `Unknown quant "${quant}" (expected one of: ${Object.keys(QUANTS).join(", ")})`
    );
  }
  return planEntries(entries, outputDir);
}

// Bytes land in <dest>.part and are renamed only after the checksum matches,
// so the final name never holds unverified bytes. A network failure keeps the
// .part file so the next run resumes it; a checksum mismatch, or a body larger
// than the pinned size, removes it.
async function downloadOne(entry, outputDir, { downloadFileImpl = downloadFile } = {}) {
  const dest = path.join(outputDir, entry.name);
  const partPath = `${dest}.part`;

  if (fs.existsSync(partPath)) {
    const partSize = fs.statSync(partPath).size;
    if (partSize > entry.size) {
      fs.rmSync(partPath, { force: true });
    } else if (partSize > 0) {
      console.log(`  ${entry.name}: resuming from ${Math.round(partSize / 1024 / 1024)}MB`);
    }
  }

  try {
    await downloadFileImpl(fileUrl(entry.name), partPath, 0, {
      resume: true,
      maxBytes: entry.size,
    });
  } catch (error) {
    if (String(error.message).startsWith("Download exceeded")) {
      fs.rmSync(partPath, { force: true });
    }
    throw error;
  }
  const actual = await sha256File(partPath);
  if (actual !== entry.sha256) {
    fs.rmSync(partPath, { force: true });
    throw new Error(`Checksum mismatch for ${entry.name}: expected ${entry.sha256}, got ${actual}`);
  }

  fs.renameSync(partPath, dest);
  return dest;
}

function printUsage() {
  console.log(`Usage: node scripts/download-omnivoice-gguf.js [options]

Downloads the OmniVoice GGUF weights from ${HF_REPO}
at pinned revision ${HF_REVISION}, verifying each file's SHA-256.

Options:
  --quant <${Object.keys(QUANTS).join("|")}>   Quantization to download (default: ${DEFAULT_QUANT})
  --output-dir <dir>       Destination directory
                           (default: ${DEFAULT_OUTPUT_DIR})
  --help                   Show this help`);
}

// A flag given without a value (end of argv, or followed by another flag) is
// an error, not a directory literally named "--quant".
function argValue(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

async function main() {
  if (process.argv.includes("--help")) {
    printUsage();
    return 0;
  }

  console.log("Note: OmniVoice pretrained weights are CC-BY-NC 4.0 (non-commercial).");

  try {
    const quant = argValue(process.argv, "--quant", DEFAULT_QUANT);
    const outputDir = path.resolve(argValue(process.argv, "--output-dir", DEFAULT_OUTPUT_DIR));
    console.log(`\n[omnivoice-gguf] ${quant} -> ${outputDir}\n`);

    fs.mkdirSync(outputDir, { recursive: true });
    const plan = await planDownloads(outputDir, quant);

    for (const entry of plan) {
      if (!entry.needed) {
        console.log(`  ${entry.name}: already downloaded and verified, skipping`);
        continue;
      }
      const sizeMb = Math.round(entry.size / 1024 / 1024);
      console.log(`  ${entry.name}: downloading (${sizeMb}MB) from ${fileUrl(entry.name)}`);
      await downloadOne(entry, outputDir);
      console.log(`  ${entry.name}: verified`);
    }
  } catch (error) {
    console.error(`\n[omnivoice-gguf] Failed: ${error.message}`);
    return 1;
  }

  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

module.exports = {
  DEFAULT_OUTPUT_DIR,
  DEFAULT_QUANT,
  HF_REPO,
  HF_REVISION,
  QUANTS,
  argValue,
  downloadOne,
  fileUrl,
  planDownloads,
  planEntries,
  sha256File,
};
