-- model_versions: the rest of the test-split metrics shown on the model page.
-- Values come from models/*/*-test-metrics.json through web/models-data.js (see scripts/build-model-data.js).
-- NULL = not in the metrics file (the page shows "-").
ALTER TABLE model_versions ADD COLUMN map50      REAL;
ALTER TABLE model_versions ADD COLUMN precision  REAL;
ALTER TABLE model_versions ADD COLUMN recall     REAL;
ALTER TABLE model_versions ADD COLUMN per_class  TEXT;   -- JSON [{name, ap50_95, ap50, precision, recall, instances}]
