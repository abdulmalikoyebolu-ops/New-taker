require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const http = require('http');

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const SYSTEM_PROMPT = `
You are Vektra Chat Bot, a conversational WhatsApp AI assistant.

Your creator and owner is Abdulmalik Oyebolu of Vektra Studio.

Rules:

* Be natural, friendly and human-like.
* Keep replies short unless the user asks for detail.
* Never generate recaps unless asked.
* Never repeat old responses.
* Never loop messages.
* Do not summarize conversations unless requested.
* React naturally to replies, stickers and images.
* Avoid sounding robotic.
* Use emojis occasionally.
* No markdown formatting.
* Reply in English unless the user speaks another language first.
  `;

const VISION_PROMPT = `You are a fun and natural WhatsApp assistant.
React casually to the image or sticker like a real friend would.
Be funny, relatable or thoughtful depending on the image.
Keep it short and natural.
Use emojis occasionally.`;

const MAX_HISTORY = 30;

let latestQR = null;
let isConnected = false;
let startupError = null;

const conversations = {};
const processedMessages = new Set();

const client = new Client({
authStrategy: new LocalAuth(),
puppeteer: {
executablePath:
process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
headless: true,
timeout: 60000,
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
console.log('QR generated');
});

client.on('ready', () => {
latestQR = null;
isConnected = true;
console.log('Bot ready!');
});

client.on('authenticated', () => {
console.log('Authenticated!');
});

client.on('auth_failure', (msg) => {
console.error('Auth failure:', msg);
startupError = msg;
});

client.on('disconnected', (reason) => {
console.log('Disconnected:', reason);

```
isConnected = false;
latestQR = null;

setTimeout(() => {
    client.initialize();
}, 5000);
```

});

async function askGroq(messages) {
const controller = new AbortController();

```
const timeout = setTimeout(() => {
    controller.abort();
}, 60000);

try {
    const response = await fetch(
        'https://api.groq.com/openai/v1/chat/completions',
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'compound-beta',
                messages,
                temperature: 0.7,
                max_tokens: 500
            }),
            signal: controller.signal
        }
    );

    clearTimeout(timeout);

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            data.error?.message || 'Groq API error'
        );
    }

    return data.choices[0].message.content;

} catch (err) {
    clearTimeout(timeout);
    throw err;
}
```

}

async function askGroqVision(base64Image, mimeType) {
const response = await fetch(
'https://api.groq.com/openai/v1/chat/completions',
{
method: 'POST',
headers: {
Authorization: `Bearer ${GROQ_API_KEY}`,
'Content-Type': 'application/json'
},
body: JSON.stringify({
model: 'meta-llama/llama-4-scout-17b-16e-instruct',
messages: [
{
role: 'user',
content: [
{
type: 'text',
text: VISION_PROMPT
},
{
type: 'image_url',
image_url: {
url: `data:${mimeType};base64,${base64Image}`
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

```
const data = await response.json();

if (!response.ok) {
    throw new Error(
        data.error?.message || 'Vision API error'
    );
}

return data.choices[0].message.content;
```

}

client.on('message', async (message) => {

```
if (message.isStatus) return;
if (message.fromMe) return;

if (processedMessages.has(message.id._serialized)) {
    return;
}

processedMessages.add(message.id._serialized);

const chatId = message.from;

if (!conversations[chatId]) {
    conversations[chatId] = [];
}

try {

    await client.sendSeen(chatId);

    const chat = await message.getChat();

    await chat.sendStateTyping();

    // IMAGE & STICKER
    if (
        message.type === 'image' ||
        message.type === 'sticker'
    ) {

        try {

            const media = await message.downloadMedia();

            if (!media) {
                await message.reply(
                    'I could not load that 😅'
                );
                return;
            }

            const mimeType =
                message.type === 'sticker'
                    ? 'image/jpeg'
                    : media.mimetype;

            const reply = await askGroqVision(
                media.data,
                mimeType
            );

            conversations[chatId].push({
                role: 'assistant',
                content: reply
            });

            await message.reply(reply);

        } catch (err) {

            console.error('Vision error:', err.message);

            await message.reply(
                'My eyes glitched 😭 send it again'
            );
        }

        return;
    }

    // VOICE NOTE
    if (
        message.type === 'audio' ||
        message.type === 'ptt'
    ) {

        try {

            const media = await message.downloadMedia();

            if (!media) {
                await message.reply(
                    'Could not load your voice note 😅'
                );
                return;
            }

            const audioBuffer = Buffer.from(
                media.data,
                'base64'
            );

            const { Blob } = require('buffer');

            const audioBlob = new Blob(
                [audioBuffer],
                {
                    type:
                        media.mimetype ||
                        'audio/ogg'
                }
            );

            const formData = new FormData();

            formData.append(
                'file',
                audioBlob,
                'audio.ogg'
            );

            formData.append(
                'model',
                'whisper-large-v3'
            );

            formData.append(
                'response_format',
                'json'
            );

            const transcribeRes = await fetch(
                'https://api.groq.com/openai/v1/audio/transcriptions',
                {
                    method: 'POST',
                    headers: {
                        Authorization:
                            `Bearer ${GROQ_API_KEY}`
                    },
                    body: formData
                }
            );

            const transcribeData =
                await transcribeRes.json();

            if (!transcribeRes.ok) {
                throw new Error(
                    transcribeData.error?.message
                );
            }

            const transcribedText =
                transcribeData.text;

            if (
                !transcribedText ||
                !transcribedText.trim()
            ) {
                await message.reply(
                    'I could not hear anything 🎤'
                );
                return;
            }

            conversations[chatId].push({
                role: 'user',
                content: transcribedText
            });

            const messages = [
                {
                    role: 'system',
                    content: SYSTEM_PROMPT
                },
                ...conversations[chatId]
            ];

            const reply = await askGroq(messages);

            conversations[chatId].push({
                role: 'assistant',
                content: reply
            });

            await message.reply(reply);

        } catch (err) {

            console.error(
                'Voice error:',
                err.message
            );

            await message.reply(
                'Could not process your voice note 😅'
            );
        }

        return;
    }

    // NORMAL TEXT
    if (message.type !== 'chat') return;

    let text = message.body
        ? message.body.trim()
        : '';

    if (!text) return;

    // IGNORE USELESS MESSAGES
    const ignoredMessages = [
        'hmm',
        'hm',
        'ok',
        'okay',
        'k',
        'lol',
        'lmao',
        '😂',
        '.',
        '..'
    ];

    if (
        ignoredMessages.includes(
            text.toLowerCase()
        ) ||
        text.length < 2
    ) {
        return;
    }

    // COMMANDS
    if (text === '/clear') {

        conversations[chatId] = [];

        await message.reply(
            'Memory cleared 🧹'
        );

        return;
    }

    if (text === '/help') {

        await message.reply(
            'Commands:\n/clear - Clear memory\n/help - Show commands'
        );

        return;
    }

    // REPLY CONTEXT
    if (message.hasQuotedMsg) {

        const quoted =
            await message.getQuotedMessage();

        if (quoted?.body) {

            text =
```

`Replying to:
"${quoted.body}"

New message:
${text}`;
}
}

```
    conversations[chatId].push({
        role: 'user',
        content: text
    });

    if (
        conversations[chatId].length >
        MAX_HISTORY
    ) {
        conversations[chatId] =
            conversations[chatId].slice(
                -MAX_HISTORY
            );
    }

    const messages = [
        {
            role: 'system',
            content: SYSTEM_PROMPT
        },
        ...conversations[chatId]
    ];

    const reply = await askGroq(messages);

    if (!reply || !reply.trim()) {

        await message.reply(
            'I could not generate a reply 😅'
        );

        return;
    }

    conversations[chatId].push({
        role: 'assistant',
        content: reply
    });

    await message.reply(reply);

} catch (err) {

    console.error(
        'Message error:',
        err.message
    );

    if (
        conversations[chatId] &&
        conversations[chatId].length > 0 &&
        conversations[chatId][
            conversations[chatId].length - 1
        ].role === 'user'
    ) {
        conversations[chatId].pop();
    }

    await message.reply(
        'Something went wrong 😅'
    );
}
```

});

process.on(
'unhandledRejection',
(reason) => {

```
    console.error(
        'Unhandled Rejection:',
        reason
    );
}
```

);

process.on(
'uncaughtException',
(err) => {

```
    console.error(
        'Uncaught Exception:',
        err.message
    );
}
```

);

const server = http.createServer(
(req, res) => {

```
    res.writeHead(200, {
        'Content-Type': 'text/html'
    });

    if (isConnected) {

        res.end(`
            <html>
            <body style="
                background:#0a0a0a;
                color:white;
                display:flex;
                justify-content:center;
                align-items:center;
                height:100vh;
                font-family:sans-serif;
            ">
                <h1>✅ Vektra Bot Online</h1>
            </body>
            </html>
        `);

    } else if (latestQR) {

        QRCode.toDataURL(
            latestQR,
            { width: 300 },
            (err, url) => {

                if (err) {
                    res.end(
                        'QR generation failed'
                    );
                    return;
                }

                res.end(`
                    <html>
                    <body style="
                        background:#0a0a0a;
                        color:white;
                        display:flex;
                        flex-direction:column;
                        justify-content:center;
                        align-items:center;
                        height:100vh;
                        font-family:sans-serif;
                    ">
                        <h2>Scan QR Code</h2>
                        <img src="${url}" />
                    </body>
                    </html>
                `);
            }
        );

    } else {

        res.end(`
            <html>
            <body style="
                background:#0a0a0a;
                color:white;
                display:flex;
                justify-content:center;
                align-items:center;
                height:100vh;
                font-family:sans-serif;
            ">
                <h2>Starting bot...</h2>
            </body>
            </html>
        `);
    }
}
```

);

server.listen(
process.env.PORT || 3000,
'0.0.0.0',
() => {

```
    console.log(
        'Server started'
    );

    client.initialize();
}
```

);
