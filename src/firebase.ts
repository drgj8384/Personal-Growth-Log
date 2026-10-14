// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCFJNVd5T_5D6YqGNWkpoa8dWxPrqOmINA",
  authDomain: "personal-growth-log.firebaseapp.com",
  projectId: "personal-growth-log",
  storageBucket: "personal-growth-log.firebasestorage.app",
  messagingSenderId: "559830617450",
  appId: "1:559830617450:web:c0d85ed6166072475ea913",
  measurementId: "G-EER1VG951M"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);