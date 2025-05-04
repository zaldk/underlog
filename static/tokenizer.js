/**
 * A tokenizer for report documents.
 * Produces a JSON tree of nodes: { name, attributes, children }.
 */

import { Token } from './common.js'

/**
 * @typedef {Object} Node
 * @property {string} name - The name of the node.
 * @property {Object<string, string>} attributes - A collection of attributes for the node.
 * @property {Node[]} children - Child nodes of this node.
 */

/**
 * Tokenize the entire report text into a list of Nodes.
 * @param {string} text - The raw report document text.
 * @returns {Node[]} Array of top-level nodes in the report.
 */
export function tokenizeReport(text) {
    const lines = text.split("\n");
    const tokenizer = new Tokenizer(lines);
    return tokenizer.tokenize();
}

class Tokenizer {
    constructor(lines) {
        this.lines = lines;
        this.pos = 0;
    }

    /**
     * Process all lines and generate AST nodes.
     * @returns {Node[]} Array of tokenized nodes.
     */
    tokenize() {
        const nodes = [];
        while (this.pos < this.lines.length) {
            const line = this.lines[this.pos];
            if (line.trim() === "") {
                this.pos++;
                continue;
            }

            /** @type {Node} */
            let node;
            switch (true) {
                case this.is_heading(line):     node = this.tokenize_heading();    break;
                case this.is_image(line):       node = this.tokenize_image();      break;
                case this.is_code_block(line):  node = this.tokenize_code_block(); break;
                case this.is_table_start(line): node = this.tokenize_table();      break;
                case this.is_list_item(line):   node = this.tokenize_list();       break;
                default:                        node = this.tokenize_paragraph();  break;
            }

            nodes.push(node);
        }
        return nodes;
    }

    /**
     * Check if a line is a heading.
     * @param {string} line
     * @returns {boolean}
     */
    is_heading(line) {
        return line.charAt(0) === '#';
    }

    /**
     * Tokenize a heading line into a Node.
     * @returns {Node}
     */
    tokenize_heading() {
        const line = this.lines[this.pos++];
        let name = Token.heading;
        let level = 0;

        // Unnumbered headings (#@ or #%)
        if (line.startsWith('#@') || line.startsWith('#%')) {
            const text = line.substring(2).trim();
            return {
                name,
                attributes: { numbered: 'false', type: line.charAt(1) },
                children: [{ name: Token.text, attributes: { content: text }, children: [] }]
            };
        }

        // Numbered headings: count '#'
        while (line.charAt(level) === '#') level++;
        const text = line.substring(level).trim();

        return {
            name,
            attributes: { numbered: 'true', level: level.toString() },
            children: [{ name: Token.text, attributes: { content: text }, children: [] }]
        };
    }

    /**
     * Check if a line is an image declaration.
     * Expects format: image::image_name[caption]
     * @param {string} line
     * @returns {boolean}
     */
    is_image(line) {
        return line.startsWith('image::');
    }

    /**
     * Tokenize an image declaration into a Node.
     * Extracts image name (key for IndexedDB) and caption.
     * @returns {Node}
     */
    tokenize_image() {
        const line = this.lines[this.pos++];
        const start = 'image::'.length;
        const brackOpen = line.indexOf('[', start);
        // Extract the name (identifier) between 'image::' and '[' or end of line
        const image_name = (brackOpen >= 0 ? line.substring(start, brackOpen) : line.substring(start)).trim();
        const brackClose = line.indexOf(']', brackOpen);
        const caption = (brackOpen >= 0 && brackClose > brackOpen)
            ? line.substring(brackOpen + 1, brackClose)
            : '';
        return {
            name: Token.image,
            attributes: { name: image_name, caption },
            children: []
        };
    }

    /**
     * Check if a line starts a fenced code block.
     * @param {string} line
     * @returns {boolean}
     */
    is_code_block(line) {
        return line.startsWith('```');
    }

    /**
     * Tokenize a fenced code block into a Node.
     * @returns {Node}
     */
    tokenize_code_block() {
        const startLine = this.lines[this.pos++];
        const lang = startLine.length > 3
            ? startLine.substring(3).trim()
            : '';

        const contentLines = [];
        while (this.pos < this.lines.length && !this.lines[this.pos].startsWith('```')) {
            contentLines.push(this.lines[this.pos++]);
        }
        if (this.pos < this.lines.length) this.pos++;

        return {
            name: Token.codeblock,
            attributes: { language: lang },
            children: contentLines.map(line => ({ name: 'code-line', attributes: { content: line }, children: [] }))
        };
    }

    /**
     * Check if a line is the start of a table or options.
     * @param {string} line
     * @returns {boolean}
     */
    is_table_start(line) {
        return line.startsWith('[') || line === '|===';
    }

