import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.kovault.app',
  appName: 'KoVault',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
};

export default config;
