import { Plugin } from "@utils/pluginBase";
import { getCurrentGenerationContext } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/runtimeManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import type { TelegramClient } from "@mtcute/node";
import type { ClientInternals } from "@utils/clientInternals";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import path from "path";
import bigInt from "big-integer";
import { safeGetReplyMessage } from "@utils/safeGetMessages";

import { safeGetMe } from "@utils/authGuards";
import { npm_install } from "@utils/npm_install";
import { logger } from "@utils/logger";
import { sleep } from "@utils/asyncHelpers";
import { getErrorMessage } from "@utils/errorHelpers";
import type { tl, Long } from "@mtcute/core";
import type { MtcuteMessageContext } from "@utils/mtcuteTypes";
import type { MtcuteInputPeer, MtcuteInputChannel, MtcuteInputUser } from "@utils/mtcuteTypes";
import { htmlEscape } from "@utils/htmlEscape";

/**
 * 从消息对象中取出所属聊天 ID。mtcute 的 MessageContext/Message 用 `.chat.id`
 * 表示当前聊天，没有 teleproto 的 `.peerId` 字段，故统一经此函数解析。
 */
function chatIdOf(msg: any): number {
  const chat = msg?.chat;
  if (chat && typeof chat.id !== "undefined") return Number(chat.id);
  return 0;
}

/**
 * Chat identifier type used across PermissionManager and BanManager.
 * Can be an InputPeer (from resolvePeer), a PeerChat/Chat-like object,
 * or a ManagedGroup-like object with kind/className.
 */
type ChatIdArg = number | MtcuteInputPeer | { chatId?: number | bigInt.BigInteger; id?: number; kind?: string; className?: string; [key: string]: unknown };

/**
 * Entity type returned by safeGetEntity - partial Telegram entity.
 */
type PartialEntity = {
  id?: number | string;
  _?: string;
  chatId?: number | string;
  username?: string;
  title?: string;
  firstName?: string;
  first_name?: string;
  lastName?: string;
  last_name?: string;
  accessHash?: string | number;
};

/**
 * Raw chat full response type for getFullChat.
 */
type _RawChatFull = {
  fullChat?: {
    participants?: {
      _?: string;
      participants?: Array<{ _?: string; userId?: number }>;
    };
  };
  users?: Array<{ id?: number | string; _?: string; [key: string]: unknown }>;
};
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// p-limit 是 ESM-only，必须动态加载
let pLimit: typeof import("p-limit").default;
let pLimitReady: Promise<void> | null = null;
async function ensurePLimit(): Promise<typeof pLimit> {
  if (pLimit) return pLimit;
  if (!pLimitReady) {
    pLimitReady = (async () => {
      try {
        npm_install("p-limit");
      } catch (e: unknown) { logger.warn('操作失败', e) }
      pLimit = (await import("p-limit")).default;
    })();
  }
  await pLimitReady;
  return pLimit;
}

// 解析 FLOOD_WAIT 错误中的等待秒数；非 flood 错返回 null
function getFloodWaitSeconds(error: unknown): number | null {
  const msg = error instanceof Error ? getErrorMessage(error) : String(error || "");
  // teleproto 抛出的 RPCError 里通常带 "FLOOD_WAIT_X" 或 "wait of N seconds"
  let m = msg.match(/FLOOD_WAIT_(\d+)/);
  if (m) return parseInt(m[1], 10);
  m = msg.match(/wait of (\d+) seconds?/i);
  if (m) return parseInt(m[1], 10);
  // teleproto FloodWaitError 的 seconds 字段
  const seconds = (error as { seconds?: number })?.seconds;
  if (typeof seconds === "number" && Number.isFinite(seconds)) return seconds;
  return null;
}

// ==================== 配置常量 ====================
const CONFIG = {
  BATCH_SIZE: 50, // 增加批次大小
  PARALLEL_LIMIT: 20, // 增加并发数
  DEFAULT_MUTE_DURATION: 0, // 0表示永久禁言
  MESSAGE_AUTO_DELETE: 10,
  PER_GROUP_SCAN_LIMIT: 2000,
  CACHE_DB_NAME: "aban_cache.json"
};

// ==================== 帮助文本 ====================
const HELP_TEXT = `<b>封禁管理</b>

<code>${mainPrefix}kick</code> 踢出
<code>${mainPrefix}ban</code> 封禁  
<code>${mainPrefix}unban</code> 解封
<code>${mainPrefix}mute [time]</code> 禁言 (如 60s/5m/1h/1d，不填则永久)
<code>${mainPrefix}unmute</code> 解禁言
<code>${mainPrefix}sb</code> 批量封禁
<code>${mainPrefix}unsb</code> 批量解封
<code>${mainPrefix}refresh</code> 刷新

回复消息或@用户名`;

// 解析时间字符串
function parseTimeString(timeStr?: string): number {
  if (!timeStr) return 0; // 无参数返回0（永久）
  
  const time = timeStr.toLowerCase();
  const num = parseInt(time) || 0;
  
  if (time.includes('d')) return num * 86400;
  if (time.includes('h')) return num * 3600;
  if (time.includes('m')) return num * 60;
  if (time.includes('s')) return num;
  
  return 0; // 默认永久
}

// ==================== 缓存管理器 ====================
type CacheEntry = {
  id: number;
  title?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  type: "user" | "chat" | "channel";
};

type CacheData = {
  cache: Record<string, CacheEntry>;
};

class CacheManager {
  private db: Low<CacheData> | null = null;
  private static instance: CacheManager;
  private initPromise: Promise<void>;

  private constructor() {
    this.initPromise = this.initDb();
  }

  static getInstance(): CacheManager {
    if (!this.instance) {
      this.instance = new CacheManager();
    }
    return this.instance;
  }

  private async initDb(): Promise<void> {
    const dbPath = path.join(
      createDirectoryInAssets("aban"),
      CONFIG.CACHE_DB_NAME
    );
    const adapter = new JSONFile<CacheData>(dbPath);
    this.db = new Low(adapter, { cache: {} });
    await this.db.read();
    if (!this.db.data) {
      this.db.data = { cache: {} };
      await this.db.write();
    }
  }

  async get(key: string): Promise<unknown> {
    await this.initPromise;
    if (!this.db) return null;
    return this.db.data.cache[key] || null;
  }

  async set(key: string, value: CacheEntry): Promise<void> {
    await this.initPromise;
    if (!this.db) return;
    this.db.data.cache[key] = value;
    await this.db.write();
  }

  async clear(): Promise<void> {
    await this.initPromise;
    if (!this.db) return;
    this.db.data.cache = {};
    await this.db.write();
  }
}

// ==================== 用户解析器 ====================
type ResolvedUser = {
  id: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  title?: string;
  type: "user" | "chat" | "channel";
  raw?: unknown;
};

type ResolvedTarget = {
  user: ResolvedUser | null;
  uid: number | null;
  participant?: tl.TypeInputPeer;
  source: "reply" | "username" | "numeric" | "unknown";
  resolutionError?: string;
  chatType?: "channel" | "chat" | "unknown";
};

class UserResolver {
  /** sb/unsb 的 true 确认位，不是用户目标 */
  private static isMetaFlag(arg: string): boolean {
    const a = arg.trim().toLowerCase();
    return a === "true" || a === "false" || a === "confirm";
  }

