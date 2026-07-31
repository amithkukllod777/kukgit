import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflowYaml, WORKFLOW_YAML_LIMITS } from '../src/workflow-yaml.mjs';

function rejects(source, code) {
  assert.throws(() => parseWorkflowYaml(source), (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    assert.equal(error.status, code.endsWith('TOO_LARGE') ? 413 : 400);
    return true;
  });
}

test('block mappings, sequences and scalar types round-trip', () => {
  const document = parseWorkflowYaml([
    'name: CI',
    'count: 3',
    'ratio: 1.5',
    'enabled: true',
    'disabled: false',
    'absent: null',
    'tilde: ~',
    'empty:',
    'quoted: "a: b"',
    "apostrophe: 'it''s fine'",
    'list:',
    '  - one',
    '  - two',
  ].join('\n'));

  assert.deepEqual({ ...document }, {
    name: 'CI',
    count: 3,
    ratio: 1.5,
    enabled: true,
    disabled: false,
    absent: null,
    tilde: null,
    empty: null,
    quoted: 'a: b',
    apostrophe: "it's fine",
    list: ['one', 'two'],
  });
});

test('a dash followed by a key starts a mapping at the key column', () => {
  const document = parseWorkflowYaml([
    'steps:',
    '  - name: First',
    '    run: echo one',
    '  - name: Second',
    '    with:',
    '      key: value',
    '  - plain-scalar',
  ].join('\n'));

  assert.equal(document.steps.length, 3);
  assert.deepEqual({ ...document.steps[0] }, { name: 'First', run: 'echo one' });
  assert.equal(document.steps[1].with.key, 'value');
  assert.equal(document.steps[2], 'plain-scalar');
});

test('flow sequences and mappings parse on one line', () => {
  const document = parseWorkflowYaml([
    'branches: [main, "release/*", 3]',
    'matrix: {os: linux, version: 22}',
    'nested: [[a, b], {k: v}]',
    'empty: []',
  ].join('\n'));

  assert.deepEqual(document.branches, ['main', 'release/*', 3]);
  assert.deepEqual({ ...document.matrix }, { os: 'linux', version: 22 });
  assert.deepEqual(document.nested[0], ['a', 'b']);
  assert.equal(document.nested[1].k, 'v');
  assert.deepEqual(document.empty, []);
});

test('comments are stripped outside quotes but never inside a block scalar', () => {
  const document = parseWorkflowYaml([
    '# leading comment',
    'name: CI  # trailing comment',
    'url: "https://example.test/#anchor"',
    'hash: a#b',
    'script: |',
    '  echo one   # this is shell, not a comment',
    '  echo two',
  ].join('\n'));

  assert.equal(document.name, 'CI');
  assert.equal(document.url, 'https://example.test/#anchor');
  // A `#` that is not preceded by whitespace is ordinary text.
  assert.equal(document.hash, 'a#b');
  assert.equal(document.script, 'echo one   # this is shell, not a comment\necho two\n');
});

test('literal and folded block scalars honour their chomping indicator', () => {
  const document = parseWorkflowYaml([
    'clip: |',
    '  line',
    'strip: |-',
    '  line',
    'keep: |+',
    '  line',
    '',
    '',
    'folded: >',
    '  one',
    '  two',
    '',
    '  four',
  ].join('\n'));

  // Clip keeps one trailing newline, strip keeps none, keep preserves every
  // blank line that followed the content.
  assert.equal(document.clip, 'line\n');
  assert.equal(document.strip, 'line');
  assert.equal(document.keep, 'line\n\n\n');
  assert.equal(document.folded, 'one two\nfour\n');
});

test('a block scalar keeps relative indentation', () => {
  const document = parseWorkflowYaml([
    'script: |',
    '  if true; then',
    '    echo nested',
    '  fi',
  ].join('\n'));
  assert.equal(document.script, 'if true; then\n  echo nested\nfi\n');
});

