import { BaileysEventMap, WASocket, WAMessage, downloadMediaMessage } from 'baileys'

import { config } from '../config/index.js'
import { generateResponse, transcribeAudio } from '../ai/openai.js'
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
            await sock.sendMessage(remoteJid, { text: aiReply })
            logger.info('AI response sent', { 
                to: remoteJid, 
                responseLength: aiReply.length,
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
