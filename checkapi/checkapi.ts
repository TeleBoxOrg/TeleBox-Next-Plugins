import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import type { MessageContext } from "@mtcute/dispatcher";
import * as fs from "fs/promises";
import path from "path";
import axios from "axios";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";
import { thtml as html } from "@mtcute/html-parser";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// ── Data store ──────────────────────────────────────────────────────────
const DATA_DIR = createDirectoryInAssets("checkapi");
const KEYS_FILE = path.join(DATA_DIR, "keys.json");

interface SavedKey {
  name: string;
  key: string;
  baseUrl?: string;
  provider?: string;
  addedAt: number;
}

async function loadKeys(): Promise<SavedKey[]> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw = await fs.readFile(KEYS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveKeys(keys: SavedKey[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(KEYS_FILE, JSON.stringify(keys, null, 2), "utf8");
}

// ── Provider detection ──────────────────────────────────────────────────

interface ProviderInfo {
  provider: string;
  displayName: string;
  baseUrl: string;
  balanceUrl?: string;
  modelsUrl?: string;
  confidence: "high" | "medium" | "low";
  headers: Record<string, string>;
}

function detectProvider(key: string, baseUrl?: string): ProviderInfo {
  // Normalize: strip whitespace but keep key intact
  const trimmedKey = key.trim();

  // Custom base URL overrides all detection
  if (baseUrl) {
    const normalized = baseUrl.replace(/\/+$/, "");
    const defaultHeaders: Record<string, string> = {};
    if (normalized.includes("openrouter"))
      defaultHeaders["HTTP-Referer"] = "https://t.me/telebox_next";
    return {
      provider: "custom",
      displayName: `自定义 (${normalized})`,
      baseUrl: normalized,
      balanceUrl: normalized.includes("openrouter")
        ? `${normalized}/api/v1/auth/key`
        : undefined,
      modelsUrl: `${normalized}/v1/models`,
      confidence: "medium",
      headers: defaultHeaders,
    };
  }

  // Anthropic: sk-ant-api03-...
  if (/^sk-ant-/i.test(trimmedKey)) {
    return {
      provider: "anthropic",
      displayName: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      modelsUrl: "https://api.anthropic.com/v1/models",
      confidence: "high",
      headers: { "x-api-key": trimmedKey, "anthropic-version": "2023-06-01" },
    };
  }

  // OpenRouter: sk-or-v1-...
  if (/^sk-or-v1-/i.test(trimmedKey)) {
    return {
      provider: "openrouter",
      displayName: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      balanceUrl: "https://openrouter.ai/api/v1/auth/key",
      modelsUrl: "https://openrouter.ai/api/v1/models",
      confidence: "high",
      headers: {
        Authorization: `Bearer ${trimmedKey}`,
        "HTTP-Referer": "https://t.me/telebox_next",
      },
    };
  }

  // OpenAI or OpenAI-compatible: sk-...
  if (/^sk-/i.test(trimmedKey)) {
    // DeepSeek: sk-*** (specific pattern)
    if (trimmedKey.length < 40) {
      return {
        provider: "deepseek",
        displayName: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        balanceUrl: "https://api.deepseek.com/user/balance",
        modelsUrl: "https://api.deepseek.com/v1/models",
        confidence: "medium",
        headers: { Authorization: `Bearer ${trimmedKey}` },
      };
    }
    // Default: OpenAI
    return {
      provider: "openai",
      displayName: "OpenAI",
      baseUrl: "https://api.openai.com",
      balanceUrl: "https://api.openai.com/v1/dashboard/billing/subscription",
      modelsUrl: "https://api.openai.com/v1/models",
      confidence: "high",
      headers: { Authorization: `Bearer ${trimmedKey}` },
    };
  }

  // xAI: xai-...
  if (/^xai-/i.test(trimmedKey)) {
    return {
      provider: "xai",
      displayName: "xAI (Grok)",
      baseUrl: "https://api.x.ai",
      modelsUrl: "https://api.x.ai/v1/models",
      confidence: "high",
      headers: { Authorization: `Bearer ${trimmedKey}` },
    };
  }

  // Google Gemini: long string, no prefix, often AIza...
  if (/^AIza/i.test(trimmedKey)) {
    return {
      provider: "gemini",
      displayName: "Google Gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      modelsUrl: `https://generativelanguage.googleapis.com/v1beta/models?key=${trimmedKey}`,
      confidence: "high",
      headers: {},
    };
  }

  // Fallback: try as OpenAI-compatible
  if (trimmedKey.length > 20) {
    return {
      provider: "openai",
      displayName: "OpenAI（推测）",
      baseUrl: "https://api.openai.com",
      balanceUrl: "https://api.openai.com/v1/dashboard/billing/subscription",
      modelsUrl: "https://api.openai.com/v1/models",
      confidence: "low",
      headers: { Authorization: `Bearer ${trimmedKey}` },
    };
  }

  return {
    provider: "unknown",
    displayName: "未知",
    baseUrl: "",
    confidence: "low",
    headers: {},
  };
}

// ── API call helpers ────────────────────────────────────────────────────

async function apiGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 15000,
): Promise<{ ok: boolean; data?: unknown; status?: number; error?: string }> {
  try {
    const resp = await axios.get(url, {
      headers,
      timeout: timeoutMs,
      validateStatus: () => true,
    });
    if (resp.status >= 200 && resp.status < 300) {
      return { ok: true, data: resp.data, status: resp.status };
    }
    const body = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
    return {
      ok: false,
      status: resp.status,
      error: `HTTP ${resp.status}: ${body.slice(0, 200)}`,
    };
  } catch (e: unknown) {
    return { ok: false, error: getErrorMessage(e) || String(e) };
  }
}

async function apiGetJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs?: number,
): Promise<{ ok: boolean; data?: Record<string, unknown>; status?: number; error?: string }> {
  const result = await apiGet(url, headers, timeoutMs);
  if (!result.ok) return result as unknown as { ok: boolean; data?: Record<string, unknown>; status?: number; error?: string };
  if (result.data && typeof result.data === "object") {
    return { ok: true, data: result.data as Record<string, unknown>, status: result.status };
  }
  return { ok: false, error: `非 JSON 响应: ${String(result.data).slice(0, 100)}` };
}

