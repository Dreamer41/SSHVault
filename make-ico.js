// One-off: wraps build/icon.png (resized to 256px) into build/icon.ico (`npx electron make-ico.js`)
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
  const png = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 256, height: 256 }).toPNG();
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(1, 4); // one image
  head.writeUInt8(0, 6); // width 256 is stored as 0
  head.writeUInt8(0, 7); // height 256 is stored as 0
  head.writeUInt16LE(1, 10); // planes
  head.writeUInt16LE(32, 12); // bits per pixel
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18); // image data offset
  fs.writeFileSync(path.join(__dirname, 'build', 'icon.ico'), Buffer.concat([head, png]));
  app.quit();
});
