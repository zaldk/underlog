/**
 * @typedef {Object} stored_image
 * @property {string} name - The name of the image
 * @property {Blob} blob - The image data as a Blob
 */

const DB_NAME = 'image_db';
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

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            reject(event.target.error);
        };
    });
}

/**
 * Store an image in IndexedDB
 * @param {stored_image} image
 * @returns {Promise<void>}
 */
export async function store_image(image) {
    const db = await open_database();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(image);

        request.onsuccess = () => {
            resolve();
        };

        request.onerror = (event) => {
            reject(event.target.error);
        };
    });
}

/**
 * Retrieve an image by name from IndexedDB
 * @param {string} name
 * @returns {Promise<stored_image|null>}
 */
export async function get_image(name) {
    const db = await open_database();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(name);

        request.onsuccess = (event) => {
            resolve(event.target.result || null);
        };

        request.onerror = (event) => {
            reject(event.target.error);
        };
    });
}

/**
 * Retrieve all image names from IndexedDB
 * @returns {Promise<string[]>}
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
 * Delete an image by name from IndexedDB
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function delete_image(name) {
    const db = await open_database();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(name);

        request.onsuccess = () => {
            resolve();
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
    const image_select = document.getElementById('image_select');
    image_select.innerHTML = '<option value="" disabled selected>Select an image</option>';

    try {
        const names = await get_all_image_names();
        names.forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            image_select.appendChild(option);
        });
    } catch (error) {
        console.error('Error populating image select:', error);
    }
}

// Event listeners
document.getElementById('upload_form').addEventListener('submit', async (event) => {
    event.preventDefault();

    const file_input = document.getElementById('file_input');
    const file = file_input.files[0];
    if (!file) {
        console.error('Please select a file first.');
        return;
    }

    const image_name = file.name;

    try {
        await store_image({ name: image_name, blob: file });
        console.info('Image stored successfully!');
        file_input.value = '';
        await populate_image_select();
    } catch (error) {
        console.error('Error storing image:', error);
    }
});

document.getElementById('image_select').addEventListener('change', async (event) => {
    const image_select = event.target;
    const image_name = image_select.value;
    if (!image_name) {
        console.error('Please select an image.');
        return;
    }

    try {
        const stored_image = await get_image(image_name);
        const image_container = document.getElementById('image_container');
        image_container.innerHTML = '';

        if (stored_image) {
            const url = URL.createObjectURL(stored_image.blob);
            const img = document.createElement('img');
            img.src = url;
            img.alt = stored_image.name;
            img.style.maxWidth = '300px';
            image_container.appendChild(img);
        } else {
            image_container.textContent = 'Image not found.';
        }
    } catch (error) {
        console.error('Error retrieving image:', error);
    }
});

document.addEventListener('DOMContentLoaded', populate_image_select);

document.getElementById('delete_btn').addEventListener('click', async () => {
    const imageSelect = document.getElementById('image_select');
    const imageName = imageSelect.value;
    if (!imageName) {
        console.error('Please select an image to delete.');
        return;
    }

    if (!confirm(`Are you sure you want to delete "${imageName}"?`)) {
        return;
    }

    try {
        await delete_image(imageName);
        console.info(`Image "${imageName}" deleted.`);
        await populate_image_select();
        document.getElementById('image_container').innerHTML = '';
    } catch (error) {
        console.error('Error deleting image:', error);
    }
});
