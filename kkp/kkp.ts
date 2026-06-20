import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";


// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#x27;",
      }[m] || m),
  );

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 帮助文本
const help_text = `🎲 <b>随机色色视频获取</b>

<b>命令：</b>
• <code>${mainPrefix}kkp</code> - 从SeSe3000Bot获取随机视频并转发


<b>说明：</b>
该插件会自动与SeSe3000Bot交互获取随机视频内容`;

class KkpPlugin extends Plugin {

  description: string = `🎲 随机色色视频获取<br><br>${help_text}`;

  // 存储等待回复的消息监听器
  private messageListeners: Map<
    string,
    {
      resolve: (message: any | null) => void;
      timeout: NodeJS.Timeout;
      startTime: number;
      handler: (event: any) => void;
    }
  > = new Map();

  cmdHandlers: Record<string, (msg: MessageContext, trigger?: MessageContext) => Promise<void>> = {
    kkp: async (msg: MessageContext) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: html`❌ 客户端未初始化` });
        return;
      }

      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts;
      const sub = (args[0] || "").toLowerCase();

      try {
        if (sub === "help" || sub === "h") {
          await msg.edit({ text: html(help_text) });
          return;
        }

        if (sub && sub !== "help" && sub !== "h") {
          await msg.edit({
            text: html`❌ <b>未知命令:</b> <code>${htmlEscape(sub)}</code>`,
          });
          return;
        }

        await this.getRandomVideo(msg, client);
      } catch (error: any) {
        console.error("[kkp] 插件执行失败:", error);
        await msg.edit({
          text: html`❌ <b>插件执行失败:</b> ${htmlEscape(error.message || "未知错误")}`,
        });
      }
    },
  };

  private extractPlainText(message: any): string {
    const fullText = message.text || message.message || "";
    if (!fullText) return "";

    if (!message.entities || message.entities.length === 0) return fullText;

    const excludedRanges: Array<{ offset: number; length: number }> = [];
    for (const entity of message.entities) {
      const eType = entity._ || entity.className || "";
      if (
        ["messageEntityHashtag", "MessageEntityHashtag",
         "messageEntityTextUrl", "MessageEntityTextUrl",
         "messageEntityUrl", "MessageEntityUrl"].includes(eType)
      ) {
        excludedRanges.push({ offset: entity.offset, length: entity.length });
      }
    }

    if (excludedRanges.length === 0) return fullText;
    excludedRanges.sort((a, b) => a.offset - b.offset);

    let result = "";
    let lastEnd = 0;
    for (const range of excludedRanges) {
      if (range.offset > lastEnd)
        result += fullText.substring(lastEnd, range.offset);
      lastEnd = range.offset + range.length;
    }
    if (lastEnd < fullText.length) result += fullText.substring(lastEnd);

    return result.trim();
  }

  private isVideoMessage(message: any): boolean {
    // mtcute: message.media is a typed object with ._ field
    const media = message.media;
    if (!media) return false;
    
    const mediaType = media._ || media.type || "";
    
    // Check for video/document media
    if (mediaType === "messageMediaDocument" || mediaType === "document") {
      const doc = media.document || media;
      if (doc) {
        const mimeType = doc.mimeType || doc.mime_type || "";
        if (mimeType.startsWith("video/")) return true;
        
        // Check file attributes for video
        const attrs = doc.attributes || [];
        for (const attr of attrs) {
          const attrType = attr._ || attr.className || "";
          if (attrType === "documentAttributeVideo") return true;
        }
        
        // Check file extension
        let fileName = "";
        for (const attr of attrs) {
          if (attr.fileName) {
            fileName = attr.fileName;
            break;
          }
        }
        if (fileName) {
          return [".mp4", ".avi", ".mov", ".mkv", ".webm", ".flv", ".wmv", ".m4v"]
            .some((ext) => fileName.toLowerCase().endsWith(ext));
        }
      }
    }
    
    // Also check direct video property
    if (message.video) return true;
    
    return false;
  }

  private async waitForBotReply(
    client: any,
    botEntity: any,
    timeoutMs: number = 15000,
  ): Promise<any | null> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const listenerId = `${botEntity.id}_${startTime}_${Math.random()}`;
      let isResolved = false;

      const cleanup = (result: any | null) => {
        if (isResolved) return;
        isResolved = true;

        const listener = this.messageListeners.get(listenerId);
        if (listener) {
          clearTimeout(listener.timeout);
          try {
            (client as any).onNewMessage.off(listener.handler);
          } catch (error) {
            console.warn("[kkp] 移除事件监听器失败:", error);
          }
          this.messageListeners.delete(listenerId);
        }
        resolve(result);
      };

      const timeout = setTimeout(() => cleanup(null), timeoutMs);

      const messageHandler = (event: any) => {
        try {
          const message = event.message;
          if (!message) return;
          const senderId = String(message.sender?.id || message.senderId || "");
          const botId = String(botEntity.id);

          // mtcute: message.date is Date object, need to compare correctly
          const messageDate = message.date instanceof Date 
            ? message.date.getTime() 
            : (message.date || 0) * 1000;

          if (senderId === botId && messageDate >= startTime - 1000) {
            if (this.isVideoMessage(message)) cleanup(message);
          }
        } catch (error) {
          console.error("[kkp] 消息处理失败:", error);
          cleanup(null);
        }
      };

      this.messageListeners.set(listenerId, {
        resolve,
        timeout,
        startTime,
        handler: messageHandler,
      });
      try {
        client.onNewMessage.on(messageHandler);
      } catch (error) {
        console.error("[kkp] 添加事件监听器失败:", error);
        cleanup(null);
      }
    });
  }

  private async getRandomVideo(msg: MessageContext, client: any): Promise<void> {
    await msg.edit({ text: html`🎲 正在获取随机视频...` });

    const botUsername = "SeSe3000Bot";
    try {
      const botEntity = await client.resolvePeer(botUsername);
      const recentMessages = await client.getHistory(botEntity, { limit: 3 });

      if (!recentMessages || recentMessages.length === 0) {
        await client.sendText(botUsername, "/start");
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      const replyPromise = this.waitForBotReply(client, botEntity, 20000);
      await client.sendText(botUsername, "随机色色");
      const videoMessage = await replyPromise;

      if (videoMessage && this.isVideoMessage(videoMessage)) {
        const mediaToSend = videoMessage.media;

        if (mediaToSend) {
          const plainTextCaption = this.extractPlainText(videoMessage);

          await msg.edit({ text: html`📥 正在转发视频...` });

          // 构造带剧透的媒体发送
          // 使用 client.sendMedia 发送带 spoiler 的视频
          const mediaDoc = (mediaToSend as any).document || mediaToSend;
          
          if (mediaDoc && mediaDoc.id) {
            // 使用 InputMediaDocument with spoiler
            const fileInput: any = {
              _: 'inputMediaDocument',
              id: {
                _: 'inputDocument',
                id: mediaDoc.id,
                accessHash: mediaDoc.accessHash,
                fileReference: mediaDoc.fileReference,
              },
              spoiler: true,
            };

            // 创建剧透实体覆盖整个文本
            const spoilerEntities = plainTextCaption.length > 0 ? [{
              _: 'messageEntitySpoiler',
              offset: 0,
              length: plainTextCaption.length,
            }] : [];

            // 使用 call 直接发送带剧透的文件
            const peerId = await client.resolvePeer(msg.chat.id);
            await client.call({
              _: 'messages.sendMedia',
              peer: peerId as any,
              media: fileInput,
              message: plainTextCaption,
              entities: spoilerEntities,
              randomId: BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000)),
            } as any);

            try {
              await client.markAsRead(peerId as any);
            } catch {}
            await msg.delete();
          } else {
            await msg.edit({ text: html`❌ 无法提取视频文件` });
          }
        } else {
          await msg.edit({ text: html`❌ 无法提取视频文件` });
        }
      } else {
        await msg.edit({ text: html`❌ 获取视频超时` });
      }
    } catch (botError: any) {
      console.error("[kkp] 错误:", botError);
      await msg.edit({
        text: html`❌ 错误: ${htmlEscape(botError.message || "未知")}`,
      });
    }
  }

  async cleanup(): Promise<void> {
    const client = await getGlobalClient().catch(() => null);

    for (const [listenerId, listener] of this.messageListeners) {
      clearTimeout(listener.timeout);
      if (client) {
        try {
          (client as any).onNewMessage.off(listener.handler);
        } catch (error) {
          console.warn("[kkp] cleanup 移除监听器失败:", error);
        }
      }
    }
    this.messageListeners.clear();
  }
}

export default new KkpPlugin();
