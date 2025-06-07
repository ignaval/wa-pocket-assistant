import fs from 'fs/promises'
import path from 'path'
import { createLogger } from '../logger/index.js'

const logger = createLogger('HistoryStorage')

export interface FormattedMessage {
    timestamp: string
    sender: string
    content: string
    type: 'text' | 'media' | 'system'
    messageId?: string
}

export interface GroupHistoryData {
    groupJid: string
    groupName: string
    messages: FormattedMessage[]
    fetchedAt: number
    messageCount: number
    period: string
}

export interface HistoryCacheInfo {
    exists: boolean
    ageHours: number
    messageCount: number
    fetchedAt?: number
}

// Cache duration in hours
const CACHE_DURATION_HOURS = 6

// Storage paths
const HISTORY_CACHE_DIR = 'history_cache'
const HISTORY_INDEX_FILE = path.join(HISTORY_CACHE_DIR, 'history_index.json')

// Ensure cache directory exists
async function ensureCacheDir() {
    try {
        await fs.mkdir(HISTORY_CACHE_DIR, { recursive: true })
    } catch (error) {
        logger.error('Failed to create history cache directory', error)
    }
}

// Get cache file path for a group
function getGroupCacheFile(groupJid: string): string {
    const sanitizedJid = groupJid.replace(/[^a-zA-Z0-9]/g, '_')
    return path.join(HISTORY_CACHE_DIR, `${sanitizedJid}_history.json`)
}

// Save group history to cache
export async function saveGroupHistory(historyData: GroupHistoryData): Promise<void> {
    try {
        await ensureCacheDir()
        
        const cacheFile = getGroupCacheFile(historyData.groupJid)
        const dataToSave = {
            ...historyData,
            fetchedAt: Date.now()
        }
        
        await fs.writeFile(cacheFile, JSON.stringify(dataToSave, null, 2))
        
        // Update index
        await updateHistoryIndex(historyData.groupJid, historyData.groupName, dataToSave.fetchedAt)
        
        logger.info('Group history saved to cache', {
            groupJid: historyData.groupJid,
            groupName: historyData.groupName,
            messageCount: historyData.messageCount
        })
        
    } catch (error) {
        logger.error('Failed to save group history', error)
        throw error
    }
}

// Load group history from cache
export async function loadGroupHistory(groupJid: string): Promise<GroupHistoryData | null> {
    try {
        const cacheFile = getGroupCacheFile(groupJid)
        const data = await fs.readFile(cacheFile, 'utf8')
        const historyData: GroupHistoryData = JSON.parse(data)
        
        // Check if cache is still valid
        const ageHours = (Date.now() - historyData.fetchedAt) / (1000 * 60 * 60)
        if (ageHours > CACHE_DURATION_HOURS) {
            logger.info('History cache expired', { groupJid, ageHours })
            return null
        }
        
        logger.info('Group history loaded from cache', {
            groupJid: historyData.groupJid,
            messageCount: historyData.messageCount,
            ageHours: Math.round(ageHours * 100) / 100
        })
        
        return historyData
        
    } catch (error) {
        if ((error as any).code === 'ENOENT') {
            logger.debug('No history cache found', { groupJid })
            return null
        }
        logger.error('Failed to load group history', error)
        return null
    }
}

// Get cache info for a group
export async function getGroupHistoryCacheInfo(groupJid: string): Promise<HistoryCacheInfo> {
    try {
        const cacheFile = getGroupCacheFile(groupJid)
        const data = await fs.readFile(cacheFile, 'utf8')
        const historyData: GroupHistoryData = JSON.parse(data)
        
        const ageHours = (Date.now() - historyData.fetchedAt) / (1000 * 60 * 60)
        
        return {
            exists: true,
            ageHours,
            messageCount: historyData.messageCount,
            fetchedAt: historyData.fetchedAt
        }
        
    } catch (error) {
        return {
            exists: false,
            ageHours: Infinity,
            messageCount: 0
        }
    }
}

// Update history index for quick lookups
async function updateHistoryIndex(groupJid: string, groupName: string, fetchedAt: number): Promise<void> {
    try {
        let index: Record<string, { groupName: string, fetchedAt: number }> = {}
        
        try {
            const indexData = await fs.readFile(HISTORY_INDEX_FILE, 'utf8')
            index = JSON.parse(indexData)
        } catch {
            // Index doesn't exist, start fresh
        }
        
        index[groupJid] = { groupName, fetchedAt }
        
        await fs.writeFile(HISTORY_INDEX_FILE, JSON.stringify(index, null, 2))
        
    } catch (error) {
        logger.error('Failed to update history index', error)
    }
}

// Get all cached group histories
export async function getAllCachedHistories(): Promise<Array<{ groupJid: string, groupName: string, ageHours: number, messageCount: number }>> {
    try {
        const indexData = await fs.readFile(HISTORY_INDEX_FILE, 'utf8')
        const index: Record<string, { groupName: string, fetchedAt: number }> = JSON.parse(indexData)
        
        const results = []
        
        for (const [groupJid, info] of Object.entries(index)) {
            const cacheInfo = await getGroupHistoryCacheInfo(groupJid)
            if (cacheInfo.exists) {
                results.push({
                    groupJid,
                    groupName: info.groupName,
                    ageHours: cacheInfo.ageHours,
                    messageCount: cacheInfo.messageCount
                })
            }
        }
        
        return results.sort((a, b) => a.ageHours - b.ageHours) // Most recent first
        
    } catch (error) {
        logger.debug('No history index found or failed to read')
        return []
    }
}

// Clean expired cache files
export async function cleanExpiredHistoryCache(): Promise<void> {
    try {
        const cachedHistories = await getAllCachedHistories()
        let cleanedCount = 0
        
        for (const history of cachedHistories) {
            if (history.ageHours > CACHE_DURATION_HOURS) {
                const cacheFile = getGroupCacheFile(history.groupJid)
                try {
                    await fs.unlink(cacheFile)
                    cleanedCount++
                } catch (error) {
                    logger.warn('Failed to delete expired cache file', { cacheFile, error })
                }
            }
        }
        
        if (cleanedCount > 0) {
            logger.info('Cleaned expired history cache files', { cleanedCount })
        }
        
    } catch (error) {
        logger.error('Failed to clean expired cache', error)
    }
} 