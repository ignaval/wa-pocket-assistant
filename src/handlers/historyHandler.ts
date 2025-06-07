import { WASocket, WAMessage, BaileysEventMap } from 'baileys'
import { createLogger } from '../logger/index.js'
import { findGroupByName, listAllGroupNames } from './groupManager.js'
import { 
    FormattedMessage, 
    GroupHistoryData, 
    saveGroupHistory, 
    loadGroupHistory, 
    getGroupHistoryCacheInfo,
    getAllCachedHistories,
    cleanExpiredHistoryCache 
} from '../storage/historyStorage.js'

const logger = createLogger('HistoryHandler')

export function setupHistoryCommandHandler(sock: WASocket): void {
    logger.info('Setting up history command handler')

    // Listen for messages to handle history commands
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const message of messages) {
            if (type === 'notify' && message.message) {
                await handleHistoryCommands(sock, message)
            }
        }
    })

    // Clean expired cache on startup
    cleanExpiredHistoryCache()
    
    logger.info('History command handler setup complete')
}

async function handleHistoryCommands(sock: WASocket, message: WAMessage): Promise<void> {
    const content = message.message
    if (!content) return

    const textMessage = content.conversation || 
                       content.extendedTextMessage?.text || 
                       content.imageMessage?.caption || 
                       content.videoMessage?.caption
    
    if (!textMessage) return

    const text = textMessage.trim()
    const fromJid = message.key.remoteJid
    
    if (!fromJid) return

    try {
        if (text === '/history' || text.startsWith('/history ')) {
            await handleHistoryCommand(sock, fromJid, text, message)
        } else if (text === '/summary' || text.startsWith('/summary ')) {
            await handleSummaryCommand(sock, fromJid, text, message)
        } else if (text === '/historyinfo' || text.startsWith('/historyinfo ')) {
            await handleHistoryInfoCommand(sock, fromJid, text)
        } else if (text === '/cachedhistories') {
            await handleCachedHistoriesCommand(sock, fromJid)
        }
    } catch (error) {
        logger.error('Error handling history command', { error, text, fromJid })
        await sock.sendMessage(fromJid, {
            text: '❌ An error occurred while processing your command. Please try again later.'
        })
    }
}

async function handleHistoryCommand(
    sock: WASocket, 
    fromJid: string, 
    text: string, 
    message: WAMessage
): Promise<void> {
    const args = text.split(' ')
    
    if (args.length < 2) {
        const groupNames = listAllGroupNames()
        let response = `📋 Available groups for history:\n\n`
        
        if (groupNames.length === 0) {
            response += `No groups available. Use /groups to see all groups.`
        } else {
            groupNames.slice(0, 20).forEach((name, index) => {
                response += `${index + 1}. ${name}\n`
            })
            
            if (groupNames.length > 20) {
                response += `\n... and ${groupNames.length - 20} more groups`
            }
            
            response += `\n\n💡 Usage: /history <group_name>`
        }
        
        await sock.sendMessage(fromJid, { text: response })
        return
    }

    const groupName = args.slice(1).join(' ')

    try {
        logger.info('Fetching history for group', { groupName })
        const historyData = await getGroupHistory(groupName)
        const response = formatHistoryResponse(historyData)
        await sock.sendMessage(fromJid, { text: response }, { quoted: message })
    } catch (error) {
        logger.error('Error fetching group history', { error, groupName })
        await sock.sendMessage(fromJid, {
            text: `❌ Failed to fetch history for "${groupName}". Please check the group name and try again.`
        }, { quoted: message })
    }
}

async function handleSummaryCommand(
    sock: WASocket, 
    fromJid: string, 
    text: string, 
    message: WAMessage
): Promise<void> {
    const args = text.split(' ')
    
    if (args.length < 2) {
        await sock.sendMessage(fromJid, {
            text: `💡 Usage: /summary <group_name>\n\nExample: /summary Tech Discussion`
        })
        return
    }

    const groupName = args.slice(1).join(' ')

    try {
        logger.info('Generating summary for group', { groupName })
        const historyData = await getGroupHistory(groupName)
        const response = formatAISummaryPlaceholder(historyData)
        await sock.sendMessage(fromJid, { text: response }, { quoted: message })
    } catch (error) {
        logger.error('Error generating summary', { error, groupName })
        await sock.sendMessage(fromJid, {
            text: `❌ Failed to generate summary for "${groupName}". Please check the group name and try again.`
        }, { quoted: message })
    }
}

async function handleHistoryInfoCommand(
    sock: WASocket, 
    fromJid: string, 
    text: string
): Promise<void> {
    const args = text.split(' ')
    
    if (args.length < 2) {
        await sock.sendMessage(fromJid, {
            text: `💡 Usage: /historyinfo <group_name>\n\nExample: /historyinfo Tech Discussion`
        })
        return
    }

    const groupName = args.slice(1).join(' ')
    
    // Find the group to get its JID
    const groupInfo = findGroupByName(groupName)
    if (!groupInfo) {
        await sock.sendMessage(fromJid, {
            text: `❌ Group "${groupName}" not found.\n\nUse /groups to see all available groups.`
        })
        return
    }
    
    const cacheInfo = await getGroupHistoryCacheInfo(groupInfo.jid)
    
    let response = `📊 History Cache Info for "${groupName}":\n\n`
    
    if (cacheInfo.exists) {
        const ageHours = Math.floor(cacheInfo.ageHours)
        const ageMinutes = Math.floor((cacheInfo.ageHours % 1) * 60)
        
        response += `✅ Cache Status: Available\n`
        response += `📅 Last Updated: ${ageHours}h ${ageMinutes}m ago\n`
        response += `💬 Message Count: ${cacheInfo.messageCount}\n`
        response += `🔄 Is Expired: ${cacheInfo.ageHours > 6 ? 'Yes' : 'No'}`
    } else {
        response += `❌ Cache Status: Not Available\n`
        response += `💡 Use /history ${groupName} to fetch and cache history`
    }
    
    await sock.sendMessage(fromJid, { text: response })
}

