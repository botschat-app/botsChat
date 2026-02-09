/**
 * Firebase client initialization for OAuth Sign-In (Google, GitHub).
 *
 * The Firebase config is loaded from Vite environment variables.
 * Create a `.env` file in packages/web/ with your Firebase config:
 *
 *   VITE_FIREBASE_API_KEY=AIzaSy...
 *   VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
 *   VITE_FIREBASE_PROJECT_ID=your-project-id
 */

import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  GithubAuthProvider,
  signInWithPopup,
  type Auth,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string,
};

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

/** Check if Firebase is configured (all required env vars present). */
export function isFirebaseConfigured(): boolean {
  return !!(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId);
}

function getFirebaseAuth(): Auth {
  if (!auth) {
    if (!isFirebaseConfigured()) {
      throw new Error("Firebase is not configured. Set VITE_FIREBASE_* env vars.");
    }
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
  }
  return auth;
}

export type FirebaseSignInResult = {
  idToken: string;
  email: string;
  displayName: string | null;
  photoURL: string | null;
  provider: "google" | "github";
};

/**
 * Sign in with Google via popup and return the Firebase ID token.
 */
export async function signInWithGoogle(): Promise<FirebaseSignInResult> {
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
 * Sign in with GitHub via popup and return the Firebase ID token.
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
