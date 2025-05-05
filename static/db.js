import * as svg from './svg.js';

/**
 * @typedef {Object} stored_image
 * @property {string} name - The name of the image
 * @property {Blob} blob - The image data as a Blob
 */

// Shim functions if script.js is loaded later or handles them differently
const showError = window.showError ?? ((msg) => showMessage('general', msg, true));
const showSuccess = window.showSuccess ?? ((msg) => showMessage('general', msg, false));

// Simple UI feedback functions (can be replaced with a more robust notification system)
function showMessage(elementId, message, isError = false) {
    if (isError) {
        console.error(`UI Message (${elementId}): ${message}`);
    } else {
        console.info(`UI Message (${elementId}): ${message}`);
    }
}

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
            console.error("Database error:", event.target.error);
            reject(event.target.error);
        };
    });
}

/**
 * Perform an IndexedDB transaction.
 * @param {IDBTransactionMode} mode - 'readonly' or 'readwrite'
 * @param {(store: IDBObjectStore) => IDBRequest} operation
 * @returns {Promise<any>} Promise resolving with the operation result or rejecting on error.
 */
async function perform_transaction(mode, operation) {
    const db = await open_database();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        const request = operation(store);

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            console.error(`Transaction error (${mode}):`, event.target.error);
            reject(event.target.error);
        };

        transaction.oncomplete = () => {
            // Optional: Log completion if needed
            // console.log(`Transaction (${mode}) completed.`);
        };
        transaction.onerror = (event) => {
            // General transaction errors (less common if request errors are handled)
            console.error(`General transaction error (${mode}):`, event.target.error);
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
    // Basic validation
    if (!image || !image.name || !(image.blob instanceof Blob)) {
        return Promise.reject(new Error("Invalid image data provided to store_image."));
    }
    try {
        await perform_transaction('readwrite', (store) => store.put(image));
    } catch (error) {
        console.error(`Failed to store image "${image.name}":`, error);
        throw error; // Re-throw to allow calling function to handle
    }
}

/**
 * Retrieve an image by name from IndexedDB
 * @param {string} name
 * @returns {Promise<stored_image|null>}
 */
export async function get_image(name) {
    if (!name) {
        return Promise.resolve(null); // Or reject(new Error("Image name is required"))
    }
    try {
        const result = await perform_transaction('readonly', (store) => store.get(name));
        return result || null;
    } catch (error) {
        console.error(`Failed to get image "${name}":`, error);
        throw error;
    }
}

/**
 * Retrieve all image names from IndexedDB
 * @returns {Promise<string[]>}
 */
export async function get_all_image_names() {
    try {
        const keys = await perform_transaction('readonly', (store) => store.getAllKeys());
        // Ensure the result is an array of strings
        if (Array.isArray(keys)) {
            return keys.map(key => String(key)); // Explicitly cast keys to string if needed
        }
        return [];
    } catch (error) {
        console.error('Failed to get all image names:', error);
        throw error;
    }
}

/**
 * Retrieve all image objects (name and blob) from IndexedDB
 * @returns {Promise<stored_image[]>}
 */
export async function getAllImages() {
    try {
        const images = await perform_transaction('readonly', (store) => store.getAll());
        return images || []; // Ensure it returns an array
    } catch (error) {
        console.error('Failed to get all images:', error);
        throw error;
    }
}


/**
 * Delete an image by name from IndexedDB
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function delete_image(name) {
    if (!name) {
        return Promise.reject(new Error("Image name is required for deletion."));
    }
    try {
        await perform_transaction('readwrite', (store) => store.delete(name));
        // Clear caches associated with the deleted image
        if (svg.IMAGE_HEIGHT_CACHE[name]) delete svg.IMAGE_HEIGHT_CACHE[name];
        if (svg.IMAGE_URL_CACHE[name]) {
            try { URL.revokeObjectURL(svg.IMAGE_URL_CACHE[name]); } catch(e) {}
            delete svg.IMAGE_URL_CACHE[name];
        }
    } catch (error) {
        console.error(`Failed to delete image "${name}":`, error);
        throw error;
    }
}

/**
 * Delete ALL images from IndexedDB. Use with caution.
 * @returns {Promise<void>}
 */
