import * as http from 'node:http'
import * as http2 from 'node:http2'
import * as https from 'node:https'
import * as path from 'node:path'
// @ts-expect-error -- provided by the TeleBox-Next host
import type { MessageContext } from '@mtcute/dispatcher'
// @ts-expect-error -- provided by the TeleBox-Next host
import { thtml as html } from '@mtcute/node'
// @ts-expect-error -- provided by the TeleBox-Next host
import { htmlEscape } from '@utils/htmlEscape'
// @ts-expect-error -- provided by the TeleBox-Next host
import { createDirectoryInAssets } from '@utils/pathHelpers'
// @ts-expect-error -- provided by the TeleBox-Next host
import { Plugin } from '@utils/pluginBase'
// @ts-expect-error -- provided by the TeleBox-Next host
import { getPrefixes } from '@utils/pluginManager'
// @ts-expect-error -- provided by the TeleBox-Next host
import { getGlobalClient } from '@utils/runtimeManager'
// @ts-expect-error -- provided by the TeleBox-Next host
import { safeGetReplyMessage } from '@utils/safeGetMessages'
// @ts-expect-error -- provided by the TeleBox-Next host
import type { Low } from 'lowdb'
// @ts-expect-error -- provided by the TeleBox-Next host
import { JSONFilePreset } from 'lowdb/node'

/**
 * A deliberately small proto surface. CloudDrive2 keeps the same fully
 * qualified service and field numbers, so proto-loader can call the official
 * gRPC endpoint without shipping generated code or credentials.
 */
interface Cd2Config {
  endpoint: string
  token: string
  accountUsername: string
  accountPassword: string
  defaultPath: string
  webdavUrl: string
  webdavUsername: string
  webdavPassword: string
  webdavRoot: string
}

type Db = Low<Cd2Config>
type Cd2File = {
  name?: string
  fullPathName?: string
  size?: string | number
  fileType?: string | number
  isDirectory?: boolean
  isCloudDirectory?: boolean
  isCloudFile?: boolean
  isLocal?: boolean
  readOnly?: boolean
}

const prefixes = getPrefixes()
const commandName = `${prefixes[0] || '.'}cd2`
const DEFAULT_ENDPOINT = 'http://localhost:19798'
const REQUEST_TIMEOUT = 20_000
const MAX_ITEMS = 40
const MAX_MESSAGE_LENGTH = 3800

const helpText = `
<b>☁️ CloudDrive2 全功能管理</b>

<b>1. 公共方法</b>
• <code>${commandName} status</code> 服务、登录和运行状态
• <code>${commandName} check</code> 验证连接
• <code>${commandName} account status|logout</code> 账户状态/退出

<b>2. 文件操作</b>
• <code>${commandName} ls [路径]</code> 浏览目录
• <code>${commandName} find /路径/文件</code> 查询文件
• <code>${commandName} grep 关键词 [路径]</code> 搜索文件
• <code>${commandName} mkdir /父目录 文件夹名</code> 创建目录
• <code>${commandName} rename /文件 新名称</code> 重命名
• <code>${commandName} mv /源路径 /目标目录</code> 移动
• <code>${commandName} cp /源路径 /目标目录</code> 复制
• <code>${commandName} rm /路径 confirm</code> 删除
• <code>${commandName} df [路径]</code> 空间信息
• <code>${commandName} dl /路径/文件</code> 下载并发送到 Telegram

<b>3. 挂载点管理</b>
• <code>${commandName} mount list</code> 查看挂载点
• <code>${commandName} mount add /挂载点 /源目录 [readonly] [noauto]</code>
• <code>${commandName} mount update /挂载点 /新源目录 [readonly] [noauto]</code>
• <code>${commandName} mount mount|unmount /挂载点</code>
• <code>${commandName} mount remove /挂载点 confirm</code>

<b>4. 传输任务</b>
• <code>${commandName} transfer status</code> 任务统计
• <code>${commandName} transfer downloads</code> 下载任务列表
• <code>${commandName} transfer uploads [页码]</code> 上传任务列表
• <code>${commandName} transfer pause|resume|cancel all|KEY...</code> 控制上传任务

<b>5. 云 API 管理</b>
• <code>${commandName} api list</code> 查看云 API
• <code>${commandName} api add webdav URL USER PASSWORD</code>
• <code>${commandName} api add local /本地目录</code>
• <code>${commandName} api add pikpak USER PASSWORD</code>
• <code>${commandName} api add aliyun-refresh REFRESH_TOKEN [openapi]</code>
• <code>${commandName} api remove CLOUD USER confirm</code>
• <code>${commandName} api config get|set CLOUD USER KEY VALUE</code>

<b>6. 备份管理</b>
• <code>${commandName} backup list</code> 查看备份
• <code>${commandName} backup add|update /源目录 /目标目录</code>
• <code>${commandName} backup enable|watch /源目录 on|off</code>
• <code>${commandName} backup destination add|remove /源目录 /目标目录</code>
• <code>${commandName} backup restart /源目录</code>
• <code>${commandName} backup remove /源目录 confirm</code>

<b>7. WebDAV 管理</b>
• <code>${commandName} dav status|on|off</code>
• <code>${commandName} dav account on|off [/根目录]</code> CloudDrive 账户模式
• <code>${commandName} dav add USER PASSWORD [/根目录]</code> 添加独立用户
• <code>${commandName} dav remove USER confirm</code>
• <code>${commandName} dav ls|mkdir|rm</code>

<b>8. 令牌管理</b>
• <code>${commandName} login</code> 账户登录并获取 Token
• <code>${commandName} token show|clear|login</code>
• <code>${commandName} conf token YOUR_CD2_API_TOKEN</code>

<b>9. 远程上传</b>
• <code>${commandName} remote add URL [目标目录]</code> 提交离线下载/远程上传任务
• <code>${commandName} remote list [路径]</code>
• <code>${commandName} remote list-all CLOUD ACCOUNT [页码]</code>
• <code>${commandName} remote remove CLOUD ACCOUNT confirm HASH...</code>
• 回复 Telegram 文件后：<code>${commandName} up [目标目录]</code>

<b>基础配置</b>
• <code>${commandName} conf endpoint http://host:19798</code>
• <code>${commandName} conf account USER PASSWORD</code>
• <code>${commandName} conf path /</code>
• <code>${commandName} conf dav-url http://host:19798/dav</code>
• <code>${commandName} conf dav-user USER PASSWORD</code>
• <code>${commandName} conf dav-root /Telegram</code>
• <code>${commandName} conf show</code>

账户密码、Token、云 API 密钥只保存在插件自己的配置文件中，显示时会脱敏。`

const htmlText = (text: string): string => html(text)

const maskToken = (token: string): string => {
  if (!token) return '未设置'
  if (token.length <= 8) return `${token.slice(0, 2)}••••••`
  return `${token.slice(0, 4)}••••${token.slice(-4)}`
}

const normalizeEndpoint = (value: string): string => {
  const input = value.trim()
  const parsed = new URL(/^https?:\/\//i.test(input) ? input : `http://${input}`)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('CD2 地址只支持 http:// 或 https://')
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('CD2 地址不能包含路径、查询参数或锚点')
  }
  if (!parsed.port) parsed.port = parsed.protocol === 'https:' ? '443' : '80'
  return parsed.origin
}

const normalizePath = (value: string): string => {
  const input = value.trim()
  if (!input) return '/'
  if (!input.startsWith('/')) throw new Error('CD2 路径必须以 / 开头')
  return input.length > 1 ? input.replace(/\/+$/, '') : '/'
}

type WebDavResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }

const normalizeWebDavUrl = (value: string): string => {
  const input = value.trim()
  const parsed = new URL(/^https?:\/\//i.test(input) ? input : `http://${input}`)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('WebDAV 地址只支持 http:// 或 https://')
  if (parsed.search || parsed.hash) throw new Error('WebDAV 地址不能包含查询参数或锚点')
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/dav'
  return parsed.toString().replace(/\/$/, '')
}

const davPathUrl = (baseUrl: string, remotePath: string): URL => {
  const base = new URL(baseUrl)
  const basePath = base.pathname.replace(/\/+$/, '')
  const encodedPath = normalizePath(remotePath)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  base.pathname = `${basePath}${encodedPath === '/' ? '/' : encodedPath}`
  base.search = ''
  base.hash = ''
  return base
}

const davRequest = (config: Cd2Config, method: string, remotePath: string, body?: Buffer, extraHeaders: Record<string, string> = {}): Promise<WebDavResponse> => {
  const username = config.webdavUsername || config.accountUsername
  const password = config.webdavPassword || config.accountPassword
  if (!config.webdavUrl || !username || !password) throw new Error(`请先配置 WebDAV 地址和账号，使用 ${commandName} conf dav-url|dav-user 或 ${commandName} conf account|login`)
  const target = davPathUrl(config.webdavUrl, remotePath)
  const transport = target.protocol === 'https:' ? https : http
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
    ...extraHeaders
  }
  if (body) {
    headers['Content-Length'] = String(body.length)
    headers['Content-Type'] ||= 'application/octet-stream'
  }
  return new Promise((resolve, reject) => {
    const request = transport.request(target, { method, headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const result = { status: response.statusCode || 0, headers: response.headers as Record<string, string | string[] | undefined>, body: Buffer.concat(chunks) }
        if (result.status >= 400) {
          reject(new Error(`WebDAV HTTP ${result.status}: ${result.body.toString('utf8').slice(0, 300)}`))
          return
        }
        resolve(result)
      })
    })
    request.setTimeout(60_000, () => request.destroy(new Error('WebDAV 请求超时')))
    request.on('error', reject)
    if (body) request.write(body)
    request.end()
  })
}

const downloadHttpBuffer = (rawUrl: string, userAgent?: string, redirects = 0): Promise<{ body: Buffer; contentType: string }> => {
  if (redirects > 5) return Promise.reject(new Error('下载地址重定向次数过多'))
  const target = new URL(rawUrl)
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return Promise.reject(new Error('CD2 下载地址协议不受支持'))
  const transport = target.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const request = transport.get(target, { headers: userAgent ? { 'User-Agent': userAgent } : undefined }, (response) => {
      const location = response.headers.location
      if (location && response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        response.resume()
        downloadHttpBuffer(new URL(location, target).toString(), userAgent, redirects + 1).then(resolve, reject)
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      response.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > 128 * 1024 * 1024) {
          request.destroy(new Error('单个下载文件不能超过 128 MiB'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        if ((response.statusCode || 0) >= 400) {
          reject(new Error(`CD2 下载失败：HTTP ${response.statusCode || 0}`))
          return
        }
        resolve({ body: Buffer.concat(chunks), contentType: String(response.headers['content-type'] || 'application/octet-stream').split(';', 1)[0] })
      })
    })
    request.setTimeout(120_000, () => request.destroy(new Error('CD2 下载超时')))
    request.on('error', reject)
  })
}

const xmlUnescape = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

