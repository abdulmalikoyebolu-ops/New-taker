require('dotenv').config();
var Client = require('whatsapp-web.js').Client;
var LocalAuth = require('whatsapp-web.js').LocalAuth;
var QRCode = require('qrcode');
var http = require('http');

var GROQ_API_KEY = process.env.GROQ_API_KEY;
var SYSTEM_PROMPT = 'You are a helpful personal AI assistant on WhatsApp called Vektra Chat Bot. Be conversational, concise and friendly. Keep responses short and natural. No markdown formatting like asterisks or hashtags. Use emojis occasionally. Always reply in English by default. Only switch to another language if the user clearly writes in that language first. Your creator and owner is Abdulmalik Oyebolu, also known as Vektra Studio. If anyone asks who made you, who owns you, or who your creator is, say it is Abdulmalik Oyebolu of Vektra Studio.';
var VISION_PROMPT = 'You are a fun, witty WhatsApp assistant. The user just sent you an image or sticker. React to it naturally like a human friend would — be funny, relatable, or thoughtful depending on what you see. Keep it short, casual, no markdown. Use emojis. Reply in the same language the user typically uses.';
var MAX_HISTORY = 20;
var latestQR = null;
var isConnected = false;
var startupError = null;
var conversations = {};

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

async function askGroq(messages) {
  var response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + GROQ_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: messages,
      max_tokens: 500,
      temperature: 0.7
    })
  });
  var data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Groq API error');
  return data.choices[0].message.content;
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

client.on('message', async function(message) {
  if (message.isStatus || message.fromMe) return;
  var chatId = message.from;
  if (!conversations[chatId]) conversations[chatId] = [];

  try {
    if (message.type === 'image' || message.type === 'sticker') {
      try {
        var media = await message.downloadMedia();
        if (!media) { await message.reply('Could not load that 😅'); return; }
        var mimeOverride = message.type === 'sticker' ? 'image/jpeg' : media.mimetype;
        var reply = await askGroqVision(media.data, mimeOverride);
        await message.reply(reply);
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

      conversations[chatId].push({ role: 'user', content: text });

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
        var voiceReply = await askGroq(voiceMessages);
        conversations[chatId].push({ role: 'assistant', content: voiceReply });
        await message.reply(voiceReply);
      } catch (e) {
        console.error('Voice error:', e.message);
        await message.reply('Could not process your voice note, try again! 😅');
      }
      return;
    } else {
      return;
    }

    if (conversations[chatId].length > MAX_HISTORY) {
      conversations[chatId] = conversations[chatId].slice(-MAX_HISTORY);
    }

    var messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...conversations[chatId]];
    var reply = await askGroq(messages);
    conversations[chatId].push({ role: 'assistant', content: reply });
    await message.reply(reply);

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
