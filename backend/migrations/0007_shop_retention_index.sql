-- Global 90-day sweep for member account service events.
-- Other target timestamp columns already have suitable indexes.
CREATE INDEX IF NOT EXISTS idx_member_events_created_at
  ON member_events(created_at);
