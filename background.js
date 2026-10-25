const LOCAL_SERVICE_BASE_URL = "http://127.0.0.1:2022";
const BACKEND_BASE_URL = "https://vbe5k5l2ij.gzg.sealos.run";
const BACKEND_JIEXI_API_URL = BACKEND_BASE_URL + "/xbd_ext_cloudDecrypt";
const BACKEND_FALLBACK_API_URL = BACKEND_BASE_URL + "/xbd_parseVideo";
const MAIN_SETTINGS_KEY = "mainLayoutSettings";
const RECENT_VIDEOS_KEY = "recentCapturedVideos";

function sanitizeFilename(title) {
  if (!title || typeof title !== "string") {
    return "";
  }
  return title.replace(/[<>:"|?*\/\n\r\\]/g, "_").trim().slice(0, 80);
}

async function getSettings() {
  const result = await chrome.storage.local.get([MAIN_SETTINGS_KEY]);
  return {
    pluginSwitch: result?.[MAIN_SETTINGS_KEY]?.pluginSwitch !== false,
    autoSendChat: result?.[MAIN_SETTINGS_KEY]?.autoSendChat !== false,
    saveToLocalDisk: Boolean(result?.[MAIN_SETTINGS_KEY]?.saveToLocalDisk), // 默认 false：不往本地硬盘存文件，免除一切下载确认弹窗
    customApiUrl: String(result?.[MAIN_SETTINGS_KEY]?.customApiUrl || "").trim()
  };
}

async function saveRecentVideo(item) {
  try {
    const res = await chrome.storage.local.get([RECENT_VIDEOS_KEY]);
    const list = Array.isArray(res?.[RECENT_VIDEOS_KEY]) ? res[RECENT_VIDEOS_KEY] : [];
    const dedupeKey = item.objectId || item.url || item.title;
    const nextList = [
      {
        ...item,
        timestamp: Date.now()
      },
      ...list.filter((x) => (x.objectId || x.url || x.title) !== dedupeKey)
    ].slice(0, 12);
    await chrome.storage.local.set({ [RECENT_VIDEOS_KEY]: nextList });
  } catch (e) {
    console.warn("保存历史记录失败:", e);
  }
}

async function requestLocalChannelsProfile(requestInit) {
  let body = {};
  try {
    body = typeof requestInit?.body === "string" ? JSON.parse(requestInit.body) : (requestInit?.body || {});
  } catch (e) {
    body = {};
  }
  const oid = String(body.objectId || "").trim();
  const nid = String(body.objectNonceId || "").trim();
  if (!oid || !nid) {
    return null;
  }

  const profileUrl = `${LOCAL_SERVICE_BASE_URL}/api/channels/feed/profile?oid=${encodeURIComponent(oid)}&nid=${encodeURIComponent(nid)}`;
  const res = await fetch(profileUrl, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) {
    return null;
  }
  const json = await res.json();
  const obj = json?.data?.data?.object || json?.data?.object;
  const objectDesc = obj?.objectDesc || obj?.object_desc;
  const mediaList = Array.isArray(objectDesc?.media) ? objectDesc.media : [];
  if (!mediaList.length) {
    return null;
  }

  const firstMedia = mediaList[0];
  const fullUrl = String(firstMedia.url || "") + String(firstMedia.urlToken || firstMedia.url_token || "");
  if (!fullUrl) {
    return null;
  }
  const decodeKey = String(firstMedia.decodeKey || firstMedia.decode_key || "");
  const isAlbum = objectDesc?.mediaType === 2 && !decodeKey && mediaList.length > 1;
  const coverUrl = String(firstMedia.coverUrl || firstMedia.cover_url || firstMedia.thumbUrl || "").replace(/^http:\/\//i, "https://");
  const title = objectDesc?.description || body.description || "视频号视频";

  return {
    code: 200,
    msg: "ok (local)",
    data: {
      title,
      type: isAlbum ? 2 : 1,
      encryption: Boolean(decodeKey),
      url: decodeKey ? "" : fullUrl,
      eurl: decodeKey ? fullUrl : "",
      photo: coverUrl,
      pics: isAlbum ? mediaList.map((m) => String(m.url || "") + String(m.urlToken || m.url_token || "")) : [],
      other: {
        decodeKey,
        fileSize: firstMedia.fileSize || 0
      }
    }
  };
}

async function requestParseApi(requestInit, customApiUrl) {
  // 1. 优先尝试本机电脑微信 4.1.13 直抓服务 (127.0.0.1:2022)，完全不经过外部服务器
  try {
    const localRes = await requestLocalChannelsProfile(requestInit);
    if (localRes && localRes.code === 200 && localRes.data) {
      console.log("✅ 已通过本机 127.0.0.1:2022 服务直接换取视频号详情");
      return localRes;
    }
  } catch (e) {
    // 本机服务未连接视频号页面时，平滑回退到云端接口
  }

  // 2. 兜底云端解析接口
  const candidateUrls = [
    customApiUrl,
    BACKEND_JIEXI_API_URL,
    BACKEND_FALLBACK_API_URL
  ].filter(Boolean);

  let lastError = null;
  for (const apiUrl of candidateUrls) {
    try {
      const res = await fetch(apiUrl, requestInit);
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const json = await res.json();
        if (json && json.code === 200 && json.data) {
          return json;
        }
        lastError = new Error(json?.msg || json?.message || `接口返回状态码: ${json?.code}`);
      } else {
        lastError = new Error(`接口返回非 JSON (${res.status})`);
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("解析接口请求失败");
}

function uint8ToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * 解析 B站视频 (支持 b23.tv 短链、bilibili.com 链接、BV号、av号)
 * 纯 API 轻量级调用，无需打开任何新标签页，0 弹窗、0 验证，直接返回可点击下载的 MP4 直链
 */
async function resolveBilibiliVideo({ bvid, aid, shareUrl, title }) {
  let targetBvid = bvid || "";
  let targetAid = aid || "";

  if (!targetBvid && !targetAid && shareUrl) {
    const res = await fetch(shareUrl, { redirect: "follow" });
    const finalUrl = res.url || shareUrl;
    const bvMatch = finalUrl.match(/(BV[0-9A-Za-z]{10})/);
    const avMatch = finalUrl.match(/av(\d+)|aid=(\d+)/i);
    if (bvMatch) targetBvid = bvMatch[1];
    if (avMatch) targetAid = avMatch[1] || avMatch[2];
  }

  if (!targetBvid && !targetAid) {
    throw new Error("未能从 B 站分享消息中识别出 BV 号或 av 号");
  }

  const queryParam = targetBvid ? `bvid=${targetBvid}` : `aid=${targetAid}`;
  const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?${queryParam}`);
  const viewJson = await viewRes.json();

  if (viewJson.code !== 0 || !viewJson.data) {
    throw new Error(viewJson.message || "获取 B 站视频详情失败");
  }

  const videoTitle = viewJson.data.title || title || "B站视频";
  const cid = viewJson.data.cid || viewJson.data.pages?.[0]?.cid;
  const coverUrl = (viewJson.data.pic || "").replace(/^http:\/\//i, "https://");

  if (!cid) {
    throw new Error("未获取到 B 站视频 cid");
  }

  const playRes = await fetch(
    `https://api.bilibili.com/x/player/playurl?${queryParam}&cid=${cid}&qn=80&fnval=1&platform=html5&high_quality=1`
  );
  const playJson = await playRes.json();
  const mp4Url = playJson?.data?.durl?.[0]?.url;

  if (!mp4Url) {
    throw new Error(playJson.message || "未获取到 B 站 MP4 视频流地址");
  }

  return {
    code: 200,
    msg: "ok",
    data: {
      platform: "bilibili",
      title: videoTitle,
      type: 1,
      encryption: false,
      url: mp4Url,
      eurl: "",
      photo: coverUrl,
      other: {
        decodeKey: "",
        bvid: targetBvid || `av${targetAid}`
      }
    }
  };
}

/**
 * 通过本机 127.0.0.1:2022 服务无感解析抖音分享链接
 * 走移动端协议签名，不开任何浏览器标签页、0 滑块验证、0 弹窗，直接返回可点击下载的 MP4 直链
 */
async function resolveDouyinVideo({ shareUrl, description, title }) {
  if (!shareUrl) {
    throw new Error("未找到抖音分享链接");
  }

  const startRes = await fetch(
    `${LOCAL_SERVICE_BASE_URL}/api/scraper/fetch?url=${encodeURIComponent(shareUrl)}`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!startRes.ok) {
    throw new Error(`本机服务响应异常 (HTTP ${startRes.status})`);
  }
  const startJson = await startRes.json();
  const jobId = startJson?.data?.id;
  if (startJson?.code !== 0 || !jobId) {
    throw new Error(startJson?.msg || "创建抖音解析任务失败");
  }

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const jobRes = await fetch(
      `${LOCAL_SERVICE_BASE_URL}/api/scraper/job?id=${encodeURIComponent(jobId)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!jobRes.ok) continue;
    const jobJson = await jobRes.json();
    const jobData = jobJson?.data;
    if (!jobData) continue;

    if (jobData.status === "failed" || jobData.status === "error") {
      throw new Error(jobData.error || jobData.progress?.message || "抖音视频解析失败");
    }

    if (jobData.status === "completed") {
      const content = jobData.content || {};
      const detailUrl = jobData.content_details?.[0]?.data?.url || "";
      const mp4Url = String(content.url || detailUrl || "").replace(/^http:\/\//i, "https://");
      if (!mp4Url) {
        throw new Error("未从抖音作品中提取到 MP4 视频地址");
      }
      const videoTitle = content.title || content.description || description || title || "抖音视频";
      const coverUrl = String(content.cover_url || "").replace(/^http:\/\//i, "https://");

      return {
        code: 200,
        msg: "ok",
        data: {
          platform: "douyin",
          title: videoTitle,
          type: 1,
          encryption: false,
          url: mp4Url,
          eurl: "",
          photo: coverUrl,
          other: {
            decodeKey: "",
            awemeId: content.external_id || ""
          }
        }
      };
    }
  }

  throw new Error("解析抖音视频超时");
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "fetch-binary") {
    return;
  }

  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== "start" || !msg.url) {
      return;
    }

    try {
      const targetUrl = String(msg.url).replace(/^http:\/\//i, "https://");
      const res = await fetch(targetUrl, { signal: AbortSignal.timeout(180000) });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      port.postMessage({
        type: "meta",
        enclen: res.headers.get("X-enclen") || ""
      });

      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        port.postMessage({ type: "chunk", chunk: value });
      }
      port.postMessage({ type: "done" });
    } catch (err) {
      port.postMessage({
        type: "error",
        message: String(err?.message || err)
      });
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || !message.action) {
      sendResponse({
        success: false,
        code: 9000,
        message: "消息格式错误",
        data: null,
        serverTime: Date.now()
      });
      return;
    }

    if (message.action === "content2back_completePage") {
      const settings = await getSettings();

      if (!settings.pluginSwitch) {
        sendResponse({
          success: true,
          code: 0,
          message: "插件已关闭，跳过注入"
        });
        return;
      }

      if (sender?.tab?.id) {
        chrome.scripting.executeScript({
          target: { tabId: parseInt(sender.tab.id, 10) },
          files: ["hook.js"],
          world: "MAIN"
        }).catch(() => {});
      }

      sendResponse({
        success: true,
        code: 0,
        message: "页面加载完成，Hook 已注入"
      });
      return;
    }

    // 处理 B站 / 抖音 转发消息（直接返回可点击下载的 MP4 直链，不打开新标签页，0 弹窗）
    if (message.action === "content2back_thirdPartyVideo") {
      const settings = await getSettings();
      if (!settings.pluginSwitch) {
        sendResponse({
          success: false,
          code: 9010,
          message: "插件开关已关闭，跳过解析"
        });
        return;
      }

      const platform = message.platform === "douyin" ? "douyin" : "bilibili";
      const platformLabel = platform === "douyin" ? "抖音" : "B站";
      const payload = message.data || {};

      try {
        const apiResponse = platform === "douyin"
          ? await resolveDouyinVideo(payload)
          : await resolveBilibiliVideo(payload);
        const { title, url, photo } = apiResponse.data;

        await saveRecentVideo({
          platform,
          objectId: apiResponse.data?.other?.bvid || apiResponse.data?.other?.awemeId || payload.shareUrl || "",
          title: `[${platformLabel}] ${title || "视频"}`,
          url,
          photo: photo || "",
          encryption: false,
          decodeKey: "",
          type: 1
        });

        // 直接向微信传输助手发送可直接点击下载的 MP4 直链
        if (settings.autoSendChat && sender?.tab?.id) {
          chrome.tabs.sendMessage(parseInt(sender.tab.id, 10), {
            action: "back2content_postVideoInfo",
            data: {
              platform,
              title: `[${platformLabel}] ${title}`,
              url,
              photo,
              encryption: false,
              decodeKey: ""
            }
          }).catch(() => {});
        }

        // 仅在用户主动开启“同时保存到电脑本地下载目录”时才触发本地保存
        if (settings.saveToLocalDisk && sender?.tab?.id) {
          chrome.tabs.sendMessage(parseInt(sender.tab.id, 10), {
            action: "back2content_downloadVideo",
            payload: apiResponse,
            saveToLocalDisk: true
          }).catch(() => {});
        }

        sendResponse({
          success: true,
          code: 200,
          message: `${platformLabel}视频解析成功，已发送 MP4 下载直链`
        });
      } catch (error) {
        console.warn(`⚠️ ${platformLabel}解析失败:`, error);
        sendResponse({
          success: false,
          code: 9015,
          message: `⚠️ ${platformLabel}视频解析失败：${error.message || error}`
        });
      }
      return;
    }

    // 处理微信视频号消息（解密并直接将可播放的 .mp4 文件发回微信对话框）
    if (message.action === "content2back_downloadMP4") {
      const settings = await getSettings();

      if (!settings.pluginSwitch) {
        sendResponse({
          success: false,
          code: 9010,
          message: "插件开关已关闭，跳过解析"
        });
        return;
      }

      console.log("🎬 BACKGROUND 接收到视频号请求:", message.data);

      let parsedBody = {};
      try {
        parsedBody = typeof message?.data?.data?.body === "string"
          ? JSON.parse(message.data.data.body)
          : (message?.data?.data?.body || {});
      } catch (e) {
        parsedBody = {};
      }

      try {
        const apiResponse = await requestParseApi(message.data.data, settings.customApiUrl);
        console.log("📦 BACKGROUND 解析返回:", apiResponse);

        const { title, encryption, url, eurl, other, photo, type, pics } = apiResponse.data;
        const decodeKey = other?.decodeKey || "";

        await saveRecentVideo({
          platform: "channels",
          objectId: parsedBody.objectId || "",
          objectNonceId: parsedBody.objectNonceId || "",
          title: title || parsedBody.description || "未命名视频",
          url: encryption ? eurl : url,
          rawUrl: url || "",
          eurl: eurl || "",
          photo: photo || "",
          encryption: Boolean(encryption),
          decodeKey: String(decodeKey || ""),
          type: type || 1
        });

        // type=2 是图集，转发给 content 顺序下载+ZIP 打包并回传微信
        if (type === 2) {
          if (sender?.tab?.id) {
            chrome.tabs.sendMessage(parseInt(sender.tab.id, 10), {
              action: "back2content_downloadVideo",
              payload: apiResponse,
              saveToLocalDisk: settings.saveToLocalDisk
            }).catch(() => {});
          }

          sendResponse({
            success: true,
            code: 200,
            message: `图集处理已开始，共 ${Array.isArray(pics) ? pics.length : 0} 张`
          });
          return;
        }

        const videoUrl = encryption ? eurl : url;

        if (settings.autoSendChat && sender?.tab?.id) {
          chrome.tabs.sendMessage(parseInt(sender.tab.id, 10), {
            action: "back2content_postVideoInfo",
            data: {
              platform: "channels",
              title,
              url: videoUrl,
              photo,
              encryption: Boolean(encryption),
              decodeKey: String(decodeKey || "")
            }
          }).catch(() => {});
        }

        if (sender?.tab?.id) {
          chrome.tabs.sendMessage(parseInt(sender.tab.id, 10), {
            action: "back2content_downloadVideo",
            payload: apiResponse,
            saveToLocalDisk: settings.saveToLocalDisk
          }).catch(() => {});
        }

        sendResponse({
          success: true,
          code: 200,
          message: "已启动解密并回传 MP4 文件"
        });

        // 不再额外下载封面图，避免单次触发两个文件下载导致浏览器弹出“允许下载多个文件”确认框
      } catch (error) {
        console.warn("⚠️ 解析请求失败:", error);
        await saveRecentVideo({
          platform: "channels",
          objectId: parsedBody.objectId || "",
          objectNonceId: parsedBody.objectNonceId || "",
          title: parsedBody.description || "仅捕获ID（待解析）",
          url: "",
          encryption: false,
          decodeKey: "",
          error: String(error?.message || error)
        });
        sendResponse({
          success: false,
          code: 9008,
          message: `解析接口响应异常: ${error.message || error}（已记录 objectId: ${parsedBody.objectId || "未知"}）`
        });
      }
      return;
    }

    if (message.action === "content2back_fetchBinary") {
      try {
        const targetUrl = String(message.url || "").replace(/^http:\/\//i, "https://");
        const res = await fetch(targetUrl, { method: "GET" });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const enclen = res.headers.get("X-enclen") || "";
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        sendResponse({
          success: true,
          base64: uint8ToBase64(bytes),
          enclen
        });
      } catch (err) {
        sendResponse({
          success: false,
          message: String(err?.message || err)
        });
      }
      return;
    }

    if (message.action === "content2back_directMediaCaptured") {
      const mediaData = message.data || {};
      await saveRecentVideo({
        platform: mediaData.platform || "channels",
        objectId: mediaData.objectId || "",
        objectNonceId: mediaData.objectNonceId || "",
        title: mediaData.title || "网页直接嗅探视频",
        url: mediaData.url || "",
        photo: mediaData.photo || "",
        encryption: Boolean(mediaData.decodeKey),
        decodeKey: String(mediaData.decodeKey || ""),
        type: mediaData.type || 1
      });
      sendResponse({
        success: true,
        code: 0,
        message: "已记录嗅探到的视频流与密钥"
      });
      return;
    }

    sendResponse({
      success: false,
      code: 9006,
      message: "未知消息类型",
      data: { type: message.action, sender: sender?.id || "" },
      serverTime: Date.now()
    });
  })();

  return true;
});
