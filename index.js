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
const GROQ_API_KEY     = process.env.GROQ_API_KEY;
const TAVILY_API_KEY   = process.env.TAVILY_API_KEY;
const GOOGLE_API_KEY   = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID    = process.env.GOOGLE_CSE_ID;
const AUTH_FOLDER      = './auth_info';
const MAX_HISTORY      = 60;
const PORT             = process.env.PORT || 3000;

const CHAT_MODEL      = 'openai/gpt-oss-20b';
const VISION_MODEL    = 'qwen/qwen3.8-27b';
const VISION_FALLBACK = 'qwen/qwen3.8-27b'; // retry (without reasoning_effort) if the first attempt fails

// ─── Prompts ──────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Vektra, a smart, witty and warm AI assistant built by VektraStudio. You have a genuine personality — you are curious, empathetic, and engaging. You respond like a knowledgeable friend who actually listens and thinks before replying. Your conversations flow naturally — you build on what was said before, ask follow-up questions when relevant, share your perspective, and never give robotic one-liners. You match the energy of the person you are talking to: casual and fun when they are relaxed, focused and detailed when they need help with something serious. You love emojis: add fitting emojis often so your replies feel lively, warm and fun, usually two or three per reply, placed naturally. Match the format to the message. For greetings, small talk, opinions and simple questions, reply the way a friend would text: one to three short natural sentences with a couple of fitting emojis, and never a list. Never give several alternative replies or several versions of the same answer, give exactly one answer. Only when the user asks for information that truly has several separate parts (steps, a comparison, a set of items, an explanation with distinct points) use this structure: one short intro line, a blank line, then a plain numbered list (1. 2. 3.) with each item on its own new line as a fitting emoji, a short title, a dash, and a one or two sentence explanation, for example: 1. 🔥 Title – explanation (use dot bullets • when the order does not matter, and always write the numbers as plain digits, never emoji numbers), then a blank line and a short friendly wrap-up line with an emoji. Never use asterisks, hashtags or markdown symbols. You always reply in English. You understand Nigerian slangs: How far means how are you. Omo means wow or my friend. Abeg means please. Wahala means trouble. No wahala means no problem. Na so means exactly. Sabi means to know. Wetin means what. Oya means okay let us go. Shey means right or is it not. Ehen means yes or I see. Guy and Bros mean friend. E don do means it is finished. If asked who made you, say you are Vektra, an AI assistant built by VektraStudio. Never reveal personal names. The current year is 2026. Remember context from earlier in the conversation and refer back to it naturally.

Accuracy rule: you do not have live information and your training data has a cutoff, so specific facts like release dates, version numbers, prices, current events, or anything that changes over time may be outdated or simply wrong in your memory. If a question depends on a fact like that and you are not fully certain, say so plainly instead of stating a guess as if it were confirmed — for example say something like "I'm not fully sure on that, it might have changed" rather than inventing a specific date or number. Being honestly uncertain is always better than sounding confident and being wrong. This also applies to the user: never guess or invent their name or any personal detail about them, and never answer a question about them with a joke, a song lyric or a made-up name. If you do not know it, say so warmly and ask, for example: I don't think you've told me your name yet, what should I call you? 😊`;

const SEARCH_SYSTEM_PROMPT = `You are Vektra, a smart AI assistant built by VektraStudio. You have access to real-time web search results below. Use them to give accurate, up-to-date answers — trust the search results over your own memory if they conflict. If the search results do not actually answer the question, say so honestly instead of guessing. Be conversational and natural, like you are talking to a friend. Answer simple questions in one or two short sentences, and use fitting emojis often. Only when the answer has several distinct items use one short intro line, then a plain numbered list (1. 2. 3.) or dot bullets (•) with each item on its own new line starting with a fitting emoji after the number, then a short friendly wrap-up with an emoji. Give exactly one answer, never several alternatives. No asterisks, hashtags or markdown symbols. The current year is 2026.`;

const VISION_PROMPT = `You are Vektra, a smart and witty AI assistant built by VektraStudio. Someone just sent you an image, possibly with a question or caption.

