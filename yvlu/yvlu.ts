/**
 * YVLU quote sticker generator for TeleBox-Next.
 * Keeps the Classic plugin's custom quote API and sticker-set configuration.
 */

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type { MessageContext } from '@mtcute/dispatcher'
import { thtml as html, type Message, type MessageEntity, type Peer, type PeerSender, type TelegramClient } from '@mtcute/node'
import { getErrorMessage } from '@utils/errorHelpers'
import { htmlEscape } from '@utils/htmlEscape'
import { createDirectoryInAssets } from '@utils/pathHelpers'
import { Plugin, type PluginRuntimeContext } from '@utils/pluginBase'
import { getPrefixes } from '@utils/pluginManager'
import { getGlobalClient } from '@utils/runtimeManager'
import { safeGetMessages, safeGetReplyMessage } from '@utils/safeGetMessages'
import axios from 'axios'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_API_URL = 'https://quote-api-enhanced.zhetengsha.eu.org/generate.webp'
const activeTempFiles = new Set<string>()

interface YvluConfig {
  stickerSetShortName: string
  apiUrl: string
  _comment?: string
}

interface QuoteEntity {
  offset: number
  length: number
  type: string
  language?: string
  url?: string
  custom_emoji_id?: string
  user?: { id: number }
}

interface QuotePhoto {
  url: string
}

interface QuoteReply {
  name: string
  text: string
  entities: QuoteEntity[]
}

interface QuoteFrom {
  id: number
  name: string
  first_name?: string
  last_name?: string
  username?: string
  photo?: QuotePhoto
  emoji_status?: string
}

interface QuoteMessage {
  from: QuoteFrom
  text: string
  entities: QuoteEntity[]
  avatar: boolean
  media?: QuotePhoto
  replyMessage?: QuoteReply
}

interface QuotePayload {
  type: 'quote'
  format: 'webp'
  backgroundColor: string
  width: number
  height: number
  scale: number
  emojiBrand: 'apple'
  messages: QuoteMessage[]
}

interface SenderDetails {
  id: number
  identifier: string
  name: string
  firstName?: string
  lastName?: string
  username?: string
  emojiStatus?: string
  peer?: Peer
}

const hashCode = (value: string): number => {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index)
    hash |= 0
  }
  return hash
}

const isWebmFormat = (buffer: Buffer): boolean => buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3

const isTgsFormat = (buffer: Buffer): boolean => buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b

const trackTempFile = (filePath: string): string => {
  activeTempFiles.add(filePath)
  return filePath
}

const removeTempFile = (filePath: string): void => {
  activeTempFiles.delete(filePath)
  try {
    fs.rmSync(filePath, { force: true })
  } catch {
    // Best-effort cleanup; the operating system will eventually clear /tmp.
  }
}

async function checkTgsDependencies(): Promise<{
  ok: boolean
  message: string
}> {
  try {
    await execFileAsync('python3', ['-c', 'from rlottie_python import LottieAnimation'])
  } catch {
    return {
      ok: false,
      message: '缺少 rlottie-python 依赖，请运行: pip3 install rlottie-python Pillow --break-system-packages'
    }
  }

  try {
    await execFileAsync('ffmpeg', ['-version'])
  } catch {
    return {
      ok: false,
      message: '缺少 ffmpeg，请安装: apt-get install -y ffmpeg'
    }
  }

  return { ok: true, message: '' }
}

