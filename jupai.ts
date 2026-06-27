import axios from "axios";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/globalClient";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { logger } from "@utils/logger";
import { htmlEscape } from "@utils/htmlEscape";

const timeout = 60000;
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "jupai";
const commandName = `${mainPrefix}${pluginName}`;
const juPaiApi = "https://api.txqq.pro/api/zt.php";

const help_text = `
生成举牌小人图片

<code>${commandName} [文本]</code> - 生成举牌小人
或回复消息使用 <code>${commandName}</code> - 将回复的消息内容生成举牌小人

示例：
<code>${commandName} 你好世界</code>
`;

class JuPaiPlugin extends Plugin {
  description: string = `<br>举牌小人<br><br>${help_text}`;
  
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    jupai: async (msg: MessageContext) => {
      try {
        // 获取文本内容
        const args = (msg.text || "").split(/\s+/).slice(1);
        let text = args.join(" ");
        
        // 如果命令后没有文本，检查是否回复了消息
        if (!text) {
          const replied = msg.replyToMessage ? await safeGetReplyMessage(msg) : null;
          if (replied && replied.text) {
            text = replied.text;
          }
        }
        
        // 如果还是没有文本，显示帮助信息
        if (!text) {
          await msg.edit({ text: html(help_text) });
          return;
        }
        
        await msg.edit({ text: "正在生成举牌小人..." });
        
        try {
          // 构建 API URL，对文本进行 URL 编码
          const imageUrl = `${juPaiApi}?msg=${encodeURIComponent(text)}`;
          
          // 获取图片数据
          const response = await axios.get(imageUrl, {
            responseType: "arraybuffer",
            timeout,
          });
          
          const imageBuffer = Buffer.from(response.data);
          
          if (!imageBuffer || imageBuffer.length === 0) {
            await msg.edit({ text: "图片获取失败或为空" });
            return;
          }
          
          // 发送图片
          const client = await getGlobalClient();
          const replyToId = msg.replyToMessage?.id || msg.id;
          await client.sendMedia(msg.chat.id, {
            type: "photo",
            file: imageBuffer,
            fileName: "jupai.jpg",
          }, {
            replyTo: replyToId,
          });
          
          await msg.delete();
        } catch (error: unknown) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          await msg.edit({ text: html(`获取失败: ${htmlEscape(errorMsg)}`) });
        }
      } catch (error: unknown) {
        logger.error("JuPai Plugin Error:", error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        await msg.edit({ text: html(`插件执行失败: ${htmlEscape(errorMsg)}`) });
      }
    },
  };
}

export default new JuPaiPlugin();