MOST IMPORTANT RULE: If the user included a caption or question about the image, answer that question directly and accurately first. The caption is their actual request. For example if they ask "what is that woman doing?" look at the image and answer clearly. If they ask "what does this say?" read and explain it. Always answer the question they asked first. After answering, you can add a short casual comment like a friend would.

If there is NO caption or question, react casually like a friend:
- Selfie or person: say things like "wait is this you?", "bro you look fresh 🔥", "caught you chilling 😂"
- Place or scenery: "where is this?", "this looks calm fr", "yo this place is nice!"
- Food: react like you are hungry or impressed
- Meme or funny image: laugh and match the energy
- Document, receipt, or text: read it and summarize clearly
- Social media screenshot: talk about what is happening, give your take

Always sound natural and conversational. Use short paragraphs with a blank line between them. No asterisks, hashtags or markdown symbols.`;

// ─── State ────────────────────────────────────────────────────────────────────
let latestQR      = null;
let isConnected    = false;
let sock           = null;
let conversations  = {};
let webSessions    = {};

// ─── Long-term memory: durable facts about each user (name, likes, etc.) ──────
const MEMORY_FILE = process.env.MEMORY_FILE || './memories.json';
let memories = {};
try { memories = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch (e) { memories = {}; }
function saveMemories() {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(memories)); } catch (e) { /* disk may be read-only, ignore */ }
}
const PERSONAL = /\b(my name|call me|i am|i'm|im|i live|i stay|i come from|i work|i study|i like|i love|i hate|my favou?rite|my (birthday|age|job|school|city|country|brother|sister|friend|dad|mom|mum|girlfriend|boyfriend|wife|husband)|remember)\b/i;
async function learnFacts(id, text) {
  try {
    if (!PERSONAL.test(text)) return;
    const existing = memories[id] || '';
    const out = await askGroq([
      { role: 'system', content: "You keep short notes about a user. Given the existing notes and the user's new message, return the updated notes as short lines (max 12 lines, each one a durable fact such as name, location, job, school, likes, dislikes, family, goals). Only keep facts the user stated about themselves. If the new message adds nothing new, return the existing notes unchanged. If there are no notes at all, return NONE. Return only the notes, with no extra words." },
      { role: 'user', content: `Existing notes:\n${existing || 'NONE'}\n\nNew message: ${text}` }
    ]);
    const cleaned = (out || '').trim();
    if (cleaned && !/^NONE$/i.test(cleaned)) {
      memories[id] = cleaned.slice(0, 1500);
      saveMemories();
    }
  } catch (e) {
    console.error('learnFacts failed:', e.message);
  }
}

// ─── Fetch with timeout helper (reliability) ──────────────────────────────────
async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Search decision (with safer failure default) ─────────────────────────────
async function shouldSearch(message, history = []) {
  const casual = /^(hi|hey|hello|yo|sup|how far|lol|lmao|haha+|thanks|thank you|ok+|okay|nice|cool|i see|i understand|oh+|wow|alright|got it|hmm+|yeah|yep|true|damn|omo|wahala|ehen|oya|noted|makes sense|interesting|ah+)\b/i;
  const trimmed = message.trim();
  if (casual.test(trimmed) && trimmed.length < 30) return false;
  if (/^[\p{Extended_Pictographic}\s\uFE0F]+$/u.test(trimmed)) return false;
  const recent = history.slice(-5, -1).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');

  try {
    const res = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          {
            role: 'system',
            content: 'Reply with ONLY one word: SEARCH or CHAT. Say SEARCH if answering accurately requires current facts, specific dates, prices, versions, real people/events, or anything that could be outdated or wrong from memory. Say CHAT for casual conversation, reactions, opinions, jokes, questions about fiction or general knowledge that does not change over time, and for any follow-up or reaction that simply continues the recent conversation.'
          },
          { role: 'user', content: (recent ? `Recent conversation:\n${recent}\n\n` : '') + `Latest message: ${message}` }
        ],
        max_tokens: 5,
        temperature: 0
      })
    }, 8000);
    const data = await res.json();
    const decision = data.choices?.[0]?.message?.content?.trim().toUpperCase();
    // If we got a clear CHAT decision, trust it. Anything else (SEARCH, unclear, missing) — search.
    return decision !== 'CHAT';
  } catch (e) {
    console.error('Search classifier failed, defaulting to SEARCH (safer than guessing):', e.message);
    return true;
  }
}

// ─── Search providers: Google primary, Tavily fallback, both timeout-guarded ──
async function googleSearch(query) {
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) throw new Error('Google Search not configured');

  const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}&num=5`;
  const res = await fetchWithTimeout(url, {}, 10000);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Google Search API error');
  if (!data.items || data.items.length === 0) throw new Error('No Google results');

  return data.items
    .map(item => `${item.title}: ${item.snippet}`)
    .join(' | ');
}

