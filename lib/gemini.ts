const MODELS = [
  process.env.GEMINI_MODEL,  
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
].filter((m): m is string => !!m);

type GeminiOptions = {
  /** JSON schema (Gemini format, UPPERCASE types). Forces valid, structured JSON output. */
  schema?: Record<string, unknown>;
  timeoutMs?: number;
};

/*Calls Gemini and returns the text, or `null` on ANY failure
(no key, timeout, HTTP error, blocked/empty response). Failures are logged.
 */
export async function callGemini(prompt: string, { schema, timeoutMs = 20000 }: GeminiOptions = {}): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  for (const model of MODELS) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            ...(schema ? { responseMimeType: 'application/json', responseSchema: schema } : {}),
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.warn(`[gemini] ${model} returned HTTP ${res.status}: ${detail.slice(0, 300)}`);
        // Model unavailable / quota / server busy -> try the next model. Anything else -> stop.
        if ([403, 404, 429, 500, 503].includes(res.status)) continue;
        return null;
      }

      const data = await res.json();
      const parts: Array<{ text?: string }> = data?.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((p) => p.text ?? '').join('').trim();

      if (text) return text;
      console.warn(`[gemini] ${model} empty response`, data?.promptFeedback ?? data?.candidates?.[0]?.finishReason);
    } catch (err) {
      console.warn(`[gemini] ${model} request failed:`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}