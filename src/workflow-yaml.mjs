import { httpError } from './security.mjs';

// A deliberately small YAML subset for KukGit workflow files.
//
// Full YAML is a large language with features that are actively dangerous in a
// file that describes what a build server will execute: anchors and aliases can
// expand a small document into a huge one, merge keys hide where a value came
// from, and arbitrary tags invite type-directed parsing. None of that is needed
// to describe jobs and steps, so none of it is accepted. Everything rejected here
// is rejected loudly, with a line number, rather than silently reinterpreted.
//
// Supported: block mappings, block sequences, flow sequences and mappings on one
// line, plain and quoted scalars, literal (`|`) and folded (`>`) block scalars
// with chomping indicators, comments, and the null/boolean/number scalars.

export const WORKFLOW_YAML_LIMITS = {
  maxBytes: 128 * 1024,
  maxLines: 4000,
  maxDepth: 12,
  maxNodes: 5000,
  maxLineLength: 4000,
};

const NULL_WORDS = new Set(['', '~', 'null', 'Null', 'NULL']);
const TRUE_WORDS = new Set(['true', 'True', 'TRUE']);
const FALSE_WORDS = new Set(['false', 'False', 'FALSE']);
const INTEGER = /^[-+]?(0|[1-9][0-9]*)$/;
const FLOAT = /^[-+]?(0|[1-9][0-9]*)\.[0-9]+$/;
const BLOCK_SCALAR_HEADER = /^([|>])([-+]?)$/;

function fail(line, message, code = 'WORKFLOW_YAML_INVALID') {
  throw httpError(400, `Line ${line}: ${message}`, code);
}

// Finds the end of the content on a line by locating an unquoted `#` that begins
// a comment. A `#` inside a quoted scalar, or one not preceded by whitespace, is
// ordinary text.
function stripComment(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\' && quote === '"') { index += 1; continue; }
      if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") { index += 1; continue; }
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#' && (index === 0 || /\s/.test(text[index - 1]))) {
      return text.slice(0, index).replace(/\s+$/, '');
    }
  }
  return text.replace(/\s+$/, '');
}

// Locates the `:` that separates a mapping key from its value: the first one at
// depth zero followed by whitespace or end of line. Returns -1 when the line is
// not a mapping entry.
function keySeparator(text) {
  let quote = null;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\' && quote === '"') { index += 1; continue; }
      if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") { index += 1; continue; }
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '[' || char === '{') { depth += 1; continue; }
    if (char === ']' || char === '}') { depth -= 1; continue; }
    if (char === ':' && depth === 0 && (index === text.length - 1 || /\s/.test(text[index + 1]))) {
      return index;
    }
  }
  return -1;
}

function decodeDoubleQuoted(raw, line) {
  let out = '';
  for (let index = 1; index < raw.length - 1; index += 1) {
    const char = raw[index];
    if (char !== '\\') { out += char; continue; }
    const next = raw[index + 1];
    index += 1;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') out += '\r';
    else if (next === '"') out += '"';
    else if (next === '\\') out += '\\';
    else if (next === '/') out += '/';
    else if (next === '0') out += '\0';
    else if (next === 'u') {
      const hex = raw.slice(index + 1, index + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(line, 'invalid \\u escape in a double-quoted scalar.');
      out += String.fromCharCode(parseInt(hex, 16));
      index += 4;
    } else fail(line, `unsupported escape '\\${next}' in a double-quoted scalar.`);
  }
  return out;
}

function decodeScalar(raw, line, { quotedOnly = false } = {}) {
  const text = raw.trim();
  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"')) fail(line, 'unterminated double-quoted scalar.');
    return decodeDoubleQuoted(text, line);
  }
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'")) fail(line, 'unterminated single-quoted scalar.');
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (quotedOnly) return text;

  // Constructs that change how a document is interpreted are refused rather than
  // read as text, so a workflow never means something other than it looks like.
  if (text.startsWith('&')) fail(line, 'YAML anchors are not supported in workflow files.', 'WORKFLOW_YAML_ANCHOR_UNSUPPORTED');
  if (text.startsWith('*')) fail(line, 'YAML aliases are not supported in workflow files.', 'WORKFLOW_YAML_ALIAS_UNSUPPORTED');
  if (text.startsWith('!')) fail(line, 'YAML tags are not supported in workflow files.', 'WORKFLOW_YAML_TAG_UNSUPPORTED');

  if (NULL_WORDS.has(text)) return null;
  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;
  if (INTEGER.test(text)) return Number(text);
  if (FLOAT.test(text)) return Number(text);
  return text;
}

