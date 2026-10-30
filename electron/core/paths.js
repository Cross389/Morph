'use strict';
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

/** 所有"用户层"文件都住在这里：%APPDATA%\Morph */
function root() {
  return app.getPath('userData');
}
const p = (...s) => path.join(root(), ...s);

const PATHS = {
  get root() { return root(); },
  get ui() { return p('ui'); },
  get shell() { return p('shell'); },
  get data() { return p('data'); },
  get notes() { return p('notes'); },
  get assets() { return p('assets'); },
  get snapshots() { return p('snapshots'); },
  /** 锁定的出厂基线：AI 永远读写不到，只有外壳面板能更新它 */
  get master() { return p('master'); },
  get settings() { return p('settings.json'); },
  get template() { return path.join(app.getAppPath(), 'template'); },
  get renderer() { return path.join(app.getAppPath(), 'renderer'); },
  get bridgeScript() { return path.join(app.getAppPath(), 'electron', 'bridge', 'iframe.js'); },
};

function ensureDirs() {
  for (const d of [PATHS.root, PATHS.ui, PATHS.shell, PATHS.data, PATHS.notes, PATHS.assets, PATHS.snapshots]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

module.exports = { PATHS, ensureDirs };
