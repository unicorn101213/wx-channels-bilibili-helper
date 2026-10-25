// ============= 注入脚本到页面上下文 =============
function injectScript(src) {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(src);
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
}

/**
 * 自动发送消息到微信文件传输助手
 * @param {string} message - 要发送的消息内容
 * @returns {Promise<boolean>} 发送成功返回true，否则false
 */
async function sendMessageToWeChat(message) {
    try {
        // 多种选择器来找输入框
        const inputSelectors = [
            'textarea.chat-panel__input-container',
            'input[type="text"][placeholder*="说点什么"]',
            'input[type="text"][data-testid="composerInput"]',
            '[contenteditable="true"][data-testid="composerInput"]',
            '.tt-input__inner',
            'input[type="text"]:not([type="hidden"])',
            'textarea'
        ];

        let inputElement = null;
        for (let selector of inputSelectors) {
            inputElement = document.querySelector(selector);
            if (inputElement) break;
        }

        if (!inputElement) {
            console.warn('⚠️ 当前页面非微信聊天页，跳过发送聊天消息');
            return false;
        }

        console.log('✅ 找到输入框:', inputElement);

        // 设置输入框焦点
        inputElement.focus();

        // 不同方式设置输入内容
        if (inputElement.contentEditable === 'true') {
            // contenteditable 元素
            inputElement.innerText = message;
            inputElement.textContent = message;
        } else {
            // input 或 textarea
            inputElement.value = message;
        }

        // 触发input事件
        const inputEvent = new Event('input', { bubbles: true });
        inputElement.dispatchEvent(inputEvent);

        // 触发change事件
        const changeEvent = new Event('change', { bubbles: true });
        inputElement.dispatchEvent(changeEvent);

        // 触发keyup事件
        const keyUpEvent = new KeyboardEvent('keyup', { bubbles: true });
        inputElement.dispatchEvent(keyUpEvent);

        // 等待一下UI更新
        await new Promise(resolve => setTimeout(resolve, 300));

        // 多种方式找发送按钮
        const buttonSelectors = [
            '.chat-send__button:not(.chat-send__button__disabled)',
            '.chat-send__button',
            'button[aria-label*="发送"]',
            'button[data-testid="composerSendButton"]',
            '.tt-button--primary',
            'button[title*="发送"]',
            'div[role="button"][data-testid="composerSendButton"]',

        ];

        let sendButton = null;
        for (let selector of buttonSelectors) {
            const elements = document.querySelectorAll(selector);
            console.log(`🔍 选择器 "${selector}" 找到 ${elements.length} 个元素`);

            for (let elem of elements) {
                // 跳过disabled的按钮
                if (elem.classList.contains('chat-send__button__disabled')) {
                    console.log('⏭️  跳过 disabled 按钮');
                    continue;
                }
                sendButton = elem;
                break;
            }
            if (sendButton) break;
        }

        // 如果还没找到，尝试用包含"发送"文本的按钮
        if (!sendButton) {
            console.log('🔍 尝试通过文本查找发送按钮...');
            const buttons = document.querySelectorAll('button, div[role="button"]');
            console.log(`找到 ${buttons.length} 个可点击元素`);

            for (let btn of buttons) {
                const text = btn.textContent.trim();
                const aria = btn.getAttribute('aria-label') || '';

                if (text.includes('发送') || aria.includes('发送')) {
                    if (!btn.classList.contains('chat-send__button__disabled')) {
                        console.log('✅ 通过文本找到发送按钮:', text || aria);
                        sendButton = btn;
                        break;
                    }
                }
            }
        }

        if (!sendButton) {
            console.warn('⚠️ 未找到发送按钮，请检查页面DOM结构');
            return false;
        }

        console.log('✅ 找到发送按钮:', sendButton);

        // 确保按钮可见且不是disabled
        if (sendButton.classList.contains('chat-send__button__disabled')) {
            console.warn('⚠️ 发送按钮是disabled状态');
            return false;
        }

        // 点击发送按钮
        sendButton.click();

        console.log('✅ 已发送消息:', message.substring(0, 50) + '...');

        return true;
    } catch (error) {
        console.warn('⚠️ 发送消息出错:', error);
        return false;
    }
}

