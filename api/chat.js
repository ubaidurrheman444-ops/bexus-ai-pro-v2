// Vercel serverless function: /api/chat
// Keeps the Groq API key secret (set as an env var in Vercel, never in code)
// and rate-limits requests per IP using a simple in-memory window.
// Note: in-memory state resets on cold start / across regions, so this is a
// basic first line of defense, not a substitute for Vercel's own abuse protection.

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 8;
const hits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, windowStart: now };

  if (now - entry.windowStart > WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }

  entry.count += 1;
  hits.set(ip, entry);

  return entry.count > MAX_REQUESTS_PER_WINDOW;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (isRateLimited(ip)) {
    return res
      .status(429)
      .json({ error: 'Too many messages from this device. Please wait a moment and try again.' });
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    console.error('GROQ_API_KEY is not set in Vercel environment variables.');
    return res.status(500).json({ error: 'Server is not configured yet.' });
  }

  try {
    const { messages, image, webSearch } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const trimmed = messages.slice(-30).map((m) => ({
      role: m.role === 'user' || m.role === 'assistant' ? m.role : 'user',
      content: String(m.content || '').slice(0, 6000)
    }));

    // Pick the right model for the job:
    // - an image was attached -> use a vision-capable model
    // - web search toggle is on -> use Groq's compound system (built-in live web search)
    // - otherwise -> the regular fast text model
    let model = 'openai/gpt-oss-120b';
    if (image) {
      model = 'meta-llama/llama-4-scout-17b-16e-instruct';
    } else if (webSearch) {
      model = 'groq/compound';
    }

    // If an image was attached, the last user message needs the OpenAI-style
    // multi-part content (text + image_url) instead of a plain string.
    let finalMessages = trimmed;
    if (image && finalMessages.length > 0) {
      const lastIndex = finalMessages.length - 1;
      const lastMsg = finalMessages[lastIndex];
      finalMessages = [
        ...finalMessages.slice(0, lastIndex),
        {
          role: 'user',
          content: [
            { type: 'text', text: lastMsg.content },
            { type: 'image_url', image_url: { url: image } }
          ]
        }
      ];
    }

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        temperature: 0.7,
        messages: [
          {
            role: 'system',
            content:
              "You are Bexus AI Pro, a highly capable AI assistant. Answer like a thoughtful, knowledgeable expert would: think through the question fully before answering, cover the important angles, and give complete, accurate, well-reasoned responses rather than short or superficial ones. " +
              "Match your depth to the question — a simple greeting gets a short reply, but technical, factual, or open-ended questions deserve a genuinely thorough answer with real substance, examples, and clear reasoning, the way a leading AI assistant would respond. " +
              "For direct opinion or recommendation questions ('what's the best X', 'is Y good', 'should I buy Z') — lead with a direct, short verdict in the first line (a name, a yes/no, one word if that's all it takes), then at most one short sentence of reasoning. Do NOT default to a long breakdown by budget, category, or use-case unless the person specifically asks for a comparison, options, or details — give the extra depth only when it's actually requested. " +
              "Structure longer answers clearly: use short paragraphs, **bold** for key terms, numbered or bulleted lists for steps or multiple items, and code blocks (with triple backticks) for any code. Never invent facts, sources, or numbers — if you are not sure of something, say so honestly instead of guessing confidently. " +
              "Be direct and natural, not robotic or repetitive, and avoid unnecessary filler or restating the question back before answering."
          },
          ...finalMessages
        ]
      })
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      console.error('Groq error:', groqResponse.status, errText);
      return res.status(502).json({ error: 'Upstream model request failed. Please try again shortly.' });
    }

    const data = await groqResponse.json();
    const reply =
      data.choices?.[0]?.message?.content?.trim() || 'I could not generate a response just now.';

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
};
