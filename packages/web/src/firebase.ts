/**
 * Firebase client initialization for OAuth Sign-In (Google, GitHub).
 *
 * The Firebase config is loaded from Vite environment variables.
 * Create a `.env` file in packages/web/ with your Firebase config:
 *
 *   VITE_FIREBASE_API_KEY=AIzaSy...
 *   VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
 *   VITE_FIREBASE_PROJECT_ID=your-project-id
 *
 * For Capacitor iOS/Android, also set:
 *   VITE_GOOGLE_IOS_CLIENT_ID=xxx.apps.googleusercontent.com
 *   VITE_GOOGLE_WEB_CLIENT_ID=xxx.apps.googleusercontent.com
 */

import { Capacitor } from "@capacitor/core";
import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  GithubAuthProvider,
  OAuthProvider,
  signInWithPopup,
  signInWithCredential,
  indexedDBLocalPersistence,
  inMemoryPersistence,
  setPersistence,
  type Auth,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string,
};

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

/** Check if Firebase is configured (all required env vars present). */
export function isFirebaseConfigured(): boolean {
  return !!(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId);
}

/** Ensure the Firebase app is initialized (for FCM, independent of OAuth). */
export function ensureFirebaseApp(): FirebaseApp | null {
  if (app) return app;
  if (!isFirebaseConfigured()) return null;
  app = initializeApp(firebaseConfig);
  return app;
}

function getFirebaseAuth(): Auth {
  if (!auth) {
    if (!isFirebaseConfigured()) {
      throw new Error("Firebase is not configured. Set VITE_FIREBASE_* env vars.");
    }
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);

    // In Capacitor native, WKWebView's IndexedDB can hang Firebase Auth.
    // Use in-memory persistence to avoid this.
    if (Capacitor.isNativePlatform()) {
      setPersistence(auth, inMemoryPersistence).catch(() => {});
    }
  }
  return auth;
}

export type FirebaseSignInResult = {
  idToken: string;
  email: string;
  displayName: string | null;
  photoURL: string | null;
  provider: "google" | "github" | "apple";
};

// ---------------------------------------------------------------------------
// Native Google Sign-In via @capgo/capacitor-social-login
// ---------------------------------------------------------------------------

let _socialLoginInitialized = false;

/** Race a promise against a timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Initialize the native social login plugin (called once).
 * On web (non-Capacitor) this is a no-op.
 */
async function ensureNativeGoogleInit(): Promise<void> {
  if (!Capacitor.isNativePlatform() || _socialLoginInitialized) return;

  const { SocialLogin } = await import("@capgo/capacitor-social-login");

  const iosClientId = import.meta.env.VITE_GOOGLE_IOS_CLIENT_ID as string | undefined;
  const webClientId = import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID as string | undefined;
  const platform = Capacitor.getPlatform();

  console.log("[NativeGoogleSignIn] initialize: platform =", platform, "iOSClientId =", iosClientId?.substring(0, 20) + "...", "webClientId =", webClientId?.substring(0, 20) + "...");

  await withTimeout(
    SocialLogin.initialize({
      google: {
        webClientId: webClientId || undefined,
        iOSClientId: iosClientId || undefined,
        iOSServerClientId: webClientId || undefined,
      },
    }),
    10000,
    "SocialLogin.initialize",
  );

  _socialLoginInitialized = true;
  console.log("[NativeGoogleSignIn] initialized OK");
}

/**
 * Perform native Google Sign-In on iOS/Android, then exchange the Google
 * credential for a Firebase ID token via `signInWithCredential`.
 */
