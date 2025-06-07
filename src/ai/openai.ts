import OpenAI from 'openai'
import { config } from '../config/index.js'

let client: OpenAI | null = null

if (config.ai.apiKey) {
    client = new OpenAI({ apiKey: config.ai.apiKey })
}

export async function generateResponse(prompt: string): Promise<string> {
    if (!client) {
        throw new Error('OpenAI API key is missing. Set OPENAI_API_KEY to enable AI responses.')
    }

    const messages: { role: 'system' | 'user'; content: string }[] = []
    if (config.ai.systemPrompt) {
        messages.push({ role: 'system', content: config.ai.systemPrompt })
    }
    messages.push({ role: 'user', content: prompt })

    const chat = await client.chat.completions.create({
        model: 'gpt-4.1-mini-2025-04-14',
        // With search
        // model: 'gpt-4o-mini-search-preview-2025-03-11',
        // temperature: 0.7,
        messages
    })

    return chat.choices[0]?.message?.content?.trim() || ''
}

export async function transcribeAudio(audioBuffer: Buffer, filename: string = 'audio.ogg'): Promise<string> {
    if (!client) {
        throw new Error('OpenAI API key is missing. Set OPENAI_API_KEY to enable audio transcription.')
    }

    try {
        // Create a File object from the buffer
        const audioFile = new File([audioBuffer], filename, { type: 'audio/ogg' })
        
        const transcription = await client.audio.transcriptions.create({
            file: audioFile,
            model: 'whisper-1',
            language: config.ai.transcriptionLanguage
        })

        return transcription.text?.trim() || ''
    } catch (error) {
        throw new Error(`Audio transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
}
