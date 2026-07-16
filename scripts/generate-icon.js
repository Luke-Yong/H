const sharp = require("sharp");
const toIco = require("to-ico");
const fs = require("fs");
const path = require("path");

const svgPath = path.join(__dirname, "..", "build", "deepseek-color.svg");
const icoPath = path.join(__dirname, "..", "build", "icon.ico");
const pngPath = path.join(__dirname, "..", "build", "icon.png");

async function generate() {
  if (!fs.existsSync(svgPath)) {
    console.error(`SVG not found: ${svgPath}`);
    process.exit(1);
  }

  const svgBuffer = fs.readFileSync(svgPath);

  // Generate standalone 1024x1024 PNG (electron-builder auto-converts to ICO for Windows)
  const png1024 = await sharp(svgBuffer).resize(1024, 1024).png().toBuffer();
  fs.writeFileSync(pngPath, png1024);
  console.log(`Generated ${pngPath} (1024x1024)`);

  // Generate multi-size ICO for BrowserWindow runtime icon (dev mode taskbar/dock)
  const sizes = [16, 24, 32, 48, 64, 256];
  const pngs = await Promise.all(
    sizes.map((size) =>
      sharp(svgBuffer).resize(size, size).png().toBuffer()
    )
  );

  // to-ico for small sizes, manually append 256x256 as PNG-compressed (required by Windows)
  const smallPngs = pngs.slice(0, -1);
  const png256 = pngs[pngs.length - 1];

  const baseIco = await toIco(smallPngs);

  const ICO_HEADER_SIZE = 6;
  const ICO_DIR_SIZE = 16;
  const numSmall = smallPngs.length;
  const numTotal = sizes.length;

  const smallEntries = [];
  for (let i = 0; i < numSmall; i++) {
    const entryOff = ICO_HEADER_SIZE + i * ICO_DIR_SIZE;
    smallEntries.push({
      width: baseIco.readUInt8(entryOff),
      height: baseIco.readUInt8(entryOff + 1),
      bpp: baseIco.readUInt16LE(entryOff + 6),
      size: baseIco.readUInt32LE(entryOff + 8),
      offset: baseIco.readUInt32LE(entryOff + 12),
    });
  }

  const header = Buffer.alloc(ICO_HEADER_SIZE);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(numTotal, 4);

  const dirSize = numTotal * ICO_DIR_SIZE;
  let dataOffset = ICO_HEADER_SIZE + dirSize;
  const dirBuffer = Buffer.alloc(dirSize);

  for (let i = 0; i < numSmall; i++) {
    const e = smallEntries[i];
    const off = i * ICO_DIR_SIZE;
    dirBuffer.writeUInt8(e.width, off);
    dirBuffer.writeUInt8(e.height, off + 1);
    dirBuffer.writeUInt8(0, off + 2);
    dirBuffer.writeUInt8(0, off + 3);
    dirBuffer.writeUInt16LE(e.bpp, off + 4);
    dirBuffer.writeUInt16LE(e.bpp, off + 6);
    dirBuffer.writeUInt32LE(e.size, off + 8);
    dirBuffer.writeUInt32LE(dataOffset, off + 12);
    dataOffset += e.size;
  }

  // 256x256 PNG entry
  {
    const off = numSmall * ICO_DIR_SIZE;
    dirBuffer.writeUInt8(0, off);
    dirBuffer.writeUInt8(0, off + 1);
    dirBuffer.writeUInt8(0, off + 2);
    dirBuffer.writeUInt8(0, off + 3);
    dirBuffer.writeUInt16LE(1, off + 4);
    dirBuffer.writeUInt16LE(32, off + 6);
    dirBuffer.writeUInt32LE(png256.length, off + 8);
    dirBuffer.writeUInt32LE(dataOffset, off + 12);
  }

  const imageParts = [];
  for (let i = 0; i < numSmall; i++) {
    const e = smallEntries[i];
    imageParts.push(baseIco.subarray(e.offset, e.offset + e.size));
  }
  imageParts.push(png256);

  const finalIco = Buffer.concat([header, dirBuffer, ...imageParts]);
  fs.writeFileSync(icoPath, finalIco);
  console.log(`Generated ${icoPath} with sizes: ${sizes.join(", ")} (${finalIco.length} bytes)`);
}

generate().catch((err) => {
  console.error("Icon generation failed:", err);
  process.exit(1);
});
