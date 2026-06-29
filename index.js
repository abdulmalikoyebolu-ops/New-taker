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
const http = require('http');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

// ─── Config ───────────────────────────────────────────────────────────────────
const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const AUTH_FOLDER    = './auth_info';
const MAX_HISTORY    = 20;
const PORT           = process.env.PORT || 3000;

// Current active Groq models (updated June 2026)
const CHAT_MODEL   = 'openai/gpt-oss-20b';           // fast chat model
const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'; // vision (Scout still active)
const VISION_FALLBACK = 'openai/gpt-oss-120b';        // fallback if Scout is down

// ─── Prompts ──────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Vektra, a smart, witty and warm AI assistant built by VektraStudio. You have a genuine personality — you are curious, empathetic, and engaging. You respond like a knowledgeable friend who actually listens and thinks before replying. Your conversations flow naturally — you build on what was said before, ask follow-up questions when relevant, share your perspective, and never give robotic one-liners. You match the energy of the person you are talking to: casual and fun when they are relaxed, focused and detailed when they need help with something serious. You use emojis naturally, not excessively. No markdown formatting — no asterisks, no hashtags, no bullet points. Always write in plain natural text. You always reply in English. You understand Nigerian slangs: How far means how are you. Omo means wow or my friend. Abeg means please. Wahala means trouble. No wahala means no problem. Na so means exactly. Sabi means to know. Wetin means what. Oya means okay let us go. Shey means right or is it not. Ehen means yes or I see. Guy and Bros mean friend. E don do means it is finished. If asked who made you, say you are Vektra, an AI assistant built by VektraStudio. Never reveal personal names. The current year is 2026. Remember context from earlier in the conversation and refer back to it naturally.`;

const SEARCH_SYSTEM_PROMPT = `You are Vektra, a smart AI assistant built by VektraStudio. You have access to real-time web search results. Use the search results to give accurate, up-to-date answers. Be conversational and natural — explain things clearly like you are talking to a friend. No markdown formatting, no bullet points, no asterisks. Plain natural text only. The current year is 2026.`;

const VISION_PROMPT = `You are Vektra, a smart and witty AI assistant built by VektraStudio. Someone just sent you an image, possibly with a question or caption.

MOST IMPORTANT RULE: If the user included a caption or question about the image, answer that question directly and accurately first. The caption is their actual request. For example if they ask "what is that woman doing?" look at the image and answer clearly. If they ask "what does this say?" read and explain it. Always answer the question they asked first. After answering, you can add a short casual comment like a friend would.

If there is NO caption or question, react casually like a friend:
- Selfie or person: say things like "wait is this you?", "bro you look fresh 🔥", "caught you chilling 😂"
- Place or scenery: "where is this?", "this looks calm fr", "yo this place is nice!"
- Food: react like you are hungry or impressed
- Meme or funny image: laugh and match the energy
- Document, receipt, or text: read it and summarize clearly
- Social media screenshot: talk about what is happening, give your take

Always sound natural and conversational. No markdown, no bullet points. Plain text only.`;

const SEARCH_KEYWORDS = [
  'search online', 'google it', 'check online', 'find out', 'look up',
  'latest news', 'current price', 'breaking news', 'weather today', 'who won',
  'live score', 'this week news', 'search for', 'check the internet', 'search it',
  'look online', 'find online', 'check it online', 'what happened', 'online'
];

// ─── State ────────────────────────────────────────────────────────────────────
let latestQR    = null;
let isConnected = false;
let sock        = null;
let conversations = {}; // WhatsApp sessions
let webSessions   = {}; // Web app sessions

// ─── Helpers ──────────────────────────────────────────────────────────────────
function needsWebSearch(text) {
  const lower = text.toLowerCase();
  return SEARCH_KEYWORDS.some(kw => lower.includes(kw));
}