const parseDavEntries = (body: Buffer): Array<{ href: string; name: string; size: string; directory: boolean }> => {
  const xml = body.toString('utf8')
  const responsePattern = /<(?:[A-Za-z_][\w.-]*:)?response\b[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?response>/gi
  const field = (item: string, tag: string): string => {
    const pattern = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${tag}>`, 'i')
    return xmlUnescape(item.match(pattern)?.[1]?.trim() || '')
  }
  return [...xml.matchAll(responsePattern)].map((match) => {
    const item = match[0]
    const href = field(item, 'href')
    const fallbackName = href.split('/').filter(Boolean).at(-1) || '/'
    let decodedName = fallbackName
    try {
      decodedName = decodeURIComponent(fallbackName)
    } catch {}
    const name = field(item, 'displayname') || decodedName
    const size = field(item, 'getcontentlength').match(/^\d+$/)?.[0] || '0'
    return { href, name, size, directory: /<(?:[A-Za-z_][\w.-]*:)?collection\b[^>]*\/?\s*>/i.test(item) }
  })
}

const tokenize = (text: string): string[] => {
  const result: string[] = []
  let token = ''
  let quote = ''
  for (const character of text.trim()) {
    if (quote) {
      if (character === quote) quote = ''
      else token += character
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (/\s/.test(character)) {
      if (token) {
        result.push(token)
        token = ''
      }
    } else {
      token += character
    }
  }
  if (quote) throw new Error('参数引号没有闭合')
  if (token) result.push(token)
  return result
}

const errorMessage = (error: unknown): string => {
  const candidate = error as { details?: string; message?: string; code?: number }
  const text = candidate?.details || candidate?.message || String(error)
  return text.replace(/^Error:\s*/i, '').slice(0, 500)
}

const formatBytes = (value: string | number | undefined): string => {
  const bytes = Number(value || 0)
  if (!Number.isFinite(bytes) || bytes < 0) return '未知'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

const getMediaExtension = (media: { type?: string; mimeType?: string }): string => {
  const mimeType = (media.mimeType || (media.type === 'photo' ? 'image/jpeg' : '')).toLowerCase().split(';', 1)[0]
  const knownExtensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav'
  }
  if (knownExtensions[mimeType]) return knownExtensions[mimeType]
  const subtype = mimeType.split('/')[1]?.replace(/[^a-z0-9]+/g, '')
  if (subtype && subtype !== 'octetstream') return subtype
  if (media.type === 'sticker') return 'webp'
  if (media.type === 'voice') return 'ogg'
  return 'bin'
}

const formatFile = (file: Cd2File, index: number): string => {
  const icon = file.isDirectory || file.isCloudDirectory ? '📁' : '📄'
  const name = htmlEscape(String(file.name || file.fullPathName || '未知'))
  const size = file.isDirectory || file.isCloudDirectory ? '' : ` · ${formatBytes(file.size)}`
  const readonly = file.readOnly ? ' · 只读' : ''
  return `${index + 1}. ${icon} <code>${name}</code>${size}${readonly}`
}

const chunkText = (items: string[], max = MAX_MESSAGE_LENGTH): string[] => {
  const chunks: string[] = []
  let current = ''
  for (const item of items) {
    const next = current ? `${current}\n${item}` : item
    if (current && next.length > max) {
      chunks.push(current)
      current = item
    } else {
      current = next
    }
  }
  if (current) chunks.push(current)
  return chunks
}

type ProtoScalar = bigint | Buffer
interface ProtoField {
  number: number
  wire: number
  value: ProtoScalar
}
type RpcResponse = Record<string, any>

const encodeVarint = (input: number | bigint): Buffer => {
  let value = BigInt(input)
  const bytes: number[] = []
  do {
    let byte = Number(value & 0x7fn)
    value >>= 7n
    if (value) byte |= 0x80
    bytes.push(byte)
  } while (value)
  return Buffer.from(bytes)
}

const encodeField = (number: number, value: string | number | bigint | boolean): Buffer => {
  if (typeof value === 'boolean') {
    return value ? Buffer.concat([encodeVarint(number << 3), encodeVarint(1)]) : Buffer.alloc(0)
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value ? Buffer.concat([encodeVarint(number << 3), encodeVarint(value)]) : Buffer.alloc(0)
  }
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([encodeVarint((number << 3) | 2), encodeVarint(bytes.length), bytes])
}

const encodeBytesField = (number: number, value: Buffer): Buffer => Buffer.concat([encodeVarint((number << 3) | 2), encodeVarint(value.length), value])

const encodeNested = (values: Array<[number, string | number | bigint | boolean | Buffer | undefined]>): Buffer => {
  const fields = values.map(([number, value]) => {
    if (value === undefined || value === null || value === '' || value === false || value === 0) return Buffer.alloc(0)
    return Buffer.isBuffer(value) ? encodeBytesField(number, value) : encodeField(number, value)
  })
  return Buffer.concat(fields)
}

const encodeBackup = (request: Record<string, unknown>): Buffer => {
  const destinations = Array.isArray(request.destinations)
    ? request.destinations.flatMap((destination) => {
        if (!destination || typeof destination !== 'object') return []
        const item = destination as Record<string, unknown>
        return [
          encodeNested([
            [1, item.destinationPath as string],
            [2, item.isEnabled as boolean]
          ])
        ]
      })
    : request.destinationPath
      ? [
          encodeNested([
            [1, request.destinationPath as string],
            [2, true]
          ])
        ]
      : []
  return encodeNested([
    [1, request.sourcePath as string],
    ...destinations.map((destination) => [2, destination] as [number, Buffer]),
    [4, request.fileReplaceRule as number],
    [5, request.fileDeleteRule as number],
    [6, request.isEnabled as boolean],
    [7, request.fileSystemWatchEnabled as boolean],
    [8, request.walkingThroughIntervalSecs as number],
    [9, request.forceWalkingThroughOnStart as boolean],
    [11, request.isTimeSchedulesEnabled as boolean]
  ])
}

const encodeRequest = (method: string, request: Record<string, unknown>): Buffer => {
  const fields: Buffer[] = []
  const add = (number: number, value: unknown): void => {
    if (value === undefined || value === null || value === '' || value === false) return
    if (Array.isArray(value)) {
      for (const item of value) add(number, item)
      return
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
      fields.push(encodeField(number, value))
    }
  }
  const addBoolean = (number: number, value: unknown): void => {
    if (typeof value === 'boolean') fields.push(encodeField(number, value))
  }
  const addBytes = (number: number, value: unknown): void => {
    if (Buffer.isBuffer(value)) fields.push(encodeBytesField(number, value))
  }
  switch (method) {
    case 'GetSubFiles':
      add(1, request.path)
      add(2, request.forceRefresh)
      break
    case 'GetToken':
      add(1, request.userName)
      add(2, request.password)
      break
    case 'Register':
      add(1, request.userName)
      add(2, request.password)
      break
    case 'SendResetAccountEmail':
      add(1, request.email)
      break
    case 'ResetAccount':
      add(1, request.resetCode)
      add(2, request.newPassword)
      break
    case 'ConfirmEmail':
      add(1, request.confirmCode)
      break
    case 'Login':
      add(1, request.userName)
      add(2, request.password)
      add(3, request.synDataToCloud)
      break
    case 'GetSearchResults':
      add(1, request.path)
      add(2, request.searchFor)
      add(3, request.forceRefresh)
      add(4, request.fuzzyMatch)
      break
    case 'FindFileByPath':
      add(1, request.parentPath)
      add(2, request.path)
      break
    case 'CreateFolder':
      add(1, request.parentPath)
      add(2, request.folderName)
      break
    case 'RenameFile':
      add(1, request.theFilePath)
      add(2, request.newName)
      break
    case 'MoveFile':
    case 'CopyFile': {
      add(1, request.theFilePaths)
      add(2, request.destPath)
      const policy = typeof request.conflictPolicy === 'string' ? { Overwrite: 0, Rename: 1, Skip: 2 }[request.conflictPolicy] : request.conflictPolicy
      add(3, policy)
      break
    }
    case 'DeleteFile':
    case 'GetSpaceInfo':
      add(1, request.path)
      add(2, request.forceRefresh)
      break
    case 'GetDownloadUrlPath':
      add(1, request.path)
      add(2, request.preview)
      add(3, request.lazyRead ?? request.lazy_read)
      add(4, request.getDirectUrl ?? request.get_direct_url)
      break
    case 'GetAccountStatus':
    case 'GetMountPoints':
    case 'HasDriveLetters':
    case 'CanAddMoreMountPoints':
    case 'GetDownloadFileCount':
    case 'GetDownloadFileList':
    case 'GetUploadFileCount':
    case 'CancelAllUploadFiles':
    case 'PauseAllUploadFiles':
    case 'ResumeAllUploadFiles':
    case 'CanAddMoreCloudApis':
    case 'GetAllCloudApis':
    case 'CanAddMoreBackups':
    case 'BackupGetAll':
      break
    case 'GetAvailableDriveLetters':
      addBoolean(1, request.includeCloudDrive)
      break
    case 'Logout':
      addBoolean(1, request.logoutFromCloudFS)
      break
    case 'AddMountPoint': {
      const option = encodeNested([
        [1, request.mountPoint as string],
        [2, request.sourceDir as string],
        [3, request.localMount as boolean],
        [4, request.readOnly as boolean],
        [5, request.autoMount as boolean],
        [6, request.uid as number],
        [7, request.gid as number],
        [8, request.permissions as string],
        [9, request.name as string]
      ])
      fields.push(option)
      break
    }
    case 'RemoveMountPoint':
    case 'Mount':
    case 'Unmount':
      add(1, request.mountPoint)
      break
    case 'UpdateMountPoint': {
      add(1, request.mountPoint)
      const option = encodeNested([
        [1, request.newMountPoint as string],
        [2, request.newSourceDir as string],
        [3, request.newLocalMount as boolean],
        [4, request.newReadOnly as boolean],
        [5, request.newAutoMount as boolean],
        [6, request.newUid as number],
        [7, request.newGid as number],
        [8, request.newPermissions as string],
        [9, request.newName as string]
      ])
      fields.push(encodeBytesField(2, option))
      break
    }
    case 'GetUploadFileList':
      addBoolean(1, request.getAll)
      add(2, request.itemsPerPage)
      add(3, request.pageNumber)
      add(4, request.filter)
      break
    case 'CancelUploadFiles':
    case 'PauseUploadFiles':
    case 'ResumeUploadFiles':
      add(1, request.keys)
      break
    case 'APILoginWebDav':
      add(1, request.serverUrl)
      add(2, request.userName)
      add(3, request.password)
      break
    case 'APILogin115Editthiscookie':
      add(1, request.editThiscookieString)
      break
    case 'APILogin115QRCode':
      add(1, request.platformString)
      break
    case 'APILoginAliyunDriveQRCode':
      addBoolean(1, request.useOpenAPI)
      break
    case 'ApiLoginGoogleDriveOAuth':
      add(1, request.refresh_token)
      add(2, request.access_token)
      add(3, request.expires_in)
      break
    case 'APILoginAliyundriveOAuth':
    case 'APILoginBaiduPanOAuth':
    case 'APILoginOneDriveOAuth':
    case 'ApiLoginXunleiOAuth':
      add(1, request.refresh_token)
      add(2, request.access_token)
      add(3, request.expires_in)
      break
    case 'APILoginAliyundriveRefreshtoken':
      add(1, request.refreshToken)
      addBoolean(2, request.useOpenAPI)
      break
    case 'ApiLoginGoogleDriveRefreshToken':
      add(1, request.client_id)
      add(2, request.client_secret)
      add(3, request.refresh_token)
      break
    case 'APILoginPikPak':
      add(1, request.userName)
      add(2, request.password)
      addBoolean(3, request.synDataToCloud)
      break
    case 'APILogin189QRCode':
      break
    case 'APIAddLocalFolder':
      add(1, request.localFolderPath)
      break
    case 'RemoveCloudAPI':
      add(1, request.cloudName)
      add(2, request.userName)
      addBoolean(3, request.permanentRemove)
      break
    case 'GetCloudAPIConfig':
      add(1, request.cloudName)
      add(2, request.userName)
      break
    case 'SetCloudAPIConfig': {
      add(1, request.cloudName)
      add(2, request.userName)
      const cloudConfig = encodeNested([
        [1, request.maxDownloadThreads as number],
        [2, request.minReadLengthKB as number],
        [3, request.maxReadLengthKB as number],
        [4, request.defaultReadLengthKB as number],
        [5, request.maxBufferPoolSizeMB as number],
        [6, request.maxQueriesPerSecond as number],
        [7, request.forceIpv4 as boolean]
      ])
      fields.push(encodeBytesField(3, cloudConfig))
      break
    }
    case 'AddOfflineFiles':
      add(1, request.urls)
      add(2, request.toFolder)
      break
    case 'RemoveOfflineFiles':
      add(1, request.cloudName)
      add(2, request.cloudAccountId)
      addBoolean(3, request.deleteFiles)
      add(4, request.infoHashes)
      break
    case 'ListOfflineFilesByPath':
    case 'GetFileDetailProperties':
    case 'GetMetaData':
    case 'GetOriginalPath':
      add(1, request.path)
      break
    case 'ListAllOfflineFiles':
      add(1, request.cloudName)
      add(2, request.cloudAccountId)
      add(3, request.page)
      break
    case 'CreateFile':
      add(1, request.parentPath)
      add(2, request.fileName)
      break
    case 'CloseFile':
      add(1, request.fileHandle)
      break
    case 'WriteToFile':
      add(1, request.fileHandle)
      add(2, request.startPos)
      add(3, request.length)
      addBytes(4, request.buffer)
      addBoolean(5, request.closeFile)
      break
    case 'BackupAdd':
    case 'BackupUpdate': {
      const backup = encodeBackup(request)
      fields.push(backup)
      break
    }
    case 'BackupRemove':
    case 'BackupRestartWalkingThrough':
      add(1, request.value)
      break
    case 'BackupAddDestination':
    case 'BackupRemoveDestination': {
      add(1, request.sourcePath)
      const destination = encodeNested([
        [1, request.destinationPath as string],
        [2, request.destinationEnabled as boolean]
      ])
      fields.push(encodeBytesField(2, destination))
      break
    }
    case 'BackupSetEnabled':
      add(1, request.sourcePath)
      addBoolean(2, request.isEnabled)
      break
    case 'BackupSetFileSystemWatchEnabled':
      add(1, request.sourcePath)
      addBoolean(6, request.fileSystemWatchEnabled)
      break
    case 'AddDavUser':
      add(1, request.userName)
      add(2, request.password)
      add(3, request.rootPath)
      add(4, request.readOnly)
      add(5, request.enabled)
      add(6, request.guest)
      break
    case 'RemoveDavUser':
    case 'GetDavUser':
      add(1, request.value || request.userName)
      break
    case 'ModifyDavUser':
      add(1, request.userName)
      add(2, request.password)
      add(3, request.rootPath)
      add(4, request.readOnly)
      add(5, request.enabled)
      add(6, request.guest)
      break
    case 'SetDavServerConfig':
      addBoolean(1, request.enableDavServer)
      addBoolean(2, request.enableClouddriveAccount)
      add(3, request.clouddriveAccountRootPath)
      addBoolean(4, request.clouddriveAccountReadOnly)
      addBoolean(5, request.enableAnonymousAccess)
      add(6, request.anonymousRootPath)
      addBoolean(7, request.anonymousReadOnly)
      addBoolean(8, request.enableAccessLog)
      break
  }
  return Buffer.concat(fields)
}

const readVarint = (buffer: Buffer, offset: number): [bigint, number] => {
  let value = 0n
  let shift = 0n
  let cursor = offset
  while (cursor < buffer.length) {
    const byte = buffer[cursor++]
    value |= BigInt(byte & 0x7f) << shift
    if (!(byte & 0x80)) return [value, cursor]
    shift += 7n
    if (shift > 70n) throw new Error('CD2 返回了无效的 Protobuf 整数')
  }
  throw new Error('CD2 返回了截断的 Protobuf 数据')
}

const parseFields = (buffer: Buffer): ProtoField[] => {
  const fields: ProtoField[] = []
  let offset = 0
  while (offset < buffer.length) {
    const [tag, afterTag] = readVarint(buffer, offset)
    offset = afterTag
    const number = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 0) {
      const [value, next] = readVarint(buffer, offset)
      fields.push({ number, wire, value })
      offset = next
    } else if (wire === 2) {
      const [length, next] = readVarint(buffer, offset)
      const end = next + Number(length)
      if (end > buffer.length) throw new Error('CD2 返回了越界的 Protobuf 字段')
      fields.push({ number, wire, value: buffer.subarray(next, end) })
      offset = end
    } else if (wire === 1 || wire === 5) {
      const width = wire === 1 ? 8 : 4
      fields.push({ number, wire, value: buffer.subarray(offset, offset + width) })
      offset += width
    } else {
      throw new Error(`CD2 返回了不支持的 Protobuf wire type：${wire}`)
    }
  }
  return fields
}

const values = (fields: ProtoField[], number: number): ProtoScalar[] => fields.filter((field) => field.number === number).map((field) => field.value)
const text = (value: ProtoScalar | undefined): string => (Buffer.isBuffer(value) ? value.toString('utf8') : '')
const bool = (value: ProtoScalar | undefined): boolean => (typeof value === 'bigint' ? value !== 0n : false)
const integer = (value: ProtoScalar | undefined): string => (typeof value === 'bigint' ? value.toString() : '0')
const doubleValue = (value: ProtoScalar | undefined): number => (Buffer.isBuffer(value) && value.length >= 8 ? value.readDoubleLE(0) : 0)

const decodeFile = (buffer: Buffer): Cd2File => {
  const fields = parseFields(buffer)
  const fileType = Number(values(fields, 5).at(0) || 0)
  return {
    name: text(values(fields, 2).at(0)),
    fullPathName: text(values(fields, 3).at(0)),
    size: integer(values(fields, 4).at(0)),
    fileType,
    isDirectory: bool(values(fields, 30).at(0)) || fileType === 0,
    isCloudDirectory: bool(values(fields, 33).at(0)),
    isCloudFile: bool(values(fields, 34).at(0)),
    isLocal: bool(values(fields, 37).at(0)),
    readOnly: bool(values(fields, 80).at(0))
  }
}

const decodeOperationResult = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  return {
    success: bool(values(fields, 1).at(0)),
    errorMessage: text(values(fields, 2).at(0)),
    resultFilePaths: values(fields, 3)
      .filter(Buffer.isBuffer)
      .map((value) => text(value))
  }
}

const decodeDavUser = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  return {
    userName: text(values(fields, 1).at(0)),
    rootPath: text(values(fields, 3).at(0)),
    readOnly: bool(values(fields, 4).at(0)),
    enabled: bool(values(fields, 5).at(0)),
    guest: bool(values(fields, 6).at(0))
  }
}

const decodeMountPoint = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  return {
    mountPoint: text(values(fields, 1).at(0)),
    sourceDir: text(values(fields, 2).at(0)),
    localMount: bool(values(fields, 3).at(0)),
    readOnly: bool(values(fields, 4).at(0)),
    autoMount: bool(values(fields, 5).at(0)),
    uid: Number(values(fields, 6).at(0) || 0),
    gid: Number(values(fields, 7).at(0) || 0),
    permissions: text(values(fields, 8).at(0)),
    isMounted: bool(values(fields, 9).at(0)),
    failReason: text(values(fields, 10).at(0))
  }
}

const decodeUploadFile = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  return { key: text(values(fields, 1).at(0)), destPath: text(values(fields, 2).at(0)), size: integer(values(fields, 3).at(0)), transferedBytes: integer(values(fields, 4).at(0)), status: text(values(fields, 5).at(0)), errorMessage: text(values(fields, 6).at(0)) }
}

const decodeDownloadFile = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  return {
    filePath: text(values(fields, 1).at(0)),
    fileLength: integer(values(fields, 2).at(0)),
    totalBufferUsed: integer(values(fields, 3).at(0)),
    downloadThreadCount: Number(values(fields, 4).at(0) || 0),
    process: values(fields, 5)
      .filter(Buffer.isBuffer)
      .map((value) => text(value)),
    detailDownloadInfo: text(values(fields, 6).at(0))
  }
}

const decodeBackupDestination = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  return { destinationPath: text(values(fields, 1).at(0)), isEnabled: bool(values(fields, 2).at(0)) }
}

const decodeBackup = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  return {
    sourcePath: text(values(fields, 1).at(0)),
    destinations: values(fields, 2)
      .filter(Buffer.isBuffer)
      .map((value) => decodeBackupDestination(value as Buffer)),
    isEnabled: bool(values(fields, 6).at(0)),
    fileSystemWatchEnabled: bool(values(fields, 7).at(0)),
    walkingThroughIntervalSecs: integer(values(fields, 8).at(0))
  }
}

const decodeBackupStatus = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  const backup = values(fields, 1).find(Buffer.isBuffer)
  return { backup: backup ? decodeBackup(backup as Buffer) : {}, status: Number(values(fields, 2).at(0) || 0), statusMessage: text(values(fields, 3).at(0)), watcherStatus: Number(values(fields, 4).at(0) || 0), watcherStatusMessage: text(values(fields, 5).at(0)) }
}

const decodeOfflineFile = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  return {
    name: text(values(fields, 1).at(0)),
    size: integer(values(fields, 2).at(0)),
    url: text(values(fields, 3).at(0)),
    status: Number(values(fields, 4).at(0) || 0),
    infoHash: text(values(fields, 5).at(0)),
    fileId: text(values(fields, 6).at(0)),
    parentId: text(values(fields, 8).at(0)),
    percentDone: Number(values(fields, 9).at(0) || 0),
    peers: Number(values(fields, 10).at(0) || 0)
  }
}

const decodeCloudApiConfig = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  return {
    maxDownloadThreads: Number(values(fields, 1).at(0) || 0),
    minReadLengthKB: integer(values(fields, 2).at(0)),
    maxReadLengthKB: integer(values(fields, 3).at(0)),
    defaultReadLengthKB: integer(values(fields, 4).at(0)),
    maxBufferPoolSizeMB: integer(values(fields, 5).at(0)),
    maxQueriesPerSecond: doubleValue(values(fields, 6).at(0)),
    forceIpv4: bool(values(fields, 7).at(0))
  }
}

const decodeResponse = (method: string, buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  if (method === 'GetToken') return { success: bool(values(fields, 1).at(0)), errorMessage: text(values(fields, 2).at(0)), token: text(values(fields, 3).at(0)) }
  if (method === 'GetSystemInfo') {
    return { isLogin: bool(values(fields, 1).at(0)), userName: text(values(fields, 2).at(0)), systemReady: bool(values(fields, 3).at(0)), systemMessage: text(values(fields, 4).at(0)), hasError: bool(values(fields, 5).at(0)) }
  }
  if (method === 'GetSubFiles' || method === 'GetSearchResults') {
    return {
      subFiles: values(fields, 1)
        .filter(Buffer.isBuffer)
        .map((value) => decodeFile(value as Buffer))
    }
  }
  if (method === 'FindFileByPath') return decodeFile(buffer)
  if (method === 'Register' || method === 'Login' || method === 'Logout' || method === 'RenameFiles' || method === 'DeleteFiles' || method === 'DeleteFilePermanently' || method === 'DeleteFilesPermanently' || method === 'AddOfflineFiles' || method === 'RemoveOfflineFiles')
    return decodeOperationResult(buffer)
  if (method === 'GetAccountStatus') return { userName: text(values(fields, 1).at(0)), emailConfirmed: text(values(fields, 2).at(0)), accountBalance: doubleValue(values(fields, 3).at(0)) }
  if (method === 'CreateFolder') {
    const folder = values(fields, 1).find(Buffer.isBuffer)
    const result = values(fields, 2).find(Buffer.isBuffer)
    return { folderCreated: folder ? decodeFile(folder as Buffer) : undefined, result: result ? decodeOperationResult(result as Buffer) : undefined }
  }
  if (method === 'MoveFile' || method === 'CopyFile' || method === 'DeleteFile' || method === 'RenameFile') return decodeOperationResult(buffer)
  if (method === 'GetSpaceInfo') return { totalSpace: integer(values(fields, 1).at(0)), usedSpace: integer(values(fields, 2).at(0)), freeSpace: integer(values(fields, 3).at(0)) }
  if (method === 'GetMountPoints')
    return {
      mountPoints: values(fields, 1)
        .filter(Buffer.isBuffer)
        .map((value) => decodeMountPoint(value as Buffer))
    }
  if (method === 'GetAvailableDriveLetters')
    return {
      driveLetters: values(fields, 1)
        .filter(Buffer.isBuffer)
        .map((value) => text(value))
    }
  if (method === 'HasDriveLetters') return { hasDriveLetters: bool(values(fields, 1).at(0)) }
  if (method === 'AddMountPoint' || method === 'RemoveMountPoint' || method === 'Mount' || method === 'Unmount' || method === 'UpdateMountPoint') return { success: bool(values(fields, 1).at(0)), failReason: text(values(fields, 2).at(0)) }
  if (method === 'GetDownloadFileCount' || method === 'GetUploadFileCount') return { fileCount: Number(values(fields, 1).at(0) || 0) }
  if (method === 'GetDownloadFileList')
    return {
      globalBytesPerSecond: doubleValue(values(fields, 1).at(0)),
      downloadFiles: values(fields, 4)
        .filter(Buffer.isBuffer)
        .map((value) => decodeDownloadFile(value as Buffer))
    }
  if (method === 'GetUploadFileList')
    return {
      totalCount: Number(values(fields, 1).at(0) || 0),
      uploadFiles: values(fields, 2)
        .filter(Buffer.isBuffer)
        .map((value) => decodeUploadFile(value as Buffer))
    }
  if (method === 'GetAllTasksCount') return { downloadCount: Number(values(fields, 1).at(0) || 0), uploadCount: Number(values(fields, 2).at(0) || 0), copyTaskCount: Number(values(fields, 6).at(0) || 0) }
  if (method === 'GetRunningInfo') return { cpuUsage: Number(values(fields, 1).at(0) || 0), memUsageKB: integer(values(fields, 2).at(0)), uptime: Number(values(fields, 3).at(0) || 0) }
  if (method === 'GetAllCloudApis') {
    return {
      apis: values(fields, 1)
        .filter(Buffer.isBuffer)
        .map((value) => {
          const cloudFields = parseFields(value as Buffer)
          return {
            name: text(values(cloudFields, 1).at(0)),
            userName: text(values(cloudFields, 2).at(0)),
            nickName: text(values(cloudFields, 3).at(0)),
            isLocked: bool(values(cloudFields, 4).at(0)),
            supportMultiThreadUploading: bool(values(cloudFields, 5).at(0)),
            supportQpsLimit: bool(values(cloudFields, 6).at(0)),
            eventListenerRunning: bool(values(cloudFields, 7).at(0)),
            path: text(values(cloudFields, 10).at(0)),
            supportHttpDownload: bool(values(cloudFields, 11).at(0)),
            readOnly: bool(values(cloudFields, 12).at(0))
          }
        })
    }
  }
  if (
    method === 'APILogin115Editthiscookie' ||
    method === 'APILoginAliyundriveOAuth' ||
    method === 'APILoginAliyundriveRefreshtoken' ||
    method === 'APILoginBaiduPanOAuth' ||
    method === 'APILoginOneDriveOAuth' ||
    method === 'ApiLoginGoogleDriveOAuth' ||
    method === 'ApiLoginGoogleDriveRefreshToken' ||
    method === 'ApiLoginXunleiOAuth' ||
    method === 'APILoginPikPak' ||
    method === 'APILoginWebDav' ||
    method === 'APIAddLocalFolder'
  )
    return { success: bool(values(fields, 1).at(0)), errorMessage: text(values(fields, 2).at(0)) }
  if (method === 'GetCloudAPIConfig') return decodeCloudApiConfig(buffer)
  if (method === 'APILogin115QRCode' || method === 'APILoginAliyunDriveQRCode' || method === 'APILogin189QRCode') return { messageType: Number(values(fields, 1).at(0) || 0), message: text(values(fields, 2).at(0)) }
  if (method === 'ListOfflineFilesByPath')
    return {
      offlineFiles: values(fields, 1)
        .filter(Buffer.isBuffer)
        .map((value) => decodeOfflineFile(value as Buffer))
    }
  if (method === 'ListAllOfflineFiles')
    return {
      pageNo: Number(values(fields, 1).at(0) || 0),
      pageRowCount: Number(values(fields, 2).at(0) || 0),
      pageCount: Number(values(fields, 3).at(0) || 0),
      totalCount: Number(values(fields, 4).at(0) || 0),
      offlineFiles: values(fields, 6)
        .filter(Buffer.isBuffer)
        .map((value) => decodeOfflineFile(value as Buffer))
    }
  if (method === 'BackupGetAll')
    return {
      backups: values(fields, 1)
        .filter(Buffer.isBuffer)
        .map((value) => decodeBackupStatus(value as Buffer))
    }
  if (method === 'CreateFile') return { fileHandle: integer(values(fields, 1).at(0)) }
  if (method === 'WriteToFile') return { bytesWritten: integer(values(fields, 1).at(0)) }
  if (method === 'GetDownloadUrlPath') return { downloadUrlPath: text(values(fields, 1).at(0)), expiresIn: integer(values(fields, 2).at(0)), directUrl: text(values(fields, 3).at(0)), userAgent: text(values(fields, 4).at(0)) }
  if (method === 'GetDavUser') return decodeDavUser(buffer)
  if (method === 'GetDavServerConfig') {
    return {
      davServerEnabled: bool(values(fields, 1).at(0)),
      davServerPath: text(values(fields, 2).at(0)),
      enableClouddriveAccount: bool(values(fields, 3).at(0)),
      clouddriveAccountRootPath: text(values(fields, 4).at(0)),
      clouddriveAccountReadOnly: bool(values(fields, 5).at(0)),
      enableAnonymousAccess: bool(values(fields, 6).at(0)),
      anonymousRootPath: text(values(fields, 7).at(0)),
      anonymousReadOnly: bool(values(fields, 8).at(0)),
      users: values(fields, 9)
        .filter(Buffer.isBuffer)
        .map((value) => decodeDavUser(value as Buffer)),
      enableAccessLog: bool(values(fields, 10).at(0))
    }
  }
  return {}
}

const frameGrpc = (payload: Buffer): Buffer => {
  const frame = Buffer.allocUnsafe(5 + payload.length)
  frame[0] = 0
  frame.writeUInt32BE(payload.length, 1)
  payload.copy(frame, 5)
  return frame
}

class Cd2Client {
  constructor(private readonly getConfig: () => Promise<Cd2Config>) {}
  close(): void {}

  private async request(method: string, request: Record<string, unknown>, streaming: boolean): Promise<RpcResponse[]> {
    const config = await this.getConfig()
    if (!config.endpoint) throw new Error(`请先配置 CD2 地址，使用 ${commandName} conf endpoint ...`)
    const parsed = new URL(config.endpoint)
    const session = http2.connect(parsed.origin, parsed.protocol === 'https:' ? { rejectUnauthorized: true } : undefined)
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let grpcStatus = '0'
      let settled = false
      const timer = setTimeout(() => finish(new Error('CD2 请求超时')), REQUEST_TIMEOUT)
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        session.close()
        if (error) {
          reject(error)
          return
        }
        if (grpcStatus !== '0') {
          reject(new Error(`CD2 gRPC 错误状态：${grpcStatus}`))
          return
        }
        const body = Buffer.concat(chunks)
        const responses: RpcResponse[] = []
        let offset = 0
        while (offset + 5 <= body.length) {
          const compressed = body[offset]
          const length = body.readUInt32BE(offset + 1)
          offset += 5
          if (offset + length > body.length) throw new Error('CD2 返回了截断的 gRPC 帧')
          if (compressed !== 0) throw new Error('CD2 返回了不支持的压缩 gRPC 帧')
          responses.push(decodeResponse(method, body.subarray(offset, offset + length)))
          offset += length
        }
        if (offset !== body.length) throw new Error('CD2 返回了无效的 gRPC 帧')
        resolve(streaming ? responses : responses.slice(0, 1))
      }
      session.on('error', (error) => finish(error))
      const headers: Record<string, string> = {
        ':method': 'POST',
        ':path': `/clouddrive.CloudDriveFileSrv/${method}`,
        'content-type': 'application/grpc',
        te: 'trailers',
        'grpc-accept-encoding': 'identity'
      }
      if (config.token) headers.authorization = `Bearer ${config.token}`
      const stream = session.request(headers)
      stream.on('response', (responseHeaders) => {
        if (Number(responseHeaders[':status'] || 200) >= 400) finish(new Error(`CD2 HTTP 状态异常：${responseHeaders[':status']}`))
        if (responseHeaders['grpc-status']) grpcStatus = String(responseHeaders['grpc-status'])
      })
      stream.on('trailers', (trailers) => {
        if (trailers['grpc-status']) grpcStatus = String(trailers['grpc-status'])
      })
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('error', (error) => finish(error))
      stream.on('end', () => finish())
      stream.end(frameGrpc(encodeRequest(method, request)))
    })
  }

  async unary(method: string, request: Record<string, unknown> = {}): Promise<RpcResponse> {
    const responses = await this.request(method, request, false)
    return responses[0] || {}
  }

  async stream(method: string, request: Record<string, unknown> = {}): Promise<RpcResponse[]> {
    return this.request(method, request, true)
  }
}

class Cd2Plugin extends Plugin {
  description = helpText
  private dbPromise?: Promise<Db>
  private client?: Cd2Client

  cleanup(): void {
    this.client?.close()
    this.client = undefined
    this.dbPromise = undefined
  }

  private async getDb(): Promise<Db> {
    if (!this.dbPromise) {
      const directory = createDirectoryInAssets('cd2')
      this.dbPromise = JSONFilePreset<Cd2Config>(path.join(directory, 'config.json'), {
        endpoint: DEFAULT_ENDPOINT,
        token: '',
        accountUsername: '',
        accountPassword: '',
        defaultPath: '/',
        webdavUrl: `${DEFAULT_ENDPOINT}/dav`,
        webdavUsername: '',
        webdavPassword: '',
        webdavRoot: '/'
      })
    }
    return this.dbPromise
  }

  private async getConfig(): Promise<Cd2Config> {
    const db = await this.getDb()
    await db.read()
    const defaults: Cd2Config = { endpoint: DEFAULT_ENDPOINT, token: '', accountUsername: '', accountPassword: '', defaultPath: '/', webdavUrl: `${DEFAULT_ENDPOINT}/dav`, webdavUsername: '', webdavPassword: '', webdavRoot: '/' }
    const config = { ...defaults, ...db.data }
    if (JSON.stringify(config) !== JSON.stringify(db.data)) {
      db.data = config
      await db.write()
    }
    return config
  }

  private async updateConfig(patch: Partial<Cd2Config>): Promise<Cd2Config> {
    const db = await this.getDb()
    await db.read()
    db.data = { ...db.data, ...patch }
    await db.write()
    this.client?.close()
    return { ...db.data }
  }

  private getClient(): Cd2Client {
    if (!this.client) this.client = new Cd2Client(() => this.getConfig())
    return this.client
  }

  private async handleConfig(msg: MessageContext, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase()
    if (action === 'show') {
      const config = await this.getConfig()
      await msg.edit({
        text: htmlText(
          [
            '<b>⚙️ CloudDrive2 配置</b>',
            `<b>地址：</b> <code>${htmlEscape(config.endpoint || '未设置')}</code>`,
            `<b>Token：</b> <code>${htmlEscape(maskToken(config.token))}</code>`,
            `<b>CloudDrive 账户：</b> <code>${htmlEscape(config.accountUsername || '未设置')}</code>`,
            `<b>CloudDrive 密码：</b> <code>${htmlEscape(maskToken(config.accountPassword))}</code>`,
            `<b>默认路径：</b> <code>${htmlEscape(config.defaultPath)}</code>`,
            `<b>WebDAV：</b> <code>${htmlEscape(config.webdavUrl || '未设置')}</code>`,
            `<b>WebDAV 用户：</b> <code>${htmlEscape(config.webdavUsername || (config.accountUsername ? `${config.accountUsername}（CloudDrive 账户）` : '未设置'))}</code>`,
            `<b>WebDAV 密码：</b> <code>${htmlEscape(maskToken(config.webdavPassword))}</code>`,
            `<b>WebDAV 上传根目录：</b> <code>${htmlEscape(config.webdavRoot)}</code>`
          ].join('\n')
        )
      })
      return
    }
    if (action === 'endpoint' || action === 'url') {
      if (!args[1]) throw new Error(`用法：${commandName} conf endpoint http://host:19798`)
      const endpoint = normalizeEndpoint(args[1])
      await this.updateConfig({ endpoint })
      await msg.edit({ text: htmlText(`✅ CD2 地址已设置为 <code>${htmlEscape(endpoint)}</code>`) })
      return
    }
    if (action === 'token') {
      const token = args[1]?.trim()
      if (!token || token.length < 8) throw new Error('CD2 API Token 至少需要 8 个字符')
      await this.updateConfig({ token })
      await msg.edit({ text: '✅ CD2 API Token 已保存' })
      return
    }
    if (action === 'account') {
      if (!args[1] || !args[2]) throw new Error(`用法：${commandName} conf account USER PASSWORD`)
      await this.updateConfig({ accountUsername: args[1], accountPassword: args[2], token: '' })
      await msg.edit({ text: `✅ CloudDrive 账户已保存：<code>${htmlEscape(args[1])}</code>\n请继续使用 ${commandName} login 完成登录` })
      return
    }
    if (action === 'path') {
      if (!args[1]) throw new Error(`用法：${commandName} conf path /目录`)
      const defaultPath = normalizePath(args[1])
      await this.updateConfig({ defaultPath })
      await msg.edit({ text: htmlText(`✅ 默认路径已设置为 <code>${htmlEscape(defaultPath)}</code>`) })
      return
    }
    if (action === 'dav-url') {
      if (!args[1]) throw new Error(`用法：${commandName} conf dav-url http://host:19798/dav`)
      const webdavUrl = normalizeWebDavUrl(args[1])
      await this.updateConfig({ webdavUrl })
      await msg.edit({ text: htmlText(`✅ WebDAV 地址已设置为 <code>${htmlEscape(webdavUrl)}</code>`) })
      return
    }
    if (action === 'dav-user') {
      if (!args[1] || !args[2]) throw new Error(`用法：${commandName} conf dav-user USER PASSWORD`)
      await this.updateConfig({ webdavUsername: args[1], webdavPassword: args[2] })
      await msg.edit({ text: '✅ WebDAV 账号已保存' })
      return
    }
    if (action === 'dav-root') {
      if (!args[1]) throw new Error(`用法：${commandName} conf dav-root /目录`)
      const webdavRoot = normalizePath(args[1])
      await this.updateConfig({ webdavRoot })
      await msg.edit({ text: htmlText(`✅ WebDAV 上传根目录已设置为 <code>${htmlEscape(webdavRoot)}</code>`) })
      return
    }
    throw new Error(`用法：${commandName} conf endpoint|token|account|path|dav-url|dav-user|dav-root|show`)
  }

  private async handleLogin(msg: MessageContext): Promise<void> {
    const config = await this.getConfig()
    if (!config.accountUsername || !config.accountPassword) throw new Error(`请先配置：${commandName} conf account USER PASSWORD`)
    await msg.edit({ text: '🔄 正在使用 CloudDrive 账户登录…' })
    const result = await this.getClient().unary('GetToken', { userName: config.accountUsername, password: config.accountPassword })
    if (!result.success || !result.token) throw new Error(result.errorMessage || 'CloudDrive 账户登录失败')
    await this.updateConfig({ token: result.token })
    const info = await this.getClient().unary('GetSystemInfo')
    await msg.edit({ text: htmlText(['✅ <b>CloudDrive 账户登录成功</b>', `<b>账号：</b> <code>${htmlEscape(config.accountUsername)}</code>`, `<b>服务就绪：</b> ${info.systemReady ? '是' : '否'}`].join('\n')) })
  }

  private async handleAccount(msg: MessageContext, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase() || 'status'
    if (action === 'status') {
      const result = await this.getClient().unary('GetAccountStatus')
      await msg.edit({ text: htmlText(['<b>👤 CloudDrive2 账户</b>', `<b>用户名：</b> <code>${htmlEscape(result.userName || '未知')}</code>`, `<b>邮箱确认：</b> ${htmlEscape(result.emailConfirmed || '未知')}`, `<b>余额：</b> ${htmlEscape(String(result.accountBalance ?? '未知'))}`].join('\n')) })
      return
    }
    if (action === 'logout') {
      await this.getClient().unary('Logout', { logoutFromCloudFS: true })
      await this.updateConfig({ token: '' })
      await msg.edit({ text: '✅ 已退出 CloudDrive2 并清除本地 Token' })
      return
    }
    if (action === 'register') {
      if (!args[1] || !args[2]) throw new Error(`用法：${commandName} account register USER PASSWORD`)
      const result = await this.getClient().unary('Register', { userName: args[1], password: args[2] })
      if (result.success === false) throw new Error(result.errorMessage || '账户注册失败')
      await msg.edit({ text: '✅ CloudDrive2 账户注册成功，请继续配置账户并登录' })
      return
    }
    if (action === 'reset-email') {
      if (!args[1]) throw new Error(`用法：${commandName} account reset-email EMAIL`)
      const result = await this.getClient().unary('SendResetAccountEmail', { email: args[1] })
      if (result.success === false) throw new Error(result.errorMessage || '重置邮件发送失败')
      await msg.edit({ text: '✅ 重置邮件已发送' })
      return
    }
    if (action === 'reset') {
      if (!args[1] || !args[2]) throw new Error(`用法：${commandName} account reset RESET_CODE NEW_PASSWORD`)
      const result = await this.getClient().unary('ResetAccount', { resetCode: args[1], newPassword: args[2] })
      if (result.success === false) throw new Error(result.errorMessage || '账户密码重置失败')
      await msg.edit({ text: '✅ 账户密码已重置' })
      return
    }
    throw new Error(`用法：${commandName} account status|logout|register|reset-email|reset`)
  }

  private async handleToken(msg: MessageContext, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase() || 'show'
    if (action === 'show') {
      const config = await this.getConfig()
      await msg.edit({ text: htmlText(`<b>🔑 Token</b> <code>${htmlEscape(maskToken(config.token))}</code>`) })
      return
    }
    if (action === 'clear') {
      await this.updateConfig({ token: '' })
      await msg.edit({ text: '✅ 本地 Token 已清除' })
      return
    }
    if (action === 'login') {
      await this.handleLogin(msg)
      return
    }
    throw new Error(`用法：${commandName} token show|clear|login`)
  }

  private async handleVerify(msg: MessageContext): Promise<void> {
    await msg.edit({ text: '🔄 正在连接 CloudDrive2…' })
    const info = await this.getClient().unary('GetSystemInfo')
    await msg.edit({
      text: htmlText(['✅ <b>CloudDrive2 连接成功</b>', `<b>登录：</b> ${info.isLogin ? '是' : '否'}`, `<b>账号：</b> <code>${htmlEscape(info.userName || '未登录')}</code>`, `<b>服务就绪：</b> ${info.systemReady ? '是' : '否'}`].join('\n'))
    })
  }

  private async handleStatus(msg: MessageContext): Promise<void> {
    const [system, runtime] = await Promise.all([this.getClient().unary('GetSystemInfo'), this.getClient().unary('GetRunningInfo')])
    await msg.edit({
      text: htmlText(
        [
          '<b>☁️ CloudDrive2 状态</b>',
          `<b>登录：</b> ${system.isLogin ? '✅' : '❌'}`,
          `<b>账号：</b> <code>${htmlEscape(system.userName || '未登录')}</code>`,
          `<b>服务就绪：</b> ${system.systemReady ? '✅' : '❌'}`,
          `<b>CPU：</b> ${Number(runtime.cpuUsage || 0).toFixed(1)}%`,
          `<b>内存：</b> ${formatBytes(Number(runtime.memUsageKB || 0) * 1024)}`,
          `<b>运行时间：</b> ${Math.floor(Number(runtime.uptime || 0) / 3600)} 小时`
        ].join('\n')
      )
    })
  }

  private async handleList(msg: MessageContext, inputPath?: string): Promise<void> {
    const config = await this.getConfig()
    const targetPath = normalizePath(inputPath || config.defaultPath)
    await msg.edit({ text: `🔄 正在读取 <code>${htmlEscape(targetPath)}</code>…` })
    const replies = await this.getClient().stream('GetSubFiles', { path: targetPath })
    const files = replies.flatMap((reply) => (reply.subFiles || []) as Cd2File[]).slice(0, MAX_ITEMS)
    if (!files.length) {
      await msg.edit({ text: htmlText(`📂 <code>${htmlEscape(targetPath)}</code>\n\n目录为空或没有权限`) })
      return
    }
    const lines = [`<b>📂 ${htmlEscape(targetPath)}</b>`, '', ...files.map(formatFile)]
    await msg.edit({ text: htmlText(lines.join('\n')) })
  }

  private async handleSearch(msg: MessageContext, args: string[]): Promise<void> {
    const keyword = args[0]?.trim()
    if (!keyword) throw new Error(`用法：${commandName} grep 关键词 [路径]`)
    const config = await this.getConfig()
    const targetPath = normalizePath(args[1] || config.defaultPath)
    await msg.edit({ text: '🔄 正在搜索 CloudDrive2…' })
    const replies = await this.getClient().stream('GetSearchResults', { path: targetPath, searchFor: keyword, fuzzyMatch: true })
    const files = replies.flatMap((reply) => (reply.subFiles || []) as Cd2File[]).slice(0, MAX_ITEMS)
    const lines = files.length ? files.map(formatFile) : ['没有找到匹配文件']
    const chunks = chunkText([`<b>🔎 搜索：${htmlEscape(keyword)}</b>`, `<b>路径：</b> <code>${htmlEscape(targetPath)}</code>`, '', ...lines])
    await msg.edit({ text: htmlText(chunks[0]) })
    for (const chunk of chunks.slice(1)) await msg.replyText(htmlText(chunk))
  }

  private async handleFind(msg: MessageContext, inputPath: string): Promise<void> {
    const targetPath = normalizePath(inputPath)
    const separator = targetPath.lastIndexOf('/')
    const parentPath = separator <= 0 ? '/' : targetPath.slice(0, separator)
    const name = targetPath.slice(separator + 1)
    const file = (await this.getClient().unary('FindFileByPath', { parentPath, path: name })) as Cd2File
    await msg.edit({
      text: htmlText(
        [
          '<b>🔎 文件信息</b>',
          `<b>名称：</b> <code>${htmlEscape(String(file.name || name))}</code>`,
          `<b>路径：</b> <code>${htmlEscape(String(file.fullPathName || targetPath))}</code>`,
          `<b>类型：</b> ${file.isDirectory ? '目录' : '文件'}`,
          `<b>大小：</b> ${formatBytes(file.size)}`,
          `<b>只读：</b> ${file.readOnly ? '是' : '否'}`
        ].join('\n')
      )
    })
  }

  private async handleSpace(msg: MessageContext, inputPath?: string): Promise<void> {
    const config = await this.getConfig()
    const targetPath = normalizePath(inputPath || config.defaultPath)
    const info = await this.getClient().unary('GetSpaceInfo', { path: targetPath })
    await msg.edit({ text: htmlText(['<b>💾 CloudDrive2 空间</b>', `<b>路径：</b> <code>${htmlEscape(targetPath)}</code>`, `<b>总空间：</b> ${formatBytes(info.totalSpace)}`, `<b>已使用：</b> ${formatBytes(info.usedSpace)}`, `<b>可用：</b> ${formatBytes(info.freeSpace)}`].join('\n')) })
  }

  private async handleTasks(msg: MessageContext): Promise<void> {
    const tasks = await this.getClient().unary('GetAllTasksCount')
    await msg.edit({ text: htmlText(['<b>🔄 CloudDrive2 任务</b>', `<b>下载：</b> ${tasks.downloadCount || 0}`, `<b>上传：</b> ${tasks.uploadCount || 0}`, `<b>云盘复制：</b> ${tasks.copyTaskCount || 0}`].join('\n')) })
  }

  private async handleClouds(msg: MessageContext): Promise<void> {
    const result = await this.getClient().unary('GetAllCloudApis')
    const clouds = (result.apis || []) as RpcResponse[]
    const lines = clouds.length
      ? clouds.map(
          (cloud, index) =>
            `${index + 1}. <b>${htmlEscape(cloud.name || '未知 API')}</b>\n   账户：<code>${htmlEscape(cloud.userName || cloud.nickName || '未知')}</code>\n   路径：<code>${htmlEscape(cloud.path || `/${cloud.name || ''}`)}</code>\n   状态：${cloud.isLocked ? '🔒 已锁定' : '✅ 可用'} · ${cloud.readOnly ? '只读' : '读写'} · 事件监听${cloud.eventListenerRunning ? '运行中' : '未运行'}\n   能力：${cloud.supportMultiThreadUploading ? '多线程上传' : '普通上传'}${cloud.supportQpsLimit ? ' · QPS 限制' : ''}`
        )
      : ['没有配置 Cloud API']
    await msg.edit({ text: htmlText(['<b>☁️ Cloud API 管理</b>', `<b>数量：</b> ${clouds.length}`, '', ...lines, '', `配置：<code>${commandName} api config get CLOUD USER</code>`, `删除：<code>${commandName} api remove CLOUD USER confirm</code>`].join('\n')) })
  }

  private async handleDownload(msg: MessageContext, inputPath: string): Promise<void> {
    const config = await this.getConfig()
    const targetPath = normalizePath(inputPath)
    const result = await this.getClient().unary('GetDownloadUrlPath', { path: targetPath, preview: false, lazyRead: true, getDirectUrl: true })
    const endpoint = new URL(config.endpoint)
    const directUrl = typeof result.directUrl === 'string' && !/[{}]/.test(result.directUrl) ? result.directUrl : ''
    const templateUrl = String(result.downloadUrlPath || '')
      .replaceAll('{SCHEME}', endpoint.protocol.replace(':', ''))
      .replaceAll('{HOST}', endpoint.host)
      .replaceAll('{PREVIEW}', 'false')
    const rawUrl = directUrl || templateUrl
    if (!rawUrl) throw new Error('CD2 没有返回下载地址')
    const url = new URL(rawUrl, endpoint).toString()
    const fallbackName = decodeURIComponent(targetPath.split('/').filter(Boolean).at(-1) || `clouddrive-${Date.now()}`)
    await msg.edit({ text: htmlText(`🔄 正在下载 <code>${htmlEscape(targetPath)}</code>…`) })
    const downloaded = await downloadHttpBuffer(url, result.userAgent)
    const client = await getGlobalClient()
    await client.editMessage({
      chatId: msg.chat.id,
      message: msg.id,
      media: { type: 'document', file: downloaded.body, fileName: fallbackName, fileMime: downloaded.contentType }
    })
  }

  private async handleMount(msg: MessageContext, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase() || 'list'
    if (action === 'can-add') {
      const result = await this.getClient().unary('CanAddMoreMountPoints')
      await msg.edit({ text: htmlText(`<b>挂载点配额：</b> ${result.success ? '✅ 可以添加' : `❌ ${htmlEscape(result.errorMessage || '不能添加')}`}`) })
      return
    }
    if (action === 'letters') {
      const result = await this.getClient().unary('GetAvailableDriveLetters', { includeCloudDrive: true })
      await msg.edit({ text: htmlText(`<b>可用盘符：</b> <code>${htmlEscape((result.driveLetters || []).join(', ') || '无')}</code>`) })
      return
    }
    if (action === 'list' || action === 'status') {
      const result = await this.getClient().unary('GetMountPoints')
      const mounts = (result.mountPoints || []) as RpcResponse[]
      const lines = mounts.length
        ? mounts.map((mount) => `• <code>${htmlEscape(mount.mountPoint || '/')}</code> ← <code>${htmlEscape(mount.sourceDir || '/')}</code> · ${mount.isMounted ? '已挂载' : '未挂载'} · ${mount.readOnly ? '只读' : '读写'}${mount.failReason ? ` · ${htmlEscape(mount.failReason)}` : ''}`)
        : ['没有配置挂载点']
      await msg.edit({ text: htmlText(['<b>📌 挂载点</b>', '', ...lines].join('\n')) })
      return
    }
    if (action === 'add') {
      if (!args[1] || !args[2]) throw new Error(`用法：${commandName} mount add /挂载点 /源目录 [readonly] [automount]`)
      const result = await this.getClient().unary('AddMountPoint', { mountPoint: normalizePath(args[1]), sourceDir: normalizePath(args[2]), localMount: false, readOnly: args[3]?.toLowerCase() === 'readonly', autoMount: args[4]?.toLowerCase() !== 'noauto' })
      if (result.success === false) throw new Error(result.failReason || '添加挂载点失败')
      await msg.edit({ text: '✅ 挂载点已添加' })
      return
    }
    if (action === 'remove' || action === 'mount' || action === 'unmount') {
      if (!args[1] || (action === 'remove' && args[2]?.toLowerCase() !== 'confirm')) throw new Error(`用法：${commandName} mount ${action} /挂载点${action === 'remove' ? ' confirm' : ''}`)
      const method = action === 'remove' ? 'RemoveMountPoint' : action === 'mount' ? 'Mount' : 'Unmount'
      const result = await this.getClient().unary(method, { mountPoint: normalizePath(args[1]) })
      if (result.success === false) throw new Error(result.failReason || `${action} 挂载点失败`)
      await msg.edit({ text: `✅ 挂载点已${action === 'remove' ? '删除' : action === 'mount' ? '挂载' : '卸载'}` })
      return
    }
    if (action === 'update') {
      if (!args[1] || !args[2]) throw new Error(`用法：${commandName} mount update /挂载点 /新源目录 [readonly] [automount]`)
      const result = await this.getClient().unary('UpdateMountPoint', {
        mountPoint: normalizePath(args[1]),
        newMountPoint: normalizePath(args[1]),
        newSourceDir: normalizePath(args[2]),
        newLocalMount: false,
        newReadOnly: args[3]?.toLowerCase() === 'readonly',
        newAutoMount: args[4]?.toLowerCase() !== 'noauto'
      })
      if (result.success === false) throw new Error(result.failReason || '更新挂载点失败')
      await msg.edit({ text: '✅ 挂载点已更新' })
      return
    }
    throw new Error(`用法：${commandName} mount list|can-add|add|update|mount|unmount|remove`)
  }

  private async handleTransfer(msg: MessageContext, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase() || 'status'
    if (action === 'status') {
      const tasks = await this.getClient().unary('GetAllTasksCount')
      const [downloads, uploads] = await Promise.all([this.getClient().unary('GetDownloadFileCount'), this.getClient().unary('GetUploadFileCount')])
      await msg.edit({ text: htmlText(['<b>🔄 传输任务</b>', `<b>下载：</b> ${tasks.downloadCount || 0}（详情 ${downloads.fileCount || 0}）`, `<b>上传：</b> ${tasks.uploadCount || 0}（详情 ${uploads.fileCount || 0}）`, `<b>云盘复制：</b> ${tasks.copyTaskCount || 0}`].join('\n')) })
      return
    }
    if (action === 'downloads') {
      const result = await this.getClient().unary('GetDownloadFileList')
      const files = (result.downloadFiles || []) as RpcResponse[]
      const lines = files.length ? files.map((file) => `• <code>${htmlEscape(file.filePath || '未知')}</code> · ${file.fileLength || 0} B · ${htmlEscape(file.detailDownloadInfo || '')}`) : ['没有下载任务']
      await msg.edit({ text: htmlText(['<b>⬇️ 下载任务</b>', '', ...lines].join('\n')) })
      return
    }
    if (action === 'uploads') {
      const page = Number(args[1] || 1)
      const result = await this.getClient().unary('GetUploadFileList', { getAll: true, itemsPerPage: MAX_ITEMS, pageNumber: Number.isFinite(page) && page > 0 ? page : 1 })
      const files = (result.uploadFiles || []) as RpcResponse[]
      const lines = files.length ? files.map((file) => `• <code>${htmlEscape(file.destPath || '未知')}</code> · ${file.transferedBytes || 0}/${file.size || 0} B · ${htmlEscape(file.status || '')}${file.errorMessage ? ` · ${htmlEscape(file.errorMessage)}` : ''}`) : ['没有上传任务']
      await msg.edit({ text: htmlText([`<b>⬆️ 上传任务（共 ${result.totalCount || 0}）</b>`, '', ...lines].join('\n')) })
      return
    }
    if (['cancel', 'pause', 'resume'].includes(action)) {
      const scope = args[1]?.toLowerCase()
      const verb = action === 'cancel' ? '取消' : action === 'pause' ? '暂停' : '恢复'
      if (scope === 'all') {
        await this.getClient().unary(`${action === 'cancel' ? 'Cancel' : action === 'pause' ? 'Pause' : 'Resume'}AllUploadFiles`)
      } else {
        const keys = args.slice(1).filter(Boolean)
        if (!keys.length) throw new Error(`用法：${commandName} transfer ${action} all|KEY...`)
        await this.getClient().unary(`${action === 'cancel' ? 'Cancel' : action === 'pause' ? 'Pause' : 'Resume'}UploadFiles`, { keys })
      }
      await msg.edit({ text: `✅ 上传任务已${verb}` })
      return
    }
    throw new Error(`用法：${commandName} transfer status|downloads|uploads [页码]|cancel|pause|resume all|KEY...`)
  }

  private async handleCloud(msg: MessageContext, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase() || 'list'
    if (action === 'list') {
      await this.handleClouds(msg)
      return
    }
    if (action === 'can-add') {
      const result = await this.getClient().unary('CanAddMoreCloudApis')
      await msg.edit({ text: htmlText(`<b>云 API 配额：</b> ${result.success ? '✅ 可以添加' : `❌ ${htmlEscape(result.errorMessage || '不能添加')}`}`) })
      return
    }
    if (action === 'add') {
      const type = args[1]?.toLowerCase()
      let method = ''
      let request: Record<string, unknown> = {}
      if (type === 'webdav') {
        if (!args[2] || !args[3] || !args[4]) throw new Error(`用法：${commandName} api add webdav URL USER PASSWORD`)
        method = 'APILoginWebDav'
        request = { serverUrl: args[2], userName: args[3], password: args[4] }
      } else if (type === 'local') {
        if (!args[2]) throw new Error(`用法：${commandName} api add local /本地目录`)
        method = 'APIAddLocalFolder'
        request = { localFolderPath: args[2] }
      } else if (type === 'pikpak') {
        if (!args[2] || !args[3]) throw new Error(`用法：${commandName} api add pikpak USER PASSWORD`)
        method = 'APILoginPikPak'
        request = { userName: args[2], password: args[3] }
      } else if (type === '115-cookie') {
        if (!args[2]) throw new Error(`用法：${commandName} api add 115-cookie COOKIE`)
        method = 'APILogin115Editthiscookie'
        request = { editThiscookieString: args[2] }
      } else if (type === '115-qrcode' || type === 'aliyun-qrcode' || type === '189-qrcode') {
        method = type === '115-qrcode' ? 'APILogin115QRCode' : type === 'aliyun-qrcode' ? 'APILoginAliyunDriveQRCode' : 'APILogin189QRCode'
        request = type === '115-qrcode' ? { platformString: args[2] } : { useOpenAPI: args[2]?.toLowerCase() === 'openapi' }
        const messages = await this.getClient().stream(method, request)
        const lines = messages.map((item) => `<b>${htmlEscape(String(item.messageType || '状态'))}</b> ${htmlEscape(item.message || '')}`)
        await msg.edit({ text: htmlText([`<b>🔐 ${htmlEscape(type)} 登录</b>`, '', ...lines].join('\n')) })
        return
      } else if (type === 'aliyun-oauth' || type === 'baidu-oauth' || type === 'onedrive-oauth' || type === 'google-oauth' || type === 'xunlei-oauth') {
        if (!args[2] || !args[3] || !args[4]) throw new Error(`用法：${commandName} api add ${type} REFRESH_TOKEN ACCESS_TOKEN EXPIRES_IN`)
        method = { 'aliyun-oauth': 'APILoginAliyundriveOAuth', 'baidu-oauth': 'APILoginBaiduPanOAuth', 'onedrive-oauth': 'APILoginOneDriveOAuth', 'google-oauth': 'ApiLoginGoogleDriveOAuth', 'xunlei-oauth': 'APILoginXunleiOAuth' }[type]
        request = { refresh_token: args[2], access_token: args[3], expires_in: Number(args[4]) }
      } else if (type === 'aliyun-refresh') {
        if (!args[2]) throw new Error(`用法：${commandName} api add aliyun-refresh REFRESH_TOKEN [openapi]`)
        method = 'APILoginAliyundriveRefreshtoken'
        request = { refreshToken: args[2], useOpenAPI: args[3]?.toLowerCase() === 'openapi' }
      } else if (type === 'google-refresh') {
        if (!args[2] || !args[3] || !args[4]) throw new Error(`用法：${commandName} api add google-refresh CLIENT_ID CLIENT_SECRET REFRESH_TOKEN`)
        method = 'ApiLoginGoogleDriveRefreshToken'
        request = { client_id: args[2], client_secret: args[3], refresh_token: args[4] }
      } else {
        throw new Error(`支持：webdav|local|pikpak|115-cookie|aliyun-oauth|aliyun-refresh|baidu-oauth|onedrive-oauth|google-oauth|google-refresh|xunlei-oauth`)
      }
      const result = await this.getClient().unary(method, request)
      if (result.success === false) throw new Error(result.errorMessage || '添加云 API 失败')
      await msg.edit({ text: `✅ 云 API 已添加（${htmlEscape(type || method)}）` })
      return
    }
    if (action === 'remove') {
      if (!args[1] || !args[2] || args[3]?.toLowerCase() !== 'confirm') throw new Error(`用法：${commandName} api remove CLOUD_NAME USER confirm`)
      const result = await this.getClient().unary('RemoveCloudAPI', { cloudName: args[1], userName: args[2], permanentRemove: false })
      if (result.success === false) throw new Error(result.errorMessage || '删除云 API 失败')
      await msg.edit({ text: '✅ 云 API 已删除' })
      return
    }
    if (action === 'config') {
      if (!args[1] || !args[2]) throw new Error(`用法：${commandName} api config get|set CLOUD_NAME USER [KEY VALUE]`)
      const mode = args[1].toLowerCase()
      if (mode === 'get') {
        const result = await this.getClient().unary('GetCloudAPIConfig', { cloudName: args[2], userName: args[3] })
        await msg.edit({ text: htmlText(['<b>⚙️ 云 API 配置</b>', ...Object.entries(result).map(([key, value]) => `<b>${htmlEscape(key)}：</b> <code>${htmlEscape(String(value))}</code>`)].join('\n')) })
        return
      }
      if (mode !== 'set' || !args[3] || !args[4] || !args[5]) throw new Error(`用法：${commandName} api config set CLOUD_NAME USER KEY VALUE`)
      const key = args[4]
      const raw = args.slice(5).join(' ')
      const value = raw === 'true' ? true : raw === 'false' ? false : Number.isNaN(Number(raw)) ? raw : Number(raw)
      const result = await this.getClient().unary('SetCloudAPIConfig', { cloudName: args[2], userName: args[3], [key]: value })
      if (result.success === false) throw new Error(result.errorMessage || '云 API 配置失败')
      await msg.edit({ text: '✅ 云 API 配置已更新' })
      return
    }
    throw new Error(`用法：${commandName} api list|can-add|add|remove|config`)
  }

  private async handleBackup(msg: MessageContext, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase() || 'list'
    if (action === 'can-add') {
      const result = await this.getClient().unary('CanAddMoreBackups')
      await msg.edit({ text: htmlText(`<b>备份配额：</b> ${result.success ? '✅ 可以添加' : `❌ ${htmlEscape(result.errorMessage || '不能添加')}`}`) })
      return
    }
    if (action === 'list') {
      const result = await this.getClient().unary('BackupGetAll')
      const backups = (result.backups || []) as RpcResponse[]
      const lines = backups.length
        ? backups.map((item) => {
            const backup = item.backup || {}
            const destinations = (backup.destinations || []).map((destination: RpcResponse) => destination.destinationPath).join(', ')
            return `• <code>${htmlEscape(backup.sourcePath || '未知')}</code> → ${htmlEscape(destinations || '未设置目标')} · ${backup.isEnabled ? '启用' : '停用'} · ${htmlEscape(item.statusMessage || '')}`
          })
        : ['没有配置备份']
      await msg.edit({ text: htmlText(['<b>💾 备份管理</b>', '', ...lines].join('\n')) })
      return
    }
    if (action === 'add' || action === 'update') {
      if (!args[1] || !args[2]) throw new Error(`用法：${commandName} backup ${action} /源目录 /目标目录`)
      const result = await this.getClient().unary(action === 'add' ? 'BackupAdd' : 'BackupUpdate', { sourcePath: normalizePath(args[1]), destinationPath: normalizePath(args[2]), isEnabled: true, fileSystemWatchEnabled: false })
      if (result.success === false) throw new Error(result.errorMessage || `备份${action === 'add' ? '添加' : '更新'}失败`)
      await msg.edit({ text: `✅ 备份已${action === 'add' ? '添加' : '更新'}` })
      return
    }
    if (action === 'remove') {
      if (!args[1] || args[2]?.toLowerCase() !== 'confirm') throw new Error(`用法：${commandName} backup remove /源目录 confirm`)
      await this.getClient().unary('BackupRemove', { value: normalizePath(args[1]) })
      await msg.edit({ text: '✅ 备份已删除' })
      return
    }
    if (action === 'enable' || action === 'watch') {
      if (!args[1] || !['on', 'off'].includes(args[2]?.toLowerCase() || '')) throw new Error(`用法：${commandName} backup ${action} /源目录 on|off`)
      const enabled = args[2].toLowerCase() === 'on'
      const method = action === 'enable' ? 'BackupSetEnabled' : 'BackupSetFileSystemWatchEnabled'
      const result = await this.getClient().unary(method, action === 'enable' ? { sourcePath: normalizePath(args[1]), isEnabled: enabled } : { sourcePath: normalizePath(args[1]), fileSystemWatchEnabled: enabled })
      if (result.success === false) throw new Error(result.errorMessage || '备份设置失败')
      await msg.edit({ text: `✅ 备份${action === 'enable' ? '任务' : '文件监听'}已${enabled ? '启用' : '关闭'}` })
      return
    }
    if (action === 'destination') {
      if (!args[1] || !args[2] || !args[3]) throw new Error(`用法：${commandName} backup destination add|remove /源目录 /目标目录`)
      const mode = args[1].toLowerCase()
      if (mode !== 'add' && mode !== 'remove') throw new Error(`用法：${commandName} backup destination add|remove /源目录 /目标目录`)
      await this.getClient().unary(mode === 'add' ? 'BackupAddDestination' : 'BackupRemoveDestination', { sourcePath: normalizePath(args[2]), destinationPath: normalizePath(args[3]), destinationEnabled: mode === 'add' })
      await msg.edit({ text: `✅ 备份目标已${mode === 'add' ? '添加' : '删除'}` })
      return
    }
    if (action === 'restart') {
      if (!args[1]) throw new Error(`用法：${commandName} backup restart /源目录`)
      await this.getClient().unary('BackupRestartWalkingThrough', { value: normalizePath(args[1]) })
      await msg.edit({ text: '✅ 备份扫描已重新开始' })
      return
    }
    throw new Error(`用法：${commandName} backup list|can-add|add|update|remove|enable|watch|destination|restart`)
  }

  private async handleRemote(msg: MessageContext, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase() || 'list'
    if (action === 'add') {
      if (!args[1]) throw new Error(`用法：${commandName} remote add URL [目标目录]`)
      const result = await this.getClient().unary('AddOfflineFiles', { urls: args[1], toFolder: normalizePath(args[2] || '/') })
      if (result.success === false) throw new Error(result.errorMessage || '远程上传任务提交失败')
      await msg.edit({ text: htmlText(['✅ <b>远程上传任务已提交</b>', ...(result.resultFilePaths || []).map((item: string) => `<code>${htmlEscape(item)}</code>`)].join('\n')) })
      return
    }
    if (action === 'list') {
      const result = await this.getClient().unary('ListOfflineFilesByPath', { path: normalizePath(args[1] || '/') })
      const files = (result.offlineFiles || []) as RpcResponse[]
      const lines = files.length ? files.map((file) => `• <code>${htmlEscape(file.name || '未知')}</code> · ${htmlEscape(file.infoHash || '')} · ${file.percentDone || 0}%`) : ['没有远程上传任务']
      await msg.edit({ text: htmlText(['<b>🌐 远程上传任务</b>', '', ...lines].join('\n')) })
      return
    }
    if (action === 'list-all') {
      const result = await this.getClient().unary('ListAllOfflineFiles', { cloudName: args[1] || '', cloudAccountId: args[2] || '', page: Number(args[3] || 1) })
      const files = (result.offlineFiles || []) as RpcResponse[]
      const lines = files.length ? files.map((file) => `• <code>${htmlEscape(file.name || '未知')}</code> · ${htmlEscape(file.infoHash || '')} · ${file.percentDone || 0}%`) : ['没有远程上传任务']
      await msg.edit({ text: htmlText([`<b>🌐 远程上传任务（第 ${result.pageNo || 1}/${result.pageCount || 1} 页）</b>`, '', ...lines].join('\n')) })
      return
    }
    if (action === 'remove') {
      if (!args[1] || !args[2] || args[3]?.toLowerCase() !== 'confirm') throw new Error(`用法：${commandName} remote remove CLOUD_NAME CLOUD_ACCOUNT_ID confirm [HASH...]`)
      const hashes = args.slice(4)
      if (!hashes.length) throw new Error('至少需要一个 infoHash')
      await this.getClient().unary('RemoveOfflineFiles', { cloudName: args[1], cloudAccountId: args[2], deleteFiles: false, infoHashes: hashes })
      await msg.edit({ text: '✅ 远程上传任务已删除' })
      return
    }
    throw new Error(`用法：${commandName} remote add|list|list-all|remove`)
  }

  private async handleDav(msg: MessageContext, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase()
    const config = await this.getConfig()
    if (action === 'status') {
      const info = await this.getClient().unary('GetDavServerConfig')
      const users = (info.users || []) as Array<{ userName?: string; rootPath?: string; readOnly?: boolean; enabled?: boolean; guest?: boolean }>
      const accountLines = info.enableClouddriveAccount ? [`• <code>${htmlEscape(config.accountUsername || 'CloudDrive 账户')}</code> · ${htmlEscape(info.clouddriveAccountRootPath || '/')} · ${info.clouddriveAccountReadOnly ? '只读' : '读写'} · CloudDrive 账户`] : ['未启用']
      const userLines = users.length ? users.map((user) => `• <code>${htmlEscape(user.userName || '未知')}</code> · ${htmlEscape(user.rootPath || '/')} · ${user.readOnly ? '只读' : '读写'} · ${user.enabled === false ? '停用' : '启用'}`) : ['没有配置独立 WebDAV 用户']
      await msg.edit({
        text: htmlText(
          [
            '<b>🌐 CloudDrive2 WebDAV</b>',
            `<b>服务：</b> ${info.davServerEnabled ? '✅ 已启用' : '❌ 未启用'}`,
            `<b>CloudDrive 账户：</b> ${info.enableClouddriveAccount ? '✅ 已启用' : '❌ 未启用'}`,
            `<b>地址：</b> <code>${htmlEscape(config.webdavUrl || '未设置')}</code>`,
            `<b>路径：</b> <code>${htmlEscape(info.davServerPath || '/dav')}</code>`,
            '',
            '<b>账户模式</b>',
            ...accountLines,
            '',
            '<b>独立 WebDAV 用户</b>',
            ...userLines
          ].join('\n')
        )
      })
      return
    }
    if (action === 'on' || action === 'off') {
      await this.getClient().unary('SetDavServerConfig', {
        enableDavServer: action === 'on',
        enableClouddriveAccount: action === 'on' && Boolean(config.accountUsername && config.accountPassword),
        clouddriveAccountRootPath: config.webdavRoot,
        clouddriveAccountReadOnly: false
      })
      await msg.edit({ text: `✅ WebDAV 服务已${action === 'on' ? '启用' : '关闭'}${action === 'on' && config.accountUsername && config.accountPassword ? '，CloudDrive 账户访问已启用' : ''}` })
      return
    }
    if (action === 'account') {
      const accountAction = args[1]?.toLowerCase()
      if (accountAction !== 'on' && accountAction !== 'off') throw new Error(`用法：${commandName} dav account on|off [/根目录]`)
      if (accountAction === 'on' && (!config.accountUsername || !config.accountPassword)) throw new Error(`请先配置 CloudDrive 账户：${commandName} conf account USER PASSWORD`)
      const rootPath = args[2] ? normalizePath(args[2]) : config.webdavRoot
      const serverEnabled = accountAction === 'on' ? true : Boolean((await this.getClient().unary('GetDavServerConfig')).davServerEnabled)
      await this.getClient().unary('SetDavServerConfig', {
        enableDavServer: serverEnabled,
        enableClouddriveAccount: accountAction === 'on',
        clouddriveAccountRootPath: rootPath,
        clouddriveAccountReadOnly: false
      })
      await msg.edit({ text: `✅ CloudDrive 账户 WebDAV 访问已${accountAction === 'on' ? '启用' : '关闭'}` })
      return
    }
    if (action === 'ls' || action === 'list') {
      const targetPath = normalizePath(args[1] || '/')
      const response = await davRequest(config, 'PROPFIND', targetPath, Buffer.from('<?xml version="1.0"?><propfind xmlns="DAV:"><allprop/></propfind>'), { Depth: '1', 'Content-Type': 'application/xml' })
      const allEntries = parseDavEntries(response.body)
      const requestedPathname = davPathUrl(config.webdavUrl, targetPath).pathname.replace(/\/+$/, '')
      const entries = allEntries
        .filter((entry) => {
          try {
            return new URL(entry.href, config.webdavUrl).pathname.replace(/\/+$/, '') !== requestedPathname
          } catch {
            return true
          }
        })
        .slice(0, MAX_ITEMS)
      const lines = entries.length
        ? entries.map((entry) => `${entry.directory ? '📁' : '📄'} <code>${htmlEscape(entry.name)}</code>${entry.directory ? '' : ` · ${formatBytes(Number(entry.size))}`}`)
        : allEntries.length
          ? ['目录为空']
          : [`未解析到 WebDAV 条目（HTTP ${response.status}，响应 ${response.body.length} 字节）`]
      await msg.edit({ text: htmlText([`<b>🌐 WebDAV ${htmlEscape(targetPath)}</b>`, '', ...lines].join('\n')) })
      return
    }
    if (action === 'mkdir') {
      if (!args[1]) throw new Error(`用法：${commandName} dav mkdir /路径`)
      await davRequest(config, 'MKCOL', normalizePath(args[1]))
      await msg.edit({ text: '✅ WebDAV 目录已创建' })
      return
    }
    if (action === 'rm') {
      if (!args[1] || args[2]?.toLowerCase() !== 'confirm') throw new Error(`删除是破坏性操作，请使用：${commandName} dav rm /路径 confirm`)
      await davRequest(config, 'DELETE', normalizePath(args[1]))
      await msg.edit({ text: '✅ WebDAV 路径已删除' })
      return
    }
    if (action === 'add') {
      if (!args[1] || !args[2]) throw new Error(`用法：${commandName} dav add USER PASSWORD [/根目录]`)
      await this.getClient().unary('AddDavUser', { userName: args[1], password: args[2], rootPath: args[3] ? normalizePath(args[3]) : '/', readOnly: false, enabled: true, guest: false })
      await msg.edit({ text: `✅ WebDAV 用户 <code>${htmlEscape(args[1])}</code> 已添加` })
      return
    }
    if (action === 'remove') {
      if (!args[1] || args[2]?.toLowerCase() !== 'confirm') throw new Error(`用法：${commandName} dav remove USER confirm`)
      await this.getClient().unary('RemoveDavUser', { value: args[1] })
      await msg.edit({ text: `✅ WebDAV 用户 <code>${htmlEscape(args[1])}</code> 已删除` })
      return
    }
    throw new Error(`用法：${commandName} dav status|on|off|account|ls|mkdir|rm|add|remove`)
  }

  private async handleUpload(msg: MessageContext, args: string[]): Promise<void> {
    const config = await this.getConfig()
    const replied = await safeGetReplyMessage(msg)
    const media = replied?.media as { type?: string; fileName?: string; mimeType?: string } | undefined
    const supportedTypes = new Set(['photo', 'document', 'video', 'audio', 'voice', 'sticker'])
    if (!replied || !media || !supportedTypes.has(media.type || '')) {
      throw new Error(`请回复 Telegram 图片、视频或文件后使用 ${commandName} up [目标目录]`)
    }
    const telegram = (await getGlobalClient()) as { downloadAsBuffer: (media: unknown) => Promise<Buffer> }
    await msg.edit({ text: '🔄 正在下载 Telegram 文件…' })
    const data = Buffer.from(await telegram.downloadAsBuffer(media))
    if (data.length > 128 * 1024 * 1024) throw new Error('单个上传文件不能超过 128 MiB')
    const fileName = media.fileName || `telegram-${replied.id || Date.now()}.${getMediaExtension(media)}`
    const requestedPath = args[0] ? normalizePath(args[0]) : normalizePath(config.webdavRoot)
    const remotePath = `${requestedPath === '/' ? '' : requestedPath}/${fileName}`
    await msg.edit({ text: `🔄 正在上传 <code>${htmlEscape(remotePath)}</code>（${formatBytes(data.length)}）…` })
    await davRequest(config, 'PUT', remotePath, data, { 'Content-Type': media.mimeType || 'application/octet-stream' })
    await msg.edit({ text: htmlText(`✅ 已上传到 WebDAV：<code>${htmlEscape(remotePath)}</code>`) })
  }

  private async handleMutation(msg: MessageContext, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase()
    if (action === 'mkdir') {
      if (!args[1] || !args[2]) throw new Error(`用法：${commandName} mkdir /父目录 文件夹名`)
      const result = await this.getClient().unary('CreateFolder', { parentPath: normalizePath(args[1]), folderName: args.slice(2).join(' ') })
      if (result.result && result.result.success === false) throw new Error(result.result.errorMessage || '创建文件夹失败')
      await msg.edit({ text: '✅ 文件夹已创建' })
      return
    }
    if (action === 'rm') {
      if (args.length < 3 || args.at(-1)?.toLowerCase() !== 'confirm') throw new Error(`删除是破坏性操作，请使用：${commandName} rm /路径 confirm`)
      const targetPath = args.slice(1, -1).join(' ')
      const result = await this.getClient().unary('DeleteFile', { path: normalizePath(targetPath) })
      if (result.success === false) throw new Error(result.errorMessage || '删除失败')
      await msg.edit({ text: '✅ 已删除' })
      return
    }
    if (action === 'mv' || action === 'cp') {
      if (!args[1] || !args[2]) throw new Error(`用法：${commandName} ${action} /源路径 /目标目录`)
      const method = action === 'mv' ? 'MoveFile' : 'CopyFile'
      const result = await this.getClient().unary(method, { theFilePaths: [normalizePath(args[1])], destPath: normalizePath(args[2]), conflictPolicy: 'Rename' })
      if (result.success === false) throw new Error(result.errorMessage || `${action} 失败`)
      await msg.edit({ text: `✅ ${action === 'mv' ? '移动' : '复制'}任务已提交` })
      return
    }
    if (action === 'rename') {
      if (!args[1] || !args[2]) throw new Error(`用法：${commandName} rename /文件 新名称`)
      const targetPath = normalizePath(args[1])
      const result = await this.getClient().unary('RenameFile', { theFilePath: targetPath, newName: args.slice(2).join(' ') })
      if (result.success === false) throw new Error(result.errorMessage || '重命名失败')
      await msg.edit({ text: '✅ 文件已重命名' })
      return
    }
    throw new Error(`未知文件操作，使用 ${commandName} h 查看帮助`)
  }

  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    cd2: async (msg: MessageContext) => {
      try {
        const args = tokenize(msg.text).slice(1)
        const subcommand = args[0]?.toLowerCase()
        if (!subcommand || subcommand === 'h') {
          await msg.edit({ text: htmlText(helpText), disableWebPreview: true })
        } else if (subcommand === 'conf') {
          await this.handleConfig(msg, args.slice(1))
        } else if (subcommand === 'login') {
          await this.handleLogin(msg)
        } else if (subcommand === 'token') {
          await this.handleToken(msg, args.slice(1))
        } else if (subcommand === 'account') {
          await this.handleAccount(msg, args.slice(1))
        } else if (subcommand === 'check') {
          await this.handleVerify(msg)
        } else if (subcommand === 'status') {
          await this.handleStatus(msg)
        } else if (subcommand === 'ls') {
          await this.handleList(msg, args.slice(1).join(' ') || undefined)
        } else if (subcommand === 'find') {
          if (!args[1]) throw new Error(`用法：${commandName} find /路径/文件`)
          await this.handleFind(msg, args.slice(1).join(' '))
        } else if (subcommand === 'grep') {
          await this.handleSearch(msg, args.slice(1))
        } else if (subcommand === 'df') {
          await this.handleSpace(msg, args.slice(1).join(' ') || undefined)
        } else if (subcommand === 'tasks') {
          await this.handleTasks(msg)
        } else if (subcommand === 'transfer') {
          await this.handleTransfer(msg, args.slice(1))
        } else if (subcommand === 'mount') {
          await this.handleMount(msg, args.slice(1))
        } else if (subcommand === 'api') {
          await this.handleCloud(msg, args.slice(1))
        } else if (subcommand === 'backup') {
          await this.handleBackup(msg, args.slice(1))
        } else if (subcommand === 'remote') {
          await this.handleRemote(msg, args.slice(1))
        } else if (subcommand === 'dl') {
          if (!args[1]) throw new Error(`用法：${commandName} dl /路径/文件`)
          await this.handleDownload(msg, args.slice(1).join(' '))
        } else if (subcommand === 'dav') {
          await this.handleDav(msg, args.slice(1))
        } else if (subcommand === 'up') {
          await this.handleUpload(msg, args.slice(1))
        } else if (['mkdir', 'rm', 'mv', 'cp', 'rename'].includes(subcommand)) {
          await this.handleMutation(msg, args)
        } else {
          throw new Error(`未知命令，使用 ${commandName} h 查看帮助`)
        }
      } catch (error) {
        await msg.edit({ text: htmlText(`❌ ${htmlEscape(errorMessage(error))}`), disableWebPreview: true })
      }
    }
  }
}

export default new Cd2Plugin()
