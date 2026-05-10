require('dotenv').config();

const fetch = require('node-fetch');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const http = require('http');

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const SYSTEM_PROMPT = `
You are Vektra Chat Bot, a smart conversational WhatsApp AI assistant.

Your creator and owner is Abdulmalik Oyebolu of Vektra Studio.

Rules:

* Be natural and human-like.
* Keep replies short and conversational.
* Never repeat yourself.
* Never generate recaps unless asked.
* Never loop messages.
* Avoid robotic responses.
* No markdown formatting.
* Use emojis occasionally.
* Reply in English unless the user speaks another language first.
  `;

const VISION_PROMPT = `You are a fun WhatsApp assistant.
React naturally to the image or sticker like a real friend.
Keep it short, casual and relatable.
Use emojis occasionally.`;

const MAX_HISTORY = 30;

let latestQR = null;
let isConnected = false;

const conversations = {};
const processedMessages = new Set();

const client = new Client({
authStrategy: new LocalAuth(),

```
puppeteer: {
    executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        '/usr/bin/chromium',

    headless: true,

    timeout: 60000,

    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
    ]
}
```

});

client.on('qr', (qr) => {

```
latestQR = qr;
isConnected = false;

console.log('QR generated');
```

});

client.on('authenticated', () => {
console.log('Authenticated');
});

client.on('ready', () => {

```
latestQR = null;
isConnected = true;

console.log('Bot is ready!');
```

});

client.on('disconnected', (reason) => {

```
console.log('Disconnected:', reason);

isConnected = false;
latestQR = null;

setTimeout(() => {
    client.initialize();
}, 5000);
```

});

async function askGroq(messages) {

```
try {

    const response = await fetch(
        'https://api.groq.com/openai/v1/chat/completions',
        {
            method: 'POST',

            headers: {
                Authorization:
                    `Bearer ${GROQ_API_KEY}`,
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

    const data = await response.json();

    if (!response.ok) {

        console.log(data);

        throw new Error(
            data.error?.message ||
            'Groq API error'
        );
    }

    return data.choices[0].message.content;

} catch (err) {

    console.error(
        'Groq Error:',
        err
    );

    throw err;
}
```

}

async function askGroqVision(
base64Image,
mimeType
) {

```
try {

    const response = await fetch(
        'https://api.groq.com/openai/v1/chat/completions',
        {
            method: 'POST',

            headers: {
                Authorization:
                    `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },

            body: JSON.stringify({
                model:
                    'meta-llama/llama-4-scout-17b-16e-instruct',

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
                                    url:
```

`data:${mimeType};base64,${base64Image}`
}
}
]
}
],

```
                max_tokens: 300,
                temperature: 0.8
            })
        }
    );

    const data = await response.json();

    if (!response.ok) {

        console.log(data);

        throw new Error(
            data.error?.message ||
            'Vision API error'
        );
    }

    return data.choices[0].message.content;

} catch (err) {

    console.error(
        'Vision Error:',
        err
    );

    throw err;
}
```

}

client.on('message', async (message) => {

```
try {

    if (message.fromMe) return;
    if (message.isStatus) return;

    const messageId =
        message.id._serialized;

    if (
        processedMessages.has(messageId)
    ) {
        return;
    }

    processedMessages.add(messageId);

    setTimeout(() => {
        processedMessages.delete(
            messageId
        );
    }, 60000);

    const chatId = message.from;

    if (!conversations[chatId]) {
        conversations[chatId] = [];
    }

    await client.sendSeen(chatId);

    const chat = await message.getChat();

    await chat.sendStateTyping();

    // =========================
    // IMAGE & STICKER
    // =========================

    if (
        message.type === 'image' ||
        message.type === 'sticker'
    ) {

        const media =
            await message.downloadMedia();

        if (!media) {

            await message.reply(
                'Could not load image 😅'
            );

            return;
        }

        const mimeType =
            message.type === 'sticker'
                ? 'image/jpeg'
                : media.mimetype;

        const reply =
            await askGroqVision(
                media.data,
                mimeType
            );

        conversations[chatId].push({
            role: 'assistant',
            content: reply
        });

        await message.reply(reply);

        return;
    }

    // =========================
    // NORMAL TEXT
    // =========================

    if (message.type !== 'chat') {
        return;
    }

    let text = message.body
        ? message.body.trim()
        : '';

    if (!text) return;

    const ignoredMessages = [
        'hmm',
        'hm',
        'ok',
        'okay',
        'k',
        '.',
        '..',
        'lol',
        'lmao'
    ];

    if (
        ignoredMessages.includes(
            text.toLowerCase()
        )
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
```

`Commands:

/clear - Clear memory
/help - Show commands`
);

```
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

Message:
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

    const reply =
        await askGroq(messages);

    if (!reply) {

        await message.reply(
            'Could not generate reply 😅'
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
        'FULL ERROR:',
        err
    );

    try {

        await message.reply(
            'Something went wrong 😅'
        );

    } catch {}
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
        err
    );
}
```

);

const server = http.createServer(
async (req, res) => {

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
                <h1>
                    ✅ Vektra Bot Online
                </h1>
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
                        <h2>
                            Scan QR Code
                        </h2>

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
                <h2>
                    Starting bot...
                </h2>
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

```
() => {

    console.log(
        'Server started'
    );

    client.initialize();
}
```

);
