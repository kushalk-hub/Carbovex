-- =============================================================================
-- CarbonX :: 07_seed_reference.sql
--
-- Reference data only: countries, states, cities (with real coordinates), sectors,
-- fuels, emission sources, registries, project types and compliance periods.
--
-- The city coordinates matter: GET /api/facilities omits anything without a
-- latitude, so an ungeocoded dataset produces a completely empty globe.
-- =============================================================================

INSERT INTO country(name, iso_code) VALUES ('India', 'IN');

INSERT INTO state(country_id, name)
SELECT country_id, n FROM country, unnest(ARRAY[
  'Gujarat','Maharashtra','Karnataka','Tamil Nadu','Madhya Pradesh','Rajasthan',
  'Uttar Pradesh','West Bengal','Odisha','Chhattisgarh','Jharkhand','Kerala',
  'Telangana','Andhra Pradesh','Punjab','Haryana','Uttarakhand','Himachal Pradesh',
  'Assam','Bihar'
]) AS n;

INSERT INTO city(state_id, name, latitude, longitude)
SELECT s.state_id, c.name, c.lat, c.lng
FROM (VALUES
  -- state,               city,                lat,        lng
  ('Gujarat',            'Ahmedabad',          23.022500,  72.571400),
  ('Gujarat',            'Vadodara',            22.307200,  73.181200),
  ('Gujarat',            'Surat',               21.170200,  72.831100),
  ('Gujarat',            'Gandhidham',          23.075600,  70.636100),
  ('Gujarat',            'Jamnagar',            22.470700,  70.057700),
  ('Maharashtra',        'Mumbai',              19.076000,  72.877700),
  ('Maharashtra',        'Pune',                18.520400,  73.856700),
  ('Maharashtra',        'Nashik',              19.997500,  73.789800),
  ('Maharashtra',        'Nagpur',              21.145800,  79.088200),
  ('Maharashtra',        'Solapur',             17.659900,  75.906400),
  ('Maharashtra',        'Ratnagiri',           16.990200,  73.312000),
  ('Karnataka',          'Bengaluru',           12.971600,  77.594600),
  ('Karnataka',          'Mangaluru',           12.914100,  74.856000),
  ('Karnataka',          'Davanagere',          14.464400,  75.921800),
  ('Karnataka',          'Ballari',             15.139400,  76.921400),
  ('Tamil Nadu',         'Chennai',             13.082700,  80.270700),
  ('Tamil Nadu',         'Tuticorin',            8.764200,  78.134800),
  ('Tamil Nadu',         'Kovilpatti',           9.226800,  77.965200),
  ('Tamil Nadu',         'Salem',              11.664300,  78.146000),
  ('Madhya Pradesh',     'Bhopal',              23.259900,  77.412600),
  ('Madhya Pradesh',     'Singrauli',           24.199400,  82.675400),
  ('Madhya Pradesh',     'Satna',               24.585400,  80.832400),
  ('Rajasthan',          'Jaipur',              26.912400,  75.787300),
  ('Rajasthan',          'Jodhpur',             26.238900,  73.024300),
  ('Rajasthan',          'Kota',                25.213800,  75.864800),
  ('Uttar Pradesh',      'Kanpur',              26.449900,  80.331900),
  ('Uttar Pradesh',      'Lucknow',             26.846700,  80.946200),
  ('West Bengal',        'Kolkata',             22.572600,  88.363900),
  ('West Bengal',        'Haldia',              22.066700,  88.069800),
  ('Odisha',             'Paradip',             20.264800,  86.694700),
  ('Odisha',             'Rourkela',            22.260400,  84.853600),
  ('Chhattisgarh',       'Raipur',              21.251400,  81.629600),
  ('Chhattisgarh',       'Korba',               22.359500,  82.750100),
  ('Jharkhand',          'Jamshedpur',          22.804600,  86.202900),
  ('Jharkhand',          'Dhanbad',             23.795700,  86.430400),
  ('Kerala',             'Kochi',                9.931200,  76.267300),
  ('Kerala',             'Kannur',              11.874500,  75.370400),
  ('Telangana',          'Hyderabad',           17.385000,  78.486700),
  ('Telangana',          'Ramagundam',          18.755800,  79.474000),
  ('Andhra Pradesh',     'Visakhapatnam',       17.686800,  83.218500),
  ('Punjab',             'Ludhiana',            30.901000,  75.857300),
  ('Haryana',            'Panipat',             29.390900,  76.963500),
  ('Uttarakhand',        'Haridwar',            29.945700,  78.164200),
  ('Himachal Pradesh',   'Parwanoo',            31.136100,  76.571400),
  ('Assam',              'Dibrugarh',           27.472800,  94.992000),
  ('Bihar',              'Patna',               25.594100,  85.137600)
) AS c(state_name, name, lat, lng)
JOIN state s ON s.name = c.state_name;