// ── Balance checks ──────────────────────────────────────────────────────

async function checkOpenAIBalance(
  key: string,
  baseUrl: string,
): Promise<string> {
  const lines: string[] = [];
  const headers = { Authorization: `Bearer ${key}` };

  // Check subscription
  const subResult = await apiGetJson(
    `${baseUrl}/v1/dashboard/billing/subscription`,
    headers,
  );
  if (subResult.ok && subResult.data) {
    const planData = subResult.data.plan as Record<string, unknown> | undefined;
    const plan = planData?.title || "未知";
    const accessUntil = subResult.data.access_until
      ? new Date((subResult.data.access_until as number) * 1000).toLocaleDateString("zh-CN")
      : "未知";
    const hardLimit = subResult.data.hard_limit_usd ?? "?";
    const softLimit = subResult.data.soft_limit_usd ?? "?";
    lines.push(`📋 套餐: ${plan}`);
    lines.push(`📅 有效期至: ${accessUntil}`);
    lines.push(`💰 硬上限: $${hardLimit} | 软上限: $${softLimit}`);
    lines.push(`🧪 系统软上限: $${subResult.data.system_hard_limit_usd ?? "?"}`);
  } else if (subResult.status === 401 || subResult.status === 403) {
    lines.push("❌ API Key 无效或已过期");
    return lines.join("\n");
  } else {
    lines.push("⚠️ 无法获取订阅信息（可能需要 API Key 有 billing 权限）");
  }

  // Check usage (last 90 days)
  const now = Math.floor(Date.now() / 1000);
  const ninetyDaysAgo = now - 90 * 86400;
  const usageResult = await apiGetJson(
    `${baseUrl}/v1/dashboard/billing/usage?start_date=${ninetyDaysAgo}&end_date=${now}`,
    headers,
  );
  if (usageResult.ok && usageResult.data) {
    const totalUsage = (usageResult.data as Record<string, unknown>).total_usage as number || 0;
    lines.push(`📊 近 90 天用量: $${(totalUsage / 100).toFixed(4)}`);
  }

  return lines.join("\n") || "✅ API Key 有效（无法获取更多账单信息）";
}

