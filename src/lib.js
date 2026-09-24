// lib.js — CORS, JSON responses, the token gate, URL helpers, source loading.

export function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allow = allowedOrigins(env);
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-harvester-token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (allow.includes('*')) h['Access-Control-Allow-Origin'] = '*';
  else if (origin && allow.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

export const json = (body, status, request, env) =>
  new Response(JSON.stringify(body, null, 2), { status: status || 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) } });

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// One shared token, sent as x-harvester-token or Authorization: Bearer.
export function authorized(request, env) {
  const got = request.headers.get('x-harvester-token') || (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  return !!env.HARVESTER_TOKEN && timingSafeEqual(got, env.HARVESTER_TOKEN);
}

export function slugify(s) {
  return (s || '').toString().toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
    .replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';
}

export function youtubeId(url) {
  if (typeof url !== 'string') return null;
  for (const re of [/[?&]v=([A-Za-z0-9_-]{11})/, /youtu\.be\/([A-Za-z0-9_-]{11})/, /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/, /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/]) {
    const m = url.match(re); if (m) return m[1];
  }
  return null;
}

export function xStatusId(raw) {
  const m = String(raw || '').match(/(?:twitter\.com|x\.com)\/(?:i\/web\/status|[^/\s]+\/status)\/(\d+)/i);
  return m ? m[1] : null;
}

export function githubRepo(raw) {
  const m = String(raw || '').match(/github\.com\/([^/\s]+)\/([^/\s?#]+)/i);
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/i, '') } : null;
}

// Fetch a non-video source as text: an X post via the public fxtwitter API, or
// any page stripped of markup. Best effort; an empty result is reported, not thrown.
export async function loadWebText(url) {
  const out = { title: '', text: '', channel: '' };
  const xid = xStatusId(url);
  if (xid) {
    try {
      const r = await fetch('https://api.fxtwitter.com/status/' + xid, { headers: { accept: 'application/json' } });
      const j = await r.json(); const tw = j.tweet || j;
      out.title = (tw.text || '').slice(0, 120);
      out.channel = tw.author?.name || tw.author?.screen_name || 'X';
      out.text = [tw.text, tw.quote?.text].filter(Boolean).join('\n\n');
    } catch { /* fall through */ }
    return out;
  }
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 harvester' } });
    const html = (await r.text()).slice(0, 120000);
    const title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || html.match(/<title[^>]*>([^<]+)/i);
    if (title) out.title = title[1].trim();
    out.text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40000);
  } catch { /* empty */ }
  return out;
}

// A thumbnail + title for a URL, for any UI that shows a card before harvesting.
export async function unfurl(raw) {
  const out = { url: raw || '', kind: 'text', thumb: null, title: null };
  if (!raw || !/^https?:\/\//i.test(raw)) return out;
  const yt = youtubeId(raw);
  if (yt) return { ...out, kind: 'youtube', thumb: `https://img.youtube.com/vi/${yt}/hqdefault.jpg` };
  if (xStatusId(raw)) {
    const w = await loadWebText(raw);
    return { ...out, kind: 'x', title: w.title || null };
  }
  const gh = githubRepo(raw);
  if (gh) return { ...out, kind: 'github', thumb: `https://opengraph.githubassets.com/1/${gh.owner}/${gh.repo}` };
  out.kind = 'article';
  try {
    const r = await fetch(raw, { headers: { 'user-agent': 'Mozilla/5.0 harvester-unfurl' } });
    const html = (await r.text()).slice(0, 80000);
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    const title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || html.match(/<title[^>]*>([^<]+)/i);
    if (og) out.thumb = og[1];
    if (title) out.title = title[1].trim().slice(0, 160);
  } catch { /* ignore */ }
  return out;
}