async function askGroq(messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages,
        max_tokens: 800,
        temperature: 0.7,
        include_reasoning: false
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Groq API error');
    return data.choices[0].message.content;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

async function askGroqVision(base64Image, mimeType, caption) {
  // Try primary vision model first, fall back if it fails
  const models = [VISION_MODEL, VISION_FALLBACK];

  for (const model of models) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: VISION_PROMPT + (caption ? `\n\nUser question/caption: "${caption}"` : '')
              },
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64Image}` }
              }
            ]
          }],
          max_tokens: 400,
          temperature: 0.8
        })
      });

      const data = await res.json();
      if (!res.ok) {
        console.error(`Vision model ${model} error:`, data.error?.message);
        continue; // try next model
      }
      console.log(`Vision handled by: ${model}`);
      return data.choices[0].message.content;
    } catch (e) {
      console.error(`Vision model ${model} failed:`, e.message);
      // try next model
    }
  }

  throw new Error('All vision models failed');
}

async function tavilySearch(query) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: 'basic',
      max_results: 3
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Tavily search failed');
  return data.results.map(r => `${r.title}: ${r.content}`).join(' | ');
}

async function getReply(sessionHistory, message, useSearch) {
  if (useSearch) {
    try {
      const searchResults = await tavilySearch(message);
      return await askGroq([
        { role: 'system', content: `${SEARCH_SYSTEM_PROMPT} Here are the search results: ${searchResults}` },
        { role: 'user', content: message }
      ]);
    } catch (searchErr) {
      console.error('Search failed, falling back:', searchErr.message);
      return await askGroq([
        { role: 'system', content: `${SYSTEM_PROMPT} Note: web search is unavailable right now, answer from training data and mention this briefly.` },
        ...sessionHistory
      ]);
    }
  }
  return await askGroq([
    { role: 'system', content: SYSTEM_PROMPT },
    ...sessionHistory
  ]);
}

function trimHistory(history) {
  if (history.length > MAX_HISTORY) return history.slice(-MAX_HISTORY);
  return history;
}

// ─── WhatsApp Bot ─────────────────────────────────────────────────────────────
async function connectToWhatsApp() {
  if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
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
      console.log('QR ready — visit the bot URL to scan.');
    }
    if (connection === 'open') {
      latestQR = null;
      isConnected = true;
      console.log('WhatsApp bot is online!');
    }
    if (connection === 'close') {
      isConnected = false;
      latestQR = null;
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode : 0;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`Connection closed. Code: ${code} | Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log('Logged out — clearing auth...');
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

        // ── Image / Sticker ──
        const isImage   = !!msgContent.imageMessage;
        const isSticker = !!msgContent.stickerMessage;
        if (isImage || isSticker) {
          try {
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            const buffer = await downloadMediaMessage(
              message, 'buffer', {},
              { logger, reuploadRequest: sock.updateMediaMessage }
            );
            const mimeType = isSticker ? 'image/webp' : (msgContent.imageMessage?.mimetype || 'image/jpeg');
            const base64   = buffer.toString('base64');
            const caption  = isImage ? (msgContent.imageMessage?.caption || '') : '';
            const reply    = await askGroqVision(base64, mimeType, caption);
            await sock.sendMessage(jid, { text: reply }, { quoted: message });
          } catch (e) {
            console.error('Vision error:', e.message);
            await sock.sendMessage(jid, { text: 'Lol I saw it but my eyes glitched 😅 send again!' }, { quoted: message });
          }
          await sock.sendPresenceUpdate('paused', jid);
          continue;
        }

        // ── Voice ──
        if (!!msgContent.audioMessage) {
          try {
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            const buffer    = await downloadMediaMessage(message, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            const audioBlob = new Blob([buffer], { type: msgContent.audioMessage?.mimetype || 'audio/ogg' });
            const formData  = new FormData();
            formData.append('file', audioBlob, 'audio.ogg');
            formData.append('model', 'whisper-large-v3');
            formData.append('response_format', 'json');

            const transcribeRes  = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
              body: formData
            });
            const transcribeData = await transcribeRes.json();
            if (!transcribeRes.ok) throw new Error(transcribeData.error?.message || 'Transcription failed');

            const text = transcribeData.text?.trim();
            if (!text) {
              await sock.sendMessage(jid, { text: 'I could not hear anything in that voice note 🎤' }, { quoted: message });
            } else {
              conversations[jid].push({ role: 'user', content: text });
              conversations[jid] = trimHistory(conversations[jid]);
              const reply = await askGroq([{ role: 'system', content: SYSTEM_PROMPT }, ...conversations[jid]]);
              conversations[jid].push({ role: 'assistant', content: reply.slice(0, 150) });
              await sock.sendMessage(jid, { text: reply }, { quoted: message });
            }
          } catch (e) {
            console.error('Voice error:', e.message);
            await sock.sendMessage(jid, { text: 'Could not process your voice note, try again! 😅' }, { quoted: message });
          }
          await sock.sendPresenceUpdate('paused', jid);
          continue;
        }

        // ── Text ──
        const text = (
          msgContent.conversation ||
          msgContent.extendedTextMessage?.text || ''
        ).trim();

        if (!text) { await sock.sendPresenceUpdate('paused', jid); continue; }

        if (text === '/clear') {
          conversations[jid] = [];
          await sock.sendMessage(jid, { text: 'Memory cleared! Fresh start 🧹' }, { quoted: message });
          await sock.sendPresenceUpdate('paused', jid);
          continue;
        }
        if (text === '/help') {
          await sock.sendMessage(jid, { text: 'Commands:\n/clear - Clear chat memory\n/help - Show this message\n\nJust type normally to chat! 😊' }, { quoted: message });
          await sock.sendPresenceUpdate('paused', jid);
          continue;
        }

        conversations[jid].push({ role: 'user', content: text });
        conversations[jid] = trimHistory(conversations[jid]);

        const reply = await getReply(conversations[jid], text, needsWebSearch(text));
        conversations[jid].push({ role: 'assistant', content: reply.slice(0, 150) });

        await sock.sendMessage(jid, { text: reply }, { quoted: message });
        await sock.sendPresenceUpdate('paused', jid);

      } catch (e) {
        console.error('Message handling error:', e.message);
      }
    }
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── POST /chat ──
  if (req.method === 'POST' && req.url === '/chat') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { message, sessionId } = JSON.parse(body);
        if (!message?.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Message is required' }));
        }
        const sid = sessionId || 'default';
        if (!webSessions[sid]) webSessions[sid] = [];

        webSessions[sid].push({ role: 'user', content: message });
        webSessions[sid] = trimHistory(webSessions[sid]);

        const reply = await getReply(webSessions[sid], message, needsWebSearch(message));
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

  // ── POST /clear ──
  if (req.method === 'POST' && req.url === '/clear') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { sessionId } = JSON.parse(body || '{}');
        webSessions[sessionId || 'default'] = [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Memory cleared!' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  // ── POST /vision ──
  if (req.method === 'POST' && req.url === '/vision') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { image, mimeType, caption, sessionId } = JSON.parse(body);
        if (!image) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Image data required' }));
        }
        const sid = sessionId || 'default';
        if (!webSessions[sid]) webSessions[sid] = [];

        const reply = await askGroqVision(image, mimeType || 'image/jpeg', caption || '');

        // Save image context so follow-up questions work
        webSessions[sid].push({ role: 'user', content: caption ? `I sent you an image with caption: ${caption}` : 'I sent you an image' });
        webSessions[sid].push({ role: 'assistant', content: reply.slice(0, 300) });
        webSessions[sid] = trimHistory(webSessions[sid]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply }));
      } catch (e) {
        console.error('Vision endpoint error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not analyze image. Please try again.' }));
      }
    });
    return;
  }

  // ── POST /voice ──
  if (req.method === 'POST' && req.url === '/voice') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { audio, mimeType, sessionId } = JSON.parse(body);
        if (!audio) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Audio data required' }));
        }
        const sid = sessionId || 'default';
        if (!webSessions[sid]) webSessions[sid] = [];

        const audioBuffer = Buffer.from(audio, 'base64');
        const audioBlob   = new Blob([audioBuffer], { type: mimeType || 'audio/webm' });
        const formData    = new FormData();
        formData.append('file', audioBlob, 'audio.webm');
        formData.append('model', 'whisper-large-v3');
        formData.append('response_format', 'json');

        const transcribeRes  = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
          body: formData
        });
        const transcribeData = await transcribeRes.json();
        if (!transcribeRes.ok) throw new Error(transcribeData.error?.message || 'Transcription failed');

        const text = transcribeData.text?.trim();
        if (!text) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ reply: 'I could not hear anything in that voice message 🎤' }));
        }

        webSessions[sid].push({ role: 'user', content: text });
        webSessions[sid] = trimHistory(webSessions[sid]);

        const reply = await askGroq([{ role: 'system', content: SYSTEM_PROMPT }, ...webSessions[sid]]);
        webSessions[sid].push({ role: 'assistant', content: reply.slice(0, 300) });
        webSessions[sid] = trimHistory(webSessions[sid]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply, transcribed: text }));
      } catch (e) {
        console.error('Voice endpoint error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not process voice message.' }));
      }
    });
    return;
  }

  // ── POST /feedback ──
  if (req.method === 'POST' && req.url === '/feedback') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { type, message, comment, sessionId, time } = JSON.parse(body);
        const emoji   = type === 'thumbs_up' ? '👍' : '👎';
        const subject = `${emoji} Vektra Feedback: ${type.replace('_', ' ')}`;
        const text    = `Feedback: ${emoji} ${type.toUpperCase()}\n\nComment:\n${comment || '(none)'}\n\nBot Message:\n${message}\n\nSession: ${sessionId}\nTime: ${time}`;

        if (process.env.RESEND_API_KEY) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'Vektra Bot <onboarding@resend.dev>',
              to: ['abdulmalikoyebolu3@gmail.com'],
              subject,
              text
            })
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('Feedback error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to send feedback' }));
      }
    });
    return;
  }

  // ── GET /status ──
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'online', whatsapp: isConnected }));
    return;
  }

  // ── GET / — Serve web UI ──
  res.writeHead(200, { 'Content-Type': 'text/html' });
  try {
    res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
  } catch (e) {
    res.end('<h1>index.html not found. Make sure it exists in the same folder.</h1>');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Vision model: ${VISION_MODEL} (fallback: ${VISION_FALLBACK})`);
  connectToWhatsApp();
});

process.on('unhandledRejection', r => console.error('Unhandled Rejection:', r));
process.on('uncaughtException',  e => console.error('Uncaught Exception:', e.message));