  static async resolveTarget(
    client: TelegramClient,
    message: MtcuteMessageContext,
    args: string[]
  ): Promise<ResolvedTarget> {
    // 去掉 true/false 等确认参数后再找目标；避免 `.sb true`（回复+确认）把 true 当作用户名
    const targetArgs = args.filter((a) => !this.isMetaFlag(a));

    // 从参数解析（@username / 数字 id）
    if (targetArgs.length > 0) {
      return await this.resolveFromString(client, message, targetArgs[0]);
    }

    // 从回复消息解析
    // mtcute Message 没有 teleproto 的 .senderId，发送者在 .sender.id（Peer/User）
    const reply = await safeGetReplyMessage(message);
    if (reply) {
      const senderPeer = (reply as { sender?: { id?: number | string; type?: string; inputPeer?: tl.TypeInputPeer } }).sender;
      const legacySenderId = (reply as { senderId?: number | string }).senderId;
      const uidRaw = senderPeer?.id ?? legacySenderId;
      const uid = uidRaw != null && uidRaw !== "" ? Number(uidRaw) : NaN;

      if (Number.isFinite(uid) && uid !== 0) {
        const sender = await this.getReplySender(reply as { sender?: unknown });
        // Prefer mtcute Peer.inputPeer (has accessHash); never require teleproto getSender()
        let participant: tl.TypeInputPeer | undefined =
          senderPeer && typeof senderPeer === "object" && senderPeer.inputPeer
            ? senderPeer.inputPeer
            : undefined;
        if (!participant && sender?.raw && typeof sender.raw === "object" && (sender.raw as { inputPeer?: tl.TypeInputPeer }).inputPeer) {
          participant = (sender.raw as { inputPeer: tl.TypeInputPeer }).inputPeer;
        }
        if (!participant) {
          participant = await this.safeGetInputEntity(client, uid);
        }
        if (!participant && sender?.raw) {
          participant = await this.safeGetInputEntity(client, sender.raw);
        }
        const fallbackParticipant =
          participant ||
          (await this.resolveParticipantFromContext(
            client,
            message,
            uid,
            sender?.raw as PartialEntity | undefined,
          ));

        return {
          user: sender ?? { id: uid, type: "user" as const },
          uid,
          participant: fallbackParticipant,
          source: "reply",
          resolutionError: fallbackParticipant ? undefined : "TARGET_ENTITY_UNRESOLVABLE",
          chatType: this.getChatType(message),
        };
      }
    }

    // 诊断：仍失败时写清 reply / args 形态，便于对照 pm2 日志
    try {
      const rinfo = (message as { replyToMessage?: { id?: number | null } }).replyToMessage;
      const hasGetReply = typeof (message as { getReplyTo?: unknown }).getReplyTo === "function";
      logger.warn(
        `[aban] resolveTarget NO_TARGET args=${JSON.stringify(args)} ` +
          `replyToId=${rinfo?.id ?? "null"} hasGetReplyTo=${hasGetReply} ` +
          `safeReply=${reply ? "yes" : "no"} ` +
          `replySenderId=${
            reply
              ? String(
                  (reply as { sender?: { id?: unknown } }).sender?.id ??
                    (reply as { senderId?: unknown }).senderId ??
                    "missing",
                )
              : "n/a"
          } chatType=${this.getChatType(message)} chatId=${chatIdOf(message)}`,
      );
    } catch (e: unknown) {
      logger.warn("[aban] resolveTarget diagnostic failed", e);
    }

    return { user: null, uid: null, source: "unknown", resolutionError: "NO_TARGET", chatType: this.getChatType(message) };
  }

  private static async resolveFromString(
    client: TelegramClient,
    message: MtcuteMessageContext,
    target: string
  ): Promise<ResolvedTarget> {
    try {
      // @username 格式
      if (target.startsWith("@")) {
        const entity = await this.safeGetEntity(client, target);
        const participant = entity ? await this.safeGetInputEntity(client, entity as unknown as number | string) : undefined;
        const uid = entity?.id ? Number(entity.id) : null;
        const fallbackParticipant = uid
          ? participant || await this.resolveParticipantFromContext(client, message, uid, entity as PartialEntity | undefined)
          : undefined;
        return {
          user: entity ? { id: Number(entity.id), firstName: entity.firstName ?? entity.first_name, lastName: entity.lastName ?? entity.last_name, username: entity.username, title: entity.title, type: (entity._ === "user" ? "user" : entity._ === "chat" ? "chat" : "channel") as "user" | "chat" | "channel" } : null,
          uid,
          participant: fallbackParticipant,
          source: "username",
          resolutionError: fallbackParticipant || uid === null ? undefined : "TARGET_ENTITY_UNRESOLVABLE",
          chatType: this.getChatType(message),
        };
      }
      
      // 纯数字 ID（mtcute 本地缓存未命中时 resolvePeer 会抛 MtPeerNotFoundError）
      if (/^-?\d+$/.test(target)) {
        const userId = parseInt(target, 10);
        const resolved = await this.resolveNumericUser(client, message, userId);
        return {
          user: resolved.user,
          uid: userId,
          participant: resolved.participant,
          source: "numeric",
          resolutionError: resolved.participant ? undefined : "TARGET_ENTITY_UNRESOLVABLE",
          chatType: this.getChatType(message),
        };
      }
    } catch (error: unknown) {
      logger.error(`[UserResolver] 解析失败: ${error}`);
    }
    
    return { user: null, uid: null, source: "unknown", resolutionError: "INVALID_TARGET", chatType: this.getChatType(message) };
  }

  private static async getReplySender(reply: { sender?: unknown }): Promise<ResolvedUser | null> {
    try {
      const sender = (reply as { sender?: unknown }).sender;
      if (!sender || typeof sender !== "object") return null;

      // mtcute Peer = User | Chat: .type / .id / .firstName / .username / .title / .inputPeer
      const peer = sender as {
        type?: string;
        id?: number | string;
        firstName?: string;
        first_name?: string;
        lastName?: string | null;
        last_name?: string;
        username?: string | null;
        title?: string;
        _?: string;
        inputPeer?: tl.TypeInputPeer;
      };

      // AnonymousSender has type "anonymous" and no usable id for ban ops
      if (peer.type === "anonymous") return null;

      const id = Number(peer.id ?? 0);
      if (!Number.isFinite(id) || id === 0) return null;

      const t =
        peer.type === "user" || peer.type === "bot" || peer._ === "user"
          ? "user"
          : peer.type === "group" || peer._ === "chat"
            ? "chat"
            : "channel";

      return {
        id,
        firstName: peer.firstName ?? peer.first_name,
        lastName: peer.lastName ?? peer.last_name ?? undefined,
        username: peer.username ?? undefined,
        title: peer.title,
        type: t as "user" | "chat" | "channel",
        raw: sender,
      };
    } catch (e: unknown) {
      logger.warn("aban: failed to extract sender entity", e);
      return null;
    }
  }

  private static getChatType(message: MtcuteMessageContext): "channel" | "chat" | "unknown" {
    // mtcute: Chat.type 恒为 "chat"；细分在 chat.chatType（group/supergroup/channel/...）
    const chat = (message as { chat?: { type?: string; chatType?: string; isGroup?: boolean } }).chat;
    const ct = chat?.chatType || "";
    if (ct === "channel" || ct === "supergroup" || ct === "gigagroup") return "channel";
    if (ct === "group") return "chat";
    // Peer.type 仅 user|chat，不能用来区分超级群
    if ((message as { isChannel?: boolean }).isChannel) return "channel";
    if ((message as { isGroup?: boolean }).isGroup) return "chat";
    // marked id -100… → channel/supergroup
    const id = chatIdOf(message);
    if (id !== 0) {
      const s = String(id);
      if (s.startsWith("-100") || id <= -1000000000000) return "channel";
      if (id < 0) return "chat";
    }
    return "unknown";
  }

  private static async safeGetEntity(
    client: TelegramClient,
    target: string | number
  ): Promise<PartialEntity | null> {
    try {
      // Resolve peer first to determine entity type and ID
      const peer = await (client as unknown as ClientInternals).resolvePeer(target) as { _?: string; userId?: number; chatId?: number; channelId?: number; accessHash?: Long };
      if (!peer) return null;

      const userId = peer.userId ? Number(peer.userId) : undefined;
      const lookUpId = userId ?? (peer.chatId ? Number(peer.chatId) : peer.channelId ? Number(peer.channelId) : undefined);

      // Fetch full entity info for display (firstName, username, title, etc.)
      if (userId) {
        try {
          const users = await client.call({
            _: 'users.getUsers',
            id: [{ _: 'inputUser', userId, accessHash: (peer.accessHash || 0 as unknown as Long) }],
          }) as unknown as Array<Record<string, unknown>>;
          if (Array.isArray(users) && users.length > 0 && (users[0] as { _?: string })._ !== 'userEmpty') {
            return users[0] as PartialEntity;
          }
        } catch { /* fallback to peer */ }
      }

      if (lookUpId) {
        try {
          const chats = await client.call({
            _: 'messages.getChats',
            id: [lookUpId],
          }) as unknown as { chats?: Array<Record<string, unknown>> };
          if (chats?.chats?.[0]) return chats.chats[0] as PartialEntity;
        } catch { /* fallback to peer */ }
      }

      // Fallback: return peer info (may lack display fields but has id)
      return peer as unknown as PartialEntity;
    } catch (e: unknown) {
      logger.warn(`aban: safeGetEntity failed for target ${target}`, e);
      return null;
    }
  }

  private static async safeGetInputEntity(
    client: TelegramClient,
    target: unknown
  ): Promise<tl.TypeInputPeer | undefined> {
    try {
      if (target == null) return undefined;
      // Already an InputPeer / Peer with inputPeer
      if (typeof target === "object") {
        const o = target as { _: string; inputPeer?: tl.TypeInputPeer };
        if (o.inputPeer) return o.inputPeer;
        if (typeof o._ === "string" && o._.startsWith("inputPeer")) {
          return target as tl.TypeInputPeer;
        }
      }
      // mtcute public API
      if (typeof (client as { resolvePeer?: (t: unknown) => Promise<tl.TypeInputPeer> }).resolvePeer === "function") {
        return await (client as { resolvePeer: (t: unknown) => Promise<tl.TypeInputPeer> }).resolvePeer(target);
      }
      // legacy/internal fallbacks
      const internals = client as unknown as ClientInternals;
      if (typeof internals.resolvePeer === "function") {
        return (await internals.resolvePeer(target)) as tl.TypeInputPeer;
      }
      if (typeof internals.getInputEntity === "function") {
        return (await internals.getInputEntity(target)) as tl.TypeInputPeer;
      }
      return undefined;
    } catch (e: unknown) {
      logger.warn("aban: safeGetInputEntity failed", e);
      return undefined;
    }
  }

