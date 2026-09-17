/// <reference types="node" />

declare module 'bfj' {
  interface Options {
    [key: string]: unknown;
  }

  function parse(
    stream: NodeJS.ReadableStream,
    options?: Options
  ): Promise<unknown>;

  function stringify(value: unknown, options?: Options): Promise<string>;

  export { parse, stringify };
}