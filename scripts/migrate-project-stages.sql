-- Migration: Remap old project stages to new lifecycle stages
-- Run this after deploying the schema changes
--
-- Old stages: lead, proposal_sent, active, completed
-- New stages: getting_started, proposal, agreement, onboarding, active, ongoing, offboarding, completed
--
-- Mapping:
--   lead          → getting_started
--   proposal_sent → proposal
--   active        → active (no change)
--   completed     → completed (no change)

UPDATE projects SET stage = 'getting_started' WHERE stage = 'lead';
UPDATE projects SET stage = 'proposal' WHERE stage = 'proposal_sent';

-- Set null stages to the new default
UPDATE projects SET stage = 'getting_started' WHERE stage IS NULL;
