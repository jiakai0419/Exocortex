-- Route history by the current discovered chat without changing provenance.
-- ID order bounds both fixed-horizon selection and each subsequent row lookup.
CREATE INDEX records_history_container_id ON records(source_id,container_id,id);