async function handleCachedHistoriesCommand(sock: WASocket, fromJid: string): Promise<void> {
    const cachedHistories = await getAllCachedHistories()
    
    let response = `📚 Cached Group Histories:\n\n`
    
    if (cachedHistories.length === 0) {
        response += `No cached histories available.\n\n`
        response += `💡 Use /history <group_name> to start caching group histories.`
    } else {
        cachedHistories.forEach((history, index) => {
            const ageHours = Math.floor(history.ageHours)
            response += `${index + 1}. ${history.groupName}\n`
            response += `   💬 ${history.messageCount} messages\n`
            response += `   ⏰ ${ageHours}h ago\n\n`
        })
        
        response += `Total: ${cachedHistories.length} cached histories`
    }
    
    await sock.sendMessage(fromJid, { text: response })
}

async function getGroupHistory(groupName: string): Promise<GroupHistoryData> {
    // Find the group
    const groupInfo = findGroupByName(groupName)
    if (!groupInfo) {
        throw new Error(`Group "${groupName}" not found`)
    }

    // First check cache
    const cachedHistory = await loadGroupHistory(groupInfo.jid)
    if (cachedHistory) {
        logger.info('Using cached history', { groupName, messageCount: cachedHistory.messageCount })
        return cachedHistory
    }

    // No cache available - return empty history with explanation
    logger.info('No cached history available', { groupName, groupJid: groupInfo.jid })
    
    const historyData: GroupHistoryData = {
        groupJid: groupInfo.jid,
        groupName: groupInfo.name,
        messages: [],
        fetchedAt: Date.now(),
        messageCount: 0,
        period: 'No historical messages available'
    }
    
    return historyData
}

function formatHistoryResponse(historyData: GroupHistoryData): string {
    let response = `📜 Message History for "${historyData.groupName}"\n`
    response += `🔢 Total Messages: ${historyData.messageCount}\n`
    response += `📅 Fetched: ${new Date(historyData.fetchedAt).toLocaleString()}\n\n`
    
    if (historyData.messageCount === 0) {
        response += `❌ No message history available.\n\n`
        response += `📋 Current Status:\n`
        response += `• WhatsApp's fetchMessageHistory API has limitations\n`
        response += `• Historical messages require existing message references\n`
        response += `• The bot needs to be present when messages are sent\n\n`
        response += `💡 To get historical messages:\n`
        response += `• Enable syncFullHistory in your bot configuration\n`
        response += `• Use fetchMessageHistory with an existing message key\n`
        response += `• Implement a real-time message collector for active groups\n`
        response += `• Consider using WhatsApp Business API for better history access`
        return response
    }

    response += `💬 Recent Messages:\n\n`
    
    // Show last 15 messages
    const messagesToShow = historyData.messages.slice(0, 15)
    
    messagesToShow.forEach((msg, index) => {
        const time = new Date(msg.timestamp).toLocaleTimeString()
        const senderName = msg.sender.split('@')[0].slice(-4) // Last 4 digits
        const messageText = msg.content.length > 100 ? msg.content.substring(0, 100) + '...' : msg.content
        
        response += `${index + 1}. [${time}] ${senderName}: ${messageText}\n`
    })
    
    if (historyData.messageCount > 15) {
        response += `\n... and ${historyData.messageCount - 15} more messages`
    }
    
    response += `\n\n💡 Use /summary ${historyData.groupName} for AI analysis`
    
    return response
}

function formatAISummaryPlaceholder(historyData: GroupHistoryData): string {
    const textMessages = historyData.messages.filter(m => m.type === 'text')
    const mediaCount = historyData.messages.filter(m => m.type === 'media').length
    const participants = [...new Set(historyData.messages.map(m => m.sender))]
    
    let summary = `🤖 AI Summary for "${historyData.groupName}"\n`
    summary += `📊 Analysis of ${historyData.messageCount} messages\n\n`
    summary += `👥 Active participants: ${participants.length}\n`
    summary += `💬 Text messages: ${textMessages.length}\n`
    summary += `📎 Media messages: ${mediaCount}\n\n`
    
    if (historyData.messageCount === 0) {
        summary += `❌ No messages available for analysis.\n\n`
        summary += `📋 This is because:\n`
        summary += `• WhatsApp's API requires the bot to be present when messages are sent\n`
        summary += `• Historical message fetching has strict API limitations\n`
        summary += `• No cached messages are available for this group\n\n`
        summary += `💡 To enable summaries:\n`
        summary += `1. Configure syncFullHistory: true in your socket settings\n`
        summary += `2. Use the fetchMessageHistory API with existing message references\n`
        summary += `3. Implement real-time message collection for active groups\n`
        summary += `4. Then use this command again for AI analysis`
        return summary
    }
    
    summary += `🔮 AI Summary:\n`
    summary += `[AI summary integration coming in Step 3...]\n\n`
    summary += `💡 This will analyze conversation topics, sentiment, and key discussions.\n`
    summary += `🎯 Perfect for summarizing group discussions and important decisions!`
    
    return summary
} 