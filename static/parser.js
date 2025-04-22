/**
 * A parser for report documents based on the given BNF.
 * Produces a JSON tree of nodes: { name, attributes, children }.
 * Does not use regular expressions.
 */

/**
 * @typedef {Object} Node
 * @property {string} name - The name of the node.
 * @property {Object<string, string>} attributes - A collection of attributes for the node.
 * @property {Node[]} children - Child nodes of this node.
 */

/**
 * Parse the entire report text into a list of Nodes.
 * @param {string} text - The raw report document text.
 * @returns {Node[]} Array of top-level nodes in the report.
 */
export function parseReport(text) {
    const lines = text.split("\n");
    const parser = new Parser(lines);
    return parser.parse();
}

class Parser {
    constructor(lines) {
        this.lines = lines;
        this.pos = 0;
    }

    /**
     * Process all lines and generate AST nodes.
     * @returns {Node[]} Array of parsed nodes.
     */
    parse() {
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
                case this.isHeading(line):    node = this.parseHeading();   break;
                case this.isImage(line):      node = this.parseImage();     break;
                case this.isCodeBlock(line):  node = this.parseCodeBlock(); break;
                case this.isTableStart(line): node = this.parseTable();     break;
                case this.isListItem(line):   node = this.parseList();      break;
                default:                      node = this.parseParagraph(); break;
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
    isHeading(line) {
        return line.charAt(0) === '#';
    }

    /**
     * Parse a heading line into a Node.
     * @returns {Node}
     */
    parseHeading() {
        const line = this.lines[this.pos++];
        let name = 'heading';
        let level = 0;

        // Unnumbered headings (#@ or #%)
        if (line.startsWith('#@') || line.startsWith('#%')) {
            const text = line.substring(2).trim();
            return {
                name,
                attributes: { numbered: 'false', type: line.charAt(1) },
                children: [{ name: 'text', attributes: { content: text }, children: [] }]
            };
        }

        // Numbered headings: count '#'
        while (line.charAt(level) === '#') level++;
        const text = line.substring(level).trim();

        return {
            name,
            attributes: { numbered: 'true', level: level.toString() },
            children: [{ name: 'text', attributes: { content: text }, children: [] }]
        };
    }

    /**
     * Check if a line is an image declaration.
     * @param {string} line
     * @returns {boolean}
     */
    isImage(line) {
        return line.startsWith('image::');
    }

    /**
     * Parse an image declaration into a Node.
     * @returns {Node}
     */
    parseImage() {
        const line = this.lines[this.pos++];
        const start = 'image::'.length;
        const brackOpen = line.indexOf('[', start);
        const path = brackOpen >= 0 ? line.substring(start, brackOpen) : '';
        const brackClose = line.indexOf(']', brackOpen);
        const caption = (brackOpen >= 0 && brackClose > brackOpen)
            ? line.substring(brackOpen + 1, brackClose)
            : '';
        return {
            name: 'image',
            attributes: { path, caption },
            children: []
        };
    }

    /**
     * Check if a line starts a fenced code block.
     * @param {string} line
     * @returns {boolean}
     */
    isCodeBlock(line) {
        return line.startsWith('```');
    }

    /**
     * Parse a fenced code block into a Node.
     * @returns {Node}
     */
    parseCodeBlock() {
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
            name: 'codeblock',
            attributes: { language: lang },
            children: contentLines.map(line => ({ name: 'code-line', attributes: { content: line }, children: [] }))
        };
    }

    /**
     * Check if a line is the start of a table or options.
     * @param {string} line
     * @returns {boolean}
     */
    isTableStart(line) {
        return line.startsWith('[') || line === '|===';
    }

    /**
     * Check if a given character is considered whitespace
     * @param {string} char
     * @returns {boolean}
     */
    isSpace(char) {
        return char === " " || char === "\t" || char === "\r" || char === "\n";
    }

    /**
     * Parse table options string into an object.
     * @param {string} text
     * @returns {Object<string, string>}
     */
    parseOptions(text) {
        // {{{
        // SYNTAX ::= [key1=val1, key2="val2", ...]
        if (text[0] != `[` || text[text.length-1] != ']') { console.error("Incorrect attribute input:", text); return {} }

        let options = { "boolean": "" };
        let key = ""
        let value = ""
        for (let i = 1; i < text.length-2; i += 1) {
            // KEY
            while (this.isSpace(text[i]) && i < text.length-1) { i += 1 }
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
            while (this.isSpace(text[i]) && i < text.length-1) { i += 1 }
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
        // }}}
    }

    /**
     * Parse a table block into a Node.
     * @returns {Node}
     */
    parseTable() {
        let options = {};
        if (this.lines[this.pos].startsWith('[')) {
            options = this.parseOptions(this.lines[this.pos++]);
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
            name: 'table',
            attributes: options,
            children: rows.map(cells => ({
                name: 'table-row',
                attributes: {},
                children: cells.map(cell => ({ name: 'table-cell', attributes: { content: cell }, children: [] }))
            }))
        };
    }

    /**
     * Check if a line is a list item (ordered or unordered).
     * @param {string} line
     * @returns {boolean}
     */
    isListItem(line) {
        return line.startsWith('- ') || line.startsWith('. ');
    }

    /**
     * Parse a sequence of list items into a list Node.
     * @returns {Node}
     */
    parseList() {
        const isOrdered = this.lines[this.pos].startsWith('. ');
        const items = [];
        while (this.pos < this.lines.length && this.isListItem(this.lines[this.pos])) {
            const line = this.lines[this.pos++];
            const text = line.substring(2).trim();
            items.push({ name: 'list-item', attributes: {}, children: [{ name: 'text', attributes: { content: text }, children: [] }] });
        }
        return { name: isOrdered ? 'ordered-list' : 'unordered-list', attributes: {}, children: items };
    }

    /**
     * Parse one or more lines into a paragraph Node.
     * @returns {Node}
     */
    parseParagraph() {
        const lines = [];
        while (this.pos < this.lines.length) {
            const line = this.lines[this.pos];
            if (line.trim() === '' || this.isHeading(line) || this.isImage(line)
                || this.isCodeBlock(line) || this.isTableStart(line) || this.isListItem(line)) break;
            lines.push(line.trim());
            this.pos++;
        }
        const content = lines.join(' ');
        return { name: 'paragraph', attributes: {}, children: [{ name: 'text', attributes: { content }, children: [] }] };
    }
}
