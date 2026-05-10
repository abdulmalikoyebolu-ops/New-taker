require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const express = require('express');
const axios = require('axios');
const pino = require('pino');

const app = express();

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const SYSTEM_PROMPT =
  'You are Vektra Chat Bot, a friendly AI WhatsApp assistant created by Abdulmalik Oyebolu of Vektra Studio. Keep replies short, natural, conversational and friendly. Use emojis occasionally. No markdown.';

const conversations = {};

async function askGroq(messages) {
  const response = await axios.post(
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

  return response.data.choices[0].message.content;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./session');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Vektra Bot', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrcode = require('qrcode-terminal');
      qrcode.generate(qr, { small: true });
      console.log('Scan the QR above');
    }

    if (connection === 'open') {
      console.log('✅ Bot connected');
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;

      console.log('❌ Disconnected');

      if (shouldReconnect) {
        startBot();
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0];

      if (!msg.message) return;

      const from = msg.key.remoteJid;

      if (msg.key.fromMe) return;

      let text = '';

      if (msg.message.conversation) {
        text = msg.message.conversation;
      }

      if (msg.message.extendedTextMessage) {
        text = msg.message.extendedTextMessage.text;
      }

      if (!text) return;

      text = text.trim();

      if (!conversations[from]) {
        conversations[from] = [];
      }

      if (text === '/clear') {
        conversations[from] = [];

        await sock.sendMessage(from, {
          text: 'Memory cleared 🧹'
        });

        return;
      }

      conversations[from].push({
        role: 'user',
        content: text
      });

      if (conversations[from].length > 20) {
        conversations[from] =
          conversations[from].slice(-20);
      }

      const messagesPayload = [
        {
          role: 'system',
          content: SYSTEM_PROMPT
        },
        ...conversations[from]
      ];

      const reply = await askGroq(messagesPayload);

      conversations[from].push({
        role: 'assistant',
        content: reply
      });

      await sock.sendMessage(from, {
        text: reply
      });

    } catch (err) {
      console.log(err);

      try {
        await sock.sendMessage(
          messages[0].key.remoteJid,
          {
            text: 'Something went wrong 😅'
          }
        );
      } catch {}
    }
  });
}

app.get('/', (req, res) => {
  res.send('Vektra Bot is running ✅');
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});

startBot();
