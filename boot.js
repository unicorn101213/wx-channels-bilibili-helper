const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const root = __dirname;

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

(async () => {
  if (!(await portOpen(2025))) {
    spawn(process.execPath, [path.join(root, "simple-ui.js")], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }).unref();
  }
  if (!(await portOpen(2022))) {
    spawn(path.join(root, "wx_video_download.exe"), [], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }).unref();
  }
})();
