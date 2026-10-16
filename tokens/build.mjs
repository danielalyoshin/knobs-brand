// SPDX-License-Identifier: GPL-2.0-or-later
//
// Generates dist/ from tokens/tokens.json, with Node alone:
//
//   dist/tokens.css        custom properties, for the site
//   dist/knobs_tokens.h    constexpr values, for the app (plain C++20)
//   dist/tokens.flat.json  every token by its dotted path, aliases resolved
//   dist/status/*.svg      the app's state marks, drawn from their shapes
//
// It checks the source first: every alias resolves, every colour is #rrggbb,
// every OKLCH note gives back its colour's hex, and every contrast note
// matches the WCAG 2 ratio of the two colours it names. Any failure stops
// the build and writes nothing.
//
// Usage:
//   node tokens/build.mjs           write dist/
//   node tokens/build.mjs --check   write nothing; exit 1 if dist/ is out of date

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(ROOT, 'dist');
const EXT = 'app.getknobs';
const CHECK = process.argv.includes('--check');

const source = JSON.parse(readFileSync(join(HERE, 'tokens.json'), 'utf8'));
const problems = [];

// ---------------------------------------------------------------- the tree

// Every token in source order, by its dotted path. A token is an object with
// a $value; its $type comes from it or from the nearest group that has one.
const tokens = new Map();
(function walk(node, path, type) {
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('$') || child === null || typeof child !== 'object') continue;
    const here = [...path, key];
    const childType = child.$type ?? type;
    if ('$value' in child) {
      tokens.set(here.join('.'), {
        path: here,
        name: here.join('.'),
        type: childType,
        raw: child.$value,
        description: child.$description ?? '',
        ext: child.$extensions?.[EXT] ?? {},
      });
    } else {
      walk(child, here, childType);
    }
  }
})(source, [], undefined);

const ALIAS = /^\{([^{}]+)\}$/;
const aliasOf = (t) => (typeof t.raw === 'string' && ALIAS.test(t.raw) ? t.raw.match(ALIAS)[1] : null);

// The token a token's value finally comes from, following aliases.
function origin(t, seen = new Set()) {
  const ref = aliasOf(t);
  if (!ref) return t;
  if (seen.has(t.name)) throw new Error(`alias loop at ${t.name}`);
  seen.add(t.name);
  const target = tokens.get(ref);
  if (!target) throw new Error(`${t.name} refers to ${ref}, which doesn't exist`);
  return origin(target, seen);
}

for (const t of tokens.values()) {
  try {
    t.origin = origin(t);
    t.value = t.origin.raw;
    t.ref = aliasOf(t);
  } catch (e) {
    problems.push(e.message);
  }
}
stopIfProblems();

// ------------------------------------------------------------ colour maths

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toLinear = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// OKLCH to sRGB hex, through OKLab's reference matrices, clamped to the gamut.
function oklchToHex(l, c, h) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const encode = (x) => {
    const v = Math.min(Math.max(x, 0), 1);
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return '#' + linear.map((x) => Math.round(encode(x) * 255).toString(16).padStart(2, '0')).join('');
}

// ----------------------------------------------------------------- checks

const HEX = /^#[0-9a-f]{6}$/;
const PATH = /^(?:[MLHVAZ]|-?\d+(?:\.\d+)?|[ ,])+$/;
const OKLCH = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/;

