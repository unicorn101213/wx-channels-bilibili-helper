const pluginSwitch = document.getElementById("pluginSwitch");
const autoSendChatSwitch = document.getElementById("autoSendChatSwitch");
const saveToLocalDiskSwitch = document.getElementById("saveToLocalDiskSwitch");
const versionText = document.getElementById("versionText");
const openLink = document.getElementById("openLink");
const recentList = document.getElementById("recentList");
const clearRecentBtn = document.getElementById("clearRecentBtn");
const manualVideoUrl = document.getElementById("manualVideoUrl");
const manualDecodeKey = document.getElementById("manualDecodeKey");
const manualTitle = document.getElementById("manualTitle");
const manualDownloadBtn = document.getElementById("manualDownloadBtn");
const statusBar = document.getElementById("statusBar");

const MAIN_SETTINGS_KEY = "mainLayoutSettings";
const RECENT_VIDEOS_KEY = "recentCapturedVideos";

function showStatus(text, type = "") {
    if (!text) {
        statusBar.className = "status-bar";
        statusBar.textContent = "";
        return;
    }
    statusBar.textContent = text;
    statusBar.className = `status-bar visible ${type}`.trim();
}

function sanitizeFilename(title) {
    if (!title || typeof title !== "string") {
        return "视频号视频";
    }
    return title.replace(/[<>:"|?*\/\n\r\\]/g, "_").trim().slice(0, 80) || "视频号视频";
}

function triggerBlobDownload(uint8Array, filename) {
    const blob = new Blob([uint8Array], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename.endsWith(".mp4") ? filename : `${filename}.mp4`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
    }, 200);
}

async function localDownloadAndDecrypt(rawUrl, decodeKey, title) {
    const cleanUrl = String(rawUrl || "").trim().replace(/^http:\/\//i, "https://");
    if (!cleanUrl) {
        showStatus("请先填写有效的视频流地址 (URL)", "error");
        return;
    }

    manualDownloadBtn.disabled = true;
    showStatus("正在拉取视频流数据，请稍候...");

    try {
        const response = await fetch(cleanUrl, {
            method: "GET",
            signal: AbortSignal.timeout(180000)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const enclenHeader = response.headers.get("X-enclen");
        const arrayBuffer = await response.arrayBuffer();
        const buffer = new Uint8Array(arrayBuffer);

        const cleanKey = String(decodeKey || "").trim();
        if (cleanKey) {
            showStatus(`正在执行 ISAAC-64 本地解密 (${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB)...`);
            const encLen = Math.min(buffer.length, parseInt(enclenHeader, 10) || 131072);
            decryptData(buffer, encLen, cleanKey);
        }

        const safeName = `${sanitizeFilename(title)}.mp4`;
        triggerBlobDownload(buffer, safeName);
        showStatus(`下载完成：${safeName}`, "success");
    } catch (error) {
        showStatus(`解密下载失败：${error.message || error}`, "error");
    } finally {
        manualDownloadBtn.disabled = false;
    }
}

async function renderRecentVideos() {
    const res = await chrome.storage.local.get([RECENT_VIDEOS_KEY]);
    const list = Array.isArray(res?.[RECENT_VIDEOS_KEY]) ? res[RECENT_VIDEOS_KEY] : [];

    if (list.length === 0) {
        recentList.innerHTML = '<div class="switch-sub">暂无捕获记录，转发视频号至网页版传输助手后将自动显示。</div>';
        return;
    }

    recentList.innerHTML = "";
    list.forEach((item) => {
        const row = document.createElement("div");
        row.className = "recent-item";

        const meta = document.createElement("div");
        meta.className = "recent-meta";

        const titleEl = document.createElement("div");
        titleEl.className = "recent-title";
        titleEl.textContent = item.title || "未命名视频";

        const subEl = document.createElement("div");
        subEl.className = "recent-sub";
        if (item.url) {
            subEl.textContent = item.decodeKey ? `加密流 · Key: ${item.decodeKey}` : "未加密直链";
        } else {
            subEl.textContent = `ID: ${item.objectId || "未知"} (${item.error || "待解析"})`;
        }

        meta.appendChild(titleEl);
        meta.appendChild(subEl);
        row.appendChild(meta);

        if (item.url) {
            const dlBtn = document.createElement("button");
            dlBtn.className = "btn-secondary";
            dlBtn.type = "button";
            dlBtn.textContent = "解密下载";
            dlBtn.addEventListener("click", () => {
                manualVideoUrl.value = item.url;
                manualDecodeKey.value = item.decodeKey || "";
                manualTitle.value = item.title || "";
                localDownloadAndDecrypt(item.url, item.decodeKey, item.title);
            });
            row.appendChild(dlBtn);
        }

        recentList.appendChild(row);
    });
}

async function saveSettings() {
    const existing = await chrome.storage.local.get([MAIN_SETTINGS_KEY]);
    const prev = existing?.[MAIN_SETTINGS_KEY] || {};
    await chrome.storage.local.set({
        [MAIN_SETTINGS_KEY]: {
            ...prev,
            pluginSwitch: Boolean(pluginSwitch.checked),
            autoSendChat: Boolean(autoSendChatSwitch.checked),
            saveToLocalDisk: Boolean(saveToLocalDiskSwitch.checked)
        }
    });
}

pluginSwitch.addEventListener("change", saveSettings);
autoSendChatSwitch.addEventListener("change", saveSettings);
saveToLocalDiskSwitch.addEventListener("change", saveSettings);

openLink.addEventListener("click", () => {
    chrome.tabs.create({
        url: "https://filehelper.weixin.qq.com/",
        active: true
    });
});

clearRecentBtn.addEventListener("click", async () => {
    await chrome.storage.local.remove([RECENT_VIDEOS_KEY]);
    await renderRecentVideos();
});

manualDownloadBtn.addEventListener("click", () => {
    localDownloadAndDecrypt(
        manualVideoUrl.value,
        manualDecodeKey.value,
        manualTitle.value || "视频号视频"
    );
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[RECENT_VIDEOS_KEY]) {
        renderRecentVideos();
    }
});

(async () => {
    const manifestVersion = chrome.runtime.getManifest().version || "1.0.0";
    versionText.textContent = `WECHAT CHANNELS · v${manifestVersion}`;

    const result = await chrome.storage.local.get([MAIN_SETTINGS_KEY]);
    const saved = result?.[MAIN_SETTINGS_KEY] || {};
    pluginSwitch.checked = saved.pluginSwitch !== false;
    autoSendChatSwitch.checked = saved.autoSendChat !== false;
    saveToLocalDiskSwitch.checked = Boolean(saved.saveToLocalDisk);

    await renderRecentVideos();
})();
