require('dotenv').config();
var Client = require('whatsapp-web.js').Client;
var LocalAuth = require('whatsapp-web.js').LocalAuth;
var QRCode = require('qrcode');
var http = require('http');

var GROQ_API_KEY = process.env.GROQ_API_KEY;
var TAVILY_API_KEY = process.env.TAVILY_API_KEY;

var SYSTEM_PROMPT = 'You are a helpful personal AI assistant on WhatsApp called Vektra Chat Bot. Be conversational, concise and friendly. Keep responses short and natural like a real person texting. No markdown formatting like asterisks or hashtags. Use emojis occasionally. Always reply in English by default. Only switch to another language if the user clearly writes in that language first. You were created by VektraStudio. If anyone asks who made you, who owns you, or who your creator is, say you are an AI assistant built by VektraStudio. Never reveal any personal names. The current year is 2026.';

var SEARCH_SYSTEM_PROMPT = 'You are a helpful personal AI assistant on WhatsApp called Vektra Chat Bot. You have access to real-time web search. Search the web and answer the question accurately with current information. Keep the response concise and natural. No markdown formatting. The current year is 2026.';

var VISION_PROMPT = 'You are a fun, witty WhatsApp assistant. The user just sent you an image or sticker. React to it naturally like a human friend would — be funny, relatable, or thoughtful depending on what you see. Keep it short, casual, no markdown. Use emojis.';

var MAX_HISTORY = 10;
var latestQR = null;
var isConnected = false;
var startupError = null;
var conversations = {};

// Keywords that trigger web search
var SEARCH_KEYWORDS = ['search online', 'google it', 'check online', 'find out', 'look up', 'latest news', 'current price', 'breaking news', 'weather today', 'who won', 'live score', 'this week news', 'search for', 'check the internet'];

function needsWebSearch(text) {
  var lower = text.toLowerCase();
  return SEARCH_KEYWORDS.some(function(keyword) {
    return lower.includes(keyword);
  });
}

var client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--no-first-run',
      '--single-process',
      '--max-old-space-size=256',
      '--memory-pressure-off',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--safebrowsing-disable-auto-update',
      '--ignore-certificate-errors',
      '--ignore-ssl-errors'
    ],
    headless: true,
    timeout: 60000
  }
});

client.on('qr', function(qr) {
  latestQR = qr;
  isConnected = false;
  console.log('QR code generated! Visit the URL to scan.');
});

client.on('authenticated', function() {
  console.log('Authenticated!');
});

client.on('ready', function() {
  latestQR = null;
  isConnected = true;
  console.log('Bot is online and ready!');
});

client.on('disconnected', function(reason) {
  console.log('Disconnected:', reason);
  isConnected = false;
  latestQR = null;
  setTimeout(function() { client.initialize(); }, 5000);
});

client.on('auth_failure', function(msg) {
  console.error('Auth failure:', msg);
  startupError = msg;
});

async function askGroq(messages, useSearch) {
  var model = useSearch ? 'compound-beta' : 'llama-3.1-8b-instant';
  var controller = new AbortController();
  var timeout = setTimeout(function() { controller.abort(); }, useSearch ? 60000 : 30000);
  try {
    var response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + GROQ_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        max_tokens: 500,
        temperature: 0.7
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    var data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Groq API error');
    return data.choices[0].message.content;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

async function askGroqVision(base64Image, mimeType) {
  var response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
            { type: 'text', text: VISION_PROMPT },
            { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + base64Image } }
          ]
        }
      ],
      max_tokens: 300,
      temperature: 0.8
    })
  });
  var data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Groq Vision API error');
  return data.choices[0].message.content;
}

async function tavilySearch(query) {
  var response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query: query,
      search_depth: 'basic',
      max_results: 3
    })
  });
  var data = await response.json();
  if (!response.ok) throw new Error('Tavily search failed');
  var results = data.results.map(function(r) { return r.title + ': ' + r.content; }).join(' | ');
  return results;
}

