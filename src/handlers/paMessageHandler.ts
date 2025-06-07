import { BaileysEventMap, WASocket, WAMessage, downloadMediaMessage } from 'baileys'
import * as fs from 'fs'
import * as path from 'path'

import { config } from '../config/index.js'
import { generateResponse, transcribeAudio } from '../ai/openai.js'
import { createLogger } from '../logger/index.js'

const logger = createLogger('PA-MessageHandler')

// Contact persistence configuration
const CONTACTS_FILE_PATH = path.join(process.cwd(), 'data', 'contacts.json')
const CONTACTS_BACKUP_PATH = path.join(process.cwd(), 'data', 'contacts_backup.json')

// Ensure data directory exists
const ensureDataDirectory = () => {
    const dataDir = path.dirname(CONTACTS_FILE_PATH)
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true })
        logger.info('Created data directory', { path: dataDir })
    }
}

// Load contacts from persistent storage
const loadPersistedContacts = (): { [jid: string]: { name?: string; notify?: string; pushName?: string } } => {
    try {
        ensureDataDirectory()
        
        if (fs.existsSync(CONTACTS_FILE_PATH)) {
            const contactsData = fs.readFileSync(CONTACTS_FILE_PATH, 'utf8')
            const loadedContacts = JSON.parse(contactsData)
            
            logger.info('📁 LOADED PERSISTED CONTACTS', {
                totalContacts: Object.keys(loadedContacts).length,
                individualContacts: Object.keys(loadedContacts).filter(jid => jid.endsWith('@s.whatsapp.net')).length,
                groupContacts: Object.keys(loadedContacts).filter(jid => jid.endsWith('@g.us')).length,
                contactsWithNames: Object.values(loadedContacts).filter((c: any) => c.name && c.name !== c.notify).length,
                filePath: CONTACTS_FILE_PATH
            })
            
            return loadedContacts
        } else {
            logger.info('📁 No persisted contacts file found, starting fresh', { 
                expectedPath: CONTACTS_FILE_PATH 
            })
            return {}
        }
    } catch (error) {
        logger.error('❌ Failed to load persisted contacts', error)
        
        // Try backup file
        try {
            if (fs.existsSync(CONTACTS_BACKUP_PATH)) {
                const backupData = fs.readFileSync(CONTACTS_BACKUP_PATH, 'utf8')
                const backupContacts = JSON.parse(backupData)
                logger.info('📁 Loaded contacts from backup file', {
                    totalContacts: Object.keys(backupContacts).length
                })
                return backupContacts
            }
        } catch (backupError) {
            logger.error('❌ Failed to load backup contacts', backupError)
        }
        
        return {}
    }
}

// Save contacts to persistent storage
const savePersistedContacts = (contacts: { [jid: string]: { name?: string; notify?: string; pushName?: string } }) => {
    try {
        ensureDataDirectory()
        
        // Create backup of existing file
        if (fs.existsSync(CONTACTS_FILE_PATH)) {
            fs.copyFileSync(CONTACTS_FILE_PATH, CONTACTS_BACKUP_PATH)
        }
        
        // Save current contacts
        const contactsJson = JSON.stringify(contacts, null, 2)
        fs.writeFileSync(CONTACTS_FILE_PATH, contactsJson, 'utf8')
        
        logger.debug('💾 Contacts saved to file', {
            totalContacts: Object.keys(contacts).length,
            filePath: CONTACTS_FILE_PATH
        })
    } catch (error) {
        logger.error('❌ Failed to save contacts to file', error)
    }
}

// Debounced save function to avoid excessive file writes
let saveTimeout: NodeJS.Timeout | null = null
const debouncedSaveContacts = () => {
    if (saveTimeout) {
        clearTimeout(saveTimeout)
    }
    
    saveTimeout = setTimeout(() => {
        savePersistedContacts(contactStore)
        saveTimeout = null
    }, 5000) // Save after 5 seconds of inactivity
}

// Global store to maintain contact information - initialize with persisted data
const contactStore: { [jid: string]: { name?: string; notify?: string; pushName?: string } } = loadPersistedContacts()

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
                    totalContactsNow: Object.keys(contactStore).length,
                    contactsWithNamesNow: Object.values(contactStore).filter(c => c.name && c.name !== c.notify).length
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
                logger.info('Contact upserted', { 
                    jid: contact.id, 
                    name: contactName, 
                    notify: contact.notify,
                    fullContact: contact
                })
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

