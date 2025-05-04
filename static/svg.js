import { Token } from './common.js';
import * as db from './db.js';

// --- Keep these constants and helpers from the "old" code ---
const UNITS = {
    mm2px: 3.7795285714285716,
    px2mm: 0.2645832624628166,
    pt2px: 1.3332857142857144,
};
const BOUNDS = {
    top: 20 * UNITS.mm2px,
    left: 30 * UNITS.mm2px,
    right: 10 * UNITS.mm2px,
    bottom: 20 * UNITS.mm2px,
};
const OFFSETS = {
    paragraph: 12.5 * UNITS.mm2px, // 1.25cm
    list_base: 12.5 * UNITS.mm2px, // Indent for the bullet/number
    list_text: 22.5 * UNITS.mm2px, // Indent for the text after bullet/number
};
const WIDTH = 210 * UNITS.mm2px;
const HEIGHT = 297 * UNITS.mm2px;
let TEXT_SIZE = 14 * UNITS.pt2px; // Default text size in px
const LINE_WIDTH = WIDTH - BOUNDS.left - BOUNDS.right;
const SVG = {
    type: "svg",
    attributes: {
        width:  `${WIDTH  * 0.75}px`,
        height: `${HEIGHT * 0.75}px`,
        viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
        xmlns: "http://www.w3.org/2000/svg",
        preserveAspectRatio: "xMidYMin meet",
    },
    children: [],
};
const TOC_ADDITION = 3; // Assuming this offset remains relevant

function text_width(text, size = TEXT_SIZE, weight = 'normal', family = 'Times New Roman') {
    // Adjusted to potentially handle different weights/families later
    if (window.ctx == null) {
        const canvas = document.createElement("canvas"); window.canvas = canvas;
        const ctx = canvas.getContext("2d"); window.ctx = ctx;
    }
    window.ctx.font = `${weight} ${size}px ${family}`;
    return window.ctx.measureText(text).width;
}

function copy(o) { return JSON.parse(JSON.stringify(o)) }

function get_page_enum(page_count) {
    const page_num_text = `${page_count + TOC_ADDITION}`;
    return {
        type: "text",
        attributes: {
            x: `${WIDTH/2 - text_width(page_num_text)/2}px`,
            y: `${HEIGHT - BOUNDS.bottom}px`,
            "font-size": `${TEXT_SIZE}px`,
            "font-family": "Times New Roman",
        },
        text: page_num_text,
    };
}

export function evaluate(svg) {
    let result = ``;
    result += `<svg id="SVG"`;
    const attributes = Object.entries(svg.attributes)
    for (let i = 0; i < attributes.length; i++) {
        result += ` ${attributes[i][0]}="${attributes[i][1]}"`
    }
    result += `>\n`

    result += `<rect width="210mm" height="297mm" fill="white" />\n`;

    const children = svg.children
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const attrs = Object.entries(child.attributes)
        if (child.type === "text") {
            result += `<text`;
            for (let j = 0; j < attrs.length; j++) {
                result += ` ${attrs[j][0]}="${attrs[j][1]}"`
            }
            result += `>${child.text}</text>\n`
        } else if (child.type === "image") {
            result += `<image`;
            for (let j = 0; j < attrs.length; j++) {
                result += ` ${attrs[j][0]}="${attrs[j][1]}"`
            }
            result += `/>\n`
        }
    }
    result += `</svg>\n`

    //console.log(result)

    return result
}

// Caches for image data retrieved from IndexedDB
export const IMAGE_HEIGHT_CACHE = {}; // Stores dimensions: { name: [width, height] | Promise }
export const IMAGE_URL_CACHE = {};    // Stores Blob URLs: { name: string }

/**
 * Asynchronously retrieves image dimensions, fetching from IndexedDB if necessary.
 * Manages Blob URL creation and caching.
 * Always returns a tuple [width, height], returning [0, 0] if the image
 * cannot be found, loaded, or dimensions determined.
 *
 * @param {string} name - The name of the image (key in IndexedDB).
 * @returns {Promise<[number, number]>} A promise resolving to [width, height] tuple. Returns [0, 0] on failure.
 */
