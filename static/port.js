/**
 * Converts an image URL (especially blob URLs) to a JPEG Data URI using a canvas.
 * @param {string} url - The URL of the image (e.g., a blob: URL from IMAGE_URL_CACHE).
 * @returns {Promise<string>} A promise that resolves with the Data URI string (e.g., "data:image/jpeg;base64,...").
 * @throws {Error} If the image cannot be loaded or converted.
 */
function image_url_to_data_uri(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = function () {
            try {
                const canvas = document.createElement("canvas");
                // Use naturalWidth/Height for accurate dimensions
                canvas.width = this.naturalWidth;
                canvas.height = this.naturalHeight;
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    return reject(new Error("Failed to get canvas context."));
                }
                ctx.drawImage(this, 0, 0);
                // Use JPEG for potentially smaller size, or PNG for transparency
                const data_uri = canvas.toDataURL("image/jpeg", 0.9); // Quality 0.9
                resolve(data_uri);
            } catch (e) {
                reject(new Error(`Canvas conversion failed for ${url}: ${e.message}`));
            } finally {
                img.remove(); // Clean up element
            }
        };
        img.onerror = function (err) {
            img.remove(); // Clean up element
            reject(new Error(`Failed to load image for data URI conversion: ${url}. Error: ${err.message || err}`));
        };
        // Setting crossOrigin might be needed if loading from external sources,
        // but likely not necessary for blob URLs generated locally.
        // img.crossOrigin = "anonymous";
        img.src = url;
    });
}

/**
 * Takes an SVG string, finds all <image> tags with blob: hrefs,
 * converts them to data URIs, and returns the modified SVG string.
 * @param {string} svg_string - The input SVG string.
 * @returns {Promise<string>} A promise resolving to the SVG string with embedded images.
 */
async function embed_images_as_data_uris(svg_string) {
    const lines = svg_string.split("\n");
    const image_promises = [];
    const image_indices = []; // Store line index for replacement later
    const original_urls = []; // Store original blob url for replacement

    const image_regex = /<image[^>]*href="([^"]+)"[^>]*>/g;
    let match;

    for (let i = 0; i < lines.length; i++) {
        // Reset regex lastIndex for each line
        image_regex.lastIndex = 0;
        // We only need to process lines containing an image tag
        // Using regex is more robust than simple includes
        while ((match = image_regex.exec(lines[i])) !== null) {
            const url = match[1]; // Capture group 1 contains the href value
            // Only process blob URLs that need conversion
            if (url && url.startsWith("blob:")) {
                image_indices.push(i);
                original_urls.push(url);
                image_promises.push(image_url_to_data_uri(url));
                // Break while loop if only one image per line is expected,
                // otherwise it will find subsequent matches if any
                // break; // Assuming one image per line for simplicity here
            }
        }
    }

    if (image_promises.length === 0) {
        return svg_string; // No blob images found
    }

    try {
        const data_uris = await Promise.all(image_promises);
        const modified_lines = [...lines]; // Create a mutable copy

        for (let j = 0; j < image_indices.length; j++) {
            const line_index = image_indices[j];
            const original_url = original_urls[j];
            const data_uri = data_uris[j];
            // Be careful with simple replace if URL appears multiple times;
            // replace only the specific href attribute value.
            // A more robust regex replace might be needed for complex cases,
            // but replacing the exact blob URL should be safe enough here.
            if (modified_lines[line_index]) { // Ensure line exists
                modified_lines[line_index] = modified_lines[line_index].replace(`href="${original_url}"`, `href="${data_uri}"`);
            }
        }
        return modified_lines.join("\n");
    } catch (error) {
        console.error("Error converting one or more images to Data URIs:", error);
        // Decide whether to return original string or throw
        // Returning original might lead to broken images in export
        throw new Error("Failed to embed images as data URIs. " + error.message);
    }
}

/**
 * Triggers a browser download for the given content.
 * @param {Blob} blob - The Blob object containing the file content.
 * @param {string} filename - The desired name for the downloaded file.
 */
