const sharp = require("sharp");
const toIco = require("to-ico");
const fs = require("fs");
const path = require("path");

const sizes = [16, 32, 48, 256];
const svgPath = path.join(__dirname, "..", "build", "deepseek-color.svg");
const icoPath = path.join(__dirname, "..", "build", "icon.ico");

async function generate() {
  if (!fs.existsSync(svgPath)) {
    console.error(`SVG not found: ${svgPath}`);
    process.exit(1);
  }

  const svgBuffer = fs.readFileSync(svgPath);

  const pngs = await Promise.all(
    sizes.map((size) =>
      sharp(svgBuffer).resize(size, size).png().toBuffer()
    )
  );

  const ico = await toIco(pngs);
  fs.writeFileSync(icoPath, ico);
  console.log(`Generated ${icoPath} with sizes: ${sizes.join(", ")}`);
}

generate().catch((err) => {
  console.error("Icon generation failed:", err);
  process.exit(1);
});
