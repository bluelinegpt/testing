import { HttpException } from "@nestjs/common";

export class ApplicationException extends HttpException {
  public constructor(
    public readonly errorCode: string,
    message: string,
    statusCode: number,
    public readonly validationDetails?: readonly string[],
    public readonly diagnostics?: Readonly<Record<string, boolean | number | string | null>>,
    public readonly exposeDiagnostics = false,
  ) {
    super(message, statusCode);
  }
}
