require('dotenv').config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const AUTH_FOLDER = './auth_info';

const SYSTEM_PROMPT = 'You are a helpful personal AI assistant on WhatsApp called Vektra Chat Bot. Be conversational, concise and friendly. Keep responses short and natural like a real person texting. No markdown formatting like asterisks or hashtags. Use emojis occasionally. Always reply in English by default no matter what. Only switch to another language if the person is writing FULLY in that language with no English at all. If someone uses Nigerian slang words mixed with English like Awfa, How far, Omo, Abeg, Wahala, Na so, Oya, Wetin, Shey, Ehen — still reply in English. You understand these slangs: Awfa means hey or what is up. How far means how are you. E don do means it is finished. Omo means wow or my friend. Abeg means please. Wahala means trouble. No wahala means no problem. Na so means exactly. Sabi means to know. Wetin means what. Dey means is or are. Oya means okay lets go. Shey means right or is it not. Ehen means yes or I see. Guy and Bros mean friend. You were created by VektraStudio. If anyone asks who made you say you are an AI assistant built by VektraStudio. Never reveal personal names. The current year is 2026.';

const SEARCH_SYSTEM_PROMPT = 'You are a helpful personal AI assistant on WhatsApp called Vektra Chat Bot. You have access to real-time web search. Search the web and answer the question accurately with current information. Keep the response concise and natural. No markdown formatting. The current year is 2026.';

const VISION_PROMPT = 'You are a fun witty WhatsApp friend. The user sent you an image or sticker. Check the user instruction first. If they ask you to read or type out text in the image — do that carefully. If it is a sticker or meme — react like a human friend would, be funny and relatable, match the energy of the sticker. If it is a selfie or photo of a person — react casually like a friend, say something fun or complimentary. Never describe the image formally like a robot. Keep it short, casual, use emojis, no markdown.';

const MAX_HISTORY = 10;
const SEARCH_KEYWORDS = ['search online', 'google it', 'check online', 'find out', 'look up', 'latest news', 'current price', 'breaking news', 'weather today', 'who won', 'live score', 'this week news', 'search for', 'check the internet', 'search it', 'look online', 'find online', 'check it online', 'what happened', 'online'];

let latestQR = null;
let isConnected = false;
let conversations = {};
let sock = null;

function needsWebSearch(text) {
  const lower = text.toLowerCase();
  return SEARCH_KEYWORDS.some(kw => lower.includes(kw));
}

async function askGroq(messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + GROQ_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages,
        max_tokens: 500,
        temperature: 0.7
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Groq API error');
    return data.choices[0].message.content;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

async function askGroqVision(base64Image, mimeType, caption) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + GROQ_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT + (caption ? ' User instruction: ' + caption : '') },
            { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + base64Image } }
          ]
        }
      ],
      max_tokens: 300,
      temperature: 0.8
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Groq Vision API error');
  return data.choices[0].message.content;
}

async function tavilySearch(query) {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: 'basic',
      max_results: 3
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error('Tavily search failed');
  return data.results.map(r => r.title + ': ' + r.content).join(' | ');
}

