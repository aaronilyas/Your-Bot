import { readFile, writeFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';
const icon = new Resvg(await readFile(new URL('../resources/icon.svg', import.meta.url)), { fitTo: { mode: 'width', value: 512 } });
await writeFile(new URL('../resources/icon.png', import.meta.url), icon.render().asPng());
