'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { PATHS } = require('./paths');
const fsx = require('./fsx');

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

const masterUi = () => path.join(PATHS.master, 'ui');
const masterShell = () => path.join(PATHS.master, 'shell');

/** 用程序内置模板建立「出厂基线」 */
async function buildMasterFromTemplate() {
  await fsp.rm(PATHS.master, { recursive: true, force: true });
  await fsp.mkdir(PATHS.master, { recursive: true });
  await fsx.copyDir(path.join(PATHS.template, 'ui'), masterUi());
  await fsp.mkdir(masterShell(), { recursive: true });
  return { built: true };
}

/**
 * 把当前界面固定成新的出厂基线。
 * 只有外壳面板能触发；AI 的文件工具被 fsx 明确禁止访问 master/。
 */
async function captureMasterFromCurrent() {
  const tmp = path.join(PATHS.root, `.master-tmp-${Date.now()}`);
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsx.copyDir(PATHS.ui, path.join(tmp, 'ui'));
  await fsp.mkdir(path.join(tmp, 'shell'), { recursive: true });
  if (fs.existsSync(PATHS.shell)) await fsx.copyDir(PATHS.shell, path.join(tmp, 'shell'));
  await fsp.rm(PATHS.master, { recursive: true, force: true });
  await fsp.rename(tmp, PATHS.master);
  return { locked: true };
}

/** 把界面恢复成出厂基线 */
async function applyMaster() {
  if (!(await exists(path.join(masterUi(), 'index.html')))) {
    await buildMasterFromTemplate();
  }
  await fsp.rm(PATHS.ui, { recursive: true, force: true });
  await fsp.mkdir(PATHS.ui, { recursive: true });
  await fsx.copyDir(masterUi(), PATHS.ui);

  if (await exists(masterShell())) {
    await fsp.rm(PATHS.shell, { recursive: true, force: true });
    await fsp.mkdir(PATHS.shell, { recursive: true });
    await fsx.copyDir(masterShell(), PATHS.shell);
  }
  return { applied: true };
}

async function seed({ resetUi = false } = {}) {
  // 1) 出厂基线：没有就用内置模板建一份。建好之后程序不会再去动它。
  if (!(await exists(path.join(masterUi(), 'index.html')))) {
    await buildMasterFromTemplate();
  }

  // 2) 当前界面：缺失或要求重置时，从基线恢复
  if (resetUi || !(await exists(path.join(PATHS.ui, 'index.html')))) {
    await applyMaster();
  }

  // 3) 文档 / 笔记 / 数据
  const docsDir = path.join(PATHS.root, 'docs');
  await fsp.mkdir(docsDir, { recursive: true });
  if (!(await exists(path.join(docsDir, 'BRIDGE.md')))) {
    await fsp.copyFile(path.join(PATHS.template, 'docs', 'BRIDGE.md'), path.join(docsDir, 'BRIDGE.md'));
  }
  if (!(await exists(path.join(PATHS.notes, 'PROJECT.md')))) {
    await fsp.copyFile(path.join(PATHS.template, 'notes', 'PROJECT.md'), path.join(PATHS.notes, 'PROJECT.md'));
  }
  if (!(await exists(path.join(PATHS.data, 'kv.json')))) {
    await fsp.writeFile(path.join(PATHS.data, 'kv.json'), '{}', 'utf8');
  }

  return { seeded: resetUi };
}

module.exports = { seed, applyMaster, captureMasterFromCurrent, buildMasterFromTemplate };
