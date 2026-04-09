import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { WAMessage, WASocket } from '@whiskeysockets/baileys';

import { readEnvFile } from './env.js';

interface TranscriptionConfig {
  model: string;
  enabled: boolean;
  fallbackMessage: string;
}

const DEFAULT_CONFIG: TranscriptionConfig = {
  model: 'whisper-1',
  enabled: true,
  fallbackMessage: '[Voice Message - transcription unavailable]',
};

async function transcribeWithOpenAI(
  audioBuffer: Buffer,
  config: TranscriptionConfig,
  filename: string,
  mimeType: string,
): Promise<string | null> {
  const env = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    console.warn('OPENAI_API_KEY not set in .env');
    return null;
  }

  try {
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;

    const openai = new OpenAI({ apiKey });

    const file = await toFile(audioBuffer, filename, {
      type: mimeType,
    });

    const transcription = await openai.audio.transcriptions.create({
      file: file,
      model: config.model,
      response_format: 'text',
    });

    // When response_format is 'text', the API returns a plain string
    return transcription as unknown as string;
  } catch (err) {
    console.error('OpenAI transcription failed:', err);
    return null;
  }
}

/**
 * Channel-neutral entry point: takes a raw audio buffer and returns a
 * transcript or null. Defaults assume a WhatsApp/Telegram-style PTT voice
 * note (OGG Opus); pass `filename`/`mimeType` for other formats.
 *
 * Returns null on missing API key or any failure — callers should fall back
 * to their own placeholder text. (Distinct from `transcribeAudioMessage`,
 * which returns the configured fallback string instead of null.)
 */
export async function transcribeAudioBuffer(
  buffer: Buffer,
  opts: { filename?: string; mimeType?: string } = {},
): Promise<string | null> {
  if (!buffer || buffer.length === 0) return null;

  const filename = opts.filename ?? 'voice.ogg';
  const mimeType = opts.mimeType ?? 'audio/ogg';

  const transcript = await transcribeWithOpenAI(
    buffer,
    DEFAULT_CONFIG,
    filename,
    mimeType,
  );

  return transcript ? transcript.trim() : null;
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  const config = DEFAULT_CONFIG;

  if (!config.enabled) {
    return config.fallbackMessage;
  }

  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      console.error('Failed to download audio message');
      return config.fallbackMessage;
    }

    console.log(`Downloaded audio message: ${buffer.length} bytes`);

    const transcript = await transcribeWithOpenAI(
      buffer,
      config,
      'voice.ogg',
      'audio/ogg',
    );

    if (!transcript) {
      return config.fallbackMessage;
    }

    return transcript.trim();
  } catch (err) {
    console.error('Transcription error:', err);
    return config.fallbackMessage;
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