// Splits a flow collection body on commas that are not inside quotes or a nested
// collection.
function splitFlow(body, line) {
  const parts = [];
  let current = '';
  let quote = null;
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      current += char;
      if (char === '\\' && quote === '"') { current += body[index + 1] ?? ''; index += 1; continue; }
      if (char === quote) {
        if (quote === "'" && body[index + 1] === "'") { current += "'"; index += 1; continue; }
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === '[' || char === '{') depth += 1;
    if (char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += char;
  }
  if (quote) fail(line, 'unterminated quoted scalar in a flow collection.');
  if (depth !== 0) fail(line, 'unbalanced brackets in a flow collection.');
  if (current.trim()) parts.push(current);
  else if (parts.length) fail(line, 'trailing comma in a flow collection.');
  return parts;
}

function parseFlow(text, line, depth, budget) {
  budget.spend(line);
  if (depth > WORKFLOW_YAML_LIMITS.maxDepth) fail(line, 'workflow nesting is too deep.', 'WORKFLOW_YAML_TOO_DEEP');
  const trimmed = text.trim();

  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) fail(line, 'unterminated flow sequence.');
    return splitFlow(trimmed.slice(1, -1), line).map((part) => parseFlow(part, line, depth + 1, budget));
  }
  if (trimmed.startsWith('{')) {
    if (!trimmed.endsWith('}')) fail(line, 'unterminated flow mapping.');
    const result = {};
    for (const part of splitFlow(trimmed.slice(1, -1), line)) {
      const separator = keySeparator(part);
      if (separator < 0) fail(line, 'a flow mapping entry must be written as key: value.');
      const key = decodeScalar(part.slice(0, separator), line, { quotedOnly: true });
      if (!key) fail(line, 'a flow mapping key must not be empty.');
      if (Object.hasOwn(result, key)) fail(line, `duplicate key '${key}'.`, 'WORKFLOW_YAML_DUPLICATE_KEY');
      result[key] = parseFlow(part.slice(separator + 1), line, depth + 1, budget);
    }
    return result;
  }
  return decodeScalar(trimmed, line);
}

function scan(text) {
  return text.split('\n').map((raw, index) => {
    const line = index + 1;
    if (raw.length > WORKFLOW_YAML_LIMITS.maxLineLength) fail(line, 'line is too long.', 'WORKFLOW_YAML_LINE_TOO_LONG');
    const indent = /^[ ]*/.exec(raw)[0].length;
    // A tab in the indentation is a classic silent-misparse source; YAML forbids
    // it and so does this parser, with a message that says why.
    if (/^[ ]*\t/.test(raw)) fail(line, 'tabs cannot be used for indentation; use spaces.', 'WORKFLOW_YAML_TAB_INDENT');
    return { line, indent, raw, content: stripComment(raw.slice(indent)) };
  });
}

class Reader {
  constructor(lines) {
    this.lines = lines;
    this.position = 0;
    this.nodes = 0;
  }

  spend(line) {
    this.nodes += 1;
    if (this.nodes > WORKFLOW_YAML_LIMITS.maxNodes) {
      fail(line, 'workflow file contains too many values.', 'WORKFLOW_YAML_TOO_LARGE');
    }
  }

