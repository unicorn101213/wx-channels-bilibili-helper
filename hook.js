/**
 * 格式化视频时长（秒转可读格式）
 * @param {number} seconds - 视频时长（秒）
 * @returns {string} 格式化后的时长
 */
function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '0秒';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const parts = [];
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分钟`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}秒`);

    return parts.join('');
}

/**
 * 从微信消息 XML 中提取「视频号 / B站小程序卡片 / 网页链接卡片」信息
 */
function extractMsgCardOrVideoInfo(xmlStr) {
    const result = {
        platform: null, // 'channels' | 'bilibili'
        o_id: null,
        n_id: null,
        description: null,
        duration: null,
        resolution: null,
        width: null,
        height: null,
        shareUrl: null,
        bvid: null
    };

    try {
        if (!xmlStr || typeof xmlStr !== 'string') {
            return result;
        }

        const textarea = document.createElement('textarea');
        textarea.innerHTML = xmlStr;
        const decodedXml = textarea.value;

        // 1. 优先尝试正则匹配 XML 中的 B站 URL 或 BV号
        const bvMatch = decodedXml.match(/(BV[0-9A-Za-z]{10})/);
        const b23Match = decodedXml.match(/https?:\/\/b23\.tv\/[0-9A-Za-z_-]+/i);
        const biliUrlMatch = decodedXml.match(/https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i);

        const cleanXml = decodedXml
            .replace(/<br\s*\/?>/g, '')
            .trim();

        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(cleanXml, 'text/xml');

        const hasParseError = xmlDoc.getElementsByTagName('parsererror').length > 0;

        if (!hasParseError) {
            // 检查是否为视频号 <finderFeed>
            const finderFeed = xmlDoc.querySelector('finderFeed');
            if (finderFeed) {
                result.platform = 'channels';
                const objectId = finderFeed.querySelector('objectId');
                const objectNonceId = finderFeed.querySelector('objectNonceId');
                const desc = finderFeed.querySelector('desc');

                if (objectId) result.o_id = objectId.textContent?.trim() || null;
                if (objectNonceId) result.n_id = objectNonceId.textContent?.trim() || null;
                if (desc && desc.textContent) result.description = desc.textContent.trim();

                const mediaList = finderFeed.querySelector('mediaList');
                const media = mediaList ? mediaList.querySelector('media') : null;

                if (media) {
                    const durationElem = media.querySelector('videoPlayDuration');
                    if (durationElem && durationElem.textContent) {
                        const duration = parseInt(durationElem.textContent.trim(), 10);
                        if (!isNaN(duration)) {
                            result.duration = duration;
                            result.durationFormatted = formatDuration(duration);
                        }
                    }

                    const widthElem = media.querySelector('width');
                    const heightElem = media.querySelector('height');
                    if (widthElem && heightElem) {
                        const width = parseFloat(widthElem.textContent?.trim());
                        const height = parseFloat(heightElem.textContent?.trim());
                        if (!isNaN(width) && !isNaN(height)) {
                            result.width = width;
                            result.height = height;
                            result.resolution = `${width} × ${height}`;
                        }
                    }
                }

                const nickname = finderFeed.querySelector('nickname');
                const username = finderFeed.querySelector('username');
                if (nickname && nickname.textContent) result.nickname = nickname.textContent.trim();
                if (username && username.textContent) result.username = username.textContent.trim();
                return result;
            }

            // 检查是否为 B站 的小程序卡片或链接分享卡片 (<appmsg>)
            const appmsg = xmlDoc.querySelector('appmsg');
            if (appmsg) {
                const titleElem = appmsg.querySelector('title');
                const urlElem = appmsg.querySelector('url');
                const pagepathElem = appmsg.querySelector('weappinfo > pagepath');
                if (titleElem && titleElem.textContent) {
                    result.description = titleElem.textContent.trim();
                }
                const rawUrl = urlElem?.textContent?.trim() || '';
                const rawPagePath = pagepathElem?.textContent?.trim() || '';
                const combined = `${rawUrl} ${rawPagePath}`;

                const cardBv = combined.match(/(BV[0-9A-Za-z]{10})/) || bvMatch;
                const cardB23 = combined.match(/https?:\/\/b23\.tv\/[0-9A-Za-z_-]+/i) || b23Match;
                const cardAv = combined.match(/aid=(\d+)|av(\d+)/i);

                if (cardBv || cardB23 || cardAv || combined.includes('bilibili.com') || combined.includes('b23.tv')) {
                    result.platform = 'bilibili';
                    result.bvid = cardBv ? cardBv[1] : null;
                    result.aid = cardAv ? (cardAv[1] || cardAv[2]) : null;
                    result.shareUrl = cardB23 ? cardB23[0] : (rawUrl || (result.bvid ? `https://www.bilibili.com/video/${result.bvid}` : null));
                    return result;
                }
            }
        }

        // 正则兜底识别 B站
        if (bvMatch || b23Match || biliUrlMatch) {
            result.platform = 'bilibili';
            result.bvid = bvMatch ? bvMatch[1] : null;
            result.shareUrl = b23Match ? b23Match[0] : (biliUrlMatch ? biliUrlMatch[0] : `https://www.bilibili.com/video/${result.bvid}`);
            return result;
        }
    } catch (error) {
        console.warn('⚠️ 解析消息卡片异常:', error);
    }

    return result;
}

