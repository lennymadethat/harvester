// harvest.js — one harvest run. For each source:
//   1. Extract: Gemini watches the video, or reads the article / post / pasted text.
//   2. Lens: Auto lets Claude pick; otherwise the caller chose. Raw skips synthesis.
//   3. Synthesize through the lens, with the lens's rulebook pages read live from the library.
//   4. Write the harvested page to raw/harvested/YYYY-MM-DD-{slug}.md.
//   5. Append each routed action item as a checkbox on its project page.
//   6. Log a harvest_events row: harvested, needs_review, or error. Errors are logged too.

import { LENSES, isLens, isAutoLens } from './lenses.js';
import { extractVideo, extractText } from './gemini.js';
import { classifyLens, synthesize } from './claude.js';
import { listProjectPages, listPagesByPrefix, readManyPages, writePage, appendToPage } from './memory.js';
import { slugify, youtubeId, loadWebText } from './lib.js';

export const HARVEST_SECTION = 'Harvested action items';
const METHODOLOGY_CHAR_CAP_DEFAULT = 80000;
const today = () => new Date().toISOString().slice(0, 10);

// ---- the project universe: one entry per project slug, best page path ----
function buildRoutingUniverse(pages) {
  const PREFIX = 'wiki/projects/';
  const map = new Map();
  for (const p of pages) {
    if (!p.path || !p.path.startsWith(PREFIX)) continue;
    const rest = p.path.slice(PREFIX.length);
    const slug = rest.split('/')[0].replace(/\.md$/i, '');
    if (!slug) continue;
    const lower = rest.toLowerCase(), s = slug.toLowerCase();
    const rank = lower === `${s}.md` ? 0 : lower === `${s}/readme.md` ? 1 : lower === `${s}/${s}.md` ? 2 : lower === `${s}/index.md` ? 3 : 9;
    const prev = map.get(slug);
    if (!prev) map.set(slug, { slug, description: p.title || slug, bestRank: rank, bestPath: p.path });
    else if (rank < prev.bestRank) { prev.bestRank = rank; prev.bestPath = p.path; prev.description = p.title || prev.description; }
  }
  for (const v of map.values()) v.pagePath = v.bestRank <= 3 ? v.bestPath : `${PREFIX}${v.slug}.md`;
  return [...map.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

// ---- a lens's rulebook, read live and capped ----
async function loadLensMethodology(lens, env) {
  const cap = Number.parseInt(env.METHODOLOGY_CHAR_CAP || '', 10) || METHODOLOGY_CHAR_CAP_DEFAULT;
  const pages = [];
  if (Array.isArray(lens.methodology) && lens.methodology.length) pages.push(...await readManyPages(lens.methodology, env));
  if (lens.prefix) {
    try { for (const p of await listPagesByPrefix(lens.prefix, env)) if (p && typeof p.body === 'string') pages.push({ path: p.path, body: p.body }); }
    catch { /* optional; never block the harvest */ }
  }
  let out = '';
  for (const p of pages) {
    const block = `--- FILE: ${p.path} ---\n${p.body}\n`;
    if (out.length + block.length > cap) { out += block.slice(0, Math.max(0, cap - out.length)); break; }
    out += block + '\n';
  }
  return { text: out, files: pages.map(p => p.path) };
}

// ---- the page ----
function frontmatter({ date, source, title, duration, lens }) {
  const esc = (v) => String(v == null ? '' : v).replace(/\n/g, ' ').replace(/"/g, '\\"');
  return ['---', `date: ${date}`, `source: ${esc(source)}`, `title: "${esc(title)}"`, `duration: ${esc(duration || '')}`, `lens: ${lens}`, '---'].join('\n');
}
const bulletList = (arr) => (Array.isArray(arr) && arr.length) ? arr.map(x => `- ${String(x).replace(/\n+/g, ' ').trim()}`).join('\n') : '';
const sectionIf = (title, body) => (body && String(body).trim()) ? `## ${title}\n\n${String(body).trim()}` : null;
const sectionList = (title, arr) => { const b = bulletList(arr); return b ? `## ${title}\n\n${b}` : null; };

function openItemsBlock(actionItems, dominantProject) {
  if (!Array.isArray(actionItems) || !actionItems.length) return `## Open Items → ${dominantProject || 'Unrouted'}\n\n_No action items extracted._`;
  const header = dominantProject ? `## Open Items → ${dominantProject}` : '## Open Items';
  const lines = actionItems.map(it => `- [ ] ${it.tag ? `[${it.tag}] ` : ''}${String(it.text || '').trim()}${it.project_slug && it.project_slug !== dominantProject ? ` → ${it.project_slug}` : ''}`);
  return `${header}\n\n${lines.join('\n')}`;
}

function visualTimelineTable(beats) {
  if (!Array.isArray(beats) || !beats.length) return '';
  const cell = (v) => String(v == null ? '' : v).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim() || '—';
  const rows = beats.map(b => (b && typeof b === 'object')
    ? `| ${b.end ? `${cell(b.t)}–${cell(b.end)}` : cell(b.t)} | ${cell(b.shot)} | ${cell(b.motion)} | ${cell(b.text_on_screen)} | ${cell(b.transition)} |`
    : `| ${cell(b)} | — | — | — | — |`);
  return ['| t | Shot / framing | What moves, how | Text on screen | Transition out |', '| --- | --- | --- | --- | --- |', ...rows].join('\n');
}

// The rich capture is always written, so the library keeps more than a summary.
function richCaptureBlocks(ex) {
  const chapters = Array.isArray(ex.chapters) && ex.chapters.length
    ? ex.chapters.map(c => (c && typeof c === 'object') ? `- ${(c.t || c.time) ? `**${c.t || c.time}** ` : ''}${c.title || c.name || ''}`.trim() : `- ${String(c)}`).join('\n') : '';
  const timeline = visualTimelineTable(ex.visual_timeline);
  return [
    timeline ? `## Visual timeline\n\n${timeline}` : null,
    sectionList('Lessons', ex.lessons), sectionList('Tutorials & How-tos', ex.tutorials), sectionList('Tips', ex.tips),
    sectionList('Messages to keep', ex.messages), sectionList('Visual notes', ex.visual_notes), sectionList('Quotes', ex.quotes),
    sectionList('Claims (check later)', ex.claims), sectionList('Stories', ex.stories), sectionList('Numbers & figures', ex.numbers),
    sectionList('Tools & names', ex.tools_and_names), sectionList('Practices', ex.practices), sectionList('Skills', ex.skills),
    chapters ? `## Chapters\n\n${chapters}` : null,
  ].filter(Boolean);
}

function buildSynthPage({ date, url, lensLabel, synth, dominantProject, ex, autoMeta }) {
  const rawPoints = bulletList(synth.raw_points) || bulletList(ex && ex.talking_points) || '_No raw points captured._';
  const autoLine = autoMeta
    ? `> **Auto-routed** → ${lensLabel} (${Math.round((autoMeta.confidence || 0) * 100)}%): ${autoMeta.reason || ''}${autoMeta.secondary?.length ? ` · also considered: ${autoMeta.secondary.join(', ')}` : ''}\n` : '';
  return [
    frontmatter({ date, source: url, title: synth.title, duration: synth.duration, lens: lensLabel }), '', autoLine,
    `## TL;DR\n\n${(synth.tl_dr || '').trim() || '_n/a_'}`, '',
    `## Through the ${lensLabel} Lens\n\n${(synth.lens_synthesis || '').trim() || '_n/a_'}`, '',
    openItemsBlock(synth.action_items, dominantProject), '',
    ...richCaptureBlocks(ex || {}), '',
    `## Raw talking points\n\n${rawPoints}`, '',
    ex && ex.full_notes ? sectionIf('Full notes', ex.full_notes) : null, '',
  ].filter(x => x !== null).join('\n');
}

function buildRawPage({ date, url, ex }) {
  const tldr = (Array.isArray(ex.key_ideas) && ex.key_ideas.length) ? ex.key_ideas.slice(0, 3).join(' ') : (ex.full_notes ? String(ex.full_notes).slice(0, 400) : '_n/a_');
  const points = bulletList([].concat(ex.talking_points || [], ex.key_ideas || [], ex.practices || [], ex.skills || [])) || (ex.full_notes ? String(ex.full_notes) : '_No points captured._');
  return [
    frontmatter({ date, source: url, title: ex.title, duration: ex.duration, lens: 'Raw' }), '',
    `## TL;DR\n\n${tldr}`, '', ...richCaptureBlocks(ex), '', `## Raw talking points\n\n${points}`, '',
    ex.full_notes ? sectionIf('Full notes', ex.full_notes) : null, '',
  ].filter(x => x !== null).join('\n');
}

// ---- action items onto project pages ----
async function appendActionItems(actionItems, bySlug, env, { date, url, title }) {
  const byProject = new Map();
  for (const it of actionItems || []) {
    if (!it.project_slug || !bySlug.has(it.project_slug)) continue;
    if (!byProject.has(it.project_slug)) byProject.set(it.project_slug, []);
    byProject.get(it.project_slug).push(it);
  }
  const routed = [];
  const srcTitle = (title || 'source').replace(/[[\]]/g, '');
  for (const [slug, items] of byProject) {
    const block = `${items.map(it => `- [ ] ${it.tag ? `[${it.tag}] ` : ''}${String(it.text || '').trim()}`).join('\n')}\n\n_harvested ${date} from [${srcTitle}](${url})_`;
    try { await appendToPage(bySlug.get(slug).pagePath, HARVEST_SECTION, block, env); routed.push(slug); }
    catch { routed.push(`${slug}(write-failed)`); }
  }
  return routed;
}

// ---- the ledger ----
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

const ledgerHeaders = (env) => ({ apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' });

// Already logged in the window? Fails OPEN: a duplicate card beats a dropped harvest.
export async function recentEventFor(env, page, windowMs = DEDUPE_WINDOW_MS) {
  try {
    const qs = new URLSearchParams({ select: 'id', page: `eq.${page}`, created_at: `gte.${new Date(Date.now() - windowMs).toISOString()}`, limit: '1' });
    const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/harvest_events?${qs}`, { headers: ledgerHeaders(env) });
    if (!resp.ok) return { found: false };
    const rows = await resp.json();
    return { found: Array.isArray(rows) && rows.length > 0 };
  } catch { return { found: false }; }
}

export async function logEvent(env, row) {
  try {
    const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/harvest_events`, { method: 'POST', headers: ledgerHeaders(env), body: JSON.stringify(row) });
    if (!resp.ok) { const t = (await resp.text()).slice(0, 200); console.log(`harvest_events insert ${resp.status}: ${t}`); return { ok: false, status: resp.status, error: t }; }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}

function shortError(msg) {
  const s = String(msg || '');
  if (/\b429\b|RESOURCE_EXHAUSTED/i.test(s)) return 'Rate limited or quota hit on a model API';
  if (/\b401\b|\b403\b|unauthorized|permission/i.test(s)) return 'API auth failed: check the worker secrets';
  if (/timeout|ETIMEDOUT|aborted/i.test(s)) return 'Upstream timed out: retry';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 140 ? one.slice(0, 137) + '…' : (one || 'Harvest failed');
}
const failTitle = (url, msg) => youtubeId(url) ? `Failed · ${youtubeId(url)} — ${shortError(msg)}` : `Failed harvest — ${shortError(msg)}`;

async function extractAny(env, url, pasted) {
  if (url && youtubeId(url)) return extractVideo(url, env);
  const web = url ? await loadWebText(url) : { title: '', text: '', channel: '' };
  const text = [web.text, pasted].filter(Boolean).join('\n\n').trim();
  if (!text) throw new Error('could not read the source as text');
  const g = await extractText({ title: web.title, url, text }, env);
  if (g.extraction && !g.extraction.title && web.title) g.extraction.title = web.title;
  if (g.extraction && !g.extraction.channel && web.channel) g.extraction.channel = web.channel;
  return g;
}

// ---- the run ----
export async function runHarvest(env, { urls, text: pastedText, lens: requestedLens, focus }) {
  const autoMode = isAutoLens(requestedLens);
  if (!autoMode && !isLens(requestedLens)) throw new Error(`unknown lens: ${requestedLens}`);
  const startedAt = new Date().toISOString();
  const date = today();

  const options = buildRoutingUniverse(await listProjectPages(env));
  const bySlug = new Map(options.map(o => [o.slug, o]));
  const methodologyCache = new Map();
  const methodologyFor = async (key) => {
    if (key === 'Raw' || key === 'Auto') return { text: '', files: [] };
    if (!methodologyCache.has(key)) methodologyCache.set(key, await loadLensMethodology(LENSES[key], env));
    return methodologyCache.get(key);
  };

  const items = [];
  const tally = { harvested: 0, needs_review: 0, error: 0 };
  const jobs = (urls && urls.length) ? urls.map(url => ({ url, pasted: pastedText || '' })) : [{ url: '', pasted: pastedText || '' }];

  for (const job of jobs) {
    const url = job.url || '(pasted text)';
    const item = { url, status: null, title: null, channel: null, duration: null, lens: autoMode ? 'Auto' : requestedLens, lens_auto: autoMode, lens_reason: null, routed_projects: [], page: null, tl_dr: null, action_items: [], reasoning: null, error: null, model: null };
    const fail = async (stage, err, extra = {}) => {
      item.status = 'error'; item.error = (`${stage}: ` + (err.message || String(err))).slice(0, 1000);
      if (!item.title) item.title = failTitle(url, item.error);
      await logEvent(env, { source_url: url, title: item.title, lens: item.lens, status: 'error', error: item.error, summary: shortError(item.error), ...extra });
      items.push(item); tally.error++;
    };

    // 1. Extract
    let extraction;
    try { const g = await extractAny(env, job.url, job.pasted); extraction = g.extraction; item.model = g.model; }
    catch (err) { await fail('Extraction failed', err); continue; }

    // 2. Lens
    let lensKey = requestedLens, autoMeta = null;
    if (autoMode) {
      try { autoMeta = await classifyLens({ extraction, projectOptions: options, focus }, env); lensKey = autoMeta.lens; }
      catch (err) { lensKey = 'Raw'; autoMeta = { lens: 'Raw', confidence: 0.2, secondary: [], reason: `Auto-classify failed (${err.message || err}); wrote the raw extraction.` }; }
      item.lens = lensKey; item.lens_reason = autoMeta.reason;
    }
    const lens = LENSES[lensKey];
    if (!lens || lensKey === 'Auto') { await fail('Lens', new Error(`resolved lens invalid: ${lensKey}`)); continue; }

    // 3. Synthesize (Raw skips)
    let pageBody, routedSlugs = [], dominantProject = null;
    try {
      if (lensKey === 'Raw') {
        item.title = extraction.title || 'Untitled'; item.channel = extraction.channel || null; item.duration = extraction.duration || null;
        pageBody = buildRawPage({ date, url, ex: extraction });
      } else {
        const methodology = await methodologyFor(lensKey);
        const synth = await synthesize({ lens, methodologyText: methodology.text, extraction, focus, projectOptions: options }, env);
        item.title = synth.title || extraction.title || 'Untitled'; item.channel = synth.channel || extraction.channel || null;
        item.duration = synth.duration || extraction.duration || null; item.tl_dr = synth.tl_dr || null;
        item.action_items = Array.isArray(synth.action_items) ? synth.action_items : [];
        const counts = new Map();
        for (const a of item.action_items) if (a.project_slug && bySlug.has(a.project_slug)) counts.set(a.project_slug, (counts.get(a.project_slug) || 0) + 1);
        dominantProject = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        routedSlugs = [...counts.keys()];
        pageBody = buildSynthPage({ date, url, lensLabel: lens.label, synth, dominantProject, ex: extraction, autoMeta });
      }
    } catch (err) { await fail('Synthesis failed', err); continue; }

    // 4. Write the page
    const fileSlug = slugify(item.title);
    const pagePath = lens.folder ? `raw/harvested/${lens.folder}/${date}-${fileSlug}.md` : `raw/harvested/${date}-${fileSlug}.md`;
    try { item.page = (await writePage(pagePath, pageBody, env)).path; }
    catch (err) { await fail('Library write failed', err, { routed_projects: routedSlugs.join(', ') || null }); continue; }

    // 5. Action items onto project pages
    const routedWritten = item.action_items.length ? await appendActionItems(item.action_items, bySlug, env, { date, url, title: item.title }) : [];
    item.routed_projects = routedWritten;
    const namedButUnknown = item.action_items.some(a => a.project_slug && !bySlug.has(a.project_slug));
    const status = (lensKey !== 'Raw' && item.action_items.length === 0) || namedButUnknown ? 'needs_review' : 'harvested';
    item.status = status;
    const autoNote = autoMode ? ` Auto→${lens.label}${item.lens_reason ? ` (${item.lens_reason})` : ''}.` : '';
    item.reasoning = lensKey === 'Raw'
      ? 'Raw lens: rich capture, no synthesis or routing.' + autoNote
      : status === 'needs_review'
        ? (namedButUnknown ? 'Some action items named a project not in the library; left for review.' : 'No action items were extracted; left for review.') + autoNote
        : `Synthesized through the ${lens.label} lens; ${routedWritten.length} project page(s) updated.` + autoNote;

    // 6. Ledger
    await logEvent(env, {
      source_url: url, title: item.title, channel: item.channel, duration: item.duration, lens: lensKey,
      routed_projects: routedWritten.join(', ') || null, page: item.page,
      summary: item.tl_dr ? item.tl_dr.slice(0, 600) : (item.title || null), reasoning: item.reasoning, status,
    });
    items.push(item);
    if (status === 'harvested') tally.harvested++; else tally.needs_review++;
  }

  return { harvested: tally.harvested, needs_review: tally.needs_review, errors: tally.error, lens: autoMode ? 'Auto' : requestedLens, auto: autoMode, items, scanned: jobs.length, startedAt, finishedAt: new Date().toISOString() };
}
