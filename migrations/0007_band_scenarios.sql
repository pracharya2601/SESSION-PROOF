-- Dev only: which synthetic scenario script a simulated band visit plays (NULL = default script).
ALTER TABLE band_visits ADD COLUMN scenario TEXT;
