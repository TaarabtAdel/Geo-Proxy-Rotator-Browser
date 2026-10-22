const { execFile } = require('node:child_process');

// Lệnh tắt máy của hệ điều hành, không cần quyền admin.
// macOS: lần đầu hệ thống hỏi cho phép app điều khiển "System Events" (Cài đặt hệ thống → Quyền riêng tư → Tự động hoá).
function shutdownCommand(platform = process.platform) {
  if (platform === 'win32') return ['shutdown', ['/s', '/t', '0']];
  if (platform === 'darwin') return ['osascript', ['-e', 'tell application "System Events" to shut down']];
  if (platform === 'linux') return ['systemctl', ['poweroff']];
  throw Error(`Chưa hỗ trợ tắt máy trên ${platform}.`);
}

function runShutdown({ platform = process.platform, exec = execFile } = {}) {
  const [cmd, args] = shutdownCommand(platform);
  return new Promise((resolve, reject) => {
    exec(cmd, args, { timeout: 30000 }, (err, _stdout, stderr) => {
      if (err) reject(Error(String(stderr || err.message).trim().slice(0, 160)));
      else resolve();
    });
  });
}

module.exports = { shutdownCommand, runShutdown };
