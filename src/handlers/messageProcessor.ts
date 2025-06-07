import { WASocket, WAMessage, downloadMediaMessage } from 'baileys'
import { createLogger } from '../logger/index.js'
import { config } from '../config/index.js'
import { generateResponse, transcribeAudio } from '../ai/openai.js'
import { findContactByName, tryGetContactNameFromUser } from './contactExtractor.js'

const logger = createLogger('MessageProcessor')

// Handle reply action
export const handleReplyAction = async (sock: WASocket, originalRemoteJid: string, textResponse: string, target: string | 'self') => {
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

// Process message with AI
export const processWithAI = async (sock: WASocket, remoteJid: string, content: string, messageType: 'text' | 'audio') => {
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

// Handle PA text message
export const handlePATextMessage = async (sock: WASocket, message: WAMessage, checkKeywords: boolean = true) => {
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

    } catch (error) {
        logger.error('Error handling text message', error, {
            messageId: message.key.id,
            from: message.key.remoteJid
        })
    }
}

// Handle PA audio message
export const handlePAAudioMessage = async (sock: WASocket, message: WAMessage, checkKeywords: boolean = true) => {
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

// Main function to handle PA messages
export const handlePAMessage = async (sock: WASocket, message: WAMessage, checkKeywords: boolean = true) => {
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