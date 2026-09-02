export const orderedFuzzyScore = (needle: string, haystack: string): number | undefined => {
  if (needle.length === 0) return 0;
  let needleIndex = 0;
  let first = -1;
  let previous = -2;
  let gaps = 0;
  let consecutive = 0;

  for (let index = 0; index < haystack.length && needleIndex < needle.length; index += 1) {
    if (haystack[index] !== needle[needleIndex]) continue;
    if (first < 0) first = index;
    if (index === previous + 1) consecutive += 1;
    else if (previous >= 0) gaps += index - previous - 1;
    previous = index;
    needleIndex += 1;
  }

  if (needleIndex !== needle.length) return undefined;
  return Math.max(12, 82 + consecutive * 5 - gaps * 2 - first);
};

export const tokenTextScore = (token: string, text: string): number | undefined => {
  if (text === token) return 330;
  if (text.startsWith(token)) return 240 - Math.min(40, text.length - token.length);
  const wordIndex = ` ${text}`.indexOf(` ${token}`);
  if (wordIndex >= 0) return 190 - Math.min(35, wordIndex);
  const contiguous = text.indexOf(token);
  if (contiguous >= 0) return 145 - Math.min(45, contiguous);
  return orderedFuzzyScore(token, text);
};