function trigger_download(blob, filename) {
    let url = null;
    try {
        url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a); // Required for Firefox
        a.click();
        a.remove(); // Clean up element
    } catch (error) {
        console.error("Download trigger failed:", error);
    } finally {
        if (url) {
            // Revoke the object URL after a short delay to ensure download starts
            setTimeout(() => URL.revokeObjectURL(url), 100);
        }
    }
}

export async function get_final_svg() {
    if (!globalThis.editor) {
        console.error("Editor not initialized.");
        return '';
    }
    const content = globalThis.editor_content;
    if (!content) {
        console.error("No content to export.");
        return '';
    }

    try {
        const svg_pages = globalThis.result;

        if (!svg_pages || svg_pages.length === 0) {
            console.error("Parsing resulted in no SVG pages.");
            return;
        }

        const svg_pages_imaged = await Promise.all(svg_pages.map(async s => await embed_images_as_data_uris(s)));
        const final_svg = svg_pages_imaged.join('\n\n');
        return final_svg;
    } catch (error) {
        console.error("SVG Export failed:", error);
    }
    return '';
}

export async function export_svg() {
    try {
        const final_svg = await get_final_svg();
        if (!final_svg || final_svg.length === 0) {
            console.error("Parsing resulted in no SVG pages.");
            return;
        }
        const svg_blob = new Blob([final_svg], { type: "image/svg+xml;charset=utf-8" });
        trigger_download(svg_blob, `underlog-${(new Date()).toString()}.svg`);
    } catch (error) {
        console.error("SVG Export failed:", error);
    }
}

export async function export_pdf() {
    const pdf_endpoint = '/pdf';

    try {
        const final_svg = await get_final_svg();
        if (!final_svg || final_svg.length === 0) {
            console.error("Parsing resulted in no SVG pages.");
            return;
        }

        const response = await fetch(pdf_endpoint, {
            method: 'POST',
            headers: {
                'Accept': 'application/pdf', // Expecting PDF back
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ input: final_svg }) // Send SVG as JSON payload
        });

        if (!response.ok) {
            // Try to get error message from backend if possible
            let error_detail = `Server responded with status ${response.status}`;
            try {
                const error_json = await response.json();
                error_detail += `: ${error_json.message || JSON.stringify(error_json)}`;
            } catch (e) { }
            throw new Error(`PDF generation failed. ${error_detail}`);
        }

        const pdf_blob = await response.blob();
        trigger_download(pdf_blob, `underlog-${(new Date()).toString()}.pdf`);
    } catch (error) {
        console.error("PDF Export failed:", error);
    }
}

export async function export_odt() {
    console.error("TODO: implement ODT");
    return;
    // const odt_endpoint = '/odt';
    //
    // try {
    //     const final_svg = await get_final_svg();
    //     if (!final_svg || final_svg.length === 0) {
    //         console.error("Parsing resulted in no SVG pages.");
    //         return;
    //     }
    //
    //     const response = await fetch(odt_endpoint, {
    //         method: 'POST',
    //         headers: {
    //             'Accept': 'application/vnd.oasis.opendocument.text', // Expecting ODT back
    //             'Content-Type': 'application/json'
    //         },
    //         body: JSON.stringify({ input: final_svg }) // Send SVG as JSON payload
    //     });
    //
    //     if (!response.ok) {
    //         // Try to get error message from backend if possible
    //         let error_detail = `Server responded with status ${response.status}`;
    //         try {
    //             const error_json = await response.json();
    //             error_detail += `: ${error_json.message || JSON.stringify(error_json)}`;
    //         } catch (e) { }
    //         throw new Error(`PDF generation failed. ${error_detail}`);
    //     }
    //
    //     const pdf_blob = await response.blob();
    //     trigger_download(pdf_blob, `underlog-${(new Date()).toString()}.pdf`);
    // } catch (error) {
    //     console.error("PDF Export failed:", error);
    // }
}
