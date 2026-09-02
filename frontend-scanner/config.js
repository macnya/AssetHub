// Expo inlines any EXPO_PUBLIC_* variable at BUILD time, so this is baked into
// the APK when it is built — changing it later needs a new build, not a restart.
//
// For local development against a laptop, create a .env file in this folder:
//   EXPO_PUBLIC_API_URL=http://192.168.1.42:5000
// Use the machine's LAN IP, not localhost — the phone can't reach that.
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL || 'https://assethub-api-d8by.onrender.com';
