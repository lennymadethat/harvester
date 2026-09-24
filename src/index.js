// Harvester — paste a link, get the lessons.
//
// Routes:
//   GET  /            liveness (public)
//   GET  /health      { ok, version, library, llm, lenses } (public)
//   POST /harvest     run a harvest; token; 409 if one is already running
//   POST /events      log a harvest_events row from another path (a bot, a script); token
//   GET  /unfurl?url= thumbnail + title for a URL, for a UI card; token
//   GET  /status      { running, lastRun, lastRunAt }; token
//
// POST /harvest body:
//   { "urls": ["https://youtube.com/watch?v=..."], "lens": "Auto"|"Work"|..., "focus": "optional", "text": "optional pasted text" }
//   urls may be one string or an array (max 10). lens defaults to Auto.

import { json, corsHeaders, authorized, unfurl } from './lib.js';
import { isLens, isAutoLens, lensList, normalizeLens } from './lenses.js';
import { runHarvest, logEvent, recentEventFor, DEDUPE_WINDOW_MS } from './harvest.js';
import { libraryConfigured } from './memory.js';

// Best-effort in-isolate state: fine for a single operator, not a hard lock.
let running = false, lastRun = null, lastRunAt = null;
const MAX_URLS = 10;

function normalizeUrls(raw) {
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(/[\n,]+/) : []);
  return list.map(s => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });

    if (path === '/' && request.method === 'GET') return json({ ok: true, service: 'harvester', version: env.HARVESTER_VERSION || 'dev' }, 200, request, env);
    if (path === '/health' && request.method === 'GET') {
      return json({
        ok: true, service: 'harvester', version: env.HARVESTER_VERSION || 'dev',
        library: libraryConfigured(env),
        llm: { gemini: !!env.GEMINI_API_KEY, anthropic: !!env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || 'claude-opus-5' },
        lenses: lensList(),
      }, 200, request, env);
    }

    if (['/harvest', '/status', '/events', '/unfurl'].includes(path) && !authorized(request, env)) {
      return json({ error: 'unauthorized' }, 401, request, env);
    }

    if (path === '/status' && request.method === 'GET') return json({ running, lastRun, lastRunAt }, 200, request, env);

    if (path === '/unfurl' && request.method === 'GET') return json(await unfurl(url.searchParams.get('url') || ''), 200, request, env);

    // History parity: another path (a Telegram bot, a local script) harvested
    // something and wants it on the same ledger. Deduped on page within the window.
    if (path === '/events' && request.method === 'POST') {
      let body; try { body = await request.json(); } catch { return json({ error: 'invalid JSON body' }, 400, request, env); }
      const source_url = typeof body?.source_url === 'string' ? body.source_url.trim() : '';
      const title = typeof body?.title === 'string' ? body.title.trim() : '';
      const page = typeof body?.page === 'string' ? body.page.trim() : '';
      if (!source_url && !page) return json({ error: 'source_url or page required' }, 400, request, env);
      const lens = normalizeLens(body?.lens) || String(body?.lens || 'Raw');
      const pathTag = typeof body?.path === 'string' ? body.path.trim() : 'external';
      const row = {
        source_url: source_url || null, title: title || page || 'Harvested',
        channel: typeof body?.channel === 'string' ? body.channel : null, duration: typeof body?.duration === 'string' ? body.duration : null,
        lens, routed_projects: body?.routed_projects != null ? (Array.isArray(body.routed_projects) ? body.routed_projects.join(', ') : String(body.routed_projects)) : null,
        page: page || null, summary: typeof body?.summary === 'string' ? body.summary.slice(0, 600) : null,
        reasoning: [typeof body?.reasoning === 'string' ? body.reasoning : '', `path:${pathTag}`].filter(Boolean).join(' · ').slice(0, 800),
        status: body?.status || 'harvested',
      };
      if (page && (await recentEventFor(env, page, DEDUPE_WINDOW_MS)).found) return json({ ok: true, deduped: true, page }, 200, request, env);
      const result = await logEvent(env, row);
      if (!result.ok) return json({ error: 'harvest_events insert failed', detail: result.error || result.status }, 502, request, env);
      return json({ ok: true, logged: row }, 200, request, env);
    }

    if (path === '/harvest' && request.method === 'POST') {
      if (!libraryConfigured(env)) return json({ error: 'library not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + OPENAI_API_KEY)' }, 503, request, env);
      let body; try { body = await request.json(); } catch { return json({ error: 'invalid JSON body' }, 400, request, env); }
      const urls = normalizeUrls(body?.urls);
      const pasted = typeof body?.text === 'string' ? body.text.trim() : '';
      const lens = normalizeLens(body?.lens);
      const focus = typeof body?.focus === 'string' ? body.focus : '';
      if (!urls.length && !pasted) return json({ error: 'no urls or text provided' }, 400, request, env);
      if (urls.length > MAX_URLS) return json({ error: `too many urls (max ${MAX_URLS})` }, 400, request, env);
      if (!lens) return json({ error: `invalid lens; must be one of ${lensList().join(', ')}` }, 400, request, env);
      if (running) return json({ status: 'busy' }, 409, request, env);
      running = true;
      try {
        const summary = await runHarvest(env, { urls, text: pasted, lens, focus });
        lastRun = summary; lastRunAt = new Date().toISOString();
        return json(summary, 200, request, env);
      } catch (e) {
        lastRun = { status: 'error', error: e.message || String(e) }; lastRunAt = new Date().toISOString();
        return json(lastRun, 500, request, env);
      } finally { running = false; }
    }

    return json({ error: 'not found', routes: ['POST /harvest', 'POST /events', 'GET /unfurl', 'GET /status', 'GET /health'] }, 404, request, env);
  },
};