  peek() {
    while (this.position < this.lines.length && this.lines[this.position].content === '') this.position += 1;
    return this.position < this.lines.length ? this.lines[this.position] : null;
  }

  take() {
    const line = this.peek();
    if (line) this.position += 1;
    return line;
  }

  // Re-presents the remainder of a line as its own line, which is how
  // `- key: value` becomes a mapping starting at the column of `key`.
  pushBack(line, indent, content) {
    this.lines.splice(this.position, 0, { line, indent, raw: content, content });
  }
}

function readBlockScalar(reader, parentIndent, header, line) {
  const match = BLOCK_SCALAR_HEADER.exec(header.trim());
  if (!match) fail(line, `unsupported block scalar header '${header.trim()}'.`);
  const [, style, chomping] = match;

  const collected = [];
  let contentIndent = null;
  while (reader.position < reader.lines.length) {
    const candidate = reader.lines[reader.position];
    const blank = candidate.raw.trim() === '';
    if (!blank && candidate.indent <= parentIndent) break;
    reader.position += 1;
    if (blank) { collected.push(''); continue; }
    if (contentIndent === null) contentIndent = candidate.indent;
    if (candidate.indent < contentIndent) fail(candidate.line, 'block scalar line is less indented than the block.');
    // Block scalar content is raw: a `#` here is part of the script, not a
    // comment, and trailing whitespace is preserved.
    collected.push(candidate.raw.slice(contentIndent));
  }

  // Blank lines after the content still belong to the block. Every chomping mode
  // except `+` discards them, so they are counted before being removed.
  let trailingBlanks = 0;
  while (collected.length && collected.at(-1) === '') { collected.pop(); trailingBlanks += 1; }

  let body;
  if (style === '|') {
    body = collected.join('\n');
  } else {
    const folded = [];
    for (const item of collected) {
      if (item === '') { folded.push('\n'); continue; }
      if (folded.length && folded.at(-1) !== '\n') folded.push(' ');
      folded.push(item);
    }
    body = folded.join('');
  }

  if (chomping === '-') return body;
  if (chomping === '+') return body === '' ? '\n'.repeat(trailingBlanks) : `${body}\n${'\n'.repeat(trailingBlanks)}`;
  return body === '' ? '' : `${body}\n`;
}

function parseValue(reader, parentIndent, rest, line, depth) {
  if (BLOCK_SCALAR_HEADER.test(rest.trim())) return readBlockScalar(reader, parentIndent, rest, line);
  if (rest.trim() !== '') return parseFlow(rest, line, depth, reader);

  const next = reader.peek();
  if (!next || next.indent <= parentIndent) return null;
  return parseBlock(reader, next.indent, depth + 1);
}

function parseMapping(reader, indent, depth) {
  const result = {};
  for (;;) {
    const line = reader.peek();
    if (!line || line.indent < indent) break;
    if (line.indent > indent) fail(line.line, 'unexpected indentation.', 'WORKFLOW_YAML_BAD_INDENT');
    if (line.content.startsWith('- ') || line.content === '-') break;

    const separator = keySeparator(line.content);
    if (separator < 0) fail(line.line, 'expected a mapping entry written as key: value.');
    const rawKey = line.content.slice(0, separator);
    if (rawKey.trim() === '<<') fail(line.line, 'YAML merge keys are not supported in workflow files.', 'WORKFLOW_YAML_MERGE_UNSUPPORTED');
    if (rawKey.trim().startsWith('?')) fail(line.line, 'complex mapping keys are not supported in workflow files.');
    const key = decodeScalar(rawKey, line.line, { quotedOnly: true });
    if (!key) fail(line.line, 'a mapping key must not be empty.');
    if (Object.hasOwn(result, key)) fail(line.line, `duplicate key '${key}'.`, 'WORKFLOW_YAML_DUPLICATE_KEY');

    reader.take();
    reader.spend(line.line);
    result[key] = parseValue(reader, indent, line.content.slice(separator + 1), line.line, depth);
  }
  return result;
}

