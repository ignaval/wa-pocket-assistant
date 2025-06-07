import { BaileysEventMap, WASocket, WAMessage } from 'baileys'
import { createLogger } from '../logger/index.js'

// Import all the modular handlers
import { 
    initializeContactStore, 
    getContactStore, 
    addContactToStore, 
    updateContactStore,
    saveContactsNow,
    getContactStoreStats,
    getContactFileInfo,
    clearAllContacts
} from './contactStore.js'
import { 
    extractContactFromMessage, 
    fetchInitialContacts, 
    refreshContactsFromActivity,
    manuallyRefreshContacts,
    debugContactInfo
} from './contactExtractor.js'
import { 
    fetchChatListWithTitles, 
    aggressiveFetchChatList,
    getChatList,
    refreshChatList,
    getChatByName,
    testChatListFunctionality
} from './chatListManager.js'
import { 
    fetchContactNamesFromMessageHistory,
    scanMessageHistoryForNames
} from './messageHistoryScanner.js'
import { handlePAMessage } from './messageProcessor.js'

const logger = createLogger('PA-MessageHandler')

// Try to implement store for better chat list capture
let inMemoryStore: any = null

// Function to try initializing the store
async function initializeStore() {
    try {
        // Store is not available in this version, so we'll use event-based approach
        logger.info('📝 Using event-based chat list capture (store not available)')
        return null
    } catch (error) {
        logger.warn('⚠️ Could not initialize store', error)
        return null
    }
}

