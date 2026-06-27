import axios from "axios";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/globalClient";

const timeout = 60000;
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "httpcat";
const commandName = `${mainPrefix}${pluginName}`;

const help_text = `
发送 HTTP 状态码对应的猫猫图片

<code>${commandName} [状态码]</code> 例如 <code>${commandName} 404</code>
`;

class HttpCatPlugin extends Plugin {

  description: string = `<br>HTTP猫猫图片<br><br>${help_text}`;
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    httpcat: async (msg: MessageContext) => {
      const args = msg.text?.split(/\s+/) || [];
      const code = args[1];
      if (!code || !/^\d{3}$/.test(code)) {
        await msg.edit({ text: html(help_text) });
        return;
      }
      const imageUrl = `https://http.cat/${code}`;
      await msg.edit({ text: `正在获取 HTTP ${code} 猫猫图片...` });
      try {
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
        const client = await getGlobalClient();
        await client.sendMedia(msg.chat.id, {
          type: "photo",
          file: imageBuffer,
          fileName: `httpcat_${code}.jpg`,
        }, {
          replyTo: msg.id,
        });
        await msg.delete();
      } catch (error: unknown) {
        await msg.edit({ text: `获取图片失败: ${error}` });
      }
    },
  };
}

export default new HttpCatPlugin();