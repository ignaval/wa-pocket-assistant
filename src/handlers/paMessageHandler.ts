import { BaileysEventMap, WASocket, WAMessage } from 'baileys'

import { config } from '../config/index.js'
import { generateResponse } from '../ai/openai.js'
import { createLogger } from '../logger/index.js'

const logger = createLogger('PA-MessageHandler')

export function setupPAHandler(sock: WASocket) {
    // Handle incoming messages
    sock.ev.on(
        'messages.upsert',
        async ({ messages, type }: BaileysEventMap['messages.upsert']) => {
            // Only process new messages
            if (type !== 'notify') return

            for (const message of messages) {
                // Skip if no message content
                if (!message.message) continue

                // Skip messages from self
                if (message.key.fromMe) continue

                if (message.key.remoteJid === '120363420786683038@g.us') {
                    await handlePAMessage(sock, message)
                }
            }
        }
    )
}

async function handlePAMessage(sock: WASocket, message: WAMessage) {
    try {
        const remoteJid = message.key.remoteJid
        if (!remoteJid) return

        // Get the text content from the message
        const textContent =
            message.message?.conversation || message.message?.extendedTextMessage?.text || ''

        if (!textContent) return

        logger.info('Message received', {
            from: remoteJid,
            text: textContent,
            messageId: message.key.id
        })

        // If AI is enabled, use AI for all messages
        if (config.bot.aiEnabled) {
            logger.info('Processing AI request', { prompt: textContent, from: remoteJid })

            try {
                const aiReply = await generateResponse(textContent)
                await sock.sendMessage(remoteJid, { text: aiReply })
                logger.info('AI response sent', { to: remoteJid, responseLength: aiReply.length })
            } catch (error) {
                logger.error('AI request failed', error)
                await sock.sendMessage(remoteJid, {
                    text: 'Sorry, AI is currently unavailable. Please try again later.'
                })
            }
            return
        }

        // Fallback to echo if AI is disabled
        // await sock.sendMessage(remoteJid, {
        //     text: `Echo: ${textContent}`
        // })

        // logger.info('Echo response sent', {
        //     to: remoteJid,
        //     originalText: textContent
        // })
    } catch (error) {
        logger.error('Error handling message', error, {
            messageId: message.key.id,
            from: message.key.remoteJid
        })
    }
}
