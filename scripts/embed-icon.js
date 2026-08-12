const { rcedit } = require("rcedit");
const path = require("path");
const fs = require("fs");

const H_VERSION = require(path.join(__dirname, "..", "package.json")).version;

function collectExes(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      collectExes(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) {
      out.push(full);
    }
  }
  return out;
}

async function patchExe(exePath, opts) {
  if (!fs.existsSync(exePath)) return;
  console.log("  patching:", path.basename(exePath));
  await rcedit(exePath, opts);
}

async function main() {
  const unpackedDir = path.join(__dirname, "..", "dist", "win-unpacked");
  const distDir = path.join(__dirname, "..", "dist");
  const icoPath = path.join(__dirname, "..", "build", "icon.ico");

  if (!fs.existsSync(unpackedDir)) {
    console.error("win-unpacked not found:", unpackedDir);
    process.exit(1);
  }
  if (!fs.existsSync(icoPath)) {
    console.error("ICO not found:", icoPath);
    process.exit(1);
  }

  const exeOpts = (baseName) => ({
    icon: icoPath,
    "version-string": {
      FileDescription: "H",
      ProductName: "H",
      CompanyName: "H",
      InternalName: baseName,
      OriginalFilename: baseName,
      LegalCopyright: "Copyright \u00A9 2026 H",
      LegalTrademarks: "",
      Comments: "H - AI coding agent",
    },
    "file-version": H_VERSION,
    "product-version": H_VERSION,
  });

  console.log("Patching executables in", unpackedDir);
  for (const exe of collectExes(unpackedDir)) {
    await patchExe(exe, exeOpts(path.basename(exe)));
  }

  console.log("Done. All EXEs in win-unpacked patched with H name/version strings.");
}

main().catch((err) => {
  console.error("embed-icon/version patch failed:", err);
  process.exit(1);
});
