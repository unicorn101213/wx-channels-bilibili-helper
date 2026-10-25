const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const PORT = 2025;
const DOWNLOAD_DIR = path.join(os.homedir(), "Downloads");
const LOCAL_API = "http://127.0.0.1:2022";

const tasks = new Map();

function sanitizeFilename(name) {
  return String(name || "video")
    .replace(/[<>:"|?*\/\n\r\\]/g, "_")
    .trim()
    .slice(0, 80) || "video";
}

function extractUrlAndPlatform(rawText) {
  const text = String(rawText || "").trim();
  const b23 = text.match(/https?:\/\/b23\.tv\/[0-9A-Za-z_-]+/i);
  const bili = text.match(/https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i);
  const bvOnly = text.match(/\b(BV[0-9A-Za-z]{10})\b/);
  if (b23 || bili || bvOnly) {
    const bvid = bili?.[1]?.startsWith("BV") ? bili[1] : (bvOnly ? bvOnly[1] : "");
    const url = b23 ? b23[0] : (bili ? bili[0] : `https://www.bilibili.com/video/${bvid}`);
    return { platform: "bilibili", url, bvid };
  }

  const dy = text.match(/https?:\/\/(?:v\.douyin\.com\/[0-9A-Za-z_-]+\/?|(?:www\.)?(?:douyin|iesdouyin)\.com\/(?:video|share\/video|note|share\/note|slides|share\/slides)\/\d+)/i);
  if (dy) {
    return { platform: "douyin", url: dy[0], isNoteHint: text.includes("图文作品") };
  }

  const anyUrl = text.match(/https?:\/\/[^\s"<>]+/i);
  if (anyUrl) {
    return { platform: "unknown", url: anyUrl[0] };
  }
  return null;
}

async function resolveBilibili(info) {
  let bvid = info.bvid || "";
  let aid = "";
  if (!bvid && info.url) {
    const bvInUrl = info.url.match(/(BV[0-9A-Za-z]{10})/);
    if (bvInUrl) {
      bvid = bvInUrl[1];
    } else {
      const r = await fetch(info.url, { redirect: "follow" });
      const finalUrl = r.url || info.url;
      bvid = finalUrl.match(/(BV[0-9A-Za-z]{10})/)?.[1] || "";
      aid = finalUrl.match(/av(\d+)|aid=(\d+)/i)?.[1] || "";
    }
  }
  if (!bvid && !aid) {
    throw new Error("未能从输入内容中识别出 B 站 BV 号");
  }
  const q = bvid ? `bvid=${bvid}` : `aid=${aid}`;
  const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?${q}`);
  const viewJson = await viewRes.json();
  if (viewJson.code !== 0 || !viewJson.data) {
    throw new Error(viewJson.message || "获取 B 站视频详情失败");
  }
  const title = viewJson.data.title || bvid;
  const cid = viewJson.data.cid || viewJson.data.pages?.[0]?.cid;
  const playRes = await fetch(
    `https://api.bilibili.com/x/player/playurl?${q}&cid=${cid}&qn=80&fnval=1&platform=html5&high_quality=1`
  );
  const playJson = await playRes.json();
  const mp4Url = playJson?.data?.durl?.[0]?.url;
  if (!mp4Url) {
    throw new Error("未获取到 B 站 MP4 直链");
  }
  return {
    kind: "video",
    platform: "B站",
    title,
    mp4Url,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
      "Referer": "https://www.bilibili.com/"
    }
  };
}

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DOUYIN_PROFILE = path.join(os.homedir(), ".cache", "chrome-devtools-mcp", "chrome-profile");
const CHROME_PORT = 9226;
let chromeReady = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureNoteChrome() {
  try {
    const alive = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`);
    if (alive.ok) return;
  } catch (e) {}
  if (!chromeReady) {
    chromeReady = (async () => {
      const child = spawn(CHROME, [
        "--headless=new",
        `--remote-debugging-port=${CHROME_PORT}`,
        `--user-data-dir=${DOUYIN_PROFILE}`,
        "--no-first-run",
        "--disable-extensions",
        "--disable-gpu",
        "about:blank"
      ], { stdio: "ignore", detached: true });
      child.unref();
      for (let i = 0; i < 30; i++) {
        await sleep(300);
        try {
          const res = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`);
          if (res.ok) return;
        } catch (e) {}
      }
      throw new Error("图文解析没有启动。请先关掉占用抖音登录的窗口，再粘贴一次。");
    })().catch((err) => {
      chromeReady = null;
      throw err;
    });
  }
  return chromeReady;
}