async function checkDeepSeekBalance(
  key: string,
  baseUrl: string,
): Promise<string> {
  const headers = { Authorization: `Bearer ${key}` };
  const result = await apiGetJson(`${baseUrl}/user/balance`, headers);

  if (result.ok && result.data) {
    const info = result.data;
    const balanceInfos = info.balance_infos as Array<Record<string, unknown>> | undefined;
    const isAvailable = info.is_available;

    const lines: string[] = [];
    lines.push(`✅ 可用: ${isAvailable ? "是" : "否"}`);
    if (balanceInfos) {
      for (const bi of balanceInfos) {
        lines.push(
          `💰 ${bi.currency || "余额"}: ${bi.total_balance || "?"} (已用: ${bi.topped_up_balance || "?"})`,
        );
      }
    }
    return lines.join("\n");
  }
  if (result.status === 401) return "❌ API Key 无效";
  return `⚠️ 无法查询: ${result.error || "未知错误"}`;
}

async function checkOpenRouterBalance(
  key: string,
  baseUrl: string,
): Promise<string> {
  const headers = { Authorization: `Bearer ${key}` };
  const result = await apiGetJson(`${baseUrl}/auth/key`, headers);

  if (result.ok && result.data) {
    const data = result.data as Record<string, unknown>;
    const info = data.data as Record<string, unknown> | undefined || data;
    const lines: string[] = [];
    lines.push(`🏷️  名称: ${info.label || info.name || "未命名"}`);
    lines.push(`💰 余额: $${info.credits ?? "?"}`);
    lines.push(`📊 已用: $${info.usage ?? "?"}`);
    if (info.limit !== undefined) lines.push(`📏 限额: $${info.limit}`);
    if (info.rate_limit) {
      const rl = info.rate_limit as Record<string, unknown>;
      lines.push(`⚡ 速率: ${rl.requests || "?"} req / ${rl.interval || "?"}`);
    }
    return lines.join("\n");
  }
  if (result.status === 401) return "❌ API Key 无效";
  return `⚠️ 无法查询: ${result.error || "未知错误"}`;
}

async function checkAnthropicUsage(
  key: string,
): Promise<string> {
  const headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
  // Anthropic has no public balance endpoint; use a lightweight call
  const result = await apiGetJson(
    "https://api.anthropic.com/v1/messages",
    headers,
    10000,
  );

  if (result.status === 401 || result.status === 403) {
    return "❌ API Key 无效";
  }
  // Even a 400 (missing body) means the key is valid
  if (result.status === 400 || result.status === 429 || result.status === 200) {
    return "✅ API Key 有效\n⚠️ Anthropic 无公开余额查询接口，请前往 console.anthropic.com 查看用量";
  }
  return `⚠️ 状态: HTTP ${result.status}\n${result.error || ""}`;
}

async function checkGeminiKey(
  key: string,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
  const result = await apiGetJson(url, {}, 10000);

  if (result.ok && result.data) {
    const models = result.data.models as Array<Record<string, unknown>> | undefined;
    const count = models?.length ?? 0;
    return `✅ API Key 有效\n📋 可用模型: ${count} 个`;
  }
  if (result.status === 400 && String(result.data || "").includes("API_KEY_INVALID")) {
    return "❌ API Key 无效";
  }
  return `⚠️ 状态: HTTP ${result.status}\n${result.error || "API Key 可能有效（无法确认）"}`;
}