export async function clearAllImages() {
    try {
        await perform_transaction('readwrite', (store) => store.clear());
        // Clear all related caches
        Object.keys(svg.IMAGE_HEIGHT_CACHE).forEach(key => delete svg.IMAGE_HEIGHT_CACHE[key]);
        Object.keys(svg.IMAGE_URL_CACHE).forEach(key => {
            try { URL.revokeObjectURL(svg.IMAGE_URL_CACHE[key]); } catch(e) {}
            delete svg.IMAGE_URL_CACHE[key];
        });
        console.info('All images cleared from IndexedDB and caches.');
    } catch (error) {
        console.error('Failed to clear all images:', error);
        throw error;
    }
}


/**
 * Populate the image select dropdown with all stored image names
 * @returns {Promise<void>}
 */
export async function populate_image_select() {
    const image_select = document.getElementById('image_select');
    // Ensure element exists
    if (!image_select) {
        console.error("Element with ID 'image_select' not found.");
        return;
    }
    // Preserve the currently selected value if possible
    const current_value = image_select.value;
    image_select.innerHTML = '<option value="" disabled selected>Select an image</option>'; // Reset options

    try {
        const names = await get_all_image_names();
        names.sort().forEach(name => { // Sort names alphabetically
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            image_select.appendChild(option);
        });
        // Try to restore previous selection
        if (names.includes(current_value)) {
            image_select.value = current_value;
        }

    } catch (error) {
        console.error('Error populating image select:', error);
        // Optionally, display an error message to the user in the UI
    }
}

/**
 * Converts a Blob object to a Base64 encoded string.
 * @param {Blob} blob - The blob to convert.
 * @returns {Promise<string>} A promise that resolves with the Base64 string (without the data: URL prefix).
 */
export function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        if (!(blob instanceof Blob)) {
            return reject(new Error("Input must be a Blob."));
        }
        const reader = new FileReader();
        reader.onloadend = () => {
            if (reader.result) {
                // Result includes the 'data:mime/type;base64,' prefix, remove it
                const base64String = reader.result.toString().split(',')[1];
                resolve(base64String);
            } else {
                reject(new Error("FileReader result was null."));
            }
        };
        reader.onerror = (error) => reject(error || new Error("FileReader error"));
        reader.readAsDataURL(blob);
    });
}


// --- DOM Event Listeners (Keep existing functionality) ---
// These listeners primarily interact with the local IndexedDB state

document.addEventListener('DOMContentLoaded', async () => {
    // Initial population of the image list
    await populate_image_select();

    // Add other DOMContentLoaded setup if needed
});


document.getElementById('upload_form')?.addEventListener('submit', async (event) => {
    event.preventDefault();

    const file_input = document.getElementById('file_input');
    if (!file_input || !file_input.files || file_input.files.length === 0) {
        showError('Please select a file first.'); // Use showError from script.js
        return;
    }

    const file = file_input.files[0];
    const image_name = file.name;

    // Optional: Check if image with the same name already exists
    // const existing = await get_image(image_name);
    // if (existing && !confirm(`An image named "${image_name}" already exists. Overwrite?`)) {
    //     return;
    // }

    try {
        await store_image({ name: image_name, blob: file });
        showSuccess('Image uploaded to local storage!'); // Use showSuccess from script.js
        file_input.value = ''; // Clear file input
        await populate_image_select();
        // Also trigger SVG update if image might be used immediately
        if (window.work) await window.work();
    } catch (error) {
        showError(`Error storing image: ${error.message}`); // Use showError
    }
});

