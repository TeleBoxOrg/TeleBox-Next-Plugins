import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/globalClient";
import axios from "axios";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";
import { htmlEscape } from "@utils/htmlEscape";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// WMO天气代码映射
const weatherCodeMap: Record<number, { icon: string; description: string }> = {
  0: { icon: "S", description: "晴朗" },
  1: { icon: "S", description: "大部晴朗" },
  2: { icon: "P", description: "部分多云" },
  3: { icon: "C", description: "阴天" },
  45: { icon: "F", description: "有雾" },
  48: { icon: "F", description: "沉积雾凇" },
  51: { icon: "D", description: "轻度细雨" },
  53: { icon: "D", description: "中度细雨" },
  55: { icon: "D", description: "密集细雨" },
  56: { icon: "S", description: "轻度冻雨" },
  57: { icon: "S", description: "密集冻雨" },
  61: { icon: "R", description: "轻度降雨" },
  63: { icon: "R", description: "中度降雨" },
  65: { icon: "R", description: "强降雨" },
  66: { icon: "S", description: "轻度冻雨" },
  67: { icon: "S", description: "强冻雨" },
  71: { icon: "S", description: "轻度降雪" },
  73: { icon: "S", description: "中度降雪" },
  75: { icon: "S", description: "强降雪" },
  77: { icon: "S", description: "雪粒" },
  80: { icon: "S", description: "轻度阵雨" },
  81: { icon: "R", description: "中度阵雨" },
  82: { icon: "T", description: "强阵雨" },
  85: { icon: "S", description: "轻度阵雪" },
  86: { icon: "S", description: "强阵雪" },
  95: { icon: "T", description: "雷暴" },
  96: { icon: "T", description: "轻度冰雹雷暴" },
  99: { icon: "T", description: "强冰雹雷暴" }
};

// 风向计算
function calcWindDirection(deg: number): string {
  const dirs = ["北", "北东北", "东北", "东东北", "东", "东东南", "东南", "南东南",
                "南", "南西南", "西南", "西西南", "西", "西西北", "西北", "北西北"];
  const ix = Math.round(deg / 22.5);
  return dirs[ix % 16];
}

// 帮助文档
const help_text = `🌤️ <b>天气查询插件</b>

<b>📝 功能描述:</b>
• 🌤️ <b>天气查询</b>：查询指定城市的实时天气
• 📊 <b>天气预报</b>：查看未来几天的天气趋势

<b>📋 使用方式:</b>
• <code>${mainPrefix}weather &lt;城市名&gt;</code> - 查询指定城市天气
• <code>${mainPrefix}weather</code> - 查询默认城市天气`;

class WeatherPlugin extends Plugin {
  name = "weather";
  description = "🌤️ 天气查询插件";
  cmdHandlers = {
    [mainPrefix + "weather"]: this.handleWeather.bind(this),
  };

  async handleWeather(msg: MessageContext, args: string[]): Promise<void> {
    try {
      await msg.replyText(html`${help_text}`);
    } catch (error: unknown) {
      logger.error("[weather] 处理失败:", error);
    }
  }

  cleanup(): void {
    // no-op
  }
}

export default new WeatherPlugin();
