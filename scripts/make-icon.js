'use strict';
/**
 * 用 Electron 自己把 SVG 渲染成 512×512 的 PNG 图标。
 * 用法：electron scripts/make-icon.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'build', 'icon.png');

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#8b9bff"/>
      <stop offset="52%" stop-color="#22d3ee"/>
      <stop offset="100%" stop-color="#a78bfa"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="18%" r="70%">
      <stop offset="0%" stop-color="#4c5bff" stop-opacity=".45"/>
      <stop offset="100%" stop-color="#4c5bff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="8" y="8" width="496" height="496" rx="118" fill="#0b0d12"/>
  <rect x="8" y="8" width="496" height="496" rx="118" fill="url(#glow)"/>
  <rect x="8" y="8" width="496" height="496" rx="118" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="3"/>
  <path d="M158 354V176c0-10 12-14 19-7l79 86 79-86c7-7 19-3 19 7v178"
        fill="none" stroke="url(#g)" stroke-width="46" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="256" cy="404" r="9" fill="#22d3ee" opacity=".9"/>
</svg>`;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:512px;height:512px;background:transparent;overflow:hidden}
svg{display:block}
</style></head><body>${SVG}</body></html>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  await new Promise((r) => setTimeout(r, 700));
  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, img.toPNG());
  console.log('ICON_OK:' + OUT);
  app.exit(0);
});
