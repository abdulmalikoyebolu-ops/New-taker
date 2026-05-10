require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const http = require('http');

const fetch = global.fetch; // Node 18+ (Render safe)

const GROQ_API_KEY = process.env.GROQ_API_KEY;

/* =========================
SYSTEM PROMPT
========================= */
const SYSTEM_PROMPT = `
You are Vektra Chat Bot, a friendly WhatsApp AI assistant.

Owner: Abdulmalik Oyebolu (Vektra Studio)

Rules:

* Be natural and conversational
* Keep replies short and clear
* Never repeat yourself
* Never generate recaps unless asked
* Never loop responses
* No markdown formatting
* Use emojis occasionally
* Reply in English unless user uses another language first
  `;

/* =========================
SETTINGS
========================= */
const MAX_HISTORY = 25;

let latestQR = null;
let isConnected = false;

const conversations = {};
const processed = new Map();

/* =========================
WHATSAPP CLIENT
========================= */
const client = new Client({
authStrategy: new LocalAuth(),
puppeteer: {
executablePath:
process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
headless: true,
args: [
'--no-sandbox',
'--disable-setuid-sandbox',
'--disable-dev-shm-usage',
'--disable-gpu'
]
}
});

/* =========================
EVENTS
========================= */
client.on('qr', (qr) => {
latestQR = qr;
isConnected = false;
});

client.on('ready', () => {
latestQR = null;
isConnected = true;
console.log('Bot ready 🚀');
});

client.on('disconnected', (reason) => {
console.log('Disconnected:', reason);
isConnected = false;
latestQR = null;

```
setTimeout(() => client.initialize(), 5000);
```

});

/* =========================
GROQ REQUEST
========================= */
async function askGroq(messages) {
try {
const res = await fetch(
'https://api.groq.com/openai/v1/chat/completions',
{
method: 'POST',
headers: {
Authorization: `Bearer ${GROQ_API_KEY}`,
'Content-Type': 'application/json'
},
body: JSON.stringify({
model: 'llama3-70b-8192',
messages,
temperature: 0.7,
max_tokens: 500
})
}
);

```
    const data = await res.json();

    if (!res.ok) {
        throw new Error(data.error?.message || 'Groq error');
    }

    return data.choices[0].message.content;
} catch (err) {
    console.error('AI ERROR:', err);
    return null;
}
```

}

/* =========================
MESSAGE HANDLER
========================= */
client.on('message', async (message) => {
try {
if (message.fromMe || message.isStatus) return;

```
    const id = message.id._serialized;

    if (processed.has(id)) return;
    processed.set(id, Date.now());

    // cleanup old message ids
    setTimeout(() => processed.delete(id), 60000);

    const chatId = message.from;

    if (!conversations[chatId]) {
        conversations[chatId] = [];
    }

    await client.sendSeen(chatId);

    const chat = await message.getChat();
    await chat.sendStateTyping();

    /* =========================
       TEXT
    ========================= */
    if (message.type === 'chat') {
        let text = (message.body || '').trim();
        if (!text) return;

        // ignore noise
        const ignore = ['hmm', 'hm', 'ok', 'okay', 'k', '.', '..', 'lol', '😂'];
        if (ignore.includes(text.toLowerCase())) return;

        // commands
        if (text === '/clear') {
            conversations[chatId] = [];
            return message.reply('Memory cleared 🧹');
        }

        if (text === '/help') {
            return message.reply('/clear - reset memory\n/help - commands');
        }

        /* =========================
           REPLY CONTEXT FIX
        ========================= */
        if (message.hasQuotedMsg) {
            const quoted = await message.getQuotedMessage();
            if (quoted && quoted.body) {
                text = `Replying to: "${quoted.body}" | User: ${text}`;
            }
        }

        conversations[chatId].push({
            role: 'user',
            content: text
        });

        if (conversations[chatId].length > MAX_HISTORY) {
            conversations[chatId] =
                conversations[chatId].slice(-MAX_HISTORY);
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

        return message.reply(reply);
    }

    /* =========================
       IMAGE / STICKER
    ========================= */
    if (
        message.type === 'image' ||
        message.type === 'sticker'
    ) {
        const media = await message.downloadMedia();

        if (!media) {
            return message.reply('Could not read media 😅');
        }

        const reply = await askGroq([
            { role: 'system', content: SYSTEM_PROMPT },
            {
                role: 'user',
                content: 'User sent an image/sticker. React naturally.'
            }
        ]);

        conversations[chatId].push({
            role: 'assistant',
            content: reply || 'Nice 👍'
        });

        return message.reply(reply || 'Nice 👍');
    }

} catch (err) {
    console.error('BOT ERROR:', err);
    return message.reply('Something went wrong 😅');
}
```

});

/* =========================
STATUS SERVER (Render)
========================= */
const server = http.createServer((req, res) => {
res.writeHead(200, { 'Content-Type': 'text/plain' });
res.end(isConnected ? 'Bot Online ✅' : 'Starting...');
});

server.listen(process.env.PORT || 3000, () => {
console.log('Server running');
client.initialize();
});
