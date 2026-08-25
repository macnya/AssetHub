import { Platform } from 'react-native';

// Palette tuned for a phone held outdoors. Ink is cooler than pure black so it
// sits calmly next to the brand teal, and surfaces stay near-white because
// grey-on-grey disappears in bright sunlight.
export const c = {
  ink: '#14181F',
  inkSoft: '#5A6472',
  inkFaint: '#98A1AE',
  paper: '#FFFFFF',
  surface: '#F7F8FA',
  rule: '#E4E7EC',

  // Named for their role, not their hue. These were `orange` and `navy`
  // when the product belonged to one organisation; the values change again
  // when a tenant sets its own primary colour.
  brand: '#0D7C74',       // used sparingly, never as a fill for large areas
  deep: '#0A3D4A',

  good: '#16794C',
  issues: '#B26A00',
  faulty: '#C0392B',
  unknown: '#8A94A2',
};

// The register's own vernacular: asset codes are typed, printed and scanned,
// so they're set in mono wherever they appear.
export const mono = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

export const conditionColor = (condition) => {
  if (condition === 'Good') return c.good;
  if (condition === 'Good with issues') return c.issues;
  if (condition === 'Faulty') return c.faulty;
  return c.unknown;
};

export const EVENT_COLORS = {
  'Transfer': '#2563EB',
  'Check-In': c.good,
  'Verification': c.brand,
  'Disposed': c.faulty,
  'Lost': c.issues,
  'Import': c.inkFaint,
};