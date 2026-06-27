import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import axios from "axios";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";

function htmlEscape(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface IpApiSuccess {
  status: "fail" | "success";
  message?: string;
  country: string;
  regionName: string;
  city: string;
  isp: string;
  org: string;
  as: string;
  query: string;
  timezone?: string;
  proxy?: boolean;
  hosting?: boolean;
}

interface IpApiFail {
  status: "fail";
  message: string;
}

type IpApiResponse = IpApiFail | IpApiSuccess;

function isIpApiSuccess(data: IpApiResponse): data is IpApiSuccess {
  return data.status === "success";
}

async function getIpInfo(query: string): Promise<IpApiResponse> {
  if (!query || query.trim() === "") {
    return {
      status: "fail",
      message: "请提供有效的IP地址或域名",
    };
  }

  const cleanQuery = query.trim();
  const apiUrl = `http://ip-api.com/json/${encodeURIComponent(
    cleanQuery
  )}?lang=zh-CN&fields=status,message,country,regionName,city,isp,org,as,query,timezone,proxy,hosting`;

  try {
    const response = await axios.get(apiUrl, {
      timeout: 15000,
      headers: {
        "User-Agent": "TeleBox-IP-Plugin/1.0",
      },
    });

    if (response.status === 200) {
      const data = response.data;
      if (data.status === "fail") {
        return {
          status: "fail",
          message: data.message || "查询失败，请检查IP地址或域名是否正确",
        };
      }
      return data;
    }

    return {
      status: "fail",
      message: `API请求失败，HTTP状态码: ${response.status}`,
    };
  } catch (error: unknown) {
    logger.error("IP API request failed:", error);

    let errorMessage = "网络请求失败";
    const errorStr = String(getErrorMessage(error));

    if (errorStr.includes("timeout") || errorStr.includes("TIMEOUT")) {
      errorMessage = "请求超时，请稍后重试";
    } else if (
      errorStr.includes("ENOTFOUND") ||
      errorStr.includes("getaddrinfo")
    ) {
      errorMessage = "DNS解析失败，请检查网络连接";
    } else if (errorStr.includes("ECONNREFUSED")) {
      errorMessage = "连接被拒绝，请稍后重试";
    }

    return {
      status: "fail",
      message: errorMessage,
    };
  }
}

const ip = async (msg: MessageContext) => {
  try {
    const args = msg.text.slice(1).split(" ").slice(1);
    let query = args.join(" ");

    if (!query) {
      try {
        const reply = await safeGetReplyMessage(msg);
        if (reply && reply.text) {
          const text = reply.text.trim();
          const ipRegex = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/;
          const domainRegex =
            /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}\b/;

          const ipMatch = text.match(ipRegex);
          const domainMatch = text.match(domainRegex);

          if (ipMatch) {
            query = ipMatch[0];
          } else if (domainMatch) {
            query = domainMatch[0];
          } else {
            query = text.split(" ")[0];
          }
        }
      } catch (replyError: unknown) {
        logger.error("Failed to get reply message:", replyError);
      }
    }

    if (!query || query.trim() === "") {
      await msg.edit({
        text: html`📍 <b>IP查询插件</b>

<b>使用方法：</b>
• <code>ip &lt;IP地址&gt;</code>
• <code>ip &lt;域名&gt;</code>
• 回复包含IP/域名的消息后使用 <code>ip</code>

<b>示例：</b>
• <code>ip 8.8.8.8</code>
• <code>ip google.com</code>
• <code>ip 2001:4860:4860::8888</code>`,
      });
      return;
    }

    await msg.edit({
      text: html`🔍 <b>正在查询:</b> <code>${htmlEscape(query)}</code>`,
    });

    const data = await getIpInfo(query);

    if (!isIpApiSuccess(data)) {
      const errorMessage = data.message || "未知错误";
      await msg.edit({
        text: html`❌ <b>查询失败</b>

<b>查询目标:</b> <code>${htmlEscape(query)}</code>
<b>失败原因:</b> ${htmlEscape(errorMessage)}

💡 <b>建议:</b>
• 检查IP地址或域名格式
• 稍后重试查询`,
      });
      return;
    }

    try {
      const country = data.country || "N/A";
      const region = data.regionName || "N/A";
      const city = data.city || "N/A";
      const isp = data.isp || "N/A";
      const org = data.org || "N/A";
      const asInfo = data.as || "N/A";
      const ipAddress = data.query || "N/A";

      let resultText = "";

      if (data.proxy) {
        resultText += "此 IP 可能为代理 IP<br>";
      }
      if (data.hosting) {
        resultText += "此 IP 可能为数据中心 IP<br>";
      }
      if (resultText) {
        resultText += "<br>";
      }

      resultText += `🌍 <b>IP/域名查询结果</b><br><br><b>🔍 查询目标:</b> <code>${htmlEscape(ipAddress)}</code><br><b>📍 地理位置:</b> ${htmlEscape(country)} - ${htmlEscape(region)} - ${htmlEscape(city)}<br><b>🏢 ISP:</b> ${htmlEscape(isp)}<br><b>🏦 组织:</b> ${htmlEscape(org)}<br><b>🔢 AS号:</b> <code>${htmlEscape(asInfo)}</code>`;

      if (data.timezone) {
        resultText += `<br><b>⏰ 时区:</b> ${htmlEscape(data.timezone)}`;
      }

      const asMatch = asInfo.match(/^AS(\d+)/);
      if (asMatch) {
        const asNum = asMatch[1];
        resultText += `<br><br>https://bgp.he.net/AS${asNum}`;
      }

      await msg.edit({
        text: html(resultText),
        disableWebPreview: true,
      });
    } catch (parseError: unknown) {
      logger.error("Failed to parse IP data:", parseError, data);
      await msg.edit({
        text: html`❌ <b>数据解析失败</b>

<b>查询目标:</b> <code>${htmlEscape(query)}</code>
<b>错误原因:</b> API返回了非预期的数据格式

💡 <b>建议:</b> 请稍后重试或联系管理员`,
      });
    }
  } catch (error: unknown) {
    logger.error("IP lookup error:", error);
    const errorMessage = getErrorMessage(error);
    const displayError =
      errorMessage.length > 100
        ? errorMessage.substring(0, 100) + "..."
        : errorMessage;

    try {
        await msg.edit({
            text: html`❌ <b>IP查询失败</b>
    
    <b>错误信息:</b> ${htmlEscape(displayError)}
    
    💡 <b>建议:</b>
    • 检查网络连接
    • 稍后重试查询
    • 确认IP地址或域名格式正确`,
        });
    } catch (editError: unknown) {
        logger.error("Failed to edit message with final error:", editError);
    }
  }
};

class IpPlugin extends Plugin {

  description: string = `
IP 查询插件：
- ip &lt;IP地址/域名&gt; - 查询 IP 地址或域名的详细信息
- 也可回复包含 IP/域名 的消息后使用 ip 命令

示例：
1. ip 8.8.8.8
2. ip google.com
3. 回复包含 IP 的消息后使用 ip
  `;
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    ip,
  };
}

export default new IpPlugin();