  /**
   * 按用户数字 ID 解析 InputPeer。
   * mtcute resolvePeer(裸 id) 仅查本地缓存；未见过的用户会 MtPeerNotFoundError。
   * 超级群/频道：channels.getParticipant(accessHash=0) 让服务端回填 accessHash。
   */
  private static async resolveNumericUser(
    client: TelegramClient,
    message: MtcuteMessageContext,
    userId: number,
  ): Promise<{ user: ResolvedUser | null; participant?: tl.TypeInputPeer }> {
    let participant = await this.safeGetInputEntity(client, userId);
    let entity = await this.safeGetEntity(client, userId);

    if (!participant) {
      participant = await this.resolveParticipantFromContext(
        client,
        message,
        userId,
        entity as PartialEntity | undefined,
      );
    }

    if (!participant) {
      participant = await this.resolveUserViaGetParticipant(client, chatIdOf(message), userId);
    }

    let user: ResolvedUser | null = null;
    if (entity) {
      user = {
        id: userId,
        firstName: entity.firstName ?? entity.first_name,
        lastName: entity.lastName ?? entity.last_name,
        username: entity.username,
        title: entity.title,
        type: "user",
        raw: entity,
      };
    } else if (participant) {
      user = { id: userId, type: "user" };
    }

    return { user, participant };
  }

  /** 在频道/超级群内用裸 userId 解析成员（getParticipant + accessHash 0） */
  private static async resolveUserViaGetParticipant(
    client: TelegramClient,
    chatId: number,
    userId: number,
  ): Promise<tl.TypeInputPeer | undefined> {
    if (!chatId || !userId) return undefined;
    const s = String(chatId);
    const looksChannel = s.startsWith("-100") || chatId <= -1_000_000_000_000;

    // basic group
    if (!looksChannel && chatId < 0) {
      try {
        const full = await client.call({
          _: "messages.getFullChat",
          chatId: Math.abs(chatId),
        } as Parameters<typeof client.call>[0]) as {
          users?: Array<{ _?: string; id?: number; accessHash?: string | number | bigint }>;
        };
        const matched = (full.users || []).find(
          (u) => Number(u?.id) === userId && u._ === "user",
        );
        if (matched && matched.accessHash != null) {
          return {
            _: "inputPeerUser",
            userId,
            accessHash: matched.accessHash as unknown as Long,
          } as tl.TypeInputPeer;
        }
      } catch (e: unknown) {
        logger.warn("aban: basic group resolve by id failed", e);
      }
      return undefined;
    }

    if (!looksChannel && chatId > 0) {
      // 可能是未标记的 channel raw id；仍尝试 resolvePeer
    }

    try {
      const channelPeer = await client.resolvePeer(chatId);
      const p = channelPeer as { _: string; channelId?: number; accessHash?: Long };
      const channelInput =
        p._ === "inputPeerChannel"
          ? {
              _: "inputChannel" as const,
              channelId: p.channelId as number,
              accessHash: p.accessHash as Long,
            }
          : channelPeer;

      const res = await client.call({
        _: "channels.getParticipant",
        channel: channelInput as unknown as MtcuteInputChannel,
        participant: {
          _: "inputPeerUser",
          userId,
          accessHash: 0 as unknown as Long,
        },
      } as Parameters<typeof client.call>[0]) as {
        users?: Array<{
          _?: string;
          id?: number;
          accessHash?: string | number | bigint;
        }>;
      };

      const matched = (res.users || []).find(
        (u) => Number(u?.id) === userId && u._ === "user",
      );
      if (matched && matched.accessHash != null) {
        return {
          _: "inputPeerUser",
          userId,
          accessHash: matched.accessHash as unknown as Long,
        } as tl.TypeInputPeer;
      }
    } catch (e: unknown) {
      logger.warn(`aban: getParticipant by id failed chat=${chatId} user=${userId}`, e);
    }
    return undefined;
  }

  private static async resolveParticipantFromContext(
    client: TelegramClient,
    message: MtcuteMessageContext,
    userId: number,
    knownEntity?: PartialEntity
  ): Promise<tl.TypeInputPeer | undefined> {
    const chat = chatIdOf(message);
    if (!chat) {
      return undefined;
    }

    const chatType = this.getChatType(message);
    const chatStr = String(chat);
    const isChannelLike =
      chatType === "channel" ||
      chatStr.startsWith("-100") ||
      chat <= -1_000_000_000_000 ||
      !!(message as { isChannel?: boolean }).isChannel ||
      (message as { chat?: { chatType?: string } }).chat?.chatType === "supergroup" ||
      (message as { chat?: { chatType?: string } }).chat?.chatType === "channel";

    if (isChannelLike) {
      try {
        // 最快路径：getParticipant(裸 id) — 目标是成员时一次成功
        const viaPart = await this.resolveUserViaGetParticipant(client, chat, userId);
        if (viaPart) return viaPart;

        // channels.getParticipants 需要 InputChannel，不能直接塞 marked chat id
        const channelPeer = await client.resolvePeer(chat);
        let offset = 0;
        const limit = 200;
        for (let i = 0; i < 5; i++) {
          const res = await client.call({
              _: 'channels.getParticipants',
              channel: channelPeer,
              filter: { _: 'channelParticipantsRecent' } as tl.TypeChannelParticipantsFilter,
              offset,
              limit,
              hash: 0,
            } as unknown as Parameters<typeof client.call>[0]);

          const rawRes = res as tl.channels.RawChannelParticipants;
          const participants = rawRes.participants ?? [];
          const users = (rawRes.users ?? []).filter(
            (u): u is tl.RawUser => u != null && (u as tl.RawUser)._ === 'user',
          );
          const matchedUser = users.find((u) => Number(u?.id) === userId);
          if (matchedUser) {
            const ah = (matchedUser as { accessHash?: string | number | bigint }).accessHash;
            if (ah != null) {
              return {
                _: "inputPeerUser",
                userId,
                accessHash: ah as unknown as Long,
              } as tl.TypeInputPeer;
            }
            const input = await this.safeGetInputEntity(client, matchedUser);
            if (input) {
              return input;
            }
          }

          if (!participants.length) break;
          offset += participants.length;
        }
      } catch (e: unknown) {
        logger.warn('aban: findParticipantPage failed', e);
        return undefined;
      }
    }

    if (chatType === "chat" || (message as { isGroup?: boolean }).isGroup) {
      try {
        const peer = knownEntity || await this.safeGetEntity(client, chat as unknown as string | number);
        const chatId = Number(peer?.chatId ?? peer?.id ?? (chat as { chatId?: number })?.chatId);
        if (!Number.isFinite(chatId)) {
          return undefined;
        }

        const full = await client.call({
            _: 'messages.getFullChat',
            chatId: Number(bigInt(chatId)),
        }) as unknown as { fullChat?: { participants?: { _?: string }; users?: unknown[] } };

        const participants = full?.fullChat?.participants;
        if (!participants || participants?._ === 'chatParticipantsForbidden') {
          return undefined;
        }
        const users: unknown[] = full?.fullChat?.users || [];
        const matchedUser = users.find((u) => Number((u as { id?: number })?.id) === userId);
        if (matchedUser) {
          return await this.safeGetInputEntity(client, matchedUser);
        }
      } catch (e: unknown) {
        logger.warn('aban: getFullChat participant lookup failed', e);
        return undefined;
      }
    }

    return undefined;
  }

  static formatUser(user: { firstName?: string; first_name?: string; lastName?: string; last_name?: string; username?: string; title?: string } | null, userId: number): string {
    if (user?.firstName || user?.first_name) {
      let name = user.firstName || user.first_name || String(userId);
      if (user.lastName || user.last_name) {
        name += ` ${user.lastName || user.last_name}`;
      }
      if (user.username) {
        name += ` (@${user.username})`;
      }
      return name;
    } else if (user?.title) {
      return `频道: ${user.title}${user.username ? ` (@${user.username})` : ''}`;
    }
    return String(userId);
  }
}

