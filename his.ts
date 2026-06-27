/**
 * 消息历史查询插件 - 查询指定用户或频道在群内的发言历史
 *
 * @author TeleBox Team
 * @version 2.0.0
 */

import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { logger } from "@utils/logger";
import { htmlEscape } from "@utils/htmlEscape";
import type { MessageContext } from "@mtcute/dispatcher";
import type { TelegramClient } from "@mtcute/core/highlevel/client";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 帮助文本定义（必需）
const help_text = `📜 <b>消息历史查询</b>

<b>使用方法：</b>
• <code>${mainPrefix}his</code> - 回复消息时查询该用户历史
• <code>${mainPrefix}his &lt;目标&gt;</code> - 查询目标的消息历史
• <code>${mainPrefix}his &lt;目标&gt; &lt;数量&gt;</code> - 查询指定数量消息
• <code>${mainPrefix}his &lt;数量&gt;</code> - 回复消息时查询指定数量

<b>示例：</b>
• 回复消息后：<code>${mainPrefix}his</code>
• <code>${mainPrefix}his @username</code>
• <code>${mainPrefix}his 123456789 10</code>
• 回复消息后：<code>${mainPrefix}his 5</code>

<b>注意事项：</b>
• 仅限群组使用
• 默认查询30条消息
• 目标可以是用户名、用户ID或频道ID`;


// 媒体类型映射
const MEDIA_TYPES: Record<string, string> = {
  "AUDIO": "[音频]",
  "DOCUMENT": "[文档]",
  "PHOTO": "[图片]",
  "STICKER": "[贴纸]",
  "VIDEO": "[视频]",
  "ANIMATION": "[动画]",
  "VOICE": "[语音]",
  "VIDEO_NOTE": "[视频消息]",
  "CONTACT": "[联系人]",
  "LOCATION": "[位置]",
  "VENUE": "[地点]",
  "POLL": "[投票]",
  "WEB_PAGE": "[网页]",
  "DICE": "[骰子]",
  "GAME": "[游戏]"
};

class HisPlugin extends Plugin {

  // 必须在 description 中引用 help_text
  description: string = `消息历史查询插件<br><br>${help_text}`;

  constructor() {
    super();
  }

  cmdHandlers: Record<string, (msg: MessageContext, trigger?: MessageContext) => Promise<void>> = {
    his: async (msg: MessageContext, trigger?: MessageContext) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化" });
        return;
      }

      // 简单参数解析
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts; // 跳过命令本身

