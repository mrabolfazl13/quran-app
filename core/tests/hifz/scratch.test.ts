import { test } from 'vitest';
import { segmentAyah, assertTiling } from '../../src/hifz/segment';
import { AYAH_TEXT } from './fixtures';
test('probe', () => {
for (const key of ['112:1','112:3','112:4','1:5','1:7','108:2','2:255','1:1','1:2','1:4','108:1'] as const) {
  const r = segmentAyah({ itemId: 'item-'+key, verseKey: key, text: AYAH_TEXT[key] });
  console.log('==', key, 'words', r.wordCount, 'segments', r.segments.length, 'tiling', JSON.stringify(assertTiling(r.segments, r.wordCount)));
  for (const s of r.segments) console.log('   ', s.position, s.fromWord+'..'+s.toWord, s.text);
  console.log('   boundaries', JSON.stringify(r.boundaries.map(b=>[b.wordPosition,b.score])));
  console.log('   anchors', JSON.stringify(r.anchors.map(a=>[a.wordPosition,a.role])));
  console.log('   notes', JSON.stringify(r.notes));
}
});
