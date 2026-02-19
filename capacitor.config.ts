import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.botschat.console",
  appName: "BotsChat",
  webDir: "packages/web/dist",

  // Allow the WebView to connect to the production API
  server: {
    // In production, the app loads from local files (capacitor://)
    // and makes API calls to the production server.
    // During development, you can override with a local URL:
    // url: "http://192.168.3.232:8787",
    androidScheme: "https",
    iosScheme: "https",
    // Allow mixed content & navigation to the API host
    allowNavigation: ["console.botschat.app", "*.botschat.app"],
  },

  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 1000,
      backgroundColor: "#1A1D21",
      showSpinner: false,
    },
    StatusBar: {
      style: "DEFAULT",
    },
    Keyboard: {
      resize: "none",
      resizeOnFullScreen: false,
    },
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },

  ios: {
    contentInset: "never",
    preferredContentMode: "mobile",
    // Allow WebView to load from capacitor:// scheme
    limitsNavigationsToAppBoundDomains: false,
  },
};

export default config;
