import { WASocket, WAMessage } from 'baileys'
import { createLogger } from '../logger/index.js'
import { GroupsStorage } from '../storage/groupsStorage.js'

const logger = createLogger('GroupManager')

export interface GroupInfo {
    jid: string
    name: string
    description?: string
    participantCount: number
}

// Store for groups - in production, use a database
const groupsCache = new Map<string, GroupInfo>()

// Persistent storage instance
const groupsStorage = new GroupsStorage('groups_cache.json', 24) // 24 hour cache

// Helper function to check if group count has changed
async function checkIfGroupCountChanged(sock: WASocket, cachedCount: number): Promise<boolean> {
    try {
        logger.info('Checking if group count has changed', { cachedCount })
        
        // Get current groups from WhatsApp (lightweight call)
        const currentGroups = await sock.groupFetchAllParticipating()
        const currentCount = Object.keys(currentGroups).length
        
        logger.info('Group count comparison', { cachedCount, currentCount })
        
        if (currentCount !== cachedCount) {
            logger.info('Group count mismatch detected', { 
                cached: cachedCount, 
                current: currentCount,
                difference: currentCount - cachedCount
            })
            return true
        }
        
        logger.info('Group count matches, using cache')
        return false
        
    } catch (error) {
        logger.error('Failed to check group count, using cache anyway', error)
        // If we can't check, assume cache is still valid
        return false
    }
}

export async function getAllGroups(sock: WASocket, forceRefresh: boolean = false): Promise<GroupInfo[]> {
    try {
        // Try to load from cache first (unless forced refresh)
        if (!forceRefresh) {
            const cachedGroups = await groupsStorage.loadGroups()
            if (cachedGroups.length > 0) {
                // Check if the number of groups has changed
                const shouldUpdateCache = await checkIfGroupCountChanged(sock, cachedGroups.length)
                
                if (shouldUpdateCache) {
                    logger.info('Group count changed, refreshing cache')
                    // Continue to fetch fresh data below
                } else {
                    // Populate the in-memory cache
                    groupsCache.clear()
                    cachedGroups.forEach(group => groupsCache.set(group.jid, group))
                    logger.info(`Loaded ${cachedGroups.length} groups from cache`)
                    return cachedGroups
                }
            }
        }

        logger.info('Fetching all participating groups from WhatsApp')
        
        // Get all participating groups from WhatsApp API
        const groups = await sock.groupFetchAllParticipating()
        
        const groupInfos: GroupInfo[] = []
        
        for (const [jid, groupData] of Object.entries(groups)) {
            const groupInfo: GroupInfo = {
                jid,
                name: groupData.subject || 'Unknown Group',
                description: groupData.desc,
                participantCount: groupData.participants?.length || 0
            }
            
            // Cache the group info in memory
            groupsCache.set(jid, groupInfo)
            groupInfos.push(groupInfo)
        }
        
        // Save to persistent storage
        await groupsStorage.saveGroups(groupInfos)
        
        logger.info(`Found and cached ${groupInfos.length} groups`)
        return groupInfos
        
    } catch (error: any) {
        if (error.message === 'rate-overlimit') {
            logger.warn('Rate limit hit while fetching groups, trying cache')
            // Try to return cached groups even if expired
            const cachedGroups = await groupsStorage.loadGroups()
            if (cachedGroups.length > 0) {
                cachedGroups.forEach(group => groupsCache.set(group.jid, group))
                return cachedGroups
            }
            // Return in-memory cache as last resort
            return Array.from(groupsCache.values())
        }
        logger.error('Failed to fetch groups', error)
        throw error
    }
}

export function findGroupByName(groupName: string): GroupInfo | null {
    // Normalize the search term
    const searchTerm = groupName.toLowerCase().trim()
    
    // First try exact match
    for (const group of groupsCache.values()) {
        if (group.name.toLowerCase() === searchTerm) {
            return group
        }
    }
    
    // Then try partial match
    for (const group of groupsCache.values()) {
        if (group.name.toLowerCase().includes(searchTerm)) {
            return group
        }
    }
    
    return null
}

export function listAllGroupNames(): string[] {
    return Array.from(groupsCache.values()).map(group => group.name)
}

export function getGroupsCount(): number {
    return groupsCache.size
}

export function getGroupByJid(jid: string): GroupInfo | null {
    return groupsCache.get(jid) || null
}

// Add function to get cache info
export async function getGroupsCacheInfo(sock?: WASocket): Promise<{ 
    exists: boolean; 
    ageHours: number; 
    count: number;
    currentCount?: number;
    countMismatch?: boolean;
}> {
    const exists = await groupsStorage.cacheExists()
    const ageHours = await groupsStorage.getCacheAge()
    const count = groupsCache.size
    
    let currentCount: number | undefined
    let countMismatch: boolean | undefined
    
    // If socket is provided, check current group count
    if (sock && exists) {
        try {
            const currentGroups = await sock.groupFetchAllParticipating()
            currentCount = Object.keys(currentGroups).length
            countMismatch = currentCount !== count
        } catch (error) {
            logger.warn('Could not fetch current group count for comparison', error)
        }
    }
    
    return { exists, ageHours, count, currentCount, countMismatch }
}

