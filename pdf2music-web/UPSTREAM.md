# PDF recognition component

This browser converter is adapted from the `webapp/` directory of
[pllopis/pdf2music](https://github.com/pllopis/pdf2music), upstream revision
`6ccbbd6` (v0.2.4). The upstream README identifies the project as AGPL-3.0
licensed. Its conversion worker and model pipeline are retained here; the
PaperTempo integration adds same-origin messaging so the recognized MusicXML
can be loaded directly into the score viewer.

The Vite build writes the standalone converter to `dist/pdf2music`. PaperTempo
embeds that page only while converting a PDF. Its PDF processing stays in the
browser; the browser fetches the recognition models from the upstream HOMR
release through the PaperTempo `/models/` proxy.