async function get_image_height(name) {
    // Ensure name is valid
    if (!name) {
        //console.warn("get_image_height called with invalid name.");
        return [0, 0];
    }

    const cached_entry = IMAGE_HEIGHT_CACHE[name];

    // 1. Check cache: If dimensions array exists, return it.
    if (Array.isArray(cached_entry)) {
        // console.log(`Dimension cache hit (Array) for ${name}:`, cached_entry);
        return cached_entry; // Return cached dimensions or [0, 0] error state
    }

    // 2. Check cache: If a promise exists, await it.
    if (cached_entry instanceof Promise) {
        // console.log(`Dimension cache hit (Promise) for ${name}, awaiting...`);
        try {
            // Await the existing promise to complete.
            const dimensions = await cached_entry;
            return dimensions; // Return the resolved dimensions from the ongoing promise
        } catch (error) {
            console.error(`Error awaiting cached promise for image "${name}":`, error);
            // Ensure cache reflects error state if the awaited promise failed critically
            if (!(Array.isArray(IMAGE_HEIGHT_CACHE[name]) && IMAGE_HEIGHT_CACHE[name][0] === 0)) {
                IMAGE_HEIGHT_CACHE[name] = [0, 0];
            }
            return [0, 0]; // Return zero-values on error
        }
    }

    // 3. Cache miss: Start loading from DB and await the result.
    // console.log(`Dimension cache miss for ${name}, starting DB load.`);

    // Create the promise to perform the loading operation.
    const loading_promise = new Promise(async (resolve) => {
        let blob_url = null; // Keep track of blob_url to revoke on error
        try {
            const stored_image = await db.get_image(name);

            if (!stored_image || !stored_image.blob) {
                // Image not found in DB is not necessarily an *error*, but results in 0 dimensions
                //console.warn(`Image "${name}" not found in DB or has no blob.`);
                resolve([0, 0]); // Resolve with zero-dimensions
                return;
            }

            // Revoke previous URL if exists for this name before creating a new one
            if (IMAGE_URL_CACHE[name]) {
                URL.revokeObjectURL(IMAGE_URL_CACHE[name]);
                // console.log(`Revoked old blob URL for ${name}`);
            }

            blob_url = URL.createObjectURL(stored_image.blob);
            IMAGE_URL_CACHE[name] = blob_url; // Cache the new URL immediately

            const img = new Image();
            img.onload = () => {
                const dimensions = [img.naturalWidth, img.naturalHeight];
                // Don't cache dimensions here inside promise, cache the final result after await
                img.remove(); // Clean up image element
                // Do NOT revoke blob_url here, it's needed for rendering
                resolve(dimensions); // Resolve the promise with dimensions
            };
            img.onerror = (err) => {
                console.error(`Failed to load image dimensions from blob URL for: ${name}`, err);
                // Don't keep a broken blob URL
                if (blob_url) {
                    URL.revokeObjectURL(blob_url);
                    delete IMAGE_URL_CACHE[name];
                }
                img.remove();
                resolve([0, 0]); // Resolve with zero-dimensions on image load error
            };
            img.src = blob_url;

        } catch (db_error) {
            console.error(`Failed during DB access or image processing for "${name}":`, db_error);
            // Ensure cleanup if blob_url was created before DB error somehow
            if (blob_url && IMAGE_URL_CACHE[name] === blob_url) {
                URL.revokeObjectURL(blob_url);
                delete IMAGE_URL_CACHE[name];
            }
            resolve([0, 0]); // Resolve with zero-dimensions on DB or other errors
        }
    });

    // Store the promise in the cache immediately so subsequent calls await the same promise.
    IMAGE_HEIGHT_CACHE[name] = loading_promise;

    try {
        // Await the loading promise we just created.
        const final_dimensions = await loading_promise;
        // Cache the final result (which could be [w,h] or [0,0])
        IMAGE_HEIGHT_CACHE[name] = final_dimensions;
        // If dimensions are [0,0], potentially remove the blob URL as it might be invalid/unusable
        if (final_dimensions[0] === 0 && IMAGE_URL_CACHE[name]) {
            //console.warn(`Image "${name}" resulted in [0,0] dimensions, removing potentially invalid blob URL from cache.`);
            URL.revokeObjectURL(IMAGE_URL_CACHE[name]);
            delete IMAGE_URL_CACHE[name];
        }
        return final_dimensions;
    } catch (error) {
        // This catch is less likely to be hit if the promise always resolves,
        // but good for robustness in case of unexpected promise rejection.
        console.error(`Unexpected error awaiting image load promise for "${name}":`, error);
        IMAGE_HEIGHT_CACHE[name] = [0, 0]; // Ensure cache reflects error state
        // Clean up potential URL cache entry
        if (IMAGE_URL_CACHE[name]) {
            try { URL.revokeObjectURL(IMAGE_URL_CACHE[name]); } catch(e){}
            delete IMAGE_URL_CACHE[name];
        }
        return [0, 0];
    }
}

