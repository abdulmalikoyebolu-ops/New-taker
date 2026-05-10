require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const http = require('http');

const fetch = global.fetch; // Render Node 18+ built-in fetch

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const SYSTEM_PROMPT = `
You are Vektra Chat Bot, a conversational WhatsApp AI assistant.

Owner: Abdulmalik Oyebolu (Vektra Studio)

Rules:

* Be natural and human-like
* Keep replies short and clear
* Never repeat yourself
* Never generate recaps unless asked
* Never loop responses
* No markdown formatting
* Use emojis occasionally
* Reply in English unless user uses another language first
  `;

const VISION_PROMPT = `React naturally to the image or sticker like a human friend.
Be short, casual and expressive.
Use emojis sometimes.`;

const MAX_HISTORY = 25;

let latestQR = null;
let isConnected = false;

const conversations = {};
const processedMessages = new Map();

const client = new Client({
authStrategy: new LocalAuth(),
puppeteer: {
executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
headless: true,
args: [
'--no-sandbox',
'--disable-setuid-sandbox',
'--disable-dev-shm-usage',
'--disable-gpu'
]
}
});

client.on('qr', (qr) => {
latestQR = qr;
isConnected = false;
});

client.on('ready', () => {
latestQR = null;
isConnected = true;
console.log('Bot is ready');
});

client.on('disconnected', (reason) => {
console.log('Disconnected:', reason);
isConnected = false;
latestQR = null;

setTimeout(() => client.initialize(), 5000);
});

// CLEAN OLD PROCESSED MESSAGES (prevents memory leak)
setInterval(() => {
const now = Date.now();
for (const [key, time] of processedMessages.entries()) {
if (now - time > 60000) processedMessages.delete(key);
}
}, 60000);

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
max_tokens: 500
})
});

```
const data = await res.json();
if (!res.ok) throw new Error(data.error?.message || 'Groq error');

return data.choices[0].message.content;
```

} catch (err) {
console.error('AI ERROR:', err);
return null;
}
}

client.on('message', async (message) => {
try {
if (message.fromMe || message.isStatus) return;

```
const id = message.id._serialized;
if (processedMessages.has(id)) return;

processedMessages.set(id, Date.now());

const chatId = message.from;
if (!conversations[chatId]) conversations[chatId] = [];

const chat = await message.getChat();
await client.sendSeen(chatId);
await chat.sendStateTyping();

let text = (message.body || '').trim();
if (!text) return;

// ignore noise messages
const ignore = ['hmm', 'hm', 'ok', 'okay', 'k', '.', '..', 'lol', '😂'];
if (ignore.includes(text.toLowerCase())) return;

// clear memory
if (text === '/clear') {
  conversations[chatId] = [];
  return message.reply('Memory cleared 🧹');
}

// help
if (text === '/help') {
  return message.reply('/clear - reset memory\n/help - commands');
}

// reply context
if (message.hasQuotedMsg) {
  const quoted = await message.getQuotedMessage();
  if (quoted?.body) {
    text = `Replying to: "${quoted.body}"\nUser: ${text}`;
  }
}

conversations[chatId].push({ role: 'user', content: text });

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

conversations[chatId].push({ role: 'assistant', content: reply });

await message.reply(reply);
```

} catch (err) {
console.error('MESSAGE ERROR:', err);
return message.reply('Something went wrong 😅');
}
});

// SIMPLE STATUS SERVER (Render requirement)
const server = http.createServer((req, res) => {
res.writeHead(200, { 'Content-Type': 'text/plain' });
res.end(isConnected ? 'Bot Online ✅' : 'Starting...');
});

server.listen(process.env.PORT || 3000, () => {
console.log('Server running');
client.initialize();
});
