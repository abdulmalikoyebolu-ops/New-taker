require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const http = require('http');

const fetch = global.fetch;

const GROQ_API_KEY = process.env.GROQ_API_KEY;

/* =========================
CONFIG
========================= */

const SYSTEM_PROMPT = `
You are Vektra Chat Bot, a WhatsApp AI assistant.

Owner: Abdulmalik Oyebolu (Vektra Studio)

Rules:

* Be natural and conversational
* Keep replies short
* Never repeat yourself
* Never generate recaps or summaries unless asked
* No markdown formatting
* Use emojis sometimes
* Reply in English unless user uses another language first
  `;

const MAX_HISTORY = 20;

let latestQR = null;
let isConnected = false;

const conversations = {};
const processed = new Map();

/* =========================
CLIENT
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
console.log('Bot is ready 🚀');
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
GROQ FUNCTION
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
        throw new Error(data.error?.message || 'Groq API error');
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
    const chatId = message.from;

    if (!conversations[chatId]) {
        conversations[chatId] = [];
    }

    const messageId = message.id._serialized;

    if (processed.has(messageId)) return;
    processed.set(messageId, Date.now());

    setTimeout(() => processed.delete(messageId), 60000);

    const text = (message.body || '').trim();
    if (!text) return;

    // ignore noise
    const ignore = ['hmm', 'hm', 'ok', 'okay', 'k', '.', '..', 'lol'];
    if (ignore.includes(text.toLowerCase())) return;

    await client.sendSeen(chatId);

    const chat = await message.getChat();
    await chat.sendStateTyping();

    let input = text;

    /* =========================
       QUOTE FIX (SAFE)
    ========================= */

    if (message.hasQuotedMsg) {
        const quoted = await message.getQuotedMessage();

        if (quoted && quoted.body) {
            input =
                'Replying to: "' +
                quoted.body +
                '" | Message: ' +
                text;
        }
    }

    conversations[chatId].push({
        role: 'user',
        content: input
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

    await message.reply(reply);

} catch (err) {
    console.error('BOT ERROR:', err);

    try {
        await message.reply('Something went wrong 😅');
    } catch (e) {}
}
```

});

/* =========================
STATUS SERVER (RENDER)
========================= */

const server = http.createServer((req, res) => {
res.writeHead(200, { 'Content-Type': 'text/plain' });
res.end(isConnected ? 'Bot Online ✅' : 'Starting...');
});

server.listen(process.env.PORT || 3000, () => {
console.log('Server running');
client.initialize();
});