for (const t of tokens.values()) {
  if (!/^[a-z0-9-]+$/.test(t.path.at(-1))) problems.push(`${t.name}: names are lowercase letters, digits and hyphens`);
  if (t.type === 'color') {
    if (!HEX.test(t.value)) {
      problems.push(`${t.name}: ${t.value} isn't a lowercase #rrggbb colour`);
      continue;
    }
    if (!t.ref) {
      const note = t.ext.oklch;
      const m = typeof note === 'string' && note.match(OKLCH);
      if (!m) problems.push(`${t.name}: needs an OKLCH note, such as "oklch(0.22 0.006 260)"`);
      else if (oklchToHex(+m[1], +m[2], +m[3]) !== t.value) {
        problems.push(`${t.name}: ${note} gives ${oklchToHex(+m[1], +m[2], +m[3])}, not ${t.value}`);
      }
    } else if (t.ext.oklch) {
      problems.push(`${t.name}: an alias takes its OKLCH from ${t.origin.name}; remove its own note`);
    }
    for (const [other, ratio] of Object.entries(t.ext.contrast ?? {})) {
      const peer = tokens.get([...t.path.slice(0, -1), other].join('.'));
      if (!peer || peer.type !== 'color') {
        problems.push(`${t.name}: its contrast names ${other}, which isn't a colour beside it`);
        continue;
      }
      const measured = contrast(t.value, peer.value);
      if (Math.abs(measured - ratio) > 0.006) {
        problems.push(`${t.name} against ${other}: noted ${ratio}:1, measures ${measured.toFixed(2)}:1`);
      }
    }
  } else if (t.ext.contrast || t.ext.oklch) {
    problems.push(`${t.name}: only colours carry OKLCH and contrast notes`);
  }
  if (t.type === 'fontWeight' && !(Number.isInteger(t.value) && t.value >= 1 && t.value <= 1000)) {
    problems.push(`${t.name}: a font weight is a whole number from 1 to 1000`);
  }
  if (t.type === 'fontFamily' && !(Array.isArray(t.value) && t.value.length && t.value.every((f) => typeof f === 'string'))) {
    problems.push(`${t.name}: a font family is a list of names`);
  }
  if (t.type === 'duration' && !/^\d+ms$/.test(t.value)) problems.push(`${t.name}: a duration is whole milliseconds, such as "160ms"`);
  if (t.type === 'path' && !(typeof t.value === 'string' && PATH.test(t.value) && /^M/.test(t.value) && /Z$/.test(t.value))) {
    problems.push(`${t.name}: a path is SVG path data with absolute M, L, H, V, A and Z only, from M to Z`);
  }
  if (t.type === 'cubicBezier') {
    const ok = Array.isArray(t.value) && t.value.length === 4 && t.value.every(Number.isFinite) && [0, 2].every((i) => t.value[i] >= 0 && t.value[i] <= 1);
    if (!ok) problems.push(`${t.name}: a cubic Bézier is [x1, y1, x2, y2] with x1 and x2 from 0 to 1`);
  }
}

// Both schemes name the same roles, in the same order.
const roles = (scheme) => [...tokens.values()].filter((t) => t.path[0] === 'scheme' && t.path[1] === scheme).map((t) => t.path[2]);
const darkRoles = roles('dark');
const lightRoles = roles('light');
if (darkRoles.join() !== lightRoles.join()) {
  problems.push(`scheme.dark and scheme.light must name the same roles in the same order:\n    dark:  ${darkRoles.join(', ')}\n    light: ${lightRoles.join(', ')}`);
}
stopIfProblems();

// ---------------------------------------------------------------- helpers

const select = (...prefix) => [...tokens.values()].filter((t) => prefix.every((p, i) => t.path[i] === p));
const ascii = (text) =>
  text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/é/g, 'e')
    .replace(/[^\x20-\x7e]/g, '?');

function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// ------------------------------------------------------------------- CSS

// The custom property for a token. Status marks belong to the app and get none.
function cssName(t) {
  const [group, ...rest] = t.path;
  if (group === 'color') return `--${rest.join('-')}`; // --brand-graphite, --neutral-dark-185
  if (group === 'scheme') return `--${rest.slice(1).join('-')}`; // --ground
  if (group === 'type') {
    const prefix = { family: 'font', weight: 'weight', size: 'size', leading: 'leading', tracking: 'tracking' }[rest[0]];
    return `--${prefix}-${rest.slice(1).join('-')}`;
  }
  if (group === 'geometry') return `--${rest.join('-')}`;
  if (group === 'motion') return `--${rest.join('-')}`; // --ease, --duration-fast
  return null;
}

const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'math', 'emoji', 'fangsong',
  'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', '-apple-system',
]);
const cssFamily = (name) => (GENERIC_FAMILIES.has(name) || /^[A-Za-z][A-Za-z0-9-]*$/.test(name) ? name : `"${name}"`);

function cssValue(t) {
  if (t.type === 'fontFamily') return t.value.map(cssFamily).join(', ');
  if (t.type === 'cubicBezier') return `cubic-bezier(${t.value.join(', ')})`;
  return String(t.value);
}

// A note beside a colour: where an alias comes from, or a value's OKLCH.
function cssNote(t) {
  if (t.type !== 'color') return '';
  if (t.ref) return ` /* ${cssName(tokens.get(t.ref))} */`;
  return ` /* ${t.ext.oklch} */`;
}

