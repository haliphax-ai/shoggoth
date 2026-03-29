export class ModelHttpError extends Error {
  readonly status: number;
  readonly bodySnippet?: string;

  constructor(status: number, message: string, bodySnippet?: string) {
    super(message);
    this.name = "ModelHttpError";
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}
