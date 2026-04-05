-- Add new scoring dimensions for smarter auto-routing
INSERT OR IGNORE INTO router_dimensions VALUES ('tool_call_presence', 'Tool Call Presence', 1.4, 1, datetime('now'));
INSERT OR IGNORE INTO router_dimensions VALUES ('conversation_momentum', 'Conversation Momentum', 1.5, 1, datetime('now'));
