require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const http = require('http');

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const SYSTEM_PROMPT = `
You are Vektra Chat Bot.

Rules:
- Be short and natural
- No recaps unless asked
- No repetition
- No markdown
- Friendly tone with emojis
- Creator: Abdulmalik Oyebolu (Vektra Studio)
`;

const MAX_HISTORY = 15;

let latestQR = null;
let isConnected = false;

const conversations = {};
const processed = new Set();

/* ================= CLIENT ================= */

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
        ]
    }
});

/* ================= EVENTS ================= */

client.on('qr', (qr) => {
    latestQR = qr;
    isConnected = false;
});

client.on('ready', () => {
    latestQR = null;
    isConnected = true;
    console.log('Bot ready 🚀');
});

client.on('disconnected', () => {
    isConnected = false;
    latestQR = null;
    setTimeout(() => client.initialize(), 5000);
});

/* ================= GROQ ================= */

async function askGroq(messages) {
    try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama3-70b-8192',
                messages,
                temperature: 0.7,
                max_tokens: 400
            })
        });

        const data = await res.json();

        if (!res.ok) throw new Error(data.error?.message);

        return data.choices[0].message.content;

    } catch (err) {
        console.error('Groq error:', err.message);
        return null;
    }
}

/* ================= MESSAGE ================= */

client.on('message', async (message) => {
    try {
        if (message.fromMe || message.isStatus) return;

        const chatId = message.from;

        const msgId = message.id._serialized;
        if (processed.has(msgId)) return;
        processed.add(msgId);
        setTimeout(() => processed.delete(msgId), 60000);

        const text = (message.body || '').trim();
        if (!text) return;

        const skip = ['hmm','hm','ok','okay','k','lol','.','..'];
        if (skip.includes(text.toLowerCase())) return;

        if (!conversations[chatId]) {
            conversations[chatId] = [];
        }

        await message.getChat().then(c => c.sendStateTyping());

        conversations[chatId].push({
            role: 'user',
            content: text
        });

        if (conversations[chatId].length > MAX_HISTORY) {
            conversations[chatId] = conversations[chatId].slice(-MAX_HISTORY);
        }

        const reply = await askGroq([
            { role: 'system', content: SYSTEM_PROMPT },
            ...conversations[chatId]
        ]);

        if (!reply) {
            return message.reply('Try again 😅');
        }

        conversations[chatId].push({
            role: 'assistant',
            content: reply
        });

        await message.reply(reply);

    } catch (err) {
        console.error('Message error:', err.message);
        await message.reply('Something went wrong 😅');
    }
});

/* ================= SERVER ================= */

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(isConnected ? 'Bot Online ✅' : 'Starting...');
});

server.listen(process.env.PORT || 3000, () => {
    console.log('Server running');
    client.initialize();
});