test('constructs that change how a document is read are refused, not reinterpreted', () => {
  // Each of these silently changes meaning in full YAML, which is exactly what a
  // file describing what a build server executes must not do.
  rejects('base: &anchor\n  a: 1', 'WORKFLOW_YAML_ANCHOR_UNSUPPORTED');
  rejects('a: 1\nb: *anchor', 'WORKFLOW_YAML_ALIAS_UNSUPPORTED');
  rejects('a: !!python/object x', 'WORKFLOW_YAML_TAG_UNSUPPORTED');
  rejects('a:\n  <<: other\n  b: 1', 'WORKFLOW_YAML_MERGE_UNSUPPORTED');
  rejects('a: 1\n---\nb: 2', 'WORKFLOW_YAML_MULTI_DOCUMENT');
  rejects('a: 1\n...', 'WORKFLOW_YAML_MULTI_DOCUMENT');
});

test('tab indentation is rejected with an explanation rather than misparsed', () => {
  assert.throws(() => parseWorkflowYaml('a:\n\tb: 1'), (error) => {
    assert.equal(error.code, 'WORKFLOW_YAML_TAB_INDENT');
    assert.match(error.message, /Line 2/);
    assert.match(error.message, /use spaces/);
    return true;
  });
});

test('structural mistakes are reported with their line number', () => {
  assert.throws(() => parseWorkflowYaml('a: 1\nb: 2\n  c: 3'), (error) => {
    assert.equal(error.code, 'WORKFLOW_YAML_BAD_INDENT');
    assert.match(error.message, /Line 3/);
    return true;
  });
  assert.throws(() => parseWorkflowYaml('a: 1\na: 2'), (error) => {
    assert.equal(error.code, 'WORKFLOW_YAML_DUPLICATE_KEY');
    assert.match(error.message, /Line 2/);
    return true;
  });
  assert.throws(() => parseWorkflowYaml('just a scalar'), (error) => error.status === 400);
  assert.throws(() => parseWorkflowYaml('a: "unterminated'), (error) => error.status === 400);
  assert.throws(() => parseWorkflowYaml('a: [1, 2'), (error) => error.status === 400);
  assert.throws(() => parseWorkflowYaml('a: [1, 2,]'), (error) => error.status === 400);
});

test('an empty or indented-start document is rejected', () => {
  rejects('', 'WORKFLOW_YAML_EMPTY');
  rejects('# only a comment', 'WORKFLOW_YAML_EMPTY');
  assert.throws(() => parseWorkflowYaml('   a: 1'), (error) => error.code === 'WORKFLOW_YAML_BAD_INDENT');
});

test('size limits fail closed instead of expanding a small file into a large one', () => {
  rejects(`a: "${'x'.repeat(WORKFLOW_YAML_LIMITS.maxBytes)}"`, 'WORKFLOW_YAML_TOO_LARGE');
  rejects(Array.from({ length: WORKFLOW_YAML_LIMITS.maxLines + 1 }, (_, i) => `k${i}: 1`).join('\n'), 'WORKFLOW_YAML_TOO_LARGE');

  let deep = 'a: 1';
  for (let level = 0; level <= WORKFLOW_YAML_LIMITS.maxDepth + 2; level += 1) {
    deep = `k${level}:\n${deep.split('\n').map((line) => `  ${line}`).join('\n')}`;
  }
  rejects(deep, 'WORKFLOW_YAML_TOO_DEEP');
});

test('carriage returns and a null byte are handled before parsing', () => {
  assert.equal(parseWorkflowYaml('a: 1\r\nb: 2\r\n').b, 2);
  assert.throws(() => parseWorkflowYaml('a: 1\0'), (error) => error.code === 'WORKFLOW_YAML_INVALID');
});

test('double-quoted escapes are decoded and unknown escapes rejected', () => {
  const document = parseWorkflowYaml('a: "line\\nbreak"\nb: "tab\\there"\nc: "\\u0041"');
  assert.equal(document.a, 'line\nbreak');
  assert.equal(document.b, 'tab\there');
  assert.equal(document.c, 'A');
  assert.throws(() => parseWorkflowYaml('a: "\\q"'), (error) => error.status === 400);
});
