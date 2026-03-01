import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, getDocs, deleteDoc, doc } from "firebase/firestore";

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
const db = getFirestore(app);
const moviesCol = collection(db, "movies");

const movies = [
    { title: "El Planeta de los Simios: Nuevo Reino", tmdbId: "653346", img: "https://image.tmdb.org/t/p/original/gKkl37BQuKTanygYQG1pyYgLVgf.jpg", year: "2024", rating: "7.1" },
    { title: "Intensa-Mente 2", tmdbId: "1022789", img: "https://image.tmdb.org/t/p/original/jL5Z1tXf3i5xIeMhL31Z5u7X9nN.jpg", year: "2024", rating: "7.7" },
    { title: "Deadpool & Wolverine", tmdbId: "533535", img: "https://image.tmdb.org/t/p/original/9yZexEqx8A1g21wA8oB1vXIfHIf.jpg", year: "2024", rating: "7.8" },
    { title: "Furiosa: de la saga Mad Max", tmdbId: "786892", img: "https://image.tmdb.org/t/p/original/sO1AXoeb6yMttKqFInIih3oTYM5.jpg", year: "2024", rating: "7.6" },
    { title: "Kung Fu Panda 4", tmdbId: "1011985", img: "https://image.tmdb.org/t/p/original/z6csQ6G1kO6E0S3nK9xN72m1h5X.jpg", year: "2024", rating: "7.1" },
    { title: "Godzilla x Kong: El nuevo imperio", tmdbId: "823464", img: "https://image.tmdb.org/t/p/original/t6807f96asY7S3pYpZQS09477S7.jpg", year: "2024", rating: "7.2" },
    { title: "Garfield: Fuera de casa", tmdbId: "748783", img: "https://image.tmdb.org/t/p/original/pY0LqGjAUPYmS62BqU1I6L0T2QY.jpg", year: "2024", rating: "6.5" },
    { title: "Bad Boys: Ride or Die", tmdbId: "573435", img: "https://image.tmdb.org/t/p/original/o9O8989F7wB4rO08R8uJ6m8y6u.jpg", year: "2024", rating: "7.0" },
    { title: "Duna: Parte Dos", tmdbId: "693134", img: "https://image.tmdb.org/t/p/original/8Ym86w8AJPshAnVfL3vW8J4K6B.jpg", year: "2024", rating: "8.3" },
    { title: "Mi villano favorito 4", tmdbId: "748167", img: "https://image.tmdb.org/t/p/original/w99S6uP7oP9vWpT8GfO7vO2kQ.jpg", year: "2024", rating: "7.2" },
    { title: "Aquaman y el Reino Perdido", tmdbId: "572802", img: "https://image.tmdb.org/t/p/original/7l9u7A9V2vM6S4Z0p2S1pYwW9S.jpg", year: "2023", rating: "6.9" },
    { title: "Oppenheimer", tmdbId: "872585", img: "https://image.tmdb.org/t/p/original/8Gxv8S7HaU0as9S3beuSU9uO9U.jpg", year: "2023", rating: "8.1" },
    { title: "Spider-Man: A través del Spider-Verso", tmdbId: "569094", img: "https://image.tmdb.org/t/p/original/8Vt6mY9C9S0S5Z2p2S1pYwW9S.jpg", year: "2023", rating: "8.4" },
    { title: "Super Mario Bros. La Película", tmdbId: "502356", img: "https://image.tmdb.org/t/p/original/qNBA9F7S3S0S5Z2p2S1pYwW9S.jpg", year: "2023", rating: "7.7" },
    { title: "John Wick 4", tmdbId: "603692", img: "https://image.tmdb.org/t/p/original/8Vt6mY9C9S0S5Z2p2S1pYwW9S.jpg", year: "2023", rating: "7.8" },
    { title: "Guardianes de la Galaxia Vol. 3", tmdbId: "447365", img: "https://image.tmdb.org/t/p/original/8Vt6mY9C9S0S5Z2p2S1pYwW9S.jpg", year: "2023", rating: "8.0" },
    { title: "Avatar: El Camino del Agua", tmdbId: "76600", img: "https://image.tmdb.org/t/p/original/8Vt6mY9C9S0S5Z2p2S1pYwW9S.jpg", year: "2022", rating: "7.7" },
    { title: "Top Gun: Maverick", tmdbId: "361743", img: "https://image.tmdb.org/t/p/original/8Vt6mY9C9S0S5Z2p2S1pYwW9S.jpg", year: "2022", rating: "8.3" },
    { title: "The Batman", tmdbId: "414906", img: "https://image.tmdb.org/t/p/original/8Vt6mY9C9S0S5Z2p2S1pYwW9S.jpg", year: "2022", rating: "7.7" },
    { title: "Puss in Boots: The Last Wish", tmdbId: "315162", img: "https://image.tmdb.org/t/p/original/kufR6RclRCDX8S0S5Z2p2S1pYwW9S.jpg", year: "2022", rating: "8.3" },
    { title: "Smile", tmdbId: "882598", img: "https://image.tmdb.org/t/p/original/kufR6RclRCDX8S0S5Z2p2S1pYwW9S.jpg", year: "2022", rating: "6.8" },
    { title: "Terrifier 2", tmdbId: "663712", img: "https://image.tmdb.org/t/p/original/kufR6RclRCDX8S0S5Z2p2S1pYwW9S.jpg", year: "2022", rating: "6.8" },
    { title: "M3GAN", tmdbId: "536554", img: "https://image.tmdb.org/t/p/original/kufR6RclRCDX8S0S5Z2p2S1pYwW9S.jpg", year: "2022", rating: "7.0" },
    { title: "Un lugar en silencio: Día uno", tmdbId: "762441", img: "https://image.tmdb.org/t/p/original/8Vt6mY9C9S0S5Z2p2S1pYwW9S.jpg", year: "2024", rating: "7.0" },
    { title: "El reino del planeta de los simios", tmdbId: "653346", img: "https://image.tmdb.org/t/p/original/8Vt6mY9C9S0S5Z2p2S1pYwW9S.jpg", year: "2024", rating: "7.1" }
];

async function run() {
    const snapshot = await getDocs(moviesCol);
    for (const movieDoc of snapshot.docs) {
        await deleteDoc(doc(db, "movies", movieDoc.id));
    }
    console.log("Database cleared.");

    for (let i = 0; i < movies.length; i++) {
        const m = movies[i];
        await addDoc(moviesCol, {
            ...m,
            status: 'healthy',
            embed: "",
            createdAt: Date.now() - (i * 1000)
        });
        console.log("Added:", m.title);
    }
    process.exit(0);
}
run();
