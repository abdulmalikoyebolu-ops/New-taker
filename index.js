require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const express = require('express');
const pino = require('pino');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

const app = express();
const PORT = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const SYSTEM_PROMPT =
  'You are Vektra Chat Bot, a helpful WhatsApp AI assistant created by Abdulmalik Oyebolu of Vektra Studio. Be friendly, short, natural, and use emojis occasionally. No markdown.';

let conversations = {};
let botStarted = false;

async function askGroq(messages) {
  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.1-8b-instant',
      messages,
      temperature: 0.7,
      max_tokens: 300
    },
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return res.data.choices[0].message.content;
}

async function startBot() {
  if (botStarted) return; // 🛑 prevents double start
  botStarted = true;

  const { state, saveCreds } = await useMultiFileAuthState('./session');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Vektra Bot', 'Chrome', '1.0']
  });

  // Save session properly 💾
  sock.ev.on('creds.update', saveCreds);

  // Connection handler 🔄
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan QR below 👇');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('✅ Bot connected successfully');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut;

      console.log('❌ Disconnected');

      if (shouldReconnect) {
        setTimeout(() => {
          startBot();
        }, 5000);
      }
    }
  });

  // Messages handler 💬
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;

    let text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text;

    if (!text) return;

    if (!conversations[from]) conversations[from] = [];

    if (text === '/clear') {
      conversations[from] = [];
      await sock.sendMessage(from, { text: 'Memory cleared 🧹' });
      return;
    }

    conversations[from].push({ role: 'user', content: text });

    if (conversations[from].length > 20) {
      conversations[from] = conversations[from].slice(-20);
    }

    try {
      const reply = await askGroq([
        { role: 'system', content: SYSTEM_PROMPT },
        ...conversations[from]
      ]);

      conversations[from].push({
        role: 'assistant',
        content: reply
      });

      await sock.sendMessage(from, { text: reply });

    } catch (err) {
      console.log(err);
      await sock.sendMessage(from, {
        text: 'Something went wrong 😅'
      });
    }
  });
}

// simple web server (keeps Render alive 🌐)
app.get('/', (req, res) => {
  res.send('Vektra Bot is running ✅');
});

app.listen(PORT, () => {
  console.log('Server running on port', PORT);
  startBot();
});