async function checkXAIKey(
  key: string,
  baseUrl: string,
): Promise<string> {
  const headers = { Authorization: `Bearer ${key}` };
  const result = await apiGetJson(`${baseUrl}/v1/models`, headers, 10000);

  if (result.ok && result.data) {
    const arr = Array.isArray(result.data) ? result.data : (result.data.data as Array<unknown> | undefined);
    const count = arr?.length ?? 0;
    return `✅ API Key 有效\n📋 可用模型: ${count} 个`;
  }
  if (result.status === 401) return "❌ API Key 无效";
  return `⚠️ 状态: HTTP ${result.status}`;
}

// ── Model listing ────────────────────────────────────────────────────────

async function listModels(
  provider: string,
  key: string,
  baseUrl: string,
): Promise<string> {
  if (provider === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
    const headers: Record<string, string> = {};
    const result = await apiGetJson(url, headers, 10000);
    if (result.ok && result.data) {
      const models = result.data.models as Array<Record<string, unknown>> | undefined || [];
      const lines: string[] = [`🤖 Gemini 模型 (${models.length}):`];
      for (const m of models.slice(0, 30)) {
        const name = String(m.name || "").replace("models/", "");
        const desc = String(m.description || "").slice(0, 80);
        const methods = String(m.supportedGenerationMethods || "");
        const tags = methods.includes("generateContent") ? "✅" : "⚡";
        lines.push(`  ${tags} <code>${name}</code> — ${desc}`);
      }
      if (models.length > 30) lines.push(`  ... 共 ${models.length} 个`);
      return lines.join("\n");
    }
    return `❌ 获取失败: ${result.error}`;
  }

  // OpenAI-compatible: GET /v1/models
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (provider === "openrouter") headers["HTTP-Referer"] = "https://t.me/telebox_next";
  else if (provider === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    delete headers["Authorization"];
  }

  const url = provider === "anthropic"
    ? "https://api.anthropic.com/v1/models"
    : `${baseUrl}/v1/models`;

  const result = await apiGetJson(url, headers, 10000);
  if (result.ok && result.data) {
    const arr = Array.isArray(result.data)
      ? result.data
      : (result.data.data as Array<Record<string, unknown>> | undefined) || [];
    const lines: string[] = [`🤖 ${provider} 模型 (${arr.length}):`];

    // Sort: first by created desc, then alphabetically
    const sorted = [...arr].sort((a, b) => {
      const ca = Number(a.created || 0);
      const cb = Number(b.created || 0);
      if (cb !== ca) return cb - ca;
      return String(a.id || "").localeCompare(String(b.id || ""));
    });

    for (const m of sorted.slice(0, 40)) {
      const id = String(m.id || m.name || "");
      const owner = m.owned_by ? ` [${m.owned_by}]` : "";
      lines.push(`  • <code>${id}</code>${owner}`);
    }
    if (sorted.length > 40) lines.push(`  ... 共 ${sorted.length} 个`);
    return lines.join("\n");
  }
  return `❌ 获取失败: ${result.error}`;
}

// ── Connection test ─────────────────────────────────────────────────────

async function testConnection(
  provider: string,
  key: string,
  baseUrl: string,
): Promise<string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (provider === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    delete headers["Authorization"];
  }

  const start = Date.now();
  const url = provider === "gemini"
    ? `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`
    : `${baseUrl}/v1/models`;

  const result = await apiGetJson(url, headers, 8000);
  const elapsed = Date.now() - start;

  if (result.ok) {
    return `✅ 连接成功 (${elapsed}ms)\n📡 ${provider} API 可达`;
  }
  if (result.status === 401 || result.status === 403) {
    return `🔑 API Key 认证失败 (${elapsed}ms)\nHTTP ${result.status}: ${result.error || "无效或权限不足"}`;
  }
  return `⚠️ 连接异常 (${elapsed}ms)\nHTTP ${result.status}: ${result.error || "未知错误"}`;
}

