import { createHash, randomUUID } from 'node:crypto'
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
<b>☁️ CloudDrive2 管理</b>

<b>账户与安全</b>
• <code>${commandName} account status|logout|reset-email|reset|delete-email|delete</code>
• <code>${commandName} login</code> · <code>${commandName} 2fa status|setup|enable|disable|recovery|regenerate|login</code>
• <code>${commandName} session list|revoke|revoke-others</code>
• <code>${commandName} token show|list|info|create|modify|remove</code>

<b>文件</b>
• <code>${commandName} ls|find|grep|mkdir|rename|mv|cp|rm|df</code>
• <code>${commandName} file detail|meta|original /路径</code>
• <code>${commandName} dl /路径/文件</code> 下载到 Telegram
• 回复文件：<code>${commandName} up [目标目录]</code> WebDAV 上传

<b>传输任务</b>
• <code>${commandName} transfer status|downloads|uploads|copies|merges</code>
• <code>${commandName} transfer pause|resume|cancel all|KEY...</code>
• <code>${commandName} transfer copy pause|resume|remove TASK_KEY...</code>
• <code>${commandName} transfer copy pause-all|resume-all|remove-completed|remove-all</code>
• <code>${commandName} transfer copy cancel|restart SOURCE DEST</code>
• <code>${commandName} transfer merge cancel SOURCE DEST</code>

<b>Cloud API</b>
• <code>${commandName} api list|can-add|discover-smb|discover-smb-shares|remove|config</code>
• <code>${commandName} api add webdav|local|pikpak|s3|sftp|ftp|smb|clouddrive ...</code>
• <code>${commandName} api add 115-open|115-open-qrcode|123-oauth|guangya-oauth|guangya-qrcode ...</code>
• 也支持 115、阿里、百度、OneDrive、Google、迅雷 OAuth/二维码登录

<b>备份</b>
• <code>${commandName} backup list|status|add|update|remove|enable|watch|destination|restart</code>
• <code>${commandName} backup strategy /源 替换 删除 完成 间隔 [sync-delete]</code>
• <code>${commandName} backup schedule add|clear /源 [时间] [星期]</code>
• <code>${commandName} backup rule add|clear /源 ...</code>

<b>远程上传与离线任务</b>
• <code>${commandName} remote add|list|list-all|remove</code>
• 回复文件：<code>${commandName} remote upload /目标目录</code> 官方流式协议
• <code>${commandName} remote control pause|resume|cancel UPLOAD_ID</code>
• <code>${commandName} remote quota|clear|restart ...</code>

<b>系统</b>
• <code>${commandName} system runtime|settings|set|set-log|set-backup-limits|table|capabilities</code>
• <code>${commandName} system cache stats|list|purge|eviction|folder</code>
• <code>${commandName} system dir-cache set|effective|expire|vacuum|size</code>
• <code>${commandName} system service restart|shutdown|update confirm</code>
• <code>${commandName} system web get|set|self-cert</code>

<b>其他</b>
• <code>${commandName} mount list|add|update|mount|unmount|remove</code>
• <code>${commandName} dav status|on|off|account|ls|mkdir|rm|add|remove</code>
• <code>${commandName} status</code> · <code>${commandName} check</code>
• <code>${commandName} conf endpoint|token|account|path|dav-url|dav-user|dav-root|show</code>

