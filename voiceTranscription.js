// Voice note handling: WhatsApp sends audio messages as a media ID, not the
// audio itself. This module (1) resolves that ID to a temporary download
// URL via Meta's Graph API, (2) downloads the actual audio bytes, then
// (3) transcribes them via OpenAI's Whisper API. The resulting text is fed
// into the normal askClaude() pipeline exactly like a typed message.

const GRAPH_API_VERSION = 'v21.0';

/**
 * Given a WhatsApp media ID (from an incoming audio message), downloads the
 * raw audio bytes. WhatsApp voice notes are typically OGG/Opus.
 */
async function downloadWhatsAppMedia(mediaId) {
  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
  });

  if (!metaRes.ok) {
    throw new Error(`Failed to resolve WhatsApp media URL: HTTP ${metaRes.status}`);
  }

  const { url, mime_type: mimeType } = await metaRes.json();

  const fileRes = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
  });

  if (!fileRes.ok) {
    throw new Error(`Failed to download WhatsApp media: HTTP ${fileRes.status}`);
  }

  const arrayBuffer = await fileRes.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType: mimeType || 'audio/ogg' };
}

/**
 * Transcribes audio bytes via OpenAI's Whisper API. Returns plain text.
 */
async function transcribeAudio(buffer, mimeType) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY in .env - required for voice note transcription.');
  }

  const extension = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'oga';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), `voice-note.${extension}`);
  form.append('model', 'whisper-1');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Whisper transcription failed: HTTP ${res.status} - ${errText}`);
  }

  const data = await res.json();
  return data.text?.trim() || '';
}

/**
 * Full pipeline: WhatsApp media ID -> downloaded audio -> transcribed text.
 * Throws on any failure - the caller (server.js) should catch and reply
 * with a friendly error rather than silently dropping the voice note.
 */
export async function transcribeWhatsAppVoiceNote(mediaId) {
  const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);
  const text = await transcribeAudio(buffer, mimeType);

  if (!text) {
    throw new Error('Transcription came back empty - the voice note may have been silent or unclear.');
  }

  return text;
}