async function tavilySearch(query) {
  if (!TAVILY_API_KEY) throw new Error('Tavily not configured');

  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: 'basic',
      max_results: 5
    })
  }, 10000);
  const data = await res.json();
  if (!res.ok) throw new Error('Tavily search failed');
  return data.results.map(r => `${r.title}: ${r.content}`).join(' | ');
}

async function webSearch(query) {
  try {
    const results = await googleSearch(query);
    console.log('Search source: Google');
    return results;
  } catch (googleErr) {
    console.error('Google Search failed, trying Tavily:', googleErr.message);
    try {
      const results = await tavilySearch(query);
      console.log('Search source: Tavily');
      return results;
    } catch (tavilyErr) {
      console.error('Tavily also failed:', tavilyErr.message);
      return null;
    }
  }
}

// ─── Groq helpers, with one retry on transient failure ────────────────────────
async function askGroqOnce(messages) {
  const res = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages,
      max_tokens: 1200,
      temperature: 0.7,
      include_reasoning: false
    })
  }, 30000);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Groq API error');
  return data.choices[0].message.content;
}

async function askGroq(messages) {
  try {
    return await askGroqOnce(messages);
  } catch (e) {
    console.error('Groq call failed, retrying once:', e.message);
    // Brief pause before retry so we don't hammer a struggling API
    await new Promise(r => setTimeout(r, 800));
    return await askGroqOnce(messages);
  }
}

async function askGroqVision(base64Image, mimeType, caption) {
  const models = [VISION_MODEL, VISION_FALLBACK];

  for (const [attempt, model] of models.entries()) {
    try {
      const res = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          ...(attempt === 0 ? { reasoning_effort: 'none' } : {}),
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
          max_tokens: 800,
          temperature: 0.7
        })
      }, 25000);

      const data = await res.json();
      if (!res.ok) {
        console.error(`Vision model ${model} error:`, data.error?.message);
        continue;
      }
      console.log(`Vision handled by: ${model}`);
      return data.choices[0].message.content;
    } catch (e) {
      console.error(`Vision model ${model} failed:`, e.message);
    }
  }

  throw new Error('All vision models failed');
}