// Function to add a contact to the store
function addContactToStore(jid: string, contactInfo: { name?: string; notify?: string; pushName?: string }) {
    // Only store real WhatsApp contacts (not @lid internal IDs)
    if (jid.includes('@s.whatsapp.net') || jid.includes('@g.us')) {
        const existingContact = contactStore[jid]
        const hasNewInfo = !existingContact || 
            contactInfo.name !== existingContact.name ||
            contactInfo.notify !== existingContact.notify ||
            contactInfo.pushName !== existingContact.pushName
        
        contactStore[jid] = {
            ...contactStore[jid], // Keep existing info
            ...contactInfo // Update with new info
        }
        
        logger.debug('Contact added/updated', { 
            jid, 
            contactInfo, 
            totalContacts: Object.keys(contactStore).length,
            hasNewInfo
        })
        
        // Save to file if there's new information
        if (hasNewInfo) {
            debouncedSaveContacts()
        }
    }
}

// Function to update contact store when contacts are received
export function updateContactStore(contacts: { [jid: string]: { name?: string; notify?: string; pushName?: string } }) {
    for (const [jid, contact] of Object.entries(contacts)) {
        addContactToStore(jid, contact)
    }
    logger.info('Contact store batch updated', { totalContacts: Object.keys(contactStore).length })
}

// Function to extract contacts from message metadata
function extractContactFromMessage(message: WAMessage) {
    const jid = message.key.remoteJid
    const pushName = message.pushName
    const fromMe = message.key.fromMe
    
    // Debug logging to see what we're getting
    logger.debug('Extracting contact from message', {
        jid,
        pushName,
        fromMe,
        messageKey: message.key,
        hasMessage: !!message.message
    })
    
    if (jid && !fromMe) {
        // Extract contact info from individual messages (direct chats)
        if (jid.endsWith('@s.whatsapp.net')) {
            const existingContact = contactStore[jid]
            const bestName = pushName || existingContact?.name || existingContact?.pushName
            
            logger.debug('Processing individual contact from message', {
                jid,
                pushName,
                existingContact,
                bestName
            })
            
            addContactToStore(jid, { 
                name: bestName ? bestName : undefined,
                pushName: pushName || undefined, 
                notify: bestName || jid.split('@')[0] 
            })
        }
        
        // Extract contact info from group messages
        if (jid.endsWith('@g.us') && message.key.participant) {
            const existingContact = contactStore[message.key.participant]
            const bestName = pushName || existingContact?.name || existingContact?.pushName
            
            logger.debug('Processing group participant from message', {
                groupJid: jid,
                participantJid: message.key.participant,
                pushName,
                existingContact,
                bestName
            })
            
            addContactToStore(message.key.participant, { 
                name: bestName ? bestName : undefined,
                pushName: pushName || undefined, 
                notify: bestName || message.key.participant.split('@')[0] 
            })
        }
    }
}

// Function to fetch initial contacts from existing chats and groups
async function fetchInitialContacts(sock: WASocket) {
    try {
        logger.info('Fetching initial contacts from existing chats and groups...')
        
        let contactsFound = 0
        
        // Method 1: Get contacts from all participating groups
        try {
            const groups = await sock.groupFetchAllParticipating()
            logger.info('Found groups for contact extraction', { groupCount: Object.keys(groups).length })
            
            for (const [groupJid, group] of Object.entries(groups)) {
                // Add group as a contact target
                addContactToStore(groupJid, {
                    name: group.subject,
                    notify: group.subject
                })
                
                // Add all participants from each group with enhanced name extraction
                for (const participant of group.participants) {
                    if (participant.id && participant.id.endsWith('@s.whatsapp.net')) {
                        // Try to extract name from participant info if available
                        const participantName = (participant as any).notify || (participant as any).name
                        
                        addContactToStore(participant.id, {
                            name: participantName || undefined,
                            notify: participantName || participant.id.split('@')[0]
                        })
                        contactsFound++
                    }
                }
            }
        } catch (groupError) {
            logger.warn('Failed to fetch group participants', groupError)
        }

        // Method 2: Try to force contact sync and get more contact information
        try {
            logger.debug('Attempting to enhance contact information...')
            
            // Try to check if there are any contacts in the auth state or available through other means
            const existingJids = Object.keys(contactStore).filter(jid => jid.endsWith('@s.whatsapp.net'))
            
            logger.info('Current individual contacts status', {
                totalIndividualContacts: existingJids.length,
                contactsWithNames: existingJids.filter(jid => contactStore[jid]?.name).length
            })
            
            // Log only if we found contacts with actual names (not just phone numbers)
            const namedContacts = existingJids.filter(jid => {
                const contact = contactStore[jid]
                return contact?.name && contact.name !== jid.split('@')[0]
            })
            
            if (namedContacts.length > 0) {
                logger.info('✅ Individual contacts with names found', {
                    count: namedContacts.length
                })
            }
            
        } catch (contactError) {
            logger.debug('Enhanced contact fetch not available', contactError)
        }

        // Method 3: Try to trigger WhatsApp to send us contact information
        try {
            logger.debug('Attempting to validate some contacts for name updates...')
            
            // Check if we can validate some contacts to see if that triggers name updates
            const sampleJids = Object.keys(contactStore)
                .filter(jid => jid.endsWith('@s.whatsapp.net'))
                .slice(0, 3)
            
            for (const jid of sampleJids) {
                try {
                    await sock.onWhatsApp(jid)
                    await new Promise(resolve => setTimeout(resolve, 200))
                } catch (validationError) {
                    // Silent validation - only log if it provides names
                }
            }
            
        } catch (syncError) {
            logger.debug('Contact sync trigger not available', syncError)
        }

        logger.info('Initial contact fetch completed', { 
            contactsFound,
            totalContactsInStore: Object.keys(contactStore).length,
            contactsWithNames: Object.values(contactStore).filter(c => c.name).length
        })
        
    } catch (error) {
        logger.error('Failed to fetch initial contacts', error)
    }
}