function cdp(ws, method, params) {
  const id = cdp.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("图文页面响应超时")), 20000);
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      if (msg.error) reject(new Error(msg.error.message || "图文页面调用失败"));
      else resolve(msg.result || {});
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
cdp.nextId = 1;

async function scrapeDouyinNote(awemeId) {
  await ensureNoteChrome();
  const created = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  try {
    await cdp(ws, "Page.enable", {});
    await cdp(ws, "Page.navigate", { url: `https://www.douyin.com/note/${awemeId}` });
    const expression = `(() => {
      const imgs = [...document.querySelectorAll("img")].map((img) => img.currentSrc || img.src);
      const images = [];
      const seen = new Set();
      for (const src of imgs) {
        if (!src || !src.includes("biz_tag=aweme_images")) continue;
        const id = (src.match(/poi-pics\\/([a-f0-9]+)/) || [])[1] || src;
        if (seen.has(id)) continue;
        seen.add(id);
        images.push(src);
      }
      return { title: document.title || "", images: images, href: location.href };
    })()`;
    let page = { title: "", images: [] };
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      const result = await cdp(ws, "Runtime.evaluate", { expression, returnByValue: true });
      page = result.result && result.result.value || page;
      if (page.images && page.images.length) break;
    }
    return page;
  } finally {
    ws.close();
    fetch(`http://127.0.0.1:${CHROME_PORT}/json/close/${created.id}`).catch(() => {});
  }
}

async function resolveDouyinNote(finalUrl) {
  const awemeId = String(finalUrl || "").match(/\/(?:share\/)?note\/(\d+)/)?.[1];
  if (!awemeId) {
    throw new Error("没能从这条图文链接里识别出作品编号");
  }
  const page = await scrapeDouyinNote(awemeId);
  if (!page.images || !page.images.length) {
    throw new Error("这条抖音图文没有取到图片。如果弹出了登录或验证，请在电脑上打开抖音网页登录后再试。");
  }
  const title = String(page.title || "抖音图文").replace(/\s*-\s*抖音\s*$/, "").trim() || "抖音图文";
  return {
    kind: "gallery",
    platform: "抖音图文",
    title,
    images: page.images,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
      "Referer": "https://www.douyin.com/"
    }
  };
}

async function resolveDouyin(info) {
  let probeUrl = "";
  try {
    const probe = await fetch(info.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"
      },
      redirect: "follow"
    });
    probeUrl = probe.url || "";
    if (probeUrl.includes("/share/note/") || probeUrl.includes("/note/")) {
      return resolveDouyinNote(probeUrl);
    }
  } catch (e) {
    if (e.message && (e.message.includes("图文") || e.message.includes("作品编号") || e.message.includes("登录"))) throw e;
  }

  const startRes = await fetch(`${LOCAL_API}/api/scraper/fetch?url=${encodeURIComponent(info.url)}`);
  const startJson = await startRes.json();
  const jobId = startJson?.data?.id;
  if (startJson?.code !== 0 || !jobId) {
    throw new Error(startJson?.msg || "调用本机 2022 服务创建任务失败");
  }

  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const jobRes = await fetch(`${LOCAL_API}/api/scraper/job?id=${encodeURIComponent(jobId)}`);
    const jobJson = await jobRes.json();
    const d = jobJson?.data;
    if (!d) continue;
    if (d.status === "failed" || d.status === "error") {
      if (String(d.error || "").includes("has no item_list") || info.isNoteHint) {
        return resolveDouyinNote(probeUrl || info.url);
      }
      throw new Error(d.error || "抖音解析失败");
    }
    if (d.status === "completed") {
      const content = d.content || {};
      const mp4Url = content.url || d.content_details?.[0]?.data?.url;
      if (!mp4Url) {
        throw new Error("未提取到抖音 MP4 视频流地址");
      }
      return {
        kind: "video",
        platform: "抖音",
        title: content.title || content.description || "抖音视频",
        mp4Url,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36"
        }
      };
    }
  }
  throw new Error("抖音视频解析超时");
}

