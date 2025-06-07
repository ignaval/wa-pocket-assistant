import { WASocket } from 'baileys'
import { createLogger } from '../logger/index.js'
import { getContactStore, addContactToStore } from './contactStore.js'

const logger = createLogger('MessageHistoryScanner')

// Helper function to process messages and extract names
const processMessagesForNames = async (messages: any[], jid: string): Promise<boolean> => {
    try {
        for (const msg of messages) {
            if (msg && typeof msg === 'object') {
                // Look for pushName in the message object
                const pushName = msg.pushName || msg.push_name || msg.senderName || msg.participant
                
                if (pushName && pushName.trim() && typeof pushName === 'string') {
                    const contactStore = getContactStore()
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
                        const contactStore = getContactStore()
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

// Function to fetch message history and extract contact names from historical messages
export const fetchContactNamesFromMessageHistory = async (sock: WASocket) => {
    try {
        logger.info('📜 FETCHING CONTACT NAMES FROM MESSAGE HISTORY')
        
        const contactStore = getContactStore()
        
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

// Export function to manually scan message history for contact names
export const scanMessageHistoryForNames = async (sock: WASocket) => {
    logger.info('🔍 MANUAL MESSAGE HISTORY SCAN TRIGGERED')
    
    const contactStore = getContactStore()
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