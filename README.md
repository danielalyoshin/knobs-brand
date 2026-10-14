<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/danielalyoshin/knobs-brand/main/logo/svg/knobs-lockup-horizontal-light.svg">
    <img src="https://raw.githubusercontent.com/danielalyoshin/knobs-brand/main/logo/svg/knobs-lockup-horizontal-dark.svg" alt="knobs" width="320">
  </picture>
</h1>

<div align="center">

**Your OBS mic chain, in every app.**

The brand of [knobs](https://github.com/danielalyoshin/knobs): its logo, colours, type, and the design tokens that carry them.<br>
A git submodule of [knobs-site](https://github.com/danielalyoshin/knobs-site), so the page and the app can draw on the same files.

[Brand guide](BRAND.md) · [Tokens](tokens/tokens.json) · [knobs](https://github.com/danielalyoshin/knobs) · [getknobs.app](https://getknobs.app/) · [Issues](https://github.com/danielalyoshin/knobs/issues)

<sub>An independent project. Not affiliated with or endorsed by the OBS Project.</sub>

</div>

## Tokens

Every value lives in [`tokens/tokens.json`](tokens/tokens.json). `node tokens/build.mjs` builds `dist/` from it: `tokens.css` for the site, `knobs_tokens.h` for the app and `tokens.flat.json` for anything else, and `--check` confirms `dist/` still matches. It needs Node 18 or newer and nothing else.

## License

[GPL-2.0-or-later](LICENSE), the same as knobs, except two kinds of files: the fonts in `fonts/` (Radio Canada and Source Code Pro, under the SIL Open Font License) and the logo files in `logo/` and `web/` (all rights reserved, apart from the knobs repository's [TRADEMARKS.md](https://github.com/danielalyoshin/knobs/blob/main/TRADEMARKS.md); see [logo/LICENSE](logo/LICENSE) and [web/LICENSE](web/LICENSE)).
