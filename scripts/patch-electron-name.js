const { rcedit } = require("rcedit");
const path = require("path");
const fs = require("fs");

async function main() {
  if (process.platform !== "win32") {
    console.log("Skip: electron.exe name patching only applies on Windows");
    return;
  }

  let electronExe;
  try {
    const electronPkgPath = require.resolve("electron/package.json");
    const electronDir = path.dirname(electronPkgPath);
    const electronPkg = JSON.parse(fs.readFileSync(electronPkgPath, "utf8"));
    electronExe = path.join(electronDir, "dist", electronPkg.executableFilename || "electron.exe");
  } catch (err) {
    console.warn("Could not locate electron.exe — skipping name patch:", err.message);
    return;
  }

  if (!fs.existsSync(electronExe)) {
    console.warn("electron.exe not found at", electronExe, "— skipping name patch");
    return;
  }

  const stampFile = path.join(path.dirname(electronExe), ".h-name-patched");
  let alreadyPatched = false;
  try {
    if (fs.existsSync(stampFile)) {
      const stamp = JSON.parse(fs.readFileSync(stampFile, "utf8"));
      if (stamp.version === "1") alreadyPatched = true;
    }
  } catch {}

  if (alreadyPatched) {
    console.log("electron.exe already patched with H name — skipping");
    return;
  }

  console.log("Patching electron.exe version strings so Task Manager shows 'H' instead of 'Electron'...");
  try {
    await rcedit(electronExe, {
      "version-string": {
        FileDescription: "H",
        ProductName: "H",
        CompanyName: "H",
        InternalName: "H",
        OriginalFilename: "H.exe",
      },
    });
    fs.writeFileSync(stampFile, JSON.stringify({ version: "1", at: Date.now() }), "utf8");
    console.log("Patched:", electronExe);
  } catch (err) {
    console.warn("Warning: failed to patch electron.exe (dev processes may still show as 'Electron'):", err.message);
  }
}

main().catch((err) => {
  console.warn("patch-electron-name failed:", err);
});