async function nativeGoogleSignIn(): Promise<FirebaseSignInResult> {
  console.log("[NativeGoogleSignIn] Step 1: ensureNativeGoogleInit");
  await ensureNativeGoogleInit();

  console.log("[NativeGoogleSignIn] Step 2: calling SocialLogin.login()");
  const { SocialLogin } = await import("@capgo/capacitor-social-login");

  // SocialLogin.login() opens native Google UI — user picks account.
  // No timeout here because user interaction takes variable time.
  const res = await SocialLogin.login({
    provider: "google",
    options: { scopes: ["email", "profile"] },
  });

  console.log("[NativeGoogleSignIn] Step 3: SocialLogin.login() returned, responseType =", res?.result?.responseType);

  const googleResult = res.result;

  // Narrow the union: online mode returns idToken + profile, offline returns serverAuthCode
  if (googleResult.responseType !== "online") {
    throw new Error(`Google Sign-In returned '${googleResult.responseType}' response; expected 'online'. Full result: ${JSON.stringify(res)}`);
  }

  const googleIdToken = googleResult.idToken;
  console.log("[NativeGoogleSignIn] Step 4: idToken present =", !!googleIdToken, ", length =", googleIdToken?.length ?? 0);

  if (!googleIdToken) {
    throw new Error("Google Sign-In did not return an idToken. Ensure Web Client ID (iOSServerClientId) is correct.");
  }

  // Send the Google ID token directly to the backend — backend now verifies
  // both Firebase ID tokens and native Google ID tokens.
  // (Firebase signInWithCredential hangs in WKWebView on real devices.)
  console.log("[NativeGoogleSignIn] Step 5: Skipping Firebase client, sending Google ID token directly to backend");

  return {
    idToken: googleIdToken,
    email: googleResult.profile.email ?? "",
    displayName: googleResult.profile.name ?? null,
    photoURL: googleResult.profile.imageUrl ?? null,
    provider: "google",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sign in with Google.
 * - Web: Firebase popup
 * - Native (iOS/Android): Native Google Sign-In → Firebase credential
 */
export async function signInWithGoogle(): Promise<FirebaseSignInResult> {
  // Native: use @capgo/capacitor-social-login + Firebase signInWithCredential
  if (Capacitor.isNativePlatform()) {
    return nativeGoogleSignIn();
  }

  // Web: use Firebase popup (works fine in browsers)
  const firebaseAuth = getFirebaseAuth();
  const provider = new GoogleAuthProvider();
  provider.addScope("email");
  provider.addScope("profile");

  const result = await signInWithPopup(firebaseAuth, provider);
  const idToken = await result.user.getIdToken();

  return {
    idToken,
    email: result.user.email ?? "",
    displayName: result.user.displayName,
    photoURL: result.user.photoURL,
    provider: "google",
  };
}

/**
 * Sign in with GitHub.
 * - Web: Firebase popup
 * - Native: Firebase popup (GitHub OAuth works in WKWebView with some config)
 *   TODO: Implement native GitHub OAuth if popup doesn't work on native.
 */
export async function signInWithGitHub(): Promise<FirebaseSignInResult> {
  const firebaseAuth = getFirebaseAuth();
  const provider = new GithubAuthProvider();
  provider.addScope("user:email");

  const result = await signInWithPopup(firebaseAuth, provider);
  const idToken = await result.user.getIdToken();

  return {
    idToken,
    email: result.user.email ?? "",
    displayName: result.user.displayName,
    photoURL: result.user.photoURL,
    provider: "github",
  };
}

// ---------------------------------------------------------------------------
// Apple Sign-In
// ---------------------------------------------------------------------------

/**
 * Native Apple Sign-In on iOS via @capgo/capacitor-social-login,
 * then exchange for Firebase credential.
 */
async function nativeAppleSignIn(): Promise<FirebaseSignInResult> {
  console.log("[NativeAppleSignIn] Step 1: initializing");
  const { SocialLogin } = await import("@capgo/capacitor-social-login");

  if (!_socialLoginInitialized) {
    await withTimeout(
      SocialLogin.initialize({ apple: {} }),
      10000,
      "SocialLogin.initialize(apple)",
    );
    _socialLoginInitialized = true;
  }

  console.log("[NativeAppleSignIn] Step 2: calling SocialLogin.login()");
  const res = await SocialLogin.login({
    provider: "apple",
    options: { scopes: ["email", "name"] },
  });

  console.log("[NativeAppleSignIn] Step 3: SocialLogin.login() returned", JSON.stringify(res).substring(0, 200));

  const appleResult = res.result as any;
  const appleIdToken = appleResult.idToken;
  if (!appleIdToken) {
    throw new Error("Apple Sign-In did not return an idToken");
  }

  // Send the Apple ID token directly to the backend — skip Firebase client
  // (signInWithCredential hangs in WKWebView on real devices, same as Google)
  console.log("[NativeAppleSignIn] Step 4: Skipping Firebase client, sending Apple ID token directly to backend");

  return {
    idToken: appleIdToken,
    email: appleResult.profile?.email ?? appleResult.email ?? "",
    displayName: appleResult.profile?.name ?? appleResult.fullName?.givenName ?? null,
    photoURL: null,
    provider: "apple",
  };
}

/**
 * Sign in with Apple.
 * - Web: Firebase popup with Apple OAuthProvider
 * - Native iOS: Native Apple Sign-In via @capgo/capacitor-social-login → Firebase credential
 */
export async function signInWithApple(): Promise<FirebaseSignInResult> {
  if (Capacitor.isNativePlatform()) {
    return nativeAppleSignIn();
  }

  const firebaseAuth = getFirebaseAuth();
  const provider = new OAuthProvider("apple.com");
  provider.addScope("email");
  provider.addScope("name");

  const result = await signInWithPopup(firebaseAuth, provider);
  const idToken = await result.user.getIdToken();

  return {
    idToken,
    email: result.user.email ?? "",
    displayName: result.user.displayName,
    photoURL: result.user.photoURL,
    provider: "apple",
  };
}
