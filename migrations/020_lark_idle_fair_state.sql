-- First-service opportunities are separate from business progress and due dates.
-- One source row prevents a changed account/file from silently resetting age.
CREATE TABLE lark_im_idle_fair_state (
  source_id TEXT PRIMARY KEY CHECK(source_id='lark.im'),
  account_key TEXT NOT NULL CHECK(length(account_key)=64 AND account_key NOT GLOB '*[^a-f0-9]*'),
  database_key TEXT NOT NULL CHECK(length(database_key)=64 AND database_key NOT GLOB '*[^a-f0-9]*'),
  generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991),
  sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 0 AND 9007199254740991),
  sample_last_served INTEGER NOT NULL CHECK(typeof(sample_last_served)='integer' AND sample_last_served BETWEEN 0 AND sequence),
  history_last_served INTEGER NOT NULL CHECK(typeof(history_last_served)='integer' AND history_last_served BETWEEN 0 AND sequence),
  resources_last_served INTEGER NOT NULL CHECK(typeof(resources_last_served)='integer' AND resources_last_served BETWEEN 0 AND sequence)
);
