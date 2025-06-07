import { WASocket } from 'baileys'
import { createLogger } from '../logger/index.js'
import { getContactStore, addContactToStore } from './contactStore.js'

const logger = createLogger('ChatListManager')

// Chat info type definition
export interface ChatInfo {
    jid: string
    name?: string
    notify?: string
    type: 'individual' | 'group'
    lastMessage?: any
}

// Function to manually trigger chat list sync to get conversation titles
export const fetchChatListWithTitles = async (sock: WASocket) => {
    try {
        logger.info('Attempting to fetch chat list with conversation titles...')
        
        // Method 1: Try to manually trigger chat list sync
        try {
            logger.debug('Attempting to manually sync chat list...')
            
            // This might trigger WhatsApp to send us updated chat information
            await sock.presenceSubscribe(sock.user?.id || '')
            
            // Give it a moment to process
            await new Promise(resolve => setTimeout(resolve, 2000))
            
            logger.info('Chat list sync triggered - waiting for chats.upsert events')
            
        } catch (syncError) {
            logger.debug('Manual chat sync failed', syncError)
        }
        
        // Method 2: Try to get profile information to trigger more contact data
        try {
            logger.debug('Checking user profile to trigger contact sync...')
            
            if (sock.user?.id) {
                try {
                    await sock.fetchStatus(sock.user.id)
                } catch (statusError) {
                    logger.debug('Status fetch failed', statusError)
                }
            }
            
        } catch (profileError) {
            logger.debug('Profile check failed', profileError)
        }
        
    } catch (error) {
        logger.error('Failed to fetch chat list with titles', error)
    }
}

// Export function to get chat list with contact names - equivalent to getChatList
export const getChatList = async (sock: WASocket): Promise<ChatInfo[]> => {
    const chatList: ChatInfo[] = []
    
    try {
        logger.info('Generating chat list from contact store...')
        
        const contactStore = getContactStore()
        
        // Get all stored contacts and chats
        for (const [jid, contact] of Object.entries(contactStore)) {
            const chatInfo: ChatInfo = {
                jid,
                name: contact.name,
                notify: contact.notify,
                type: jid.endsWith('@g.us') ? 'group' : 'individual',
                lastMessage: undefined // Could be enhanced to include last message info
            }
            
            chatList.push(chatInfo)
        }
        
        logger.info('Chat list generated', {
            totalChats: chatList.length,
            individualChats: chatList.filter(c => c.type === 'individual').length,
            groupChats: chatList.filter(c => c.type === 'group').length,
            chatsWithNames: chatList.filter(c => c.name && c.name !== c.jid.split('@')[0]).length
        })
        
        return chatList
        
    } catch (error) {
        logger.error('Failed to generate chat list', error)
        return []
    }
}

// Export function to refresh chat list by triggering WhatsApp sync
export const refreshChatList = async (sock: WASocket): Promise<void> => {
    try {
        logger.info('Refreshing chat list...')
        
        // Method 1: Trigger presence to potentially get chat updates
        try {
            if (sock.user?.id) {
                await sock.presenceSubscribe(sock.user.id)
                logger.debug('Presence subscription triggered for chat refresh')
            }
        } catch (presenceError) {
            logger.debug('Presence subscription failed', presenceError)
        }
        
        // Method 2: Try to get groups which also updates group chat info
        try {
            const groups = await sock.groupFetchAllParticipating()
            logger.debug('Group fetch triggered for chat refresh', { groupCount: Object.keys(groups).length })
            
            // This should trigger chats.upsert events for groups
            for (const [groupJid, group] of Object.entries(groups)) {
                addContactToStore(groupJid, {
                    name: group.subject,
                    notify: group.subject
                })
            }
        } catch (groupError) {
            logger.debug('Group fetch failed during refresh', groupError)
        }
        
        // Method 3: Small delay to allow any triggered events to process
        await new Promise(resolve => setTimeout(resolve, 1000))
        
        logger.info('Chat list refresh completed')
        
    } catch (error) {
        logger.error('Failed to refresh chat list', error)
    }
}