// Function to periodically refresh contacts from active chats
async function refreshContactsFromActivity(sock: WASocket) {
    try {
        // Silent periodic refresh - only log if new names are found
        const beforeCount = Object.values(contactStore).filter(c => c.name && c.name !== c.notify).length
        
        // Minimal refresh logic here
        
        const afterCount = Object.values(contactStore).filter(c => c.name && c.name !== c.notify).length
        
        if (afterCount > beforeCount) {
            logger.info('📞 New contact names found during periodic refresh', {
                newNamesFound: afterCount - beforeCount,
                totalNamesNow: afterCount
            })
        }
        
    } catch (error) {
        logger.debug('Error in periodic contact refresh', error)
    }
}

// Export function to manually refresh contacts (useful for debugging)
export async function manuallyRefreshContacts(sock: WASocket) {
    logger.info('Manually refreshing contacts...')
    await fetchInitialContacts(sock)
    await fetchChatListWithTitles(sock)
    
    logger.info('Manual contact refresh completed', {
        totalContacts: Object.keys(contactStore).length,
        individualContacts: Object.keys(contactStore).filter(jid => jid.endsWith('@s.whatsapp.net')).length,
        contactsWithNames: Object.values(contactStore).filter(c => c.name && c.name !== c.notify).length,
        individualContactsWithRealNames: Object.entries(contactStore)
            .filter(([jid, contact]) => jid.endsWith('@s.whatsapp.net') && contact.name && contact.name !== jid.split('@')[0])
            .length
    })
}

// Function to debug contact information
export async function debugContactInfo(sock: WASocket, jid?: string) {
    if (jid) {
        logger.info('Debug info for specific contact', {
            jid,
            storedContact: contactStore[jid],
            exists: !!contactStore[jid]
        })
        
        try {
            const onWhatsAppResult = await sock.onWhatsApp(jid)
            logger.info('WhatsApp validation for contact', { jid, result: onWhatsAppResult })
        } catch (error) {
            logger.error('Failed to validate contact on WhatsApp', { jid, error })
        }
    } else {
        logger.info('All contacts debug info', {
            totalContacts: Object.keys(contactStore).length,
            individualContacts: Object.keys(contactStore).filter(j => j.endsWith('@s.whatsapp.net')).length,
            groupContacts: Object.keys(contactStore).filter(j => j.endsWith('@g.us')).length,
            contactsWithRealNames: Object.entries(contactStore).filter(([jid, contact]) => 
                contact.name && contact.name !== jid.split('@')[0]
            ).length
        })
    }
}