export function setupPAHandler(sock: WASocket) {
    // Initialize the contact store
    initializeContactStore()
    
    // Initialize store for better chat capture
    initializeStore().then(store => {
        if (store) {
            logger.info('Store initialized, binding to socket events')
            // store.bind(sock.ev) // Would be used if store was available
        }
    })
    
    // Listen for meaningful events only
    const originalEmit = sock.ev.emit.bind(sock.ev)
    sock.ev.emit = function(event: any, ...args: any[]) {
        // Only log events that might contain contact names or important data
        if (event.includes('chat') || event.includes('contact') || event.includes('history') || event.includes('messaging')) {
            const hasContactData = args[0] && (
                (Array.isArray(args[0]) && args[0].some((item: any) => item?.name)) ||
                (args[0]?.contacts && args[0].contacts.length > 0) ||
                (args[0]?.chats && args[0].chats.length > 0)
            )
            
            if (hasContactData || event.includes('messaging-history')) {
                logger.info('📡 Event with contact data', { 
                    event,
                    hasContactData: hasContactData || 'messaging-history',
                    timestamp: new Date().toISOString()
                })
            }
        }
        return originalEmit(event, ...args)
    }
    
    // CRITICAL: Listen for messaging-history.set event - this is where fetchMessageHistory sends the actual messages!
    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => {
        logger.info('🎯 MESSAGING-HISTORY.SET EVENT RECEIVED', {
            chatsCount: chats?.length || 0,
            contactsCount: contacts?.length || 0,
            messagesCount: messages?.length || 0,
            isLatest,
            timestamp: new Date().toISOString()
        })
        
        // Process contacts from history sync
        if (contacts && contacts.length > 0) {
            logger.info('📞 Processing contacts from history sync', { contactCount: contacts.length })
            
            for (const contact of contacts) {
                if (contact.id && contact.name) {
                    addContactToStore(contact.id, {
                        name: contact.name,
                        notify: contact.notify || contact.name
                    })
                    
                    logger.info('✅ Contact name from history sync', {
                        jid: contact.id.split('@')[0],
                        name: contact.name,
                        notify: contact.notify
                    })
                }
            }
        }
        
        // Process messages from history sync to extract contact names
        if (messages && messages.length > 0) {
            logger.info('📨 Processing messages from history sync', { messageCount: messages.length })
            
            let namesFoundFromMessages = 0
            
            for (const message of messages) {
                if (message.key && message.pushName) {
                    const jid = message.key.remoteJid || message.key.participant
                    if (jid && jid.endsWith('@s.whatsapp.net')) {
                        const contactStore = getContactStore()
                        const existingContact = contactStore[jid]
                        if (!existingContact?.name || existingContact.name === jid.split('@')[0]) {
                            addContactToStore(jid, {
                                name: message.pushName,
                                pushName: message.pushName,
                                notify: message.pushName
                            })
                            
                            logger.info('✅ Contact name extracted from history message', {
                                jid: jid.split('@')[0],
                                name: message.pushName,
                                source: 'messaging-history.set'
                            })
                            
                            namesFoundFromMessages++
                        }
                    }
                }
            }
            
            logger.info('📊 Names extracted from history messages', {
                namesFound: namesFoundFromMessages,
                totalMessages: messages.length
            })
        }
        
        // Process chats from history sync (conversation titles!)
        if (chats && chats.length > 0) {
            logger.info('💬 Processing chats from history sync', { chatCount: chats.length })
            
            for (const chat of chats) {
                if (chat.id && chat.name) {
                    addContactToStore(chat.id, {
                        name: chat.name,
                        notify: chat.name
                    })
                    
                    logger.info('✅ Chat title from history sync', {
                        jid: chat.id.split('@')[0],
                        name: chat.name,
                        isIndividual: chat.id.endsWith('@s.whatsapp.net'),
                        isGroup: chat.id.endsWith('@g.us')
                    })
                }
            }
        }
    })
    
    // Listen for chat list updates - this captures conversation titles!
    sock.ev.on('chats.upsert', (chats) => {
        logger.info('🔥 CHATS.UPSERT EVENT RECEIVED', { 
            chatCount: chats.length,
            timestamp: new Date().toISOString()
        })
        
        // Detailed analysis of what we're getting
        const individualChats = chats.filter(chat => chat.id && chat.id.endsWith('@s.whatsapp.net'))
        const groupChats = chats.filter(chat => chat.id && chat.id.endsWith('@g.us'))
        const individualChatsWithNames = individualChats.filter(chat => chat.name && chat.name !== chat.id.split('@')[0])
        
        logger.info('📊 CHAT ANALYSIS', {
            totalChats: chats.length,
            individualChats: individualChats.length,
            groupChats: groupChats.length,
            individualChatsWithNames: individualChatsWithNames.length,
            individualChatSample: individualChats.slice(0, 3).map(chat => ({
                id: chat.id,
                name: chat.name,
                hasName: !!chat.name,
                nameIsPhoneNumber: chat.name === chat.id.split('@')[0]
            }))
        })
        
        if (individualChatsWithNames.length > 0) {
            logger.info('🎉 INDIVIDUAL CONVERSATION TITLES FOUND!', {
                count: individualChatsWithNames.length
            })
        }
        
        // Process each chat to extract names - this includes individual conversation titles
        for (const chat of chats) {
            if (chat.id && chat.name) {
                // This is the conversation title - exactly what you were asking about!
                addContactToStore(chat.id, {
                    name: chat.name,
                    notify: chat.name
                })
                
                logger.info('💾 Chat title captured', {
                    jid: chat.id,
                    chatName: chat.name,
                    isIndividual: chat.id.endsWith('@s.whatsapp.net'),
                    isGroup: chat.id.endsWith('@g.us'),
                    isConversationTitle: chat.id.endsWith('@s.whatsapp.net') && chat.name !== chat.id.split('@')[0]
                })
            }
        }
        
        // Also capture any unread message info that might have contact names
        for (const chat of chats) {
            if (chat.unreadCount && chat.unreadCount > 0) {
                logger.debug('Unread chat detected', {
                    jid: chat.id,
                    name: chat.name,
                    unreadCount: chat.unreadCount
                })
            }
        }
    })

    // Listen for chat updates
    sock.ev.on('chats.update', (chatUpdates) => {
        logger.debug('Chats update event', { 
            updateCount: chatUpdates.length,
            updates: chatUpdates.map(update => ({
                id: update.id,
                name: update.name
            }))
        })
        
        for (const update of chatUpdates) {
            if (update.id && update.name) {
                addContactToStore(update.id, {
                    name: update.name,
                    notify: update.name
                })
                
                logger.info('Chat name updated', {
                    jid: update.id,
                    newName: update.name
                })
            }
        }
    })

    // Handle incoming messages
    sock.ev.on(
        'messages.upsert',
        async ({ messages, type }: BaileysEventMap['messages.upsert']) => {
            logger.info('📨 MESSAGES.UPSERT EVENT', {
                type,
                messageCount: messages.length,
                isNewMessages: type === 'notify',
                isHistoricalMessages: type === 'append',
                timestamp: new Date().toISOString()
            })
            
            // Process historical messages for contact name extraction
            if (type === 'append') {
                logger.info('🎯 PROCESSING HISTORICAL MESSAGES FROM fetchMessageHistory', {
                    messageCount: messages.length
                })
                
                let namesFoundInHistory = 0
                
                for (const message of messages) {
                    // Extract contact information from historical messages
                    extractContactFromMessage(message)
                    
                    // Enhanced name extraction for historical messages
                    if (message.pushName && message.key?.remoteJid?.endsWith('@s.whatsapp.net')) {
                        const jid = message.key.remoteJid
                        const contactStore = getContactStore()
                        const existingContact = contactStore[jid]
                        
                        // Only update if we don't have a name or this is a better name
                        if (!existingContact?.name || existingContact.name === jid.split('@')[0]) {
                            addContactToStore(jid, {
                                name: message.pushName,
                                pushName: message.pushName,
                                notify: message.pushName
                            })
                            
                            logger.info('✅ CONTACT NAME FOUND IN HISTORY!', {
                                jid: jid.split('@')[0],
                                name: message.pushName,
                                source: 'historical_messages',
                                messageTimestamp: message.messageTimestamp
                            })
                            
                            namesFoundInHistory++
                        }
                    }
                }
                
                logger.info('📊 HISTORICAL MESSAGE PROCESSING COMPLETED', {
                    messagesProcessed: messages.length,
                    namesFound: namesFoundInHistory,
                    totalContactsNow: Object.keys(getContactStore()).length,
                    contactsWithNamesNow: Object.values(getContactStore()).filter(c => c.name && c.name !== c.notify).length
                })
                
                return // Don't process historical messages as new messages
            }
            
            // Only process new messages (type === 'notify')
            if (type !== 'notify') return

            for (const message of messages) {
                // Extract contact information from every message
                extractContactFromMessage(message)

                // Skip if no message content
                if (!message.message) continue

                const textContent = 
                    message.message?.conversation || message.message?.extendedTextMessage?.text || ''

                // Check if this is an audio message
                const isAudioMessage = !!message.message?.audioMessage

                // Process messages that start with @PA or audio messages (for 'pocket' detection)
                if (message.key.fromMe && (textContent.startsWith('@PA') || textContent.startsWith('@pa') || isAudioMessage)) {
                    await handlePAMessage(sock, message, true) // Check keywords
                }

                if (message.key.remoteJid === '120363420786683038@g.us') {
                    await handlePAMessage(sock, message, false) // Don't check keywords, process directly
                }
            }
        }
    )

    // Listen for presence updates which might give us contact names
    sock.ev.on('presence.update', (presenceUpdate) => {
        if (presenceUpdate.id && presenceUpdate.id.endsWith('@s.whatsapp.net')) {
            // Sometimes presence updates include contact information
            logger.debug('Presence update received', presenceUpdate)
        }
    })

    // Listen for connection updates to fetch initial contacts when connected
    sock.ev.on('connection.update', async (update) => {
        if (update.connection === 'open') {
            // Fetch initial contacts when connection is established
            setTimeout(async () => {
                await fetchInitialContacts(sock)
                await fetchChatListWithTitles(sock)
                
                // NEW: Use aggressive chat list fetching
                await aggressiveFetchChatList(sock)
                
                // NEW: Fetch contact names from message history
                await fetchContactNamesFromMessageHistory(sock)
                
                // CRITICAL: Save all contacts after initial sync to capture names from first connection
                logger.info('💾 SAVING CONTACTS AFTER INITIAL SYNC')
                await saveContactsNow()
                
                // Set up periodic refresh every 10 minutes
                setInterval(() => {
                    refreshContactsFromActivity(sock)
                }, 10 * 60 * 1000)
                
                // Set up periodic saves every 30 minutes
                setInterval(async () => {
                    logger.info('💾 PERIODIC CONTACT SAVE')
                    await saveContactsNow()
                }, 30 * 60 * 1000)
            }, 3000) // Wait 3 seconds for the connection to fully stabilize
        }
    })

    // Listen for contacts updates to populate our contact store
    sock.ev.on('contacts.upsert', (contacts) => {
        logger.info('Contacts upsert event received', { 
            contactCount: contacts.length,
            contacts: contacts.map(c => ({ id: c.id, name: c.name, notify: c.notify }))
        })
        const contactsObj: { [jid: string]: { name?: string; notify?: string; pushName?: string } } = {}
        for (const contact of contacts) {
            if (contact.id) {
                const contactName = contact.name || contact.notify
                contactsObj[contact.id] = {
                    name: contactName || undefined,
                    notify: contact.notify || contactName || contact.id.split('@')[0]
                }
            }
        }
        updateContactStore(contactsObj)
    })

    // Also listen for contacts.update
    sock.ev.on('contacts.update', (contacts) => {
        logger.debug('Contacts update event received', { contactCount: contacts.length })
        const contactsObj: { [jid: string]: { name?: string; notify?: string; pushName?: string } } = {}
        for (const contact of contacts) {
            if (contact.id) {
                const contactName = contact.name || contact.notify
                contactsObj[contact.id] = {
                    name: contactName || undefined,
                    notify: contact.notify || contactName || contact.id.split('@')[0]
                }
                logger.debug('Contact updated', { 
                    jid: contact.id, 
                    name: contactName, 
                    notify: contact.notify 
                })
            }
        }
        updateContactStore(contactsObj)
    })
}

// Re-export all the functions from the modules for backwards compatibility
export {
    // Contact store functions
    getContactStoreStats,
    getContactFileInfo,
    clearAllContacts,
    saveContactsNow,
    
    // Contact extractor functions
    manuallyRefreshContacts,
    debugContactInfo,
    
    // Chat list manager functions
    getChatList,
    refreshChatList,
    getChatByName,
    testChatListFunctionality,
    
    // Message history scanner functions
    scanMessageHistoryForNames
} 