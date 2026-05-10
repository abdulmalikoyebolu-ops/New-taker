require('dotenv').config();
var Client = require('whatsapp-web.js').Client;
var LocalAuth = require('whatsapp-web.js').LocalAuth;
var QRCode = require('qrcode');
var http = require('http');

var GROQ_API_KEY = process.env.GROQ_API_KEY;

var SYSTEM_PROMPT =
  'You are a helpful personal AI assistant on WhatsApp called Vektra Chat Bot. Be conversational, concise and friendly. Keep responses short and natural. No markdown formatting. Use emojis occasionally.';

var VISION_PROMPT =
  'You are a fun WhatsApp assistant. React naturally to images or stickers in a friendly, funny way.';

var MAX_HISTORY = 10;

var latestQR = null;
var isConnected = false;
var conversations = {};

var client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ],
    headless: true
  }
});

client.on('qr', (qr) => {
  latestQR = qr;
  isConnected = false;
});

client.on('ready', () => {
  latestQR = null;
  isConnected = true;
  console.log('Bot is online 🚀');
});

client.on('disconnected', () => {
  isConnected = false;
  latestQR = null;
  setTimeout(() => client.initialize(), 5000);
});

/* ---------------- GROQ CHAT ---------------- */
async function askGroq(messages) {
  var controller = new AbortController();
  var timeout = setTimeout(() => controller.abort(), 30000);

  try {
    var response = await fetch(
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
        }),
        signal: controller.signal
      }
    );

    clearTimeout(timeout);

    // 🔥 FIX 1: check HTTP error BEFORE JSON parsing
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || 'Groq request failed');
    }

    var data = await response.json();

    // 🔥 FIX 2: safe structure check
    if (!data.choices?.length) {
      throw new Error('Empty response from Groq');
    }

    return data.choices[0].message?.content || 'No response 😅';
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/* ---------------- VISION ---------------- */
async function askGroqVision(base64Image, mimeType) {
  var response = await fetch(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + GROQ_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: VISION_PROMPT },
              {
                type: 'image_url',
                image_url: {
                  url: 'data:' + mimeType + ';base64,' + base64Image
                }
              }
            ]
          }
        ],
        max_tokens: 300,
        temperature: 0.8
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Vision API failed');
  }

  var data = await response.json();

  if (!data.choices?.length) {
    throw new Error('Empty vision response');
  }

  return data.choices[0].message?.content;
}

/* ---------------- MESSAGE HANDLER ---------------- */
client.on('message', async (message) => {
  if (message.isStatus || message.fromMe) return;

  var chatId = message.from;

  if (!conversations[chatId]) {
    conversations[chatId] = [];
  }

  try {
    var chat = await message.getChat();

    // 🔥 FIX 3: only typing (no presence spam)
    await chat.sendStateTyping();

    /* ---------------- IMAGE / STICKER ---------------- */
    if (message.type === 'image' || message.type === 'sticker') {
      var media = await message.downloadMedia();
      if (!media) return message.reply('I couldn’t load that 😅');

      var mime = message.type === 'sticker' ? 'image/jpeg' : media.mimetype;

      var reply = await askGroqVision(media.data, mime);
      return message.reply(reply);
    }

    /* ---------------- TEXT ---------------- */
    if (message.type === 'chat') {
      var text = message.body?.trim();
      if (!text) return;

      if (text === '/clear') {
        conversations[chatId] = [];
        return message.reply('Memory cleared 🧹');
      }

      conversations[chatId].push({ role: 'user', content: text });
    }

    /* ---------------- MEMORY LIMIT ---------------- */
    if (conversations[chatId].length > MAX_HISTORY) {
      conversations[chatId] = conversations[chatId].slice(-MAX_HISTORY);
    }

    var messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...conversations[chatId]
    ];

    var reply = await askGroq(messages);

    conversations[chatId].push({
      role: 'assistant',
      content: reply.slice(0, 200)
    });

    await message.reply(reply);
  } catch (err) {
    console.error('Bot error:', err.message);

    // rollback last message to avoid broken context
    if (conversations[chatId]?.length) {
      conversations[chatId].pop();
    }

    await message.reply('Something went wrong, try again 😅');
  }
});

/* ---------------- CRASH HANDLING ---------------- */
process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

/* ---------------- SERVER ---------------- */
var server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });

  res.end(
    isConnected
      ? '<h2>✅ Bot Online</h2>'
      : '<h2>🔄 Starting Bot...</h2>'
  );
});

server.listen(process.env.PORT || 3000, () => {
  console.log('Server running...');
  client.initialize();
});