// Rate limiting queue for metadata requests
const metadataQueue: Array<{ jid: string; retryCount: number }> = []
let isProcessingQueue = false

// Helper function to fetch metadata with rate limiting
async function fetchMetadataWithRateLimit(sock: WASocket, jid: string, retryCount = 0): Promise<boolean> {
    try {
        // Add delay to avoid rate limiting - start with longer delays
        const delay = 2000 + (retryCount * 3000) // 2s, 5s, 8s, 11s
        logger.debug('Fetching group metadata', { jid, retryCount, delay })
        await new Promise(resolve => setTimeout(resolve, delay))
        
        const metadata = await sock.groupMetadata(jid)
        const groupInfo: GroupInfo = {
            jid,
            name: metadata.subject || 'Unknown Group',
            description: metadata.desc,
            participantCount: metadata.participants?.length || 0
        }
        
        groupsCache.set(jid, groupInfo)
        logger.info('Successfully cached group', { jid, name: groupInfo.name, participantCount: groupInfo.participantCount })
        return true
        
    } catch (error: any) {
        if (error.message === 'rate-overlimit' && retryCount < 3) {
            // Add to queue for retry with exponential backoff
            logger.warn('Rate limit hit, will retry later', { jid, retryCount: retryCount + 1 })
            metadataQueue.push({ jid, retryCount: retryCount + 1 })
            return false
        } else {
            logger.error('Failed to fetch group metadata', error, { jid, retryCount })
            return false
        }
    }
}

// Process metadata queue with delays
async function processMetadataQueue(sock: WASocket) {
    if (isProcessingQueue) {
        logger.debug('Queue processing already in progress')
        return
    }
    
    if (metadataQueue.length === 0) {
        logger.debug('Queue is empty, nothing to process')
        return
    }
    
    isProcessingQueue = true
    logger.info('Starting queue processing', { queueLength: metadataQueue.length })
    
    let processed = 0
    let successful = 0
    
    while (metadataQueue.length > 0) {
        const item = metadataQueue.shift()
        if (item) {
            processed++
            const success = await fetchMetadataWithRateLimit(sock, item.jid, item.retryCount)
            if (success) successful++
            
            // Log progress every 10 items
            if (processed % 10 === 0) {
                logger.info('Queue processing progress', { 
                    processed, 
                    successful, 
                    remaining: metadataQueue.length 
                })
            }
        }
    }
    
    isProcessingQueue = false
    logger.info('Queue processing completed', { processed, successful })
    
    // If there are still items in the queue (from retries), schedule another processing round
    if (metadataQueue.length > 0) {
        logger.info('Retries added to queue, scheduling next processing round', { queueLength: metadataQueue.length })
        setTimeout(() => processMetadataQueue(sock), 10000) // Wait 10 seconds before processing retries
    }
}

// Listen for group updates to keep cache fresh
export function setupGroupEventListeners(sock: WASocket) {
    sock.ev.on('groups.update', async (updates) => {
        // Only process updates if we have groups cached (avoid initial load processing)
        if (groupsCache.size === 0) {
            logger.debug('Ignoring groups.update events during initial load', { updateCount: updates.length })
            return
        }
        
        logger.info('Processing groups.update events', { updateCount: updates.length })
        
        // Add all updates to queue instead of processing immediately
        for (const update of updates) {
            metadataQueue.push({ jid: update.id, retryCount: 0 })
        }
        
        // Process queue with rate limiting
        setTimeout(() => processMetadataQueue(sock), 2000) // Wait 2 seconds before processing
    })

    // Listen for when user joins/leaves groups
    sock.ev.on('group-participants.update', async (event) => {
        try {
            // If it's about the current user and they left, remove from cache
            const userId = sock.user?.id
            if (event.action === 'remove' && userId && event.participants?.includes(userId)) {
                groupsCache.delete(event.id)
                logger.info('Removed group from cache after leaving', { jid: event.id })
                return
            }
            
            // For other updates, just update participant count if we already have the group
            const existingGroup = groupsCache.get(event.id)
            if (existingGroup) {
                // Queue for metadata update instead of doing it immediately
                metadataQueue.push({ jid: event.id, retryCount: 0 })
                setTimeout(() => processMetadataQueue(sock), 3000)
            }
        } catch (error) {
            logger.error('Failed to handle group participant update', error, { jid: event.id })
        }
    })
} 