document.getElementById('image_select')?.addEventListener('change', async (event) => {
    const image_select = event.target;
    const image_name = image_select.value;
    const rename_container = document.getElementById('rename_form');
    const image_container = document.getElementById('image_container');
    const rename_input = document.getElementById('rename_input');

    // Ensure elements exist
    if (!rename_container || !image_container || !rename_input) {
        console.error("Required UI elements for image selection not found.");
        return;
    }

    if (!image_name) {
        rename_container.classList.remove('visible');
        image_container.innerHTML = '';
        rename_input.value = ''; // Clear rename input when no image selected
        return;
    }

    rename_container.classList.add('visible');
    rename_input.value = image_name; // Pre-fill rename input

    try {
        const stored_image = await get_image(image_name);
        image_container.innerHTML = ''; // Clear previous image

        if (stored_image && stored_image.blob) {
            // It's generally better to revoke previous URLs to avoid memory leaks
            const old_img = image_container.querySelector('img');
            if (old_img && old_img.src.startsWith('blob:')) {
                URL.revokeObjectURL(old_img.src);
            }

            const url = URL.createObjectURL(stored_image.blob);
            const img = document.createElement('img');
            img.src = url;
            img.alt = stored_image.name;
            img.style.maxWidth = '300px'; // Keep style consistent
            img.style.display = 'block'; // Prevent extra space below img
            img.onload = () => {
                // Optional: If not using object URLs elsewhere, revoke after load
                // URL.revokeObjectURL(url);
            };
            img.onerror = () => {
                image_container.textContent = 'Error loading image preview.';
                URL.revokeObjectURL(url); // Clean up on error
            }
            image_container.appendChild(img);
        } else {
            image_container.textContent = 'Image data not found.';
        }
    } catch (error) {
        showError(`Error retrieving image preview: ${error.message}`); // Use showError
        image_container.textContent = 'Error retrieving image preview.';
    }
});


document.getElementById('delete_btn')?.addEventListener('click', async () => {
    const imageSelect = document.getElementById('image_select');
    if (!imageSelect) return;

    const imageName = imageSelect.value;
    if (!imageName) {
        showError('Please select an image to delete.');
        return;
    }

    if (!confirm(`Are you sure you want to delete the local copy of "${imageName}"? This might affect the currently unsaved project.`)) {
        return;
    }

    try {
        await delete_image(imageName);
        showSuccess(`Local image "${imageName}" deleted.`);
        // Reset UI related to the deleted image
        document.getElementById('image_container').innerHTML = '';
        document.getElementById('rename_form')?.classList.remove('visible');
        await populate_image_select(); // Refresh dropdown
        // Also trigger SVG update as the image is now gone
        if (window.work) await window.work();
    } catch (error) {
        showError(`Error deleting image: ${error.message}`);
    }
});

document.getElementById('rename_form')?.addEventListener('submit', async (event) => {
    event.preventDefault();

    const image_select = document.getElementById('image_select');
    const rename_input = document.getElementById('rename_input');
    if (!image_select || !rename_input) return;

    const old_name = image_select.value;
    const new_name = rename_input.value.trim();

    if (!old_name) {
        showError('No image selected to rename.');
        return;
    }
    if (!new_name) {
        showError('Please enter a new name.');
        return;
    }
    if (old_name === new_name) {
        showError('New name cannot be the same as the current name.');
        return;
    }

    // Check if the new name already exists
    const exists_with_new_name = await get_image(new_name);
    if (exists_with_new_name) {
        showError(`An image named "${new_name}" already exists.`);
        return;
    }

    try {
        const existing_image = await get_image(old_name);
        if (!existing_image || !existing_image.blob) {
            showError(`Original image "${old_name}" not found.`);
            await populate_image_select(); // Refresh list in case it was deleted elsewhere
            return;
        }

        // Store with new name, then delete old one
        await store_image({ name: new_name, blob: existing_image.blob });
        await delete_image(old_name); // This also clears caches for old_name

        await populate_image_select(); // Refresh dropdown

        // Update the selection to the new name
        image_select.value = new_name;
        // Manually trigger the change event to update the preview and rename input
        image_select.dispatchEvent(new Event('change'));

        showSuccess(`Local image renamed from "${old_name}" to "${new_name}".`);
        // Also trigger SVG update as image reference might change
        if (window.work) await window.work();

    } catch (error) {
        showError(`Error renaming image: ${error.message}`);
        // Attempt to refresh the select list in case of partial failure
        await populate_image_select();
    }
});
