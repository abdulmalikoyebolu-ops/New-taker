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

const SYSTEM_PROMPT = 'You are a helpful personal AI assistant called Vektra Chat Bot. Be conversational, concise and friendly. Keep responses short and natural like a real person texting. No markdown formatting like asterisks or hashtags. Use emojis occasionally. Always reply in English by default no matter what. Only switch to another language if the person is writing FULLY in that language with no English at all. If someone uses Nigerian slang words mixed with English like Awfa, How far, Omo, Abeg, Wahala, Na so, Oya, Wetin, Shey, Ehen — still reply in English. You understand these slangs: Awfa means hey or what is up. How far means how are you. E don do means it is finished. Omo means wow or my friend. Abeg means please. Wahala means trouble. No wahala means no problem. Na so means exactly. Sabi means to know. Wetin means what. Dey means is or are. Oya means okay lets go. Shey means right or is it not. Ehen means yes or I see. Guy and Bros mean friend. You were created by VektraStudio. If anyone asks who made you say you are an AI assistant built by VektraStudio. Never reveal personal names. The current year is 2026.';

const SEARCH_SYSTEM_PROMPT = 'You are a helpful personal AI assistant called Vektra Chat Bot. You have access to real-time web search. Search the web and answer the question accurately with current information. Keep the response concise and natural. No markdown formatting. The current year is 2026.';

const VISION_PROMPT = 'You are a fun witty AI assistant. The user sent you an image or sticker. Check the user instruction first. If they ask you to read or type out text in the image — do that carefully. If it is a sticker or meme — react like a human friend would, be funny and relatable, match the energy of the sticker. If it is a selfie or photo of a person — react casually like a friend, say something fun or complimentary. Never describe the image formally like a robot. Keep it short, casual, use emojis, no markdown.';

const MAX_HISTORY = 10;
const SEARCH_KEYWORDS = ['search online', 'google it', 'check online', 'find out', 'look up', 'latest news', 'current price', 'breaking news', 'weather today', 'who won', 'live score', 'this week news', 'search for', 'check the internet', 'search it', 'look online', 'find online', 'check it online', 'what happened', 'online'];

let latestQR = null;
let isConnected = false;
let conversations = {};
let sock = null;

// Web app sessions (separate from WhatsApp)
let webSessions = {};

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
    browser: ['Vektra Bot', 'Chrome', '120.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    retryRequestDelayMs: 2000,
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
        if (!message.message) continue;
        if (message.key.fromMe) continue;
        if (isJidBroadcast(message.key.remoteJid)) continue;
        if (message.key.remoteJid === 'status@broadcast') continue;

        const jid = message.key.remoteJid;
        const msgContent = message.message;

        await sock.readMessages([message.key]);
        await sock.sendPresenceUpdate('composing', jid);

        if (!conversations[jid]) conversations[jid] = [];

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

// ─── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {

  // ── CORS headers (allows web app frontend to call this API) ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── POST /chat — Web App API endpoint ──
  if (req.method === 'POST' && req.url === '/chat') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const { message, sessionId } = JSON.parse(body);

        if (!message || !message.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Message is required' }));
          return;
        }

        const sid = sessionId || 'default';
        if (!webSessions[sid]) webSessions[sid] = [];

        const useSearch = needsWebSearch(message);
        webSessions[sid].push({ role: 'user', content: message });
        if (webSessions[sid].length > MAX_HISTORY) webSessions[sid] = webSessions[sid].slice(-MAX_HISTORY);

        let reply;
        if (useSearch) {
          try {
            const searchResults = await tavilySearch(message);
            const searchMessages = [
              { role: 'system', content: SEARCH_SYSTEM_PROMPT + ' Here are the search results: ' + searchResults },
              { role: 'user', content: message }
            ];
            reply = await askGroq(searchMessages);
          } catch (searchErr) {
            console.error('Search failed:', searchErr.message);
            const fallback = [
              { role: 'system', content: SYSTEM_PROMPT + ' Note: web search is unavailable, answer from training data and mention this briefly.' },
              ...webSessions[sid]
            ];
            reply = await askGroq(fallback);
          }
        } else {
          const chatMessages = [{ role: 'system', content: SYSTEM_PROMPT }, ...webSessions[sid]];
          reply = await askGroq(chatMessages);
        }

        webSessions[sid].push({ role: 'assistant', content: reply.slice(0, 150) });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply }));

      } catch (e) {
        console.error('Web chat error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Something went wrong, try again!' }));
      }
    });
    return;
  }

  // ── POST /clear — Clear web session memory ──
  if (req.method === 'POST' && req.url === '/clear') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { sessionId } = JSON.parse(body || '{}');
        const sid = sessionId || 'default';
        webSessions[sid] = [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Memory cleared!' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  // ── POST /vision — Image analysis ──
  if (req.method === 'POST' && req.url === '/vision') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const { image, mimeType, caption, sessionId } = JSON.parse(body);
        const reply = await askGroqVision(image, mimeType || 'image/jpeg', caption || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply }));
      } catch (e) {
        console.error('Vision endpoint error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not analyze image.' }));
      }
    });
    return;
  }

  // ── POST /voice — Voice transcription + reply ──
  if (req.method === 'POST' && req.url === '/voice') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const { audio, mimeType, sessionId } = JSON.parse(body);
        const sid = sessionId || 'default';
        if (!webSessions[sid]) webSessions[sid] = [];

        // Decode base64 audio and transcribe
        const audioBuffer = Buffer.from(audio, 'base64');
        const audioBlob = new Blob([audioBuffer], { type: mimeType || 'audio/webm' });
        const formData = new FormData();
        formData.append('file', audioBlob, 'audio.webm');
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
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ reply: 'I could not hear anything in that voice message.' }));
          return;
        }

        webSessions[sid].push({ role: 'user', content: transcribedText });
        if (webSessions[sid].length > MAX_HISTORY) webSessions[sid] = webSessions[sid].slice(-MAX_HISTORY);
        const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...webSessions[sid]];
        const reply = await askGroq(messages);
        webSessions[sid].push({ role: 'assistant', content: reply.slice(0, 150) });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply, transcribed: transcribedText }));
      } catch (e) {
        console.error('Voice endpoint error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not process voice message.' }));
      }
    });
    return;
  }

  // ── GET /status — Health check ──
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'online', whatsapp: isConnected }));
    return;
  }

  // ── GET / — Serve web chat UI ──
  res.writeHead(200, { 'Content-Type': 'text/html' });
  try {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    res.end(html);
  } catch (e) {
    res.end('<h1>Chat UI not found. Make sure public/index.html exists.</h1>');
  }
});

server.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log('Server running on port', process.env.PORT || 3000);
  console.log('Web API available at POST /chat');
  connectToWhatsApp();
});

process.on('unhandledRejection', reason => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err.message));
