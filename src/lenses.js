// lenses.js — the strategic core. A lens is a synthesis FRAME plus the rulebook
// pages loaded into the model's context at call time, not just a label. The
// pages are read live from your library on every harvest, so editing a rulebook
// tunes its lens with no redeploy.
//
// Edit this file to define your own worlds. Each lens:
//   label        shown on pages and in the ledger
//   description  one line the Auto classifier uses to pick this lens
//   methodology  library paths whose bodies are handed to the synthesizer
//   prefix       optional: every page under this prefix is loaded too
//   frame        the instruction: how to read a source through this lens
//   folder       optional: pages land in raw/harvested/<folder>/ instead of raw/harvested/
//   explicitOnly optional: Auto never picks it; you choose it on purpose
//
// Two lenses are special and should stay: Auto (the classifier picks) and Raw
// (no synthesis: the extraction is written as-is).

export const LENSES = {
  Auto: { label: 'Auto', auto: true, methodology: [], frame: null },

  Work: {
    label: 'Work',
    description: 'Your business or job: strategy, product, marketing, operations, the craft you are paid for.',
    methodology: ['wiki/methodology/work-rules.md'],
    frame:
      'Apply this source to the owner\'s work. Use the vocabulary and rules in the methodology. ' +
      'Action items should be concrete: a thing to build, test, write, or change, tagged by sub-type ' +
      '(Product / Marketing / Research / Process / Content).',
  },

  Personal: {
    label: 'Personal',
    description: 'The owner personally: habits, health, learning, home, money, relationships, life design.',
    methodology: ['wiki/identity.md'],
    frame:
      'Apply this source to the owner personally: habits, systems, health, learning, home. ' +
      'Action items should be concrete personal experiments or system changes.',
  },

  Visuals: {
    label: 'Visuals',
    description: 'Never auto-picked. Read a video as choreography and produce a timed shot list a build session can rebuild.',
    methodology: ['wiki/methodology/visuals-rules.md'],
    folder: 'visuals',
    explicitOnly: true,
    frame:
      'Read this video as CHOREOGRAPHY, not content. Produce a timed shot list a build session can rebuild ' +
      'in code without watching the video. lens_synthesis must open with at most one line of context about ' +
      'what the video is, then a markdown beats table with the columns ' +
      '`t (start–end) | Shot / framing | What moves, how | Text on screen + how it enters | Transition out`, ' +
      'one row per beat, every row timed (estimate and mark `~` when the source has no exact timestamps), ' +
      'repeated beats included because repetition is a rhythm fact. Name moves and easings plainly ' +
      '(enter/exit, hold, type, camera, particle, cut; linear, ease-out, spring, bounce, snap, elastic). ' +
      'After the table add short sections: **Rhythm** (shots per 10s, where it accelerates, longest hold, fastest burst), ' +
      '**Music sync**, **Palette & type** (3-5 hex-ish colours, light/dark ground, display vs body families), ' +
      '**Device & framing**, and **Best three moves** (beat number, why it works, a one-word rebuild cost: ' +
      'DOM+CSS / needs-3D / needs-video-frames). Never summarize the pitch or the voiceover beyond that one ' +
      'context line. Action items are BUILD TASKS only, tagged Build. Take choreography only; never recommend ' +
      'copying footage, logos, music, or assets.',
  },

  Raw: { label: 'Raw', methodology: [], frame: null },
};

export const isLens = (key) => Object.prototype.hasOwnProperty.call(LENSES, key);
export const isAutoLens = (key) => key === 'Auto' || key === 'auto' || key == null || key === '';
export const lensList = () => Object.keys(LENSES);
// Lenses the Auto classifier may return: no Auto itself, nothing explicit-only.
export const autoLensList = () => Object.keys(LENSES).filter(k => k !== 'Auto' && !LENSES[k].explicitOnly);

// Accept a lens key case-insensitively; null when unknown.
export function normalizeLens(raw) {
  if (isAutoLens(raw)) return 'Auto';
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (isLens(t)) return t;
  return Object.keys(LENSES).find(k => k.toLowerCase() === t.toLowerCase()) || null;
}
