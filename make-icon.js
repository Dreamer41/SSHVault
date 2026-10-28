// One-off: renders build/icon.png (run with `npx electron make-icon.js`)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 512, height: 512, webPreferences: { offscreen: true } });
  const html = `<body style="margin:0;background:transparent"><svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <rect x="16" y="16" width="480" height="480" rx="96" fill="#14161a"/>
    <rect x="16" y="16" width="480" height="480" rx="96" fill="none" stroke="#4c8dff" stroke-width="16"/>
    <path d="M130 170 L250 256 L130 342" fill="none" stroke="#4c8dff" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="280" y="324" width="110" height="36" rx="8" fill="#e6e6e6"/></svg></body>`;
  await win.loadURL('data:text/html,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'build', 'icon.png'), img.toPNG());
  app.quit();
});