敏感参数只发送给已配置的 CloudDrive2 服务；列表显示时会脱敏。`

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

const parseProxySetting = (value: string): Record<string, unknown> => {
  const normalized = value.toLowerCase()
  if (normalized === 'system') return { proxyType: 0 }
  if (normalized === 'none' || normalized === 'off') return { proxyType: 1 }
  const url = new URL(value)
  const proxyType = url.protocol === 'http:' || url.protocol === 'https:' ? 2 : url.protocol === 'socks5:' ? 3 : -1
  if (proxyType < 0) throw new Error('代理只支持 system|none|http://|https://|socks5://')
  return { proxyType, host: url.hostname, port: Number(url.port || (proxyType === 2 ? 8080 : 1080)), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }
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

const encodePresentField = (number: number, value: string | number | bigint | boolean): Buffer => {
  if (typeof value === 'boolean') return Buffer.concat([encodeVarint(number << 3), encodeVarint(value ? 1 : 0)])
  if (typeof value === 'number' || typeof value === 'bigint') return Buffer.concat([encodeVarint(number << 3), encodeVarint(value)])
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

const TOKEN_PERMISSION_FIELDS = [
  'allowList',
  'allowSearch',
  'allowListLocal',
  'allowCreateFolder',
  'allowCreateFile',
  'allowWrite',
  'allowRead',
  'allowRename',
  'allowMove',
  'allowCopy',
  'allowDelete',
  'allowDeletePermanently',
  'allowCreateEncrypt',
  'allowUnlockEncrypted',
  'allowLockEncrypted',
  'allowAddOfflineDownload',
  'allowListOfflineDownloads',
  'allowModifyOfflineDownloads',
  'allowSharedLinks',
  'allowViewProperties',
  'allowGetSpaceInfo',
  'allowViewRuntimeInfo',
  'allowGetMemberships',
  'allowModifyMemberships',
  'allowGetMounts',
  'allowModifyMounts',
  'allowGetTransferTasks',
  'allowModifyTransferTasks',
  'allowGetCloudApis',
  'allowModifyCloudApis',
  'allowGetSystemSettings',
  'allowModifySystemSettings',
  'allowGetBackups',
  'allowModifyBackups',
  'allowGetDavConfig',
  'allowModifyDavConfig',
  'allowTokenManagement',
  'allowGetAccountInfo',
  'allowModifyAccount',
  'allowServiceControl',
  'allowPushMessage'
] as const

const READ_TOKEN_PERMISSIONS = new Set([
  'allowList',
  'allowSearch',
  'allowListLocal',
  'allowRead',
  'allowListOfflineDownloads',
  'allowViewProperties',
  'allowGetSpaceInfo',
  'allowViewRuntimeInfo',
  'allowGetMemberships',
  'allowGetMounts',
  'allowGetTransferTasks',
  'allowGetCloudApis',
  'allowGetSystemSettings',
  'allowGetBackups',
  'allowGetDavConfig',
  'allowGetAccountInfo'
])

const tokenPermissions = (profile: string): Record<string, boolean> => {
  const normalized = profile.toLowerCase()
  if (!['read', 'write', 'full'].includes(normalized)) throw new Error('Token 权限预设只支持 read|write|full')
  return Object.fromEntries(TOKEN_PERMISSION_FIELDS.map((name) => [name, normalized === 'full' || normalized === 'write' || READ_TOKEN_PERMISSIONS.has(name)]))
}

const encodeTokenPermissions = (permissions: Record<string, unknown>): Buffer => Buffer.concat(TOKEN_PERMISSION_FIELDS.map((name, index) => encodePresentField(index + 1, Boolean(permissions[name]))))

const encodeProxyInfo = (proxy: Record<string, unknown>): Buffer =>
  Buffer.concat([
    encodePresentField(1, Number(proxy.proxyType || 0)),
    proxy.host ? encodeField(2, String(proxy.host)) : Buffer.alloc(0),
    proxy.port !== undefined ? encodePresentField(3, Number(proxy.port)) : Buffer.alloc(0),
    proxy.username ? encodeField(4, String(proxy.username)) : Buffer.alloc(0),
    proxy.password ? encodeField(5, String(proxy.password)) : Buffer.alloc(0)
  ])

const encodeFileBackupRule = (rule: Record<string, unknown>): Buffer => {
  const kind = String(rule.kind || 'extensions')
  const field = { extensions: 1, fileNames: 2, regex: 3, minSize: 4 }[kind]
  if (!field) throw new Error(`未知备份规则类型：${kind}`)
  return Buffer.concat([
    typeof rule.value === 'number' ? encodePresentField(field, rule.value) : encodePresentField(field, String(rule.value || '')),
    encodePresentField(100, rule.isEnabled !== false),
    encodePresentField(101, Boolean(rule.isBlackList)),
    encodePresentField(102, Boolean(rule.applyToFolder)),
    encodePresentField(103, rule.applyToFile !== false)
  ])
}

const encodeTimeSchedule = (schedule: Record<string, unknown>): Buffer => {
  const days = Array.isArray(schedule.daysOfWeek) ? Buffer.concat(schedule.daysOfWeek.map((day) => encodePresentField(1, Number(day)))) : Buffer.alloc(0)
  return Buffer.concat([encodePresentField(1, schedule.isEnabled !== false), encodePresentField(2, Number(schedule.hour || 0)), encodePresentField(3, Number(schedule.minute || 0)), encodePresentField(4, Number(schedule.second || 0)), days.length ? encodeBytesField(5, days) : Buffer.alloc(0)])
}

const SYSTEM_SETTING_FIELDS: Record<string, [number, 'string' | 'uint' | 'double' | 'bool' | 'list' | 'proxy']> = {
  dirCacheTimeToLiveSecs: [1, 'uint'],
  maxPreProcessTasks: [2, 'uint'],
  maxProcessTasks: [3, 'uint'],
  tempFileLocation: [4, 'string'],
  syncWithCloud: [5, 'bool'],
  readDownloaderTimeoutSecs: [6, 'uint'],
  uploadDelaySecs: [7, 'uint'],
  processBlackList: [8, 'list'],
  uploadIgnoredExtensions: [9, 'list'],
  updateChannel: [10, 'uint'],
  maxDownloadSpeedKBytesPerSecond: [11, 'double'],
  maxUploadSpeedKBytesPerSecond: [12, 'double'],
  deviceName: [13, 'string'],
  dirCachePersistence: [14, 'bool'],
  dirCacheDbLocation: [15, 'string'],
  fileLogLevel: [16, 'uint'],
  terminalLogLevel: [17, 'uint'],
  backupLogLevel: [18, 'uint'],
  enableAutoRegisterDevice: [19, 'bool'],
  realtimeLogLevel: [20, 'uint'],
  operatorPriorityOrder: [21, 'list'],
  updateProxy: [22, 'proxy'],
  startDelaySecs: [23, 'uint'],
  fileBufferDiskCacheLocation: [24, 'string'],
  fileBufferDiskCacheMaxBytes: [25, 'uint'],
  cloudfsProxy: [26, 'proxy'],
  maxFileLogSizeBytes: [27, 'uint'],
  maxBackupLogSizeBytes: [28, 'uint'],
  maxFileLogFiles: [29, 'uint'],
  maxBackupLogFiles: [30, 'uint'],
  backupQueueHighWater: [31, 'uint'],
  backupQueueLowWater: [32, 'uint'],
  maxConcurrentBackupWalkers: [33, 'uint'],
  useTempFileForCrossCloudCopy: [34, 'bool']
}

const encodeDoubleField = (number: number, value: number): Buffer => {
  const bytes = Buffer.allocUnsafe(8)
  bytes.writeDoubleLE(value)
  return Buffer.concat([encodeVarint((number << 3) | 1), bytes])
}

const encodeSystemSettings = (request: Record<string, unknown>): Buffer => {
  const fields: Buffer[] = []
  for (const [key, value] of Object.entries(request)) {
    const spec = SYSTEM_SETTING_FIELDS[key]
    if (!spec || value === undefined || value === null) continue
    const [number, kind] = spec
    if (kind === 'double') fields.push(encodeDoubleField(number, Number(value)))
    else if (kind === 'list') {
      const items = Array.isArray(value) ? value : String(value).split(',').filter(Boolean)
      fields.push(encodeBytesField(number, Buffer.concat(items.map((item) => encodePresentField(1, String(item))))))
    } else if (kind === 'proxy' && typeof value === 'object') fields.push(encodeBytesField(number, encodeProxyInfo(value as Record<string, unknown>)))
    else if (kind === 'bool') fields.push(encodePresentField(number, Boolean(value)))
    else if (kind === 'uint') fields.push(encodePresentField(number, Number(value)))
    else fields.push(encodePresentField(number, String(value)))
  }
  return Buffer.concat(fields)
}

const encodeCloudApiConfig = (request: Record<string, unknown>): Buffer => {
  const fields: Buffer[] = [
    encodePresentField(1, Number(request.maxDownloadThreads || 0)),
    encodePresentField(2, Number(request.minReadLengthKB || 0)),
    encodePresentField(3, Number(request.maxReadLengthKB || 0)),
    encodePresentField(4, Number(request.defaultReadLengthKB || 0)),
    encodePresentField(5, Number(request.maxBufferPoolSizeMB || 0)),
    encodePresentField(6, Number(request.maxQueriesPerSecond || 0)),
    encodePresentField(7, Boolean(request.forceIpv4))
  ]
  if (request.apiProxy && typeof request.apiProxy === 'object') fields.push(encodeBytesField(8, encodeProxyInfo(request.apiProxy as Record<string, unknown>)))
  if (request.dataProxy && typeof request.dataProxy === 'object') fields.push(encodeBytesField(9, encodeProxyInfo(request.dataProxy as Record<string, unknown>)))
  if (request.customUserAgent !== undefined) fields.push(encodePresentField(10, String(request.customUserAgent)))
  if (request.maxUploadThreads !== undefined) fields.push(encodePresentField(11, Number(request.maxUploadThreads)))
  if (request.insecureTls !== undefined) fields.push(encodePresentField(12, Boolean(request.insecureTls)))
  if (request.useHttpDownload !== undefined) fields.push(encodePresentField(13, Boolean(request.useHttpDownload)))
  if (request.supportDirectLink !== undefined) fields.push(encodePresentField(14, Boolean(request.supportDirectLink)))
  if (request.supportDirectDownloadUrl !== undefined) fields.push(encodePresentField(15, Boolean(request.supportDirectDownloadUrl)))
  if (request.maxDownloadThreadsLimit !== undefined) fields.push(encodePresentField(18, Number(request.maxDownloadThreadsLimit)))
  if (request.maxBufferPoolSizeMBLimit !== undefined) fields.push(encodePresentField(19, Number(request.maxBufferPoolSizeMBLimit)))
  if (request.maxQueriesPerSecondLimit !== undefined) fields.push(encodePresentField(20, Number(request.maxQueriesPerSecondLimit)))
  if (request.useMultithreadDownloaderForCopy !== undefined) fields.push(encodePresentField(21, Boolean(request.useMultithreadDownloaderForCopy)))
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
  const rules = Array.isArray(request.fileBackupRules) ? request.fileBackupRules.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object').map(encodeFileBackupRule) : []
  const schedules = Array.isArray(request.timeSchedules) ? request.timeSchedules.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object').map(encodeTimeSchedule) : []
  return Buffer.concat([
    request.sourcePath ? encodeField(1, String(request.sourcePath)) : Buffer.alloc(0),
    ...destinations.map((destination) => encodeBytesField(2, destination)),
    ...rules.map((rule) => encodeBytesField(3, rule)),
    encodePresentField(4, Number(request.fileReplaceRule || 0)),
    encodePresentField(5, Number(request.fileDeleteRule || 0)),
    encodePresentField(13, Number(request.fileCompletionRule || 0)),
    encodePresentField(6, request.isEnabled !== false),
    encodePresentField(7, Boolean(request.fileSystemWatchEnabled)),
    encodePresentField(8, Number(request.walkingThroughIntervalSecs || 0)),
    encodePresentField(9, Boolean(request.forceWalkingThroughOnStart)),
    ...schedules.map((schedule) => encodeBytesField(10, schedule)),
    encodePresentField(11, Boolean(request.isTimeSchedulesEnabled)),
    encodePresentField(14, Boolean(request.syncDeleteFromDest)),
    request.dontStartScanAfterAdd === undefined ? Buffer.alloc(0) : encodePresentField(15, Boolean(request.dontStartScanAfterAdd))
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
  const addPresent = (number: number, value: unknown): void => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') fields.push(encodePresentField(number, value))
  }
  const addNested = (number: number, value: Buffer): void => {
    fields.push(encodeBytesField(number, value))
  }
  const addProxy = (number: number, value: unknown): void => {
    if (value && typeof value === 'object') addNested(number, encodeProxyInfo(value as Record<string, unknown>))
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
      if (request.statusFilter !== undefined) addPresent(5, request.statusFilter)
      if (request.operatorTypeFilter !== undefined) addPresent(6, request.operatorTypeFilter)
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
      fields.push(encodeBytesField(3, encodeCloudApiConfig(request)))
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
      addPresent(2, Boolean(request.forceRefresh))
      break
    case 'GetFileDetailProperties':
    case 'GetMetaData':
    case 'GetOriginalPath':
      add(1, request.path)
      break
    case 'ListAllOfflineFiles':
      add(1, request.cloudName)
      add(2, request.cloudAccountId)
      add(3, request.page)
      add(4, request.path)
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
    case 'BackupGetStatus':
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
    case 'BackupUpdateStrategies': {
      add(1, request.sourcePath)
      if (Array.isArray(request.destinations)) {
        for (const value of request.destinations) {
          const destination = value as Record<string, unknown>
          addNested(2, Buffer.concat([encodePresentField(1, String(destination.destinationPath || '')), encodePresentField(2, destination.isEnabled !== false)]))
        }
      }
      if (Array.isArray(request.fileBackupRules)) {
        for (const value of request.fileBackupRules) addNested(3, encodeFileBackupRule(value as Record<string, unknown>))
      }
      if (request.fileReplaceRule !== undefined) addPresent(4, request.fileReplaceRule)
      if (request.fileDeleteRule !== undefined) addPresent(5, request.fileDeleteRule)
      if (request.fileSystemWatchEnabled !== undefined) addPresent(6, request.fileSystemWatchEnabled)
      if (request.walkingThroughIntervalSecs !== undefined) addPresent(7, request.walkingThroughIntervalSecs)
      break
    }
    case 'CancelMergeTask':
    case 'CancelCopyTask':
    case 'RestartCopyTask':
      add(1, request.sourcePath)
      add(2, request.destPath)
      break
    case 'PauseCopyTask':
      add(1, request.sourcePath)
      add(2, request.destPath)
      addPresent(3, Boolean(request.pause))
      break
    case 'RemoveCopyTasks':
    case 'ResumeCopyTasks':
      add(1, request.taskKeys)
      break
    case 'PauseCopyTasks':
      add(1, request.taskKeys)
      addPresent(2, Boolean(request.pause))
      break
    case 'PauseAllCopyTasks':
      addPresent(1, Boolean(request.pause))
      break
    case 'GetApiTokenInfo':
    case 'RemoveToken':
      add(1, request.value || request.token)
      break
    case 'CreateToken':
      addPresent(1, String(request.rootDir || '/'))
      addNested(2, encodeTokenPermissions((request.permissions || {}) as Record<string, unknown>))
      add(3, request.friendlyName || request.friendly_name)
      if (request.expiresIn !== undefined || request.expires_in !== undefined) addPresent(4, request.expiresIn ?? request.expires_in)
      if (request.enableGrpcLog !== undefined) addPresent(5, request.enableGrpcLog)
      if (request.enableStreamFileLog !== undefined) addPresent(6, request.enableStreamFileLog)
      break
    case 'ModifyToken':
      add(1, request.token)
      if (request.rootDir !== undefined) addPresent(2, String(request.rootDir))
      if (request.permissions && typeof request.permissions === 'object') addNested(3, encodeTokenPermissions(request.permissions as Record<string, unknown>))
      if (request.friendlyName !== undefined || request.friendly_name !== undefined) addPresent(4, String(request.friendlyName ?? request.friendly_name))
      if (request.expiresIn !== undefined || request.expires_in !== undefined) addPresent(5, request.expiresIn ?? request.expires_in)
      if (request.enableGrpcLog !== undefined) addPresent(6, request.enableGrpcLog)
      if (request.enableStreamFileLog !== undefined) addPresent(7, request.enableStreamFileLog)
      break
    case 'LoginWith2FA':
      add(1, request.userName)
      add(2, request.password)
      add(3, request.totpCode || request.totp_code)
      addPresent(4, Boolean(request.synDataToCloud))
      addProxy(5, request.cloudfsProxy)
      break
    case 'Setup2FA':
      add(1, request.password)
      break
    case 'Enable2FA':
    case 'Disable2FA':
    case 'GetRecoveryCodes':
    case 'RegenerateRecoveryCodes':
      add(1, request.totpCode || request.totp_code)
      break
    case 'SendDisable2FAEmail':
      add(1, request.email)
      addProxy(2, request.cloudfsProxy)
      break
    case 'Disable2FAByEmail':
      add(1, request.disableCode || request.disable_code)
      add(2, request.password)
      addProxy(3, request.cloudfsProxy)
      break
    case 'UnbindDevice':
      add(1, request.password)
      add(2, request.totpCode || request.totp_code)
      break
    case 'RevokeSession':
      add(1, request.sessionId || request.session_id)
      break
    case 'DeleteAccount':
      add(1, request.deleteCode || request.delete_code)
      add(2, request.password)
      add(3, request.totpCode || request.totp_code)
      addPresent(4, Boolean(request.forfeitBalance ?? request.forfeit_balance))
      break
    case 'APILogin115OpenOAuth':
    case 'APILoginGuangYaPanOAuth':
    case 'ApiLoginXunleiOpenOAuth':
    case 'ApiLogin123panOAuth':
      add(1, request.refreshToken || request.refresh_token)
      add(2, request.accessToken || request.access_token)
      add(3, request.expiresIn || request.expires_in)
      addProxy(4, request.apiProxy)
      addProxy(5, request.dataProxy)
      break
    case 'APILogin115OpenQRCode':
    case 'APILoginGuangYaPanQRCode':
      addProxy(1, request.apiProxy)
      addProxy(2, request.dataProxy)
      break
    case 'APILoginS3':
      add(1, request.accessKeyId)
      add(2, request.secretAccessKey)
      add(3, request.region)
      add(4, request.bucket)
      add(5, request.endpoint)
      addPresent(6, Boolean(request.pathStyle))
      addPresent(7, Boolean(request.doNotSyncToCloud))
      if (request.signatureVersion !== undefined) addPresent(8, request.signatureVersion)
      addProxy(9, request.apiProxy)
      addProxy(10, request.dataProxy)
      break
    case 'APILoginCloudDrive':
      add(1, request.grpcUrl)
      add(2, request.token)
      addPresent(3, Boolean(request.insecureTls))
      addPresent(4, Boolean(request.doNotSyncToCloud))
      addProxy(5, request.apiProxy)
      addProxy(6, request.dataProxy)
      break
    case 'APILoginSftp':
      add(1, request.host)
      addPresent(2, Number(request.port || 22))
      add(3, request.userName)
      add(4, request.password)
      add(5, request.privateKey)
      add(6, request.passphrase)
      add(7, request.rootPath)
      addPresent(8, Boolean(request.doNotSyncToCloud))
      addProxy(9, request.apiProxy)
      addProxy(10, request.dataProxy)
      break
    case 'APILoginFtp':
      add(1, request.host)
      addPresent(2, Number(request.port || 21))
      add(3, request.userName)
      add(4, request.password)
      addPresent(5, Boolean(request.useTls))
      add(6, request.rootPath)
      addPresent(7, Boolean(request.doNotSyncToCloud))
      addProxy(8, request.apiProxy)
      addProxy(9, request.dataProxy)
      break
    case 'APILoginSmb':
      add(1, request.server)
      add(2, request.share)
      addPresent(3, Number(request.port || 445))
      add(4, request.userName)
      add(5, request.password)
      add(6, request.workgroup)
      add(7, request.rootPath)
      addPresent(8, Boolean(request.doNotSyncToCloud))
      addProxy(9, request.apiProxy)
      addProxy(10, request.dataProxy)
      break
    case 'DiscoverSmbShares':
      add(1, request.server)
      addPresent(2, Number(request.port || 445))
      add(3, request.userName)
      add(4, request.password)
      add(5, request.workgroup)
      break
    case 'CreateOAuthState':
      add(1, request.oauthType)
      add(2, request.returnUrl)
      add(3, request.deviceId)
      add(4, request.codeVerifier)
      break
    case 'GetOfflineQuotaInfo':
      add(1, request.cloudName)
      add(2, request.cloudAccountId)
      add(3, request.path)
      break
    case 'ClearOfflineFiles':
      add(1, request.cloudName)
      add(2, request.cloudAccountId)
      addPresent(3, Number(request.filter || 0))
      addPresent(4, Boolean(request.deleteFiles))
      add(5, request.path)
      break
    case 'RestartOfflineTask':
      add(1, request.cloudName)
      add(2, request.cloudAccountId)
      add(3, request.infoHash)
      add(4, request.url)
      add(5, request.parentId)
      add(6, request.path)
      break
    case 'StartRemoteUpload': {
      add(1, request.filePath || request.file_path)
      addPresent(2, Number(request.fileSize ?? request.file_size ?? 0))
      const hashes = (request.knownHashes || request.known_hashes || {}) as Record<string, unknown>
      for (const [hashType, hashValue] of Object.entries(hashes)) addNested(3, Buffer.concat([encodePresentField(1, Number(hashType)), encodePresentField(2, String(hashValue))]))
      addPresent(4, Boolean(request.clientCanCalculateHashes ?? request.client_can_calculate_hashes))
      break
    }
    case 'RemoteUploadControl':
      add(1, request.uploadId || request.upload_id)
      addNested(request.action === 'cancel' ? 2 : request.action === 'pause' ? 3 : 4, Buffer.alloc(0))
      break
    case 'RemoteUploadChannel':
      add(1, request.deviceId || request.device_id)
      break
    case 'RemoteReadData':
      add(1, request.uploadId || request.upload_id)
      addPresent(3, Number(request.offset || 0))
      addPresent(4, Number(request.length || 0))
      addPresent(5, Boolean(request.lazyRead ?? request.lazy_read))
      addBytes(6, request.data)
      addPresent(7, Boolean(request.isLastChunk ?? request.is_last_chunk))
      break
    case 'RemoteHashProgress':
      add(1, request.uploadId || request.upload_id)
      addPresent(2, Number(request.bytesHashed ?? request.bytes_hashed ?? 0))
      addPresent(3, Number(request.totalBytes ?? request.total_bytes ?? 0))
      addPresent(4, Number(request.hashType ?? request.hash_type ?? 0))
      add(5, request.hashValue || request.hash_value)
      add(6, request.blockHashes || request.block_hashes)
      break
    case 'SetDiskCacheEvictionStrategy':
      addPresent(1, Number(request.strategy || 0))
      break
    case 'SetFolderDiskCache':
      add(1, request.path)
      addPresent(2, Number(request.maxFileSize || 0))
      addPresent(3, Number(request.minFileSize || 0))
      addPresent(4, Number(request.extensionFilterMode || 0))
      add(5, request.extensions)
      addPresent(6, request.enabled !== false)
      break
    case 'RemoveFolderDiskCache':
    case 'ForceExpireDirCache':
      add(1, request.path)
      break
    case 'SetSystemSettings':
      fields.push(encodeSystemSettings(request))
      break
    case 'SetDirCacheTimeSecs':
      add(1, request.path)
      if (request.dirCacheTimeToLiveSecs !== undefined) addPresent(2, request.dirCacheTimeToLiveSecs)
      break
    case 'GetEffectiveDirCacheTimeSecs':
      add(1, request.path)
      break
    case 'GetOpenFileTable':
      addPresent(1, Boolean(request.includeDir))
      break
    case 'GetReferencedEntryPaths':
      add(1, request.path)
      break
    case 'SetWebServerConfig':
      if (request.httpPort !== undefined || request.http_port !== undefined) addPresent(1, request.httpPort ?? request.http_port)
      if (request.httpsPort !== undefined || request.https_port !== undefined) addPresent(2, request.httpsPort ?? request.https_port)
      add(3, request.certFile || request.cert_file)
      add(4, request.keyFile || request.key_file)
      if (request.enableHttps !== undefined || request.enable_https !== undefined) addPresent(5, request.enableHttps ?? request.enable_https)
      add(6, request.certContent || request.cert_content)
      add(7, request.keyContent || request.key_content)
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
  return {
    key: text(values(fields, 1).at(0)),
    destPath: text(values(fields, 2).at(0)),
    size: integer(values(fields, 3).at(0)),
    transferedBytes: integer(values(fields, 4).at(0)),
    status: text(values(fields, 5).at(0)),
    errorMessage: text(values(fields, 6).at(0)),
    operatorType: Number(values(fields, 7).at(0) || 0),
    statusEnum: Number(values(fields, 8).at(0) || 0)
  }
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

const decodeBackupRule = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  const typed = ([1, 2, 3, 4] as const).find((number) => values(fields, number).length)
  const kind = typed === 1 ? 'extensions' : typed === 2 ? 'fileNames' : typed === 3 ? 'regex' : 'minSize'
  return {
    kind,
    value: typed === 4 ? integer(values(fields, 4).at(0)) : text(values(fields, typed || 1).at(0)),
    isEnabled: bool(values(fields, 100).at(0)),
    isBlackList: bool(values(fields, 101).at(0)),
    applyToFolder: bool(values(fields, 102).at(0)),
    applyToFile: values(fields, 103).length ? bool(values(fields, 103).at(0)) : true
  }
}

const decodeTimeSchedule = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  const days = values(fields, 5).find(Buffer.isBuffer)
  return {
    isEnabled: bool(values(fields, 1).at(0)),
    hour: Number(values(fields, 2).at(0) || 0),
    minute: Number(values(fields, 3).at(0) || 0),
    second: Number(values(fields, 4).at(0) || 0),
    daysOfWeek: days ? values(parseFields(days as Buffer), 1).map(Number) : []
  }
}

const decodeBackup = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  return {
    sourcePath: text(values(fields, 1).at(0)),
    destinations: values(fields, 2)
      .filter(Buffer.isBuffer)
      .map((value) => decodeBackupDestination(value as Buffer)),
    fileBackupRules: values(fields, 3)
      .filter(Buffer.isBuffer)
      .map((value) => decodeBackupRule(value as Buffer)),
    fileReplaceRule: Number(values(fields, 4).at(0) || 0),
    fileDeleteRule: Number(values(fields, 5).at(0) || 0),
    fileCompletionRule: Number(values(fields, 13).at(0) || 0),
    isEnabled: bool(values(fields, 6).at(0)),
    fileSystemWatchEnabled: bool(values(fields, 7).at(0)),
    walkingThroughIntervalSecs: integer(values(fields, 8).at(0)),
    forceWalkingThroughOnStart: bool(values(fields, 9).at(0)),
    timeSchedules: values(fields, 10)
      .filter(Buffer.isBuffer)
      .map((value) => decodeTimeSchedule(value as Buffer)),
    isTimeSchedulesEnabled: bool(values(fields, 11).at(0)),
    syncDeleteFromDest: bool(values(fields, 14).at(0)),
    dontStartScanAfterAdd: bool(values(fields, 15).at(0))
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
    addTime: integer(values(fields, 7).at(0)),
    parentId: text(values(fields, 8).at(0)),
    percentDone: Number(values(fields, 9).at(0) || 0),
    peers: Number(values(fields, 10).at(0) || 0)
  }
}

const decodeCloudApiConfig = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  const apiProxy = values(fields, 8).find(Buffer.isBuffer)
  const dataProxy = values(fields, 9).find(Buffer.isBuffer)
  return {
    maxDownloadThreads: Number(values(fields, 1).at(0) || 0),
    minReadLengthKB: integer(values(fields, 2).at(0)),
    maxReadLengthKB: integer(values(fields, 3).at(0)),
    defaultReadLengthKB: integer(values(fields, 4).at(0)),
    maxBufferPoolSizeMB: integer(values(fields, 5).at(0)),
    maxQueriesPerSecond: doubleValue(values(fields, 6).at(0)),
    forceIpv4: bool(values(fields, 7).at(0)),
    apiProxy: apiProxy ? decodeProxyInfo(apiProxy as Buffer) : undefined,
    dataProxy: dataProxy ? decodeProxyInfo(dataProxy as Buffer) : undefined,
    customUserAgent: text(values(fields, 10).at(0)),
    maxUploadThreads: Number(values(fields, 11).at(0) || 0),
    insecureTls: bool(values(fields, 12).at(0)),
    useHttpDownload: bool(values(fields, 13).at(0)),
    supportDirectLink: bool(values(fields, 14).at(0)),
    supportDirectDownloadUrl: bool(values(fields, 15).at(0)),
    maxDownloadThreadsLimit: Number(values(fields, 18).at(0) || 0),
    maxBufferPoolSizeMBLimit: integer(values(fields, 19).at(0)),
    maxQueriesPerSecondLimit: doubleValue(values(fields, 20).at(0)),
    useMultithreadDownloaderForCopy: bool(values(fields, 21).at(0))
  }
}

const decodeTokenPermissions = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  return Object.fromEntries(TOKEN_PERMISSION_FIELDS.map((name, index) => [name, bool(values(fields, index + 1).at(0))]))
}

const decodeTokenInfo = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  const permissions = values(fields, 3).find(Buffer.isBuffer)
  return {
    token: text(values(fields, 1).at(0)),
    rootDir: text(values(fields, 2).at(0)),
    permissions: permissions ? decodeTokenPermissions(permissions as Buffer) : {},
    expiresIn: integer(values(fields, 4).at(0)),
    friendlyName: text(values(fields, 5).at(0)),
    enableGrpcLog: bool(values(fields, 6).at(0)),
    enableStreamFileLog: bool(values(fields, 7).at(0))
  }
}

const decodeCopyTask = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  return {
    taskMode: Number(values(fields, 2).at(0) || 0),
    sourcePath: text(values(fields, 3).at(0)),
    destPath: text(values(fields, 4).at(0)),
    status: Number(values(fields, 5).at(0) || 0),
    totalFolders: integer(values(fields, 6).at(0)),
    totalFiles: integer(values(fields, 7).at(0)),
    failedFolders: integer(values(fields, 8).at(0)),
    failedFiles: integer(values(fields, 9).at(0)),
    uploadedFiles: integer(values(fields, 10).at(0)),
    cancelledFiles: integer(values(fields, 11).at(0)),
    totalBytes: integer(values(fields, 12).at(0)),
    uploadedBytes: integer(values(fields, 13).at(0)),
    paused: bool(values(fields, 14).at(0)),
    skippedFiles: integer(values(fields, 16).at(0))
  }
}

const decodeMergeTask = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  return {
    sourcePath: text(values(fields, 1).at(0)),
    destPath: text(values(fields, 2).at(0)),
    status: Number(values(fields, 3).at(0) || 0),
    mergedFiles: integer(values(fields, 4).at(0)),
    mergedFolders: integer(values(fields, 5).at(0)),
    errorMessage: text(values(fields, 8).at(0)),
    conflictPolicy: Number(values(fields, 9).at(0) || 0),
    operationType: Number(values(fields, 10).at(0) || 0)
  }
}

const decodeSession = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  return {
    id: text(values(fields, 1).at(0)),
    deviceId: text(values(fields, 2).at(0)),
    deviceName: text(values(fields, 3).at(0)),
    deviceOsType: text(values(fields, 4).at(0)),
    createdAt: text(values(fields, 5).at(0)),
    lastUsedAt: text(values(fields, 6).at(0)),
    expiresAt: text(values(fields, 7).at(0)),
    lastIpAddress: text(values(fields, 8).at(0))
  }
}

const decodeStringList = (buffer: Buffer): string[] =>
  values(parseFields(buffer), 1)
    .filter(Buffer.isBuffer)
    .map((value) => text(value))

const decodeProxyInfo = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  return { proxyType: Number(values(fields, 1).at(0) || 0), host: text(values(fields, 2).at(0)), port: Number(values(fields, 3).at(0) || 0), username: text(values(fields, 4).at(0)) }
}

const decodeSystemSettings = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  const result: RpcResponse = {}
  for (const [key, [number, kind]] of Object.entries(SYSTEM_SETTING_FIELDS)) {
    const value = values(fields, number).at(0)
    if (value === undefined) continue
    result[key] = kind === 'double' ? doubleValue(value) : kind === 'bool' ? bool(value) : kind === 'uint' ? integer(value) : kind === 'list' ? decodeStringList(value as Buffer) : kind === 'proxy' ? decodeProxyInfo(value as Buffer) : text(value)
  }
  return result
}

const decodeMetadata = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  const metadata: Record<string, string> = {}
  for (const value of values(fields, 1).filter(Buffer.isBuffer)) {
    const entry = parseFields(value as Buffer)
    metadata[text(values(entry, 1).at(0))] = text(values(entry, 2).at(0))
  }
  return { metadata }
}

const decodeTimestamp = (buffer: Buffer): string => {
  const fields = parseFields(buffer)
  const seconds = Number(values(fields, 1).at(0) || 0)
  return seconds ? new Date(seconds * 1000).toISOString() : ''
}

const decodeOpenFileTable = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  const openFiles: Record<string, string> = {}
  for (const value of values(fields, 1).filter(Buffer.isBuffer)) {
    const entry = parseFields(value as Buffer)
    openFiles[String(values(entry, 1).at(0) || 0)] = text(values(entry, 2).at(0))
  }
  return { openFiles, localOpenFileCount: integer(values(fields, 2).at(0)) }
}

const decodeDirCacheTable = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  const dirCache: Record<string, RpcResponse> = {}
  for (const value of values(fields, 1).filter(Buffer.isBuffer)) {
    const entry = parseFields(value as Buffer)
    const item = values(entry, 2).find(Buffer.isBuffer)
    if (!item) continue
    const nested = parseFields(item as Buffer)
    const inserted = values(nested, 1).find(Buffer.isBuffer)
    dirCache[text(values(entry, 1).at(0))] = { insertTime: inserted ? decodeTimestamp(inserted as Buffer) : '', timeToLiveSecs: integer(values(nested, 2).at(0)), referencedSubfileLen: integer(values(nested, 3).at(0)) }
  }
  return { dirCache }
}

const decodeRemoteUploadChannel = (buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  const read = values(fields, 2).find(Buffer.isBuffer)
  const hash = values(fields, 3).find(Buffer.isBuffer)
  const status = values(fields, 4).find(Buffer.isBuffer)
  if (read) {
    const nested = parseFields(read as Buffer)
    return { uploadId: text(values(fields, 1).at(0)), type: 'read', offset: integer(values(nested, 1).at(0)), length: integer(values(nested, 2).at(0)), lazyRead: bool(values(nested, 3).at(0)) }
  }
  if (hash) {
    const nested = parseFields(hash as Buffer)
    return { uploadId: text(values(fields, 1).at(0)), type: 'hash', hashType: Number(values(nested, 2).at(0) || 0), blockSize: Number(values(nested, 3).at(0) || 0) }
  }
  if (status) {
    const nested = parseFields(status as Buffer)
    return { uploadId: text(values(fields, 1).at(0)), type: 'status', status: Number(values(nested, 1).at(0) || 0), errorMessage: text(values(nested, 2).at(0)) }
  }
  return { uploadId: text(values(fields, 1).at(0)), type: 'unknown' }
}

const decodeResponse = (method: string, buffer: Buffer): RpcResponse => {
  const fields = parseFields(buffer)
  if (method === 'GetToken' || method === 'LoginWith2FA') return { success: bool(values(fields, 1).at(0)), errorMessage: text(values(fields, 2).at(0)), token: text(values(fields, 3).at(0)) }
  if (method === 'CreateToken' || method === 'ModifyToken' || method === 'GetApiTokenInfo') return decodeTokenInfo(buffer)
  if (method === 'ListTokens')
    return {
      tokens: values(fields, 1)
        .filter(Buffer.isBuffer)
        .map((value) => decodeTokenInfo(value as Buffer))
    }
  if (method === 'GetCopyTasks')
    return {
      copyTasks: values(fields, 1)
        .filter(Buffer.isBuffer)
        .map((value) => decodeCopyTask(value as Buffer))
    }
  if (method === 'GetMergeTasks')
    return {
      mergeTasks: values(fields, 1)
        .filter(Buffer.isBuffer)
        .map((value) => decodeMergeTask(value as Buffer))
    }
  if (method === 'RemoveAllCopyTasks' || method === 'RemoveCopyTasks' || method === 'PauseAllCopyTasks' || method === 'PauseCopyTasks' || method === 'ResumeAllCopyTasks' || method === 'ResumeCopyTasks')
    return { success: bool(values(fields, 1).at(0)), affectedCount: Number(values(fields, 2).at(0) || 0), errorMessage: text(values(fields, 3).at(0)) }
  if (method === 'Check2FAStatus') return { enabled: bool(values(fields, 1).at(0)) }
  if (method === 'Setup2FA') return { secret: text(values(fields, 1).at(0)), qrCodeDataUrl: text(values(fields, 2).at(0)), manualEntryKey: text(values(fields, 3).at(0)) }
  if (method === 'Enable2FA' || method === 'GetRecoveryCodes' || method === 'RegenerateRecoveryCodes')
    return {
      recoveryCodes: values(fields, 1)
        .filter(Buffer.isBuffer)
        .map((value) => text(value))
    }
  if (method === 'GetSessions')
    return {
      sessions: values(fields, 1)
        .filter(Buffer.isBuffer)
        .map((value) => decodeSession(value as Buffer))
    }
  if (method === 'SendDeleteAccountEmail')
    return { email: text(values(fields, 1).at(0)), balance: doubleValue(values(fields, 2).at(0)), hasActiveSubscription: bool(values(fields, 3).at(0)), boundDeviceCount: Number(values(fields, 4).at(0) || 0), expiresInMinutes: Number(values(fields, 5).at(0) || 0) }
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
        .map((value) => decodeUploadFile(value as Buffer)),
      globalBytesPerSecond: doubleValue(values(fields, 3).at(0)),
      totalBytes: integer(values(fields, 4).at(0)),
      finishedBytes: integer(values(fields, 5).at(0)),
      totalCountFiltered: Number(values(fields, 6).at(0) || 0)
    }
  if (method === 'GetAllTasksCount') return { downloadCount: Number(values(fields, 1).at(0) || 0), uploadCount: Number(values(fields, 2).at(0) || 0), copyTaskCount: Number(values(fields, 6).at(0) || 0) }
  if (method === 'GetRunningInfo') return { cpuUsage: Number(values(fields, 1).at(0) || 0), memUsageKB: integer(values(fields, 2).at(0)), uptime: Number(values(fields, 3).at(0) || 0) }
  if (method === 'CanAddMoreCloudApis' || method === 'CanAddMoreBackups') return decodeOperationResult(buffer)
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
            hasPromotions: bool(values(cloudFields, 8).at(0)),
            promotionTitle: text(values(cloudFields, 9).at(0)),
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
    method === 'ApiLoginXunleiOpenOAuth' ||
    method === 'ApiLogin123panOAuth' ||
    method === 'APILogin115OpenOAuth' ||
    method === 'APILoginGuangYaPanOAuth' ||
    method === 'APILoginS3' ||
    method === 'APILoginCloudDrive' ||
    method === 'APILoginSftp' ||
    method === 'APILoginFtp' ||
    method === 'APILoginSmb' ||
    method === 'APILoginPikPak' ||
    method === 'APILoginWebDav' ||
    method === 'APIAddLocalFolder'
  )
    return { success: bool(values(fields, 1).at(0)), errorMessage: text(values(fields, 2).at(0)) }
  if (method === 'GetCloudAPIConfig') return decodeCloudApiConfig(buffer)
  if (method === 'APILogin115QRCode' || method === 'APILoginAliyunDriveQRCode' || method === 'APILogin189QRCode' || method === 'APILogin115OpenQRCode' || method === 'APILoginGuangYaPanQRCode') return { messageType: Number(values(fields, 1).at(0) || 0), message: text(values(fields, 2).at(0)) }
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
  if (method === 'BackupGetStatus') return decodeBackupStatus(buffer)
  if (method === 'GetFileDetailProperties')
    return { totalFileCount: integer(values(fields, 1).at(0)), totalFolderCount: integer(values(fields, 2).at(0)), totalSize: integer(values(fields, 3).at(0)), isFaved: bool(values(fields, 4).at(0)), isShared: bool(values(fields, 5).at(0)), originalPath: text(values(fields, 6).at(0)) }
  if (method === 'GetMetaData') return decodeMetadata(buffer)
  if (method === 'GetOriginalPath') return { result: text(values(fields, 1).at(0)) }
  if (method === 'GetOfflineQuotaInfo') return { total: Number(values(fields, 1).at(0) || 0), used: Number(values(fields, 2).at(0) || 0), left: Number(values(fields, 3).at(0) || 0) }
  if (method === 'StartRemoteUpload') return { uploadId: text(values(fields, 1).at(0)) }
  if (method === 'RemoteReadData') return { success: bool(values(fields, 1).at(0)), errorMessage: text(values(fields, 2).at(0)), bytesReceived: integer(values(fields, 3).at(0)), isLastChunk: bool(values(fields, 4).at(0)) }
  if (method === 'RemoteUploadChannel') return decodeRemoteUploadChannel(buffer)
  if (method === 'GetRuntimeInfo') return { productName: text(values(fields, 1).at(0)), productVersion: text(values(fields, 2).at(0)), cloudApiVersion: text(values(fields, 3).at(0)), osInfo: text(values(fields, 4).at(0)) }
  if (method === 'GetFileBufferDiskCacheStats')
    return {
      enabled: bool(values(fields, 1).at(0)),
      totalBytes: integer(values(fields, 2).at(0)),
      maxBytes: integer(values(fields, 3).at(0)),
      entryCount: integer(values(fields, 4).at(0)),
      segmentCount: integer(values(fields, 5).at(0)),
      rootDir: text(values(fields, 6).at(0)),
      scanCompleted: bool(values(fields, 7).at(0)),
      evictionStrategy: Number(values(fields, 8).at(0) || 0)
    }
  if (method === 'ListDiskCacheFolders')
    return {
      folders: values(fields, 1)
        .filter(Buffer.isBuffer)
        .map((value) => {
          const item = parseFields(value as Buffer)
          return {
            path: text(values(item, 1).at(0)),
            maxFileSize: integer(values(item, 2).at(0)),
            minFileSize: integer(values(item, 3).at(0)),
            extensionFilterMode: Number(values(item, 4).at(0) || 0),
            extensions: values(item, 5)
              .filter(Buffer.isBuffer)
              .map((entry) => text(entry)),
            enabled: bool(values(item, 6).at(0))
          }
        })
    }
  if (method === 'GetSystemSettings') return decodeSystemSettings(buffer)
  if (method === 'GetEffectiveDirCacheTimeSecs') return { dirCacheTimeToLiveSecs: integer(values(fields, 1).at(0)), source: text(values(fields, 2).at(0)) }
  if (method === 'GetDirCacheDbSize') return { sizeBytes: integer(values(fields, 1).at(0)) }
  if (method === 'GetOpenFileTable') return decodeOpenFileTable(buffer)
  if (method === 'GetDirCacheTable') return decodeDirCacheTable(buffer)
  if (method === 'GetReferencedEntryPaths')
    return {
      paths: values(fields, 1)
        .filter(Buffer.isBuffer)
        .map((value) => text(value))
    }
  if (method === 'GetTempFileTable')
    return {
      count: integer(values(fields, 1).at(0)),
      tempFiles: values(fields, 2)
        .filter(Buffer.isBuffer)
        .map((value) => text(value))
    }
  if (method === 'GetServiceCapabilities') return { canRestart: bool(values(fields, 1).at(0)), canUpdate: bool(values(fields, 2).at(0)) }
  if (method === 'GetWebServerConfig') return { httpPort: Number(values(fields, 1).at(0) || 0), httpsPort: Number(values(fields, 2).at(0) || 0), certFile: text(values(fields, 3).at(0)), keyFile: text(values(fields, 4).at(0)), enableHttps: bool(values(fields, 5).at(0)) }
  if (method === 'DiscoverSmbServers')
    return {
      servers: values(fields, 1)
        .filter(Buffer.isBuffer)
        .map((value) => {
          const item = parseFields(value as Buffer)
          return { name: text(values(item, 1).at(0)), address: text(values(item, 2).at(0)) }
        })
    }
  if (method === 'DiscoverSmbShares')
    return {
      shareNames: values(fields, 1)
        .filter(Buffer.isBuffer)
        .map((value) => text(value))
    }
  if (method === 'CreateOAuthState') return { success: bool(values(fields, 1).at(0)), errorMessage: text(values(fields, 2).at(0)), state: text(values(fields, 3).at(0)), expiresIn: integer(values(fields, 4).at(0)) }
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

  async consumeServerStream(method: string, request: Record<string, unknown>, onMessage: (message: RpcResponse) => Promise<boolean | undefined>): Promise<void> {
    const config = await this.getConfig()
    if (!config.endpoint) throw new Error(`请先配置 CD2 地址，使用 ${commandName} conf endpoint ...`)
    const parsed = new URL(config.endpoint)
    const session = http2.connect(parsed.origin, parsed.protocol === 'https:' ? { rejectUnauthorized: true } : undefined)
    await new Promise<void>((resolve, reject) => {
      let pending = Buffer.alloc(0)
      let grpcStatus = '0'
      let settled = false
      let chain = Promise.resolve()
      const timer = setTimeout(() => finish(new Error('CD2 远程上传通道超时')), 60 * 60 * 1000)
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        stream.close()
        session.close()
        if (error) reject(error)
        else if (grpcStatus !== '0') reject(new Error(`CD2 gRPC 错误状态：${grpcStatus}`))
        else resolve()
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
      stream.on('data', (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk])
        while (pending.length >= 5) {
          if (pending[0] !== 0) return finish(new Error('CD2 返回了不支持的压缩 gRPC 帧'))
          const length = pending.readUInt32BE(1)
          if (pending.length < length + 5) break
          const payload = pending.subarray(5, length + 5)
          pending = pending.subarray(length + 5)
          chain = chain
            .then(async () => {
              if (settled) return
              const keep = await onMessage(decodeResponse(method, payload))
              if (keep === false) finish()
            })
            .catch((error: Error) => finish(error))
        }
      })
      stream.on('end', () => chain.then(() => finish()).catch((error: Error) => finish(error)))
      stream.on('error', (error) => finish(error))
      stream.end(frameGrpc(encodeRequest(method, request)))
    })
  }

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
    if (action === 'delete-email') {
      const result = await this.getClient().unary('SendDeleteAccountEmail')
      await msg.edit({
        text: htmlText(
          [
            '📧 <b>账户注销验证码已发送</b>',
            `<b>邮箱：</b> ${htmlEscape(result.email || '当前账户邮箱')}`,
            `<b>余额：</b> ${htmlEscape(String(result.balance || 0))}`,
            `<b>绑定设备：</b> ${result.boundDeviceCount || 0}`,
            `<b>有效期：</b> ${result.expiresInMinutes || 0} 分钟`,
            result.hasActiveSubscription ? '❌ 存在有效订阅，需先取消订阅' : '⚠️ 注销不可恢复；确认时需要密码、验证码和可选 2FA。'
          ].join('\n')
        )
      })
      return
    }
    if (action === 'delete') {
      if (!args[1] || !args[2] || !args.includes('confirm')) throw new Error(`用法：${commandName} account delete DELETE_CODE PASSWORD [TOTP] [forfeit] confirm`)
      const optional = args.slice(3, -1)
      await this.getClient().unary('DeleteAccount', { deleteCode: args[1], password: args[2], totpCode: optional.find((item) => /^\d{6}$/.test(item)), forfeitBalance: optional.includes('forfeit') })
      await this.updateConfig({ token: '', accountUsername: '', accountPassword: '' })
      await msg.edit({ text: '✅ CloudDrive2 账户已注销，本地账户和 Token 已清除' })
      return
    }
    throw new Error(`用法：${commandName} account status|logout|register|reset-email|reset|delete-email|delete`)
  }

  private async handleTwoFactor(msg: MessageContext, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase() || 'status'
    if (action === 'status') {
      const result = await this.getClient().unary('Check2FAStatus')
      await msg.edit({ text: htmlText(['<b>🔐 两步验证</b>', `<b>已启用：</b> ${result.enabled ? '✅' : '❌'}`].join('\n')) })
      return
    }
    if (action === 'setup') {
      if (!args[1]) throw new Error(`用法：${commandName} 2fa setup PASSWORD`)
      const result = await this.getClient().unary('Setup2FA', { password: args[1] })
      await msg.edit({
        text: htmlText(
          ['<b>🔐 两步验证设置</b>', `<b>密钥：</b> <code>${htmlEscape(result.secret || result.manualEntryKey || '')}</code>`, `<b>手动输入：</b> <code>${htmlEscape(result.manualEntryKey || result.secret || '')}</code>`, `下一步：<code>${commandName} 2fa enable 6位验证码</code>`].join('\n')
        )
      })
      return
    }
    if (action === 'enable' || action === 'recovery' || action === 'regenerate') {
      if (!args[1]) throw new Error(`用法：${commandName} 2fa ${action} TOTP_CODE`)
      const method = action === 'enable' ? 'Enable2FA' : action === 'recovery' ? 'GetRecoveryCodes' : 'RegenerateRecoveryCodes'
      const result = await this.getClient().unary(method, { totpCode: args[1] })
      const codes = (result.recoveryCodes || []) as string[]
      await msg.edit({ text: htmlText([`✅ <b>${action === 'enable' ? '两步验证已启用' : '恢复码'}</b>`, ...codes.map((code) => `<code>${htmlEscape(code)}</code>`), codes.length ? '<i>请离线保存这些恢复码。</i>' : '操作成功'].join('\n')) })
      return
    }
    if (action === 'disable') {
      if (!args[1]) throw new Error(`用法：${commandName} 2fa disable TOTP_CODE`)
      await this.getClient().unary('Disable2FA', { totpCode: args[1] })
      await msg.edit({ text: '✅ 两步验证已关闭' })
      return
    }
    if (action === 'login') {
      if (!args[1] || !args[2] || !args[3]) throw new Error(`用法：${commandName} 2fa login USER PASSWORD TOTP_CODE`)
      const result = await this.getClient().unary('LoginWith2FA', { userName: args[1], password: args[2], totpCode: args[3], synDataToCloud: true })
      if (!result.success || !result.token) throw new Error(result.errorMessage || '2FA 登录失败')
      await this.updateConfig({ accountUsername: args[1], accountPassword: args[2], token: result.token })
      await msg.edit({ text: '✅ 2FA 登录成功，Token 已保存' })
      return
    }
    if (action === 'send-disable-email') {
      if (!args[1]) throw new Error(`用法：${commandName} 2fa send-disable-email EMAIL`)
      await this.getClient().unary('SendDisable2FAEmail', { email: args[1] })
      await msg.edit({ text: '✅ 关闭 2FA 的恢复邮件已发送' })
      return
    }
    if (action === 'disable-email') {
      if (!args[1] || !args[2]) throw new Error(`用法：${commandName} 2fa disable-email DISABLE_CODE PASSWORD`)
      await this.getClient().unary('Disable2FAByEmail', { disableCode: args[1], password: args[2] })
      await msg.edit({ text: '✅ 已通过邮件恢复流程关闭 2FA' })
      return
    }
    if (action === 'unbind') {
      if (!args[1]) throw new Error(`用法：${commandName} 2fa unbind PASSWORD [TOTP_CODE]`)
      await this.getClient().unary('UnbindDevice', { password: args[1], totpCode: args[2] })
      await msg.edit({ text: '✅ 当前设备已解绑' })
      return
    }
    throw new Error(`用法：${commandName} 2fa status|setup|enable|disable|recovery|regenerate|login|send-disable-email|disable-email|unbind`)
  }

  private async handleSessions(msg: MessageContext, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase() || 'list'
    if (action === 'list') {
      const result = await this.getClient().unary('GetSessions')
      const sessions = (result.sessions || []) as RpcResponse[]
      const lines = sessions.length
        ? sessions.map((session, index) => `${index + 1}. <b>${htmlEscape(session.deviceName || session.deviceId || '未知设备')}</b> · ${htmlEscape(session.deviceOsType || '')}\n   ID：<code>${htmlEscape(session.id || '')}</code> · 最后使用：${htmlEscape(session.lastUsedAt || '未知')}`)
        : ['没有活动会话']
      await msg.edit({ text: htmlText(['<b>📱 CloudDrive2 会话</b>', '', ...lines].join('\n')) })
      return
    }
    if (action === 'revoke') {
      if (!args[1] || args[2]?.toLowerCase() !== 'confirm') throw new Error(`用法：${commandName} session revoke SESSION_ID confirm`)
      await this.getClient().unary('RevokeSession', { sessionId: args[1] })
      await msg.edit({ text: '✅ 会话已撤销' })
      return
    }
    if (action === 'revoke-others') {
      if (args[1]?.toLowerCase() !== 'confirm') throw new Error(`用法：${commandName} session revoke-others confirm`)
      await this.getClient().unary('RevokeOtherSessions')
      await msg.edit({ text: '✅ 其他会话已全部撤销' })
      return
    }
    throw new Error(`用法：${commandName} session list|revoke|revoke-others`)
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
    if (action === 'list') {
      const result = await this.getClient().unary('ListTokens')
      const tokens = (result.tokens || []) as RpcResponse[]
      const lines = tokens.length
        ? tokens.map(
            (item, index) =>
              `${index + 1}. <b>${htmlEscape(item.friendlyName || '未命名')}</b> · <code>${htmlEscape(maskToken(item.token || ''))}</code>\n   根目录：<code>${htmlEscape(item.rootDir || '/')}</code> · 剩余：${item.expiresIn ? `${item.expiresIn} 秒` : '永不过期'} · gRPC 日志 ${item.enableGrpcLog ? '开' : '关'}`
          )
        : ['没有额外 API Token']
      await msg.edit({ text: htmlText(['<b>🔑 API Token 列表</b>', '', ...lines].join('\n')) })
      return
    }
    if (action === 'info') {
      const config = await this.getConfig()
      const token = args[1] || config.token
      if (!token) throw new Error(`用法：${commandName} token info [TOKEN]`)
      const info = await this.getClient().unary('GetApiTokenInfo', { value: token })
      const permissions = Object.entries((info.permissions || {}) as Record<string, boolean>)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name.replace(/^allow/, ''))
        .join(', ')
      await msg.edit({
        text: htmlText(
          [
            '<b>🔑 Token 详情</b>',
            `<b>名称：</b> ${htmlEscape(info.friendlyName || '未命名')}`,
            `<b>Token：</b> <code>${htmlEscape(maskToken(info.token || token))}</code>`,
            `<b>根目录：</b> <code>${htmlEscape(info.rootDir || '/')}</code>`,
            `<b>权限：</b> ${htmlEscape(permissions || '无')}`,
            `<b>剩余有效期：</b> ${info.expiresIn ? `${info.expiresIn} 秒` : '永不过期'}`,
            `<b>日志：</b> gRPC ${info.enableGrpcLog ? '开' : '关'} · 流文件 ${info.enableStreamFileLog ? '开' : '关'}`
          ].join('\n')
        )
      })
      return
    }
    if (action === 'create') {
      if (!args[1] || !args[2] || !args[3]) throw new Error(`用法：${commandName} token create NAME ROOT read|write|full [EXPIRES_SECONDS]`)
      const expiresIn = args[4] === undefined ? undefined : Number(args[4])
      if (expiresIn !== undefined && (!Number.isInteger(expiresIn) || expiresIn < 0)) throw new Error('EXPIRES_SECONDS 必须是非负整数，0 表示永不过期')
      const result = await this.getClient().unary('CreateToken', { friendlyName: args[1], rootDir: normalizePath(args[2]), permissions: tokenPermissions(args[3]), expiresIn })
      await msg.edit({ text: htmlText(['✅ <b>API Token 已创建</b>', `<b>名称：</b> ${htmlEscape(result.friendlyName || args[1])}`, `<b>Token：</b> <code>${htmlEscape(result.token || '')}</code>`, '<i>请立即保存；后续列表只显示脱敏值。</i>'].join('\n')) })
      return
    }
    if (action === 'modify') {
      if (!args[1] || !args[2]) throw new Error(`用法：${commandName} token modify TOKEN name=... root=/... perm=read|write|full expires=秒 grpc=on|off stream-log=on|off`)
      const options = Object.fromEntries(
        args.slice(2).map((item) => {
          const separator = item.indexOf('=')
          if (separator < 1) throw new Error(`无效参数：${item}`)
          return [item.slice(0, separator).toLowerCase(), item.slice(separator + 1)]
        })
      )
      const request: Record<string, unknown> = { token: args[1] }
      if (options.name !== undefined) request.friendlyName = options.name
      if (options.root !== undefined) request.rootDir = normalizePath(options.root)
      if (options.perm !== undefined) request.permissions = tokenPermissions(options.perm)
      if (options.expires !== undefined) request.expiresIn = Number(options.expires)
      if (options.grpc !== undefined) request.enableGrpcLog = options.grpc === 'on'
      if (options['stream-log'] !== undefined) request.enableStreamFileLog = options['stream-log'] === 'on'
      const result = await this.getClient().unary('ModifyToken', request)
      await msg.edit({ text: htmlText(`✅ Token <code>${htmlEscape(maskToken(result.token || args[1]))}</code> 已修改`) })
      return
    }
    if (action === 'remove') {
      if (!args[1] || args[2]?.toLowerCase() !== 'confirm') throw new Error(`用法：${commandName} token remove TOKEN confirm`)
      await this.getClient().unary('RemoveToken', { value: args[1] })
      await msg.edit({ text: '✅ API Token 已删除' })
      return
    }
    throw new Error(`用法：${commandName} token show|clear|login|list|info|create|modify|remove`)
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

  private async handleFileInfo(msg: MessageContext, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase()
    const targetPath = normalizePath(args.slice(1).join(' '))
    if (!action || !args[1]) throw new Error(`用法：${commandName} file detail|meta|original /路径`)
    if (action === 'detail') {
      const result = await this.getClient().unary('GetFileDetailProperties', { path: targetPath, forceRefresh: false })
      await msg.edit({
        text: htmlText(
          [
            '<b>📄 文件详情</b>',
            `<b>路径：</b> <code>${htmlEscape(targetPath)}</code>`,
            `<b>文件数：</b> ${result.totalFileCount || 0}`,
            `<b>目录数：</b> ${result.totalFolderCount || 0}`,
            `<b>总大小：</b> ${formatBytes(result.totalSize || 0)}`,
            `<b>收藏：</b> ${result.isFaved ? '是' : '否'}`,
            `<b>共享：</b> ${result.isShared ? '是' : '否'}`,
            `<b>原始路径：</b> <code>${htmlEscape(result.originalPath || '')}</code>`
          ].join('\n')
        )
      })
      return
    }
    if (action === 'meta') {
      const result = await this.getClient().unary('GetMetaData', { path: targetPath, forceRefresh: false })
      const entries = Object.entries((result.metadata || {}) as Record<string, string>)
      await msg.edit({ text: htmlText(['<b>🏷 文件元数据</b>', `<b>路径：</b> <code>${htmlEscape(targetPath)}</code>`, '', ...(entries.length ? entries.map(([key, value]) => `<b>${htmlEscape(key)}：</b> <code>${htmlEscape(value)}</code>`) : ['没有元数据'])].join('\n')) })
      return
    }
    if (action === 'original') {
      const result = await this.getClient().unary('GetOriginalPath', { path: targetPath, forceRefresh: false })
      await msg.edit({ text: htmlText(`<b>原始路径：</b> <code>${htmlEscape(result.result || '')}</code>`) })
      return
    }
    throw new Error(`用法：${commandName} file detail|meta|original /路径`)
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
      media: {
        type: 'document',
        file: downloaded.body,
        fileName: fallbackName,
        fileMime: downloaded.contentType,
        caption: htmlText(`✅ 下载完成：<code>${htmlEscape(fallbackName)}</code>`)
      }
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
      const operatorType = args[2] ? { mount: 0, copy: 1, backup: 2, remote: 3 }[args[2].toLowerCase()] : undefined
      const statusFilter = args[3] ? { waiting: 0, preprocessing: 1, cancelled: 2, transfer: 3, paused: 4, finished: 5, skipped: 6, queued: 7, ignored: 8, error: 9, fatal: 10 }[args[3].toLowerCase()] : undefined
      if (args[2] && operatorType === undefined) throw new Error('上传任务类型只支持 mount|copy|backup|remote')
      if (args[3] && statusFilter === undefined) throw new Error('上传状态只支持 waiting|preprocessing|cancelled|transfer|paused|finished|skipped|queued|ignored|error|fatal')
      const result = await this.getClient().unary('GetUploadFileList', { getAll: true, itemsPerPage: MAX_ITEMS, pageNumber: Number.isFinite(page) && page > 0 ? page : 1, operatorTypeFilter: operatorType, statusFilter })
      const files = (result.uploadFiles || []) as RpcResponse[]
      const types = ['挂载', '复制', '备份', '远程上传']
      const lines = files.length ? files.map((item) => `• <code>${htmlEscape(item.destPath || item.key || '')}</code> · ${formatBytes(item.transferedBytes)}/${formatBytes(item.size)} · ${htmlEscape(item.status || '')} · ${types[Number(item.operatorType)] || item.operatorType}`) : ['没有上传任务']
      await msg.edit({
        text: htmlText([`<b>⬆️ 上传任务（筛选 ${result.totalCountFiltered ?? result.totalCount ?? 0}/总计 ${result.totalCount || 0}）</b>`, `<b>速度：</b> ${formatBytes(result.globalBytesPerSecond)}/s · ${formatBytes(result.finishedBytes)}/${formatBytes(result.totalBytes)}`, '', ...lines].join('\n'))
      })
      return
    }
    if (action === 'copies') {
      const result = await this.getClient().unary('GetCopyTasks')
      const tasks = (result.copyTasks || []) as RpcResponse[]
      const statuses = ['等待', '扫描中', '已扫描', '完成', '失败']
      const lines = tasks.length
        ? tasks
            .slice(0, MAX_ITEMS)
            .map(
              (task, index) =>
                `${index + 1}. ${Number(task.taskMode) === 1 ? '移动' : '复制'} · ${statuses[Number(task.status)] || task.status}\n   <code>${htmlEscape(task.sourcePath || '')}</code> → <code>${htmlEscape(task.destPath || '')}</code>\n   文件 ${task.uploadedFiles || 0}/${task.totalFiles || 0} · ${formatBytes(task.uploadedBytes || 0)}/${formatBytes(task.totalBytes || 0)}${task.paused ? ' · ⏸' : ''}`
            )
        : ['没有复制任务']
      await msg.edit({ text: htmlText(['<b>📋 复制/移动任务</b>', '', ...lines].join('\n')) })
      return
    }
    if (action === 'merges') {
      const result = await this.getClient().unary('GetMergeTasks')
      const tasks = (result.mergeTasks || []) as RpcResponse[]
      const statuses = ['等待', '运行中', '完成', '失败', '已取消']
      const lines = tasks.length
        ? tasks
            .slice(0, MAX_ITEMS)
            .map(
              (task, index) =>
                `${index + 1}. ${Number(task.operationType) === 1 ? '复制' : '移动'}合并 · ${statuses[Number(task.status)] || task.status}\n   <code>${htmlEscape(task.sourcePath || '')}</code> → <code>${htmlEscape(task.destPath || '')}</code>\n   文件 ${task.mergedFiles || 0} · 目录 ${task.mergedFolders || 0}${task.errorMessage ? ` · ${htmlEscape(task.errorMessage)}` : ''}`
            )
        : ['没有合并任务']
      await msg.edit({ text: htmlText(['<b>🧩 合并任务</b>', '', ...lines].join('\n')) })
      return
    }
    if (action === 'copy') {
      const operation = args[1]?.toLowerCase()
      if (operation === 'cancel' || operation === 'restart') {
        if (!args[2] || !args[3]) throw new Error(`用法：${commandName} transfer copy ${operation} SOURCE DEST`)
        await this.getClient().unary(operation === 'cancel' ? 'CancelCopyTask' : 'RestartCopyTask', { sourcePath: args[2], destPath: args.slice(3).join(' ') })
      } else if (operation === 'pause-all' || operation === 'resume-all') {
        await this.getClient().unary(operation === 'pause-all' ? 'PauseAllCopyTasks' : 'ResumeAllCopyTasks', operation === 'pause-all' ? { pause: true } : {})
      } else if (operation === 'remove-completed' || operation === 'remove-all') {
        const result = await this.getClient().unary(operation === 'remove-completed' ? 'RemoveCompletedCopyTasks' : 'RemoveAllCopyTasks')
        await msg.edit({ text: `✅ 复制任务已清理${result.affectedCount !== undefined ? `（${result.affectedCount}）` : ''}` })
        return
      } else if (operation === 'pause' || operation === 'resume' || operation === 'remove') {
        const taskKeys = args.slice(2)
        if (!taskKeys.length) throw new Error(`用法：${commandName} transfer copy ${operation} TASK_KEY...`)
        const method = operation === 'pause' ? 'PauseCopyTasks' : operation === 'resume' ? 'ResumeCopyTasks' : 'RemoveCopyTasks'
        const result = await this.getClient().unary(method, { taskKeys, pause: operation === 'pause' })
        if (result.success === false) throw new Error(result.errorMessage || '复制任务控制失败')
        await msg.edit({ text: `✅ 已处理 ${result.affectedCount ?? taskKeys.length} 个复制任务` })
        return
      } else {
        throw new Error(`用法：${commandName} transfer copy pause|resume|remove TASK_KEY...|pause-all|resume-all|remove-completed|remove-all|cancel|restart SOURCE DEST`)
      }
      await msg.edit({ text: '✅ 复制任务控制命令已执行' })
      return
    }
    if (action === 'merge') {
      if (args[1]?.toLowerCase() !== 'cancel' || !args[2] || !args[3]) throw new Error(`用法：${commandName} transfer merge cancel SOURCE DEST`)
      await this.getClient().unary('CancelMergeTask', { sourcePath: args[2], destPath: args.slice(3).join(' ') })
      await msg.edit({ text: '✅ 合并任务已取消' })
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
    if (action === 'oauth-state') {
      if (!args[1] || !args[2]) throw new Error(`用法：${commandName} api oauth-state OAUTH_TYPE RETURN_URL [DEVICE_ID] [CODE_VERIFIER]`)
      const result = await this.getClient().unary('CreateOAuthState', { oauthType: args[1], returnUrl: args[2], deviceId: args[3], codeVerifier: args[4] })
      if (result.success === false) throw new Error(result.errorMessage || '创建 OAuth state 失败')
      await msg.edit({ text: htmlText(['✅ <b>OAuth state 已创建</b>', `<b>State：</b> <code>${htmlEscape(result.state || '')}</code>`, `<b>有效期：</b> ${result.expiresIn || 0} 秒`].join('\n')) })
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
      } else if (type === '115-qrcode' || type === 'aliyun-qrcode' || type === '189-qrcode' || type === '115-open-qrcode' || type === 'guangya-qrcode') {
        method = type === '115-qrcode' ? 'APILogin115QRCode' : type === 'aliyun-qrcode' ? 'APILoginAliyunDriveQRCode' : type === '189-qrcode' ? 'APILogin189QRCode' : type === '115-open-qrcode' ? 'APILogin115OpenQRCode' : 'APILoginGuangYaPanQRCode'
        request = type === '115-qrcode' ? { platformString: args[2] } : type === 'aliyun-qrcode' || type === '189-qrcode' ? { useOpenAPI: args[2]?.toLowerCase() === 'openapi' } : {}
        const messages = await this.getClient().stream(method, request)
        const lines = messages.map((item) => `<b>${htmlEscape(String(item.messageType || '状态'))}</b> ${htmlEscape(item.message || '')}`)
        await msg.edit({ text: htmlText([`<b>🔐 ${htmlEscape(type)} 登录</b>`, '', ...lines].join('\n')) })
        return
      } else if (['aliyun-oauth', 'baidu-oauth', 'onedrive-oauth', 'google-oauth', 'xunlei-oauth', 'xunlei-open', '123-oauth', '115-open', 'guangya-oauth'].includes(type || '')) {
        if (!args[2] || !args[3] || !args[4]) throw new Error(`用法：${commandName} api add ${type} REFRESH_TOKEN ACCESS_TOKEN EXPIRES_IN`)
        method =
          {
            'aliyun-oauth': 'APILoginAliyundriveOAuth',
            'baidu-oauth': 'APILoginBaiduPanOAuth',
            'onedrive-oauth': 'APILoginOneDriveOAuth',
            'google-oauth': 'ApiLoginGoogleDriveOAuth',
            'xunlei-oauth': 'ApiLoginXunleiOAuth',
            'xunlei-open': 'ApiLoginXunleiOpenOAuth',
            '123-oauth': 'ApiLogin123panOAuth',
            '115-open': 'APILogin115OpenOAuth',
            'guangya-oauth': 'APILoginGuangYaPanOAuth'
          }[type || ''] || ''
        request = { refresh_token: args[2], access_token: args[3], expires_in: Number(args[4]) }
      } else if (type === 'aliyun-refresh') {
        if (!args[2]) throw new Error(`用法：${commandName} api add aliyun-refresh REFRESH_TOKEN [openapi]`)
        method = 'APILoginAliyundriveRefreshtoken'
        request = { refreshToken: args[2], useOpenAPI: args[3]?.toLowerCase() === 'openapi' }
      } else if (type === 'google-refresh') {
        if (!args[2] || !args[3] || !args[4]) throw new Error(`用法：${commandName} api add google-refresh CLIENT_ID CLIENT_SECRET REFRESH_TOKEN`)
        method = 'ApiLoginGoogleDriveRefreshToken'
        request = { client_id: args[2], client_secret: args[3], refresh_token: args[4] }
      } else if (type === 's3') {
        if (!args[2] || !args[3] || !args[4] || !args[5]) throw new Error(`用法：${commandName} api add s3 ACCESS_KEY SECRET_KEY REGION BUCKET [ENDPOINT] [path-style]`)
        method = 'APILoginS3'
        request = { accessKeyId: args[2], secretAccessKey: args[3], region: args[4], bucket: args[5], endpoint: args[6], pathStyle: args[7]?.toLowerCase() === 'path-style', doNotSyncToCloud: false, signatureVersion: 4 }
      } else if (type === 'sftp') {
        if (!args[2] || !args[3] || !args[4] || !args[5]) throw new Error(`用法：${commandName} api add sftp HOST PORT USER PASSWORD [ROOT]`)
        method = 'APILoginSftp'
        request = { host: args[2], port: Number(args[3]), userName: args[4], password: args[5], rootPath: args[6] || '/', doNotSyncToCloud: false }
      } else if (type === 'ftp') {
        if (!args[2] || !args[3] || !args[4] || !args[5]) throw new Error(`用法：${commandName} api add ftp HOST PORT USER PASSWORD [ROOT] [tls]`)
        method = 'APILoginFtp'
        request = { host: args[2], port: Number(args[3]), userName: args[4], password: args[5], rootPath: args[6] || '/', useTls: args[7]?.toLowerCase() === 'tls', doNotSyncToCloud: false }
      } else if (type === 'smb') {
        if (!args[2] || !args[3] || !args[4] || !args[5]) throw new Error(`用法：${commandName} api add smb SERVER SHARE USER PASSWORD [ROOT] [WORKGROUP] [PORT]`)
        method = 'APILoginSmb'
        request = { server: args[2], share: args[3], userName: args[4], password: args[5], rootPath: args[6] || '/', workgroup: args[7], port: Number(args[8] || 445), doNotSyncToCloud: false }
      } else if (type === 'clouddrive') {
        if (!args[2] || !args[3]) throw new Error(`用法：${commandName} api add clouddrive GRPC_URL TOKEN [insecure]`)
        method = 'APILoginCloudDrive'
        request = { grpcUrl: args[2], token: args[3], insecureTls: args[4]?.toLowerCase() === 'insecure', doNotSyncToCloud: false }
      } else {
        throw new Error('支持：webdav|local|pikpak|115-cookie|115-qrcode|115-open|115-open-qrcode|aliyun-oauth|aliyun-refresh|aliyun-qrcode|baidu-oauth|onedrive-oauth|google-oauth|google-refresh|xunlei-oauth|xunlei-open|123-oauth|guangya-oauth|guangya-qrcode|s3|sftp|ftp|smb|clouddrive')
      }
      const result = await this.getClient().unary(method, request)
      if (result.success === false) throw new Error(result.errorMessage || '添加云 API 失败')
      await msg.edit({ text: `✅ 云 API 已添加（${htmlEscape(type || method)}）` })
      return
    }
    if (action === 'discover-smb') {
      const result = await this.getClient().unary('DiscoverSmbServers')
      const servers = (result.servers || []) as RpcResponse[]
      const lines = servers.length ? servers.map((server) => `• <b>${htmlEscape(server.name || '未知')}</b> · <code>${htmlEscape(server.address || '')}</code>`) : ['没有发现 SMB 服务器']
      await msg.edit({ text: htmlText(['<b>🖥 SMB 服务器</b>', '', ...lines].join('\n')) })
      return
    }
    if (action === 'discover-smb-shares') {
      if (!args[1] || !args[2] || !args[3]) throw new Error(`用法：${commandName} api discover-smb-shares SERVER USER PASSWORD [WORKGROUP] [PORT]`)
      const result = await this.getClient().unary('DiscoverSmbShares', { server: args[1], userName: args[2], password: args[3], workgroup: args[4], port: Number(args[5] || 445) })
      const shares = (result.shareNames || []) as string[]
      await msg.edit({ text: htmlText(['<b>📂 SMB 共享</b>', '', ...(shares.length ? shares.map((name) => `• <code>${htmlEscape(name)}</code>`) : ['没有发现共享'])].join('\n')) })
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
      const mutable = new Set([
        'maxDownloadThreads',
        'minReadLengthKB',
        'maxReadLengthKB',
        'defaultReadLengthKB',
        'maxBufferPoolSizeMB',
        'maxQueriesPerSecond',
        'forceIpv4',
        'apiProxy',
        'dataProxy',
        'customUserAgent',
        'maxUploadThreads',
        'insecureTls',
        'useHttpDownload',
        'supportDirectLink',
        'useMultithreadDownloaderForCopy'
      ])
      if (!mutable.has(key)) throw new Error(`配置项不可修改；支持：${[...mutable].join('|')}`)
      const booleans = new Set(['forceIpv4', 'insecureTls', 'useHttpDownload', 'supportDirectLink', 'useMultithreadDownloaderForCopy'])
      const proxies = new Set(['apiProxy', 'dataProxy'])
      const value = proxies.has(key) ? parseProxySetting(raw) : booleans.has(key) ? ['true', 'on', '1'].includes(raw.toLowerCase()) : key === 'customUserAgent' ? raw : Number(raw)
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${key} 必须是数字`)
      const current = await this.getClient().unary('GetCloudAPIConfig', { cloudName: args[2], userName: args[3] })
      await this.getClient().unary('SetCloudAPIConfig', { ...current, cloudName: args[2], userName: args[3], [key]: value })
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
    if (action === 'status') {
      if (!args[1]) throw new Error(`用法：${commandName} backup status /源目录`)
      const item = await this.getClient().unary('BackupGetStatus', { value: normalizePath(args[1]) })
      const backup = (item.backup || {}) as RpcResponse
      const destinations = ((backup.destinations || []) as RpcResponse[]).map((entry) => entry.destinationPath).join(', ')
      const rules = (backup.fileBackupRules || []) as RpcResponse[]
      const schedules = (backup.timeSchedules || []) as RpcResponse[]
      await msg.edit({
        text: htmlText(
          [
            '<b>💾 备份详情</b>',
            `<b>源：</b> <code>${htmlEscape(backup.sourcePath || args[1])}</code>`,
            `<b>目标：</b> ${htmlEscape(destinations || '未设置')}`,
            `<b>状态：</b> ${htmlEscape(item.statusMessage || item.status || '未知')}`,
            `<b>文件监听：</b> ${backup.fileSystemWatchEnabled ? '开' : '关'}`,
            `<b>扫描间隔：</b> ${backup.walkingThroughIntervalSecs || 0} 秒`,
            `<b>文件规则：</b> ${rules.length}`,
            `<b>时间计划：</b> ${schedules.length}`,
            `<b>同步删除：</b> ${backup.syncDeleteFromDest ? '开' : '关'}`
          ].join('\n')
        )
      })
      return
    }
    if (action === 'strategy') {
      if (!args[1] || !args[2] || !args[3] || !args[4] || args[5] === undefined) throw new Error(`用法：${commandName} backup strategy /源目录 skip|overwrite|history delete|recycle|keep|history none|source|empty INTERVAL_SECONDS [sync-delete]`)
      const item = await this.getClient().unary('BackupGetStatus', { value: normalizePath(args[1]) })
      const backup = (item.backup || {}) as RpcResponse
      const replace = { skip: 0, overwrite: 1, history: 2 }[args[2].toLowerCase()]
      const deletion = { delete: 0, recycle: 1, keep: 2, history: 3 }[args[3].toLowerCase()]
      const completion = { none: 0, source: 1, empty: 2 }[args[4].toLowerCase()]
      if (replace === undefined || deletion === undefined || completion === undefined) throw new Error('备份策略值无效')
      Object.assign(backup, { fileReplaceRule: replace, fileDeleteRule: deletion, fileCompletionRule: completion, walkingThroughIntervalSecs: Number(args[5]), syncDeleteFromDest: args[6]?.toLowerCase() === 'sync-delete' })
      await this.getClient().unary('BackupUpdate', backup)
      await msg.edit({ text: '✅ 备份替换、删除、完成和扫描策略已更新' })
      return
    }
    if (action === 'schedule') {
      const mode = args[1]?.toLowerCase()
      if (!mode || !args[2]) throw new Error(`用法：${commandName} backup schedule add|clear /源目录 [HH:MM[:SS]] [DAYS]`)
      const item = await this.getClient().unary('BackupGetStatus', { value: normalizePath(args[2]) })
      const backup = (item.backup || {}) as RpcResponse
      if (mode === 'clear') backup.timeSchedules = []
      else if (mode === 'add') {
        if (!args[3] || !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(args[3])) throw new Error('时间格式应为 HH:MM 或 HH:MM:SS')
        const [hour, minute, second = 0] = args[3].split(':').map(Number)
        if (hour > 23 || minute > 59 || second > 59) throw new Error('时间超出有效范围')
        const daysOfWeek = args[4] ? args[4].split(',').map(Number) : []
        backup.timeSchedules = [...((backup.timeSchedules || []) as RpcResponse[]), { isEnabled: true, hour, minute, second, daysOfWeek }]
      } else throw new Error(`用法：${commandName} backup schedule add|clear /源目录 [HH:MM[:SS]] [DAYS]`)
      backup.isTimeSchedulesEnabled = ((backup.timeSchedules || []) as RpcResponse[]).length > 0
      await this.getClient().unary('BackupUpdate', backup)
      await msg.edit({ text: `✅ 备份时间计划已${mode === 'add' ? '添加' : '清空'}` })
      return
    }
    if (action === 'rule') {
      const mode = args[1]?.toLowerCase()
      if (!mode || !args[2]) throw new Error(`用法：${commandName} backup rule add|clear /源目录 [ext|name|regex|min VALUE allow|deny file|folder|both]`)
      const item = await this.getClient().unary('BackupGetStatus', { value: normalizePath(args[2]) })
      const backup = (item.backup || {}) as RpcResponse
      if (mode === 'clear') backup.fileBackupRules = []
      else if (mode === 'add') {
        if (!args[3] || args[4] === undefined) throw new Error(`用法：${commandName} backup rule add /源目录 ext|name|regex|min VALUE allow|deny file|folder|both`)
        const kind = { ext: 'extensions', name: 'fileNames', regex: 'regex', min: 'minSize' }[args[3].toLowerCase()]
        if (!kind) throw new Error('规则类型只支持 ext|name|regex|min')
        const target = args[6]?.toLowerCase() || 'file'
        backup.fileBackupRules = [
          ...((backup.fileBackupRules || []) as RpcResponse[]),
          { kind, value: kind === 'minSize' ? Number(args[4]) : args[4], isEnabled: true, isBlackList: args[5]?.toLowerCase() === 'deny', applyToFolder: target === 'folder' || target === 'both', applyToFile: target === 'file' || target === 'both' }
        ]
      } else throw new Error(`用法：${commandName} backup rule add|clear ...`)
      await this.getClient().unary('BackupUpdate', backup)
      await msg.edit({ text: `✅ 备份文件规则已${mode === 'add' ? '添加' : '清空'}` })
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
    if (action === 'upload') {
      const replied = await safeGetReplyMessage(msg)
      const media = replied?.media as { type?: string; fileName?: string; mimeType?: string } | undefined
      if (!replied || !media) throw new Error(`请回复 Telegram 文件后使用 ${commandName} remote upload /目标目录`)
      const telegram = (await getGlobalClient()) as { downloadAsBuffer: (media: unknown) => Promise<Buffer> }
      await msg.edit({ text: '🔄 正在读取 Telegram 文件…' })
      const data = Buffer.from(await telegram.downloadAsBuffer(media))
      if (data.length > 128 * 1024 * 1024) throw new Error('单个远程上传文件不能超过 128 MiB')
      const fileName = media.fileName || `telegram-${replied.id || Date.now()}.${getMediaExtension(media)}`
      const directory = normalizePath(args[1] || '/')
      const filePath = `${directory === '/' ? '' : directory}/${fileName}`
      await msg.edit({ text: htmlText(`🔄 正在建立官方远程上传通道：<code>${htmlEscape(filePath)}</code>…`) })
      const client = this.getClient()
      const started = await client.unary('StartRemoteUpload', { filePath, fileSize: data.length, knownHashes: {}, clientCanCalculateHashes: true })
      const uploadId = String(started.uploadId || '')
      if (!uploadId) throw new Error('CloudDrive2 未返回远程上传 ID')
      let finalStatus = -1
      let finalError = ''
      await client.consumeServerStream('RemoteUploadChannel', { deviceId: `telebox-${randomUUID()}` }, async (event) => {
        if (event.uploadId && event.uploadId !== uploadId) return true
        if (event.type === 'read') {
          const offset = Number(event.offset || 0)
          const requested = Number(event.length || 0)
          const end = Math.min(data.length, offset + requested)
          const chunk = data.subarray(offset, end)
          const result = await client.unary('RemoteReadData', { uploadId, offset, length: chunk.length, lazyRead: Boolean(event.lazyRead), data: chunk, isLastChunk: end >= data.length })
          if (result.success === false) throw new Error(result.errorMessage || '远程上传数据发送失败')
          const percent = data.length ? Math.min(100, Math.floor((end / data.length) * 100)) : 100
          await msg.edit({ text: htmlText(`🔄 正在远程上传 <code>${htmlEscape(fileName)}</code>：${percent}%`) })
          return true
        }
        if (event.type === 'hash') {
          const hashType = Number(event.hashType || 0)
          const algorithm = hashType === 1 ? 'md5' : 'sha1'
          const hashValue = createHash(algorithm).update(data).digest('hex')
          const blockSize = Number(event.blockSize || 0)
          const blockHashes =
            hashType === 1 && blockSize > 0
              ? Array.from({ length: Math.ceil(data.length / blockSize) }, (_, index) =>
                  createHash('md5')
                    .update(data.subarray(index * blockSize, Math.min(data.length, (index + 1) * blockSize)))
                    .digest('hex')
                )
              : []
          await client.unary('RemoteHashProgress', { uploadId, bytesHashed: data.length, totalBytes: data.length, hashType, hashValue, blockHashes })
          return true
        }
        if (event.type === 'status') {
          finalStatus = Number(event.status || 0)
          finalError = String(event.errorMessage || '')
          if ([2, 5, 6, 8, 9, 10].includes(finalStatus)) return false
        }
        return true
      })
      if ([2, 9, 10].includes(finalStatus)) throw new Error(finalError || `远程上传失败，状态 ${finalStatus}`)
      await msg.edit({ text: htmlText(`✅ 远程上传完成：<code>${htmlEscape(filePath)}</code>`) })
      return
    }
    if (action === 'control') {
      const operation = args[1]?.toLowerCase()
      if (!['pause', 'resume', 'cancel'].includes(operation || '') || !args[2]) throw new Error(`用法：${commandName} remote control pause|resume|cancel UPLOAD_ID`)
      await this.getClient().unary('RemoteUploadControl', { uploadId: args[2], action: operation })
      await msg.edit({ text: `✅ 远程上传已${operation === 'pause' ? '暂停' : operation === 'resume' ? '恢复' : '取消'}` })
      return
    }
    if (action === 'quota') {
      if (!args[1] || !args[2]) throw new Error(`用法：${commandName} remote quota CLOUD_NAME CLOUD_ACCOUNT_ID [PATH]`)
      const result = await this.getClient().unary('GetOfflineQuotaInfo', { cloudName: args[1], cloudAccountId: args[2], path: args[3] })
      await msg.edit({ text: htmlText(['<b>🌐 离线任务配额</b>', `<b>总数：</b> ${result.total || 0}`, `<b>已用：</b> ${result.used || 0}`, `<b>剩余：</b> ${result.left || 0}`].join('\n')) })
      return
    }
    if (action === 'clear') {
      if (!args[1] || !args[2] || !args[3]) throw new Error(`用法：${commandName} remote clear CLOUD_NAME CLOUD_ACCOUNT_ID all|finished|error|downloading [delete] [PATH]`)
      const filter = { all: 0, finished: 1, error: 2, downloading: 3 }[args[3].toLowerCase()]
      if (filter === undefined) throw new Error('筛选只支持 all|finished|error|downloading')
      await this.getClient().unary('ClearOfflineFiles', { cloudName: args[1], cloudAccountId: args[2], filter, deleteFiles: args[4]?.toLowerCase() === 'delete', path: args[5] })
      await msg.edit({ text: '✅ 离线任务已清理' })
      return
    }
    if (action === 'restart') {
      if (!args[1] || !args[2] || !args[3] || !args[4] || !args[5]) throw new Error(`用法：${commandName} remote restart CLOUD_NAME CLOUD_ACCOUNT_ID INFO_HASH URL PARENT_ID [PATH]`)
      await this.getClient().unary('RestartOfflineTask', { cloudName: args[1], cloudAccountId: args[2], infoHash: args[3], url: args[4], parentId: args[5], path: args[6] })
      await msg.edit({ text: '✅ 离线任务已重启' })
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

  private async handleSystem(msg: MessageContext, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase() || 'runtime'
    if (action === 'runtime') {
      const result = await this.getClient().unary('GetRuntimeInfo')
      await msg.edit({
        text: htmlText(
          ['<b>🖥 CloudDrive2 运行环境</b>', `<b>产品：</b> ${htmlEscape(result.productName || '')}`, `<b>版本：</b> ${htmlEscape(result.productVersion || '')}`, `<b>Cloud API：</b> ${htmlEscape(result.cloudApiVersion || '')}`, `<b>系统：</b> ${htmlEscape(result.osInfo || '')}`].join('\n')
        )
      })
      return
    }
    if (action === 'settings') {
      const result = await this.getClient().unary('GetSystemSettings')
      const lines = Object.entries(result).map(([key, value]) => `<b>${htmlEscape(key)}：</b> <code>${htmlEscape(Array.isArray(value) ? value.join(',') : typeof value === 'object' ? JSON.stringify(value) : String(value))}</code>`)
      await msg.edit({ text: htmlText(['<b>⚙️ 系统设置</b>', '', ...lines].join('\n')) })
      return
    }
    if (action === 'set-log') {
      if (args.length < 5) throw new Error(`用法：${commandName} system set-log FILE_MAX_BYTES BACKUP_MAX_BYTES FILE_COUNT BACKUP_COUNT`)
      await this.getClient().unary('SetSystemSettings', { maxFileLogSizeBytes: Number(args[1]), maxBackupLogSizeBytes: Number(args[2]), maxFileLogFiles: Number(args[3]), maxBackupLogFiles: Number(args[4]) })
      await msg.edit({ text: '✅ 日志轮换四项设置已整体更新' })
      return
    }
    if (action === 'set-backup-limits') {
      if (args.length < 4) throw new Error(`用法：${commandName} system set-backup-limits HIGH_WATER LOW_WATER MAX_WALKERS`)
      await this.getClient().unary('SetSystemSettings', { backupQueueHighWater: Number(args[1]), backupQueueLowWater: Number(args[2]), maxConcurrentBackupWalkers: Number(args[3]) })
      await msg.edit({ text: '✅ 备份扫描资源限制三项已整体更新' })
      return
    }
    if (action === 'set') {
      if (!args[1] || args[2] === undefined) throw new Error(`用法：${commandName} system set KEY VALUE`)
      const spec = SYSTEM_SETTING_FIELDS[args[1]]
      if (!spec) throw new Error(`未知设置项；支持：${Object.keys(SYSTEM_SETTING_FIELDS).join('|')}`)
      if (['maxFileLogSizeBytes', 'maxBackupLogSizeBytes', 'maxFileLogFiles', 'maxBackupLogFiles'].includes(args[1])) throw new Error(`日志轮换设置必须整体提交：${commandName} system set-log ...`)
      if (['backupQueueHighWater', 'backupQueueLowWater', 'maxConcurrentBackupWalkers'].includes(args[1])) throw new Error(`备份资源限制必须整体提交：${commandName} system set-backup-limits ...`)
      const raw = args.slice(2).join(' ')
      const value = spec[1] === 'bool' ? raw.toLowerCase() === 'on' || raw.toLowerCase() === 'true' : spec[1] === 'uint' || spec[1] === 'double' ? Number(raw) : spec[1] === 'list' ? raw.split(',').filter(Boolean) : spec[1] === 'proxy' ? parseProxySetting(raw) : raw
      await this.getClient().unary('SetSystemSettings', { [args[1]]: value })
      await msg.edit({ text: `✅ 系统设置 ${args[1]} 已更新` })
      return
    }
    if (action === 'cache') {
      const operation = args[1]?.toLowerCase() || 'stats'
      if (operation === 'stats') {
        const result = await this.getClient().unary('GetFileBufferDiskCacheStats')
        await msg.edit({
          text: htmlText(
            [
              '<b>🗃 文件磁盘缓存</b>',
              `<b>启用：</b> ${result.enabled ? '是' : '否'}`,
              `<b>占用：</b> ${formatBytes(result.totalBytes)} / ${formatBytes(result.maxBytes)}`,
              `<b>条目：</b> ${result.entryCount || 0} · 分段 ${result.segmentCount || 0}`,
              `<b>目录：</b> <code>${htmlEscape(result.rootDir || '')}</code>`,
              `<b>初始扫描：</b> ${result.scanCompleted ? '完成' : '进行中'}`,
              `<b>淘汰策略：</b> ${['LRU', '最大优先', '最小优先'][Number(result.evictionStrategy)] || result.evictionStrategy}`
            ].join('\n')
          )
        })
        return
      }
      if (operation === 'list') {
        const result = await this.getClient().unary('ListDiskCacheFolders')
        const folders = (result.folders || []) as RpcResponse[]
        const lines = folders.length
          ? folders.map((folder) => `• <code>${htmlEscape(folder.path || '')}</code> · ${folder.enabled ? '启用' : '禁用'} · ${formatBytes(folder.minFileSize)}-${formatBytes(folder.maxFileSize)} · ${htmlEscape(((folder.extensions || []) as string[]).join(',') || '全部扩展名')}`)
          : ['没有目录缓存规则']
        await msg.edit({ text: htmlText(['<b>🗃 目录缓存规则</b>', '', ...lines].join('\n')) })
        return
      }
      if (operation === 'purge') {
        if (args[2]?.toLowerCase() !== 'confirm') throw new Error(`用法：${commandName} system cache purge confirm`)
        await this.getClient().unary('PurgeFileBufferDiskCache')
        await msg.edit({ text: '✅ 文件磁盘缓存已清空' })
        return
      }
      if (operation === 'eviction') {
        const strategy = { lru: 0, largest: 1, smallest: 2 }[args[2]?.toLowerCase() || '']
        if (strategy === undefined) throw new Error(`用法：${commandName} system cache eviction lru|largest|smallest`)
        await this.getClient().unary('SetDiskCacheEvictionStrategy', { strategy })
        await msg.edit({ text: '✅ 缓存淘汰策略已更新' })
        return
      }
      if (operation === 'folder') {
        const mode = args[2]?.toLowerCase()
        if (mode === 'remove') {
          if (!args[3]) throw new Error(`用法：${commandName} system cache folder remove /路径`)
          await this.getClient().unary('RemoveFolderDiskCache', { path: normalizePath(args[3]) })
          await msg.edit({ text: '✅ 目录缓存规则已删除' })
          return
        }
        if (mode === 'set') {
          if (!args[3]) throw new Error(`用法：${commandName} system cache folder set /路径 [MAX_BYTES] [MIN_BYTES] disabled|include|exclude [EXT,...] on|off`)
          const filterMode = { disabled: 0, include: 1, exclude: 2 }[args[6]?.toLowerCase() || 'disabled']
          await this.getClient().unary('SetFolderDiskCache', { path: normalizePath(args[3]), maxFileSize: Number(args[4] || 0), minFileSize: Number(args[5] || 0), extensionFilterMode: filterMode, extensions: (args[7] || '').split(',').filter(Boolean), enabled: args[8]?.toLowerCase() !== 'off' })
          await msg.edit({ text: '✅ 目录缓存规则已保存' })
          return
        }
      }
      throw new Error(`用法：${commandName} system cache stats|list|purge|eviction|folder`)
    }
    if (action === 'dir-cache') {
      const operation = args[1]?.toLowerCase()
      if (operation === 'set') {
        if (!args[2]) throw new Error(`用法：${commandName} system dir-cache set /路径 SECONDS|default`)
        await this.getClient().unary('SetDirCacheTimeSecs', { path: normalizePath(args[2]), dirCacheTimeToLiveSecs: args[3]?.toLowerCase() === 'default' || args[3] === undefined ? undefined : Number(args[3]) })
        await msg.edit({ text: '✅ 目录缓存时间已更新' })
        return
      }
      if (operation === 'effective') {
        if (!args[2]) throw new Error(`用法：${commandName} system dir-cache effective /路径`)
        const result = await this.getClient().unary('GetEffectiveDirCacheTimeSecs', { path: normalizePath(args[2]) })
        await msg.edit({ text: `目录缓存有效期：${result.dirCacheTimeSecs || 0} 秒` })
        return
      }
      if (operation === 'expire') {
        if (!args[2]) throw new Error(`用法：${commandName} system dir-cache expire /路径`)
        await this.getClient().unary('ForceExpireDirCache', { path: normalizePath(args[2]) })
        await msg.edit({ text: '✅ 目录缓存已强制过期' })
        return
      }
      if (operation === 'vacuum') {
        await this.getClient().unary('VacuumDirCache')
        await msg.edit({ text: '✅ 目录缓存数据库已整理' })
        return
      }
      if (operation === 'size') {
        const result = await this.getClient().unary('GetDirCacheDbSize')
        await msg.edit({ text: `目录缓存数据库：${formatBytes(result.sizeBytes)}` })
        return
      }
      throw new Error(`用法：${commandName} system dir-cache set|effective|expire|vacuum|size`)
    }
    if (action === 'table') {
      const operation = args[1]?.toLowerCase()
      if (operation === 'open') {
        const result = await this.getClient().unary('GetOpenFileTable', { includeDir: args[2]?.toLowerCase() === 'include-dir' })
        const entries = Object.entries((result.openFiles || {}) as Record<string, string>)
        await msg.edit({
          text: htmlText(['<b>📖 打开文件表</b>', `<b>本地打开数：</b> ${result.localOpenFileCount || 0}`, '', ...(entries.length ? entries.slice(0, MAX_ITEMS).map(([handle, filePath]) => `• <code>${htmlEscape(handle)}</code> ${htmlEscape(filePath)}`) : ['没有打开文件'])].join('\n'))
        })
        return
      }
      if (operation === 'dir') {
        const result = await this.getClient().unary('GetDirCacheTable')
        const entries = Object.entries((result.dirCache || {}) as Record<string, RpcResponse>)
        await msg.edit({
          text: htmlText(
            ['<b>🗂 目录缓存表</b>', '', ...(entries.length ? entries.slice(0, MAX_ITEMS).map(([filePath, item]) => `• <code>${htmlEscape(filePath)}</code> · TTL ${item.timeToLiveSecs || 0}s · 引用 ${item.referencedSubfileLen || 0} · ${htmlEscape(item.insertTime || '')}`) : ['目录缓存为空'])].join(
              '\n'
            )
          )
        })
        return
      }
      if (operation === 'refs') {
        if (!args[2]) throw new Error(`用法：${commandName} system table refs /路径`)
        const result = await this.getClient().unary('GetReferencedEntryPaths', { path: normalizePath(args.slice(2).join(' ')) })
        const paths = (result.paths || []) as string[]
        await msg.edit({ text: htmlText(['<b>🔗 引用路径</b>', '', ...(paths.length ? paths.map((filePath) => `• <code>${htmlEscape(filePath)}</code>`) : ['没有引用路径'])].join('\n')) })
        return
      }
      if (operation === 'temp') {
        const result = await this.getClient().unary('GetTempFileTable')
        const files = (result.tempFiles || []) as string[]
        await msg.edit({ text: htmlText([`<b>🧹 临时文件（${result.count || 0}）</b>`, '', ...(files.length ? files.slice(0, MAX_ITEMS).map((filePath) => `• <code>${htmlEscape(filePath)}</code>`) : ['没有临时文件'])].join('\n')) })
        return
      }
      throw new Error(`用法：${commandName} system table open [include-dir]|dir|refs /路径|temp`)
    }
    if (action === 'capabilities') {
      const result = await this.getClient().unary('GetServiceCapabilities')
      await msg.edit({ text: htmlText(['<b>🧰 服务能力</b>', `<b>服务重启：</b> ${result.canRestart ? '支持' : '不支持'}`, `<b>系统更新：</b> ${result.canUpdate ? '支持' : '不支持'}`].join('\n')) })
      return
    }
    if (action === 'service') {
      const operation = args[1]?.toLowerCase()
      if (!['restart', 'shutdown', 'update'].includes(operation || '') || args[2]?.toLowerCase() !== 'confirm') throw new Error(`用法：${commandName} system service restart|shutdown|update confirm`)
      await msg.edit({ text: `🔄 正在执行服务${operation === 'restart' ? '重启' : operation === 'shutdown' ? '关闭' : '更新'}…` })
      await this.getClient().unary(operation === 'restart' ? 'RestartService' : operation === 'shutdown' ? 'ShutdownService' : 'UpdateSystem')
      return
    }
    if (action === 'web') {
      const operation = args[1]?.toLowerCase() || 'get'
      if (operation === 'get') {
        const result = await this.getClient().unary('GetWebServerConfig')
        await msg.edit({
          text: htmlText(
            [
              '<b>🌐 Web 服务</b>',
              `<b>HTTP：</b> ${result.httpPort || 0}`,
              `<b>HTTPS：</b> ${result.httpsPort || 0}`,
              `<b>启用 HTTPS：</b> ${result.enableHttps ? '是' : '否'}`,
              `<b>证书：</b> <code>${htmlEscape(result.certFile || '')}</code>`,
              `<b>密钥：</b> <code>${htmlEscape(result.keyFile || '')}</code>`
            ].join('\n')
          )
        })
        return
      }
      if (operation === 'set') {
        if (!args[2] || !args[3] || !['on', 'off'].includes(args[4]?.toLowerCase() || '')) throw new Error(`用法：${commandName} system web set HTTP_PORT HTTPS_PORT on|off [CERT_FILE] [KEY_FILE]`)
        await this.getClient().unary('SetWebServerConfig', { httpPort: Number(args[2]), httpsPort: Number(args[3]), enableHttps: args[4].toLowerCase() === 'on', certFile: args[5], keyFile: args[6] })
        await msg.edit({ text: '✅ Web 服务配置已更新' })
        return
      }
      if (operation === 'self-cert') {
        if (args[2]?.toLowerCase() !== 'confirm') throw new Error(`用法：${commandName} system web self-cert confirm`)
        await this.getClient().unary('GenerateSelfSignedCert', { restartServers: true })
        await msg.edit({ text: '✅ 自签名证书已生成并重启 Web 服务' })
        return
      }
    }
    throw new Error(`用法：${commandName} system runtime|settings|set|cache|dir-cache|capabilities|service|web`)
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
        } else if (subcommand === '2fa') {
          await this.handleTwoFactor(msg, args.slice(1))
        } else if (subcommand === 'session') {
          await this.handleSessions(msg, args.slice(1))
        } else if (subcommand === 'check') {
          await this.handleVerify(msg)
        } else if (subcommand === 'status') {
          await this.handleStatus(msg)
        } else if (subcommand === 'ls') {
          await this.handleList(msg, args.slice(1).join(' ') || undefined)
        } else if (subcommand === 'find') {
          if (!args[1]) throw new Error(`用法：${commandName} find /路径/文件`)
          await this.handleFind(msg, args.slice(1).join(' '))
        } else if (subcommand === 'file') {
          await this.handleFileInfo(msg, args.slice(1))
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
        } else if (subcommand === 'system') {
          await this.handleSystem(msg, args.slice(1))
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