INSERT INTO sector(name, description) VALUES
  ('Power',        'Coal, gas and nuclear generation'),
  ('Cement',       'Clinker and cement production'),
  ('Steel',        'Integrated steel plants'),
  ('Aluminium',    'Smelters and alumina refineries'),
  ('Fertiliser',   'Ammonia and urea'),
  ('Petrochemicals','Olefins and aromatics'),
  ('Pulp & Paper', 'Integrated pulp mills'),
  ('Textile',      'Spinning and processing'),
  ('Chlor-Alkali', 'Chlorine and caustic soda'),
  ('Refinery',     'Oil refining');

INSERT INTO facility_type(name) VALUES
  ('Coal plant'),('Gas plant'),('Cement kiln'),('Steel plant'),('Aluminium smelter'),
  ('Fertiliser plant'),('Petrochemical unit'),('Pulp mill'),('Spinning mill'),
  ('Chlor-alkali plant'),('Refinery');

INSERT INTO fuel_type(name, unit, emission_factor) VALUES
  ('Coal',        'tonne', 2.42),      -- tCO2 per tonne of coal
  ('Natural gas', 'm3',    0.00202),
  ('Diesel',      'kL',    2.68),
  ('Fuel oil',    'kL',    3.15),
  ('Pet coke',    'tonne', 3.30),
  ('Limestone',   'tonne', 0.44),
  ('Grid power',  'MWh',   0.71);

INSERT INTO emission_source(scope, name) VALUES
  (1, 'Stationary combustion'),
  (1, 'Process emissions'),
  (1, 'Fugitive emissions'),
  (2, 'Purchased electricity'),
  (3, 'Transport');

INSERT INTO registry(name) VALUES ('Verra'), ('Gold Standard'), ('India CCTS');

INSERT INTO project_type(name) VALUES
  ('Solar'), ('Wind'), ('Reforestation'), ('Biogas'), ('Cookstoves'), ('Afforestation');

INSERT INTO compliance_period(year, start_date, end_date, deadline) VALUES
  (2024, '2024-01-01', '2024-12-31', '2025-03-31'),
  (2025, '2025-01-01', '2025-12-31', '2026-03-31'),
  (2026, '2026-01-01', '2026-12-31', '2027-03-31'),
  (2027, '2027-01-01', '2027-12-31', '2028-03-31');

INSERT INTO verifier(name, accreditation_no) VALUES
  ('Bureau Veritas India',        'BV-IN-2019-001'),
  ('TUV SUD Bharat',              'TUV-IN-2020-114'),
  ('SGS India Emissions',         'SGS-IN-2018-077'),
  ('Intertek Testing Services',   'ITS-IN-2021-203'),
  -- Not a real accreditation body. verification.verifier_id is NOT NULL and
  -- points here, so an ADMIN (who is not tied to an accredited verifier) needs
  -- somewhere honest to attribute a decision to. The API falls back to this row
  -- only when the acting account has no verifier_id of its own, and the audit
  -- log still records the real acting user separately.
  ('CarbonX Internal Review',     'CX-INTERNAL-0001');

-- Accreditation bodies are the only "user-side" reference data needed here;
-- app_user rows are created by scripts/seed.js because they need bcrypt hashes.
