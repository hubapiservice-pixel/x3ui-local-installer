import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [baselineIndexPath, baselineStylePath, outputDir] = process.argv.slice(2);
if (!baselineIndexPath || !baselineStylePath || !outputDir) {
  throw new Error('Usage: node scripts/merge-online-guides.mjs BASE_INDEX BASE_CSS OUTPUT_DIR');
}

const replaceSection = (baseline, source, startMarker, endMarker) => {
  const findBounds = (text, label) => {
    const start = text.indexOf(startMarker);
    const end = text.indexOf(endMarker, start + startMarker.length);
    if (start < 0 || end < 0 || text.indexOf(startMarker, start + 1) !== -1 || text.indexOf(endMarker, end + 1) !== -1) {
      throw new Error(`Expected one bounded ${label} section`);
    }
    return { start, end };
  };
  const oldBounds = findBounds(baseline, 'online');
  const newBounds = findBounds(source, 'local');
  return baseline.slice(0, oldBounds.start)
    + source.slice(newBounds.start, newBounds.end)
    + baseline.slice(oldBounds.end);
};

const root = new URL('../', import.meta.url);
const [onlineIndex, onlineStyles, localIndex, localStyles] = await Promise.all([
  readFile(baselineIndexPath, 'utf8'),
  readFile(baselineStylePath, 'utf8'),
  readFile(new URL('public/index.html', root), 'utf8'),
  readFile(new URL('public/styles.css', root), 'utf8'),
]);

let mergedIndex = replaceSection(
  onlineIndex, localIndex,
  '<h3 class="usage-heading">',
  '<p class="notice">节点导入成功',
);
const mergedStyles = replaceSection(
  onlineStyles, localStyles,
  '.guide-intro {',
  '.dialog-content > .notice:last-child',
);

const previousCssVersion = 'styles.css?v=20261016-3';
if (mergedIndex.split(previousCssVersion).length !== 2) throw new Error('Unexpected online CSS version');
mergedIndex = mergedIndex.replace(previousCssVersion, 'styles.css?v=20261016-guides-1');
mergedIndex = mergedIndex.replace(/(guides\/[a-z0-9.-]+\.png)(?=")/g, '$1?v=20261016-guides-1');

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(join(outputDir, 'index.html'), mergedIndex),
  writeFile(join(outputDir, 'styles.css'), mergedStyles),
]);
console.log(`Merged only guide HTML and CSS into ${outputDir}`);