async function connectToWhatsApp() {
  if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => ({ conversation: '' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQR = qr;
      isConnected = false;
      console.log('QR code ready — visit the bot URL to scan.');
    }

    if (connection === 'open') {
      latestQR = null;
      isConnected = true;
      console.log('Bot is online and ready!');
    }

    if (connection === 'close') {
      isConnected = false;
      latestQR = null;
      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : 0;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Status:', statusCode, '| Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        // Logged out — clear auth so fresh QR is generated on restart
        console.log('Logged out. Clearing auth...');
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        setTimeout(connectToWhatsApp, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify') return;

    for (const message of msgs) {
      try {
        // Ignore broadcasts, status updates, and own messages
        if (!message.message) continue;
        if (message.key.fromMe) continue;
        if (isJidBroadcast(message.key.remoteJid)) continue;
        if (message.key.remoteJid === 'status@broadcast') continue;

        const jid = message.key.remoteJid;
        const msgContent = message.message;

        // Mark as read
        await sock.readMessages([message.key]);

        // Show typing indicator
        await sock.sendPresenceUpdate('composing', jid);

        if (!conversations[jid]) conversations[jid] = [];

        // --- IMAGE / STICKER ---
        const isImage = !!msgContent.imageMessage;
        const isSticker = !!msgContent.stickerMessage;

        if (isImage || isSticker) {
          try {
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            const buffer = await downloadMediaMessage(message, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
            const mimeType = isSticker ? 'image/webp' : (msgContent.imageMessage?.mimetype || 'image/jpeg');
            const base64 = buffer.toString('base64');
            const caption = isImage ? (msgContent.imageMessage?.caption || '') : '';
            const visionReply = await askGroqVision(base64, mimeType, caption);
            await sock.sendMessage(jid, { text: visionReply }, { quoted: message });
          } catch (e) {
            console.error('Vision error:', e.message);
            await sock.sendMessage(jid, { text: 'Lol I saw it but my eyes glitched 😅 send again!' }, { quoted: message });
          }
          await sock.sendPresenceUpdate('paused', jid);
          continue;
        }

        // --- VOICE NOTE / AUDIO ---
        const isVoice = !!msgContent.audioMessage;
        if (isVoice) {
          try {
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            const buffer = await downloadMediaMessage(message, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
            const audioBlob = new Blob([buffer], { type: msgContent.audioMessage?.mimetype || 'audio/ogg' });
            const formData = new FormData();
            formData.append('file', audioBlob, 'audio.ogg');
            formData.append('model', 'whisper-large-v3');
            formData.append('response_format', 'json');
            const transcribeRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY },
              body: formData
            });
            const transcribeData = await transcribeRes.json();
            if (!transcribeRes.ok) throw new Error(transcribeData.error?.message || 'Transcription failed');
            const transcribedText = transcribeData.text;
            if (!transcribedText?.trim()) {
              await sock.sendMessage(jid, { text: 'I could not hear anything in that voice note 🎤' }, { quoted: message });
            } else {
              conversations[jid].push({ role: 'user', content: transcribedText });
              if (conversations[jid].length > MAX_HISTORY) conversations[jid] = conversations[jid].slice(-MAX_HISTORY);
              const voiceMessages = [{ role: 'system', content: SYSTEM_PROMPT }, ...conversations[jid]];
              const voiceReply = await askGroq(voiceMessages);
              conversations[jid].push({ role: 'assistant', content: voiceReply.slice(0, 150) });
              await sock.sendMessage(jid, { text: voiceReply }, { quoted: message });
            }
          } catch (e) {
            console.error('Voice error:', e.message);
            await sock.sendMessage(jid, { text: 'Could not process your voice note, try again! 😅' }, { quoted: message });
          }
          await sock.sendPresenceUpdate('paused', jid);
          continue;
        }

        // --- TEXT MESSAGE ---
        const text = (
          msgContent.conversation ||
          msgContent.extendedTextMessage?.text ||
          ''
        ).trim();

        if (!text) {
          await sock.sendPresenceUpdate('paused', jid);
          continue;
        }

        if (text === '/clear') {
          conversations[jid] = [];
          await sock.sendMessage(jid, { text: 'Memory cleared! Fresh start 🧹' }, { quoted: message });
          await sock.sendPresenceUpdate('paused', jid);
          continue;
        }

        if (text === '/help') {
          await sock.sendMessage(jid, { text: 'Commands:\n/clear - Clear chat memory\n/help - Show this message\n\nJust type normally to chat with me! 😊' }, { quoted: message });
          await sock.sendPresenceUpdate('paused', jid);
          continue;
        }

        const useSearch = needsWebSearch(text);
        conversations[jid].push({ role: 'user', content: text });
        if (conversations[jid].length > MAX_HISTORY) conversations[jid] = conversations[jid].slice(-MAX_HISTORY);

        let reply;
        if (useSearch) {
          try {
            const searchResults = await tavilySearch(text);
            const searchMessages = [
              { role: 'system', content: SEARCH_SYSTEM_PROMPT + ' Here are the search results: ' + searchResults },
              { role: 'user', content: text }
            ];
            reply = await askGroq(searchMessages);
          } catch (searchErr) {
            console.error('Search failed:', searchErr.message);
            const fallback = [
              { role: 'system', content: SYSTEM_PROMPT + ' Note: web search is unavailable, answer from training data and mention this briefly.' },
              ...conversations[jid]
            ];
            reply = await askGroq(fallback);
          }
        } else {
          const chatMessages = [{ role: 'system', content: SYSTEM_PROMPT }, ...conversations[jid]];
          reply = await askGroq(chatMessages);
        }

        conversations[jid].push({ role: 'assistant', content: reply.slice(0, 150) });
        await sock.sendMessage(jid, { text: reply }, { quoted: message });
        await sock.sendPresenceUpdate('paused', jid);

      } catch (e) {
        console.error('Message handling error:', e.message);
      }
    }
  });
}

// HTTP Server — same QR page as before
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  if (isConnected) {
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Bot Status</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px}
    .badge{background:#16a34a;color:#fff;padding:10px 24px;border-radius:100px;font-size:15px;font-weight:600}
    p{color:#888;font-size:13px}</style></head>
    <body><div class="badge">✅ Bot is connected & running!</div><p>Vektra Chat Bot is online.</p></body></html>`);
  } else if (latestQR) {
    qrcode.toDataURL(latestQR, { width: 300, margin: 2 }, (err, url) => {
      if (err) { res.end('Error generating QR'); return; }
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Scan QR Code</title>
      <meta http-equiv="refresh" content="30"/>
      <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:20px;text-align:center;padding:24px}
      h2{font-size:22px;font-weight:700}.qr-wrap{background:#fff;padding:16px;border-radius:16px}
      img{display:block;width:280px;height:280px}
      .steps{background:#141414;border:1px solid #222;border-radius:12px;padding:16px 20px;font-size:13px;color:#aaa;line-height:2;text-align:left}
      .steps b{color:#fff}.note{font-size:11px;color:#555}</style></head>
      <body><h2>Scan to connect your WhatsApp</h2>
      <div class="qr-wrap"><img src="${url}" alt="QR Code"/></div>
      <div class="steps"><b>How to scan:</b><br/>1. Open WhatsApp on your phone<br/>2. Tap Menu (⋮) → Linked Devices<br/>3. Tap "Link a Device"<br/>4. Point camera at the QR code above</div>
      <p class="note">Page auto-refreshes every 30 seconds</p></body></html>`);
    });
  } else {
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Starting...</title>
    <meta http-equiv="refresh" content="10"/>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px}
    .spinner{width:40px;height:40px;border:3px solid #222;border-top-color:#4f7cff;border-radius:50%;animation:spin 1s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}p{color:#888;font-size:13px}</style></head>
    <body><div class="spinner"></div><p>Starting up... page will refresh automatically</p></body></html>`);
  }
});

server.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log('Server running on port', process.env.PORT || 3000);
  connectToWhatsApp();
});

process.on('unhandledRejection', reason => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err.message));
