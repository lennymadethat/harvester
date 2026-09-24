// gemini.js — the watcher. Gemini reads a YouTube URL natively as a video part
// (no download, no transcription step) and returns a rich, faithful, structured
// extraction. For articles, posts and pasted text the same shape comes from the
// text prompt. Claude does the thinking afterwards; Gemini only sees and reports.
//
// Wire shape: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
// header x-goog-api-key, body { contents:[{ parts:[ {text}, {file_data:{file_uri}} ] }] }.

const DEFAULT_MODEL = 'gemini-2.5-pro';
const DEFAULT_FALLBACK = 'gemini-2.5-flash';
const API = 'https://generativelanguage.googleapis.com/v1beta/models';

const SHAPE =
  '{\n' +
  '  "title": string,\n' +
  '  "channel": string,             // channel, author, or speaker\n' +
  '  "duration": string,            // e.g. "23:14", or "" for text\n' +
  '  "talking_points": string[],    // the full sequence of points, in order\n' +
  '  "key_ideas": string[],\n' +
  '  "lessons": string[],\n' +
  '  "tutorials": string[],         // step-by-step how-tos demonstrated\n' +
  '  "tips": string[],\n' +
  '  "messages": string[],          // what the speaker explicitly wants remembered\n' +
  '  "practices": string[],\n' +
  '  "skills": string[],\n' +
  '  "tools_and_names": string[],   // tools, products, people, books named\n' +
  '  "numbers": string[],           // exact figures, stats, prices, dates\n' +
  '  "stories": string[],\n' +
  '  "claims": string[],            // explicit claims, for later fact-check\n' +
  '  "quotes": string[],            // memorable verbatim lines\n' +
  '  "visual_notes": string[],      // what appears on screen: diagrams, slides, UI, demos\n' +
  '  "visual_timeline": [{"t":"m:ss","end":"m:ss","shot":string,"motion":string,"text_on_screen":string,"transition":string}],\n' +
  '  "chapters": [{"t":"mm:ss","title":string}],\n' +
  '  "domain_signals": string[],    // free-form clues about which world this belongs to\n' +
  '  "full_notes": string           // a thorough plain-text note of the whole thing\n' +
  '}';

const VIDEO_PROMPT =
  'You are a video-ingestion engine for a personal second brain. Watch the linked video end to end ' +
  '(audio, on-screen text, visuals). Return a RAW, FAITHFUL, RICH structured extraction. Do not editorialize. ' +
  'Capture what was said AND what was shown. Return ONLY JSON, no prose, no code fences, with this shape:\n' + SHAPE + '\n' +
  'visual_timeline: one entry per visual beat, timestamps required, covering the whole video; exhaustive for a ' +
  'short video, one beat per chapter for a long one. Be thorough: prefer specific bullets over vague ones. ' +
  'Empty arrays are fine. If you cannot access or read the video, return {"error": "<short reason>"}.';

const TEXT_PROMPT =
  'You are an ingestion engine for a personal second brain. Read the source below (an article, a post, a ' +
  'repository page, or pasted notes). Return a RAW, FAITHFUL, RICH structured extraction. Do not editorialize. ' +
  'Return ONLY JSON, no prose, no code fences, with this shape:\n' + SHAPE + '\n' +
  'Empty arrays are fine. If the source is empty or unreadable, return {"error": "<short reason>"}.';

export function parseModelJson(raw, who = 'model') {
  let s = (raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) throw new Error(`No JSON object found in ${who} output`);
  return JSON.parse(s.slice(first, last + 1));
}

async function call(model, parts, env) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const resp = await fetch(`${API}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 16384, responseMimeType: 'application/json' },
    }),
  });
  if (!resp.ok) {
    const err = new Error(`gemini ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  const cand = data.candidates && data.candidates[0];
  const text = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts.map(p => p.text || '').join('') : '';
  if (!text) throw new Error(`gemini returned no text${cand && cand.finishReason ? ` (finishReason=${cand.finishReason})` : ''}`);
  const parsed = parseModelJson(text, 'gemini');
  if (parsed && parsed.error) throw new Error(`gemini could not read the source: ${parsed.error}`);
  return parsed;
}

// Fall back to the smaller model on length, quota and transient errors.
const FALLBACK_STATUS = new Set([400, 413, 429, 500, 503]);

async function withFallback(env, fn) {
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const fallback = env.GEMINI_FALLBACK_MODEL || DEFAULT_FALLBACK;
  try { return { extraction: await fn(model), model }; }
  catch (e) {
    if (fallback && fallback !== model && (e.status == null || FALLBACK_STATUS.has(e.status))) {
      return { extraction: await fn(fallback), model: fallback, fellBack: true };
    }
    throw e;
  }
}

// A YouTube URL, watched natively.
export function extractVideo(url, env) {
  return withFallback(env, (model) => call(model, [{ text: VIDEO_PROMPT }, { file_data: { file_uri: url } }], env));
}

// An article, post, or pasted text.
export function extractText({ title, url, text }, env) {
  const header = [title ? `Title: ${title}` : '', url ? `URL: ${url}` : '', '', text || ''].filter(Boolean).join('\n');
  return withFallback(env, (model) => call(model, [{ text: TEXT_PROMPT + '\n\nSOURCE:\n' + header.slice(0, 60000) }], env));
}