// Function to try to get contact name by asking the user for help
async function tryGetContactNameFromUser(sock: WASocket, targetName: string, originalSender: string): Promise<string | null> {
    try {
        // Get a list of available contacts with partial matches
        const possibleMatches = Object.entries(contactStore)
            .filter(([jid, contact]) => {
                const contactName = (contact.name || contact.notify || '').toLowerCase()
                return contactName.includes(targetName.toLowerCase()) || 
                       targetName.toLowerCase().includes(contactName.toLowerCase())
            })
            .slice(0, 5) // Limit to 5 suggestions
        
        if (possibleMatches.length > 0) {
            const suggestionText = possibleMatches
                .map(([jid, contact], index) => 
                    `${index + 1}. ${contact.name || contact.notify} (${jid.split('@')[0]})`
                )
                .join('\n')
            
            await sock.sendMessage(originalSender, {
                text: `[PA]: I couldn't find a contact named "${targetName}". Did you mean one of these?\n\n${suggestionText}\n\nPlease use the exact name or phone number.`
            })
            
            return null
        } else {
            // Try to find contacts with phone numbers only and suggest using phone numbers
            const phoneOnlyContacts = Object.entries(contactStore)
                .filter(([jid, contact]) => jid.endsWith('@s.whatsapp.net') && !contact.name)
                .slice(0, 3)
                .map(([jid]) => jid.split('@')[0])
            
            if (phoneOnlyContacts.length > 0) {
                await sock.sendMessage(originalSender, {
                    text: `[PA]: I couldn't find a contact named "${targetName}". I have ${Object.keys(contactStore).filter(j => j.endsWith('@s.whatsapp.net')).length} contacts but most only have phone numbers.\n\nTry using a phone number like: ${phoneOnlyContacts[0]}\n\nOr send a message to the person first so I can learn their name.`
                })
            } else {
                await sock.sendMessage(originalSender, {
                    text: `[PA]: I couldn't find a contact named "${targetName}". Please use their phone number instead, or send them a message first so I can learn their name.`
                })
            }
            
            return null
        }
    } catch (error) {
        logger.error('Error getting contact name from user', error)
        return null
    }
}

async function findContactByName(sock: WASocket, name: string): Promise<string | null> {
    try {
        logger.debug('Searching for contact', { 
            name, 
            contactStoreSize: Object.keys(contactStore).length 
        })

        logger.info('Contact store contents', { 
            contactStore: Object.fromEntries(
                Object.entries(contactStore)
            ),
            totalContacts: Object.keys(contactStore).length
        })
        
        // Search through the contact store first (exact matches)
        for (const [jid, contact] of Object.entries(contactStore)) {
            const contactName = (contact.name || contact.notify || contact.pushName || '').toLowerCase()
            const searchName = name.toLowerCase()
            
            if (contactName.includes(searchName) || searchName.includes(contactName)) {
                logger.info('Found contact by name', { 
                    searchName: name, 
                    foundName: contact.name || contact.notify || contact.pushName, 
                    jid 
                })
                return jid
            }
        }
        
        // If not found in contact store, try a more fuzzy search
        // Look for partial matches (in case the AI used a nickname or part of the name)
        for (const [jid, contact] of Object.entries(contactStore)) {
            const contactName = (contact.name || contact.notify || contact.pushName || '').toLowerCase()
            const nameParts = contactName.split(' ')
            const searchParts = name.toLowerCase().split(' ')
            
            // Check if any part of the search name matches any part of the contact name
            for (const searchPart of searchParts) {
                for (const namePart of nameParts) {
                    if (searchPart.length > 2 && namePart.includes(searchPart)) {
                        logger.info('Found contact by partial name match', { 
                            searchName: name, 
                            foundName: contact.name || contact.notify || contact.pushName, 
                            matchedPart: searchPart,
                            jid 
                        })
                        return jid
                    }
                }
            }
        }
        
        // As a last resort, try to check if the name is a phone number that we can validate
        if (/^\+?\d+$/.test(name.replace(/\s|-/g, ''))) {
            const cleanNumber = name.replace(/\+|\s|-/g, '')
            const potentialJid = cleanNumber + '@s.whatsapp.net'
            
            try {
                const results = await sock.onWhatsApp(potentialJid)
                if (results && results.length > 0 && results[0].exists) {
                    logger.info('Found contact by phone number validation', { 
                        searchName: name, 
                        jid: results[0].jid 
                    })
                    return results[0].jid as string
                }
            } catch (phoneCheckError) {
                logger.debug('Phone number validation failed', phoneCheckError)
            }
        }
        
        logger.warn('No contact found for name', { 
            name, 
            contactStoreSize: Object.keys(contactStore).length,
            suggestion: 'Try using the exact name as it appears in WhatsApp or a phone number. The contact store will populate as you exchange messages.'
        })
        return null
    } catch (error) {
        logger.error('Error searching for contact', error, { name })
        return null
    }
}