// ── Full check ───────────────────────────────────────────────────────────

async function fullCheck(
  info: ProviderInfo,
  key: string,
): Promise<string> {
  const sections: string[] = [];

  // 0. Provider info
  sections.push(
    `🔍 识别: ${info.displayName} (${info.provider}, 置信度: ${info.confidence})`,
  );

  // 1. Connection test
  sections.push(`\n📡 连接测试:`);
  sections.push(await testConnection(info.provider, key, info.baseUrl));

  // 2. Balance
  sections.push(`\n💰 余额/用量:`);
  try {
    if (info.provider === "openai" || info.provider === "custom") {
      sections.push(await checkOpenAIBalance(key, info.baseUrl));
    } else if (info.provider === "deepseek") {
      sections.push(await checkDeepSeekBalance(key, info.baseUrl));
    } else if (info.provider === "openrouter") {
      sections.push(await checkOpenRouterBalance(key, info.baseUrl));
    } else if (info.provider === "anthropic") {
      sections.push(await checkAnthropicUsage(key));
    } else if (info.provider === "gemini") {
      sections.push(await checkGeminiKey(key));
    } else if (info.provider === "xai") {
      sections.push(await checkXAIKey(key, info.baseUrl));
    } else {
      sections.push("❓ 未知 provider，尝试 OpenAI 兼容检查...");
      sections.push(await testConnection("openai", key, "https://api.openai.com"));
    }
  } catch (e: unknown) {
    sections.push(`⚠️ 余额查询异常: ${getErrorMessage(e) || e}`);
  }

  // 3. Models count
  sections.push(`\n📋 模型列表（前 10 个）:`);
  try {
    const modelsStr = await listModels(info.provider, key, info.baseUrl);
    // Take only first 10 models for full check (to keep message short)
    const lines = modelsStr.split("\n");
    const header = lines[0] || "";
    const firstTen = lines.slice(1, 11);
    if (lines.length > 12) firstTen.push(`  ... 共 ${lines.length - 1} 个，使用 <code>${mainPrefix}checkapi models</code> 查看全部`);
    sections.push(header);
    sections.push(...firstTen);
  } catch (e: unknown) {
    sections.push(`⚠️ 模型列表异常: ${getErrorMessage(e) || e}`);
  }

  return sections.join("\n");
}

// ── Plugin ───────────────────────────────────────────────────────────────