async function convertTgsToWebm(tgsBuffer: Buffer): Promise<Buffer> {
  const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2)}`
  const tgsPath = trackTempFile(path.join(os.tmpdir(), `yvlu-${uniqueId}.tgs`))
  const gifPath = trackTempFile(path.join(os.tmpdir(), `yvlu-${uniqueId}.gif`))
  const webmPath = trackTempFile(path.join(os.tmpdir(), `yvlu-${uniqueId}.webm`))

  try {
    fs.writeFileSync(tgsPath, tgsBuffer)
    const pythonScript = ['import sys', 'from rlottie_python import LottieAnimation', 'animation = LottieAnimation.from_tgs(sys.argv[1])', 'animation.save_animation(sys.argv[2])'].join('\n')

    await execFileAsync('python3', ['-c', pythonScript, tgsPath, gifPath])
    await execFileAsync('ffmpeg', ['-i', gifPath, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '400k', '-auto-alt-ref', '0', '-an', '-y', webmPath])

    return fs.readFileSync(webmPath)
  } finally {
    removeTempFile(tgsPath)
    removeTempFile(gifPath)
    removeTempFile(webmPath)
  }
}

function convertEntities(entities: ReadonlyArray<MessageEntity>): QuoteEntity[] {
  return entities
    .map((entity): QuoteEntity | null => {
      const base = { offset: entity.offset, length: entity.length }
      const params = entity.params

      switch (params.kind) {
        case 'bold':
        case 'italic':
        case 'underline':
        case 'strikethrough':
        case 'code':
        case 'url':
        case 'mention':
        case 'hashtag':
        case 'cashtag':
        case 'bot_command':
        case 'email':
        case 'phone_number':
        case 'spoiler':
        case 'blockquote':
          return { ...base, type: params.kind }
        case 'pre':
          return { ...base, type: 'pre', language: params.language }
        case 'text_link':
          return { ...base, type: 'text_link', url: params.url }
        case 'text_mention':
          return {
            ...base,
            type: 'text_mention',
            user: { id: params.userId }
          }
        case 'emoji':
          return {
            ...base,
            type: 'custom_emoji',
            custom_emoji_id: params.emojiId.toString()
          }
        default:
          return null
      }
    })
    .filter((entity): entity is QuoteEntity => entity !== null)
}

function getSenderDetails(sender: PeerSender, fallbackIndex: number): SenderDetails {
  if (sender.type === 'anonymous') {
    const id = hashCode(sender.displayName || `anonymous_${fallbackIndex}`)
    return {
      id,
      identifier: `anonymous:${id}`,
      name: sender.displayName,
      firstName: sender.displayName
    }
  }

  const firstName = sender.type === 'user' ? sender.firstName : sender.title
  const lastName = sender.type === 'user' ? (sender.lastName ?? undefined) : undefined
  const username = sender.username ?? undefined

  return {
    id: sender.id,
    identifier: `${sender.type}:${sender.id}`,
    name: sender.displayName,
    firstName,
    lastName,
    username,
    emojiStatus: sender.emojiStatus?.emoji.toString(),
    peer: sender
  }
}

function getEffectiveSender(message: Message): PeerSender {
  if (message.forward) {
    try {
      return message.forward.sender
    } catch {
      const fallbackName = message.forward.raw.fromName || message.forward.raw.postAuthor || '未知来源'
      return { type: 'anonymous', displayName: fallbackName }
    }
  }

  return message.sender
}

async function getProfilePhoto(client: TelegramClient, sender?: Peer): Promise<QuotePhoto | undefined> {
  const location = sender?.photo?.small
  if (!location) return undefined

  try {
    const data = Buffer.from(await client.downloadAsBuffer(location))
    if (data.length === 0) return undefined
    return { url: `data:image/jpeg;base64,${data.toString('base64')}` }
  } catch {
    return undefined
  }
}

async function downloadQuoteMedia(client: TelegramClient, message: Message): Promise<QuotePhoto | undefined> {
  const media = message.media
  if (!media) return undefined

  try {
    let buffer: Buffer
    switch (media.type) {
      case 'photo':
      case 'sticker':
      case 'document':
      case 'video':
      case 'audio':
      case 'voice':
        buffer = Buffer.from(await client.downloadAsBuffer(media))
        break
      default:
        return undefined
    }

    let mime = 'image/jpeg'
    if (media.type === 'sticker') {
      mime = media.mimeType || 'image/webp'
      if (media.sourceType === 'animated' || isTgsFormat(buffer)) {
        const dependency = await checkTgsDependencies()
        if (dependency.ok) {
          try {
            buffer = await convertTgsToWebm(buffer)
            mime = 'video/webm'
          } catch (error: unknown) {
            console.error('[yvlu] TGS conversion failed:', error)
          }
        } else {
          console.warn(`[yvlu] ${dependency.message}`)
        }
      }
    } else if ('mimeType' in media && media.mimeType) {
      mime = media.mimeType
    }

    return { url: `data:${mime};base64,${buffer.toString('base64')}` }
  } catch (error: unknown) {
    console.error('[yvlu] Failed to download quote media:', error)
    return undefined
  }
}

async function getReplyBlock(message: Message): Promise<QuoteReply | undefined> {
  const replyInfo = message.replyToMessage
  if (!replyInfo) return undefined

  if (replyInfo.quoteText) {
    return {
      name: replyInfo.sender?.displayName ?? 'Reply',
      text: replyInfo.quoteText,
      entities: convertEntities(replyInfo.quoteEntities)
    }
  }

  const replied = await safeGetReplyMessage(message)
  if (!replied) return undefined

  return {
    name: replied.sender.displayName,
    text: replied.text,
    entities: convertEntities(replied.entities)
  }
}

function getHelpText(): string {
  const command = `${getPrefixes()[0] || '.'}yvlu`
  return `
