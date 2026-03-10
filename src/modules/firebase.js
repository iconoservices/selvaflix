import { initializeApp } from "firebase/app";
import { getFirestore, collection } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
    apiKey: "AIzaSyCABaNkvULmjBatNh0Giih01IDH4sNbt1Q",
    authDomain: "selvaflix-5d991.firebaseapp.com",
    projectId: "selvaflix-5d991",
    storageBucket: "selvaflix-5d991.firebasestorage.app",
    messagingSenderId: "935630160406",
    appId: "1:935630160406:web:171ecfcb9e4258628bab37",
    measurementId: "G-N4DRH9QPE3"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const moviesCol = collection(db, "movies");
