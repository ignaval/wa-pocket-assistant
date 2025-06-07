import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from '../logger/index.js'

const logger = createLogger('ContactStore')

// Contact persistence configuration
const CONTACTS_FILE_PATH = path.join(process.cwd(), 'data', 'contacts.json')
const CONTACTS_BACKUP_PATH = path.join(process.cwd(), 'data', 'contacts_backup.json')

// Contact type definition
export interface ContactInfo {
    name?: string
    notify?: string
    pushName?: string
}

// Global store to maintain contact information
let contactStore: { [jid: string]: ContactInfo } = {}

// Debounced save function to avoid excessive file writes
let saveTimeout: NodeJS.Timeout | null = null

// Ensure data directory exists
const ensureDataDirectory = () => {
    const dataDir = path.dirname(CONTACTS_FILE_PATH)
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true })
        logger.info('Created data directory', { path: dataDir })
    }
}

// Load contacts from persistent storage
const loadPersistedContacts = (): { [jid: string]: ContactInfo } => {
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
const savePersistedContacts = (contacts: { [jid: string]: ContactInfo }) => {
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
const debouncedSaveContacts = () => {
    if (saveTimeout) {
        clearTimeout(saveTimeout)
    }
    
    saveTimeout = setTimeout(() => {
        savePersistedContacts(contactStore)
        saveTimeout = null
    }, 5000) // Save after 5 seconds of inactivity
}

// Initialize contact store
export const initializeContactStore = () => {
    contactStore = loadPersistedContacts()
    return contactStore
}

// Get the current contact store
export const getContactStore = () => contactStore

// Function to add a contact to the store
export const addContactToStore = (jid: string, contactInfo: ContactInfo) => {
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
export const updateContactStore = (contacts: { [jid: string]: ContactInfo }) => {
    for (const [jid, contact] of Object.entries(contacts)) {
        addContactToStore(jid, contact)
    }
    logger.info('Contact store batch updated', { totalContacts: Object.keys(contactStore).length })
}

// Export function to manually save contacts
export const saveContactsNow = async () => {
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

// Export function to get contact store statistics
export const getContactStoreStats = () => {
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

// Export function to get contact file info
export const getContactFileInfo = () => {
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
export const clearAllContacts = async () => {
    logger.warn('🗑️ CLEARING ALL CONTACTS')
    
    // Clear memory
    Object.keys(contactStore).forEach(key => delete contactStore[key])
    
    // Save empty state
    savePersistedContacts(contactStore)
    
    logger.info('🗑️ All contacts cleared')
} 