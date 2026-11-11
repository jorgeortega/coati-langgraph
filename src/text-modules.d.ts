// data/*.txt, *.md and *.jsonl are bundled as strings: wrangler.jsonc "rules"
// for the Worker, the text plugin in vitest.config.ts for tests.
declare module '*.txt' {
  const text: string;
  export default text;
}
declare module '*.md' {
  const text: string;
  export default text;
}
declare module '*.jsonl' {
  const text: string;
  export default text;
}