<b>🎨 YVLU 语录生成器</b>

<b>1. 生成语录</b>
• <code>${command} [数量]</code> - 回复消息，生成最近 N 条
• <code>${command} r [数量]</code> - 包含被引用的消息
• <code>${command} &lt;自定义文字&gt;</code> - 替换首条内容后生成

<b>2. 贴纸包管理</b>
• <code>${command} s</code> - 回复图片或贴纸，保存到贴纸包
• <code>${command} config sticker &lt;名称&gt;</code> - 设置贴纸包 ShortName

<b>3. API 设置</b>
• <code>${command} api [URL]</code> - 设置自定义 API
• <code>${command} api reset</code> - 重置 API
`
}

function isYvluConfig(value: unknown): value is YvluConfig {
  if (!value || typeof value !== 'object') return false
  return 'stickerSetShortName' in value && typeof value.stickerSetShortName === 'string' && 'apiUrl' in value && typeof value.apiUrl === 'string'
}

class YvluPlugin extends Plugin {
  description = (): string => `\n生成文字语录贴纸\n\n${getHelpText()}`
  private config: YvluConfig | null = null
  private configPath = ''
  private abortSignal?: AbortSignal

  setup(context: PluginRuntimeContext): void {
    this.abortSignal = context.signal
    this.ensureConfig()
  }

  cleanup(): void {
    for (const filePath of [...activeTempFiles]) removeTempFile(filePath)
    this.abortSignal = undefined
    this.config = null
    this.configPath = ''
  }

  private ensureConfig(): YvluConfig {
    if (!this.configPath) {
      this.configPath = path.join(createDirectoryInAssets('yvlu'), 'config.json')
    }

    if (!fs.existsSync(this.configPath)) {
      const initial: YvluConfig = {
        stickerSetShortName: '',
        apiUrl: '',
        _comment: 'shortName 只能包含字母、数字和下划线; apiUrl 为空时使用默认'
      }
      fs.writeFileSync(this.configPath, JSON.stringify(initial, null, 2), 'utf8')
    }

    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
      this.config = isYvluConfig(parsed) ? parsed : { stickerSetShortName: '', apiUrl: '' }
    } catch (error: unknown) {
      console.error('[yvlu] Failed to load config:', error)
      this.config = { stickerSetShortName: '', apiUrl: '' }
    }

    return this.config
  }

  private saveConfig(): void {
    const config = this.ensureConfig()
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8')
  }

  private async generateQuote(quoteData: QuotePayload): Promise<{ buffer: Buffer; extension: 'webp' | 'webm' | 'png' }> {
    const config = this.ensureConfig()
    const url = config.apiUrl.trim() || DEFAULT_API_URL
    const response = await axios.request<ArrayBuffer>({
      method: 'post',
      timeout: REQUEST_TIMEOUT_MS,
      url,
      data: quoteData,
      responseType: 'arraybuffer',
      signal: this.abortSignal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'TeleBox/0.2.9'
      }
    })

    const buffer = Buffer.from(response.data)
    if (isWebmFormat(buffer)) return { buffer, extension: 'webm' }
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { buffer, extension: 'png' }
    }
    return { buffer, extension: 'webp' }
  }

  private async getQuoteMessages(client: TelegramClient, replied: Message, count: number): Promise<Message[]> {
    if (count === 1) return [replied]

    const messages = await safeGetMessages(client, replied.chat.id, {
      offsetId: replied.id - 1,
      limit: count,
      reverse: true
    })

    if (!messages.some((message) => message.id === replied.id)) {
      messages.unshift(replied)
    }

    return messages.slice(0, count)
  }

  private async buildQuoteMessages(client: TelegramClient, messages: Message[], customText: string | undefined, includeReplies: boolean, selectedQuote: MessageContext['replyToMessage']): Promise<QuoteMessage[]> {
    const items: QuoteMessage[] = []
    let previousIdentifier: string | null = null

    for (const [index, message] of messages.entries()) {
      const sender = getSenderDetails(getEffectiveSender(message), index)
      const showAvatar = sender.identifier !== previousIdentifier
      previousIdentifier = sender.identifier

      const photo = showAvatar ? await getProfilePhoto(client, sender.peer) : undefined
      let text = message.text
      let entities = convertEntities(message.entities)

      if (index === 0) {
        if (customText) {
          text = customText
          entities = []
        } else if (selectedQuote?.quoteText) {
          text = selectedQuote.quoteText
          entities = convertEntities(selectedQuote.quoteEntities)
        }
      }

      const replyMessage = includeReplies ? await getReplyBlock(message) : undefined

      items.push({
        from: {
          id: sender.id || hashCode(sender.name || `user_${index}`),
          name: showAvatar ? sender.name : '',
          first_name: showAvatar ? sender.firstName : undefined,
          last_name: showAvatar ? sender.lastName : undefined,
          username: showAvatar && photo ? sender.username : undefined,
          photo,
          emoji_status: showAvatar ? sender.emojiStatus : undefined
        },
        text,
        entities,
        avatar: showAvatar,
        media: await downloadQuoteMedia(client, message),
        replyMessage
      })
    }

    return items
  }

  private async sendQuoteResult(client: TelegramClient, msg: MessageContext, replied: Message, result: { buffer: Buffer; extension: 'webp' | 'webm' | 'png' }): Promise<void> {
    if (result.extension === 'webm') {
      const uploaded = await client.uploadFile({
        file: result.buffer,
        fileName: 'yvlu.webm',
        fileMime: 'video/webm'
      })
      await client.sendMedia(
        msg.chat.id,
        {
          _: 'inputMediaUploadedDocument',
          file: uploaded.inputFile,
          mimeType: 'video/webm',
          nosoundVideo: true,
          attributes: [
            {
              _: 'documentAttributeSticker',
              alt: '📝',
              stickerset: { _: 'inputStickerSetEmpty' }
            },
            {
              _: 'documentAttributeVideo',
              duration: 0,
              w: 512,
              h: 512,
              supportsStreaming: true
            },
            { _: 'documentAttributeFilename', fileName: 'yvlu.webm' }
          ]
        },
        { replyTo: replied.id }
      )
      return
    }

    if (result.extension === 'png') {
      await client.sendMedia(msg.chat.id, { type: 'photo', file: result.buffer, fileName: 'yvlu.png' }, { replyTo: replied.id })
      return
    }

    await client.sendMedia(
      msg.chat.id,
      {
        type: 'sticker',
        file: result.buffer,
        fileName: 'yvlu.webp',
        fileMime: 'image/webp',
        alt: '📝'
      },
      { replyTo: replied.id }
    )
  }

  private async handleQuote(msg: MessageContext, trigger?: MessageContext): Promise<void> {
    const startedAt = Date.now()
    const args = (msg.text ?? '').trim().split(/\s+/)
    let count = 1
    let includeReplies = false
    let customText: string | undefined

    if (!args[1] || /^\d+$/.test(args[1])) {
      count = Number.parseInt(args[1] ?? '1', 10) || 1
    } else if (args[1].toLowerCase() === 'r') {
      includeReplies = true
      count = Number.parseInt(args[2] ?? '1', 10) || 1
    } else {
      customText = (msg.text ?? '').replace(/^\S+\s+/, '')
    }

    const replied = await safeGetReplyMessage(msg)
    if (!replied) {
      await msg.edit({ text: '请回复一条消息' })
      return
    }
    if (count > 5) {
      await msg.edit({ text: '太多了 哒咩' })
      return
    }

    await msg.edit({ text: '正在生成语录贴纸...' })

    try {
      const client = await getGlobalClient()
      const messages = await this.getQuoteMessages(client, replied, count)
      if (messages.length === 0) {
        await msg.edit({ text: '未找到消息' })
        return
      }

      const quoteData: QuotePayload = {
        type: 'quote',
        format: 'webp',
        backgroundColor: '#1b1429',
        width: 512,
        height: 768,
        scale: 2,
        emojiBrand: 'apple',
        messages: await this.buildQuoteMessages(client, messages, customText, includeReplies, (trigger ?? msg).replyToMessage)
      }
      const result = await this.generateQuote(quoteData)
      if (result.buffer.length === 0) {
        await msg.edit({ text: '生成的图片数据为空' })
        return
      }

      await this.sendQuoteResult(client, msg, replied, result)
      await msg.delete()
      console.info(`[yvlu] Quote generated in ${Date.now() - startedAt}ms`)
    } catch (error: unknown) {
      console.error('[yvlu] Quote generation failed:', error)
      await msg.edit({
        text: html(`语录生成失败: ${htmlEscape(getErrorMessage(error))}`)
      })
    }
  }

  private async handleConfigCommand(msg: MessageContext, args: string[]): Promise<void> {
    const config = this.ensureConfig()
    const subcommand = args[0]?.toLowerCase()

    if (subcommand === 'sticker' || subcommand === 'set') {
      const newName = args.slice(1).join('_')
      if (!newName || !/^[a-zA-Z0-9_]+$/.test(newName)) {
        await msg.edit({ text: '❌ 名称非法 (仅限字母数字下划线)' })
        return
      }
      config.stickerSetShortName = newName
      this.saveConfig()
      await msg.edit({
        text: html(`✅ 贴纸包已设为: <code>${htmlEscape(newName)}</code>`)
      })
      return
    }

    const command = `${getPrefixes()[0] || '.'}yvlu`
    await msg.edit({
      text: html(`<b>当前配置:</b>\n贴纸包: ${htmlEscape(config.stickerSetShortName || '未设置')}\nAPI: ${htmlEscape(config.apiUrl || '默认')}\n\n使用 <code>${command} config sticker [name]</code> 修改`)
    })
  }

  private async handleApiCommand(msg: MessageContext, args: string[]): Promise<void> {
    const config = this.ensureConfig()
    const value = args[0]

    if (!value) {
      await msg.edit({
        text: html(`当前 API: <code>${htmlEscape(config.apiUrl || '默认')}</code>`)
      })
      return
    }

    if (value.toLowerCase() === 'reset') {
      config.apiUrl = ''
      this.saveConfig()
      await msg.edit({ text: '✅ API 已重置为默认' })
      return
    }

    let url = value
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`
    if (!url.includes('/generate')) {
      url = `${url.replace(/\/$/, '')}/generate.webp`
    }
    try {
      new URL(url)
    } catch {
      await msg.edit({ text: '❌ API URL 无效' })
      return
    }

    config.apiUrl = url
    this.saveConfig()
    await msg.edit({
      text: html(`✅ API 已设为: <code>${htmlEscape(url)}</code>`)
    })
  }

  private async prepareStickerFile(client: TelegramClient, replied: Message): Promise<Buffer | string> {
    const media = replied.media
    if (!media) throw new Error('请回复一张贴纸或图片')

    if (media.type === 'sticker') return media.fileId
    if (media.type !== 'photo') throw new Error('不支持的媒体类型')

    const source = Buffer.from(await client.downloadAsBuffer(media))
    if (source.length === 0) throw new Error('下载图片失败')
    return sharp(source)
      .resize(512, 512, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .webp()
      .toBuffer()
  }

  private async handleSaveStickerToSet(msg: MessageContext): Promise<void> {
    const config = this.ensureConfig()
    const command = `${getPrefixes()[0] || '.'}yvlu`
    if (!config.stickerSetShortName) {
      await msg.edit({
        text: `❌ 未配置贴纸包!\n请先设置: ${command} config sticker <名称>`
      })
      return
    }

    const replied = await safeGetReplyMessage(msg)
    if (!replied?.media) {
      await msg.edit({ text: '❌ 请回复一张贴纸或图片' })
      return
    }

    try {
      const client = await getGlobalClient()
      const sticker = await this.prepareStickerFile(client, replied)
      let exists = true

      try {
        await client.getStickerSet(config.stickerSetShortName)
      } catch (error: unknown) {
        if (getErrorMessage(error).includes('STICKERSET_INVALID')) {
          exists = false
        } else {
          throw error
        }
      }

      if (exists) {
        await client.addStickerToSet(config.stickerSetShortName, {
          file: sticker,
          emojis: '📝'
        })
      } else {
        await client.createStickerSet({
          owner: 'self',
          title: config.stickerSetShortName,
          shortName: config.stickerSetShortName,
          type: 'sticker',
          stickers: [{ file: sticker, emojis: '📝' }]
        })
      }

      await msg.edit({
        text: html(`✅ 已${exists ? '保存到' : '创建并保存到'}贴纸包!\nt.me/addstickers/${htmlEscape(config.stickerSetShortName)}`)
      })
    } catch (error: unknown) {
      console.error('[yvlu] Failed to save sticker:', error)
      await msg.edit({
        text: html(`❌ 保存失败: ${htmlEscape(getErrorMessage(error))}`)
      })
    }
  }

  cmdHandlers: Record<string, (msg: MessageContext, trigger?: MessageContext) => Promise<void>> = {
    yvlu: async (msg, trigger) => {
      this.ensureConfig()
      const args = (msg.text ?? '').trim().split(/\s+/)
      const subcommand = args[1]?.toLowerCase()

      if (subcommand === 'config') {
        await this.handleConfigCommand(msg, args.slice(2))
      } else if (subcommand === 'api') {
        await this.handleApiCommand(msg, args.slice(2))
      } else if (subcommand === 's') {
        await this.handleSaveStickerToSet(msg)
      } else {
        await this.handleQuote(msg, trigger)
      }
    }
  }
}

export default new YvluPlugin()
