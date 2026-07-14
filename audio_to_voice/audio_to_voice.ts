import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import type { MessageContext } from "@mtcute/dispatcher";
import type { Audio, Document, InputMediaVoice, Message } from "@mtcute/core";
import type { MtcuteFileLocation } from "@utils/mtcuteTypes";
import fs from "fs";
import path from "path";
import { createDirectoryInTemp } from "@utils/pathHelpers";
import { execFile } from "child_process";
import { promisify } from "util";
import { safeGetMessages } from "@utils/safeGetMessages";
import { logger } from "@utils/logger";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const execFileAsync = promisify(execFile);

/** Message / MessageContext 都带 media，用于 hasAudio / getAudioDuration */
type AudioSource = Message | MessageContext;

class AudioToVoicePlugin extends Plugin {

  description: string = `🎙️ <b>音频转语音</b>\n\n
<b>命令</b>\n
• <code>${mainPrefix}audio_to_voice</code>（回复一条包含音乐的消息）\n\n
<b>功能</b>\n
• 将音乐文件转换为 Telegram 语音消息（OGG/Opus）\n\n
<b>用法</b>\n
1) 回复音乐文件发送 <code>${mainPrefix}audio_to_voice</code>\n\n
<b>依赖</b>\n
• 需要系统安装 FFmpeg`;
  
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    "audio_to_voice": this.handleAudioToVoice.bind(this),
  };

  private hasAudio(msg: AudioSource): boolean {
    if (!msg.media) return false;

    // Check if media is an Audio document (not a voice note)
    const media = msg.media;
    if (media.type === 'audio') {
      return true;
    }
    // Also accept documents with audio mime type
    if (media.type === 'document') {
      const doc = media as Document;
      return doc.mimeType?.startsWith('audio/') ?? false;
    }
    return false;
  }

  private getAudioDuration(msg: AudioSource): number {
    const media = msg.media;
    if (!media) return 0;

    if (media.type === 'audio') {
      return (media as Audio).duration;
    }
    if (media.type === 'document') {
      // Document doesn't expose duration directly; return 0 as fallback
      return 0;
    }
    return 0;
  }

  /**
   * 解析待转换音频来源：优先回复消息中的音频，否则用命令消息自身的音频。
   * 与 teleproto 版 getAudio 对齐——回复场景必须下载被回复消息的 media，不能用命令消息。
   */
  private async getAudio(msg: MessageContext, client: NonNullable<Awaited<ReturnType<typeof getGlobalClient>>>): Promise<AudioSource | null> {
    const replyId = msg.replyToMessage?.id;
    if (replyId != null) {
      const replyMessages = await safeGetMessages(client, msg.chat.id, {
        ids: [replyId],
      });
      if (replyMessages.length > 0) {
        const replyMsg = replyMessages[0];
        if (this.hasAudio(replyMsg)) {
          return replyMsg;
        }
      }
    }

    return this.hasAudio(msg) ? msg : null;
  }

  private async handleAudioToVoice(msg: MessageContext): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化" });
      return;
    }

    try {
      const audioMsg = await this.getAudio(msg, client);
      if (!audioMsg) {
        await msg.edit({ text: "请回复一个音乐文件" });
        return;
      }

      // 是否来自回复（被回复消息与命令消息不是同一条）
      const isReplyAudio = audioMsg !== msg;

      await msg.edit({ text: "转换中。。。" });

      // 先检测 ffmpeg 是否可用
      try {
        await execFileAsync("ffmpeg", ["-version"]);
      } catch (_e: unknown) {
        await msg.edit({ text: "❌ 未检测到 ffmpeg，请先在系统安装 ffmpeg 后重试。macOS 可使用：brew install ffmpeg" });
        return;
      }

      const tempDir = createDirectoryInTemp("audio_to_voice");
      // 原始下载路径（无扩展名）
      const audioPath = path.join(tempDir, `audio_${Date.now()}`);
      const oggPath = path.join(tempDir, `voice_${Date.now()}.ogg`);

      try {
        // 下载音频文件（必须用 audioMsg，回复场景下是被回复消息的 media）
        const media = audioMsg.media!;
        // Audio/Document extend RawDocument which extends FileLocation, compatible with downloadAsBuffer
        const buffer = await client.downloadAsBuffer(media as MtcuteFileLocation);
        fs.writeFileSync(audioPath, buffer as Buffer);

        // 使用 FFmpeg 转码为 OGG/Opus（Telegram 语音格式）
        // 48k-64k 比特率，48k 采样率，单声道
        // 使用 execFile 参数数组（不启用 shell），杜绝路径中的命令注入风险。
        const args = [
          "-y",
          "-i", audioPath,
          "-vn",
          "-acodec", "libopus",
          "-b:a", "64k",
          "-ar", "48000",
          "-ac", "1",
          oggPath,
        ];
        try {
          await execFileAsync("ffmpeg", args, { timeout: 180000 });
        } catch (_e: unknown) {
          throw new Error(`FFmpeg 转码失败，请确认系统已安装 FFmpeg（macOS: brew install ffmpeg）。`);
        }

        if (!fs.existsSync(oggPath)) {
          throw new Error("转码后的语音文件未找到");
        }

        const duration = this.getAudioDuration(audioMsg);
        
        // 确定回复目标：回复场景回落到原音频消息
        const replyToId: number | undefined = isReplyAudio ? (msg.replyToMessage?.id ?? undefined) : undefined;
        
        // 发送语音笔记
        const voiceMedia: InputMediaVoice = {
          type: "voice",
          file: oggPath,
          duration: duration || undefined,
        };
        await client.sendMedia(msg.chat.id, voiceMedia, {
          replyTo: replyToId,
        });

        // 清理临时文件
        this.safeRemove(audioPath);
        this.safeRemove(oggPath);
        
        // 清理状态消息
        if (isReplyAudio) {
          // 如果是回复的音频，删除状态消息
          try {
            await msg.delete();
          } catch (deleteError: unknown) {
            logger.warn("删除状态消息失败:", deleteError);
          }
        } else {
          // 如果是消息本身的音频，清空消息内容
          try {
            await msg.edit({ text: "" });
          } catch (editError: unknown) {
            logger.warn("清空消息失败:", editError);
          }
        }
        
      } catch (error: unknown) {
        this.safeRemove(audioPath);
        this.safeRemove(oggPath);
        await msg.edit({ text: `转换为语音消息失败：${error}` });
      }
      
    } catch (error: unknown) {
      logger.error("AudioToVoice plugin error:", error);
      await msg.edit({ text: `转换为语音消息失败：${error}` });
    }
  }

  private safeRemove(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error: unknown) {
      logger.warn(`删除文件失败 ${filePath}:`, error);
    }
  }
}

export default new AudioToVoicePlugin();