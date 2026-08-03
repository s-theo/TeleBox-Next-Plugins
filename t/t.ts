import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { MessageContext } from '@mtcute/dispatcher'
import { createDirectoryInAssets } from '@utils/pathHelpers'
import { Plugin } from '@utils/pluginBase'
import { getPrefixes } from '@utils/pluginManager'
import { getGlobalClient } from '@utils/runtimeManager'

const execFileAsync = promisify(execFile)
const EDGE_TTS = '/root/.local/bin/edge-tts'
const DATA_FILE_NAME = 'tts_data.json'
const activeFiles = new Set<string>()
const mainPrefix = getPrefixes()[0] || '.'

interface UserConfig {
  defaultRole: string
  defaultRoleId: string
}

interface AllUserData {
  users: Record<string, UserConfig>
  roles: Record<string, string>
  covers?: Record<string, string>
}

interface GeneratedSpeech {
  oggFile: string
  mp3File: string
}

interface MusicMetadata {
  title: string
  artist: string
  album: string
  cover?: string
}

const getDataFilePath = (): string => path.join(createDirectoryInAssets('tts-plugin'), DATA_FILE_NAME)

const getCacheDir = (): string => createDirectoryInAssets('tts-plugin/cache')

const trackFile = (file: string): string => {
  activeFiles.add(file)
  return file
}

const removeFile = async (file: string): Promise<void> => {
  activeFiles.delete(file)
  await fs.rm(file, { force: true }).catch(() => {})
}

function getInitialRoles(): Record<string, string> {
  return {
    晓晓: 'zh-CN-XiaoxiaoNeural',
    云希: 'zh-CN-YunxiNeural',
    晓伊: 'zh-CN-XiaoyiNeural',
    云扬: 'zh-CN-YunyangNeural',
    台湾女: 'zh-TW-HsiaoChenNeural',
    英文男: 'en-US-GuyNeural',
    英文女: 'en-US-JennyNeural'
  }
}

async function loadUserData(): Promise<AllUserData> {
  try {
    const data = await fs.readFile(getDataFilePath(), 'utf8')
    const parsed = JSON.parse(data) as AllUserData

    if (!parsed.roles) parsed.roles = {}
    if (!parsed.covers) parsed.covers = {}

    const initial = getInitialRoles()
    let changed = false
    for (const [name, id] of Object.entries(initial)) {
      if (!(name in parsed.roles)) {
        parsed.roles[name] = id
        changed = true
      }
    }
    if (changed) await saveUserData(parsed)
    return parsed
  } catch {
    const initial: AllUserData = {
      users: {},
      roles: getInitialRoles(),
      covers: {}
    }
    await saveUserData(initial)
    return initial
  }
}

async function saveUserData(userData: AllUserData): Promise<void> {
  await fs.writeFile(getDataFilePath(), JSON.stringify(userData, null, 2), 'utf8')
}

