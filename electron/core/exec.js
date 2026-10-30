'use strict';
const { spawn } = require('node:child_process');
const os = require('node:os');

const IS_WIN = process.platform === 'win32';
const MAX_OUTPUT = 30000;

/**
 * 执行一条系统命令。
 * Windows 用 PowerShell（-NoProfile），其他平台用 /bin/sh。
 */
function run({ command, cwd, timeout = 120000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    if (!command || typeof command !== 'string') return reject(new Error('命令不能为空'));

    const workdir = cwd || os.homedir();
    const child = IS_WIN
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        cwd: workdir,
        windowsHide: true,
        env: { ...process.env, ...env },
      })
      : spawn('/bin/sh', ['-c', command], {
        cwd: workdir,
        env: { ...process.env, ...env },
      });

    let out = '';
    let err = '';
    let killed = false;

    const append = (buf, isErr) => {
      const s = buf.toString('utf8');
      if (isErr) err += s; else out += s;
      if (out.length + err.length > MAX_OUTPUT * 2) {
        if (!killed) { killed = true; child.kill(); }
      }
    };

    child.stdout.on('data', (b) => append(b, false));
    child.stderr.on('data', (b) => append(b, true));

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill(); } catch { /* ignore */ }
    }, Math.max(1000, Math.min(600000, Number(timeout) || 120000)));

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('启动命令失败：' + e.message));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: true,
        exitCode: code,
        timedOut: killed && code !== 0,
        cwd: workdir,
        stdout: out.slice(0, MAX_OUTPUT),
        stderr: err.slice(0, MAX_OUTPUT),
      });
    });
  });
}

module.exports = { run, IS_WIN };
