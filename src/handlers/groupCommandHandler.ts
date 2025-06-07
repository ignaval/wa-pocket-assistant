import { BaileysEventMap, WASocket, WAMessage } from 'baileys'
import { createLogger } from '../logger/index.js'
import { 
    getAllGroups, 
    findGroupByName, 
    listAllGroupNames, 
    setupGroupEventListeners, 
    getGroupsCount, 
    getGroupsCacheInfo 
} from './groupManager.js'

const logger = createLogger('GroupCommandHandler')

export function setupGroupCommandHandler(sock: WASocket) {
    // Set up group event listeners
    setupGroupEventListeners(sock)
    
    // Initialize groups list with delay to avoid rate limiting after connection is established
    sock.ev.on('connection.update', ({ connection }) => {
        if (connection === 'open') {
            setTimeout(async () => {
                try {
                    logger.info('Loading groups...')
                    await getAllGroups(sock)
                    logger.info('Groups loaded successfully')
                } catch (error) {
                    logger.error('Failed to load groups on initial connection', error)
                }
            }, 5000) // Wait 5 seconds after connection before fetching groups
        }
    })
    
    // Handle incoming messages for group commands
    sock.ev.on(
        'messages.upsert',
        async ({ messages, type }: BaileysEventMap['messages.upsert']) => {
            // Only process new messages
            if (type !== 'notify') return

            for (const message of messages) {
                // Skip if no message content
                if (!message.message) continue

                // Skip messages from self
                // if (message.key.fromMe) continue

                await handleGroupCommands(sock, message)
            }
        }
    )
}

async function handleGroupCommands(sock: WASocket, message: WAMessage) {
    try {
        const remoteJid = message.key.remoteJid
        if (!remoteJid) return

        // Get the text content from the message
        const textContent =
            message.message?.conversation || message.message?.extendedTextMessage?.text || ''

        if (!textContent) return

        // Only handle group-related commands
        if (!isGroupCommand(textContent)) return

        logger.info('Group command received', {
            from: remoteJid,
            command: textContent.split(' ')[0],
            messageId: message.key.id
        })

        // Check for groups command
        if (textContent.startsWith('/groups')) {
            await handleGroupsCommand(sock, message)
            return
        }

        // Check for find group command
        if (textContent.startsWith('/findgroup')) {
            const args = textContent.split(' ')
            await handleFindGroupCommand(sock, message, args)
            return
        }

        // Check for cache info command  
        if (textContent.startsWith('/cacheinfo')) {
            await handleCacheInfoCommand(sock, message)
            return
        }

    } catch (error) {
        logger.error('Error handling group command', error, {
            messageId: message.key.id,
            from: message.key.remoteJid
        })
    }
}

// Helper function to check if a message is a group command
function isGroupCommand(text: string): boolean {
    const groupCommands = ['/groups', '/findgroup', '/cacheinfo']
    return groupCommands.some(cmd => text.startsWith(cmd))
}

// Add function to list groups
async function handleGroupsCommand(
    sock: WASocket, 
    message: WAMessage
): Promise<void> {
    const remoteJid = message.key.remoteJid
    if (!remoteJid) return

    try {
        logger.info('Processing groups list command', { from: remoteJid })
        
        // Just get the cached groups list - no need to refresh
        const groupNames = listAllGroupNames()
        
        if (!groupNames.length) {
            await sock.sendMessage(remoteJid, { 
                text: 'No groups found. Make sure you are part of some WhatsApp groups.' 
            })
            return
        }

        const groupsList = groupNames.map((name, index) => `${index + 1}. ${name}`).join('\n')
        
        await sock.sendMessage(remoteJid, { 
            text: `📱 Available Groups (${groupNames.length}):\n\n${groupsList}` 
        })
        
        logger.info('Groups list sent', { groupCount: groupNames.length, to: remoteJid })
        
    } catch (error) {
        logger.error('Groups command failed', error)
        await sock.sendMessage(remoteJid, {
            text: 'Failed to fetch groups list. Please try again.'
        })
    }
}

// Add function to find a specific group
async function handleFindGroupCommand(
    sock: WASocket, 
    message: WAMessage, 
    args: string[]
): Promise<void> {
    const remoteJid = message.key.remoteJid
    if (!remoteJid) return

    try {
        if (args.length < 2) {
            await sock.sendMessage(remoteJid, { 
                text: 'Usage: /findgroup <group_name>\n\nExample: /findgroup Family Chat' 
            })
            return
        }

        const groupName = args.slice(1).join(' ') // Join all args after command
        
        logger.info('Processing find group command', { 
            from: remoteJid, 
            groupName 
        })

        // Find the group by name
        const groupInfo = findGroupByName(groupName)
        
        if (!groupInfo) {
            await sock.sendMessage(remoteJid, { 
                text: `❌ Group "${groupName}" not found.\n\nUse /groups to see all available groups.` 
            })
            return
        }

        await sock.sendMessage(remoteJid, { 
            text: `✅ Found Group:\n\n📱 Name: ${groupInfo.name}\n👥 Participants: ${groupInfo.participantCount}\n🆔 ID: ${groupInfo.jid}${groupInfo.description ? `\n📝 Description: ${groupInfo.description}` : ''}` 
        })
        
        logger.info('Group found and info sent', { 
            groupName: groupInfo.name,
            groupJid: groupInfo.jid,
            to: remoteJid 
        })
        
    } catch (error) {
        logger.error('Find group command failed', error)
        await sock.sendMessage(remoteJid, {
            text: 'Failed to find group. Please try again.'
        })
    }
}

async function handleCacheInfoCommand(
    sock: WASocket, 
    message: WAMessage
): Promise<void> {
    const remoteJid = message.key.remoteJid
    if (!remoteJid) return

    try {
        await sock.sendMessage(remoteJid, { 
            text: '🔍 Checking cache status...' 
        })

        const { exists, ageHours, count, currentCount, countMismatch } = await getGroupsCacheInfo(sock)
        
        const ageText = ageHours === Infinity ? 'No cache' : 
                       ageHours < 1 ? `${Math.round(ageHours * 60)} minutes` :
                       `${Math.round(ageHours)} hours`
        
        let statusText = `📊 Groups Cache Info:\n\n💾 Cache exists: ${exists ? 'Yes' : 'No'}\n⏰ Cache age: ${ageText}\n📱 Cached groups: ${count}`
        
        if (currentCount !== undefined) {
            statusText += `\n🔄 Current groups: ${currentCount}`
            
            if (countMismatch) {
                const difference = currentCount - count
                statusText += `\n⚠️ Count mismatch detected!`
                statusText += `\n📈 Difference: ${difference > 0 ? '+' : ''}${difference}`
                statusText += `\n🔄 Cache will auto-update on next /groups command`
            } else {
                statusText += `\n✅ Cache is up to date`
            }
        }
        
        statusText += `\n\n${exists ? 'Cache auto-refreshes after 24 hours' : 'Cache will be created on next group fetch'}`
        
        await sock.sendMessage(remoteJid, { text: statusText })
        
    } catch (error) {
        logger.error('Cache info command failed', error)
        await sock.sendMessage(remoteJid, {
            text: 'Failed to get cache info.'
        })
    }
} 