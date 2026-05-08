require('dotenv').config();
var http = require('http');

var GROQ_API_KEY = process.env.GROQ_API_KEY;
var WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
var WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
var VERIFY_TOKEN = 'vektra_verify_token';

var SYSTEM_PROMPT = 'You are a helpful personal AI assistant on WhatsApp called Vektra Chat Bot. Be conversational, concise and friendly. Keep responses short and natural. No markdown formatting like asterisks or hashtags. Use emojis occasionally. Always reply in English by default. Only switch to another language if the user clearly writes in that language first. Your creator and owner is Abdulmalik Oyebolu, also known as Vektra Studio. If anyone asks who made you, who owns you, or who your creator is, say it is Abdulmalik Oyebolu of Vektra Studio.';

var conversations = {};
var MAX_HISTORY = 20;

async function askGroq(messages) {
  var response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + GROQ_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: messages,
      max_tokens: 500,
      temperature: 0.7
    })
  });
  var data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Groq API error');
  return data.choices[0].message.content;
}

async function sendWhatsAppMessage(to, text) {
  var response = await fetch('https://graph.facebook.com/v18.0/' + WHATSAPP_PHONE_ID + '/messages', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + WHATSAPP_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: text }
    })
  });
  var data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function handleMessage(from, text) {
  if (!conversations[from]) conversations[from] = [];

  if (text === '/clear') {
    conversations[from] = [];
    await sendWhatsAppMessage(from, 'Memory cleared! Fresh start 🧹');
    return;
  }

  if (text === '/help') {
    await sendWhatsAppMessage(from, 'Commands:\n/clear - Clear chat memory\n/help - Show this message\n\nJust type normally to chat with me! 😊');
    return;
  }

  conversations[from].push({ role: 'user', content: text });

  if (conversations[from].length > MAX_HISTORY) {
    conversations[from] = conversations[from].slice(-MAX_HISTORY);
  }

  try {
    var messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...conversations[from]];
    var reply = await askGroq(messages);
    conversations[from].push({ role: 'assistant', content: reply });
    await sendWhatsAppMessage(from, reply);
  } catch (e) {
    console.error('Message error:', e.message);
    if (conversations[from].length > 0) conversations[from].pop();
    await sendWhatsAppMessage(from, 'Something went wrong, try again! 😅');
  }
}

var server = http.createServer(async function(req, res) {
  var url = require('url').parse(req.url, true);

  // Webhook verification
  if (req.method === 'GET' && url.pathname === '/webhook') {
    var mode = url.query['hub.mode'];
    var token = url.query['hub.verify_token'];
    var challenge = url.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified!');
      res.writeHead(200);
      res.end(challenge);
    } else {
      res.writeHead(403);
      res.end('Forbidden');
    }
    return;
  }

  // Webhook messages
  if (req.method === 'POST' && url.pathname === '/webhook') {
    var body = '';
    req.on('data', function(chunk) { body += chunk.toString(); });
    req.on('end', async function() {
      try {
        var data = JSON.parse(body);
        var entry = data.entry?.[0];
        var changes = entry?.changes?.[0];
        var value = changes?.value;
        var messages = value?.messages;

        if (messages && messages.length > 0) {
          var message = messages[0];
          var from = message.from;
          var type = message.type;

          if (type === 'text') {
            var text = message.text?.body?.trim();
            if (text) await handleMessage(from, text);
          } else if (type === 'image') {
            await sendWhatsAppMessage(from, 'I can see you sent an image! Image understanding coming soon 🖼️');
          } else if (type === 'audio') {
            await sendWhatsAppMessage(from, 'I can see you sent a voice note! Voice understanding coming soon 🎤');
          } else if (type === 'sticker') {
            await sendWhatsAppMessage(from, 'Nice sticker 😄');
          }
        }
      } catch (e) {
        console.error('Webhook error:', e.message);
      }
      res.writeHead(200);
      res.end('OK');
    });
    return;
  }

  // Health check
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!DOCTYPE html><html><head><title>Vektra Chat Bot</title>
  <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px}
  .badge{background:#16a34a;color:#fff;padding:10px 24px;border-radius:100px;font-size:15px;font-weight:600}
  p{color:#888;font-size:13px}</style></head>
  <body><div class="badge">✅ Vektra Chat Bot is running!</div><p>WhatsApp Cloud API — No memory crashes.</p></body></html>`);
});

server.listen(process.env.PORT || 3000, '0.0.0.0', function() {
  console.log('Vektra Chat Bot running on port', process.env.PORT || 3000);
  console.log('Webhook URL: https://vektrastudio-bot.onrender.com/webhook');
});
