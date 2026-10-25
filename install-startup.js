const fs = require("fs");
const path = require("path");

const startupDir = path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const target = path.join(startupDir, "视频号B站抖音下载-开机启动.vbs");
const old = path.join(startupDir, "视频下载台开机启动.vbs");
const node = "C:\\Program Files\\nodejs\\node.exe";
const boot = path.join(__dirname, "boot.js");
const body = [
  "Set sh = CreateObject(\"Wscript.Shell\")",
  `sh.Run """${node}"" ""${boot}""", 0, False`,
  ""
].join("\r\n");

fs.writeFileSync(target, body);
if (old !== target && fs.existsSync(old)) fs.unlinkSync(old);
console.log("开机启动已写入：" + target);