class CheckApiPlugin extends Plugin {
  name = "checkapi";
  description =
    `🔍 API Key 检测工具\n\n` +
    `支持 OpenAI / Anthropic / Gemini / DeepSeek / OpenRouter / xAI / 自定义\n\n` +
    `用法:\n` +
    `<blockquote expandable>` +
    `<code>${mainPrefix}checkapi &lt;key&gt;</code> — 自动识别并全线检测\n` +
    `<code>${mainPrefix}checkapi balance &lt;key|name&gt;</code> — 仅查余额\n` +
    `<code>${mainPrefix}checkapi models &lt;key|name&gt;</code> — 列模型\n` +
    `<code>${mainPrefix}checkapi test &lt;key|name&gt;</code> — 连通性测试\n` +
    `<code>${mainPrefix}checkapi save &lt;name&gt; &lt;key&gt; [baseUrl]</code> — 保存 Key\n` +
    `<code>${mainPrefix}checkapi list</code> — 列出已保存\n` +
    `<code>${mainPrefix}checkapi del &lt;name&gt;</code> — 删除\n` +
    `<code>${mainPrefix}checkapi check &lt;name|all&gt;</code> — 检测已保存\n` +
    `</blockquote>\n\n` +
    `智能识别：根据 Key 前缀自动判断 provider\n` +
    `- <code>sk-ant-...</code> → Anthropic\n` +
    `- <code>sk-or-v1-...</code> → OpenRouter\n` +
    `- <code>sk-...</code> → OpenAI\n` +
    `- <code>AIza...</code> → Google Gemini\n` +
    `- <code>xai-...</code> → xAI (Grok)`;

  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    checkapi: async (msg) => {
      const text = msg.text.slice(mainPrefix.length).trim();
      const parts = text.split(/\s+/).filter(Boolean);

      // No args → help
      if (parts.length === 0 || parts[0] === "help") {
        await msg.edit({ text: html`${this.description}` });
        return;
      }

      const sub = parts[0]?.toLowerCase();

      // list
      if (sub === "list") {
        const keys = await loadKeys();
        if (keys.length === 0) {
          await msg.edit({ text: html`📭 未保存任何 API Key\n\n使用 <code>${mainPrefix}checkapi save &lt;name&gt; &lt;key&gt;</code> 保存` });
          return;
        }
        const lines = [`🔑 已保存的 API Key (${keys.length}):`];
        for (const k of keys) {
          const masked = k.key.slice(0, 7) + "..." + k.key.slice(-4);
          const provider = k.provider || "auto";
          const base = k.baseUrl ? ` [${k.baseUrl}]` : "";
          lines.push(`  • <b>${k.name}</b>: ${masked} (${provider})${base}`);
        }
        await msg.edit({ text: html`${lines.join("\n")}` });
        return;
      }

      // del
      if (sub === "del" || sub === "delete") {
        const name = parts[1];
        if (!name) {
          await msg.edit({ text: html`❌ 用法: <code>${mainPrefix}checkapi del &lt;name&gt;</code>` });
          return;
        }
        const keys = await loadKeys();
        const idx = keys.findIndex((k) => k.name === name);
        if (idx === -1) {
          await msg.edit({ text: html`❌ 未找到名为 <b>${name}</b> 的 Key` });
          return;
        }
        keys.splice(idx, 1);
        await saveKeys(keys);
        await msg.edit({ text: html`✅ 已删除 <b>${name}</b>` });
        return;
      }

      // save
      if (sub === "save") {
        const name = parts[1];
        const key = parts[2];
        const baseUrl = parts[3] || undefined;

        if (!name || !key) {
          await msg.edit({
            text: html`❌ 用法: <code>${mainPrefix}checkapi save &lt;name&gt; &lt;key&gt; [baseUrl]</code>\n\n示例:\n<code>${mainPrefix}checkapi save openai sk-xxx</code>\n<code>${mainPrefix}checkapi save myproxy sk-xxx https://my.proxy.com/v1</code>`,
          });
          return;
        }

        const keys = await loadKeys();
        const existing = keys.findIndex((k) => k.name === name);
        const info = detectProvider(key, baseUrl);
        const entry: SavedKey = {
          name,
          key,
          baseUrl,
          provider: info.provider,
          addedAt: Date.now(),
        };

        if (existing >= 0) {
          keys[existing] = entry;
          await saveKeys(keys);
          await msg.edit({ text: html`✅ 已更新 <b>${name}</b> (${info.displayName})` });
        } else {
          keys.push(entry);
          await saveKeys(keys);
          await msg.edit({ text: html`✅ 已保存 <b>${name}</b> (${info.displayName})\n\n使用 <code>${mainPrefix}checkapi check ${name}</code> 检测` });
        }
        return;
      }

      // check (saved)
      if (sub === "check") {
        const target = parts[1] || "all";
        if (target === "all") {
          const keys = await loadKeys();
          if (keys.length === 0) {
            await msg.edit({ text: html`📭 未保存任何 Key` });
            return;
          }
          await msg.edit({ text: html`🔍 正在检测 ${keys.length} 个 Key...` });
          const results: string[] = [];
          for (const k of keys) {
            const info = detectProvider(k.key, k.baseUrl);
            results.push(`\n━━━ <b>${k.name}</b> (${info.displayName}) ━━━`);
            results.push(await fullCheck(info, k.key));
            // Edit progress every 2 keys
            if (results.length % 2 === 0) {
              await msg.edit({
                text: html`🔍 正在检测... (${results.length / 2}/${keys.length})\n${results.join("\n").slice(-3000)}`,
              });
            }
          }
          await msg.edit({ text: html`${results.join("\n")}` });
          return;
        }

        // Single saved key
        const keys = await loadKeys();
        const found = keys.find((k) => k.name === target);
        if (found) {
          await msg.edit({ text: html`🔍 正在检测 <b>${target}</b>...` });
          const info = detectProvider(found.key, found.baseUrl);
          const result = await fullCheck(info, found.key);
          await msg.edit({ text: html`${result}` });
          return;
        }
        // Not found → fall through to inline key detection
        await msg.edit({ text: html`❌ 未找到名为 <b>${target}</b> 的 Key\n\n使用 <code>${mainPrefix}checkapi list</code> 查看已保存` });
        return;
      }

      // balance / models / test subcommands
      if (sub === "balance" || sub === "models" || sub === "test") {
        const input = parts[1];
        if (!input) {
          await msg.edit({ text: html`❌ 用法: <code>${mainPrefix}checkapi ${sub} &lt;key|name&gt;</code>` });
          return;
        }

        // Try saved key first
        const keys = await loadKeys();
        const found = keys.find((k) => k.name === input);
        let key: string;
        let info: ProviderInfo;

        if (found) {
          key = found.key;
          info = detectProvider(found.key, found.baseUrl);
          await msg.edit({ text: html`🔍 检测 <b>${input}</b> (${info.displayName})...` });
        } else {
          key = input;
          info = detectProvider(key);
          await msg.edit({ text: html`🔍 ${info.displayName}...` });
        }

        try {
          if (sub === "balance") {
            let result: string;
            if (info.provider === "openai" || info.provider === "custom") {
              result = await checkOpenAIBalance(key, info.baseUrl);
            } else if (info.provider === "deepseek") {
              result = await checkDeepSeekBalance(key, info.baseUrl);
            } else if (info.provider === "openrouter") {
              result = await checkOpenRouterBalance(key, info.baseUrl);
            } else if (info.provider === "anthropic") {
              result = await checkAnthropicUsage(key);
            } else if (info.provider === "gemini") {
              result = await checkGeminiKey(key);
            } else if (info.provider === "xai") {
              result = await checkXAIKey(key, info.baseUrl);
            } else {
              result = "❓ 未知 provider";
            }
            await msg.edit({ text: html`💰 <b>${info.displayName}</b> 余额\n\n${result}` });
          } else if (sub === "models") {
            const result = await listModels(info.provider, key, info.baseUrl);
            await msg.edit({ text: html`${result}` });
          } else if (sub === "test") {
            const result = await testConnection(info.provider, key, info.baseUrl);
            await msg.edit({ text: html`📡 <b>${info.displayName}</b> 连接测试\n\n${result}` });
          }
        } catch (e: unknown) {
          await msg.edit({
            text: html`❌ 查询失败: ${getErrorMessage(e) || String(e)}`,
          });
        }
        return;
      }

      // Inline key: full auto-detect + check
      const key = parts[0];
      const info = detectProvider(key);
      await msg.edit({ text: html`🔍 识别为 <b>${info.displayName}</b>，正在检测...` });

      try {
        const result = await fullCheck(info, key);
        await msg.edit({ text: html`${result}` });
      } catch (e: unknown) {
        await msg.edit({
          text: html`❌ 检测失败: ${getErrorMessage(e) || String(e)}`,
        });
      }
    },
  };
}

export default new CheckApiPlugin();
