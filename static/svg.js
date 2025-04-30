import { Token } from './common.js'; // Assuming Token is in common.js

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
const FIRST_LINE_WIDTH = WIDTH - BOUNDS.left - BOUNDS.right - OFFSETS.paragraph;
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
            result += `>\n`
            result += `${child.text}\n`
            result += `</text>\n`
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

const IMAGE_HEIGHT_CACHE = {};
/**
 * Gets image dimensions, potentially asynchronously.
 * Uses a cache and triggers a callback when dimensions are finalized (either from cache or after loading).
 *
 * @param {string} url - The URL of the image.
 * @returns {[number, number] | null} Returns dimensions [width, height] if already cached, otherwise null.
 */
function getImageHeight(url) {
    const cachedDimensions = IMAGE_HEIGHT_CACHE[url];

    // 1. Already cached (and not a promise)? Return dimensions immediately.
    if (Array.isArray(cachedDimensions)) {
        // Make sure it's the final dimensions array, not the error marker [0,0] initially set on error?
        // Or assume cache only holds valid dimensions or promises.
        if (cachedDimensions.length === 2 && cachedDimensions[0] > 0) {
            // console.log(`Cache hit for ${url}:`, cachedDimensions);
            return cachedDimensions;
        }
        // If cache holds [0,0] error marker, treat as uncached for initial return,
        // but the promise logic below will prevent re-fetching if error already occurred.
    }

    // 2. Loading already in progress? Return null for now, callback will trigger later.
    if (cachedDimensions instanceof Promise) {
        // console.log(`Cache hit (Promise) for ${url}`);
        // The promise is already running.
        return null;
    }

    // 3. Not cached and not loading? Start loading.
    // console.log(`Cache miss for ${url}, starting load.`);
    const promise = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const dimensions = [img.width, img.height];
            IMAGE_HEIGHT_CACHE[url] = dimensions; // Cache dimensions
            // console.log(`Loaded ${url}:`, dimensions);
            img.remove();
            resolve(dimensions);
        };
        img.onerror = (err) => {
            console.error(`Failed to load image: ${url}`, err);
            IMAGE_HEIGHT_CACHE[url] = [0, 0]; // Cache error state (e.g., [0,0])
            img.remove();
            reject(new Error(`Failed to load image ${url}`));
        };
        img.src = url;
    }).then(
        (dimensions) => {
            // Success: Trigger the update callback
            return dimensions; // Pass dimensions along if chained
        },
        (error) => {
            // Error: Still trigger the update callback (maybe to show error state)
            throw error; // Re-throw error if needed elsewhere
        }
    );

    // Store the promise in the cache immediately to prevent duplicate requests
    IMAGE_HEIGHT_CACHE[url] = promise;

    // Return null because dimensions are not available *yet*.
    return null;
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
export function parse(nodes) {
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

    const addWrappedText = ({
        text,
        text_start,
        available_width,
        first_line_indent = 0,
        align = 'left',
        text_size = TEXT_SIZE,
        weight = 'normal'
    }) => {
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


    // --- Main Rendering Loop (Synchronous) ---
    heading_counters = [];

    for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i];
        let current_text_size = TEXT_SIZE;

        // Switch statement for node.name
        switch (node.name) {
            // ... (cases for paragraph, heading, lists, code, table) ...
            case Token.paragraph: {
                const textContent = node.children?.[0]?.attributes?.content || '';
                addWrappedText({ text: textContent, text_start: BOUNDS.left, available_width: LINE_WIDTH, first_line_indent: OFFSETS.paragraph });
                break;
            }

            case Token.heading: {
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
                addWrappedText({ text: final_text, text_start: BOUNDS.left, available_width: LINE_WIDTH, first_line_indent: OFFSETS.paragraph, align, weight: 'bold', text_size: current_text_size });
                Y_OFFSET += current_text_size * 0.5;
                break;
            }


            case Token.image: {
                const path = node.attributes.path;
                const caption = node.attributes.caption || '';
                let requested_width_percent = 50; // Default or parse from attrs if available

                const target_width_px = LINE_WIDTH * (requested_width_percent / 100);
                let image_height_px; // Will hold final or placeholder height

                // Call modified getImageHeight
                const dimensions = getImageHeight(path);

                if (dimensions) {
                    // Cache hit: Use actual dimensions
                    image_height_px = target_width_px * (dimensions[1] / dimensions[0]);
                } else {
                    // Cache miss or loading: Use placeholder height
                    console.warn(`Using placeholder height for ${path}`);
                    image_height_px = target_width_px * 0.25; // Default aspect ratio guess
                    // The async loading was started inside getImageHeight
                }

                // Use image_height_px (actual or placeholder) for layout checks and rendering
                const required_height = image_height_px + (caption ? TEXT_SIZE * 2.5 : 0);
                if (Y_OFFSET + required_height > HEIGHT - BOUNDS.bottom) {
                    ensure_bounds(true); // Force new page if placeholder/actual image + caption won't fit
                }

                const img_x = BOUNDS.left + (LINE_WIDTH / 2) - (target_width_px / 2);
                svgs.at(-1).children.push({
                    type: "image",
                    attributes: {
                        x: `${img_x}px`,
                        y: `${Y_OFFSET}px`,
                        width: `${target_width_px}px`,
                        height: `${image_height_px}px`, // Use placeholder or actual height
                        href: path,
                        preserveAspectRatio: "xMidYMin meet",
                    },
                });
                // Crucially, advance Y_OFFSET using the SAME height (placeholder or actual)
                Y_OFFSET += image_height_px + TEXT_SIZE * 0.5;

                if (caption) {
                    image_counter++;
                    const caption_prefix = `Рисунок ${heading_counters[0] !== undefined ? heading_counters[0] : '?'}.${image_counter} – `;
                    const full_caption = caption_prefix + caption;
                    // Use addWrappedText for caption rendering
                    addWrappedText({ text: full_caption, text_start: BOUNDS.left, available_width: LINE_WIDTH, align: 'center' });
                    Y_OFFSET += TEXT_SIZE * 0.5; // Space after caption
                }

                break;
            } // End case Token.image

            case Token.ordered_list:
            case Token.unordered_list: {
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

                    const linesAdded = addWrappedText({ text: itemContent, text_start: text_x, available_width: text_available_width });
                    if (linesAdded === 0) {
                        Y_OFFSET += current_text_size * 1.5;
                    }
                }
                Y_OFFSET += TEXT_SIZE * 0.5;
                break;
            }

            case Token.codeblock: {
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
            }

            case Token.table: {
                // Basic Table Rendering (as before)
                console.warn("Basic Table Rendering: Borders, column widths, and advanced formatting not implemented.");
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
            }

            default:
                console.warn(`Unhandled node type: ${node.name}`);
                break;
        }
        // Ensure bounds after processing each top-level node? Maybe not needed if handled within blocks.
        // ensure_bounds();
    } // End of main node loop


    // --- Final Page Number ---
    if (last_heading_was_numbered && svgs.at(-1).children.length > 0) {
        svgs.at(-1).children.push(get_page_enum(page_count));
    }

    // --- TOC Generation (mostly same as before) ---
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
                console.warn("TOC content exceeds single page height - not fully handled.");
                break; // Stop adding entries if page full
            }

            const entry = TOC[i];
            const page_num_str = entry.page !== -1 ? `${entry.page}` : '??';
            const textWidth = text_width(entry.text, TEXT_SIZE);
            const pageNumWidth = text_width(page_num_str, TEXT_SIZE);
            const space_for_dots = toc_line_width - textWidth - pageNumWidth - (2 * dot_width);
            const num_dots = Math.max(0, Math.floor(space_for_dots / dot_width));
            const dots = '.'.repeat(num_dots);

            tocPage.children.push({ /* Entry text */
                type: "text", attributes: { x: `${BOUNDS.left}px`, y: `${tocYOffset}px`, "font-size": `${TEXT_SIZE}px`, "font-family": "Times New Roman" }, text: entry.text,
            });
            tocPage.children.push({ /* Dots */
                type: "text", attributes: { x: `${BOUNDS.left + textWidth + dot_width}px`, y: `${tocYOffset}px`, "font-size": `${TEXT_SIZE}px`, "font-family": "Times New Roman", "letter-spacing": "1px" }, text: dots,
            });
            tocPage.children.push({ /* Page number */
                type: "text", attributes: { x: `${WIDTH - BOUNDS.right}px`, y: `${tocYOffset}px`, "font-size": `${TEXT_SIZE}px`, "font-family": "Times New Roman" }, text: page_num_str,
            });
            tocYOffset += TEXT_SIZE * 1.5;
        }
    } else if (TOC_PAGE_INDEX !== -1) {
        console.error("TOC page index is set but out of bounds!");
    }

    // Return the generated svgs array (potentially with placeholder image heights)
    return svgs;
}
