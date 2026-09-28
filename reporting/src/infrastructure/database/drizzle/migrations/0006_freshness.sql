-- Report freshness (Phase 70): the relay role reads how far each source is sealed, per
-- tenant, to expose the oldest watermark per source. Still no event, seal or figure.
GRANT SELECT ("source_module", "through") ON source_watermarks TO horizon_relay;