      try {
        const DEFAULT_COUNT = 30;

        // 处理帮助命令
        if (args[0] === "help" || args[0] === "h") {
          await msg.edit({ text: help_text });
          return;
        }

        // 无参数时的处理
        if (args.length === 0) {
          // 如果是回复消息，则查询被回复者
          if (msg.replyToMessage?.id) {
            const reply = await safeGetReplyMessage(msg);
            if (reply) {
              const target = reply.sender.id.toString();
              await this.queryHistory(msg, target, DEFAULT_COUNT, client);
              return;
            }
          }

          // 否则显示错误提示
          await msg.edit({
            text: "❌ 请回复一条消息或指定查询目标"
          });
          return;
        }

        // 一个参数的情况
        if (args.length === 1) {
          const arg = args[0];
          const num = parseInt(arg);

          // 如果是数字且在回复消息的情况下，作为数量参数
          if (!isNaN(num) && num > 0 && msg.replyToMessage?.id) {
            const reply = await safeGetReplyMessage(msg);
            if (reply) {
              const target = reply.sender.id.toString();
              const count = Math.min(num, 100); // 最大限制100条
              await this.queryHistory(msg, target, count, client);
              return;
            }
          }

          // 否则作为目标参数
          const target = this.parseEntity(arg);
          await this.queryHistory(msg, target, DEFAULT_COUNT, client);
          return;
        }

        // 两个参数的情况：目标 + 数量
        if (args.length === 2) {
          const target = this.parseEntity(args[0]);
          const num = parseInt(args[1]);

          if (isNaN(num) || num <= 0) {
            await msg.edit({
              text: "❌ 无效的数量参数"
            });
            return;
          }

          const count = Math.min(num, 100); // 最大限制100条
          await this.queryHistory(msg, target, count, client);
          return;
        }

        // 参数过多
        await msg.edit({
          text: "❌ 参数过多，请使用 .his help 查看帮助"
        });
        return;

      } catch (error: any) {
        logger.error("[his] 插件执行失败:", error);

        // 处理特定错误类型
        if (error.message?.includes("FLOOD_WAIT")) {
          const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
          await msg.edit({
            text: `⏳ <b>请求过于频繁</b><br><br>需要等待 ${waitTime} 秒后重试`
          });
          return;
        }

        if (error.message?.includes("MESSAGE_TOO_LONG")) {
          await msg.edit({
            text: "❌ <b>消息过长</b><br><br>请减少查询数量"
          });
          return;
        }

        // 通用错误处理
        await msg.edit({
          text: `❌ <b>操作失败:</b> ${htmlEscape(error.message || "未知错误")}`
        });
      }
    }
  };


  // 查询历史消息
  private async queryHistory(msg: MessageContext, targetEntity: any, num: number, client: TelegramClient): Promise<void> {
    const chatId = msg.chat.id;

    // 显示处理中消息
    await msg.edit({ text: "🔍 正在查询消息历史..." });

    // 格式化目标实体显示
    let targetDisplay = "";
    try {
      const peer = await client.getPeer(targetEntity);
      if (peer) {
        const parts: string[] = [];
        if (peer.type === "user") {
          if (peer.firstName) parts.push(peer.firstName);
          if (peer.lastName) parts.push(peer.lastName);
          if (peer.username) parts.push(`@${peer.username}`);
        } else {
          if (peer.title) parts.push(peer.title);
          if (peer.username) parts.push(`@${peer.username}`);
        }
        targetDisplay = parts.join(" ") || targetEntity.toString();
      } else {
        targetDisplay = targetEntity.toString();
      }
    } catch (error) {
      targetDisplay = targetEntity.toString();
    }

    // 获取聊天链接基础URL
    let baseLinkUrl = "";
    try {
      const chat = await client.getChat(chatId);
      if (chat.username) {
        baseLinkUrl = `https://t.me/${chat.username}/`;
      } else if (chat.chatType === "supergroup" || chat.chatType === "gigagroup") {
        const chatIdStr = String(chatId).replace("-100", "");
        baseLinkUrl = `https://t.me/c/${chatIdStr}/`;
      }
    } catch (error) {
      logger.error("[HIS] Could not get chat entity for linking:", error);
    }

    let count = 0;
    const messages: string[] = [];

    try {
      // 迭代消息 - iterHistory does NOT support fromUser, so we filter manually
      const messageIterator = client.iterHistory(chatId, {
        limit: num * 5  // fetch extra to account for filtered-out messages
      });

      for await (const message of messageIterator) {
        // Manual sender filtering (replaces teleproto's fromUser option)
        if (message.sender.id.toString() !== targetEntity.toString()) {
          continue;
        }

        count++;
        let messageText = message.text || "";

        // 处理媒体消息
        if (message.media) {
          messageText = await this.processMediaMessage(message, messageText);
        }

        // 处理服务消息
        if (message.isService && message.action) {
          const action = message.action;
          if (action.type === "message_pinned") {
            messageText = "[置顶消息]";
          } else if (action.type === "title_changed") {
            messageText = "[修改群名] " + action.title;
          } else {
            messageText = "[服务消息] " + action.type;
          }
        }

        if (!messageText) {
          messageText = "[Unsupported Message]";
        }

        // 格式化消息显示
        const messageTextDisplay = messageText.length > 50
          ? `${messageText.substring(0, 50)}...`
          : messageText;

        // 添加链接（如果可用）
        if (baseLinkUrl) {
          const messageLink = `${baseLinkUrl}${message.id}`;
          messages.push(`${count}. <a href="${messageLink}">${htmlEscape(messageTextDisplay)}</a>`);
        } else {
          messages.push(`${count}. ${htmlEscape(messageTextDisplay)}`);
        }

        if (count >= num) break;
      }

      if (messages.length === 0) {
        await msg.edit({
          text: `❌ 未找到 <b>${htmlEscape(targetDisplay)}</b> 的消息记录`
        });
        return;
      }

      // 构建结果消息
      const header = `📜 <b>消息历史查询</b><br><br>` +
                    `👤 <b>目标:</b> ${htmlEscape(targetDisplay)}<br>` +
                    `💬 <b>消息数:</b> ${messages.length}<br>` +
                    `━━━━━━━━━━━━━━━━<br><br>`;

      const results = header + messages.join("<br>");

      // 分片发送长消息
      const MAX_LENGTH = 3500;
      if (results.length > MAX_LENGTH) {
        const chunks: string[] = [];
        let currentChunk = header;

        for (const message of messages) {
          if ((currentChunk + "<br>" + message).length > MAX_LENGTH) {
            chunks.push(currentChunk);
            currentChunk = message;
          } else {
            currentChunk += (currentChunk ? "<br>" : "") + message;
          }
        }
        if (currentChunk) {
          chunks.push(currentChunk);
        }

        // 发送第一片
        await msg.edit({
          text: chunks[0],
          disableWebPreview: true
        });

        // 发送后续片段
        for (let i = 1; i < chunks.length; i++) {
          await client.sendText(chatId, chunks[i], {
            disableWebPreview: true
          });
        }
      } else {
        await msg.edit({
          text: results,
          disableWebPreview: true
        });
      }

      logger.info(`[HIS] 查询完成 - 群组: ${chatId}, 目标: ${targetEntity.toString()}, 消息数: ${count}`);

    } catch (error: any) {
      logger.error("[HIS_ERROR]:", error);
      await msg.edit({
        text: `❌ 查询失败: ${htmlEscape(error.message || "未知错误")}`
      });
    }
  }

  // 处理媒体消息
  private async processMediaMessage(message: any, mediaCaption: string): Promise<string> {
    // 简化版本：总是显示媒体类型
    const showMediaType = true;
    if (!showMediaType) return mediaCaption;

    const media = message.media;

    if (media.type === "photo") {
      return MEDIA_TYPES.PHOTO + " " + mediaCaption;
    } else if (media.type === "document") {
      // In mtcute, document types use subclasses with .attr, not .attributes array
      // Check subclass type by media constructor name or attr type
      const docClassName = media.constructor?.name || "";

      if (docClassName === "Sticker") {
        return MEDIA_TYPES.STICKER + " " + mediaCaption;
      } else if (docClassName === "Voice") {
        return MEDIA_TYPES.VOICE + " " + mediaCaption;
      } else if (docClassName === "Video") {
        return MEDIA_TYPES.VIDEO + " " + mediaCaption;
      } else if (docClassName === "Audio") {
        return MEDIA_TYPES.AUDIO + " " + mediaCaption;
      }

      // Fallback: check the attr._ field for raw TL type
      const attr = media.attr;
      if (attr) {
        if (attr._ === "documentAttributeSticker") return MEDIA_TYPES.STICKER + " " + mediaCaption;
        if (attr._ === "documentAttributeAudio") {
          if (attr.voice) return MEDIA_TYPES.VOICE + " " + mediaCaption;
          return MEDIA_TYPES.AUDIO + " " + mediaCaption;
        }
        if (attr._ === "documentAttributeVideo") return MEDIA_TYPES.VIDEO + " " + mediaCaption;
        if (attr._ === "documentAttributeAnimated") return MEDIA_TYPES.ANIMATION + " " + mediaCaption;
      }

      return MEDIA_TYPES.DOCUMENT + " " + mediaCaption;
    } else if (media.type === "contact") {
      return MEDIA_TYPES.CONTACT + " " + mediaCaption;
    } else if (media.type === "geo" || media.type === "venue") {
      return MEDIA_TYPES.LOCATION + " " + mediaCaption;
    } else if (media.type === "poll") {
      return MEDIA_TYPES.POLL + " " + mediaCaption;
    } else if (media.type === "webPage") {
      return MEDIA_TYPES.WEB_PAGE + " " + mediaCaption;
    } else if (media.type === "dice") {
      return MEDIA_TYPES.DICE + " " + mediaCaption;
    } else if (media.type === "game") {
      return MEDIA_TYPES.GAME + " " + mediaCaption;
    }

    return mediaCaption;
  }

  // 解析实体参数
  private parseEntity(argStr: string): string | number {
    // 尝试解析为数字ID
    const num = parseInt(argStr);
    if (!isNaN(num)) {
      return num;
    }
    // 否则作为用户名返回
    return argStr;
  }
}

export default new HisPlugin();