function cssBlock(list, indent) {
  const width = Math.max(...list.map((t) => cssName(t).length)) + 1;
  return list.map((t) => `${indent}${(cssName(t) + ':').padEnd(width + 1)}${cssValue(t)};${cssNote(t)}`);
}

function buildCss() {
  const pad = '  ';
  // A role the two schemes share, such as the footer band, is set once on
  // :root; the light blocks name only the roles that change.
  const darkValue = new Map(select('scheme', 'dark').map((t) => [t.path[2], t.value]));
  const lightOwn = select('scheme', 'light').filter((t) => t.value !== darkValue.get(t.path[2]));
  const out = [
    '/*',
    ' * knobs design tokens, generated by tokens/build.mjs from tokens/tokens.json.',
    " * Don't edit this file: change tokens.json and run `node tokens/build.mjs`.",
    ' * SPDX-License-Identifier: GPL-2.0-or-later',
    ' *',
    ' * The dark scheme is the default, on :root. The light scheme follows the',
    ' * system setting unless the root element has data-theme="dark", and',
    ' * data-theme="light" picks it whatever the system says, so a toggle that',
    ' * sets data-theme wins either way. A role both schemes share, such as the',
    ' * footer band, is set once, on :root. The app\'s state marks (status in',
    ' * tokens.json) belong to the app and aren\'t declared here.',
    ' */',
    '',
    ':root {',
    `${pad}color-scheme: dark;`,
    '',
    `${pad}/* Brand colours */`,
    ...cssBlock(select('color', 'brand'), pad),
    '',
    `${pad}/* Neutral ramps, by OKLCH lightness in thousandths */`,
    ...cssBlock(select('color', 'neutral'), pad),
    '',
    `${pad}/* Type */`,
    ...cssBlock(select('type'), pad),
    '',
    `${pad}/* Geometry */`,
    ...cssBlock(select('geometry'), pad),
    '',
    `${pad}/* Motion */`,
    ...cssBlock(select('motion'), pad),
    '',
    `${pad}/* Colour by role: dark */`,
    ...cssBlock(select('scheme', 'dark'), pad),
    '}',
    '',
    '/* Colour by role: light, from the system setting */',
    '@media (prefers-color-scheme: light) {',
    `${pad}:root:not([data-theme="dark"]) {`,
    `${pad}${pad}color-scheme: light;`,
    ...cssBlock(lightOwn, pad + pad),
    `${pad}}`,
    '}',
    '',
    '/* Colour by role: light, chosen on the page */',
    ':root[data-theme="light"] {',
    `${pad}color-scheme: light;`,
    ...cssBlock(lightOwn, pad),
    '}',
  ];
  return out.join('\n') + '\n';
}

// -------------------------------------------------------------------- C++

const pascal = (parts) => parts.flatMap((p) => p.split('-')).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
const argb = (hex) => `0xFF${hex.slice(1).toUpperCase()}`;
const snake = (name) => name.replace(/-/g, '_');

// Where a C++ value comes from: another constant for an alias, else its OKLCH.
function cppNote(t) {
  if (!t.ref) return t.ext.oklch;
  const [group, ...rest] = t.ref.split('.');
  if (group === 'color') return `${rest[0]}::k${pascal(rest.slice(1))}`;
  if (group === 'scheme') return `same as ${snake(rest[1])}`;
  return t.ref;
}

function cppComment(text, indent, width = 80) {
  return wrap(ascii(text), width - indent.length - 3).map((l) => `${indent}// ${l}`);
}

// Lines of code with their notes lined up after them.
function withNotes(code, notes) {
  const width = Math.max(...code.map((c) => c.length));
  return code.map((c, i) => `${c.padEnd(width)}  // ${notes[i]}`);
}

function cppConstants(list, nameOf) {
  return withNotes(
    list.map((t) => `inline constexpr Argb ${nameOf(t)} = ${argb(t.value)};`),
    list.map(cppNote),
  );
}

function px(t) {
  const m = String(t.value).match(/^(-?[\d.]+)px$/);
  if (!m) throw new Error(`${t.name}: the header takes geometry in px only`);
  return m[1].includes('.') ? `${m[1]}f` : `${m[1]}.0f`;
}