client.on('message', async function(message) {
  if (message.isStatus || message.fromMe) return;
  var chatId = message.from;
  if (!conversations[chatId]) conversations[chatId] = [];

  try {
    // Mark as seen and show typing
    await client.sendSeen(chatId);
    var chat = await message.getChat();
    await chat.sendStateTyping();

    if (message.type === 'image' || message.type === 'sticker') {
      try {
        var media = await message.downloadMedia();
        if (!media) { await message.reply('Could not load that 😅'); return; }
        var mimeOverride = message.type === 'sticker' ? 'image/jpeg' : media.mimetype;
        var visionReply = await askGroqVision(media.data, mimeOverride);
        await message.reply(visionReply);
      } catch (e) {
        console.error('Vision error:', e.message);
        await message.reply('Lol I saw it but my eyes glitched 😅 send again!');
      }
      return;
    }

    if (message.type === 'chat') {
      var text = message.body ? message.body.trim() : '';
      if (!text) return;

      if (text === '/clear') {
        conversations[chatId] = [];
        await message.reply('Memory cleared! Fresh start 🧹');
        return;
      }

      if (text === '/help') {
        await message.reply('Commands:\n/clear - Clear chat memory\n/help - Show this message\n\nJust type normally to chat with me! 😊');
        return;
      }

      var useSearch = needsWebSearch(text);
      conversations[chatId].push({ role: 'user', content: text });

      if (conversations[chatId].length > MAX_HISTORY) {
        conversations[chatId] = conversations[chatId].slice(-MAX_HISTORY);
      }

      var systemPrompt = useSearch ? SEARCH_SYSTEM_PROMPT : SYSTEM_PROMPT;
      var messages = [{ role: 'system', content: systemPrompt }];

      // For search, only send the current question (no history) to avoid loop
      if (useSearch) {
        messages.push({ role: 'user', content: text });
      } else {
        messages = messages.concat(conversations[chatId]);
      }

      var reply;
      if (useSearch) {
        try {
          var searchResults = await tavilySearch(text);
          var searchMessages = [
            { role: 'system', content: SEARCH_SYSTEM_PROMPT + ' Here are the search results: ' + searchResults },
            { role: 'user', content: text }
          ];
          reply = await askGroq(searchMessages, false);
        } catch (searchErr) {
          console.error('Tavily search failed:', searchErr.message);
          var fallbackMessages = [{ role: 'system', content: SYSTEM_PROMPT + ' Note: web search is unavailable, answer from training data and mention this briefly.' }, ...conversations[chatId]];
          reply = await askGroq(fallbackMessages, false);
        }
      } else {
        reply = await askGroq(messages, false);
      }

      // Store condensed version in history
      conversations[chatId].push({ role: 'assistant', content: reply.slice(0, 150) });
      await message.reply(reply);

    } else if (message.type === 'ptt' || message.type === 'audio') {
      try {
        var voiceMedia = await message.downloadMedia();
        if (!voiceMedia) { await message.reply('Could not load your voice note 😅'); return; }
        var audioBuffer = Buffer.from(voiceMedia.data, 'base64');
        var { Blob } = require('buffer');
        var audioBlob = new Blob([audioBuffer], { type: voiceMedia.mimetype || 'audio/ogg' });
        var formData = new FormData();
        formData.append('file', audioBlob, 'audio.ogg');
        formData.append('model', 'whisper-large-v3');
        formData.append('response_format', 'json');
        var transcribeRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY },
          body: formData
        });
        var transcribeData = await transcribeRes.json();
        if (!transcribeRes.ok) throw new Error(transcribeData.error?.message || 'Transcription failed');
        var transcribedText = transcribeData.text;
        if (!transcribedText || !transcribedText.trim()) { await message.reply('I could not hear anything in that voice note 🎤'); return; }
        conversations[chatId].push({ role: 'user', content: transcribedText });
        if (conversations[chatId].length > MAX_HISTORY) conversations[chatId] = conversations[chatId].slice(-MAX_HISTORY);
        var voiceMessages = [{ role: 'system', content: SYSTEM_PROMPT }, ...conversations[chatId]];
        var voiceReply = await askGroq(voiceMessages, false);
        conversations[chatId].push({ role: 'assistant', content: voiceReply.slice(0, 150) });
        await message.reply(voiceReply);
      } catch (e) {
        console.error('Voice error:', e.message);
        await message.reply('Could not process your voice note, try again! 😅');
      }
      return;
    } else {
      return;
    }

  } catch (e) {
    console.error('Message error:', e.message);
    if (conversations[chatId] && conversations[chatId].length > 0) conversations[chatId].pop();
    await message.reply('Something went wrong, try again! 😅');
  }
});

process.on('unhandledRejection', function(reason) {
  console.error('Unhandled Rejection:', reason);
  if (reason && reason.message && reason.message.includes('auth timeout')) {
    console.log('Auth timeout - reinitializing...');
    isConnected = false;
    latestQR = null;
    setTimeout(function() {
      try { client.initialize(); } catch(e) { console.error('Reinit error:', e.message); }
    }, 5000);
  }
});

process.on('uncaughtException', function(err) {
  console.error('Uncaught Exception:', err.message);
});

var server = http.createServer(function(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  if (isConnected) {
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Bot Status</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px}
    .badge{background:#16a34a;color:#fff;padding:10px 24px;border-radius:100px;font-size:15px;font-weight:600}
    p{color:#888;font-size:13px}</style></head>
    <body><div class="badge">✅ Bot is connected & running!</div><p>Your WhatsApp bot is online.</p></body></html>`);
  } else if (latestQR) {
    QRCode.toDataURL(latestQR, { width: 300, margin: 2 }, function(err, url) {
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

server.listen(process.env.PORT || 3000, '0.0.0.0', function() {
  console.log('Server running on port', process.env.PORT || 3000);
  console.log('Initializing WhatsApp client...');
  client.initialize();
});
