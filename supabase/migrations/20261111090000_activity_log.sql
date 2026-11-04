-- Settings › Activity log reads the audit trail newest first, 50 at a time, per organisation.
create index if not exists audit_events_org_id_idx on public.audit_events (organisation_id, id desc);
