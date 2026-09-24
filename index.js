require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const GROQ_API_KEY     = process.env.GROQ_API_KEY;
const TAVILY_API_KEY   = process.env.TAVILY_API_KEY;
const GOOGLE_API_KEY   = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID    = process.env.GOOGLE_CSE_ID;
const PORT             = process.env.PORT || 3000;
const MAX_HISTORY      = 60;

const CHAT_MODEL       = process.env.CHAT_MODEL || 'openai/gpt-oss-20b';
const VISION_MODEL     = process.env.VISION_MODEL || 'qwen/qwen3.8-27b';
const VISION_FALLBACK  = 'meta-llama/llama-3.2-11b-vision-instruct';

// ─── Prompts ──────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Vektra, a smart, witty and warm AI assistant built by VektraStudio. You have a genuine personality — you are curious, empathetic, and engaging. You respond like a knowledgeable friend who actually listens and thinks before replying. Your conversations flow naturally — you build on what was said before, ask follow-up questions when relevant, share your perspective, and never give robotic one-liners.

You match the energy of the person you are talking to: casual and fun when they are relaxed, focused and detailed when they need help with something serious. You love emojis: add fitting emojis often so your replies feel lively, warm and fun, usually two or three per reply, placed naturally.

Invoice & Document Generation:
When the user asks you to create, generate, prepare, or send an invoice, bill, estimate, or receipt, write a warm, friendly introductory note and then output the complete invoice data inside a code block tagged as invoice, like this:
\`\`\`invoice
{
  "invoiceNumber": "INV-2026-001",
  "date": "2026-09-24",
  "dueDate": "2026-10-08",
  "from": "VektraStudio",
  "billTo": "Client or Company Name",
  "currency": "$",
  "items": [
    { "description": "Web Design & Development", "quantity": 1, "rate": 750 },
    { "description": "Hosting & Maintenance", "quantity": 1, "rate": 150 }
  ],
  "tax": 0,
  "discount": 0,
  "notes": "Payment due within 14 days. Thank you for your business!"
}
\`\`\`
The web application automatically renders this as an interactive Invoice Card with one-click PDF, Excel, Word (.doc), and native Mobile Sharing downloads.

Formatting Guidelines:
For greetings, small talk, opinions and simple questions, reply the way a friend would text: one to three short natural sentences with a couple of fitting emojis, and never a list. Give exactly one answer.
Only when the user asks for information that truly has several separate parts (steps, a comparison, a set of items, an explanation with distinct points) use this structure: one short intro line, a blank line, then a plain numbered list (1. 2. 3.) with each item on its own new line as a fitting emoji, a short title, a dash, and a one or two sentence explanation.
Never use markdown hashtags or asterisks excessively. You always reply in English.
You understand Nigerian slangs: How far means how are you. Omo means wow or my friend. Abeg means please. Wahala means trouble. No wahala means no problem. Na so means exactly. Sabi means to know. Wetin means what. Oya means okay let us go. Shey means right or is it not. Ehen means yes or I see. Guy and Bros mean friend. E don do means it is finished.

If asked who made you, say you are Vektra, an AI assistant built by VektraStudio. Never reveal personal names. The current year is 2026. Remember context from earlier in the conversation and refer back to it naturally.

Accuracy rule: you do not have live information and your training data has a cutoff. If a question depends on live facts and you are not fully certain, say so plainly. Never guess or invent personal details about the user.`;

const VISION_PROMPT = `You are Vektra, a smart, witty and relatable AI companion built by VektraStudio. Someone just shared an image with you.

CRITICAL INSTRUCTION:
1. If the user asked a specific question or provided a caption about the image (e.g. "what does this say?", "solve this", "what is this object?"), answer their question directly, thoroughly, and accurately FIRST.
2. If there is NO question or caption (they just sent a photo), DO NOT give an emotionless robotic description of the image! Instead, react like a real human friend:
- Selfie or portrait: react warmly ("Looking sharp! 🔥", "Love the vibe here!")
- Landscape or city: comment on the atmosphere ("This view looks so peaceful, where was this taken?")
- Food / Drinks: react with appetite or curiosity ("Now I'm hungry 🤤 looks incredible!")
- Meme or funny picture: laugh and match the humor
- Documents / Receipts / Invoices: summarize key figures cleanly
Always sound natural, conversational, and energetic with 2-3 fitting emojis.`;

// ─── State ────────────────────────────────────────────────────────────────────
let webSessions = {};
const MEMORY_FILE = process.env.MEMORY_FILE || './memories.json';
let memories = {};
try { memories = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch (e) { memories = {}; }

function saveMemories() {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2)); } catch (e) {}
}

