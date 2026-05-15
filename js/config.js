// ============================================
// Pawpaw Ko — Trades feature config
// ============================================
// Fill these in from Supabase: Project Settings -> API
// The anon key is safe to expose; access is gated by Row Level Security.

window.PAWPAWKO_CONFIG = {
  SUPABASE_URL: 'https://cligjmfhxvazjarbvexp.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_MbXa-DQ33D9VSMHhHho0Xg_kZ65QHtt'
};

// ---------- Cities served ----------
// `value` is the canonical id stored in profiles.city.
window.CITIES = [
  { value: 'nyc',     label: 'New York City' },
  { value: 'la',      label: 'Los Angeles' },
  { value: 'sf',      label: 'San Francisco' },
  { value: 'houston', label: 'Houston' },
  { value: 'dallas',  label: 'Dallas' }
];

// ---------- Boroughs / neighborhoods, keyed by city.value ----------
// NYC uses its real five boroughs. Other cities use "major neighborhoods /
// districts" as the rough equivalent — refine per-city as we actually launch
// each market. Subway-stop data is NYC-only; the trades UI shows "N/A" for
// subway when a non-NYC city is selected.
window.BOROUGHS_BY_CITY = {
  'nyc': ['Manhattan', 'Brooklyn', 'Queens', 'The Bronx', 'Staten Island'],
  'la': [
    'Downtown', 'Hollywood', 'Santa Monica', 'Venice', 'Pasadena',
    'Long Beach', 'Koreatown', 'Silver Lake'
  ],
  'sf': [
    'Downtown / Union Square', 'SoMa', 'Mission', 'Castro',
    'North Beach', 'Marina', 'Sunset', 'Richmond'
  ],
  'houston': [
    'Downtown', 'Midtown', 'Montrose', 'The Heights',
    'Galleria', 'Rice Village', 'Museum District'
  ],
  'dallas': [
    'Downtown', 'Uptown', 'Deep Ellum', 'Bishop Arts',
    'Knox-Henderson', 'Lakewood', 'Oak Lawn'
  ]
};

// ---------- Backward-compat for account.js profile editor ----------
// (Profile editor currently only supports NYC; expand later.)
window.NYC_BOROUGHS = window.BOROUGHS_BY_CITY['nyc'];

// Major NYC subway transfer / high-traffic stations, grouped by borough.
// Drives the borough → subway cascade on the trades search page (NYC only).
window.NYC_MAJOR_SUBWAY_STOPS_BY_BOROUGH = {
  'Manhattan': [
    'Times Sq-42 St', 'Grand Central-42 St', '34 St-Penn Station', '34 St-Herald Sq',
    'Union Sq-14 St', '14 St-8 Av', 'Columbus Circle-59 St',
    '86 St (Lex)', '96 St (Lex)', '125 St', 'Fulton St', 'Canal St',
    'Chambers St', 'World Trade Center'
  ],
  'Brooklyn': [
    'Atlantic Av-Barclays Ctr', 'Jay St-MetroTech', 'DeKalb Av', 'Bedford Av',
    'Borough Hall', 'Prospect Park', 'Coney Island-Stillwell Av',
    'Flatbush Av-Brooklyn College', 'Hoyt-Schermerhorn'
  ],
  'Queens': [
    'Court Sq-23 St', 'Queensboro Plaza', 'Jackson Hts-Roosevelt Av',
    'Forest Hills-71 Av', 'Flushing-Main St', 'Jamaica Ctr-Parsons/Archer',
    'Astoria-Ditmars Blvd'
  ],
  'The Bronx': [
    '149 St-Grand Concourse', 'Yankee Stadium-161 St', 'Fordham Rd', 'Pelham Bay Park'
  ],
  'Staten Island': [
    'St George'
  ]
};

// Flat list — backward-compat for places that don't care about borough
// grouping (profile editor, etc.)
window.NYC_MAJOR_SUBWAY_STOPS = Object.values(window.NYC_MAJOR_SUBWAY_STOPS_BY_BOROUGH).flat();

// ---------- Binder categories ----------
window.BINDER_CATEGORIES = [
  { value: 'optcg',   label: 'OPTCG' },
  { value: 'pokemon', label: 'Pokémon' }
];

// ---------- Listing types ----------
window.LISTING_TYPES = [
  { value: 'trade', label: 'Trade Only' },
  { value: 'sell',  label: 'Sell Only' },
  { value: 'free',  label: 'Free' },
  { value: 'combo', label: 'Trade or Sell' }
];
