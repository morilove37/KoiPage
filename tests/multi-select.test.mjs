import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * The multi-select filter trigger is pure markup, so it can be rendered without
 * a DOM. Bundling through esbuild mirrors `friend-library-render.test.mjs`: the
 * component is TSX with the `@/` alias, which Node cannot import directly.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const viteRequire = createRequire(require.resolve('vite/package.json'));
const { build } = viteRequire('esbuild');

const compiled = await build({
  absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'cjs',
  packages: 'external',
  stdin: {
    contents: "export { MultiSelect } from './src/components/ui/multi-select';",
    resolveDir: root, loader: 'tsx',
  },
});
const module = { exports: {} };
new Function('module', 'exports', 'require', compiled.outputFiles[0].text)(module, module.exports, require);
const { MultiSelect } = module.exports;

const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const options = [
  { value: 'unplayed', label: '未开始' },
  { value: 'playing', label: '游玩中' },
  { value: 'completed', label: '已通关' },
];

function render(values) {
  // `useLayoutEffect` is inert during SSR and React warns about it; the markup
  // under test is unaffected, so the notice is dropped instead of drowning the
  // results.
  const error = console.error;
  console.error = () => {};
  try {
    return renderToStaticMarkup(
      React.createElement(MultiSelect, { label: '状态', values, onValuesChange: () => {}, options, allLabel: '全部状态' }),
    );
  } finally {
    console.error = error;
  }
}

test('the trigger shows the all-label until something is selected', () => {
  assert.match(render([]), /全部状态/);
  assert.doesNotMatch(render([]), /已选/);
});

test('a single selection shows its label, several collapse to a count', () => {
  const one = render(['playing']);
  assert.match(one, /游玩中/);
  // The all-row would otherwise be ambiguous with "nothing selected".
  assert.doesNotMatch(one, /全部状态/);
  assert.match(render(['unplayed', 'playing']), /已选 2 项/);
  assert.match(render(['unplayed', 'playing', 'completed']), /已选 3 项/);
});

test('a value with no matching option still counts instead of looking empty', () => {
  // A developer can disappear from the library while the filter keeps its name.
  assert.match(render(['deleted-studio']), /已选 1 项/);
});

test('the panel is closed and announced as collapsed by default', () => {
  const html = render([]);
  assert.doesNotMatch(html, /role="listbox"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-haspopup="listbox"/);
});