/**
 * 从普通文本消息 (MsgType === 1) 中识别 B站 或 抖音 分享链接
 */
function extractTextShareLink(text) {
    if (!text || typeof text !== 'string') return null;

    const cleanText = text.replace(/<[^>]+>/g, '').trim();

    // 1. 匹配 B站 b23.tv 短链、bilibili.com 链接或纯 BV 号
    const b23Match = cleanText.match(/https?:\/\/b23\.tv\/[0-9A-Za-z_-]+/i);
    const biliMatch = cleanText.match(/https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i);
    const bvOnlyMatch = cleanText.match(/\b(BV[0-9A-Za-z]{10})\b/);

    if (b23Match || biliMatch || bvOnlyMatch) {
        const bvid = (biliMatch && biliMatch[1]?.startsWith('BV'))
            ? biliMatch[1]
            : (bvOnlyMatch ? bvOnlyMatch[1] : null);
        return {
            platform: 'bilibili',
            bvid,
            shareUrl: b23Match ? b23Match[0] : (biliMatch ? biliMatch[0] : `https://www.bilibili.com/video/${bvid}`),
            description: 'B站视频'
        };
    }

    // 2. 匹配抖音分享口令中的短链 (v.douyin.com / www.douyin.com / iesdouyin.com)
    const dyMatch = cleanText.match(/https?:\/\/(?:v\.douyin\.com\/[0-9A-Za-z_-]+\/?|(?:www\.)?(?:douyin|iesdouyin)\.com\/(?:video|share\/video)\/\d+)/i);
    if (dyMatch) {
        return {
            platform: 'douyin',
            shareUrl: dyMatch[0],
            description: cleanText.replace(dyMatch[0], '').trim().slice(0, 60) || '抖音视频'
        };
    }

    return null;
}

/**
 * 递归从任意视频号网页 JSON 响应中嗅探视频流
 */
function sniffDirectFinderMedia(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 7) return null;

    if (Array.isArray(obj)) {
        for (const item of obj) {
            const found = sniffDirectFinderMedia(item, depth + 1);
            if (found) return found;
        }
        return null;
    }

    const decodeKey = obj.decodeKey || obj.decode_key || '';
    const mediaUrl = obj.url || obj.mediaUrl || '';
    if (
        typeof mediaUrl === 'string' &&
        (mediaUrl.includes('finder.video.qq.com') || mediaUrl.includes('qq.com')) &&
        (decodeKey || mediaUrl.includes('.mp4'))
    ) {
        return {
            platform: 'channels',
            type: 1,
            url: mediaUrl + (obj.urlToken || obj.url_token || ''),
            decodeKey: String(decodeKey || ''),
            title: obj.description || obj.desc || obj.title || document.title || '视频号视频',
            photo: obj.thumbUrl || obj.thumb_url || obj.coverUrl || ''
        };
    }

    for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (val && typeof val === 'object') {
            const found = sniffDirectFinderMedia(val, depth + 1);
            if (found) {
                if (!found.title && (obj.description || obj.desc)) {
                    found.title = obj.description || obj.desc;
                }
                return found;
            }
        }
    }
    return null;
}

// 防止同一条消息重复触发
const processedMsgIds = new Set();