const cppFloat = (n) => (Number.isInteger(n) ? `${n}.0f` : `${n}f`);

function buildCpp() {
  const dark = select('scheme', 'dark');
  const light = select('scheme', 'light');
  const scheme = (list, name, about) => [
    ...cppComment(about, ''),
    `inline constexpr Scheme ${name} = {`,
    ...withNotes(
      list.map((t) => `    .${snake(t.path[2])} = ${argb(t.value)},`),
      list.map(cppNote),
    ),
    '};',
  ];
  const ease = tokens.get('motion.ease');
  const out = [
    '// SPDX-License-Identifier: GPL-2.0-or-later',
    '//',
    '// knobs design tokens, generated by tokens/build.mjs from tokens/tokens.json in',
    "// knobs-brand. Don't edit this file: change tokens.json and run",
    '// `node tokens/build.mjs`.',
    '//',
    '// Plain C++20 with no Windows headers. Colours are 0xAARRGGBB in sRGB, with',
    '// straight alpha. Red(), Green(), Blue() and Alpha() give a channel from 0 to 1,',
    '// which is what a D2D1_COLOR_F holds:',
    '//',
    '//   const knobs::tokens::Argb c = knobs::tokens::kDark.ground;',
    '//   const D2D1_COLOR_F color{knobs::tokens::Red(c), knobs::tokens::Green(c),',
    '//                            knobs::tokens::Blue(c), knobs::tokens::Alpha(c)};',
    '//',
    '// Type is the site\'s and isn\'t here: the app sets Windows\' own type.',
    '#pragma once',
    '',
    '#include <cstdint>',
    '',
    'namespace knobs::tokens {',
    '',
    '// A colour as 0xAARRGGBB.',
    'using Argb = std::uint32_t;',
    '',
    'constexpr float Alpha(Argb c) { return static_cast<float>((c >> 24) & 0xFFu) / 255.0f; }',
    'constexpr float Red(Argb c) { return static_cast<float>((c >> 16) & 0xFFu) / 255.0f; }',
    'constexpr float Green(Argb c) { return static_cast<float>((c >> 8) & 0xFFu) / 255.0f; }',
    'constexpr float Blue(Argb c) { return static_cast<float>(c & 0xFFu) / 255.0f; }',
    '',
    ...cppComment(source.color.brand.$description, ''),
    'namespace brand {',
    ...cppConstants(select('color', 'brand'), (t) => `k${pascal([t.path[2]])}`),
    '}  // namespace brand',
    '',
    ...cppComment(`${source.color.neutral.$description} kDark* are the dark scheme's, kLight* the light scheme's.`, ''),
    'namespace neutral {',
    ...cppConstants(select('color', 'neutral'), (t) => `k${pascal([t.path[2]])}${t.path[3]}`),
    '}  // namespace neutral',
    '',
    "// One colour scheme, by role. Windows' app mode picks kDark or kLight; high",
    "// contrast uses the user's own colours instead.",
    'struct Scheme {',
    ...dark.flatMap((t) => [...cppComment(t.description, '  '), `  Argb ${snake(t.path[2])};`]),
    '};',
    '',
    ...scheme(dark, 'kDark', source.scheme.dark.$description),
    '',
    ...scheme(light, 'kLight', source.scheme.light.$description),
    '',
    ...cppComment(source.status.$description, ''),
    'namespace status {',
    ...select('status').flatMap((t) => [...cppComment(t.description, ''), ...cppConstants([t], (u) => `k${pascal([u.path[1]])}`)]),
    '}  // namespace status',
    '',
    ...cppComment(source['status-shape'].$description, ''),
    'namespace status_shape {',
    ...select('status-shape').flatMap((t) => [
      ...cppComment(t.description, ''),
      `inline constexpr char k${pascal([t.path[1]])}[] = "${t.value}";`,
    ]),
    '}  // namespace status_shape',
    '',
    '// Geometry, in DIPs (CSS pixels).',
    'namespace geometry {',
    ...select('geometry').flatMap((t) => [...cppComment(t.description, ''), `inline constexpr float k${pascal([t.path[1]])} = ${px(t)};`]),
    '}  // namespace geometry',
    '',
    '// Motion: one curve, its durations, and distances in DIPs.',
    'namespace motion {',
    ...cppComment(ease.description, ''),
    `// cubic-bezier(${ease.value.join(', ')})`,
    ...['X1', 'Y1', 'X2', 'Y2'].map((p, i) => `inline constexpr float kEase${p} = ${cppFloat(ease.value[i])};`),
    ...select('motion', 'duration').flatMap((t) => [
      ...cppComment(t.description, ''),
      `inline constexpr float k${pascal([t.path[2]])}Ms = ${cppFloat(parseInt(t.value, 10))};`,
    ]),
    ...select('motion').filter((t) => t.type === 'dimension').flatMap((t) => [
      ...cppComment(t.description, ''),
      `inline constexpr float k${pascal([t.path[1]])} = ${px(t)};`,
    ]),
    '}  // namespace motion',
    '',
    '}  // namespace knobs::tokens',
  ];
  return out.join('\n') + '\n';
}