async function douyinCookieHeader() {
  await ensureNoteChrome();
  const tabs = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)).json();
  const tab = tabs.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
  if (!tab) return "";
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  try {
    const result = await cdp(ws, "Network.getCookies", {
      urls: ["https://www.douyin.com/", "https://p3-pc-sign.douyinpic.com/"]
    });
    return (result.cookies || []).map((item) => item.name + "=" + item.value).join("; ");
  } finally {
    ws.close();
  }
}

async function downloadGallery(task, resolved) {
  const folder = path.join(DOWNLOAD_DIR, `[${resolved.platform}]_${sanitizeFilename(resolved.title)}`);
  fs.mkdirSync(folder, { recursive: true });
  task.folderPath = folder;
  task.filePath = folder;
  task.filename = path.basename(folder);
  task.files = [];
  task.totalBytes = resolved.images.length;
  task.downloadedBytes = 0;
  const started = Date.now();
  const cookie = await douyinCookieHeader();
  for (let i = 0; i < resolved.images.length; i++) {
    task.message = `正在保存第 ${i + 1} / ${resolved.images.length} 张图片...`;
    task.percent = Math.round((i / resolved.images.length) * 100);
    const response = await fetch(resolved.images[i], {
      headers: Object.assign({}, resolved.headers || {}, cookie ? { Cookie: cookie } : {}),
      redirect: "follow"
    });
    if (!response.ok) {
      throw new Error(`第 ${i + 1} 张图片下载失败 (HTTP ${response.status})`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get("content-type") || "";
    const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
    const name = String(i + 1).padStart(2, "0") + "." + ext;
    fs.writeFileSync(path.join(folder, name), bytes);
    task.files.push(name);
    task.downloadedBytes = i + 1;
    task.speed = Math.round((bytes.length / 1024) / Math.max((Date.now() - started) / 1000, 0.1));
  }
  task.percent = 100;
  task.status = "completed";
  task.message = `图文已保存，共 ${resolved.images.length} 张图片`;
}

async function runDownloadTask(task, rawInput) {
  try {
    task.status = "parsing";
    task.message = "正在识别链接...";
    const info = extractUrlAndPlatform(rawInput);
    if (!info) {
      throw new Error("未在输入内容中找到有效的 B站 或 抖音 网址");
    }

    let resolved;
    if (info.platform === "bilibili") {
      resolved = await resolveBilibili(info);
    } else if (info.platform === "douyin") {
      resolved = await resolveDouyin(info);
    } else {
      throw new Error("目前极简面板支持粘贴【抖音】或【B站】分享口令/链接（微信视频号请直接在电脑微信点开视频点右下角下载图标）");
    }

    task.platform = resolved.platform;
    task.title = resolved.title;
    task.kind = resolved.kind || "video";
    task.directUrl = resolved.mp4Url || "";
    task.status = "downloading";
    if (resolved.kind === "gallery") {
      await downloadGallery(task, resolved);
      return;
    }
    task.message = "正在下载 MP4 到电脑 Downloads 目录...";

    const filename = `[${resolved.platform}]_${sanitizeFilename(resolved.title)}.mp4`;
    const filePath = path.join(DOWNLOAD_DIR, filename);
    task.filename = filename;
    task.filePath = filePath;

    const response = await fetch(resolved.mp4Url, {
      headers: resolved.headers || {},
      redirect: "follow"
    });
    if (!response.ok || !response.body) {
      throw new Error(`下载视频流失败 (HTTP ${response.status})`);
    }

    const totalBytes = parseInt(response.headers.get("content-length") || "0", 10);
    task.totalBytes = totalBytes;
    task.downloadedBytes = 0;
    const started = Date.now();

    const fileStream = fs.createWriteStream(filePath);
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(Buffer.from(value));
      task.downloadedBytes += value.byteLength;
      const seconds = Math.max((Date.now() - started) / 1000, 0.1);
      task.speed = Math.round(task.downloadedBytes / 1024 / seconds);
      if (totalBytes > 0) {
        task.percent = Math.min(99, Math.round((task.downloadedBytes / totalBytes) * 100));
      }
    }
    await new Promise((resolve) => fileStream.end(resolve));

    task.percent = 100;
    task.status = "completed";
    task.message = `下载完成 (${(task.downloadedBytes / 1024 / 1024).toFixed(1)} MB)`;
  } catch (err) {
    task.status = "error";
    task.message = err.message || String(err);
  }
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>视频号 · B站 · 抖音下载</title>
  <style>
    :root {
      --primary: #171717;
      --on-primary: #ffffff;
      --ink: #171717;
      --body: #4d4d4d;
      --mute: #888888;
      --hairline: #ebebeb;
      --hairline-strong: #a1a1a1;
      --canvas: #ffffff;
      --canvas-soft: #fafafa;
      --canvas-soft-2: #f5f5f5;
      --link: #0070f3;
      --link-deep: #0761d1;
      --link-bg-soft: #d3e5ff;
      --error: #ee0000;
      --error-soft: #f7d4d6;
      --error-deep: #c50000;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Geist, Inter, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      background: var(--canvas-soft);
      color: var(--ink);
      line-height: 1.5;
      height: 100vh;
      overflow: hidden;
    }
    .shell {
      display: flex;
      height: 100vh;
    }
    .side {
      width: 280px;
      flex: none;
      background: var(--canvas);
      border-right: 1px solid var(--hairline);
      display: flex;
      flex-direction: column;
    }
    .side-head {
      padding: 20px 18px 12px;
      border-bottom: 1px solid var(--hairline);
    }
    .side-list {
      overflow: auto;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .lib-item {
      width: 100%;
      text-align: left;
      border: 0;
      background: transparent;
      border-radius: 8px;
      padding: 10px;
      cursor: pointer;
      color: var(--ink);
    }
    .lib-item:hover, .lib-item.active {
      background: var(--canvas-soft-2);
    }
    .lib-name {
      font-size: 13px;
      font-weight: 500;
      word-break: break-all;
    }
    .lib-meta {
      margin-top: 2px;
      font-size: 12px;
      color: var(--mute);
    }
    .main {
      flex: 1;
      overflow: auto;
      padding: 28px;
    }
    .container {
      max-width: 760px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .card {
      background: var(--canvas);
      border: 1px solid var(--hairline);
      border-radius: 12px;
      padding: 24px;
    }
    .eyebrow {
      font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: var(--mute);
      letter-spacing: 0.04em;
    }
    h1 {
      font-size: 24px;
      font-weight: 600;
      letter-spacing: -0.96px;
      margin-top: 4px;
    }
    .sub {
      font-size: 14px;
      color: var(--body);
      margin-top: 6px;
    }
    .input-row {
      display: flex;
      gap: 10px;
      margin-top: 18px;
    }
    .url-input {
      flex: 1;
      height: 44px;
      padding: 0 14px;
      font-size: 14px;
      color: var(--ink);
      background: var(--canvas);
      border: 1px solid var(--hairline-strong);
      border-radius: 8px;
      outline: none;
    }
    .url-input:focus {
      border-color: var(--primary);
    }
    .btn {
      height: 44px;
      padding: 0 20px;
      font-size: 14px;
      font-weight: 500;
      color: var(--on-primary);
      background: var(--primary);
      border: 1px solid var(--primary);
      border-radius: 8px;
      cursor: pointer;
      white-space: nowrap;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-ghost {
      height: 32px;
      padding: 0 12px;
      font-size: 13px;
      font-weight: 500;
      color: var(--ink);
      background: var(--canvas-soft-2);
      border: 1px solid var(--hairline);
      border-radius: 6px;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
    }
    .btn-ghost:hover {
      border-color: var(--hairline-strong);
    }
    .btn-danger {
      color: var(--error-deep);
      background: var(--canvas);
      border-color: var(--error-soft);
    }
    .lib-row {
      display: flex;
      align-items: stretch;
      gap: 4px;
    }
    .lib-row .lib-item {
      flex: 1;
      min-width: 0;
    }
    .lib-del {
      flex: none;
      border: 0;
      background: transparent;
      color: var(--error-deep);
      font-size: 12px;
      padding: 0 8px;
      border-radius: 8px;
      cursor: pointer;
    }
    .lib-del:hover {
      background: var(--error-soft);
    }
    .task-list {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .task-item {
      border: 1px solid var(--hairline);
      border-radius: 10px;
      padding: 16px;
      background: var(--canvas);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .task-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
    }
    .task-title {
      font-size: 15px;
      font-weight: 500;
      color: var(--ink);
      word-break: break-all;
    }
    .badge {
      font-family: "Geist Mono", ui-monospace, monospace;
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--link-bg-soft);
      color: var(--link-deep);
      white-space: nowrap;
    }
    .badge.error {
      background: var(--error-soft);
      color: var(--error-deep);
    }
    .progress-track {
      height: 6px;
      background: var(--canvas-soft-2);
      border-radius: 999px;
      overflow: hidden;
    }
    .progress-bar {
      height: 100%;
      background: var(--link);
      transition: width 0.25s ease;
    }
    .task-meta {
      font-size: 13px;
      color: var(--body);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .percent {
      font-family: "Geist Mono", ui-monospace, monospace;
      font-size: 28px;
      font-weight: 600;
      letter-spacing: -0.8px;
      color: var(--ink);
    }
    .gallery {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 8px;
    }
    .gallery img {
      width: 100%;
      height: 140px;
      object-fit: cover;
      border-radius: 8px;
      border: 1px solid var(--hairline);
      background: var(--canvas-soft-2);
    }
    video {
      width: 100%;
      max-height: 360px;
      border-radius: 8px;
      background: var(--primary);
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="side">
      <div class="side-head">
        <div class="eyebrow">LIBRARY</div>
        <h1 style="font-size:20px;">已下载</h1>
      </div>
      <div id="library" class="side-list">
        <div class="sub" style="padding:10px;">还没有下载记录。</div>
      </div>
    </aside>
    <main class="main">
      <div class="container">
        <section class="card">
          <div class="eyebrow">127.0.0.1:2025 · 视频号在电脑微信里下载</div>
          <h1>视频号 · B站 · 抖音下载</h1>
          <p class="sub">B 站和抖音：把微信里复制的整段分享文字粘到这里。视频存成 MP4，抖音图文存成一个文件夹里的图片。视频号：在电脑微信里点开视频，点播放器右下角的下载图标。删除会同时去掉 Downloads 里的文件。说明见本文件夹的 README.md。</p>
          <div class="input-row">
            <input id="rawInput" class="url-input" type="text" placeholder="粘贴抖音或 B 站分享文字，回车开始" autofocus />
            <button id="submitBtn" class="btn" type="button">开始下载</button>
          </div>
        </section>
        <section class="card">
          <div class="eyebrow" style="margin-bottom: 12px;">PROGRESS</div>
          <div id="taskList" class="task-list">
            <div class="sub">粘贴链接后，这里会显示名称、大小、速度和进度。</div>
          </div>
        </section>
      </div>
    </main>
  </div>

  <script>
    const rawInput = document.getElementById('rawInput');
    const submitBtn = document.getElementById('submitBtn');
    const taskList = document.getElementById('taskList');

    async function startTask() {
      const text = rawInput.value.trim();
      if (!text) return;
      submitBtn.disabled = true;
      try {
        await fetch('/api/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        rawInput.value = '';
        await pollTasks();
      } finally {
        submitBtn.disabled = false;
      }
    }

    submitBtn.addEventListener('click', startTask);
    rawInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startTask();
    });

    async function openAction(id, mode) {
      await fetch('/api/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, mode })
      });
    }

    async function deleteItem(id, name) {
      if (!window.confirm('确定删除？下载文件夹里的这个文件也会一并去掉。')) return;
      const res = await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, name: name })
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        window.alert(data.message || '删除失败，请先关掉正在播放的窗口再试。');
        return;
      }
      lastSignature = '';
      pollTasks();
      pollLibrary();
    }

    let lastSignature = '';
    let selectedName = '';

    function formatSize(bytes) {
      const n = Number(bytes) || 0;
      if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
      if (n >= 1024) return Math.round(n / 1024) + ' KB';
      return n + ' B';
    }

    function renderTask(t) {
      const isErr = t.status === 'error';
      const isDone = t.status === 'completed';
      const gallery = t.kind === 'gallery';
      const sizeText = gallery
        ? ((t.downloadedBytes || 0) + ' / ' + (t.totalBytes || 0) + ' 张')
        : (t.totalBytes ? formatSize(t.downloadedBytes) + ' / ' + formatSize(t.totalBytes) : formatSize(t.downloadedBytes));
      const speedText = t.speed ? (gallery ? '' : t.speed + ' KB/s') : '';
      const preview = isDone && gallery && t.files
        ? '<div class="gallery">' + t.files.map(function (name) {
            return '<img alt="" src="/media?id=' + encodeURIComponent(t.id) + '&file=' + encodeURIComponent(name) + '">';
          }).join('') + '</div>'
        : (isDone && !gallery ? '<video controls preload="metadata" src="/video?id=' + t.id + '"></video>' : '');
      const actions = isDone
        ? '<div class="actions">' +
            (gallery ? '' : '<button class="btn-ghost" onclick="openAction(\\'' + t.id + '\\', \\'file\\')">用播放器打开</button>') +
            '<button class="btn-ghost" onclick="openAction(\\'' + t.id + '\\', \\'folder\\')">打开所在文件夹</button>' +
            (gallery ? '' : '<a class="btn-ghost" href="/video?id=' + t.id + '" download="' + (t.filename || 'video.mp4') + '">浏览器另存</a>') +
            '<button class="btn-ghost btn-danger" onclick="deleteItem(\\'' + t.id + '\\', \\'\\')">删除</button>' +
          '</div>'
        : '';
      return '<div class="task-item">' +
        '<div class="task-head"><div class="task-title">' + (t.platform ? '[' + t.platform + '] ' : '') + (t.title || t.rawInput || '') + '</div>' +
        '<div class="percent">' + (isDone ? '100%' : isErr ? '失败' : (t.percent || 0) + '%') + '</div></div>' +
        '<div class="progress-track"><div class="progress-bar" style="width:' + (isDone ? 100 : (t.percent || 4)) + '%;background:' + (isErr ? 'var(--error)' : 'var(--link)') + '"></div></div>' +
        '<div class="task-meta"><span>' + (t.message || '') + '</span><span>' + sizeText + (speedText ? ' · ' + speedText : '') + '</span></div>' +
        actions + preview + '</div>';
    }

    async function pollTasks() {
      try {
        const res = await fetch('/api/tasks');
        const list = await res.json();
        if (!list.length) {
          if (lastSignature !== '[]') {
            lastSignature = '[]';
            taskList.innerHTML = '<div class="sub">粘贴链接后，这里会显示名称、大小、速度和进度。</div>';
          }
          return;
        }
        const sig = JSON.stringify(list.map(t => [t.id, t.status, t.percent, t.message, (t.files || []).length]));
        if (sig === lastSignature) return;
        lastSignature = sig;
        taskList.innerHTML = list.map(renderTask).join('');
      } catch (e) {}
    }

    async function pollLibrary() {
      try {
        const res = await fetch('/api/library');
        const list = await res.json();
        const box = document.getElementById('library');
        if (!list.length) {
          box.innerHTML = '<div class="sub" style="padding:10px;">还没有下载记录。</div>';
          return;
        }
        box.innerHTML = list.map(function (item) {
          const active = item.name === selectedName ? ' active' : '';
          const meta = item.kind === 'gallery' ? (item.count + ' 张图片') : formatSize(item.size);
          const safeName = item.name.replace(/"/g, '&quot;');
          return '<div class="lib-row"><button class="lib-item' + active + '" data-name="' + safeName + '" onclick="openLibrary(this.dataset.name)">' +
            '<div class="lib-name">' + item.name + '</div><div class="lib-meta">' + meta + '</div></button>' +
            '<button class="lib-del" data-name="' + safeName + '" onclick="deleteItem(&quot;&quot;, this.dataset.name)">删除</button></div>';
        }).join('');
      } catch (e) {}
    }

    async function openLibrary(name) {
      selectedName = name;
      await fetch('/api/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, mode: 'folder' })
      });
      pollLibrary();
    }

    setInterval(pollTasks, 1000);
    setInterval(pollLibrary, 2000);
    pollTasks();
    pollLibrary();
  </script>
</body>
</html>`;

function listLibrary() {
  if (!fs.existsSync(DOWNLOAD_DIR)) return [];
  return fs.readdirSync(DOWNLOAD_DIR, { withFileTypes: true })
    .filter((ent) => isManagedName(ent.name))
    .map((ent) => {
      try {
        const full = path.join(DOWNLOAD_DIR, ent.name);
        const stat = fs.statSync(full);
        let count = 0;
        if (stat.isDirectory()) {
          count = fs.readdirSync(full).filter((name) => /\.(jpg|jpeg|png|webp)$/i.test(name)).length;
        }
        return {
          name: ent.name,
          kind: stat.isDirectory() ? "gallery" : "video",
          size: stat.size,
          count,
          mtime: stat.mtimeMs
        };
      } catch (err) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

function isManagedName(name) {
  return name.startsWith("[B站]_") || name.startsWith("[抖音]_") || name.startsWith("[抖音图文]_");
}

function libraryPath(name) {
  const base = path.basename(String(name || ""));
  if (!isManagedName(base)) return "";
  const full = path.join(DOWNLOAD_DIR, base);
  return fs.existsSync(full) ? full : "";
}

function deleteManagedPath(target) {
  const resolved = path.resolve(target);
  const root = path.resolve(DOWNLOAD_DIR);
  const base = path.basename(resolved);
  if (path.dirname(resolved) !== root || !isManagedName(base)) {
    throw new Error("只能删除本下载台保存在 Downloads 里的文件");
  }
  if (!fs.existsSync(resolved)) return;
  // 文件名里的 [] 不能直接交给 rm：会被当成通配符，图文文件夹删不掉，复杂名字还会把进程打崩。
  const tmp = path.join(root, "_正在删除_" + Date.now());
  try {
    fs.renameSync(resolved, tmp);
  } catch (err) {
    if (err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES") {
      throw new Error("文件正在被播放或占用，请先关掉播放窗口再删除");
    }
    throw err;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && u.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML_PAGE);
    return;
  }

  if (req.method === "GET" && u.pathname === "/api/library") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(listLibrary()));
    return;
  }

  if (req.method === "GET" && u.pathname === "/api/tasks") {
    const list = Array.from(tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(list));
    return;
  }

  if (req.method === "POST" && u.pathname === "/api/start") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { text } = JSON.parse(body || "{}");
      const id = "task_" + Date.now();
      const task = {
        id,
        rawInput: String(text || "").slice(0, 100),
        title: "",
        platform: "",
        status: "queued",
        percent: 5,
        message: "已加入队列...",
        createdAt: Date.now()
      };
      tasks.set(id, task);
      runDownloadTask(task, text);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, id }));
    });
    return;
  }

  if (req.method === "POST" && u.pathname === "/api/open") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, mode, name } = JSON.parse(body || "{}");
      const task = tasks.get(id);
      const target = (task && task.filePath && fs.existsSync(task.filePath)) ? task.filePath : libraryPath(name);
      if (target) {
        const isDir = fs.statSync(target).isDirectory();
        if (mode === "folder" || isDir) {
          if (isDir) {
            spawn("explorer.exe", [target], { detached: true, stdio: "ignore" }).unref();
          } else {
            spawn("explorer.exe", ["/select,", target], { detached: true, stdio: "ignore" }).unref();
          }
        } else {
          spawn("cmd.exe", ["/c", "start", "", target], { detached: true, stdio: "ignore" }).unref();
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method === "POST" && u.pathname === "/api/delete") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { id, name } = JSON.parse(body || "{}");
        const task = id ? tasks.get(id) : null;
        const target = (task && task.filePath && fs.existsSync(task.filePath))
          ? task.filePath
          : libraryPath(name);
        if (target) deleteManagedPath(target);
        if (id) tasks.delete(id);
        if (target) {
          const resolved = path.resolve(target);
          for (const [taskId, item] of tasks) {
            if (item.filePath && path.resolve(item.filePath) === resolved) tasks.delete(taskId);
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: err.message || "删除失败" }));
      }
    });
    return;
  }

  if (req.method === "GET" && u.pathname === "/media") {
    const task = tasks.get(u.searchParams.get("id"));
    const file = path.basename(u.searchParams.get("file") || "");
    const root = task && task.folderPath ? path.resolve(task.folderPath) : "";
    const full = root ? path.resolve(root, file) : "";
    if (!root || !full.startsWith(root + path.sep) || !fs.existsSync(full)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(full).toLowerCase();
    const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    res.writeHead(200, { "Content-Type": type });
    const stream = fs.createReadStream(full);
    stream.on("error", () => {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    });
    stream.pipe(res);
    return;
  }

  if (req.method === "GET" && u.pathname === "/video") {
    const id = u.searchParams.get("id");
    const task = tasks.get(id);
    if (!task || !task.filePath || !fs.existsSync(task.filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const stat = fs.statSync(task.filePath);
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": stat.size
    });
    const stream = fs.createReadStream(task.filePath);
    stream.on("error", () => {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    });
    stream.pipe(res);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const logFile = path.join(__dirname, "simple-ui.log");
function writeLog(kind, err) {
  try {
    fs.appendFileSync(logFile, new Date().toISOString() + " " + kind + " " + (err && err.stack || err) + "\n");
  } catch (e) {}
}
process.on("uncaughtException", (err) => writeLog("uncaught", err));
process.on("unhandledRejection", (err) => writeLog("rejection", err));

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Minimalist UI running at http://127.0.0.1:${PORT}`);
});