// ==================== 消息管理器 ====================
class MessageManager {
  static async smartEdit(
    message: MtcuteMessageContext,
    text: string,
    deleteAfter: number = CONFIG.MESSAGE_AUTO_DELETE
  ): Promise<MtcuteMessageContext> {
    try {
      const client = await getGlobalClient();
      if (!client) return message;

      await message.edit({text});

      if (deleteAfter > 0) {
        const lifecycle = getCurrentGenerationContext();
        if (lifecycle) {
          lifecycle.setTimeout(async () => {
            try {
              const peerId = chatIdOf(message);
              await client.deleteMessagesById(peerId as unknown as number, [message.id], {
                revoke: true,
              });
            } catch (e: unknown) {
              const msg = getErrorMessage(e);
              if (!msg.includes('MESSAGE_ID_INVALID')) {
                logger.error(`删除消息失败: ${e}`);
              }
            }
          }, deleteAfter * 1000, { label: 'aban:smartEdit-delayed-delete' });
        }
      }

      return message;
    } catch (error: unknown) {
      const errMsg = getErrorMessage(error) || String(error);
      if (errMsg.includes('MESSAGE_ID_INVALID')) {
        // Expected when the target message was already deleted - not actionable
      } else {
        logger.error(`编辑消息失败: ${errMsg}`);
      }
      return message;
    }
  }
}

// ==================== 权限管理器 ====================
type ManagedGroup = {
  id: number;
  title: string;
  kind: ChatKind;
  // bigint 序列化为字符串。channel 必填；basic group 不需要
  accessHash?: string;
};

/**
 * 把 ManagedGroup 转成可以直接喂给 any.* 的 channel 参数。
 * - channel 有 accessHash → 构造完整 InputChannel，直接走，不触发 GetChannels 兜底
 * - channel 无 accessHash（旧缓存或未填）→ 通过 getInputEntity 让 teleproto 自行解析
 * - basic group → 返回裸 id（调用方应通过 kind 分流到 messages.* 路径）
 */
async function resolveChannelInput(
  client: TelegramClient,
  group: ManagedGroup
): Promise<tl.TypeInputChannel | number> {
  if (group.kind !== 'channel') {
    return group.id;
  }
  if (group.accessHash) {
    return {
      _: "inputChannel" as const,
      channelId: bigInt(group.id) as unknown as number,
      accessHash: bigInt(group.accessHash) as unknown as tl.Long,
    };
  }
  // 兜底：mtcute resolvePeer（marked id 或 raw 均可；优先 -100 前缀）
  try {
    const marked = group.id > 0 ? Number(`-100${group.id}`) : group.id;
    const peer = await client.resolvePeer(marked);
    // inputPeerChannel / inputChannel 形状
    const p = peer as { _: string; channelId?: number | bigint; accessHash?: tl.Long };
    if (p && (p._ === "inputPeerChannel" || p._ === "inputChannel")) {
      return {
        _: "inputChannel",
        channelId: p.channelId as number,
        accessHash: p.accessHash as tl.Long,
      };
    }
    return peer as unknown as tl.TypeInputChannel;
  } catch (e: unknown) {
    logger.warn(`[aban] resolveChannelInput fallback failed id=${group.id}`, e);
    throw e;
  }
}

/**
 * 把 ManagedGroup 转成 PermissionManager 那一组方法能识别的 chatId。
 * - channel：返回 InputChannel（带 accessHash），走 any.GetParticipant
 * - basic group：返回 PeerChat-like 对象，让 getChatKind/getBasicGroupChatId 走 chat 路径
 */
async function resolvePermissionTarget(
  client: TelegramClient,
  group: ManagedGroup
): Promise<MtcuteInputPeer | { className: string; chatId: bigInt.BigInteger }> {
  if (group.kind === 'chat') {
    return { className: 'PeerChat', chatId: bigInt(group.id) };
  }
  const channel = await resolveChannelInput(client, group);
  if (typeof channel === 'number') {
    // basic group without channel info — shouldn't happen if kind is correct
    return { className: 'PeerChat', chatId: bigInt(channel) };
  }
  return channel as unknown as MtcuteInputPeer | { className: string; chatId: bigInt.BigInteger };
}

class PermissionManager {
  private static getChatKind(chatId: ChatIdArg | { kind?: string }): ChatKind {
    const obj = chatId as { kind?: string; className?: string };
    if (obj?.kind === 'chat' || obj?.kind === 'channel') {
      return obj.kind;
    }
    const className = obj?.className;
    if (className === 'PeerChat' || className === 'Chat') {
      return 'chat';
    }
    return 'channel';
  }

  private static getBasicGroupChatId(chatId: { chatId?: number; id?: number }): number {
    return Number(chatId?.chatId ?? chatId?.id);
  }

  private static async getBasicGroupParticipants(client: TelegramClient, chatId: unknown): Promise<Array<{ _?: string; userId?: number }> | null> {
    const full = await client.call({
        _: 'messages.getFullChat',
        chatId: Number(this.getBasicGroupChatId(chatId as { chatId?: number; id?: number })),
      } as Parameters<typeof client.call>[0]) as { fullChat?: { participants?: { _?: string; participants?: Array<{ _?: string; userId?: number }> } } };

    const participants = full?.fullChat?.participants;
    if (!participants || participants?._ === 'chatParticipantsForbidden') {
      return null;
    }

    return participants.participants || null;
  }

  static async checkAdminPermission(
    client: TelegramClient,
    chatId: ChatIdArg
  ): Promise<boolean> {
    try {
      const me = await safeGetMe(client);
      if (!me) return false;
      if (this.getChatKind(chatId) === 'chat') {
        const participants = await this.getBasicGroupParticipants(client, chatId);
        if (!participants) {
          return false;
        }

        const meParticipant = participants.find((p: { userId?: number }) => Number(p?.userId) === Number((me as { id?: number | string }).id));
        return meParticipant?._ === 'chatParticipantCreator' || meParticipant?._ === 'chatParticipantAdmin';
      }

      const participant = await client.call({
          _: 'channels.getParticipant',
          channel: chatId as unknown as MtcuteInputChannel,
          participant: await client.resolvePeer(me.id)
        });

      const p = participant.participant;
      if (p?._ === 'channelParticipantCreator') return true;
      if (p?._ === 'channelParticipantAdmin') {
        const rights = p.adminRights;
        return !!(rights?.banUsers || rights?.deleteMessages);
      }
      return false;
    } catch (e: unknown) {
      logger.warn('aban: isMeAdmin check failed', e);
      return false;
    }
  }

  static async isTargetAdmin(
    client: TelegramClient,
    chatId: ChatIdArg,
    userId: number
  ): Promise<boolean> {
    try {
      if (this.getChatKind(chatId) === 'chat') {
        const participants = await this.getBasicGroupParticipants(client, chatId);
        if (!participants) {
          return false;
        }

        const targetParticipant = participants.find((p: { userId?: string | number; _?: string }) => Number(p?.userId) === userId);
        return targetParticipant?._ === 'chatParticipantCreator' || targetParticipant?._ === 'chatParticipantAdmin';
      }

      const participant = await client.call({
          _: 'channels.getParticipant',
          channel: chatId as unknown as MtcuteInputChannel,
          participant: await client.resolvePeer(userId)
        });
      
      const p = participant.participant;
      return (
        p?._ === 'channelParticipantCreator' ||
        p?._ === 'channelParticipantAdmin'
      );
    } catch (e: unknown) {
      logger.warn('aban: isOwnerOrAdmin check failed', e);
      return false;
    }
  }

  static async canDeleteMessages(
    client: TelegramClient,
    chatId: ChatIdArg
  ): Promise<boolean> {
    try {
      const me = await safeGetMe(client);
      if (!me) return false;
      if (this.getChatKind(chatId) === 'chat') {
        const participants = await this.getBasicGroupParticipants(client, chatId);
        if (!participants) {
          return false;
        }

        const meParticipant = participants.find((p: { userId?: number }) => Number(p?.userId) === Number((me as { id?: number | string }).id));
        return meParticipant?._ === 'chatParticipantCreator' || meParticipant?._ === 'chatParticipantAdmin';
      }

      const participant = await client.call({
          _: 'channels.getParticipant',
          channel: chatId as unknown as MtcuteInputChannel,
          participant: await client.resolvePeer(me.id)
        });
      
      const p = participant.participant;
      if (p?._ === 'channelParticipantCreator') return true;
      if (p?._ === 'channelParticipantAdmin') {
        return !!p.adminRights?.deleteMessages;
      }
      return false;
    } catch (e: unknown) {
      logger.warn('aban: canDeleteMessages check failed', e);
      return false;
    }
  }
}

// ==================== 群组管理器 ====================
class GroupManager {
  private static cache = CacheManager.getInstance();

