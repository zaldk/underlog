/**
 * @typedef {Object} StoredImage
 * @property {string} name - The name of the image
 * @property {Blob} blob - The image data as a Blob
 */

const DB_NAME = 'ImageDB';
const DB_VERSION = 1;
const STORE_NAME = 'images';

/**
 * Open (or create) the IndexedDB database
 * @returns {Promise<IDBDatabase>}
 */
export function open_database() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'name' });
            }
        };
        request.onsuccess = (event) => { resolve(event.target.result); };
        request.onerror = (event) => { reject(event.target.error); };
    });
}

/**
 * Store an image in IndexedDB
 * @param {StoredImage} image
 * @returns {Promise<void>}
 */
export async function store_image(image) {
    const db = await open_database();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(image);

        request.onsuccess = () => { resolve(); };
        request.onerror = (event) => { reject(event.target.error); };
    });
}

/**
 * Retrieve an image by name from IndexedDB
 * @param {string} name
 * @returns {Promise<StoredImage|null>}
 */
export async function get_image(name) {
    const db = await open_database();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(name);

        request.onsuccess = (event) => { resolve(event.target.result || null); };
        request.onerror = (event) => { reject(event.target.error); };
    });
}

/**
 * Retrieve all image names from IndexedDB
 * @returns {Promise<string[]>} - A promise that resolves to an array of image names
 */
export async function get_all_image_names() {
    const db = await open_database();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAllKeys();

        request.onsuccess = (event) => {
            /** @type {string[]} */
            const keys = event.target.result;
            resolve(keys);
        };

        request.onerror = (event) => {
            reject(event.target.error);
        };
    });
}

/**
 * Populate the image select dropdown with all stored image names
 * @returns {Promise<void>}
 */
export async function populate_image_select() {
    const select = document.getElementById('imageSelect');
    select.innerHTML = '<option value="" disabled selected>Select an image</option>'; // Reset options

    try {
        const names = await get_all_image_names();
        names.forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Error populating image select:', error);
    }
}

// Event listeners for forms
document.getElementById('uploadForm').addEventListener('submit', async (event) => {
    event.preventDefault(); // Prevent form from submitting normally

    const fileInput = document.getElementById('fileInput');
    const file = fileInput.files[0];
    if (!file) {
        console.error('Please select a file first.');
        return;
    }

    const imageName = file.name;

    try {
        await store_image({ name: imageName, blob: file });
        console.info('Image stored successfully!');
        fileInput.value = ''; // Clear the file input
        await populate_image_select();
    } catch (error) {
        console.error('Error storing image:', error);
    }
});

document.getElementById('retrieveForm').addEventListener('submit', async (event) => {
    event.preventDefault();

    const imageSelect = document.getElementById('imageSelect');
    const imageName = imageSelect.value;
    if (!imageName) {
        console.error('Please select an image.');
        return;
    }

    try {
        const storedImage = await get_image(imageName);
        const container = document.getElementById('imageContainer');
        container.innerHTML = '';

        if (storedImage) {
            const url = URL.createObjectURL(storedImage.blob);
            const img = document.createElement('img');
            img.src = url;
            img.alt = storedImage.name;
            img.style.maxWidth = '300px';
            container.appendChild(img);
        } else {
            container.textContent = 'Image not found.';
        }
    } catch (error) {
        console.error('Error retrieving image:', error);
    }
});

// Populate the dropdown on page load
window.addEventListener('DOMContentLoaded', populate_image_select);