function parseSequence(reader, indent, depth) {
  const items = [];
  for (;;) {
    const line = reader.peek();
    if (!line || line.indent < indent) break;
    if (line.indent > indent) fail(line.line, 'unexpected indentation.', 'WORKFLOW_YAML_BAD_INDENT');
    if (line.content !== '-' && !line.content.startsWith('- ')) break;

    const rest = line.content === '-' ? '' : line.content.slice(2);
    reader.take();
    reader.spend(line.line);

    if (rest.trim() === '') {
      const next = reader.peek();
      items.push(!next || next.indent <= indent ? null : parseBlock(reader, next.indent, depth + 1));
      continue;
    }
    if (BLOCK_SCALAR_HEADER.test(rest.trim())) {
      items.push(readBlockScalar(reader, indent, rest, line.line));
      continue;
    }
    // `- key: value` starts a mapping whose entries line up under `key`.
    if (!rest.trimStart().startsWith('[') && !rest.trimStart().startsWith('{') && keySeparator(rest) >= 0) {
      const contentIndent = indent + 2 + (rest.length - rest.trimStart().length);
      reader.pushBack(line.line, contentIndent, rest.trim());
      items.push(parseMapping(reader, contentIndent, depth + 1));
      continue;
    }
    items.push(parseFlow(rest, line.line, depth, reader));
  }
  return items;
}

function parseBlock(reader, indent, depth) {
  if (depth > WORKFLOW_YAML_LIMITS.maxDepth) {
    fail(reader.peek()?.line ?? 0, 'workflow nesting is too deep.', 'WORKFLOW_YAML_TOO_DEEP');
  }
  const line = reader.peek();
  if (!line) return null;
  return (line.content === '-' || line.content.startsWith('- '))
    ? parseSequence(reader, indent, depth)
    : parseMapping(reader, indent, depth);
}

/**
 * Parses a workflow file written in the supported YAML subset.
 *
 * Throws a structured 400 with the offending line number for anything outside
 * the subset. It never returns a partially understood document.
 */
export function parseWorkflowYaml(source) {
  const text = String(source ?? '');
  if (Buffer.byteLength(text) > WORKFLOW_YAML_LIMITS.maxBytes) {
    throw httpError(413, 'Workflow file is too large.', 'WORKFLOW_YAML_TOO_LARGE');
  }
  if (text.includes('\0')) throw httpError(400, 'Workflow file contains a null byte.', 'WORKFLOW_YAML_INVALID');

  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = scan(normalized);
  if (lines.length > WORKFLOW_YAML_LIMITS.maxLines) {
    throw httpError(413, 'Workflow file has too many lines.', 'WORKFLOW_YAML_TOO_LARGE');
  }

  for (const line of lines) {
    if (line.content === '---' && line.line !== lines.find((item) => item.content !== '')?.line) {
      fail(line.line, 'multiple YAML documents are not supported in a workflow file.', 'WORKFLOW_YAML_MULTI_DOCUMENT');
    }
    if (line.content === '...') {
      fail(line.line, 'YAML document end markers are not supported in a workflow file.', 'WORKFLOW_YAML_MULTI_DOCUMENT');
    }
  }

  const reader = new Reader(lines.filter((line) => line.content !== '---'));
  const first = reader.peek();
  if (!first) throw httpError(400, 'Workflow file is empty.', 'WORKFLOW_YAML_EMPTY');
  if (first.indent !== 0) fail(first.line, 'the workflow document must start at column 1.', 'WORKFLOW_YAML_BAD_INDENT');

  const document = parseBlock(reader, 0, 0);
  const trailing = reader.peek();
  if (trailing) fail(trailing.line, 'unexpected content after the end of the document.');
  return document;
}