async function getReply(sessionHistory, message, useSearch, memory) {
  const memNote = memory
    ? ` Things you already know about this user from earlier chats: ${memory}. Use them naturally, and if they ask what their name is or what you remember about them, answer from these notes.`
    : ` You do not know this user's name or any personal details yet, unless they told you earlier in this conversation. Never guess or make them up. If they ask about their name or about themselves, say honestly that you don't know yet and ask them.`;
  if (useSearch) {
    let query = message;
    if (message.trim().split(/\s+/).length < 6) {
      const prevUser = [...sessionHistory].reverse().slice(1).find(m => m.role === 'user');
      if (prevUser) query = `${prevUser.content} ${message}`;
    }
    const searchResults = await webSearch(query);
    if (searchResults) {
      return await askGroq([
        { role: 'system', content: `${SEARCH_SYSTEM_PROMPT}${memNote} Use the earlier conversation for context. Here are the search results: ${searchResults}` },
        ...sessionHistory
      ]);
    }
    return await askGroq([
      { role: 'system', content: `${SYSTEM_PROMPT}${memNote} Note: web search is unavailable right now. If this question needs current/factual info you are not certain about, say so briefly instead of guessing.` },
      ...sessionHistory
    ]);
  }
  return await askGroq([
    { role: 'system', content: SYSTEM_PROMPT + memNote },
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

        if (!!msgContent.audioMessage) {
          try {
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            const buffer    = await downloadMediaMessage(message, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            const audioBlob = new Blob([buffer], { type: msgContent.audioMessage?.mimetype || 'audio/ogg' });
            const formData  = new FormData();
            formData.append('file', audioBlob, 'audio.ogg');
            formData.append('model', 'whisper-large-v3');
            formData.append('response_format', 'json');

            const transcribeRes  = await fetchWithTimeout('https://api.groq.com/openai/v1/audio/transcriptions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
              body: formData
            }, 25000);
            const transcribeData = await transcribeRes.json();
            if (!transcribeRes.ok) throw new Error(transcribeData.error?.message || 'Transcription failed');

            const text = transcribeData.text?.trim();
            if (!text) {
              await sock.sendMessage(jid, { text: 'I could not hear anything in that voice note 🎤' }, { quoted: message });
            } else {
              conversations[jid].push({ role: 'user', content: text });
        learnFacts(jid, text);
              conversations[jid] = trimHistory(conversations[jid]);
              const reply = await getReply(conversations[jid], text, await shouldSearch(text, conversations[jid]), memories[jid]);
              conversations[jid].push({ role: 'assistant', content: reply.slice(0, 600) });
              await sock.sendMessage(jid, { text: reply }, { quoted: message });
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
        learnFacts(jid, text);
        conversations[jid] = trimHistory(conversations[jid]);

        const reply = await getReply(conversations[jid], text, await shouldSearch(text, conversations[jid]), memories[jid]);
        conversations[jid].push({ role: 'assistant', content: reply.slice(0, 600) });

        await sock.sendMessage(jid, { text: reply }, { quoted: message });
        await sock.sendPresenceUpdate('paused', jid);

      } catch (e) {
        console.error('Message handling error:', e.message);
        try {
          await sock.sendMessage(message.key.remoteJid, { text: 'Something went wrong on my end, try that again in a sec 😅' }, { quoted: message });
        } catch (sendErr) {
          console.error('Could not even send the error message:', sendErr.message);
        }
      }
    }
  });
}

// ─── UI fix injected into the web page when it is served ──────────────────────
const UI_FIX_CSS = String.raw`
/* Use the device's own font */
html body, html body button, html body input, html body textarea{
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue","Noto Sans",Arial,"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif !important;
}
/* Input bar visibility */
.input-wrap{
  background:#1c1c21;
  border:1px solid rgba(255,255,255,0.22);
  box-shadow:0 4px 20px rgba(0,0,0,0.5);
  backdrop-filter:none;-webkit-backdrop-filter:none;
  transition:box-shadow .3s ease, border-color .3s ease, min-height .3s ease;
}
body.light .input-wrap{
  background:#ececf1;
  border:1px solid rgba(0,0,0,0.18);
  box-shadow:0 4px 16px rgba(0,0,0,0.08);
}
.input-wrap:focus-within{
  border-color:rgba(167,139,250,0.7);
  box-shadow:0 0 0 3px rgba(124,58,237,0.18), 0 8px 28px rgba(0,0,0,0.5);
}
body.light .input-wrap:focus-within{
  border-color:rgba(124,58,237,0.6);
  box-shadow:0 0 0 3px rgba(124,58,237,0.14), 0 8px 28px rgba(0,0,0,0.1);
}
#msginput::placeholder{color:rgba(255,255,255,0.45);}
body.light #msginput::placeholder{color:rgba(0,0,0,0.5);}

/* Reply formatting */
.row.bot .bubble .vk-p{margin:0 0 .8em;text-align:left;}
.row.bot .bubble .vk-li{display:flex;align-items:flex-start;gap:.55em;margin:0 0 .6em;}
.row.bot .bubble .vk-m{flex:0 0 auto;min-width:1.5em;text-align:left;}
.row.bot .bubble .vk-m.n{color:var(--accent-l);font-weight:600;}
.row.bot .bubble .vk-t{flex:1;min-width:0;word-break:break-word;}
.row.bot .bubble .vk-li + .vk-p{margin-top:.9em;}
.row.bot .bubble > :last-child{margin-bottom:0;}
.row.bot .bubble strong{font-weight:700;}
`;

const UI_FIX_JS = String.raw`
(function(){
  var ITEM=/^(\d\uFE0F?\u20E3|\d{1,2}[.)]|[-\u2022*]|[\u{1F300}-\u{1FAFF}\u2600-\u27BF]\uFE0F?)\s+(\S.*)$/u;
  function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function inline(s){
    s=s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
    s=s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g,'$1<em>$2</em>');
    return s;
  }
  function boldTitle(b){
    if(/<strong>/.test(b))return b;
    var m=b.match(/^([^<]{2,40}?)(\s[\u2013\u2014-]\s|:\s)/);
    return m?'<strong>'+m[1]+'</strong>'+b.slice(m[1].length):b;
  }
  function normalize(t){
    t=t.replace(/\r/g,'');
    t=t.replace(/\s*(\d\uFE0F?\u20E3)\s*/g,'\n$1 ');
    t=t.replace(/([.!?:])\s+(\d{1,2})[.)]\s+(?=\S)/g,'$1\n$2. ');
    t=t.replace(/([.!?:])\s+[-\u2022]\s+(?=\S)/g,'$1\n- ');
    return t;
  }
  function fmt(t){
    var lines=normalize(String(t)).split('\n').map(function(l){return l.trim();}).filter(Boolean);
    if(lines.length===1&&lines[0].length>300){
      var parts=lines[0].match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g)||[lines[0]];
      lines=parts.reduce(function(a,s,i){if(i%3===0)a.push(s.trim());else a[a.length-1]+=' '+s.trim();return a;},[]);
    }
    return lines.map(function(l){
      var m=l.match(ITEM);
      if(m){
        var mk=m[1].replace(/^(\d)\uFE0F?\u20E3$/,'$1.'),num=/^\d{1,2}[.)]$/.test(mk);
        if(/^[-\u2022*]$/.test(mk))mk='\u2022';
        return '<div class="vk-li"><span class="vk-m'+(num?' n':'')+'">'+esc(mk)+'</span><span class="vk-t">'+boldTitle(inline(esc(m[2])))+'</span></div>';
      }
      return '<p class="vk-p">'+inline(esc(l))+'</p>';
    }).join('');
  }
  window.vektraFmt=fmt;
  var _f=window.fetch;
  window.fetch=function(url,opts){
    var isChat=typeof url==='string'&&/\/(chat|voice)$/.test(url);
    if(isChat&&opts&&typeof opts.body==='string'){
      try{
        var b=JSON.parse(opts.body);
        b.memory=localStorage.getItem('vektra_mem')||'';
        opts=Object.assign({},opts,{body:JSON.stringify(b)});
      }catch(e){}
    }
    var p=_f.call(this,url,opts);
    if(isChat){p.then(function(r){r.clone().json().then(function(d){
      if(d&&typeof d.memory==='string'&&d.memory)localStorage.setItem('vektra_mem',d.memory);
    }).catch(function(){});}).catch(function(){});}
    return p;
  };
  var _a=addMsg;
  addMsg=function(text,role,htmlStr,domEl,extra){
    _a.apply(this,arguments);
    if(role==='bot'&&text&&!htmlStr&&!domEl){
      var row=msgs.lastElementChild,b=row&&row.querySelector('.bubble');
      if(b)b.innerHTML=fmt(text);
    }
  };
})();
`;

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/chat') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { message, sessionId, memory: clientMemory } = JSON.parse(body);
        if (!message?.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Message is required' }));
        }
        const sid = sessionId || 'default';
        if (!webSessions[sid]) webSessions[sid] = [];
        if (clientMemory && !memories[sid]) memories[sid] = String(clientMemory).slice(0, 1500);

        webSessions[sid].push({ role: 'user', content: message });
        learnFacts(sid, message);
        webSessions[sid] = trimHistory(webSessions[sid]);

        const reply = await getReply(webSessions[sid], message, await shouldSearch(message, webSessions[sid]), memories[sid]);
        webSessions[sid].push({ role: 'assistant', content: reply.slice(0, 600) });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply, memory: memories[sid] || '' }));
      } catch (e) {
        console.error('Web chat error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Something went wrong, try again!' }));
      }
    });
    return;
  }

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

        webSessions[sid].push({ role: 'user', content: caption ? `I sent you an image with caption: ${caption}` : 'I sent you an image' });
        webSessions[sid].push({ role: 'assistant', content: reply.slice(0, 600) });
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

  if (req.method === 'POST' && req.url === '/voice') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { audio, mimeType, sessionId, memory: clientMemory } = JSON.parse(body);
        if (!audio) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Audio data required' }));
        }
        const sid = sessionId || 'default';
        if (!webSessions[sid]) webSessions[sid] = [];

        if (clientMemory && !memories[sid]) memories[sid] = String(clientMemory).slice(0, 1500);
        const audioBuffer = Buffer.from(audio, 'base64');
        const audioBlob   = new Blob([audioBuffer], { type: mimeType || 'audio/webm' });
        const formData    = new FormData();
        formData.append('file', audioBlob, 'audio.webm');
        formData.append('model', 'whisper-large-v3');
        formData.append('response_format', 'json');

        const transcribeRes  = await fetchWithTimeout('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
          body: formData
        }, 25000);
        const transcribeData = await transcribeRes.json();
        if (!transcribeRes.ok) throw new Error(transcribeData.error?.message || 'Transcription failed');

        const text = transcribeData.text?.trim();
        if (!text) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ reply: 'I could not hear anything in that voice message 🎤' }));
        }

        webSessions[sid].push({ role: 'user', content: text });
        learnFacts(sid, text);
        webSessions[sid] = trimHistory(webSessions[sid]);

        const reply = await getReply(webSessions[sid], text, await shouldSearch(text, webSessions[sid]), memories[sid]);
        webSessions[sid].push({ role: 'assistant', content: reply.slice(0, 600) });
        webSessions[sid] = trimHistory(webSessions[sid]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply, transcribed: text, memory: memories[sid] || '' }));
      } catch (e) {
        console.error('Voice endpoint error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not process voice message.' }));
      }
    });
    return;
  }

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
        } else {
          console.log('RESEND_API_KEY not set — feedback logged here instead:', text);
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

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      whatsapp: isConnected,
      search: {
        google: !!(GOOGLE_API_KEY && GOOGLE_CSE_ID),
        tavily: !!TAVILY_API_KEY
      },
      feedbackEmail: !!process.env.RESEND_API_KEY
    }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  try {
    let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    html = html.replace('</head>', () => '<style id="vektra-ui-fix">' + UI_FIX_CSS + '</style>\n</head>');
    html = html.replace('</body>', () => '<script id="vektra-ui-fix-js">' + UI_FIX_JS + '</script>\n</body>');
    res.end(html);
  } catch (e) {
    res.end('<h1>index.html not found. Make sure it exists in the same folder.</h1>');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Vision model: ${VISION_MODEL} (fallback: ${VISION_FALLBACK})`);
  console.log(`Search: Google=${!!(GOOGLE_API_KEY && GOOGLE_CSE_ID)} Tavily=${!!TAVILY_API_KEY}`);
  console.log(`Feedback email: ${!!process.env.RESEND_API_KEY}`);
  connectToWhatsApp();
});

process.on('unhandledRejection', r => console.error('Unhandled Rejection:', r));
process.on('uncaughtException',  e => console.error('Uncaught Exception:', e.message));
