-- Harvester ledger. Run in the SAME Postgres as your Second Brain library
-- (github.com/lennymadethat/second-brain, migrations 0001-0004 first).
-- One row per source harvested: success, needs_review, or error. Errors are
-- logged too; the feed is an accountability surface, not a success-only log.

CREATE TABLE IF NOT EXISTS public.harvest_events (
    id              BIGSERIAL PRIMARY KEY,
    source_url      TEXT,
    title           TEXT        NOT NULL,
    channel         TEXT,
    duration        TEXT,
    lens            TEXT        NOT NULL,
    routed_projects TEXT,          -- comma-separated project slugs whose pages were updated
    page            TEXT,          -- the harvested page path in the library
    summary         TEXT,
    reasoning       TEXT,
    status          TEXT        NOT NULL DEFAULT 'harvested',   -- harvested | needs_review | error
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS harvest_events_created_at_idx ON public.harvest_events (created_at DESC);
CREATE INDEX IF NOT EXISTS harvest_events_page_idx ON public.harvest_events (page);

GRANT ALL ON public.harvest_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.harvest_events_id_seq TO service_role;