async function handleReplyAction(sock: WASocket, originalRemoteJid: string, textResponse: string, target: string | 'self') {
    try {
        const messagePrefix = '[PA]: '
        
        if (target === 'self') {
            // Send reply to the original sender
            await sock.sendMessage(originalRemoteJid, { text: messagePrefix + textResponse })
            logger.info('Reply sent to original sender', { 
                to: originalRemoteJid, 
                responseLength: textResponse.length 
            })
        } else {
            // Send reply to a specific contact/group
            let targetJid = target
            
            // If target looks like a phone number (digits only), format it as a WhatsApp JID
            if (/^\d+$/.test(target)) {
                targetJid = target + '@s.whatsapp.net'
            } 
            // If target looks like it's already a JID, use it as is
            else if (target.includes('@')) {
                targetJid = target
            } 
            // Otherwise, treat it as a contact name and search for it
            else {
                logger.info('Searching for contact by name', { name: target })
                const foundJid = await findContactByName(sock, target)
                
                if (foundJid) {
                    targetJid = foundJid
                    logger.info('Contact found', { name: target, jid: foundJid })
                } else {
                    // Contact not found - try to help the user with suggestions
                    await tryGetContactNameFromUser(sock, target, originalRemoteJid)
                    return
                }
            }
            
            await sock.sendMessage(targetJid, { text: messagePrefix + textResponse })
            logger.info('Reply sent to specified target', { 
                to: targetJid, 
                originalSender: originalRemoteJid,
                targetName: target !== targetJid ? target : undefined,
                responseLength: textResponse.length 
            })
        }
    } catch (error) {
        logger.error('Failed to send reply', error, { 
            target, 
            originalSender: originalRemoteJid 
        })
        
        // Fallback: send error message to original sender
        await sock.sendMessage(originalRemoteJid, {
            text: '[PA]: Sorry, I couldn\'t deliver the message to the specified target. Here\'s what I wanted to say: ' + textResponse
        })
    }
}

async function processWithAI(sock: WASocket, remoteJid: string, content: string, messageType: 'text' | 'audio') {
    // If AI is enabled, use AI for all messages
    if (config.bot.aiEnabled) {
        logger.info('Processing AI request', { 
            prompt: content, 
            from: remoteJid, 
            messageType 
        })

        try {
            const aiReply = await generateResponse(content)
            
            // Try to parse the AI response as JSON
            let parsedResponse: { textResponse: any; action: any }
            try {
                parsedResponse = JSON.parse(aiReply)
            } catch (parseError) {
                logger.error('Failed to parse AI response as JSON, treating as plain text', parseError, {
                    aiReply: aiReply.substring(0, 200) + '...'
                })
                // Fallback to plain text response
                const aiReplyPrefix = '[PA]: '
                await sock.sendMessage(remoteJid, { text: aiReplyPrefix + aiReply })
                return
            }

            // Validate the JSON structure
            if (!parsedResponse.textResponse || !parsedResponse.action) {
                logger.error('Invalid AI response format', { parsedResponse })
                await sock.sendMessage(remoteJid, {
                    text: '[PA]: Sorry, I received an invalid response format. Please try again.'
                })
                return
            }

            const { textResponse, action } = parsedResponse
            logger.info('Parsed AI response', { 
                actionType: action.type, 
                actionTarget: action.target,
                responseLength: textResponse.length 
            })

            // Handle different action types
            switch (action.type) {
                case 'reply':
                    await handleReplyAction(sock, remoteJid, textResponse, action.target)
                    break
                
                case 'negotiate':
                    logger.info('Negotiate action not yet implemented', { target: action.target })
                    // For now, just send the text response to the original sender
                    await sock.sendMessage(remoteJid, { text: '[PA]: ' + textResponse })
                    break
                
                case 'summary':
                    logger.info('Summary action not yet implemented', { target: action.target })
                    // For now, just send the text response to the original sender
                    await sock.sendMessage(remoteJid, { text: '[PA]: ' + textResponse })
                    break
                
                default:
                    logger.warn('Unknown action type', { actionType: action.type })
                    await sock.sendMessage(remoteJid, { text: '[PA]: ' + textResponse })
                    break
            }

            logger.info('AI response processed successfully', { 
                actionType: action.type,
                actionTarget: action.target,
                messageType 
            })
        } catch (error) {
            logger.error('AI request failed', error, { messageType })
            await sock.sendMessage(remoteJid, {
                text: 'Sorry, AI is currently unavailable. Please try again later.'
            })
        }
        return
    }

    // Fallback responses when AI is disabled
    if (messageType === 'audio') {
        await sock.sendMessage(remoteJid, { 
            text: `I heard you say: "${content}"\n\nYou mentioned "pocket" - AI is currently disabled, but I detected the keyword!` 
        })
    } else {
        // For text messages, use echo fallback (commented out in original)
        // await sock.sendMessage(remoteJid, {
        //     text: `Echo: ${content}`
        // })
        // logger.info('Echo response sent', { to: remoteJid, originalText: content })
    }
}