  /**
   * mtcute 没有 teleproto 的 client.getDialogs()；应使用 iterDialogs。
   * Dialog 形状：dialog.peer (User|Chat)，无 isChannel/isGroup/entity 顶层字段。
   */
  static async getAllManageableDialogs(client: TelegramClient): Promise<Array<{
    id: number;
    isChannel: boolean;
    isGroup: boolean;
    title: string;
    entity?: { id?: number; accessHash?: string | number; inputPeer?: unknown };
  }>> {
    const dialogMap = new Map<number, {
      id: number;
      isChannel: boolean;
      isGroup: boolean;
      title: string;
      entity?: { id?: number; accessHash?: string | number; inputPeer?: unknown };
    }>();

    const collectDialogs = async (params?: { archived?: "keep" | "exclude" | "only" }) => {
      // Prefer public iterDialogs (async iterator). Fall back only if somehow present.
      const iter = (client as { iterDialogs?: (p?: unknown) => AsyncIterable<unknown> }).iterDialogs;
      if (typeof iter !== "function") {
        throw new TypeError(
          "client.iterDialogs is not a function (mtcute requires iterDialogs, not getDialogs)",
        );
      }
      for await (const dialog of iter.call(client, params ?? {}) as AsyncIterable<{
        peer?: {
          id?: number | string;
          type?: string;
          title?: string;
          accessHash?: string | number | null;
          inputPeer?: unknown;
        };
      }>) {
        const peer = dialog?.peer as {
          id?: number | string;
          type?: string;
          chatType?: string;
          isGroup?: boolean;
          title?: string;
          accessHash?: string | number | null;
          inputPeer?: unknown;
          raw?: { _?: string; id?: number | string; accessHash?: string | number | bigint };
        } | undefined;
        if (!peer || peer.id == null) continue;
        // mtcute: User.type==="user"；Chat.type 恒 "chat"，细分在 peer.chatType
        if (peer.type === "user" || peer.type === "bot") continue;

        const rawUnderscore = peer.raw?._;
        let chatType = peer.chatType || "";
        if (!chatType && rawUnderscore) {
          if (rawUnderscore === "chat" || rawUnderscore === "chatForbidden") chatType = "group";
          else if (rawUnderscore === "channel" || rawUnderscore === "channelForbidden") chatType = "channel";
        }

        const isBasicGroup = chatType === "group";
        const isChannelLike =
          chatType === "channel" ||
          chatType === "supergroup" ||
          chatType === "gigagroup";
        if (!isBasicGroup && !isChannelLike) continue;

        const markedId = Number(peer.id);
        if (!Number.isFinite(markedId)) continue;

        // InputChannel.channelId / DeleteChatUser.chatId 需要 raw 正数 id，不是 marked id
        const rawTl = (peer as { raw?: { id?: number | string; channelId?: number | string; accessHash?: string | number | bigint } }).raw;
        let rawId: number;
        if (isChannelLike) {
          // channel/supergroup: prefer TL channel id; else unmark -100…
          const fromRaw = rawTl?.id != null ? Number(rawTl.id) : NaN;
          if (Number.isFinite(fromRaw) && fromRaw > 0) {
            rawId = fromRaw;
          } else {
            const s = String(markedId);
            rawId = s.startsWith("-100") ? Number(s.slice(4)) : Math.abs(markedId);
          }
        } else {
          // basic group: raw chat id positive
          const fromRaw = rawTl?.id != null ? Number(rawTl.id) : NaN;
          rawId = Number.isFinite(fromRaw) && fromRaw > 0 ? fromRaw : Math.abs(markedId);
        }

        const accessHash =
          rawTl?.accessHash != null
            ? (rawTl.accessHash as string | number)
            : (peer as { accessHash?: string | number | null }).accessHash != null
              ? ((peer as { accessHash: string | number }).accessHash as string | number)
              : undefined;

        dialogMap.set(markedId, {
          id: markedId,
          isChannel: isChannelLike,
          isGroup: isBasicGroup || chatType === "supergroup" || chatType === "gigagroup",
          title: peer.title || "Unknown",
          entity: {
            id: rawId,
            accessHash,
            inputPeer: peer.inputPeer,
          },
        });
      }
    };

    // 主列表 + 归档（mtcute 用 archived: 'only'，不是 teleproto folderId: 1）
    await collectDialogs({ archived: "exclude" });
    try {
      await collectDialogs({ archived: "only" });
    } catch (e: unknown) {
      logger.warn("[GroupManager] 归档会话枚举失败（可忽略）", e);
    }

    return Array.from(dialogMap.values());
  }

  static async getManagedGroups(
    client: TelegramClient
  ): Promise<ManagedGroup[]> {
    // v4: mtcute iterDialogs 映射；旧 v3 可能缓存了空数组
    const cached = await this.cache.get("managed_groups_v4");
    if (cached && Array.isArray(cached) && (cached as unknown[]).length > 0) {
      return cached as ManagedGroup[];
    }

    const groups: ManagedGroup[] = [];

    try {
      const dialogs = await this.getAllManageableDialogs(client);
      logger.info(`[GroupManager] 枚举到 ${dialogs.length} 个群/频道会话`);

      // 与 Classic 对齐：不再预检查管理员权限。
      // 批量 sb/unsb 由各群实际 API 返回权限错误，避免 checkAdminPermission 误判导致「无管理群组」。
      for (const dialog of dialogs) {
        if (!(dialog.isChannel || dialog.isGroup)) continue;
        const isChannel = !!dialog.isChannel;
        const rawHash = isChannel ? dialog.entity?.accessHash : undefined;
        const accessHash = rawHash != null ? String(rawHash) : undefined;
        // entity.id = raw 正数 id（InputChannel.channelId / chatId）
        const rawId = Number(dialog.entity?.id);
        if (!Number.isFinite(rawId) || rawId === 0) continue;
        groups.push({
          id: rawId,
          title: dialog.title || "Unknown",
          kind: isChannel ? ("channel" as const) : ("chat" as const),
          accessHash,
        });
      }

      try {
        await this.cache.set("managed_groups_v4", groups as unknown as CacheEntry);
        // 清掉旧空缓存 key，避免其它路径读到 v3 空列表
        try {
          await this.cache.set("managed_groups_v3", [] as unknown as CacheEntry);
        } catch {
          /* ignore */
        }
      } catch (cacheError: unknown) {
        logger.error(`[GroupManager] 缓存群组失败: ${cacheError}`);
      }
    } catch (error: unknown) {
      logger.error(`[GroupManager] 获取群组失败: ${error}`);
    }

    return groups;
  }

  static async clearCache(): Promise<void> {
    await this.cache.clear();
  }
}

// ==================== 封禁操作管理器 ====================
type BatchGroupFailure = {
  group: ManagedGroup;
  reason: string;
};

type ChatKind = "channel" | "chat";

type BatchBanResult = {
  success: number;
  failed: number;
  failedGroups: string[];
  failureDetails: BatchGroupFailure[];
  unresolved: boolean;
  unresolvedReason?: string;
};

class BanManager {
  static async resolveParticipant(
    client: TelegramClient,
    userId: number,
    participant?: tl.TypeInputPeer
  ): Promise<tl.TypeInputPeer> {
    if (participant) {
      return participant;
    }
    return (client as unknown as ClientInternals).getInputEntity(userId) as Promise<tl.TypeInputPeer>;
  }

  private static getErrorReason(error: unknown): string {
    const message = error instanceof Error ? getErrorMessage(error) : String(error || "UNKNOWN_ERROR");
    const match = message.match(/[A-Z_]{3,}/);
    return match?.[0] || message;
  }

  private static getChatKind(chatId: any): ChatKind {
    if (chatId?.kind === 'chat' || chatId?.kind === 'channel') {
      return chatId.kind;
    }

    const className = chatId?.className;
    if (className === 'PeerChat' || className === 'Chat') {
      return 'chat';
    }
    return 'channel';
  }

  private static getBasicGroupChatId(chatId: { chatId?: number; id?: number }): number {
    return Number(chatId?.chatId ?? chatId?.id);
  }

  private static async applyBanLikeAction(
    client: TelegramClient,
    chatId: ChatIdArg,
    resolvedParticipant: tl.TypeInputPeer,
    bannedRights: { _: 'chatBannedRights'; untilDate: number; [key: string]: unknown },
    action: 'ban' | 'unban' | 'mute'
  ): Promise<void> {
    const chatKind = this.getChatKind(chatId);
    if (chatKind === 'chat') {
      if (action === 'unban' || action === 'mute') {
        throw new Error('BASIC_GROUP_ACTION_UNSUPPORTED');
      }

      await client.call({
          _: 'messages.deleteChatUser',
          chatId: Number(bigInt(this.getBasicGroupChatId(chatId as { chatId?: number; id?: number }))),
          userId: resolvedParticipant as unknown as MtcuteInputUser,
        });
      return;
    }

    await client.call({
        _: 'channels.editBanned',
        channel: chatId as unknown as MtcuteInputChannel,
        participant: resolvedParticipant,
        bannedRights,
      });
  }

