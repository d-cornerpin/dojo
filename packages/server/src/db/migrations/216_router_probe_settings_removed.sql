-- 216: the router probe is removed; its four settings are deleted. A box with none of them changes nothing.
DELETE FROM config WHERE key IN ('router_probe_enabled', 'router_probe_budget', 'router_probe_sample', 'router_probe_adequate');
