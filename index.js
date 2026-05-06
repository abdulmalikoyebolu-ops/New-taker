require('dotenv').config();
var Client = require('whatsapp-web.js').Client;
var LocalAuth = require('whatsapp-web.js').LocalAuth;
var QRCode = require('qrcode');
var http = require('http');
var GoogleGenerativeAI = require('@google/generative-ai').GoogleGenerativeAI;

var GEMINI_API_KEY = process.env.GEMINI_API_KEY;
var SYSTEM_PROMPT = 'You are a helpful personal AI assistant on WhatsApp. Be conversational, concise and friendly. Keep responses short and natural. No markdown formatting like asterisks or hashtags. Use emojis occasionally.';
var MAX_HISTORY = 20;
var latestQR = null;
var isConnected = false;
var startupError = null;

var genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
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
      '--single-process'
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

client.on('message', async function(message) {
  if (message.isStatus || message.fromMe) return;
  var chatId = message.from;
  if (!conversations[chatId]) conversations[chatId] = [];

  try {
    if (message.type === 'chat') {
      var text = message.body ? message.body.trim() : '';
      if (!text) return;

      // Commands
      if (text === '/clear') {
        conversations[chatId] = [];
        await message.reply('Memory cleared! Fresh start 🧹');
        return;
      }

      if (text === '/help') {
        await message.reply('Commands:\n/clear - Clear chat memory\n/help - Show this message\n\nJust type normally to chat with me! 😊');
        return;
      }

      conversations[chatId].push({ role: 'user', parts: [{ text: text }] });

    } else if (message.type === 'ptt' || message.type === 'audio') {
      await message.reply('I cannot process voice messages yet — please type instead! 🎤');
      return;
    } else {
      return;
    }

    // Trim history
    if (conversations[chatId].length > MAX_HISTORY) {
      conversations[chatId] = conversations[chatId].slice(-MAX_HISTORY);
    }

    var model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction: SYSTEM_PROMPT
    });

    var history = conversations[chatId].slice(0, -1);
    var chat = model.startChat({ history: history });
    var last = conversations[chatId][conversations[chatId].length - 1];
    var result = await chat.sendMessage(last.parts);
    var reply = result.response.text();

    conversations[chatId].push({ role: 'model', parts: [{ text: reply }] });
    await message.reply(reply);

  } catch (e) {
    console.error('Message error:', e.message);
    await message.reply('Something went wrong, try again! 😅');
  }
});

// ── Web server to show QR ──
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
      h2{font-size:22px;font-weight:700}
      .qr-wrap{background:#fff;padding:16px;border-radius:16px}
      img{display:block;width:280px;height:280px}
      .steps{background:#141414;border:1px solid #222;border-radius:12px;padding:16px 20px;font-size:13px;color:#aaa;line-height:2;text-align:left}
      .steps b{color:#fff}
      .note{font-size:11px;color:#555}</style></head>
      <body>
        <h2>Scan to connect your WhatsApp</h2>
        <div class="qr-wrap"><img src="${url}" alt="QR Code"/></div>
        <div class="steps">
          <b>How to scan:</b><br/>
          1. Open WhatsApp on your phone<br/>
          2. Tap Menu (⋮) → Linked Devices<br/>
          3. Tap "Link a Device"<br/>
          4. Point camera at the QR code above
        </div>
        <p class="note">Page auto-refreshes every 30 seconds · QR expires after ~60 seconds</p>
      </body></html>`);
    });

  } else {
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Starting...</title>
    <meta http-equiv="refresh" content="10"/>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px}
    .spinner{width:40px;height:40px;border:3px solid #222;border-top-color:#4f7cff;border-radius:50%;animation:spin 1s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    p{color:#888;font-size:13px}</style></head>
    <body><div class="spinner"></div><p>Starting up... page will refresh automatically</p>
    ${startupError ? `<p style="color:#ff6b6b">Error: ${startupError}</p>` : ''}
    </body></html>`);
  }
});

server.listen(process.env.PORT || 3000, '0.0.0.0', function() {
  console.log('Server running on port', process.env.PORT || 3000);
  console.log('Initializing WhatsApp client...');
  client.initialize();
});
