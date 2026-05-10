require('dotenv').config();
var Client = require('whatsapp-web.js').Client;
var LocalAuth = require('whatsapp-web.js').LocalAuth;
var QRCode = require('qrcode');
var http = require('http');

var GROQ_API_KEY = process.env.GROQ_API_KEY;

var SYSTEM_PROMPT =
  'You are Vektra Chat Bot, a helpful WhatsApp assistant. Be short, friendly, and natural. No markdown.';

var MAX_HISTORY = 10;

var latestQR = null;
var isConnected = false;
var conversations = {};

/* ---------------- CLIENT ---------------- */
var client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ],
    headless: true
  }
});

/* ---------------- EVENTS ---------------- */
client.on('qr', (qr) => {
  latestQR = qr;
  isConnected = false;
  console.log('📱 QR RECEIVED');
});

client.on('ready', () => {
  isConnected = true;
  latestQR = null;
  console.log('✅ BOT ONLINE');
});

client.on('disconnected', () => {
  isConnected = false;
  latestQR = null;
  setTimeout(() => client.initialize(), 5000);
});

/* ---------------- SAFE GROQ ---------------- */
async function askGroq(messages) {
  try {
    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + GROQ_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'compound-beta',
          messages,
          max_tokens: 500,
          temperature: 0.7
        })
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || 'Groq error');
    }

    const data = await response.json();

    if (!data.choices?.length) {
      throw new Error('Empty response');
    }

    return data.choices[0].message?.content || '...';
  } catch (err) {
    console.error('Groq error:', err.message);
    return 'I had trouble thinking 😅 try again';
  }
}

/* ---------------- MESSAGE HANDLER ---------------- */
client.on('message', async (message) => {
  if (message.fromMe || message.isStatus) return;

  const chatId = message.from;

  if (!conversations[chatId]) {
    conversations[chatId] = [];
  }

  try {
    const chat = await message.getChat();
    await chat.sendStateTyping();

    const text = message.body?.trim();
    if (!text) return;

    if (text === '/clear') {
      conversations[chatId] = [];
      return message.reply('Memory cleared 🧹');
    }

    conversations[chatId].push({ role: 'user', content: text });

    if (conversations[chatId].length > MAX_HISTORY) {
      conversations[chatId] = conversations[chatId].slice(-MAX_HISTORY);
    }

    const reply = await askGroq([
      { role: 'system', content: SYSTEM_PROMPT },
      ...conversations[chatId]
    ]);

    conversations[chatId].push({
      role: 'assistant',
      content: reply.slice(0, 200)
    });

    await message.reply(reply);

  } catch (err) {
    console.error('Message error:', err.message);
    await message.reply('Something went wrong 😅 try again');
  }
});

/* ---------------- HTTP SERVER (FIXED QR LOGIC) ---------------- */
var server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });

  // ✅ Connected page
  if (isConnected) {
    return res.end(`
      <h2>✅ Bot Connected</h2>
      <p>WhatsApp bot is online</p>
    `);
  }

  // ⏳ Waiting page
  if (!latestQR) {
    return res.end(`
      <h2>⏳ Waiting for QR Code...</h2>
      <p>Please refresh in a few seconds</p>
      <script>
        setTimeout(() => location.reload(), 3000);
      </script>
    `);
  }

  // 📱 QR page
  QRCode.toDataURL(latestQR, (err, url) => {
    if (err) {
      return res.end('QR generation failed');
    }

    res.end(`
      <html>
      <body style="background:#111;color:#fff;text-align:center;padding:40px">
        <h2>Scan QR Code</h2>
        <img src="${url}" width="280" height="280" />
        <p>WhatsApp → Linked Devices → Scan</p>

        <script>
          setTimeout(() => location.reload(), 4000);
        </script>
      </body>
      </html>
    `);
  });
});

/* ---------------- START ---------------- */
server.listen(process.env.PORT || 3000, () => {
  console.log('Server running...');
  client.initialize();
});