async function handlePAMessage(sock: WASocket, message: WAMessage, checkKeywords: boolean = true) {
    try {
        const remoteJid = message.key.remoteJid
        if (!remoteJid) return

        // Check if this is an audio message
        const audioMessage = message.message?.audioMessage
        
        if (audioMessage) {
            await handlePAAudioMessage(sock, message, checkKeywords)
        } else {
            await handlePATextMessage(sock, message, checkKeywords)
        }
    } catch (error) {
        logger.error('Error handling message', error, {
            messageId: message.key.id,
            from: message.key.remoteJid
        })
    }
}

async function handlePATextMessage(sock: WASocket, message: WAMessage, checkKeywords: boolean = true) {
    try {
        const remoteJid = message.key.remoteJid
        if (!remoteJid) return

        // Get the text content from the message
        const textContent = message.message?.conversation || message.message?.extendedTextMessage?.text || ''

        // Skip text messages that don't have content
        if (!textContent) return

        // Check for @PA or @pa keywords if required
        if (checkKeywords && !textContent.startsWith('@PA') && !textContent.startsWith('@pa')) {
            logger.debug('Text message does not start with @PA or @pa, skipping processing', {
                from: remoteJid,
                text: textContent.substring(0, 50) + '...'
            })
            return
        }

        logger.info('Text message received', {
            from: remoteJid,
            text: textContent,
            messageId: message.key.id,
            keywordCheckEnabled: checkKeywords
        })

        // Process with AI if enabled
        await processWithAI(sock, remoteJid, textContent, 'text')

        // Fallback to echo if AI is disabled
        // await sock.sendMessage(remoteJid, {
        //     text: `Echo: ${textContent}`
        // })

        // logger.info('Echo response sent', {
        //     to: remoteJid,
        //     originalText: textContent
        // })
    } catch (error) {
        logger.error('Error handling text message', error, {
            messageId: message.key.id,
            from: message.key.remoteJid
        })
    }
}

async function handlePAAudioMessage(sock: WASocket, message: WAMessage, checkKeywords: boolean = true) {
    try {
        const remoteJid = message.key.remoteJid
        if (!remoteJid) return

        const audioMessage = message.message?.audioMessage
        if (!audioMessage) return

        logger.info('Audio message received', {
            from: remoteJid,
            messageId: message.key.id,
            duration: audioMessage.seconds
        })

        // Debug: Log all audio message fields to see what's available
        logger.debug('Audio message fields:', {
            audioMessage: JSON.stringify(audioMessage, null, 2)
        })

        // Download and transcribe the audio message
        try {
            logger.info('Downloading audio message for transcription...')
            
            // Download the audio as buffer
            const audioBuffer = await downloadMediaMessage(
                message,
                'buffer',
                {},
                {
                    logger: logger.getPinoInstance(),
                    reuploadRequest: sock.updateMediaMessage
                }
            ) as Buffer

            logger.info('Audio downloaded, starting transcription...', { 
                audioSize: audioBuffer.length 
            })

            // Transcribe the audio using OpenAI Whisper
            const transcribedText = await transcribeAudio(audioBuffer)
            
            logger.info('Audio transcribed successfully', { 
                transcription: transcribedText,
                containsPocket: transcribedText.toLowerCase().includes('pocket'),
                keywordCheckEnabled: checkKeywords
            })

            // Check if the transcription contains 'pocket' (if keyword checking is enabled)
            if (!checkKeywords || transcribedText.toLowerCase().includes('pocket')) {
                if (checkKeywords) {
                    logger.info('Audio contains "pocket", processing with AI...')
                } else {
                    logger.info('Processing audio without keyword check...')
                }
                await processWithAI(sock, remoteJid, transcribedText, 'audio')
            } else {
                logger.info('Audio does not contain "pocket", skipping processing')
                // Optionally send a response indicating the audio was processed but didn't contain the keyword
                // await sock.sendMessage(remoteJid, { 
                //     text: `I transcribed your audio: "${transcribedText}"\n\nBut it doesn't contain "pocket", so I won't process it further.` 
                // })
            }

        } catch (error) {
            logger.error('Failed to process audio message', error)
            await sock.sendMessage(remoteJid, { 
                text: 'Sorry, I had trouble processing your voice message. Please try again or send a text message.' 
            })
        }
    } catch (error) {
        logger.error('Error handling audio message', error, {
            messageId: message.key.id,
            from: message.key.remoteJid
        })
    }
}

