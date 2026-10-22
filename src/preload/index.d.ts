export {};

declare global {
  interface Window {
    hws: {
      invoke(command: string, input: unknown): Promise<unknown>;
    };
  }
}
