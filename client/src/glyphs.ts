/**
 * Counting what the EYE sees in an emoji string.
 *
 * Plain .ts, not inside the component that uses it, for the same reason the oven matrix
 * logic lives apart from its screen: Node can type-strip .ts and run it directly, but it
 * cannot type-strip JSX, so anything defined in a .tsx file is untestable here.
 */

/**
 * The number of grapheme clusters - which is the number of separate pictures a person sees.
 *
 * The three obvious implementations all disagree:
 *   '🍕'.length            === 2   (UTF-16 units: one emoji is a surrogate pair)
 *   [...'🧑‍🍳'].length      === 3   (code points: two people-and-tools joined by U+200D)
 *   [...'🌶️'].length       === 2   (code points: a chilli plus U+FE0F, "render in colour")
 * Only segmentation agrees with the eye, and getting this wrong is visible: a one-glyph
 * pizza type would be shrunk to fit a box it already fits in.
 */
export function glyphCount(emoji: string): number {
  const trimmed = emoji.trim();
  if (!trimmed) return 0;
  if (typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)].length;
  }
  // Every browser this app targets has had Segmenter since 2022, so this is a floor and not
  // a real code path. Code points at least beat UTF-16 units when it is reached.
  return [...trimmed].length;
}

/** Clamped because the stylesheet only has rules up to three. */
export function glyphBucket(emoji: string): number {
  return Math.min(glyphCount(emoji), 3);
}
