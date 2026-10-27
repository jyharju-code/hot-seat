export class NotImplementedError extends Error {
  constructor(provider: string) {
    super(`${provider} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}
