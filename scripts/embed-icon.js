const { rcedit } = require("rcedit");
const path = require("path");
const fs = require("fs");

async function main() {
  const exePath = path.join(__dirname, "..", "dist", "win-unpacked", "H.exe");
  const icoPath = path.join(__dirname, "..", "build", "icon.ico");

  if (!fs.existsSync(exePath)) {
    console.error(`EXE not found: ${exePath}`);
    process.exit(1);
  }
  if (!fs.existsSync(icoPath)) {
    console.error(`ICO not found: ${icoPath}`);
    process.exit(1);
  }

  await rcedit(exePath, { icon: icoPath });
  console.log("Icon embedded into", exePath);
}

main().catch((err) => {
  console.error("Icon embedding failed:", err);
  process.exit(1);
});
