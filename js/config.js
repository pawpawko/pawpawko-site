// ============================================
// Pawpaw Ko — Trades feature config
// ============================================
// Fill these in from Supabase: Project Settings -> API
// The anon key is safe to expose; access is gated by Row Level Security.

window.PAWPAWKO_CONFIG = {
  SUPABASE_URL: 'https://cligjmfhxvazjarbvexp.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_MbXa-DQ33D9VSMHhHho0Xg_kZ65QHtt'
};

// NYC five boroughs — used by filter dropdowns and profile editor
window.NYC_BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'The Bronx', 'Staten Island'];

// Major NYC subway transfer / high-traffic stations — used for meet-up filter
window.NYC_MAJOR_SUBWAY_STOPS = [
  // Manhattan
  'Times Sq-42 St', 'Grand Central-42 St', '34 St-Penn Station', '34 St-Herald Sq',
  'Union Sq-14 St', '14 St-8 Av', 'Columbus Circle-59 St',
  '86 St (Lex)', '96 St (Lex)', '125 St', 'Fulton St', 'Canal St',
  'Chambers St', 'World Trade Center',
  // Brooklyn
  'Atlantic Av-Barclays Ctr', 'Jay St-MetroTech', 'DeKalb Av', 'Bedford Av',
  'Borough Hall', 'Prospect Park', 'Coney Island-Stillwell Av',
  'Flatbush Av-Brooklyn College', 'Hoyt-Schermerhorn',
  // Queens
  'Court Sq-23 St', 'Queensboro Plaza', 'Jackson Hts-Roosevelt Av',
  'Forest Hills-71 Av', 'Flushing-Main St', 'Jamaica Ctr-Parsons/Archer',
  'Astoria-Ditmars Blvd',
  // Bronx
  '149 St-Grand Concourse', 'Yankee Stadium-161 St', 'Fordham Rd', 'Pelham Bay Park',
  // Staten Island
  'St George'
];

// Listing types
window.LISTING_TYPES = [
  { value: 'trade', label: 'Trade Only' },
  { value: 'sell',  label: 'Sell Only' },
  { value: 'free',  label: 'Free' },
  { value: 'combo', label: 'Trade or Sell' }
];