// --------------------------------------------------------------- flat JSON

// One token a line; a list, such as a font stack, stays on its token's line.
function buildFlat() {
  const json = (v) => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v));
  const lines = [...tokens.values()].map((t) => `  ${JSON.stringify(t.name)}: ${json(t.value)}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

// ------------------------------------------------------------ state marks

// Each state mark as an SVG, its ground and glyph in their colours, for
// anything that needs to show one, such as this repository's guide. The box
// leaves a unit round the 16-unit square for the triangle's corners.
const MARKS = [
  ['ok', 'Set', 'disc', 'status.ok', 'check', 'status.on-status'],
  ['stop', 'Needs you', 'disc', 'status.stop', 'exclamation', 'status.on-status'],
  ['warn', 'Warning', 'triangle', 'status.warn', 'triangle-exclamation', 'status.on-warn'],
  ['warn-on-dark', 'Warning', 'triangle', 'status.warn-on-dark', 'triangle-exclamation', 'status.on-warn'],
  ['info', 'Information', 'disc', 'status.info', 'information', 'status.on-status'],
  ['pause', 'Paused', 'disc', 'status.info', 'pause', 'status.on-status'],
  ['info-on-dark', 'Information', 'disc', 'status.info-on-dark', 'information', 'status.on-info-on-dark'],
  ['pause-on-dark', 'Paused', 'disc', 'status.info-on-dark', 'pause', 'status.on-info-on-dark'],
];

function buildMarks() {
  const value = (name) => {
    const t = tokens.get(name);
    if (!t) throw new Error(`a state mark needs ${name}, which doesn't exist`);
    return t.value;
  };
  return MARKS.map(([file, title, ground, groundColour, glyph, glyphColour]) => [
    `status/${file}.svg`,
    [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 18 18" width="72" height="72" role="img" ' +
        `aria-label="${title}"><title>${title}</title>`,
      '<!-- SPDX-License-Identifier: GPL-2.0-or-later. Generated by tokens/build.mjs from tokens/tokens.json. -->',
      `<path fill="${value(groundColour)}" d="${value(`status-shape.${ground}`)}"/>`,
      `<path fill="${value(glyphColour)}" d="${value(`status-shape.${glyph}`)}"/>`,
      '</svg>',
      '',
    ].join('\n'),
  ]);
}

// ---------------------------------------------------------------- outputs

function stopIfProblems() {
  if (!problems.length) return;
  console.error(`tokens.json has ${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

let outputs;
try {
  outputs = [
    ['tokens.css', buildCss()],
    ['knobs_tokens.h', buildCpp()],
    ['tokens.flat.json', buildFlat()],
    ...buildMarks(),
  ];
} catch (e) {
  problems.push(e.message);
  stopIfProblems();
}

const read = (file) => {
  try {
    return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
};

if (CHECK) {
  const stale = outputs.filter(([name, text]) => read(join(DIST, name)) !== text).map(([name]) => name);
  if (stale.length) {
    console.error(`dist/ is out of date: ${stale.join(', ')}. Run node tokens/build.mjs and commit the result.`);
    process.exit(1);
  }
  console.log(`dist/ is up to date with tokens.json (${tokens.size} tokens).`);
} else {
  for (const [name, text] of outputs) {
    mkdirSync(dirname(join(DIST, name)), { recursive: true });
    writeFileSync(join(DIST, name), text);
    console.log(`wrote ${relative(ROOT, join(DIST, name))}`);
  }
  console.log(`${tokens.size} tokens.`);
}