function cleanTextForTTS(text: string): string {
  return text.replace(/["']/g, '').trim()
}

async function generateSpeechSimple(text: string, voice: string): Promise<GeneratedSpeech | null> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const mp3File = trackFile(path.join(getCacheDir(), `tts-${unique}.mp3`))
  const oggFile = trackFile(path.join(getCacheDir(), `tts-${unique}.ogg`))

  try {
    await execFileAsync(EDGE_TTS, ['--voice', voice, '--text', text, '--write-media', mp3File])
    await execFileAsync('ffmpeg', ['-y', '-i', mp3File, '-c:a', 'libopus', '-b:a', '64k', oggFile])
    return { oggFile, mp3File }
  } catch (error: unknown) {
    console.error('[t] TTS generation failed:', error)
    await Promise.all([removeFile(oggFile), removeFile(mp3File)])
    return null
  }
}

async function generateMusic(text: string, voice: string, meta: MusicMetadata): Promise<string | null> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const rawFile = trackFile(path.join(getCacheDir(), `tts-${unique}.mp3`))
  const finalFile = trackFile(path.join(getCacheDir(), `tts-${unique}-meta.mp3`))

  try {
    await execFileAsync(EDGE_TTS, ['--voice', voice, '--text', text, '--write-media', rawFile])

    const args = ['-y', '-i', rawFile]
    if (meta.cover) {
      args.push('-i', meta.cover, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-q:a', '2', '-c:v', 'mjpeg', '-id3v2_version', '3', '-disposition:v', 'attached_pic')
    } else {
      args.push('-c:a', 'libmp3lame', '-q:a', '2')
    }
    args.push('-metadata', `title=${meta.title}`, '-metadata', `artist=${meta.artist}`, '-metadata', `album=${meta.album}`, finalFile)

    await execFileAsync('ffmpeg', args)
    return finalFile
  } catch (error: unknown) {
    console.error('[t] Music generation failed:', error)
    await removeFile(finalFile)
    return null
  } finally {
    await removeFile(rawFile)
  }
}

async function getUserConfig(msg: MessageContext): Promise<{
  userData: AllUserData
  userId: string
  config: UserConfig
}> {
  const userId = msg.sender.id.toString()
  const userData = await loadUserData()
  let config = userData.users[userId]

  if (!config) {
    config = {
      defaultRole: '晓晓',
      defaultRoleId: userData.roles.晓晓
    }
    userData.users[userId] = config
    await saveUserData(userData)
  }

  return { userData, userId, config }
}

async function tts(msg: MessageContext): Promise<void> {
  const { config } = await getUserConfig(msg)
  const parts = msg.text.split(/\s+/).slice(1)
  const client = await getGlobalClient()
  if (!client) {
    await msg.edit({ text: '❌ 客户端未初始化' })
    return
  }

  if (parts.length >= 3) {
    const title = parts[0]
    const artist = parts[1]
    const text = parts.slice(2).join(' ')
    const file = await generateMusic(cleanTextForTTS(text), config.defaultRoleId, {
      title,
      artist,
      album: 'TTS'
    })

    if (!file) {
      await msg.edit({ text: '❌ 生成失败，请确认 edge-tts 和 ffmpeg 已安装' })
      return
    }

    try {
      await client.sendMedia(msg.chat.id, {
        type: 'audio',
        file,
        title,
        performer: artist
      })
      await msg.delete({ revoke: true })
    } finally {
      await removeFile(file)
    }
    return
  }

  const text = parts.join(' ')
  if (!text) {
    await msg.edit({ text: '❌ 请输入文本' })
    return
  }

  const generated = await generateSpeechSimple(cleanTextForTTS(text), config.defaultRoleId)
  if (!generated) {
    await msg.edit({ text: '❌ 生成失败，请确认 edge-tts 和 ffmpeg 已安装' })
    return
  }

  try {
    await client.sendMedia(msg.chat.id, {
      type: 'voice',
      file: generated.oggFile
    })
    await msg.delete({ revoke: true })
  } finally {
    await Promise.all([removeFile(generated.oggFile), removeFile(generated.mp3File)])
  }
}

async function ttsSet(msg: MessageContext): Promise<void> {
  const { userData, userId } = await getUserConfig(msg)
  const roleName = msg.text.split(/\s+/)[1]

  if (!roleName || !userData.roles[roleName]) {
    await msg.edit({ text: '❌ 未找到该角色，请查看插件帮助中的角色列表' })
    return
  }

  userData.users[userId] = {
    defaultRole: roleName,
    defaultRoleId: userData.roles[roleName]
  }
  await saveUserData(userData)
  await msg.edit({ text: `✅ 切换为 ${roleName}` })
}

const help_text = `🚀 免费文字转语音（edge-tts）

📝 基本用法：
• ${mainPrefix}t 文本            → 生成语音
• ${mainPrefix}ts 角色名         → 切换语音角色

🎭 支持角色列表：
• 晓晓    zh-CN-XiaoxiaoNeural
• 云希    zh-CN-YunxiNeural
• 晓伊    zh-CN-XiaoyiNeural
• 云扬    zh-CN-YunyangNeural
• 台湾女  zh-TW-HsiaoChenNeural
• 英文男  en-US-GuyNeural
• 英文女  en-US-JennyNeural

⚡ 特性：
• 自动删除命令消息
• 免费无限使用（edge-tts）
• 支持音乐模式（${mainPrefix}t 歌曲名 歌手 文本）

运行依赖：edge-tts、ffmpeg`

class TTSPlugin extends Plugin {
  description = help_text

  async cleanup(): Promise<void> {
    await Promise.all([...activeFiles].map(removeFile))
  }

  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    t: tts,
    ts: ttsSet
  }
}

export default new TTSPlugin()