  static async banUser(
    client: TelegramClient,
    chatId: ChatIdArg,
    userId: number,
    _until: number = 0,
    participant?: tl.TypeInputPeer
  ): Promise<boolean> {
    try {
      const resolvedParticipant = await this.resolveParticipant(client, userId, participant);
      const rights = { _: 'chatBannedRights' as const,
        untilDate: 0,
        viewMessages: true,
        sendMessages: true,
        sendMedia: true,
        sendStickers: true,
        sendGifs: true,
        sendGames: true,
        sendInline: true,
        embedLinks: true,
      };

      await this.applyBanLikeAction(client, chatId, resolvedParticipant, rights, 'ban');
      return true;
    } catch (error: unknown) {
      logger.error(`[BanManager] 封禁失败: ${error}`);
      return false;
    }
  }

  static async unbanUser(
    client: TelegramClient,
    chatId: ChatIdArg,
    userId: number,
    participant?: tl.TypeInputPeer
  ): Promise<boolean> {
    try {
      const resolvedParticipant = await this.resolveParticipant(client, userId, participant);
      const rights = { _: 'chatBannedRights' as const, 
        untilDate: 0,
      };

      await this.applyBanLikeAction(client, chatId, resolvedParticipant, rights, 'unban');
      return true;
    } catch (error: unknown) {
      logger.error(`[BanManager] 解封失败: ${error}`);
      return false;
    }
  }

  static async muteUser(
    client: TelegramClient,
    chatId: ChatIdArg,
    userId: number,
    duration: number,
    participant?: tl.TypeInputPeer
  ): Promise<boolean> {
    try {
      const resolvedParticipant = await this.resolveParticipant(client, userId, participant);
      const until = duration === 0 ? 0 : Math.floor(Date.now() / 1000) + duration;
      const rights = { _: 'chatBannedRights' as const, 
        untilDate: until,
        sendMessages: true,
        sendMedia: true,
        sendStickers: true,
        sendGifs: true,
        sendGames: true,
        sendInline: true,
        embedLinks: true,
      };

      await this.applyBanLikeAction(client, chatId, resolvedParticipant, rights, 'mute');
      return true;
    } catch (error: unknown) {
      logger.error(`[BanManager] 禁言失败: ${error}`);
      return false;
    }
  }

  static async kickUser(
    client: TelegramClient,
    chatId: ChatIdArg,
    userId: number,
    participant?: tl.TypeInputPeer
  ): Promise<boolean> {
    try {
      if (this.getChatKind(chatId) === 'chat') {
        return await this.banUser(client, chatId, userId, 0, participant);
      }

      const banned = await this.banUser(client, chatId, userId, 0, participant);
      if (!banned) {
        return false;
      }

      return await this.unbanUser(client, chatId, userId, participant);
    } catch (error: unknown) {
      logger.error(`[BanManager] 踢出失败: ${error}`);
      return false;
    }
  }

  // 删除用户在当前会话的消息（sb命令优化）
  static async deleteHistoryInCurrentChat(
    client: TelegramClient,
    chatId: ChatIdArg,
    userId: number,
    participant?: tl.TypeInputPeer
  ): Promise<boolean> {
    try {
      const canDelete = await PermissionManager.canDeleteMessages(client, chatId);
      if (!canDelete) {
        logger.info(`[BanManager] 无删除消息权限`);
        return false;
      }

      const resolvedParticipant: tl.TypeInputPeer = participant || await (client as { resolvePeer: (target: unknown) => Promise<tl.TypeInputPeer> }).resolvePeer(userId);

      await client.call({
          _: 'channels.deleteParticipantHistory',
          channel: chatId as unknown as MtcuteInputChannel,
          participant: resolvedParticipant,
        });
      
      logger.info(`[BanManager] 成功删除用户 ${userId} 在当前会话的所有消息`);
      return true;
    } catch (error: unknown) {
      // 静默处理常见错误
      if (!/CHANNEL_INVALID|CHAT_ADMIN_REQUIRED|USER_NOT_PARTICIPANT/.test(getErrorMessage(error))) {
        logger.error(`[BanManager] 删除消息失败: ${getErrorMessage(error)}`);
      }
      return false;
    }
  }

  static async batchBanUser(
    client: TelegramClient,
    groups: ManagedGroup[],
    userId: number,
    participant?: tl.TypeInputPeer,
    reason: string = "跨群违规"
  ): Promise<BatchBanResult> {
    let resolvedParticipant: tl.TypeInputPeer;
    try {
      resolvedParticipant = await this.resolveParticipant(client, userId, participant);
    } catch (error: unknown) {
      return {
        success: 0,
        failed: groups.length,
        failedGroups: groups.map((group) => group.title),
        failureDetails: [],
        unresolved: true,
        unresolvedReason: this.getErrorReason(error),
      };
    }

    const rights = { _: 'chatBannedRights' as const,
      untilDate: 0,
      viewMessages: true,
      sendMessages: true,
      sendMedia: true,
      sendStickers: true,
      sendGifs: true,
      sendGames: true,
      sendInline: true,
      embedLinks: true,
    };

    const limit = (await ensurePLimit())(4);

    const runOne = async (
      group: ManagedGroup
    ): Promise<
      | { success: true; group: ManagedGroup }
      | { success: false; group: ManagedGroup; reason: string }
    > => {
      const buildRequest = async (): Promise<unknown> => {
        if (group.kind === 'chat') {
          return client.call({
              _: 'messages.deleteChatUser',
              chatId: Number(this.getBasicGroupChatId({ id: group.id })),
              userId: resolvedParticipant as unknown as MtcuteInputUser,
            });
        }
        const channelInput = await resolveChannelInput(client, group);
        return client.call({
              _: 'channels.editBanned',
              channel: channelInput as unknown as MtcuteInputChannel,
              participant: resolvedParticipant,
              bannedRights: rights,
            });
      };

      // 单组重试：FLOOD_WAIT 等待 ≤ 8s 时重试一次，其余错误直接返回
      const attempt = async (retriesLeft: number): Promise<
        | { success: true; group: ManagedGroup }
        | { success: false; group: ManagedGroup; reason: string }
      > => {
        try {
          await buildRequest();
          return { success: true as const, group };
        } catch (error: unknown) {
          const floodSecs = getFloodWaitSeconds(error);
          if (floodSecs !== null && floodSecs <= 8 && retriesLeft > 0) {
            await sleep((floodSecs + 1) * 1000);
            return attempt(retriesLeft - 1);
          }
          return {
            success: false as const,
            group,
            reason: this.getErrorReason(error),
          };
        }
      };

      return attempt(1);
    };

    const settled = await Promise.allSettled(
      groups.map((group) => limit(() => runOne(group)))
    );

    const results: Array<
      | { success: true; group: ManagedGroup }
      | { success: false; group: ManagedGroup; reason: string }
    > = settled.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      return {
        success: false as const,
        group: groups[index],
        reason: this.getErrorReason(result.reason),
      };
    });
    
    let success = 0;
    let failed = 0;
    const failedGroups: string[] = [];
    const failureDetails: BatchGroupFailure[] = [];
    
    results.forEach((result) => {
      if (result.success) {
        success++;
      } else {
        failed++;
        failedGroups.push(result.group.title);
        failureDetails.push({
          group: result.group,
          reason: (result as { reason: string }).reason,
        });
      }
    });

    void reason;
    return {
      success,
      failed,
      failedGroups,
      failureDetails,
      unresolved: false,
    };
  }

  // 批量解封操作（全并发版本）
  static async batchUnbanUser(
    client: TelegramClient,
    groups: ManagedGroup[],
    userId: number,
    participant?: tl.TypeInputPeer
  ): Promise<{ success: number; failed: number; failedGroups: string[]; unresolved: boolean; unresolvedReason?: string }> {
    let resolvedParticipant: tl.TypeInputPeer;
    try {
      resolvedParticipant = await this.resolveParticipant(client, userId, participant);
    } catch (error: unknown) {
      return {
        success: 0,
        failed: groups.length,
        failedGroups: groups.map((group) => group.title),
        unresolved: true,
        unresolvedReason: this.getErrorReason(error),
      };
    }

    const rights = { _: 'chatBannedRights' as const,
      untilDate: 0,
    };

    const limit = (await ensurePLimit())(4);

    const runOne = async (
      group: ManagedGroup
    ): Promise<{ success: boolean; group: ManagedGroup }> => {
      if (group.kind === 'chat') {
        // 基础群不支持解封操作
        return { success: false, group };
      }

      const buildRequest = async (): Promise<unknown> => {
        const channelInput = await resolveChannelInput(client, group);
        return client.call({
              _: 'channels.editBanned',
              channel: channelInput as unknown as MtcuteInputChannel,
              participant: resolvedParticipant,
              bannedRights: rights,
            });
      };

      const attempt = async (
        retriesLeft: number
      ): Promise<{ success: boolean; group: ManagedGroup }> => {
        try {
          await buildRequest();
          return { success: true, group };
        } catch (error: unknown) {
          const floodSecs = getFloodWaitSeconds(error);
          if (floodSecs !== null && floodSecs <= 8 && retriesLeft > 0) {
            await sleep((floodSecs + 1) * 1000);
            return attempt(retriesLeft - 1);
          }
          return { success: false, group };
        }
      };

      return attempt(1);
    };

    const settled = await Promise.allSettled(
      groups.map((group) => limit(() => runOne(group)))
    );

    const results: Array<{ success: boolean; group: ManagedGroup }> = settled.map(
      (result, index) => {
        if (result.status === 'fulfilled') {
          return result.value;
        }
        return { success: false, group: groups[index] };
      }
    );
    
    let success = 0;
    let failed = 0;
    const failedGroups: string[] = [];
    
    results.forEach((result) => {
      if (result.success) {
        success++;
      } else {
        failed++;
        failedGroups.push(result.group.title);
      }
    });

    return { success, failed, failedGroups, unresolved: false };
  }
}