/**
 * 自动将解密后的文件（MP4 / ZIP）上传并发送回网页版微信文件传输助手对话框
 * 这样手机端和电脑端微信可以直接点击播放或直接转发给别人
 * @param {Uint8Array} uint8Data - 解密后的二进制数据
 * @param {string} filename - 文件名（如 xxx.mp4）
 * @param {string} mimeType - MIME 类型
 * @returns {Promise<boolean>}
 */
async function sendFileToWeChat(uint8Data, filename, mimeType = 'video/mp4') {
    try {
        const file = new File([uint8Data], filename, {
            type: mimeType,
            lastModified: Date.now()
        });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);

        // 优先查找页面上的文件上传 input[type="file"]
        const fileInputs = document.querySelectorAll('input[type="file"]');
        if (fileInputs.length > 0) {
            const fileInput = document.querySelector('.chat-panel input[type="file"]') || fileInputs[fileInputs.length - 1];
            const textInput = document.querySelector('textarea.chat-panel__input-container, textarea, [contenteditable="true"]');
            if (textInput && 'value' in textInput) {
                textInput.value = '';
                textInput.dispatchEvent(new Event('input', { bubbles: true }));
            }

            fileInput.files = dataTransfer.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            fileInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));

            // 选中文件后如果输入框还留着文件，说明页面在等发送键，补一次点击
            await new Promise(resolve => setTimeout(resolve, 800));
            if (fileInput.files && fileInput.files.length > 0) {
                const sendButton = document.querySelector('.chat-send__button:not(.chat-send__button__disabled)')
                    || document.querySelector('.chat-send__button');
                if (sendButton && !sendButton.classList.contains('chat-send__button__disabled')) {
                    sendButton.click();
                }
            }

            console.log('✅ 已通过 input[type="file"] 自动回传解密后的文件到微信传输助手:', filename);
            return true;
        }

        // 兜底方案：向聊天输入区派发 paste / drop 事件
        const target =
            document.querySelector('textarea.chat-panel__input-container') ||
            document.querySelector('.chat-panel') ||
            document.body;

        if (target) {
            const dropEvent = new DragEvent('drop', {
                bubbles: true,
                cancelable: true,
                dataTransfer
            });
            target.dispatchEvent(dropEvent);
            console.log('✅ 已通过 DragDrop 自动回传解密后的文件到微信传输助手:', filename);
            return true;
        }

        console.warn('⚠️ 未找到文件上传控件');
        return false;
    } catch (error) {
        console.warn('⚠️ 自动回传文件到微信传输助手失败:', error);
        return false;
    }
}

/**
 * 消息队列管理器 - 确保消息有序发送
 */
class MessageQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        this.maxRetries = 3;
        this.delayBetweenMessages = 1000; // 消息间延迟
    }

    /**
     * 添加消息到队列
     */
    add(message) {
        this.queue.push({
            content: message,
            retries: 0,
            timestamp: Date.now()
        });
        console.log(`📋 消息已入队，当前队列长度: ${this.queue.length}`);
        this.process();
    }

    /**
     * 批量添加消息
     */
    addBatch(messages) {
        messages.forEach((msg, index) => {
            this.queue.push({
                content: msg,
                retries: 0,
                timestamp: Date.now(),
                order: index + 1,
                total: messages.length
            });
        });
        console.log(`📋 批量入队 ${messages.length} 条消息`);
        this.process();
    }

    /**
     * 处理队列中的消息
     */
    async process() {
        if (this.isProcessing || this.queue.length === 0) {
            return;
        }

        this.isProcessing = true;

        while (this.queue.length > 0) {
            const msg = this.queue[0];
            const success = await this.sendWithRetry(msg);

            if (success) {
                this.queue.shift();
                console.log(`✅ 消息已发送 (${msg.order || 1}/${msg.total || 1})`);

                // 消息间延迟
                if (this.queue.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, this.delayBetweenMessages));
                }
            } else {
                console.warn(`⚠️ 消息发送失败，已从队列移除 (重试 ${msg.retries}/${this.maxRetries})`);
                this.queue.shift();
                break;
            }
        }

        this.isProcessing = false;
        console.log(`✅ 消息队列处理完成`);
    }

    /**
     * 带重试的发送逻辑
     */
    async sendWithRetry(msgObj) {
        while (msgObj.retries < this.maxRetries) {
            try {
                const success = await sendMessageToWeChat(msgObj.content);
                if (success) {
                    return true;
                }
                msgObj.retries++;
                console.warn(`⚠️ 发送失败，准备重试... (${msgObj.retries}/${this.maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                msgObj.retries++;
                console.warn(`⚠️ 发送异常:`, error);
            }
        }
        return false;
    }

    /**
     * 设置消息间延迟
     */
    setDelay(ms) {
        this.delayBetweenMessages = ms;
    }

    /**
     * 获取队列状态
     */
    getStatus() {
        return {
            pending: this.queue.length,
            isProcessing: this.isProcessing,
            queue: this.queue
        };
    }

    /**
     * 清空队列
     */
    clear() {
        this.queue = [];
        console.log('🗑️ 消息队列已清空');
    }
}

// 创建全局消息队列实例
const messageQueue = new MessageQueue();

// 文字回发和文件回传必须排队，避免“请稍候”还在发送时就把文件塞进输入框
let chatChain = Promise.resolve();
function runInChatOrder(task) {
    const run = chatChain.then(task, task);
    chatChain = run.then(() => {}, () => {});
    return run;
}

// 注入 hook 脚本
injectScript('ajaxhook.min.js');

// ============= 监听来自注入脚本的消息 =============
window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data) return;

    if (event.data.type === 'hook2content_getResponseText') {
        console.log('捕获视频号请求:', event.data);
        runInChatOrder(async () => {
            const res = await chrome.runtime.sendMessage({
                action: 'content2back_downloadMP4',
                data: event.data
            });
            if (res && !res.success) {
                await sendMessageToWeChat(res.message);
            }
        });
    }

    if (event.data.type === 'hook2content_thirdPartyVideo') {
        const platformName = event.data.platform === 'bilibili' ? 'B站' : '抖音';
        console.log(`捕获${platformName}请求:`, event.data);
        runInChatOrder(async () => {
            const res = await chrome.runtime.sendMessage({
                action: 'content2back_thirdPartyVideo',
                platform: event.data.platform,
                data: event.data.data
            });
            if (res && !res.success) {
                await sendMessageToWeChat(res.message);
            }
        });
    }

    if (event.data.type === 'hook2content_directMedia') {
        console.log('直接嗅探到媒资:', event.data.data);
        await chrome.runtime.sendMessage({
            action: 'content2back_directMediaCaptured',
            data: event.data.data
        });
    }
});

// ============= 监听来自 background 的下载命令 =============
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'back2content_downloadVideo') {
        const responseData = request.payload;
        const saveToLocalDisk = Boolean(request.saveToLocalDisk);
        console.log('📥 接收到解析结果:', responseData, '保存到本地硬盘:', saveToLocalDisk);

        runInChatOrder(() => handleDownload(responseData, sendResponse, saveToLocalDisk));
        return true; // 异步处理
    }

    if (request.action === 'back2content_postVideoInfo') {
        const { title, url, encryption } = request.data;

        console.log('📹 接收到视频信息，准备发送消息...');

        // 加密视频号不再把封面地址贴进对话。微信会把这种图片地址展开成一张图，看起来像在转圈，真正的 mp4 却还没发出来。
        const message4 = encryption
            ? `正在解密「${title || '未命名视频'}」，完成后会把可播放的 mp4 发到这里。`
            : `🎬【视频标题】：\n${title || '未命名视频'}\n\n【视频直链（可直接点击或复制下载）】：\n${url || '无'}`;

        runInChatOrder(() => sendMessageToWeChat(message4));
        sendResponse({
            success: true,
            message: '已添加到消息队列'
        });
    }
});

// ============= 处理下载逻辑 =============
async function handleDownload(responseData, sendResponse, saveToLocalDisk = false) {
    try {
        const { code, msg, data } = responseData;

        if (code !== 200) {
            throw new Error(msg || '解析失败');
        }

        const { title, type, encryption, url, eurl, other, preFetchedBase64 } = data;
        const decodeKey = other?.decodeKey;

        console.log('📋 内容信息:', {
            标题: title,
            类型: type === 1 ? '视频' : '图集',
            加密: encryption,
            解密密钥: decodeKey,
            文件大小: other?.fileSize
        });

        // 处理不同类型
        if (type === 1) {
            // 视频处理
            const videoUrl = encryption ? eurl : url;
            if (!videoUrl && !preFetchedBase64) {
                throw new Error('未获取到视频下载地址');
            }

            if (encryption && !decodeKey) {
                throw new Error('视频已加密但缺少解密密钥');
            }

            console.log(`🎬 开始处理${encryption ? '加密' : ''}视频...`);
            await downloadAndDecryptVideo(videoUrl, decodeKey, encryption, title, sendResponse, preFetchedBase64, saveToLocalDisk);

        } else if (type === 2) {
            // 图集处理
            console.log('🖼️ 下载图集...');
            await downloadImageSetAsZip(data.pics, title, sendResponse, saveToLocalDisk);

        } else {
            throw new Error('未知的内容类型');
        }

    } catch (error) {
        console.warn('⚠️ 下载异常:', error);
        sendResponse({
            success: false,
            message: error.message
        });
    }
}

const WECHAT_UPLOAD_LIMIT = 20 * 1024 * 1024;

async function sendMp4BackOrHint(bytes, filename, saveToLocalDisk, alreadyPlain) {
    if (saveToLocalDisk) {
        downloadFile(bytes, filename);
    }

    const sizeMb = (bytes.byteLength / 1024 / 1024).toFixed(1);
    if (bytes.byteLength > WECHAT_UPLOAD_LIMIT) {
        await sendMessageToWeChat(`这个视频有 ${sizeMb} MB，超过网页版文件传输助手大约 20MB 的限制，没有发回对话框。请点浏览器右上角插件里这条记录的「解密下载」，直接保存到电脑。`);
        return false;
    }

    const lead = alreadyPlain ? `视频有 ${sizeMb} MB` : `已解密 ${sizeMb} MB`;
    await sendMessageToWeChat(`${lead}，正在把 mp4 发回对话框。`);
    return sendFileToWeChat(bytes, filename, 'video/mp4');
}

function sanitizeContentFilename(title) {
    if (!title || typeof title !== 'string') {
        return '视频号视频';
    }
    return title.replace(/[<>:"|?*\/\n\r\\]/g, '_').trim().slice(0, 80) || '视频号视频';
}

function isPlayableMp4(bytes) {
    return bytes && bytes.length > 8
        && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}

function decryptUntilPlayable(bytes, enclenStr, decodeKey) {
    if (isPlayableMp4(bytes)) {
        return;
    }

    const headerLen = parseInt(enclenStr, 10);
    const candidates = [];
    if (headerLen > 0) candidates.push(headerLen);
    candidates.push(131072);
    candidates.push(bytes.length);

    const tried = new Set();
    for (const len of candidates) {
        const n = Math.min(bytes.length, len);
        if (!n || tried.has(n)) continue;
        tried.add(n);
        decryptData(bytes, n, String(decodeKey));
        if (isPlayableMp4(bytes)) return;
        decryptData(bytes, n, String(decodeKey));
    }

    throw new Error('解密后仍不是可播放的 MP4');
}

function fetchVideoBytesViaPort(url) {
    return new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'fetch-binary' });
        const chunks = [];
        let enclen = '';
        let settled = false;

        const finish = (fn) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { port.disconnect(); } catch (e) {}
            fn();
        };

        const timer = setTimeout(() => {
            finish(() => reject(new Error('下载超时')));
        }, 180000);

        port.onDisconnect.addListener(() => {
            if (!settled) {
                finish(() => reject(new Error('下载中断')));
            }
        });

        port.onMessage.addListener((msg) => {
            if (msg.type === 'meta') {
                enclen = msg.enclen || '';
            } else if (msg.type === 'chunk' && msg.chunk) {
                chunks.push(new Uint8Array(msg.chunk));
            } else if (msg.type === 'done') {
                const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
                const bytes = new Uint8Array(total);
                let offset = 0;
                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.length;
                }
                finish(() => resolve({ bytes, enclen }));
            } else if (msg.type === 'error') {
                finish(() => reject(new Error(msg.message || '后台下载失败')));
            }
        });

        port.postMessage({ type: 'start', url });
    });
}

async function fetchVideoBytes(url) {
    const videoUrl = String(url || '').replace(/^http:\/\//i, 'https://');
    try {
        const response = await fetch(videoUrl, { method: 'GET', signal: AbortSignal.timeout(180000) });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length) {
            throw new Error('视频内容为空');
        }
        return { bytes, enclen: response.headers.get('X-enclen') || '' };
    } catch (err) {
        console.warn('页面直接拉取失败，改由后台分段拉取', err);
        const viaPort = await fetchVideoBytesViaPort(videoUrl);
        if (!viaPort.bytes?.length) {
            throw new Error(err?.message || '拉取视频流失败');
        }
        return viaPort;
    }
}

// ============= 视频下载和解密函数 =============
async function downloadAndDecryptVideo(url, decodeKey, isEncrypted, title, sendResponse, preFetchedBase64 = '', saveToLocalDisk = false) {
    try {
        console.log('⏳ 下载中...');

        let encryptedBuffer = null;
        let enclenStr = '';

        if (preFetchedBase64) {
            const binaryStr = atob(preFetchedBase64);
            encryptedBuffer = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
                encryptedBuffer[i] = binaryStr.charCodeAt(i);
            }
        } else {
            const fetched = await fetchVideoBytes(url);
            encryptedBuffer = fetched.bytes;
            enclenStr = fetched.enclen || '';
        }

        console.log(`📦 下载完成，数据长度: ${encryptedBuffer.byteLength}`);

        const safeFilename = `${sanitizeContentFilename(title)}.mp4`;

        if (isEncrypted) {
            console.log('⏳ 解密中...');

            try {
                decryptUntilPlayable(encryptedBuffer, enclenStr, decodeKey);
                console.log('✅ 解密完成');
                const uploaded = await sendMp4BackOrHint(encryptedBuffer, safeFilename, saveToLocalDisk, false);
                if (!uploaded && encryptedBuffer.byteLength <= WECHAT_UPLOAD_LIMIT) {
                    await sendMessageToWeChat(`解密失败：mp4 已解密，但没能发回对话框。可点插件里的「解密下载」。`);
                }

                sendResponse({
                    success: uploaded,
                    message: uploaded ? '视频解密并回传成功' : '解密成功但回传失败'
                });
            } catch (decryptError) {
                console.warn('⚠️ 解密失败:', decryptError);
                await sendMessageToWeChat(`解密失败：${decryptError.message}`);
                sendResponse({
                    success: false,
                    message: '解密失败: ' + decryptError.message
                });
            }

        } else {
            // 无需解密（如 B站 / 抖音 / 未加密视频号），直接回传文件至微信对话框
            console.log('✅ 获取完成（无需解密）');
            await sendMp4BackOrHint(encryptedBuffer, safeFilename, saveToLocalDisk, true);

            sendResponse({
                success: true,
                message: '视频处理并回传成功'
            });
        }

    } catch (error) {
        console.warn('⚠️ 自动下载受阻:', error);
        sendMessageToWeChat(`⚠️ 自动下载受阻（可点击浏览器右上角插件图标点“解密下载”）：${error.message}`);
        sendResponse({
            success: false,
            message: error.message
        });
    }
}

// ============= 图集下载函数 =============
async function downloadImageSet(pics, title, sendResponse) {
    try {
        if (!Array.isArray(pics) || pics.length === 0) {
            throw new Error('图集为空');
        }

        console.log(`📸 共 ${pics.length} 张图片`);

        for (let i = 0; i < pics.length; i++) {
            const picUrl = pics[i];
            console.log(`📥 下载图片 ${i + 1}/${pics.length}...`);

            const response = await fetch(picUrl);
            if (!response.ok) {
                console.warn(`⚠️ 图片 ${i + 1} 下载失败`);
                continue;
            }

            const blob = await response.blob();
            downloadFile(new Uint8Array(await blob.arrayBuffer()), `${title || 'pic'}_${i + 1}.jpg`);

            // 避免请求过快
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        console.log('✅ 图集下载完成');
        sendResponse({
            success: true,
            message: `图集下载完成（${pics.length}张）`
        });

    } catch (error) {
        console.warn('⚠️ 图集下载错误:', error);
        sendResponse({
            success: false,
            message: error.message
        });
    }
}

// ============= 文件下载函数 =============
function downloadFile(data, filename) {
    try {
        console.log('💾 保存文件:', filename);

        // 创建 Blob
        const blob = new Blob([data], { type: 'video/mp4' });

        // 创建下载链接
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        a.style.display = 'none';

        document.body.appendChild(a);
        a.click();

        // 清理资源
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
        }, 100);

        console.log('✅ 文件保存成功');
    } catch (error) {
        console.warn('⚠️ 文件保存失败:', error);
    }
}

// ============= 图集 ZIP 下载函数（新增） =============
async function downloadImageSetAsZip(pics, title, sendResponse, saveToLocalDisk = false) {
    try {
        // 中文注释：先校验后端返回的 pics 是否可用
        if (!Array.isArray(pics) || pics.length === 0) {
            throw new Error('图集为空');
        }

        console.log(`📸 共 ${pics.length} 张图片，开始按顺序下载并打包 ZIP`);

        // 中文注释：生成 CRC32 查表，ZIP 每个文件都要 CRC32
        const crcTable = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let j = 0; j < 8; j++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            crcTable[i] = c >>> 0;
        }

        // 中文注释：准备 DOS 时间日期（ZIP 标准头字段）
        const now = new Date();
        const dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((Math.floor(now.getSeconds() / 2)) & 0x1f);
        const safeYear = Math.min(2107, Math.max(1980, now.getFullYear()));
        const dosDate = (((safeYear - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);

        // 中文注释：ZIP 内容区（本地头+数据）和中央目录区分开累积，最后再拼接
        const textEncoder = new TextEncoder();
        const localParts = [];
        const centralParts = [];
        let localOffset = 0;

        // 中文注释：严格顺序下载，命名按你的要求固定为 0.png、1.png...
        for (let i = 0; i < pics.length; i++) {
            const picUrl = String(pics[i] || '').trim();
            if (!picUrl) {
                throw new Error(`第 ${i + 1} 张图片地址为空`);
            }

            console.log(`📥 下载图片 ${i + 1}/${pics.length}: ${picUrl}`);
            const response = await fetch(picUrl.replace(/^http:\/\//i, 'https://'), { method: 'GET' });
            if (!response.ok) {
                throw new Error(`第 ${i + 1} 张图片下载失败: ${response.status} ${response.statusText}`);
            }

            // 中文注释：取原始字节，不做图片重编码，直接入包
            const fileData = new Uint8Array(await response.arrayBuffer());
            const fileName = `${i}.png`;
            const fileNameBytes = textEncoder.encode(fileName);

            // 中文注释：计算当前文件 CRC32
            let crc32 = 0xFFFFFFFF;
            for (let k = 0; k < fileData.length; k++) {
                crc32 = (crc32 >>> 8) ^ crcTable[(crc32 ^ fileData[k]) & 0xFF];
            }
            crc32 = (crc32 ^ 0xFFFFFFFF) >>> 0;

            // 中文注释：写 ZIP 本地文件头（method=0 表示不压缩）
            const localHeader = new Uint8Array(30 + fileNameBytes.length);
            const localView = new DataView(localHeader.buffer);
            localView.setUint32(0, 0x04034B50, true);
            localView.setUint16(4, 20, true);
            localView.setUint16(6, 0, true);
            localView.setUint16(8, 0, true);
            localView.setUint16(10, dosTime, true);
            localView.setUint16(12, dosDate, true);
            localView.setUint32(14, crc32, true);
            localView.setUint32(18, fileData.length, true);
            localView.setUint32(22, fileData.length, true);
            localView.setUint16(26, fileNameBytes.length, true);
            localView.setUint16(28, 0, true);
            localHeader.set(fileNameBytes, 30);
            localParts.push(localHeader, fileData);

            // 中文注释：写中央目录头，并记录本地头偏移
            const centralHeader = new Uint8Array(46 + fileNameBytes.length);
            const centralView = new DataView(centralHeader.buffer);
            centralView.setUint32(0, 0x02014B50, true);
            centralView.setUint16(4, 20, true);
            centralView.setUint16(6, 20, true);
            centralView.setUint16(8, 0, true);
            centralView.setUint16(10, 0, true);
            centralView.setUint16(12, dosTime, true);
            centralView.setUint16(14, dosDate, true);
            centralView.setUint32(16, crc32, true);
            centralView.setUint32(20, fileData.length, true);
            centralView.setUint32(24, fileData.length, true);
            centralView.setUint16(28, fileNameBytes.length, true);
            centralView.setUint16(30, 0, true);
            centralView.setUint16(32, 0, true);
            centralView.setUint16(34, 0, true);
            centralView.setUint16(36, 0, true);
            centralView.setUint32(38, 0, true);
            centralView.setUint32(42, localOffset, true);
            centralHeader.set(fileNameBytes, 46);
            centralParts.push(centralHeader);

            // 中文注释：偏移指针移动到下一个本地头起点
            localOffset += localHeader.length + fileData.length;

            // 中文注释：稍微降速，避免短时间内并发太猛
            await new Promise(resolve => setTimeout(resolve, 120));
        }

        // 中文注释：写 ZIP 结束记录 EOCD
        const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
        const eocd = new Uint8Array(22);
        const eocdView = new DataView(eocd.buffer);
        eocdView.setUint32(0, 0x06054B50, true);
        eocdView.setUint16(4, 0, true);
        eocdView.setUint16(6, 0, true);
        eocdView.setUint16(8, centralParts.length, true);
        eocdView.setUint16(10, centralParts.length, true);
        eocdView.setUint32(12, centralSize, true);
        eocdView.setUint32(16, localOffset, true);
        eocdView.setUint16(20, 0, true);

        // 中文注释：拼接出 ZIP 二进制并回传微信（按开关决定是否同时落盘到本地）
        const zipBlob = new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
        const safeTitle = sanitizeContentFilename(title || '图集');
        const zipData = new Uint8Array(await zipBlob.arrayBuffer());
        if (saveToLocalDisk) {
            downloadFileByMime(zipData, `${safeTitle}.zip`, 'application/zip');
        }
        await sendFileToWeChat(zipData, `${safeTitle}.zip`, 'application/zip');

        console.log('✅ 图集 ZIP 下载完成');
        sendMessageToWeChat(`✅ 图集 ZIP 下载完成（${pics.length} 张，已打包 ZIP 并回传）`);
        sendResponse({
            success: true,
            message: `图集下载完成（${pics.length} 张，已打包 ZIP）`
        });
    } catch (error) {
        console.warn('⚠️ 图集 ZIP 下载失败:', error);
        sendMessageToWeChat('❌ 图集 ZIP 下载失败:', error)
        sendResponse({
            success: false,
            message: String(error?.message || error || '图集下载失败')
        });
    }
}

// ============= 通用 MIME 下载函数（新增） =============
function downloadFileByMime(data, filename, mimeType) {
    try {
        // 中文注释：这里专门支持 zip 等非视频 MIME
        const blob = new Blob([data], { type: mimeType || 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
        }, 100);
    } catch (error) {
        console.warn('⚠️ 通用文件保存失败:', error);
    }
}

// ============= DOM 加载完成通知 =============
document.addEventListener("DOMContentLoaded", function () {
    console.log('✅ DOM 加载完成');
    chrome.runtime.sendMessage({ action: "content2back_completePage" });
});
