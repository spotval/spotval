// SpotVal Backend API Route
// This file runs on Vercel's servers, not in the user's browser
// It calls GPT-4.1 via GitHub Models and returns a structured deal score

// Rate limiting: 5 scans per IP per 24h.
// Note: in-memory state. Resets when Vercel cold-starts a new instance,
// so the effective limit can be a bit higher under load. Good enough for
// abuse prevention at current scale; swap for @vercel/kv later if needed.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const ipRequests = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = ipRequests.get(ip);

  if (!entry || now >= entry.resetAt) {
    const resetAt = now + RATE_LIMIT_WINDOW_MS;
    ipRequests.set(ip, { count: 1, resetAt });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetAt };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count, resetAt: entry.resetAt };
}

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limit by IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
          || req.headers['x-real-ip']
          || 'unknown';

  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    const msLeft = limit.resetAt - Date.now();
    const hoursLeft = Math.max(1, Math.ceil(msLeft / (1000 * 60 * 60)));
    return res.status(429).json({
      error: `Daily scan limit reached (5 per day). Try again in ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}.`,
      remaining: 0,
      resetAt: limit.resetAt
    });
  }

  try {
    const { inputType, url, title, price, condition, description } = req.body;

    // Validate input based on type
    if (inputType === 'url') {
      if (!url || url.trim().length < 5) {
        return res.status(400).json({ error: 'Please provide a valid listing URL' });
      }
    } else {
      if (!title || !price || !condition || !description) {
        return res.status(400).json({ error: 'Please fill in all listing fields' });
      }
    }

    // Build the prompt for GPT-4.1
    const listingDetails = inputType === 'url'
      ? `URL: ${url}\n\nNote: The user pasted a URL. Analyze based on what you can infer from the URL and your market knowledge.`
      : `Title: ${title}\nListed Price: $${price}\nCondition: ${condition}\nDescription: ${description}`;

    const systemPrompt = `You are SpotVal, an expert at analyzing online secondhand listings to determine if they are good deals. You analyze listings from Facebook Marketplace, eBay, Craigslist, OfferUp, Mercari, and other platforms.

Your job is to return a structured JSON analysis with:
- score: integer 0-100 (where 80+ is great, 50-79 is fair, below 50 is overpriced)
- verdict: one of "Great Deal", "Fair Deal", or "Overpriced"
- verdictIcon: one of "✓" (great), "~" (fair), or "✕" (overpriced)
- verdictColor: hex color - "#39e07a" for great, "#f5c842" for fair, "#f25c5c" for overpriced
- message: 1-2 sentence plain-English explanation of why this score
- recommendation: short action like "Buy now", "Negotiate", "Pass", "Lowball offer"
- offer: suggested offer price as string with dollar sign like "$385"
- confidence: short string like "High confidence based on market knowledge" or "Medium confidence - limited data on this item"
- suggestedMessage: a 2-3 sentence message the buyer can copy and send to the seller. Match the tone to the score:
  * If Great Deal (80+): polite confirmation message expressing genuine interest and asking about pickup or next steps. Keep it warm and ready to commit.
  * If Fair Deal (50-79): respectful negotiation that asks if they would accept the suggested offer. Acknowledge the item has value but make a clear counter-offer.
  * If Overpriced (below 50): friendly but firm lowball. Reference the suggested offer as your max budget. Mention you have been watching the market. Stay respectful but do not apologize for the lower offer.

The suggestedMessage MUST follow these rules:
- Sound completely human and conversational, like a real person texting another person
- Use plain language - no buzzwords, no salesy phrases, no excessive enthusiasm
- AVOID excessive punctuation - no exclamation points unless absolutely natural (max 1), no em-dashes, no semicolons, minimal commas
- AVOID phrases like "I hope this finds you well", "I am reaching out", "I came across", "Just letting you know"
- AVOID overly formal or robotic phrasing
- DO use contractions naturally (I'm, that's, you're)
- DO start with something natural like "Hey", "Hi there", or just dive into the message
- DO reference the suggested offer price when negotiating
- Stay under 60 words total

Be honest and direct on the analysis. Base scores on actual market value, condition described, and platform pricing norms.

Return ONLY valid JSON. No markdown, no code fences, no extra text.`;

    const userPrompt = `Analyze this listing:\n\n${listingDetails}\n\nReturn your structured JSON analysis.`;

    // Call GPT-4.1 via GitHub Models
    const response = await fetch('https://models.github.ai/inference/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4.1',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 700,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('GitHub Models API error:', response.status, errorText);
      return res.status(500).json({
        error: 'Analysis service unavailable. Please try again in a moment.'
      });
    }

    const data = await response.json();
    const aiContent = data.choices?.[0]?.message?.content;

    if (!aiContent) {
      return res.status(500).json({ error: 'No analysis returned. Please try again.' });
    }

    // Parse the AI response
    let analysis;
    try {
      analysis = JSON.parse(aiContent);
    } catch (parseError) {
      console.error('Failed to parse AI response:', aiContent);
      return res.status(500).json({ error: 'Invalid analysis format. Please try again.' });
    }

    // Build the response for the frontend
    const result = {
      score: analysis.score || 50,
      verdict: analysis.verdict || 'Fair Deal',
      verdictIcon: analysis.verdictIcon || '~',
      verdictColor: analysis.verdictColor || '#f5c842',
      message: analysis.message || 'Analysis complete.',
      recommendation: analysis.recommendation || 'Review carefully',
      offer: analysis.offer || '$0',
      confidence: analysis.confidence || 'Medium confidence',
      suggestedMessage: analysis.suggestedMessage || '',
      listingTitle: inputType === 'url' ? 'Listing from URL' : title,
      listingMeta: inputType === 'url'
        ? url.substring(0, 60) + (url.length > 60 ? '...' : '')
        : `Listed at $${price} · ${condition}`,
      remaining: limit.remaining,
      resetAt: limit.resetAt
    };

    return res.status(200).json(result);

  } catch (error) {
    console.error('Scan API error:', error);
    return res.status(500).json({
      error: 'Something went wrong analyzing your listing. Please try again.'
    });
  }
}
