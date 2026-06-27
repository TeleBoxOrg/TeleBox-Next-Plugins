import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import axios from "axios";
import { getGlobalClient } from "@utils/globalClient";

const url = "https://api.52vmy.cn/api/wl/moyu";

const CN_TIME_ZONE = "Asia/Shanghai";

function formatCN(date: Date): string {
  return date.toLocaleString("zh-CN", { timeZone: CN_TIME_ZONE });
}

class MoyuPlugin extends Plugin {

  description: string = "摸鱼日报";
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    moyu: async (msg) => {
      await msg.edit({ text: "开摸..." });
      const caption = `摸鱼日报 ${formatCN(new Date())}`;

      const res = await axios.get(url, {
        responseType: "arraybuffer",
        validateStatus: () => true,
      });

      const buf = Buffer.from(res.data);
      const client = await getGlobalClient();
      await client.sendMedia(msg.chat.id, {
        type: "photo",
        file: buf,
        fileName: "moyu.jpg",
        caption,
      });
      await msg.delete();
    },
  };
}

const plugin = new MoyuPlugin();

export default plugin;