// New function to manually trigger chat list sync to get conversation titles
async function fetchChatListWithTitles(sock: WASocket) {
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
export async function getChatList(sock: WASocket): Promise<Array<{jid: string, name?: string, notify?: string, type: 'individual' | 'group', lastMessage?: any}>> {
    const chatList: Array<{jid: string, name?: string, notify?: string, type: 'individual' | 'group', lastMessage?: any}> = []
    
    try {
        logger.info('Generating chat list from contact store...')
        
        // Get all stored contacts and chats
        for (const [jid, contact] of Object.entries(contactStore)) {
            const chatInfo = {
                jid,
                name: contact.name,
                notify: contact.notify,
                type: jid.endsWith('@g.us') ? 'group' as const : 'individual' as const,
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
export async function refreshChatList(sock: WASocket): Promise<void> {
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
export async function getChatByName(name: string): Promise<{jid: string, name?: string, notify?: string, type: 'individual' | 'group'} | null> {
    try {
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

// Export function to get contact store statistics
export function getContactStoreStats() {
    const totalContacts = Object.keys(contactStore).length
    const individualContacts = Object.keys(contactStore).filter(jid => jid.endsWith('@s.whatsapp.net')).length
    const groupChats = Object.keys(contactStore).filter(jid => jid.endsWith('@g.us')).length
    const contactsWithNames = Object.values(contactStore).filter(c => c.name && c.name !== c.notify).length
    
    return {
        totalContacts,
        individualContacts,
        groupChats,
        contactsWithNames,
        storeCoverage: totalContacts > 0 ? (contactsWithNames / totalContacts * 100).toFixed(1) + '%' : '0%'
    }
}

// Export function to demonstrate getChatList functionality
export async function testChatListFunctionality(sock: WASocket) {
    logger.info('Testing Chat List Functionality...')
    
    // 1. Refresh the chat list to get latest data
    await refreshChatList(sock)
    
    // 2. Get contact store statistics
    const stats = getContactStoreStats()
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

// Enhanced function to aggressively fetch chat list with conversation titles
async function aggressiveFetchChatList(sock: WASocket) {
    try {
        logger.debug('🚀 Starting background sync processes...')
        
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

// Function to fetch message history and extract contact names from historical messages
async function fetchContactNamesFromMessageHistory(sock: WASocket) {
    try {
        logger.info('📜 FETCHING CONTACT NAMES FROM MESSAGE HISTORY')
        
        // Get individual contacts (not groups)
        const individualContacts = Object.keys(contactStore)
            .filter(jid => jid.endsWith('@s.whatsapp.net'))
            .slice(0, 20) // Limit to first 20 to avoid overwhelming the system
        
        let namesFound = 0
        let processed = 0
        
        // Process message history silently, only log meaningful results
        for (const jid of individualContacts) {
            try {
                processed++
                
                // Try to get message history (silent processing)
                try {
                    const messages = await sock.fetchMessageHistory(10, {
                        remoteJid: jid,
                        fromMe: false,
                        id: undefined
                    }, undefined)
                    
                    if (messages && Array.isArray(messages) && messages.length > 0) {
                        const nameFound = await processMessagesForNames(messages, jid)
                        if (nameFound) {
                            namesFound++
                            continue
                        }
                    }
                } catch (method1Error) {
                    // Try alternative method silently
                    try {
                        const messages = await sock.fetchMessageHistory(5, {
                            remoteJid: jid,
                            fromMe: undefined,
                            id: ''
                        }, 0)
                        
                        if (messages && Array.isArray(messages) && messages.length > 0) {
                            const nameFound = await processMessagesForNames(messages, jid)
                            if (nameFound) {
                                namesFound++
                            }
                        }
                    } catch (method2Error) {
                        // Silent failure - continue to next contact
                    }
                }
                
                // Small delay to avoid overwhelming WhatsApp servers
                await new Promise(resolve => setTimeout(resolve, 100))
                
            } catch (error) {
                // Silent error - continue with next contact
            }
        }
        
        // Only log if we found names from message history
        if (namesFound > 0) {
            logger.info('📜 MESSAGE HISTORY SCAN COMPLETED', {
                contactsProcessed: processed,
                namesFound,
                totalContactsWithNamesNow: Object.values(contactStore).filter(c => c.name && c.name !== c.notify).length
            })
        } else {
            logger.debug('📜 Message history scan completed - no new names found', {
                contactsProcessed: processed
            })
        }
        
        return { processed, namesFound }
        
    } catch (error) {
        logger.error('Failed to fetch contact names from message history', error)
        return { processed: 0, namesFound: 0 }
    }
}

// Helper function to process messages and extract names
async function processMessagesForNames(messages: any[], jid: string): Promise<boolean> {
    try {
        for (const msg of messages) {
            if (msg && typeof msg === 'object') {
                // Look for pushName in the message object
                const pushName = msg.pushName || msg.push_name || msg.senderName || msg.participant
                
                if (pushName && pushName.trim() && typeof pushName === 'string') {
                    const existingContact = contactStore[jid]
                    const newName = pushName.trim()
                    
                    // Only update if we don't have a name or this is a better name
                    if (!existingContact?.name || existingContact.name === jid.split('@')[0]) {
                        addContactToStore(jid, {
                            name: newName,
                            pushName: newName,
                            notify: newName
                        })
                        
                        logger.info('✅ Contact name found in message history!', {
                            phone: jid.split('@')[0],
                            name: newName,
                            source: 'message_history'
                        })
                        return true // Found a name
                    }
                }
                
                // Also check if message has key.participant (for group messages)
                if (msg.key && msg.key.participant && msg.key.participant === jid) {
                    const participantName = msg.pushName || msg.push_name
                    if (participantName && participantName.trim()) {
                        const existingContact = contactStore[jid]
                        const newName = participantName.trim()
                        
                        if (!existingContact?.name || existingContact.name === jid.split('@')[0]) {
                            addContactToStore(jid, {
                                name: newName,
                                pushName: newName,
                                notify: newName
                            })
                            
                            logger.info('✅ Contact name found via participant!', {
                                phone: jid.split('@')[0],
                                name: newName,
                                source: 'group_participant'
                            })
                            return true
                        }
                    }
                }
            }
        }
        
        return false // No name found in any message
    } catch (error) {
        logger.debug('Error processing messages for names', { 
            jid: jid.split('@')[0], 
            error: error instanceof Error ? error.message : String(error)
        })
        return false
    }
}

// Export function to manually scan message history for contact names
export async function scanMessageHistoryForNames(sock: WASocket) {
    logger.info('🔍 MANUAL MESSAGE HISTORY SCAN TRIGGERED')
    
    const beforeCount = Object.values(contactStore).filter(c => c.name && c.name !== c.notify).length
    const result = await fetchContactNamesFromMessageHistory(sock)
    const afterCount = Object.values(contactStore).filter(c => c.name && c.name !== c.notify).length
    
    if (afterCount > beforeCount) {
        logger.info('📊 MESSAGE HISTORY SCAN: New names found', {
            newNames: afterCount - beforeCount,
            totalNamesNow: afterCount
        })
    }
    
    return {
        improvement: afterCount - beforeCount,
        ...result
    }
}

// Export function to manually save contacts (useful for debugging or forced saves)
export async function saveContactsNow() {
    logger.info('💾 MANUAL SAVE TRIGGERED')
    savePersistedContacts(contactStore)
    
    const stats = {
        totalContacts: Object.keys(contactStore).length,
        individualContacts: Object.keys(contactStore).filter(jid => jid.endsWith('@s.whatsapp.net')).length,
        groupContacts: Object.keys(contactStore).filter(jid => jid.endsWith('@g.us')).length,
        contactsWithNames: Object.values(contactStore).filter(c => c.name && c.name !== c.notify).length,
        filePath: CONTACTS_FILE_PATH
    }
    
    logger.info('💾 Contacts saved successfully', stats)
    return stats
}

// Export function to get contact file info
export function getContactFileInfo() {
    ensureDataDirectory()
    
    const mainFileExists = fs.existsSync(CONTACTS_FILE_PATH)
    const backupFileExists = fs.existsSync(CONTACTS_BACKUP_PATH)
    
    let mainFileStats: fs.Stats | undefined
    let backupFileStats: fs.Stats | undefined
    
    try {
        if (mainFileExists) {
            mainFileStats = fs.statSync(CONTACTS_FILE_PATH)
        }
        if (backupFileExists) {
            backupFileStats = fs.statSync(CONTACTS_BACKUP_PATH)
        }
    } catch (error) {
        logger.error('Error getting file stats', error)
    }
    
    return {
        mainFile: {
            path: CONTACTS_FILE_PATH,
            exists: mainFileExists,
            size: mainFileStats?.size,
            modified: mainFileStats?.mtime
        },
        backupFile: {
            path: CONTACTS_BACKUP_PATH,
            exists: backupFileExists,
            size: backupFileStats?.size,
            modified: backupFileStats?.mtime
        },
        currentContactCount: Object.keys(contactStore).length
    }
}

// Export function to clear all contacts (for testing)
export async function clearAllContacts() {
    logger.warn('🗑️ CLEARING ALL CONTACTS')
    
    // Clear memory
    Object.keys(contactStore).forEach(key => delete contactStore[key])
    
    // Save empty state
    savePersistedContacts(contactStore)
    
    logger.info('🗑️ All contacts cleared')
}