// --- END of old helpers/constants ---


/**
 * Parses the Node tree generated by parseReport into an array of SVG page objects synchronously.
 * Uses placeholder dimensions for images initially if not cached.
 * Relies on a callback mechanism to trigger re-parsing/re-rendering when image dimensions become available.
 *
 * @param {Node[]} nodes - Array of top-level nodes from parseReport.
 * @returns {Object[]} An array of SVG page objects based on currently available data. May be incomplete/incorrect layout initially.
 */
export async function parse(nodes) {
    let TOC = [];
    let TOC_PAGE_INDEX = -1;
    let Y_OFFSET = BOUNDS.top;
    let heading_counters = [];
    let list_counters = { ordered: [], unordered: [] };
    let image_counter = 0;
    let page_count = 0;
    let last_heading_was_numbered = false;
    let svgs = [copy(SVG)];

    function ensure_bounds(forceNewPage = false) {
        if (forceNewPage || Y_OFFSET >= HEIGHT - BOUNDS.bottom - TEXT_SIZE) {
            if (last_heading_was_numbered && svgs.at(-1).children.length > 0) {
                svgs.at(-1).children.push(get_page_enum(page_count));
            }
            page_count += 1;
            svgs.push(copy(SVG));
            Y_OFFSET = BOUNDS.top;
            last_heading_was_numbered = false;
        }
    }

    /**
     * Adds text to the current SVG page, handling word wrapping and justification.
     * @param {object} options - Text options.
     * @param {string} options.text - The text content.
     * @param {number} options.text_start - The starting X coordinate for the text block.
     * @param {number} options.available_width - The maximum width available for text lines.
     * @param {number} [options.first_line_indent=0] - Additional indent for the first line.
     * @param {'left'|'center'|'right'|'justify'} [options.align='left'] - Text alignment.
     * @param {number} [options.text_size=TEXT_SIZE] - Font size in pixels.
     * @param {string} [options.weight='normal'] - Font weight.
     * @returns {number} The number of lines added.
     */
    const add_wrapped_text = ({
        text,
        text_start,
        available_width,
        first_line_indent = 0,
        align = 'left',
        text_size = TEXT_SIZE,
        weight = 'normal'
    }) => {
        // {{{
        // Make sure it uses the passed current_text_size correctly
        // and increments Y_OFFSET appropriately.
        if (!text) return 0;
        const words = text.trim().split(/[ \t]+/);
        let word_start_index = 0;
        let lines_added = 0;

        while (word_start_index < words.length) {
            ensure_bounds();
            let current_line_start_index = word_start_index;
            let current_line_length_px = 0;
            const line_width = available_width - ((current_line_start_index === 0) ? first_line_indent : 0);

            for (let j = current_line_start_index; j < words.length; j++) {
                const word = words[j];
                const word_width = text_width(word + " ", text_size);

                if (j > current_line_start_index && (current_line_length_px + word_width) > line_width) {
                    break;
                }
                current_line_length_px += word_width;
                word_start_index = j + 1;
            }

            const line_words = words.slice(current_line_start_index, word_start_index);
            const line_text = line_words.join(" ");
            const num_words_on_line = line_words.length;
            const num_spaces = Math.max(0, num_words_on_line - 1);

            let word_spacing = text_width(" ", text_size);
            word_spacing = (line_width - current_line_length_px) / num_spaces;
            if (current_line_start_index + num_words_on_line === words.length && current_line_length_px <= line_width * 0.8) word_spacing = text_width(" ");


            let x_pos = text_start + ((current_line_start_index === 0) ? first_line_indent : 0);
            if (align === 'center') {
                x_pos = WIDTH/2 - current_line_length_px/2;
                word_spacing = text_width(" ", text_size);
            }
            // if (align === 'right') {
            //     x_pos
            // }

            svgs.at(-1).children.push({
                type: "text",
                attributes: {
                    x: `${x_pos}px`,
                    y: `${Y_OFFSET}px`,
                    "font-size": `${text_size}px`,
                    "font-family": 'Times New Roman',
                    "font-weight": weight,
                    "word-spacing": `${word_spacing}px`,
                },
                text: line_text,
            });

            Y_OFFSET += text_size * 1.5;
            lines_added++;
        }
        return lines_added;
        // }}}
    };


    let temp_heading_counters = [];
    for (const node of nodes) {
        if (node.name !== Token.heading) continue;
        const isNumbered = node.attributes.numbered === 'true';
        const level = isNumbered ? parseInt(node.attributes.level || '1', 10) : 0;
        const type = node.attributes.type;
        const textContent = node.children?.[0]?.attributes?.content || '';
        let prefix = "";
        if (isNumbered) {
            while (temp_heading_counters.length < level) { temp_heading_counters.push(0); }
            temp_heading_counters[level - 1] += 1;
            for (let l = level; l < temp_heading_counters.length; l++) { temp_heading_counters[l] = 0; }
            prefix = temp_heading_counters.slice(0, level).join(".") + " ";
        }
        const final_text = prefix + ((isNumbered && level === 1) ? textContent.toUpperCase() : textContent);
        if (type !== '%') {
            TOC.push({ text: final_text, page: -1, isNumbered: isNumbered, level: level });
        }
    }
    image_counter = 0; // Reset before main processing


    // Main Rendering Loop
    heading_counters = [];

    for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i];
        let current_text_size = TEXT_SIZE;

        switch (node.name) {
            case Token.paragraph: {
                const textContent = node.children?.[0]?.attributes?.content || '';
                add_wrapped_text({ text: textContent, text_start: BOUNDS.left, available_width: LINE_WIDTH, first_line_indent: OFFSETS.paragraph });
                break;
            }

            case Token.heading: {
                // {{{
                const isNumbered = node.attributes.numbered === 'true';
                const level = isNumbered ? parseInt(node.attributes.level || '1', 10) : 0;
                const type = node.attributes.type;
                const textContent = node.children?.[0]?.attributes?.content || '';
                let prefix = "";
                let align = 'left';

                if (!isNumbered && type === '%') {
                    if (svgs.at(-1).children.length > 0) { ensure_bounds(true); }
                    TOC_PAGE_INDEX = page_count;
                    ensure_bounds(true);
                    last_heading_was_numbered = false;
                    continue;
                }

                if (isNumbered) {
                    while (heading_counters.length < level) { heading_counters.push(0); }
                    heading_counters[level - 1] += 1;
                    for (let l = level; l < heading_counters.length; l++) { heading_counters[l] = 0; }
                    prefix = heading_counters.slice(0, level).join(".") + " ";
                    if (level === 1) {
                        image_counter = 0;
                        if (Y_OFFSET > BOUNDS.top + TEXT_SIZE) { ensure_bounds(true); }
                    }
                    last_heading_was_numbered = true;
                } else if (type === '@') {
                    prefix = "";
                    align = 'center';
                    last_heading_was_numbered = false;
                    if (Y_OFFSET > BOUNDS.top + TEXT_SIZE) { ensure_bounds(true); }
                }

                const final_text = prefix + ((isNumbered && level === 1) ? textContent.toUpperCase() : textContent);

                for (let j = 0; j < TOC.length; j++) {
                    if (TOC[j].text === final_text && TOC[j].page === -1 && TOC[j].isNumbered === isNumbered && TOC[j].level === level) {
                        TOC[j].page = page_count + TOC_ADDITION;
                        break;
                    }
                }
                current_text_size = TEXT_SIZE; // * (level === 1 ? 1.2 : level === 2 ? 1.1 : 1.0);
                add_wrapped_text({ text: final_text, text_start: BOUNDS.left, available_width: LINE_WIDTH, first_line_indent: OFFSETS.paragraph, align, weight: 'bold', text_size: current_text_size });
                Y_OFFSET += current_text_size * 0.5;
                break;
                // }}}
            }

            case Token.image: {
                // {{{
                const name = node.attributes.name;
                const caption = node.attributes.caption || '';
                // TODO: Allow specifying width, e.g., image::name[caption, width=80%]
                let requested_width_percent = 50; // Default width

                const target_width_px = LINE_WIDTH * (requested_width_percent / 100);
                let image_height_px;
                let image_href = '#'; // Default placeholder href

                const dimensions = await get_image_height(name); // Returns [width, height] or [0, 0]

                // Get the Blob URL from the cache (populated by get_image_height)
                const cached_url = IMAGE_URL_CACHE[name];
                if (cached_url) {
                    image_href = cached_url;
                } else if (dimensions[0] > 0) {
                    // If dimensions were loaded but URL somehow missing, log error
                    console.error(`Dimensions loaded for image "${name}" but Blob URL is missing from cache.`);
                    image_href = '#error-missing-url'; // Indicate an error state
                } else {
                    // Dimensions are [0, 0], likely image failed to load or not found
                    //console.warn(`Image "${name}" could not be loaded or found.`);
                    image_href = '#error-not-found';
                }


                // Calculate actual height based on awaited dimensions
                if (Array.isArray(dimensions) && dimensions[0] > 0) { // Check for valid width
                    image_height_px = target_width_px * (dimensions[1] / dimensions[0]);
                } else {
                    // Dimensions are [0, 0] or invalid
                    //console.warn(`Image "${name}" has zero or invalid dimensions. Using fallback height.`);
                    image_height_px = target_width_px * 0.6; // Fallback aspect ratio
                    // Ensure href reflects the error if not already set
                    if (!image_href.startsWith('#error')) {
                        image_href = '#error-zero-dimensions';
                    }
                }

                // --- Layout Calculation and Placement ---
                // Estimate caption height (sync operation)
                // Note: text_width might need adjustment if run outside browser context
                const caption_prefix = `Рисунок ?.? – `; // Placeholder prefix for width calc
                const estimated_full_caption = caption_prefix + caption;
                const caption_lines_estimate = caption ? Math.ceil(text_width(estimated_full_caption, TEXT_SIZE) / LINE_WIDTH) + 1 : 0;
                const caption_height = caption ? (TEXT_SIZE * 1.5 * caption_lines_estimate) + (TEXT_SIZE * 0.5) : 0; // Height for caption + spacing

                // Calculate total required height using calculated/fallback image height
                const required_height = image_height_px + caption_height + TEXT_SIZE * 0.5; // Img + spacing + caption + spacing

                // Check page bounds (sync operation)
                ensure_bounds(); // Check if starting position is ok
                if (Y_OFFSET + required_height > HEIGHT - BOUNDS.bottom) {
                    ensure_bounds(true); // Force new page if it won't fit
                }

                // Add SVG image element (sync operation)
                const img_x = BOUNDS.left + (LINE_WIDTH / 2) - (target_width_px / 2);
                svgs.at(-1).children.push({
                    type: "image",
                    attributes: {
                        x: `${img_x}px`,
                        y: `${Y_OFFSET - TEXT_SIZE/2}px`,
                        width: `${target_width_px}px`,
                        height: `${image_height_px}px`, // Use calculated or fallback height
                        href: image_href,               // Use cached Blob URL or error placeholder
                        preserveAspectRatio: "xMidYMin meet",
                    },
                    // No 'text' property for image element
                });

                // Advance Y offset (sync operation)
                Y_OFFSET += image_height_px;
                Y_OFFSET += TEXT_SIZE * 0.5;
                ensure_bounds(); // Re-check after spacing

                // Add caption if present (sync operation)
                if (caption) {
                    image_counter++;
                    // Get current chapter number
                    const chapter_num = (heading_counters && heading_counters.length > 0) ? heading_counters[0] : '?';
                    const actual_caption_prefix = `Рисунок ${chapter_num}.${image_counter} – `;
                    const full_caption = actual_caption_prefix + caption;

                    // Add caption text using helper function
                    add_wrapped_text({
                        text: full_caption,
                        text_start: BOUNDS.left,
                        available_width: LINE_WIDTH,
                        align: 'center',
                        text_size: 14 * UNITS.pt2px, // Should be 12pt and halfbold
                    });
                    // Y_OFFSET is advanced within add_wrapped_text
                }

                // Add standard spacing after the image/caption block (sync operation)
                Y_OFFSET += 6 * UNITS.mm2px;
                // --- End Layout Calculation and Placement ---

                break; // End case Token.image
                // }}}
            }

            case Token.ordered_list:
            case Token.unordered_list: {
                // {{{
                const isOrdered = node.name === Token.ordered_list;
                list_counters[isOrdered ? 'ordered' : 'unordered'] = []; // Reset counters

                for (const itemNode of node.children) {
                    if (itemNode.name !== Token.list_item) continue;

                    const level = parseInt(itemNode.attributes.level || '1', 10);
                    const itemContent = itemNode.children?.[0]?.attributes?.content || '';
                    let list_char = "";
                    let counter_array = list_counters[isOrdered ? 'ordered' : 'unordered'];

                    while (counter_array.length < level) { counter_array.push(0); }
                    counter_array[level - 1] += 1;
                    for (let l = level; l < counter_array.length; l++) { counter_array[l] = 0; }

                    if (isOrdered) {
                        list_char = counter_array.slice(0, level).join(".") + ".";
                    } else {
                        list_char = '–'
                    }

                    const bullet_x = BOUNDS.left + OFFSETS.list_base;
                    const text_x = BOUNDS.left + OFFSETS.list_text;
                    const text_available_width = WIDTH - text_x - BOUNDS.right;

                    ensure_bounds();

                    svgs.at(-1).children.push({
                        type: "text",
                        attributes: {
                            x: `${bullet_x}px`,
                            y: `${Y_OFFSET}px`,
                            "font-size": `${current_text_size}px`,
                            "font-family": "Times New Roman",
                        },
                        text: list_char,
                    });

                    const linesAdded = add_wrapped_text({ text: itemContent, text_start: text_x, available_width: text_available_width });
                    if (linesAdded === 0) {
                        Y_OFFSET += current_text_size * 1.5;
                    }
                }
                Y_OFFSET += TEXT_SIZE * 0.5;
                break;
                // }}}
            }

            case Token.codeblock: {
                // {{{
                const lang = node.attributes.language;
                const codeFontFamily = 'Courier New, monospace';
                const codeFontSize = TEXT_SIZE * 0.9;
                const codeLineHeight = codeFontSize * 1.3;
                const blockPadding = 5 * UNITS.mm2px;

                ensure_bounds();
                const startY = Y_OFFSET;
                Y_OFFSET += blockPadding;

                for(const lineNode of node.children) {
                    if (lineNode.name !== Token.code_line) continue;
                    const lineContent = lineNode.attributes.content || '';
                    ensure_bounds();
                    svgs.at(-1).children.push({
                        type: "text",
                        attributes: {
                            x: `${BOUNDS.left + OFFSETS.paragraph}px`,
                            y: `${Y_OFFSET}px`,
                            "font-size": `${codeFontSize}px`,
                            "font-family": codeFontFamily,
                            "xml:space": "preserve",
                        },
                        text: lineContent.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>'),
                    });
                    Y_OFFSET += codeLineHeight;
                }
                Y_OFFSET += blockPadding;
                // Optional background rect logic would go here
                Y_OFFSET += TEXT_SIZE * 0.5;
                break;
                // }}}
            }

            case Token.table: {
                // {{{
                //console.warn("Basic Table Rendering: Borders, column widths, and advanced formatting not implemented.");
                const tableFontFamily = 'Times New Roman';
                const tableFontSize = TEXT_SIZE * 0.9;
                const tableLineHeight = tableFontSize * 1.4;
                const cellPadding = 2 * UNITS.mm2px;
                const firstRowCells = node.children?.[0]?.children?.length || 1;
                const colWidth = (LINE_WIDTH - OFFSETS.paragraph) / Math.max(1, firstRowCells);

                Y_OFFSET += TEXT_SIZE * 0.5;

                for (const rowNode of node.children) {
                    if (rowNode.name !== Token.table_row) continue;
                    let maxRowHeight = 0;
                    let cellX = BOUNDS.left + OFFSETS.paragraph;
                    const startYForRow = Y_OFFSET;

                    for (let c = 0; c < rowNode.children.length; c++) {
                        const cellNode = rowNode.children[c];
                        if (cellNode.name !== Token.table_cell) continue;
                        const cellContent = cellNode.attributes.content || '';
                        ensure_bounds();
                        svgs.at(-1).children.push({
                            type: "text",
                            attributes: {
                                x: `${cellX + cellPadding}px`,
                                y: `${Y_OFFSET + tableFontSize}px`,
                                "font-size": `${tableFontSize}px`,
                                "font-family": tableFontFamily,
                            },
                            text: cellContent,
                        });
                        maxRowHeight = Math.max(maxRowHeight, tableLineHeight);
                        cellX += colWidth;
                    }
                    Y_OFFSET = startYForRow + maxRowHeight;
                }
                Y_OFFSET += TEXT_SIZE * 0.5;
                break;
                // }}}
            }

            default:
                //console.warn(`Unhandled node type: ${node.name}`);
                break;
        }
        // Ensure bounds after processing each top-level node? Maybe not needed if handled within blocks.
        // ensure_bounds();
    } // End of main node loop


    // --- Final Page Number ---
    if (last_heading_was_numbered && svgs.at(-1).children.length > 0) {
        svgs.at(-1).children.push(get_page_enum(page_count));
    }

    // --- TOC Generation ---
    if (TOC_PAGE_INDEX !== -1 && TOC_PAGE_INDEX < svgs.length) {
        const tocPage = svgs[TOC_PAGE_INDEX];
        // Reset Y_OFFSET specifically for drawing TOC content
        let tocYOffset = BOUNDS.top;

        const TOC_HEADING = "СОДЕРЖАНИЕ";
        tocPage.children.push({
            type: "text",
            attributes: {
                x: `${WIDTH/2 - text_width(TOC_HEADING)/2}px`,
                y: `${tocYOffset}px`,
                "font-size": `${TEXT_SIZE}px`,
                "font-family": "Times New Roman",
                "font-weight": "bold",
            },
            text: TOC_HEADING,
        });
        tocYOffset += TEXT_SIZE * 2.0;

        const toc_line_width = LINE_WIDTH;
        const dot_width = text_width(".", TEXT_SIZE);

        for (let i = 0; i < TOC.length; i++) {
            // Need a separate ensure_bounds check for TOC page content height
            if (tocYOffset >= HEIGHT - BOUNDS.bottom - TEXT_SIZE) {
                // Handle TOC spanning multiple pages if necessary (complex)
                //console.warn("TOC content exceeds single page height - not fully handled.");
                break; // Stop adding entries if page full
            }

            const entry = TOC[i];
            const page_num_str = entry.page !== -1 ? `${entry.page}` : '??';
            const textWidth = text_width(entry.text, TEXT_SIZE);
            const pageNumWidth = text_width(page_num_str, TEXT_SIZE);
            const space_for_dots = toc_line_width - textWidth - pageNumWidth;
            const num_dots = Math.max(0, Math.floor(space_for_dots / dot_width) + 1);
            const dots = '.'.repeat(num_dots);
            const dot_spacing = space_for_dots / num_dots

            tocPage.children.push({ /* Entry text */
                type: "text", attributes: { x: `${BOUNDS.left}px`, y: `${tocYOffset}px`, "font-size": `${TEXT_SIZE}px`, "font-family": "Times New Roman" }, text: entry.text,
            });
            tocPage.children.push({ /* Dots */
                type: "text", attributes: { x: `${BOUNDS.left + textWidth}px`, y: `${tocYOffset}px`, "font-size": `${TEXT_SIZE}px`, "font-family": "Times New Roman", "letter-spacing": `${dot_spacing-dot_width}px` }, text: dots,
            });
            tocPage.children.push({ /* Page number */
                type: "text", attributes: { x: `${WIDTH - BOUNDS.right - pageNumWidth}px`, y: `${tocYOffset}px`, "font-size": `${TEXT_SIZE}px`, "font-family": "Times New Roman" }, text: page_num_str,
            });
            tocYOffset += TEXT_SIZE * 1.5;
        }
    } else if (TOC_PAGE_INDEX !== -1) {
        console.error("TOC page index is set but out of bounds!");
    }

    // Return the generated svgs array (potentially with placeholder image heights)
    return svgs;
}