// ==================== 命令处理器 ====================
class CommandHandlers {
  // 单群基础命令处理
  static async handleBasicCommand(
    client: TelegramClient,
    message: any,
    action: 'kick' | 'ban' | 'unban' | 'mute' | 'unmute'
  ): Promise<void> {
    try {
      // 权限检查
      const hasPermission = await PermissionManager.checkAdminPermission(
        client,
        chatIdOf(message)
      );
      
      if (!hasPermission) {
        await MessageManager.smartEdit(message, "❌ 无管理员权限");
        return;
      }

      // 解析参数
      const rawText = String(message.text ?? message.rawText ?? "").trim();
      const args = rawText ? rawText.split(/\s+/).slice(1) : [];
      const { user, uid, participant, resolutionError, chatType } = await UserResolver.resolveTarget(client, message, args);

      if (!uid) {
        logger.warn(`[aban] 获取用户失败 uid=null args=${JSON.stringify(args)} err=${resolutionError}`);
        await MessageManager.smartEdit(
          message,
          "❌ 获取用户失败（请回复目标用户的消息，或附带 @用户名 / 用户ID；true 仅作确认参数）",
        );
        return;
      }

      const basicGroupActionAllowedWithoutParticipant = chatType === 'chat' && ['ban', 'kick'].includes(action);
      if (!participant && ['ban', 'unban', 'mute', 'unmute', 'kick'].includes(action) && !basicGroupActionAllowedWithoutParticipant) {
        const errorText = resolutionError === 'TARGET_ENTITY_UNRESOLVABLE'
          ? '❌ 无法解析该目标的 Telegram 实体，请使用回复消息或 @用户名 后再试'
          : '❌ 获取用户失败';
        await MessageManager.smartEdit(message, errorText);
        return;
      }

      // 检查目标是否为管理员
      const isAdmin = await PermissionManager.isTargetAdmin(client, chatIdOf(message), uid);
      if (isAdmin) {
        const hasConfirm = args.includes('true');
        if (!hasConfirm) {
          await MessageManager.smartEdit(message, "⚠️ 目标是管理员，请在命令后加上 <code>true</code> 确认执行");
          return;
        }
      }

      const display = UserResolver.formatUser(user, uid);
      const status = await MessageManager.smartEdit(
        message,
        `⏳ ${this.getActionName(action)}${htmlEscape(display)}...`,
        0
      );

      let success = false;
      let resultText = "";

      switch (action) {
        case 'kick':
          success = await BanManager.kickUser(client, chatIdOf(message), uid, participant);
          resultText = `✅ 已踢出 ${htmlEscape(display)}`;
          break;
        case 'ban':
          // 先删除消息，再封禁
          const deleteSuccess = await BanManager.deleteHistoryInCurrentChat(client, chatIdOf(message), uid, participant);
          success = await BanManager.banUser(client, chatIdOf(message), uid, 0, participant);
          const deleteText = deleteSuccess ? '(已清理消息)' : '';
          resultText = chatType === 'chat'
            ? `✅ 已移出 ${htmlEscape(display)} ${deleteText}`
            : `✅ 已封禁 ${htmlEscape(display)} ${deleteText}`;
          break;
        case 'unban':
          success = await BanManager.unbanUser(client, chatIdOf(message), uid, participant);
          resultText = chatType === 'chat'
            ? `✅ 已处理 ${htmlEscape(display)}`
            : `✅ 已解封 ${htmlEscape(display)}`;
          break;
        case 'mute':
          const duration = parseTimeString(args[1]);
          success = await BanManager.muteUser(client, chatIdOf(message), uid, duration, participant);
          const durationText = duration === 0 ? '永久' : this.formatDuration(duration);
          resultText = chatType === 'chat'
            ? `✅ 已处理 ${htmlEscape(display)} ${durationText}`
            : `✅ 已禁言 ${htmlEscape(display)} ${durationText}`;
          break;
        case 'unmute':
          success = await BanManager.unbanUser(client, chatIdOf(message), uid, participant);
          resultText = chatType === 'chat'
            ? `✅ 已处理 ${htmlEscape(display)}`
            : `✅ 已解禁言 ${htmlEscape(display)}`;
          break;
      }

      if (success) {
        await MessageManager.smartEdit(status, resultText);
      } else {
        await MessageManager.smartEdit(status, `❌ ${this.getActionName(action)}失败`);
      }
    } catch (error: unknown) {
      await MessageManager.smartEdit(message, `❌ 操作失败：${htmlEscape(getErrorMessage(error))}`);
    }
  }

  private static getActionName(action: string): string {
    const names: Record<string, string> = {
      kick: '踢出', ban: '封禁', unban: '解封',
      mute: '禁言', unmute: '解除禁言'
    };
    return names[action] || action;
  }

  private static formatDuration(seconds: number): string {
    if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
    return `${seconds}s`;
  }

  // sb命令：即时返回+后台处理
  static async handleSuperBan(
    client: TelegramClient,
    message: any
  ): Promise<void> {
    try {
      const rawText = String(message.text ?? message.rawText ?? "").trim();
      const args = rawText ? rawText.split(/\s+/).slice(1) : [];
      const { user, uid, participant, resolutionError, source } = await UserResolver.resolveTarget(client, message, args);

      if (!uid) {
        logger.warn(`[aban/sb] 获取用户失败 uid=null source=${source} err=${resolutionError} args=${JSON.stringify(args)}`);
        await MessageManager.smartEdit(
          message,
          resolutionError === "INVALID_TARGET"
            ? "❌ 无法识别目标（不要用 true 当用户名；请回复目标消息，或使用 @用户名 / 用户ID）"
            : "❌ 获取用户失败（请回复目标用户的消息，或附带 @用户名 / 用户ID）",
        );
        return;
      }

      if (!participant) {
        logger.warn(`[aban/sb] 实体不可解析 uid=${uid} source=${source} err=${resolutionError}`);
        const errorText = resolutionError === 'TARGET_ENTITY_UNRESOLVABLE'
          ? '❌ 无法解析该目标的 Telegram 实体，请先通过回复消息、@用户名或让该目标在当前会话中可见后再试'
          : '❌ 获取用户失败';
        await MessageManager.smartEdit(message, errorText);
        return;
      }

      const groups = await GroupManager.getManagedGroups(client);
      const hasBasicGroups = groups.some((group) => group.kind === 'chat');
      
      if (groups.length === 0) {
        await MessageManager.smartEdit(message, "❌ 无管理群组");
        return;
      }

      // 权限检查：并发检查目标是否为管理员（使用 p-limit 控制并发避免 flood）
      const checkLimit = (await ensurePLimit())(4);
      const adminResults = await Promise.allSettled(
        groups.map((group) =>
          checkLimit(async () => {
            try {
              const target = await resolvePermissionTarget(client, group);
              return await PermissionManager.isTargetAdmin(client, target, uid);
            } catch (_e: unknown) {
              return false;
            }
          })
        )
      );
      const adminGroups = adminResults.filter(
        (r) => r.status === 'fulfilled' && r.value
      ).length;

      if (adminGroups > 0) {
        const hasConfirm = args.includes('true');
        if (!hasConfirm) {
          await MessageManager.smartEdit(message, `⚠️ 目标在 ${adminGroups} 个管理群中具有管理员身份，请在命令后加上 <code>true</code> 确认执行`);
          return;
        }
      }

      const display = UserResolver.formatUser(user, uid);

      // 立即返回处理中状态
      const statusActionText = (message as { isGroup?: boolean; isChannel?: boolean }).isGroup && !(message as { isChannel?: boolean }).isChannel ? '移出' : '封禁';
      const status = await MessageManager.smartEdit(
        message,
        `⚡ 在${groups.length}个频道/群组中${statusActionText}该用户...`,
        0
      );

      // 后台处理：不等待结果，立即启动
      const backgroundProcess = async () => {
        const startTime = Date.now();
        
        // 并发执行删除和封禁
        const [deletedInCurrent, banResult] = await Promise.allSettled([
          BanManager.deleteHistoryInCurrentChat(client, chatIdOf(message), uid, participant),
          BanManager.batchBanUser(client, groups, uid, participant, args.slice(1).join(" ") || "违规")
        ]);

        const elapsed = (Date.now() - startTime) / 1000;
        
        // 处理结果
        const deleteSuccess = deletedInCurrent.status === 'fulfilled' && deletedInCurrent.value;
        const {
          success = 0,
          failed = groups.length,
          failureDetails = [],
          unresolved = false,
          unresolvedReason,
        } = banResult.status === 'fulfilled'
          ? banResult.value
          : { failureDetails: [], unresolved: true, unresolvedReason: 'UNKNOWN_ERROR' };

        // 内部日志辅助：不含 HTML 转义的纯文本原因汇总
        const summarizeReasonsPlain = (details: BatchGroupFailure[]): string => {
          const counts = new Map<string, number>();
          for (const item of details) {
            counts.set(item.reason, (counts.get(item.reason) || 0) + 1);
          }
          return Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([reason, count]) => `${reason}×${count}`)
            .join(', ');
        };

        if (failureDetails.length > 0) {
          logger.warn(`[sb] 封禁失败汇总: failed=${failureDetails.length}, unresolved=${unresolved ? 'yes' : 'no'}, reasons=[${summarizeReasonsPlain(failureDetails)}]`);
        }

        const summarizeReasons = (details: BatchGroupFailure[]): string => {
          const counts = new Map<string, number>();
          for (const item of details) {
            counts.set(item.reason, (counts.get(item.reason) || 0) + 1);
          }
          return Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([reason, count]) => `${htmlEscape(reason)}×${count}`)
            .join('、');
        };

        const failureSummary = unresolved
          ? `\n⚠️ 目标实体无法解析：${htmlEscape(unresolvedReason || 'UNKNOWN_ERROR')}`
          : failed > 0
            ? `\n⚠️ 失败 ${failed} 个频道/群组（${summarizeReasons(failureDetails)}）`
            : '';
        const capabilityNote = hasBasicGroups
          ? `\nℹ️ 基础群仅支持移出现有成员，不支持对未入群目标提前封禁`
          : '';

        // 更新最终结果
        const finalActionText = (message as { isGroup?: boolean; isChannel?: boolean }).isGroup && !(message as { isChannel?: boolean }).isChannel ? '移出' : '封禁';
        const result = `✅ 在${success}个频道/群组中${finalActionText}该用户 ${htmlEscape(display)}${failureSummary}${capabilityNote}\n🗑️当前群组消息: ${deleteSuccess ? '✓已清理' : '✗'} | ⏱️${elapsed.toFixed(1)}s`;
        
        // 更新为最终结果
        const lc1 = getCurrentGenerationContext();
        if (lc1) {
          lc1.setTimeout(() => {
            MessageManager.smartEdit(status, result, 30).catch(() => { /* smartEdit may fail if msg was deleted */ });
          }, 100, { label: 'aban:sb-result-update' });
        }
      };

