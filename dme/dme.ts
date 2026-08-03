/**
 * DME (Delete My Messages) for TeleBox-Next.
 * All deletion modes try to replace editable media before deleting it.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { MessageContext } from '@mtcute/dispatcher'
import { thtml as html, type Message, type TelegramClient } from '@mtcute/node'
import { createDirectoryInAssets } from '@utils/pathHelpers'
import { Plugin } from '@utils/pluginBase'
import { getPrefixes } from '@utils/pluginManager'
import { getGlobalClient } from '@utils/runtimeManager'
import { safeGetReplyMessage } from '@utils/safeGetMessages'

const CONFIG = {
  TROLL_IMAGE_URL: 'https://raw.githubusercontent.com/TeleBoxOrg/TeleBox-Next/main/telebox.png',
  TROLL_IMAGE_NAME: 'dme_troll_image.png',
  BATCH_SIZE: 50,
  MIN_BATCH_SIZE: 5,
  MAX_BATCH_SIZE: 100,
  RETRY_ATTEMPTS: 3,
  DELAYS: {
    BATCH: 200,
    EDIT_WAIT: 1000,
    SEARCH: 100,
    RETRY: 2000,
    NETWORK_ERROR: 5000
  }
} as const

const mainPrefix = getPrefixes()[0] || '.'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const getErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const getTrollImagePath = (): string => path.join(createDirectoryInAssets('dme'), CONFIG.TROLL_IMAGE_NAME)

async function getTrollImage(): Promise<string | null> {
  const imagePath = getTrollImagePath()
  if (fs.existsSync(imagePath)) return imagePath

  try {
    const response = await fetch(CONFIG.TROLL_IMAGE_URL)
    if (!response.ok) return null
    fs.writeFileSync(imagePath, Buffer.from(await response.arrayBuffer()))
    return imagePath
  } catch (error: unknown) {
    console.error('[dme] Failed to download anti-recall image:', error)
    return null
  }
}

const isOwnMessage = (message: Message, myId: number): boolean => message.sender.id === myId || message.isOutgoing

const canReplaceMedia = (message: Message): boolean => {
  const media = message.media
  return Boolean(media && media.type !== 'webpage' && media.type !== 'sticker')
}

async function editMediaMessageToAntiRecall(client: TelegramClient, chatId: number, message: Message, trollImagePath: string): Promise<boolean> {
  if (!canReplaceMedia(message)) return false
  if (Date.now() - message.date.getTime() > 48 * 60 * 60 * 1000) return false

  try {
    await client.editMessage({
      chatId,
      message: message.id,
      text: '',
      media: {
        type: 'photo',
        file: trollImagePath
      }
    })
    return true
  } catch {
    return false
  }
}

async function deleteMessagesWithRetry(client: TelegramClient, chatId: number, messageIds: number[], retryCount = 0): Promise<number> {
  if (messageIds.length === 0) return 0

  try {
    await client.deleteMessagesById(chatId, messageIds, { revoke: true })
    await client.call({ _: 'updates.getState' }).catch(() => undefined)
    return messageIds.length
  } catch (error: unknown) {
    if (retryCount < CONFIG.RETRY_ATTEMPTS) {
      await sleep(CONFIG.DELAYS.RETRY * (retryCount + 1))
      return deleteMessagesWithRetry(client, chatId, messageIds, retryCount + 1)
    }
    throw error
  }
}

async function adaptiveBatchDelete(client: TelegramClient, chatId: number, messageIds: number[]): Promise<{ deletedCount: number; failedCount: number }> {
  let deletedCount = 0
  let failedCount = 0
  let currentBatchSize: number = CONFIG.BATCH_SIZE
  let index = 0

  while (index < messageIds.length) {
    const batch = messageIds.slice(index, index + currentBatchSize)
    try {
      deletedCount += await deleteMessagesWithRetry(client, chatId, batch)
      index += batch.length
      currentBatchSize = Math.min(CONFIG.MAX_BATCH_SIZE, currentBatchSize + 10)
      await sleep(CONFIG.DELAYS.BATCH)
    } catch (error: unknown) {
      failedCount += batch.length
      index += batch.length
      currentBatchSize = Math.max(CONFIG.MIN_BATCH_SIZE, Math.floor(currentBatchSize / 2))
      await sleep(getErrorMessage(error).includes('FLOOD') ? CONFIG.DELAYS.NETWORK_ERROR : CONFIG.DELAYS.RETRY)
    }
  }

  return { deletedCount, failedCount }
}

async function processBatchWithAntiRecall(client: TelegramClient, chatId: number, messages: Message[]): Promise<{ deleted: number; edited: number }> {
  if (messages.length === 0) return { deleted: 0, edited: 0 }

  let edited = 0
  const trollImagePath = await getTrollImage()
  if (trollImagePath) {
    const results = await Promise.allSettled(messages.map((message) => editMediaMessageToAntiRecall(client, chatId, message, trollImagePath)))
    edited = results.filter((result) => result.status === 'fulfilled' && result.value).length
    if (edited > 0) await sleep(CONFIG.DELAYS.EDIT_WAIT)
  }

  const deletion = await adaptiveBatchDelete(
    client,
    chatId,
    messages.map((message) => message.id)
  )
  return { deleted: deletion.deletedCount, edited }
}

async function deleteRangeMessages(client: TelegramClient, chatId: number, myId: number, startMessageId: number): Promise<{ processedCount: number; editedCount: number }> {
  let processedCount = 0
  let editedCount = 0
  let batch: Message[] = []

  for await (const message of client.iterHistory(chatId, {
    minId: startMessageId - 1
  })) {
    if (!isOwnMessage(message, myId)) continue
    batch.push(message)

    if (batch.length >= CONFIG.BATCH_SIZE) {
      const result = await processBatchWithAntiRecall(client, chatId, batch)
      processedCount += result.deleted
      editedCount += result.edited
      batch = []
    }
  }

  if (batch.length > 0) {
    const result = await processBatchWithAntiRecall(client, chatId, batch)
    processedCount += result.deleted
    editedCount += result.edited
  }

  return { processedCount, editedCount }
}

async function streamSearchAndProcess(client: TelegramClient, chatId: number, myId: number, userRequestedCount: number): Promise<{ processedCount: number; editedCount: number }> {
  const targetCount = userRequestedCount === 999999 ? Infinity : userRequestedCount
  let processedCount = 0
  let editedCount = 0
  let batch: Message[] = []

  for await (const message of client.iterHistory(chatId)) {
    if (!isOwnMessage(message, myId)) continue
    batch.push(message)

    const remaining = targetCount - processedCount
    if (batch.length >= Math.min(CONFIG.BATCH_SIZE, remaining)) {
      const result = await processBatchWithAntiRecall(client, chatId, batch)
      processedCount += result.deleted
      editedCount += result.edited
      batch = []
      if (processedCount >= targetCount) break
      await sleep(CONFIG.DELAYS.SEARCH)
    }
  }

  if (batch.length > 0 && processedCount < targetCount) {
    const remaining = targetCount - processedCount
    const result = await processBatchWithAntiRecall(client, chatId, batch.slice(0, remaining))
    processedCount += result.deleted
    editedCount += result.edited
  }

  return { processedCount, editedCount }
}

const help_text = `🗑️ <b>智能防撤回删除插件</b>（默认防撤回版）

<b>所有操作默认先尝试替换媒体，再删除消息。</b>

<b>指令说明：</b>
• <code>${mainPrefix}dme [数量]</code>
  删除最近 N 条自己的消息。

• <b>回复消息</b> + <code>${mainPrefix}dme</code>
  删除被回复的本人消息。

• <b>回复消息</b> + <code>${mainPrefix}dme -r</code>
  删除从该消息开始到最新的本人消息。

<b>示例：</b>
• <code>${mainPrefix}dme 10</code> - 处理最近 10 条
• <code>${mainPrefix}dme 999</code> - 处理所有能找到的消息`

const dme = async (msg: MessageContext): Promise<void> => {
  const client = await getGlobalClient()
  if (!client) {
    await msg.edit({ text: '❌ 客户端未初始化' })
    return
  }

  const args = msg.text.trim().split(/\s+/).slice(1)
  const firstArg = (args[0] || '').toLowerCase()

  if (firstArg === 'help' || firstArg === 'h') {
    await msg.edit({ text: html(help_text) })
    return
  }

  try {
    const me = await client.getMe()
    const replyMessage = await safeGetReplyMessage(msg)

    await client.deleteMessagesById(msg.chat.id, [msg.id], { revoke: true }).catch(() => undefined)

    if (replyMessage) {
      if (args.includes('-r')) {
        const result = await deleteRangeMessages(client, msg.chat.id, me.id, replyMessage.id)
        console.log(`[dme] Range complete: deleted ${result.processedCount}, edited ${result.editedCount}`)
      } else if (isOwnMessage(replyMessage, me.id)) {
        const result = await processBatchWithAntiRecall(client, msg.chat.id, [replyMessage])
        console.log(`[dme] Reply complete: deleted ${result.deleted}, edited ${result.edited}`)
      }
      return
    }

    const count = Number.parseInt(firstArg, 10)
    if (!Number.isSafeInteger(count) || count <= 0) return

    const result = await streamSearchAndProcess(client, msg.chat.id, me.id, count)
    console.log(`[dme] Count complete: deleted ${result.processedCount}, edited ${result.editedCount}`)
  } catch (error: unknown) {
    console.error('[dme] Execution failed:', error)
  }
}

class DmePlugin extends Plugin {
  description = `智能防撤回删除插件\n\n${help_text}`

  cleanup(): void {
    // This plugin holds no timers, listeners, clients, or open file handles.
  }

  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    dme
  }
}

export default new DmePlugin()
