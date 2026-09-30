-- ====================================================================
-- SIA licence / DBS Update Service — compliance tracking
-- ====================================================================
--
-- Not an integration with either service — there isn't one to build.
-- Confirmed via the SIA's own FOI response (24 Aug 2026, FOI 0622): no
-- public API exists for single or bulk licence checks, and none is coming
-- soon — not even for the paid third-party "SIA Verify"/"SIA Checker"
-- services, which the SIA confirmed have no special access either. The DBS
-- Update Service is, by design, a manual, consent-based, per-person web
-- check with no automation route (see the DBS employer guide) — DBS does
-- not proactively notify of status changes, so an employer must remember to
-- recheck periodically.
--
-- So these columns record what an admin found when they last actually
-- performed the check by hand, not a live status. The value CCCS adds is
-- turning "did anyone remember to recheck this" into a visible flag — see
-- personnelCompliance() in server.js — the same idea as an overdue vehicle
-- service or a missed patrol visit: a silent gap made visible, not an
-- automated verdict.
ALTER TABLE personnel ADD COLUMN sia_licence_no         TEXT;
ALTER TABLE personnel ADD COLUMN sia_licence_expiry     DATE;
ALTER TABLE personnel ADD COLUMN dbs_certificate_no     TEXT;
ALTER TABLE personnel ADD COLUMN dbs_certificate_type   TEXT;  -- STANDARD | ENHANCED
ALTER TABLE personnel ADD COLUMN dbs_update_service_id  TEXT;
-- When an admin last actually ran the DBS Update Service status check by
-- hand — set only via the dedicated "checked now" action, never implied by
-- editing the certificate/type fields above, since typing in a certificate
-- number is not the same act as performing the check.
ALTER TABLE personnel ADD COLUMN dbs_last_checked_at    TIMESTAMPTZ;