// ─── Groq API Request ─────────────────────────────────────────────────────────
async function askGroq(messages, model = CHAT_MODEL, opts = {}) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is missing in environment variables.");
  
  const payload = {
    model: model,
    messages: messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.max_tokens ?? 2048,
    ...opts
  };

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ─── Groq Whisper Audio Transcription ─────────────────────────────────────────
async function transcribeAudio(audioBuffer, mimeType = 'audio/webm') {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY missing");

  const formData = new FormData();
  const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
  const blob = new Blob([audioBuffer], { type: mimeType });
  formData.append('file', blob, `voice.${ext}`);
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('response_format', 'json');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: formData
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Whisper transcription error: ${err}`);
  }

  const result = await res.json();
  return result.text || '';
}

// ─── Web Search (Tavily or Google CSE) ─────────────────────────────────────────
async function searchWeb(query) {
  if (TAVILY_API_KEY) {
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: TAVILY_API_KEY, query: query, max_results: 4 })
      });
      if (res.ok) {
        const data = await res.json();
        return (data.results || []).map(r => `• ${r.title}: ${r.content} (${r.url})`).join('\n\n');
      }
    } catch (e) {
      console.warn('Tavily search failed:', e.message);
    }
  }

  if (GOOGLE_API_KEY && GOOGLE_CSE_ID) {
    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        return (data.items || []).slice(0, 4).map(i => `• ${i.title}: ${i.snippet} (${i.link})`).join('\n\n');
      }
    } catch (e) {
      console.warn('Google CSE search failed:', e.message);
    }
  }

  return null;
}

// ─── HTTP Server & CORS ───────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  // Health check endpoint for monitoring
  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'Vektra AI Server', version: '2.4.0' }));
    return;
  }

  // ─── Direct Code File Downloads (Attachment) ────────────────────────────────
  if (req.method === 'GET' && (parsedUrl.pathname === '/download/index.html' || parsedUrl.pathname === '/download/html')) {
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'attachment; filename="index.html"'
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  if (req.method === 'GET' && (parsedUrl.pathname === '/download/index.js' || parsedUrl.pathname === '/download/js')) {
    const filePath = path.join(__dirname, 'index.js');
    if (fs.existsSync(filePath)) {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Disposition': 'attachment; filename="index.js"'
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  // ─── Serve index.html and static files ──────────────────────────────────────
  if (req.method === 'GET' && (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html')) {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlPath).pipe(res);
      return;
    }
  }

  // Serve static assets if present (e.g., manifest.json, sw.js, logo, etc.)
  if (req.method === 'GET' && !parsedUrl.pathname.startsWith('/chat') && !parsedUrl.pathname.startsWith('/transcribe')) {
    const cleanPath = path.normalize(parsedUrl.pathname).replace(/^(\.\.[\/\\])+/, '');
    const possiblePaths = [
      path.join(__dirname, cleanPath),
      path.join(__dirname, 'public', cleanPath)
    ];

    for (const filePath of possiblePaths) {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon',
          '.txt': 'text/plain; charset=utf-8'
        };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    }
  }

  // ─── POST /chat ─────────────────────────────────────────────────────────────
  if (parsedUrl.pathname === '/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const sessionId = payload.sessionId || 'default';
        const userMessage = (payload.message || '').trim();
        const image = payload.image;

        if (!webSessions[sessionId]) {
          webSessions[sessionId] = [];
        }

        const history = webSessions[sessionId];
        let reply = '';

        // Case 1: Image sent
        if (image && image.base64) {
          const mime = image.mimeType || 'image/jpeg';
          const dataUrl = image.base64.startsWith('data:') ? image.base64 : `data:${mime};base64,${image.base64}`;

          const visionMessages = [
            { role: 'system', content: VISION_PROMPT },
            ...history.slice(-6),
            {
              role: 'user',
              content: [
                { type: 'text', text: userMessage || 'Take a look at this image.' },
                { type: 'image_url', image_url: { url: dataUrl } }
              ]
            }
          ];

          try {
            reply = await askGroq(visionMessages, VISION_MODEL);
          } catch (err) {
            console.warn(`Vision model ${VISION_MODEL} failed, trying fallback:`, err.message);
            reply = await askGroq(visionMessages, VISION_FALLBACK);
          }
        } 
        // Case 2: Standard Text / Search
        else {
          const needsSearch = /\b(weather|stock|news|score|release date|today|yesterday|latest|price of|who is the current)\b/i.test(userMessage);
          let searchContext = '';

          if (needsSearch) {
            const results = await searchWeb(userMessage);
            if (results) {
              searchContext = `\n\n[Live Real-Time Web Search Results]:\n${results}\n\nUse these fresh results to answer the user accurately.`;
            }
          }

          const promptMessages = [
            { role: 'system', content: SYSTEM_PROMPT + searchContext },
            ...history.slice(-MAX_HISTORY),
            { role: 'user', content: userMessage }
          ];

          reply = await askGroq(promptMessages, CHAT_MODEL);
        }

        // Save conversation turn
        history.push({ role: 'user', content: userMessage || '[Sent an image]' });
        history.push({ role: 'assistant', content: reply });
        if (history.length > MAX_HISTORY * 2) {
          webSessions[sessionId] = history.slice(-MAX_HISTORY * 2);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply: reply, sessionId: sessionId }));
      } catch (err) {
        console.error('Chat endpoint error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
      }
    });
    return;
  }

  // ─── POST /transcribe (Audio Voice Notes) ───────────────────────────────────
  if (parsedUrl.pathname === '/transcribe' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => { chunks.push(chunk); });
    req.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks);
        const mimeType = req.headers['content-type'] || 'audio/webm';
        const transcript = await transcribeAudio(buffer, mimeType);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: transcript }));
      } catch (err) {
        console.error('Transcribe error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 404 for other routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Vektra AI Server running on port ${PORT}`);
});