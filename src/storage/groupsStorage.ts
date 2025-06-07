import { promises as fs } from 'fs'
import { createLogger } from '../logger/index.js'
import { GroupInfo } from '../handlers/groupManager.js'

const logger = createLogger('GroupsStorage')

interface GroupsData {
    lastUpdated: number
    groups: GroupInfo[]
    version: string
}

export class GroupsStorage {
    private filePath: string
    private cacheExpiryHours: number

    constructor(storagePath: string = 'groups_cache.json', cacheExpiryHours: number = 24) {
        this.filePath = storagePath
        this.cacheExpiryHours = cacheExpiryHours
    }

    async saveGroups(groups: GroupInfo[]): Promise<void> {
        try {
            const data: GroupsData = {
                lastUpdated: Date.now(),
                groups,
                version: '1.0'
            }

            await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8')
            logger.info('Groups saved to storage', { 
                groupCount: groups.length, 
                filePath: this.filePath 
            })
        } catch (error) {
            logger.error('Failed to save groups to storage', error)
        }
    }

    async loadGroups(): Promise<GroupInfo[]> {
        try {
            const fileContent = await fs.readFile(this.filePath, 'utf8')
            const data: GroupsData = JSON.parse(fileContent)
            
            // Check if cache is expired
            const ageHours = (Date.now() - data.lastUpdated) / (1000 * 60 * 60)
            
            if (ageHours > this.cacheExpiryHours) {
                logger.info('Groups cache expired', { 
                    ageHours: Math.round(ageHours), 
                    maxAge: this.cacheExpiryHours 
                })
                return []
            }

            logger.info('Groups loaded from storage', { 
                groupCount: data.groups.length,
                ageHours: Math.round(ageHours)
            })
            
            return data.groups
            
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                logger.info('No groups cache file found, will create new one')
            } else {
                logger.error('Failed to load groups from storage', error)
            }
            return []
        }
    }

    async cacheExists(): Promise<boolean> {
        try {
            await fs.access(this.filePath)
            return true
        } catch {
            return false
        }
    }

    async getCacheAge(): Promise<number> {
        try {
            const fileContent = await fs.readFile(this.filePath, 'utf8')
            const data: GroupsData = JSON.parse(fileContent)
            return (Date.now() - data.lastUpdated) / (1000 * 60 * 60) // hours
        } catch {
            return Infinity
        }
    }

    async clearCache(): Promise<void> {
        try {
            await fs.unlink(this.filePath)
            logger.info('Groups cache cleared')
        } catch (error) {
            logger.error('Failed to clear groups cache', error)
        }
    }
} 