    /**
     * Check if a given character is considered whitespace
     * @param {string} char
     * @returns {boolean}
     */
    is_space(char) {
        return char === " " || char === "\t" || char === "\r" || char === "\n";
    }

    /**
     * Tokenize table options string into an object.
     * @param {string} text
     * @returns {Object<string, string>}
     */
    tokenize_options(text) {
        // SYNTAX ::= [key1=val1, key2="val2", ...]
        if (text[0] != `[` || text[text.length-1] != ']') { console.error("Incorrect attribute input:", text); return {} }

        let options = { "boolean": "" };
        let key = ""
        let value = ""
        for (let i = 1; i < text.length-2; i += 1) {
            // KEY
            while (this.is_space(text[i]) && i < text.length-1) { i += 1 }
            for (; text[i] !== "=" && i < text.length-1; i += 1) {
                if (text[i] === ",") {
                    if (key.trim() !== '') {
                        options.boolean += key.trim() + ";";
                        key = '';
                    }
                    continue
                }
                key += text[i];
            }
            i += 1;
            key = key.trim();

            // VALUE
            // if starts with `"` then loop until `"`
            // otherwise loop until `,`
            while (this.is_space(text[i]) && i < text.length-1) { i += 1 }
            if (text[i] === `"`) {
                i += 1;
                for (; text[i] !== `"` && i < text.length-1; i += 1) {
                    value += text[i];
                }
            } else {
                for (; text[i] !== `,` && i < text.length-1; i += 1) {
                    value += text[i];
                }
            }
            value = value.trim();

            if (value.length > 0) {
                options[key] = value;
            } else {
                options.boolean += key;
            }

            key = ''; value = '';
        }
        return options;
    }

    /**
     * Tokenize a table block into a Node.
     * @returns {Node}
     */
    tokenize_table() {
        let options = {};
        if (this.lines[this.pos].startsWith('[')) {
            options = this.tokenize_options(this.lines[this.pos++]);
        }
        if (this.lines[this.pos] === '|===') this.pos++;

        const rows = [];
        while (this.pos < this.lines.length && this.lines[this.pos] !== '|===') {
            const rowLine = this.lines[this.pos++];
            if (!rowLine.startsWith('|')) continue;
            const cells = [];
            let idx = 1;
            while (idx < rowLine.length) {
                const next = rowLine.indexOf('|', idx);
                if (next < 0) { cells.push(rowLine.substring(idx).trim()); break; }
                cells.push(rowLine.substring(idx, next).trim());
                idx = next + 1;
            }
            rows.push(cells);
        }
        if (this.pos < this.lines.length) this.pos++;

        return {
            name: Token.table,
            attributes: options,
            children: rows.map(cells => ({
                name: Token.table_row,
                attributes: {},
                children: cells.map(cell => ({ name: Token.table_cell, attributes: { content: cell }, children: [] }))
            }))
        };
    }

    count_first_chars(text, char) {
        let count = 0;
        for (let i = 0; i < text.length; i++) {
            if (text[i] === char) { count += 1 } else { break }
        }
        return count
    }

    /**
     * Check if a line is a list item (ordered or unordered).
     * @param {string} line
     * @returns {boolean}
     */
    is_list_item(line) {
        const firstChar = line.charAt(0);
        return firstChar === '-' || firstChar === '.';
    }

    /**
     * Tokenize a flat sequence of list items, assigning a level based on repeated symbols.
     * @returns {Node}
     */
    tokenize_list() {
        const char = this.lines[this.pos].charAt(0);
        const isOrdered = char === '.';
        const items = [];

        while (this.pos < this.lines.length && this.is_list_item(this.lines[this.pos])) {
            const line = this.lines[this.pos++];
            const level = this.count_first_chars(line, char);
            const content = line.slice(level).trim();

            items.push({
                name: 'list-item',
                attributes: { level: level.toString() },
                children: [
                    {
                        name: 'text',
                        attributes: { content },
                        children: []
                    }
                ]
            });
        }

        return {
            name: isOrdered ? 'ordered-list' : 'unordered-list',
            attributes: {},
            children: items
        };
    }

    /**
     * Tokenize one or more lines into a paragraph Node.
     * @returns {Node}
     */
    tokenize_paragraph() {
        const lines = [];
        while (this.pos < this.lines.length) {
            const line = this.lines[this.pos];
            if (line.trim() === '' || this.is_heading(line) || this.is_image(line)
                || this.is_code_block(line) || this.is_table_start(line) || this.is_list_item(line)) break;
            lines.push(line.trim());
            this.pos++;
        }
        const content = lines.join(' ');
        return { name: Token.paragraph, attributes: {}, children: [{ name: Token.text, attributes: { content }, children: [] }] };
    }
}
