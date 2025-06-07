import { WASocket, WAMessage } from 'baileys'
import { createLogger } from '../logger/index.js'
import { getContactStore, addContactToStore, ContactInfo } from './contactStore.js'

const logger = createLogger('ContactExtractor')

// Function to extract contacts from message metadata
export const extractContactFromMessage = (message: WAMessage) => {
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
            const contactStore = getContactStore()
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
            const contactStore = getContactStore()
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

// Function to try to get contact name by asking the user for help
export const tryGetContactNameFromUser = async (sock: WASocket, targetName: string, originalSender: string): Promise<string | null> => {
    try {
        const contactStore = getContactStore()
        
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

export const findContactByName = async (sock: WASocket, name: string): Promise<string | null> => {
    try {
        const contactStore = getContactStore()
        
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

// Function to fetch initial contacts from existing chats and groups
export const fetchInitialContacts = async (sock: WASocket) => {
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
            
            const contactStore = getContactStore()
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
            
            const contactStore = getContactStore()
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

        const contactStore = getContactStore()
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
export const refreshContactsFromActivity = async (sock: WASocket) => {
    try {
        const contactStore = getContactStore()
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
export const manuallyRefreshContacts = async (sock: WASocket) => {
    logger.info('Manually refreshing contacts...')
    await fetchInitialContacts(sock)
    
    const contactStore = getContactStore()
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
export const debugContactInfo = async (sock: WASocket, jid?: string) => {
    const contactStore = getContactStore()
    
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