ah.proxy({
    onRequest(config, handler) {
        handler.next(config);
    },
    onError(err, handler) {
        handler.next(err);
    },
    onResponse(response, handler) {
        try {
            // 1. 拦截网页版文件传输助手的 /webwxsync 消息同步接口
            if (response.config.method === 'POST' && response.config.url.includes('/webwxsync')) {
                const responseObj = JSON.parse(response.response);

                if (responseObj.AddMsgList && Array.isArray(responseObj.AddMsgList)) {
                    responseObj.AddMsgList.forEach((msg, index) => {
                        const msgId = String(msg.MsgId || msg.NewMsgId || `${index}_${Date.now()}`);
                        if (processedMsgIds.has(msgId)) return;

                        // 忽略插件自己刚刚发出的状态提示消息
                        if (typeof msg.Content === 'string' && (
                            msg.Content.includes('视频号下载助手') ||
                            msg.Content.includes('🎬【视频标题】') ||
                            msg.Content.includes('⚡ 已收到') ||
                            msg.Content.includes('正在解密') ||
                            msg.Content.includes('已解密') ||
                            msg.Content.includes('解密失败') ||
                            msg.Content.includes('没能发回') ||
                            msg.Content.includes('20MB') ||
                            msg.Content.includes('✅ 视频已') ||
                            msg.Content.includes('✅ 图集 ZIP') ||
                            msg.Content.includes('⚠️ 自动下载') ||
                            msg.Content.includes('⚠️ B站') ||
                            msg.Content.includes('⚠️ 抖音')
                        )) {
                            return;
                        }

                        // A. MsgType === 49：应用卡片消息（视频号卡片 / B站小程序卡片 / 网页链接卡片）
                        if (msg.MsgType === 49 && msg.Content) {
                            const info = extractMsgCardOrVideoInfo(msg.Content);

                            if (info.platform === 'channels' && info.o_id && info.n_id) {
                                processedMsgIds.add(msgId);
                                console.log(`%c✓ [视频号卡片] 提取成功`, 'color: #0070f3; font-weight: bold;', info);

                                window.postMessage({
                                    type: 'hook2content_getResponseText',
                                    platform: 'channels',
                                    data: {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            objectId: info.o_id,
                                            objectNonceId: info.n_id,
                                            description: info.description || '',
                                            source: true
                                        })
                                    }
                                }, '*');
                            } else if (info.platform === 'bilibili' && (info.bvid || info.shareUrl || info.aid)) {
                                processedMsgIds.add(msgId);
                                console.log(`%c✓ [B站卡片] 提取成功`, 'color: #ff0080; font-weight: bold;', info);

                                window.postMessage({
                                    type: 'hook2content_thirdPartyVideo',
                                    platform: 'bilibili',
                                    data: {
                                        bvid: info.bvid,
                                        aid: info.aid,
                                        shareUrl: info.shareUrl,
                                        title: info.description || 'B站视频'
                                    }
                                }, '*');
                            }
                        }

                        // B. MsgType === 1：普通文本消息（识别 B站 与 抖音 分享链接）
                        if (msg.MsgType === 1 && msg.Content) {
                            const linkInfo = extractTextShareLink(msg.Content);
                            if (linkInfo && (linkInfo.platform === 'bilibili' || linkInfo.platform === 'douyin')) {
                                processedMsgIds.add(msgId);
                                console.log(`%c✓ [${linkInfo.platform === 'bilibili' ? 'B站' : '抖音'}文本分享链接] 提取成功`, 'color: #0070f3; font-weight: bold;', linkInfo);

                                window.postMessage({
                                    type: 'hook2content_thirdPartyVideo',
                                    platform: linkInfo.platform,
                                    data: linkInfo
                                }, '*');
                            }
                        }
                    });
                }
            } else if (
                typeof response.response === 'string' &&
                (response.response.includes('decodeKey') ||
                 response.response.includes('decode_key') ||
                 response.response.includes('finder.video.qq.com'))
            ) {
                const jsonObj = JSON.parse(response.response);
                const directMedia = sniffDirectFinderMedia(jsonObj);
                if (directMedia && directMedia.url) {
                    window.postMessage({
                        type: 'hook2content_directMedia',
                        data: directMedia
                    }, '*');
                }
            }
        } catch (error) {
            // 忽略非 JSON 解析异常
        }
        handler.next(response);
    }
});