      // 后台执行，不等待
      backgroundProcess().catch(() => { /* background process error logged internally */ });

    } catch (error: unknown) {
      await MessageManager.smartEdit(message, `❌ ${getErrorMessage(error)}`);
    }
  }

  // unsb命令：即时返回+后台处理
  static async handleSuperUnban(
    client: TelegramClient,
    message: any
  ): Promise<void> {
    try {
      const rawText = String(message.text ?? message.rawText ?? "").trim();
      const args = rawText ? rawText.split(/\s+/).slice(1) : [];
      const { user, uid, participant, resolutionError } = await UserResolver.resolveTarget(client, message, args);

      if (!uid) {
        logger.warn(`[aban] 获取用户失败 uid=null args=${JSON.stringify(args)} err=${resolutionError}`);
        await MessageManager.smartEdit(
          message,
          "❌ 获取用户失败（请回复目标用户的消息，或附带 @用户名 / 用户ID；true 仅作确认参数）",
        );
        return;
      }

      if (!participant) {
        const errorText = resolutionError === 'TARGET_ENTITY_UNRESOLVABLE'
          ? '❌ 无法解析该目标的 Telegram 实体，请先通过回复消息、@用户名或让该目标在当前会话中可见后再试'
          : '❌ 获取用户失败';
        await MessageManager.smartEdit(message, errorText);
        return;
      }

      const groups = await GroupManager.getManagedGroups(client);
      const hasBasicGroups = groups.some((group) => group.kind === 'chat');
      
      if (groups.length === 0) {
        await MessageManager.smartEdit(message, "❌ 无管理群组");
        return;
      }

      // 权限检查：并发检查目标是否为管理员（使用 p-limit 控制并发避免 flood）
      const checkLimitUnban = (await ensurePLimit())(4);
      const adminResultsUnban = await Promise.allSettled(
        groups.map((group) =>
          checkLimitUnban(async () => {
            try {
              const target = await resolvePermissionTarget(client, group);
              return await PermissionManager.isTargetAdmin(client, target, uid);
            } catch (_e: unknown) {
              return false;
            }
          })
        )
      );
      const adminGroups = adminResultsUnban.filter(
        (r) => r.status === 'fulfilled' && r.value
      ).length;

      if (adminGroups > 0) {
        const hasConfirm = args.includes('true');
        if (!hasConfirm) {
          await MessageManager.smartEdit(message, `⚠️ 目标在 ${adminGroups} 个管理群中具有管理员身份，请在命令后加上 <code>true</code> 确认执行`);
          return;
        }
      }

      const display = UserResolver.formatUser(user, uid);
      
      // 立即返回处理中状态
      const status = await MessageManager.smartEdit(
        message,
        `🔓 在${groups.length}个频道/群组中解封该用户...`,
        0
      );

      // 后台处理
      const backgroundProcess = async () => {
        const startTime = Date.now();
        const {
          success = 0,
          failed = groups.length,
          unresolved = false,
          unresolvedReason,
        } = await BanManager.batchUnbanUser(client, groups, uid, participant).catch(() => ({
          success: 0,
          failed: groups.length,
          unresolved: true,
          unresolvedReason: 'UNKNOWN_ERROR',
        }));
        
        const elapsed = (Date.now() - startTime) / 1000;

        // 内部日志：记录失败原因
        if (!unresolved && failed > 0) {
          logger.warn(`[unsb] 解封失败: failed=${failed}/${groups.length}`);
        }

        const failureSummary = unresolved
          ? ` | ⚠️ 目标实体无法解析：${htmlEscape(unresolvedReason || 'UNKNOWN_ERROR')}`
          : failed > 0
            ? ` | ⚠️ ${failed} 个频道/群组解封失败`
            : '';
        const capabilityNote = hasBasicGroups
          ? ` | ℹ️ 基础群不支持跨群解封语义，仅会跳过`
          : '';
        const result = `✅ 在${success}个频道/群组中解封该用户 ${htmlEscape(display)}${failureSummary}${capabilityNote} | ⏱️${elapsed.toFixed(1)}s`;
        
        const lc2 = getCurrentGenerationContext();
        if (lc2) {
          lc2.setTimeout(() => {
            MessageManager.smartEdit(status, result, 30).catch(() => { /* smartEdit may fail if msg was deleted */ });
          }, 100, { label: 'aban:unsb-result-update' });
        }
      };

      backgroundProcess().catch(() => { /* background process error logged internally */ });
    } catch (error: unknown) {
      await MessageManager.smartEdit(message, `❌ ${getErrorMessage(error)}`);
    }
  }
}

// ==================== 插件主类 ====================
class AbanPlugin extends Plugin {
  description: string = HELP_TEXT;

  cleanup(): void {
    // Lifecycle-aware timers are now managed by GenerationContext
    // and cleaned up automatically on reload. No manual cleanup needed.
  }

  cmdHandlers: Record<string, (msg: MtcuteMessageContext) => Promise<void>> = {
    // 帮助命令
    aban: async (msg) => {
      await MessageManager.smartEdit(msg, HELP_TEXT);
    },

    // 基础管理命令
    kick: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleBasicCommand(client, msg, 'kick');
    },

    ban: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleBasicCommand(client, msg, 'ban');
    },

    unban: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleBasicCommand(client, msg, 'unban');
    },

    mute: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleBasicCommand(client, msg, 'mute');
    },

    unmute: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleBasicCommand(client, msg, 'unmute');
    },

    // 批量管理命令
    sb: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleSuperBan(client, msg);
    },

    unsb: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleSuperUnban(client, msg);
    },

    // 系统命令
    refresh: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }

      const status = await MessageManager.smartEdit(msg, "🔄 刷新中...", 0);
      
      try {
        await GroupManager.clearCache();
        const groups = await GroupManager.getManagedGroups(client);
        await MessageManager.smartEdit(status, `✅ 已刷新 ${groups.length}个群组`);
      } catch (_e: unknown) {
        await MessageManager.smartEdit(status, `❌ 刷新失败`);
      }
    }
  };
}

// 导出插件实例
export default new AbanPlugin();