// Export function to get a specific chat by JID or name
export const getChatByName = async (name: string): Promise<ChatInfo | null> => {
    try {
        const contactStore = getContactStore()
        
        // Search for exact match first
        for (const [jid, contact] of Object.entries(contactStore)) {
            if (contact.name?.toLowerCase() === name.toLowerCase() || 
                contact.notify?.toLowerCase() === name.toLowerCase()) {
                return {
                    jid,
                    name: contact.name,
                    notify: contact.notify,
                    type: jid.endsWith('@g.us') ? 'group' : 'individual'
                }
            }
        }
        
        // Search for partial match
        for (const [jid, contact] of Object.entries(contactStore)) {
            const contactName = (contact.name || contact.notify || '').toLowerCase()
            if (contactName.includes(name.toLowerCase())) {
                return {
                    jid,
                    name: contact.name,
                    notify: contact.notify,
                    type: jid.endsWith('@g.us') ? 'group' : 'individual'
                }
            }
        }
        
        return null
    } catch (error) {
        logger.error('Failed to get chat by name', error, { name })
        return null
    }
}

// Enhanced function to aggressively fetch chat list with conversation titles
export const aggressiveFetchChatList = async (sock: WASocket) => {
    try {
        logger.debug('🚀 Starting background sync processes...')
        
        const contactStore = getContactStore()
        
        // Background sync - try various methods silently
        const knownJids = Object.keys(contactStore).filter(jid => jid.endsWith('@s.whatsapp.net')).slice(0, 10)
        for (const jid of knownJids) {
            try {
                await sock.presenceSubscribe(jid)
                await new Promise(resolve => setTimeout(resolve, 100))
            } catch (error) {
                // Silent failure
            }
        }
        
        // Try to trigger updates through message history and status checks
        const recentContacts = Object.keys(contactStore).slice(0, 5)
        for (const jid of recentContacts) {
            try {
                await sock.fetchMessageHistory(10, { remoteJid: jid, fromMe: false, id: '' }, 0)
                await new Promise(resolve => setTimeout(resolve, 100))
            } catch (error) {
                // Silent failure
            }
        }
        
        for (const jid of knownJids.slice(0, 3)) {
            try {
                await sock.fetchStatus(jid)
                await new Promise(resolve => setTimeout(resolve, 100))
            } catch (error) {
                // Silent failure
            }
        }
        
        // Set up WebSocket listeners for chat events
        sock.ws.on('CB:chatlist', (node: any) => {
            logger.info('🎯 Chat list event received', { timestamp: new Date().toISOString() })
        })
        
        sock.ws.on('CB:chat', (node: any) => {
            logger.info('🎯 Chat event received', { timestamp: new Date().toISOString() })
        })
        
        logger.debug('🏁 Background sync processes completed')
        
    } catch (error) {
        logger.error('Aggressive chat list fetch failed', error)
    }
}

// Export function to demonstrate getChatList functionality
export const testChatListFunctionality = async (sock: WASocket) => {
    logger.info('Testing Chat List Functionality...')
    
    // 1. Refresh the chat list to get latest data
    await refreshChatList(sock)
    
    // 2. Get contact store statistics
    const contactStore = getContactStore()
    const stats = {
        totalContacts: Object.keys(contactStore).length,
        individualContacts: Object.keys(contactStore).filter(jid => jid.endsWith('@s.whatsapp.net')).length,
        groupChats: Object.keys(contactStore).filter(jid => jid.endsWith('@g.us')).length,
        contactsWithNames: Object.values(contactStore).filter(c => c.name && c.name !== c.notify).length,
        storeCoverage: Object.keys(contactStore).length > 0 ? 
            (Object.values(contactStore).filter(c => c.name && c.name !== c.notify).length / Object.keys(contactStore).length * 100).toFixed(1) + '%' : '0%'
    }
    logger.info('Contact Store Statistics', stats)
    
    // 3. Get the full chat list
    const chatList = await getChatList(sock)
    logger.info('Chat List Retrieved', {
        totalChats: chatList.length,
        // Sample chats omitted for cleaner logging
    })
    
    // 4. Test specific chat lookup
    if (chatList.length > 0) {
        const firstChat = chatList[0]
        if (firstChat.name) {
            const foundChat = await getChatByName(firstChat.name)
            logger.info('Chat lookup test', {
                searchedFor: firstChat.name,
                found: !!foundChat,
                result: foundChat
            })
        }
    }
    
    // 5. Display individual contacts with names (only if any found)
    const individualChatsWithNames = chatList.filter(chat => 
        chat.type === 'individual' && chat.name && chat.name !== chat.jid.split('@')[0]
    )
    
    if (individualChatsWithNames.length > 0) {
        logger.info('✅ Individual Contacts with Names Found', {
            count: individualChatsWithNames.length
        })
    }
    
    return {
        stats,
        chatList,
        individualChatsWithNames: individualChatsWithNames.length
    }
} 